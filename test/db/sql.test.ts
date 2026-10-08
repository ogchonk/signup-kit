import { readFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/* Runs the package's SQL against a real Postgres (CI: postgres:16 service; locally: a docker
   container). DATABASE_URL must point at a throwaway database: this suite drops and recreates objects. */

const url = process.env.DATABASE_URL ?? "postgres://postgres:t@localhost:55432/postgres"
const sql = (f: string) => readFileSync(join(__dirname, "../../sql", f), "utf8")
const render = (f: string, table: string) => sql(f).replaceAll("{{table}}", table)
let db: pg.Pool

const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows

async function snapshot(): Promise<string> {
  const parts = await Promise.all([
    q(`select table_name, column_name, data_type, column_default, is_nullable from information_schema.columns where table_schema='public' order by 1,2`),
    q(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace='public'::regnamespace order by 1,2`),
    q(`select tablename, indexdef from pg_indexes where schemaname='public' order by 1,2`),
    q(`select proname, pg_get_function_identity_arguments(oid) a, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace order by 1`),
    q(`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='public' order by 1,2,3`),
    q(`select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'execute') x from pg_proc p cross join pg_roles r where p.pronamespace='public'::regnamespace and r.rolname in ('anon','authenticated','service_role') order by 1,2`),
  ])
  return JSON.stringify(parts)
}

beforeAll(async () => {
  db = new pg.Pool({ connectionString: url, max: 60 })
  await q(`drop schema if exists public cascade; create schema public; grant usage on schema public to public`)
  for (const r of ["anon", "authenticated", "service_role"]) await q(`do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin; end if; end $$`)
  /* As on Supabase: service_role bypasses row-level security; the anon roles don't. */
  await q(`alter role service_role bypassrls`)
  await q(`grant usage on schema public to anon, authenticated, service_role`)
  await q(`alter default privileges in schema public grant all on tables to service_role`)
  /* Exact copies of the live waitlist shapes (catalog, 2026-10-08). */
  await q(`create table public.pf_waitlist_signups (id uuid primary key default gen_random_uuid(), email text not null, submitted_at timestamptz not null default now(), source text, user_agent text, referrer text);
    create unique index pf_waitlist_signups_email_key on public.pf_waitlist_signups (lower(email));
    create index pf_waitlist_signups_submitted_at_idx on public.pf_waitlist_signups (submitted_at desc);
    alter table public.pf_waitlist_signups enable row level security;
    grant all on public.pf_waitlist_signups to anon, authenticated;
    create table public.ntabc_waitlist_signups (id uuid primary key default gen_random_uuid(), email text not null, submitted_at timestamptz not null default now(), source text, user_agent text, referrer text,
      constraint ntabc_waitlist_signups_email_key unique (email), constraint ntabc_waitlist_signups_email_lower_ck check (email = lower(email)));
    alter table public.ntabc_waitlist_signups enable row level security;
    insert into public.pf_waitlist_signups (email) values ('x@y.co'); insert into public.ntabc_waitlist_signups (email) values ('z@y.co');`)
  /* The live rc_subscribers shape. */
  await q(`create table public.rc_subscribers (id uuid primary key default gen_random_uuid(), email text not null, status text not null default 'pending', source text not null default 'footer',
      confirm_token_hash text, confirm_sent_at timestamptz, confirmed_at timestamptz, unsubscribed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      confirm_sends smallint not null default 0, unsubscribe_reason text,
      constraint rc_subscribers_email_key unique (email), constraint rc_subscribers_email_lower check (email = lower(email)),
      constraint rc_subscribers_email_shape check (email ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'),
      constraint rc_subscribers_status_check check (status = any (array['pending','confirmed','unsubscribed'])),
      constraint rc_subscribers_unsubscribe_reason_check check (unsubscribe_reason is null or unsubscribe_reason = any (array['user','bounced','complained'])));
    create index rc_subscribers_created_at_idx on public.rc_subscribers (created_at);
    alter table public.rc_subscribers enable row level security;`)
})

afterAll(async () => {
  await db?.end()
})

describe("shared quota (sql/001)", () => {
  it("upgrades v0.1.1's boolean signup_take_send in place", async () => {
    await q(`create table public.signup_send_quota (day date not null, pool text not null, sends int not null default 0, primary key (day, pool));
      create function public.signup_take_send(p_pool text, p_limit int) returns boolean language sql as $$ select true $$;`)
    await q(sql("001_shared_infra.sql"))
    expect((await q(`select format_type(prorettype, null) t from pg_proc where proname='signup_take_send'`))[0].t).toBe("date")
  })
  it("returns the UTC day it charged, and null at the limit (review S2)", async () => {
    await q(sql("001_shared_infra.sql"))
    const today = (await q(`select ((now() at time zone 'utc')::date)::text d`))[0].d
    const [r] = await q(`select signup_take_send('t1',2)::text a, signup_take_send('t1',2)::text b, signup_take_send('t1',2)::text c`)
    expect(r).toEqual({ a: today, b: today, c: null })
    expect((await q(`select signup_pool_open('t1',2) o`))[0].o).toBe(false)
    expect((await q(`select signup_pool_open('fresh',2) o`))[0].o).toBe(true)
  })
  it("takes exactly the limit under 50 concurrent calls", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => q(`select signup_take_send('conc',40)::text t`)))
    expect(results.filter((r) => r[0].t !== null)).toHaveLength(40)
    expect((await q(`select sends from signup_send_quota where pool='conc'`))[0].sends).toBe(40)
  })
  it("gives back only to the given day and never below zero", async () => {
    await q(`select signup_give_back_send('conc', (now() at time zone 'utc')::date - 1)`)
    expect((await q(`select sends from signup_send_quota where pool='conc'`))[0].sends).toBe(40)
    await q(`select signup_give_back_send('conc', (now() at time zone 'utc')::date)`)
    expect((await q(`select sends from signup_send_quota where pool='conc'`))[0].sends).toBe(39)
    for (let i = 0; i < 3; i++) await q(`select signup_give_back_send('t1', (now() at time zone 'utc')::date)`)
    expect((await q(`select sends from signup_send_quota where pool='t1'`))[0].sends).toBe(0)
  })
  it("pools are separate", async () => {
    expect((await q(`select signup_take_send('other',1)::text t`))[0].t).not.toBeNull()
  })
  it("anon and authenticated can't execute the functions; service_role can", async () => {
    const asRole = async (role: string, text: string) => {
      const c = await db.connect()
      try {
        await c.query(`set role ${role}`)
        return (await c.query(text)).rows
      } finally {
        await c.query("reset role").catch(() => {})
        c.release()
      }
    }
    for (const role of ["anon", "authenticated"]) await expect(asRole(role, `select signup_take_send('x',1)`)).rejects.toThrow(/permission denied/)
    expect((await asRole("service_role", `select signup_take_send('svc',1)::text t`))[0].t).not.toBeNull()
  })
})

describe("waitlist templates (sql/010 structure, sql/011 row checks)", () => {
  const apply = async (file: string) => {
    for (const t of ["pf_waitlist_signups", "ntabc_waitlist_signups"]) await q(render(file, t))
  }
  it("010 converges both live shapes and is idempotent", async () => {
    await apply("010_waitlist_table.sql.tmpl")
    const a = await snapshot()
    await q(sql("001_shared_infra.sql"))
    await apply("010_waitlist_table.sql.tmpl")
    expect(await snapshot()).toBe(a)
  })
  it("010 alone still accepts what today's live sign-up code writes (review B1)", async () => {
    await q(`insert into pf_waitlist_signups(email, user_agent, referrer) values ('Old@Y.co', repeat('u', 900), repeat('r', 900))`)
    await q(`insert into ntabc_waitlist_signups(email, referrer) values ('${"a".repeat(250)}@y.co', repeat('r', 900))`)
    await q(`delete from pf_waitlist_signups where email = 'Old@Y.co'; delete from ntabc_waitlist_signups where email like 'aaaa%'`)
  })
  it("reuses existing uniqueness instead of adding a second unique index", async () => {
    const idx = await q(`select tablename, indexdef from pg_indexes where indexdef ilike 'create unique index%email%' and tablename like '%waitlist%' order by 1`)
    expect(idx.map((r) => r.tablename)).toEqual(["ntabc_waitlist_signups", "pf_waitlist_signups"])
  })
  it("doesn't mistake a multi-column or other-column unique index for email uniqueness", async () => {
    await q(`create table public.odd_waitlist (id uuid primary key default gen_random_uuid(), email text not null, email_hash text, source text, user_agent text, referrer text, submitted_at timestamptz not null default now());
      create unique index odd_pair on public.odd_waitlist (email, source); create unique index odd_hash on public.odd_waitlist (email_hash);`)
    await q(render("010_waitlist_table.sql.tmpl", "odd_waitlist"))
    expect((await q(`select indexname from pg_indexes where tablename='odd_waitlist' and indexdef ilike '%lower(email)%'`)).map((r) => r.indexname)).toEqual(["odd_waitlist_email_key"])
  })
  it("revokes pf's stray public grants", async () => {
    expect(await q(`select * from information_schema.role_table_grants where table_name like '%waitlist%' and grantee in ('anon','authenticated')`)).toHaveLength(0)
  })
  it("011 adds the row checks, idempotently; then uppercase and long text are rejected", async () => {
    await apply("011_waitlist_constraints.sql.tmpl")
    const a = await snapshot()
    await apply("011_waitlist_constraints.sql.tmpl")
    expect(await snapshot()).toBe(a)
    await expect(q(`insert into pf_waitlist_signups(email) values ('x@y.co')`)).rejects.toMatchObject({ code: "23505" })
    await expect(q(`insert into ntabc_waitlist_signups(email) values ('z@y.co')`)).rejects.toMatchObject({ code: "23505" })
    await expect(q(`insert into pf_waitlist_signups(email) values ('Up@y.co')`)).rejects.toMatchObject({ code: "23514" })
    await expect(q(`insert into ntabc_waitlist_signups(email, user_agent) values ('ua@y.co', repeat('u', 513))`)).rejects.toMatchObject({ code: "23514" })
  })
  it("two concurrent inserts of one new address: exactly one wins", async () => {
    const r = await Promise.allSettled([q(`insert into ntabc_waitlist_signups(email) values ('race@y.co')`), q(`insert into ntabc_waitlist_signups(email) values ('race@y.co')`)])
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  })
  it("creates a correct table for a new site (010 + 011)", async () => {
    await q(render("010_waitlist_table.sql.tmpl", "newsite_waitlist_signups"))
    await q(render("011_waitlist_constraints.sql.tmpl", "newsite_waitlist_signups"))
    const idx = await q(`select indexdef from pg_indexes where tablename='newsite_waitlist_signups' and indexdef ilike '%unique%email%'`)
    expect(idx).toHaveLength(1)
    const cols = (await q(`select column_name from information_schema.columns where table_name='newsite_waitlist_signups' order by 1`)).map((r) => r.column_name)
    expect(cols).toEqual(["email", "id", "referrer", "source", "submitted_at", "unsubscribed_at", "user_agent", "welcome_sent_at"])
    expect((await q(`select conname from pg_constraint where conrelid='public.newsite_waitlist_signups'::regclass and contype='c' order by 1`)).map((r) => r.conname)).toEqual(["newsite_waitlist_signups_email_shape", "newsite_waitlist_signups_text_caps"])
  })
})

describe("newsletter template (sql/020)", () => {
  it("changes nothing when applied to the live rc_subscribers shape (compares that table's own catalog)", async () => {
    /* pg_cron isn't in plain postgres:16, so the purge-job branch is skipped here; Phase 5 checks it live. */
    const only = (s: string) => JSON.parse(s).map((part: unknown[]) => part.filter((r) => JSON.stringify(r).includes("rc_subscribers")))
    const before = only(await snapshot())
    expect(before.flat().length).toBeGreaterThan(20)
    await q(render("020_newsletter_table.sql.tmpl", "rc_subscribers"))
    expect(only(await snapshot())).toEqual(before)
    const cons = await q(`select conname from pg_constraint where conrelid='public.rc_subscribers'::regclass order by 1`)
    expect(cons.map((r) => r.conname)).toEqual(["rc_subscribers_email_key", "rc_subscribers_email_lower", "rc_subscribers_email_shape", "rc_subscribers_pkey", "rc_subscribers_status_check", "rc_subscribers_unsubscribe_reason_check"])
  })
  it("creates a full newsletter table for a new site, idempotently", async () => {
    await q(render("020_newsletter_table.sql.tmpl", "newsite_subscribers"))
    const a = await snapshot()
    await q(render("020_newsletter_table.sql.tmpl", "newsite_subscribers"))
    expect(await snapshot()).toBe(a)
  })
})
