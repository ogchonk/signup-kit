import { readFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"
import { PostgrestClient } from "@supabase/postgrest-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { supabaseStore, type DbClient } from "../../src/core/supabase-store"
import { newsletterConfirm, newsletterSignup, unsubscribe, waitlistSignup, WELCOME_GAP_MS, type Deps } from "../../src/core/handlers"
import { hashToken, unsubscribeToken } from "../../src/core/tokens"
import { fakeEnv, fakeMailer, fakeResolver } from "../../src/testing"
import { newsletterSite, post, waitlistSite } from "../helpers"

/* The real Store (supabase-store.ts) against real PostgREST in front of real Postgres (review M3): every
   filter, the 23505 mapping, the status guards and the races run for real, not through the fake.
   DATABASE_URL and POSTGREST_URL must point at throwaway services; this suite recreates the schema. */

const dbUrl = process.env.DATABASE_URL ?? "postgres://postgres:t@localhost:55432/postgres"
const restUrl = process.env.POSTGREST_URL ?? "http://localhost:53000"
const sql = (f: string) => readFileSync(join(__dirname, "../../sql", f), "utf8")
const render = (f: string, table: string) => sql(f).replaceAll("{{table}}", table)
let db: pg.Pool
const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows

const client = () => new PostgrestClient(restUrl) as unknown as DbClient
const store = () => supabaseStore("unused", "unused", client())

/** Waits until PostgREST's schema cache holds this suite's schema: the new columns and the RPCs, not an older copy. */
async function waitForSchema(): Promise<void> {
  const probes = [
    () => fetch(`${restUrl}/rc_subscribers?select=confirm_sent_at,unsubscribe_reason&limit=0`),
    () => fetch(`${restUrl}/pf_waitlist_signups?select=welcome_sent_at,unsubscribed_at&limit=0`),
    () => fetch(`${restUrl}/ntabc_waitlist_signups?select=welcome_sent_at,unsubscribed_at&limit=0`),
    () => fetch(`${restUrl}/rpc/signup_pool_open`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"p_pool":"probe","p_limit":1}' }),
  ]
  for (let i = 0; i < 100; i++) {
    const ok = await Promise.all(probes.map((p) => p().then((r) => r.ok).catch(() => false)))
    if (ok.every(Boolean)) return
    if (i % 10 === 0) await q(`notify pgrst, 'reload schema'`)
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("PostgREST never loaded this suite's schema")
}

beforeAll(async () => {
  db = new pg.Pool({ connectionString: dbUrl, max: 10 })
  await q(`drop schema if exists public cascade; create schema public; grant usage on schema public to public`)
  for (const r of ["anon", "authenticated", "service_role"]) await q(`do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin; end if; end $$`)
  await q(`alter role service_role bypassrls`)
  await q(`grant usage on schema public to anon, authenticated, service_role`)
  await q(`alter default privileges in schema public grant all on tables to service_role`)
  /* The live shapes (catalog, 2026-10-08), then the package's SQL as Phase 2 and each cutover apply it. */
  await q(`create table public.pf_waitlist_signups (id uuid primary key default gen_random_uuid(), email text not null, submitted_at timestamptz not null default now(), source text, user_agent text, referrer text);
    create unique index pf_waitlist_signups_email_key on public.pf_waitlist_signups (lower(email));
    create table public.ntabc_waitlist_signups (id uuid primary key default gen_random_uuid(), email text not null, submitted_at timestamptz not null default now(), source text, user_agent text, referrer text,
      constraint ntabc_waitlist_signups_email_key unique (email), constraint ntabc_waitlist_signups_email_lower_ck check (email = lower(email)));`)
  await q(sql("001_shared_infra.sql"))
  for (const t of ["pf_waitlist_signups", "ntabc_waitlist_signups"]) {
    await q(render("010_waitlist_table.sql.tmpl", t))
    await q(render("011_waitlist_constraints.sql.tmpl", t))
  }
  await q(render("020_newsletter_table.sql.tmpl", "rc_subscribers"))
  await q(`notify pgrst, 'reload schema'`)
  await waitForSchema()
})

afterAll(async () => {
  await db?.end()
})

const today = async () => (await q(`select ((now() at time zone 'utc')::date)::text d`))[0].d as string

describe("quota through PostgREST", () => {
  it("takeSend returns the charged day, then null at the limit; giveBack returns the slot to that day", async () => {
    const s = store()
    const d = await today()
    expect(await s.takeSend("rest", 1)).toBe(d)
    expect(await s.takeSend("rest", 1)).toBeNull()
    expect(await s.poolOpen("rest", 1)).toBe(false)
    await s.giveBack("rest", d)
    expect(await s.poolOpen("rest", 1)).toBe(true)
  })
})

describe("waitlist store", () => {
  it("maps a duplicate to 'repeat' on both live index shapes (pf: lower(email); ntabc: the column)", async () => {
    const s = store()
    for (const t of ["pf_waitlist_signups", "ntabc_waitlist_signups"]) {
      expect(await s.wlInsert(t, { email: "dup@example.com", source: "x", user_agent: null, referrer: null })).toBe("new")
      expect(await s.wlInsert(t, { email: "dup@example.com", source: "x", user_agent: null, referrer: null })).toBe("repeat")
    }
  })
  it("two concurrent welcome claims on one new row: exactly one wins", async () => {
    const s = store()
    await s.wlInsert("ntabc_waitlist_signups", { email: "claim@example.com", source: "x", user_agent: null, referrer: null })
    const stamp = (ms: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, 0, ms)).toISOString()
    const r = await Promise.all([s.wlClaimWelcome("ntabc_waitlist_signups", "claim@example.com", stamp(1), null, false), s.wlClaimWelcome("ntabc_waitlist_signups", "claim@example.com", stamp(2), null, false)])
    expect(r.filter(Boolean)).toHaveLength(1)
  })
  it("a re-subscribe claim clears unsubscribed_at; its release puts it back; a plain claim never matches an unsubscribed row", async () => {
    const s = store()
    const t = "ntabc_waitlist_signups"
    await s.wlInsert(t, { email: "re@example.com", source: "x", user_agent: null, referrer: null })
    expect(await s.wlClaimWelcome(t, "re@example.com", "2026-10-01T00:00:00.000Z", null, false)).toBe(true)
    expect(await s.wlUnsubscribe(t, "re@example.com", "2026-10-02T00:00:00.000Z")).toBe("done")
    const row = (await s.wlGet(t, "re@example.com"))!
    expect(await s.wlClaimWelcome(t, "re@example.com", "2026-10-05T00:00:00.000Z", row.welcome_sent_at, false)).toBe(false)
    /* PostgREST hands timestamps back as "…+00:00"; the claim compares them as timestamps, so the round trip must still match. */
    expect(await s.wlClaimWelcome(t, "re@example.com", "2026-10-05T00:00:00.000Z", row.welcome_sent_at, true)).toBe(true)
    expect((await s.wlGet(t, "re@example.com"))!.unsubscribed_at).toBeNull()
    await s.wlReleaseWelcome(t, "re@example.com", "2026-10-05T00:00:00.000Z", row.welcome_sent_at, row.unsubscribed_at)
    const back = (await s.wlGet(t, "re@example.com"))!
    expect(Date.parse(back.unsubscribed_at!)).toBe(Date.parse("2026-10-02T00:00:00.000Z"))
    expect(Date.parse(back.welcome_sent_at!)).toBe(Date.parse("2026-10-01T00:00:00.000Z"))
  })
  it("unsubscribe reports an unknown address", async () => {
    expect(await store().wlUnsubscribe("ntabc_waitlist_signups", "nobody@example.com", new Date().toISOString())).toBe("unknown")
  })
  it("full flow on the real store: welcome, unsubscribe, re-sign-up inside 24 h changes nothing, after 24 h re-subscribes", async () => {
    const site = waitlistSite()
    const mailer = fakeMailer()
    let now = new Date()
    const pending: Promise<void>[] = []
    const deps: Deps = { store: store(), mailer, resolver: fakeResolver(), env: fakeEnv({ VERCEL_ENV: "production" }), now: () => now, defer: (w) => void pending.push(w()) }
    const settle = async () => {
      while (pending.length) await Promise.all(pending.splice(0))
    }
    const email = "flow@example.com"
    await waitlistSignup(post("https://ntabc.co/api/subscribe", { email }), site, deps)
    await settle()
    expect(mailer.sent).toHaveLength(1)
    const tok = unsubscribeToken("test-secret", email)
    const res = await unsubscribe(new Request(`https://ntabc.co/api/unsubscribe?e=${encodeURIComponent(email)}&t=${tok}`, { method: "POST", body: "List-Unsubscribe=One-Click" }), site, deps)
    expect(res.status).toBe(200)
    now = new Date(now.getTime() + 60_000)
    await waitlistSignup(post("https://ntabc.co/api/subscribe", { email }), site, deps)
    await settle()
    expect(mailer.sent).toHaveLength(1)
    expect((await q(`select unsubscribed_at is not null u from ntabc_waitlist_signups where email=$1`, [email]))[0].u).toBe(true)
    now = new Date(now.getTime() + WELCOME_GAP_MS)
    await waitlistSignup(post("https://ntabc.co/api/subscribe", { email }), site, deps)
    await settle()
    expect(mailer.sent).toHaveLength(2)
    expect((await q(`select unsubscribed_at is null u from ntabc_waitlist_signups where email=$1`, [email]))[0].u).toBe(true)
  })
})

describe("newsletter store", () => {
  const t = "rc_subscribers"
  const f = (stamp: string, sends = 1) => ({ confirm_token_hash: hashToken(stamp), confirm_sent_at: stamp, confirm_sends: sends })
  it("insert maps a racing duplicate to 'race'", async () => {
    const s = store()
    expect(await s.nlInsertPending(t, "n1@example.com", "footer", f("2026-10-08T00:00:00.000Z"))).toBe("new")
    expect(await s.nlInsertPending(t, "n1@example.com", "footer", f("2026-10-08T00:00:01.000Z"))).toBe("race")
  })
  it("toPending only matches the expected status and a stamp older than the cutoff", async () => {
    const s = store()
    expect(await s.nlToPending(t, "n1@example.com", "confirmed", "2026-10-09T00:00:00.000Z", f("2026-10-09T01:00:00.000Z", 2))).toBe(false)
    expect(await s.nlToPending(t, "n1@example.com", "pending", "2026-10-07T00:00:00.000Z", f("2026-10-09T01:00:00.000Z", 2))).toBe(false)
    expect(await s.nlToPending(t, "n1@example.com", "pending", "2026-10-09T00:00:00.000Z", f("2026-10-09T01:00:00.000Z", 2))).toBe(true)
    expect((await s.nlFind(t, "n1@example.com"))!.confirm_sends).toBe(2)
  })
  it("a restore never overwrites an unsubscribe that landed in between (audit fault 5, for real)", async () => {
    const s = store()
    const stamp = "2026-10-08T03:00:00.000Z"
    await s.nlInsertPending(t, "n2@example.com", "footer", f(stamp))
    expect(await s.nlUnsubscribe(t, "n2@example.com", "user", "2026-10-08T03:00:01.000Z")).toBe("done")
    await s.nlRestorePending(t, "n2@example.com", hashToken(stamp), null)
    expect((await s.nlFind(t, "n2@example.com"))!.status).toBe("unsubscribed")
    expect(await s.nlUnsubscribe(t, "n2@example.com", "user", "2026-10-08T03:00:02.000Z")).toBe("already")
    expect(await s.nlUnsubscribe(t, "nobody@example.com", "user", "2026-10-08T03:00:02.000Z")).toBe("unknown")
  })
  it("stampConfirmed honours the cutoff through PostgREST's or-filter; restoreConfirmed only undoes its own stamp", async () => {
    const s = store()
    await s.nlInsertPending(t, "n3@example.com", "footer", f("2026-10-08T04:00:00.000Z"))
    await q(`update rc_subscribers set status='confirmed', confirm_sent_at=null where email='n3@example.com'`)
    expect(await s.nlStampConfirmed(t, "n3@example.com", "2026-10-08T05:00:00.000Z", "2026-10-07T05:00:00.000Z")).toBe(true)
    expect(await s.nlStampConfirmed(t, "n3@example.com", "2026-10-08T06:00:00.000Z", "2026-10-07T06:00:00.000Z")).toBe(false)
    expect(await s.nlStampConfirmed(t, "n3@example.com", "2026-10-09T06:00:00.000Z", "2026-10-08T06:00:00.000Z")).toBe(true)
    await s.nlRestoreConfirmed(t, "n3@example.com", "2026-10-08T05:00:00.000Z", null)
    expect(Date.parse((await s.nlFind(t, "n3@example.com"))!.confirm_sent_at!)).toBe(Date.parse("2026-10-09T06:00:00.000Z"))
    await s.nlRestoreConfirmed(t, "n3@example.com", "2026-10-09T06:00:00.000Z", null)
    expect((await s.nlFind(t, "n3@example.com"))!.confirm_sent_at).toBeNull()
  })
  it("two concurrent stale-stamp claims on one row: exactly one wins, for a null and for an old stamp", async () => {
    const s = store()
    await s.nlInsertPending(t, "n5@example.com", "footer", f("2026-10-01T00:00:00.000Z"))
    for (const before of [null, "2026-10-01T00:00:00Z"]) {
      await q(`update rc_subscribers set status='confirmed', confirm_sent_at=$1 where email='n5@example.com'`, [before])
      const r = await Promise.all([
        s.nlStampConfirmed(t, "n5@example.com", "2026-10-08T10:00:00.001Z", "2026-10-07T10:00:00.000Z"),
        s.nlStampConfirmed(t, "n5@example.com", "2026-10-08T10:00:00.002Z", "2026-10-07T10:00:00.000Z"),
      ])
      expect(r.filter(Boolean), String(before)).toHaveLength(1)
    }
  })
  it("marks undeliverable addresses with the reason", async () => {
    const s = store()
    await s.nlInsertPending(t, "n4@example.com", "footer", f("2026-10-08T07:00:00.000Z"))
    await s.nlMarkUndeliverable(t, ["n4@example.com", "missing@example.com"], "bounced", "2026-10-08T07:01:00.000Z")
    expect(await s.nlFind(t, "n4@example.com")).toMatchObject({ status: "unsubscribed", unsubscribe_reason: "bounced" })
  })
  it("full flow on the real store: sign up, then confirm through the POST button", async () => {
    const site = newsletterSite()
    const mailer = fakeMailer()
    const pending: Promise<void>[] = []
    const deps: Deps = {
      store: store(),
      mailer,
      resolver: fakeResolver(),
      env: fakeEnv({ NEWSLETTER_RESEND_API_KEY: "k", NEWSLETTER_SECRET: "test-secret", VERCEL_ENV: "production" }),
      defer: (w) => void pending.push(w()),
    }
    const res = await newsletterSignup(post("https://robbychoate.com/api/newsletter", { email: "flow@example.com" }), site, deps)
    expect(res.status).toBe(200)
    await Promise.all(pending.splice(0))
    expect(mailer.sent).toHaveLength(1)
    const token = /t=([A-Za-z0-9_-]{43})/.exec(mailer.sent[0]!.text)![1]!
    const done = await newsletterConfirm(new Request("https://robbychoate.com/api/newsletter/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${token}` }), site, deps)
    expect(done.headers.get("location")).toBe("https://robbychoate.com/?newsletter=confirmed#newsletter")
    expect((await q(`select status from rc_subscribers where email='flow@example.com'`))[0].status).toBe("confirmed")
  })
})
