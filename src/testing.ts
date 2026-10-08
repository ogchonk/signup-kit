import type { Mailer, Message, SendResult } from "./core/mail"
import type { Resolver } from "./core/email"
import { utcDay, type NlRow, type PendingFields, type Store, type WlRow } from "./core/store"

/* Test kit shared by the package and every site's own tests: an in-memory store with the same
   behaviour as the Supabase one, a recording mailer, a resolver that needs no network, and the
   contract fixtures every sign-up endpoint must pass. Concurrency and SQL behaviour are proven
   against real Postgres in the package's test:db, not with this fake. */

export type FakeStore = Store & {
  calls: string[]
  waitlist: Map<string, Map<string, WlRow & { source: string }>>
  newsletter: Map<string, Map<string, NlRow & { source: string }>>
  quota: Map<string, number>
  failNext: (op: string) => void
}

export function fakeStore(): FakeStore {
  const waitlist = new Map<string, Map<string, WlRow & { source: string }>>()
  const newsletter = new Map<string, Map<string, NlRow & { source: string }>>()
  const quota = new Map<string, number>()
  const calls: string[] = []
  const failing = new Set<string>()
  const wl = (t: string) => waitlist.get(t) ?? waitlist.set(t, new Map()).get(t)!
  const nl = (t: string) => newsletter.get(t) ?? newsletter.set(t, new Map()).get(t)!
  const qk = (pool: string, day: string) => `${day}|${pool}`
  const today = () => utcDay(new Date())
  const op = (name: string) => {
    calls.push(name)
    if (failing.delete(name)) throw new Error(`fake failure: ${name}`)
  }
  const stale = (stamp: string | null, cutoff: string) => stamp === null || stamp < cutoff

  return {
    calls,
    waitlist,
    newsletter,
    quota,
    failNext: (name) => failing.add(name),
    async poolOpen(pool, limit) {
      op("poolOpen")
      return (quota.get(qk(pool, today())) ?? 0) < limit
    },
    async takeSend(pool, limit) {
      op("takeSend")
      const day = today()
      const k = qk(pool, day)
      const n = quota.get(k) ?? 0
      if (n >= limit) return null
      quota.set(k, n + 1)
      return day
    },
    async giveBack(pool, day) {
      op("giveBack")
      const k = qk(pool, day)
      quota.set(k, Math.max((quota.get(k) ?? 0) - 1, 0))
    },
    async wlInsert(table, row) {
      op("wlInsert")
      const t = wl(table)
      if (t.has(row.email)) return "repeat"
      t.set(row.email, { unsubscribed_at: null, welcome_sent_at: null, source: row.source })
      return "new"
    },
    async wlGet(table, email) {
      op("wlGet")
      const r = wl(table).get(email)
      return r ? { unsubscribed_at: r.unsubscribed_at, welcome_sent_at: r.welcome_sent_at } : null
    },
    async wlClaimWelcome(table, email, now, previous, resubscribe) {
      op("wlClaimWelcome")
      const r = wl(table).get(email)
      if (!r || r.welcome_sent_at !== previous) return false
      if (resubscribe ? r.unsubscribed_at === null : r.unsubscribed_at !== null) return false
      r.welcome_sent_at = now
      if (resubscribe) r.unsubscribed_at = null
      return true
    },
    async wlReleaseWelcome(table, email, claimed, previous, unsubscribedAt) {
      op("wlReleaseWelcome")
      const r = wl(table).get(email)
      if (!r || r.welcome_sent_at !== claimed) return
      r.welcome_sent_at = previous
      if (unsubscribedAt !== undefined) r.unsubscribed_at = unsubscribedAt
    },
    async wlUnsubscribe(table, email, now) {
      op("wlUnsubscribe")
      const r = wl(table).get(email)
      if (!r) return "unknown"
      if (r.unsubscribed_at === null) r.unsubscribed_at = now
      return "done"
    },
    async nlFind(table, email) {
      op("nlFind")
      const r = nl(table).get(email)
      return r ? { ...r } : null
    },
    async nlStampConfirmed(table, email, now, cutoff) {
      op("nlStampConfirmed")
      const r = nl(table).get(email)
      if (!r || r.status !== "confirmed" || !stale(r.confirm_sent_at, cutoff)) return false
      r.confirm_sent_at = now
      return true
    },
    async nlRestoreConfirmed(table, email, claimed, previous) {
      op("nlRestoreConfirmed")
      const r = nl(table).get(email)
      if (r && r.status === "confirmed" && r.confirm_sent_at === claimed) r.confirm_sent_at = previous
    },
    async nlToPending(table, email, expect, cutoff, f: PendingFields) {
      op("nlToPending")
      const r = nl(table).get(email)
      if (!r || r.status !== expect || !stale(r.confirm_sent_at, cutoff)) return false
      Object.assign(r, { status: "pending", ...f, unsubscribed_at: null, unsubscribe_reason: null })
      return true
    },
    async nlInsertPending(table, email, source, f) {
      op("nlInsertPending")
      const t = nl(table)
      if (t.has(email)) return "race"
      t.set(email, { email, source, status: "pending", ...f, unsubscribed_at: null, unsubscribe_reason: null })
      return "new"
    },
    async nlRestorePending(table, email, tokenHash, previous) {
      op("nlRestorePending")
      const r = nl(table).get(email)
      if (!r || r.status !== "pending" || r.confirm_token_hash !== tokenHash) return
      if (previous) Object.assign(r, { ...previous, source: r.source })
      else Object.assign(r, { confirm_token_hash: null, confirm_sent_at: null, confirm_sends: 0 })
    },
    async nlConfirm(table, tokenHash, since) {
      op("nlConfirm")
      for (const r of nl(table).values()) {
        if (r.confirm_token_hash === tokenHash && r.status === "pending" && r.confirm_sent_at !== null && r.confirm_sent_at >= since) {
          Object.assign(r, { status: "confirmed", confirm_token_hash: null, confirm_sends: 0 })
          return true
        }
      }
      return false
    },
    async nlUnsubscribe(table, email, reason, now) {
      op("nlUnsubscribe")
      const r = nl(table).get(email)
      if (!r) return "unknown"
      if (r.status === "unsubscribed") return "already"
      Object.assign(r, { status: "unsubscribed", unsubscribed_at: now, unsubscribe_reason: reason, confirm_token_hash: null, confirm_sends: 0 })
      return "done"
    },
    async nlMarkUndeliverable(table, emails, reason, now) {
      op("nlMarkUndeliverable")
      for (const e of emails) {
        const r = nl(table).get(e)
        if (r) Object.assign(r, { status: "unsubscribed", unsubscribed_at: now, unsubscribe_reason: reason, confirm_token_hash: null, confirm_sends: 0 })
      }
    },
  }
}

export type FakeMailer = Mailer & { sent: Message[]; mode: "ok" | "fail" | "slow-fail"; delayMs: number }

export function fakeMailer(): FakeMailer {
  const m: FakeMailer = {
    sent: [],
    mode: "ok",
    delayMs: 0,
    async send(msg): Promise<SendResult> {
      if (m.delayMs) await new Promise((r) => setTimeout(r, m.delayMs))
      if (m.mode !== "ok") return { ok: false, reason: m.mode === "slow-fail" ? "timeout" : "rejected" }
      m.sent.push(msg)
      return { ok: true }
    },
  }
  return m
}

/** A resolver that says every domain takes mail, except names in `noMail`. */
export function fakeResolver(noMail: string[] = []): Resolver {
  const no = (d: string) => noMail.includes(d)
  const notFound = () => Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })
  return {
    resolveMx: async (d) => (no(d) ? Promise.reject(notFound()) : [{ exchange: "mx." + d }]),
    resolve4: async (d) => (no(d) ? Promise.reject(notFound()) : ["192.0.2.1"]),
    resolve6: async (d) => (no(d) ? Promise.reject(notFound()) : []),
  }
}

/** Env with every secret a site needs, under the default names. */
export function fakeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    RESEND_API_KEY: "test-key",
    SIGNUP_SECRET: "test-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "test-supabase",
    RESEND_WEBHOOK_SECRET: "whsec_" + Buffer.from("webhook-secret").toString("base64"),
    ...extra,
  }
}

export type Fixture = { name: string; init: RequestInit & { headers?: Record<string, string> }; status: number; body?: string }

const J = { "content-type": "application/json" }

/** The behaviour every sign-up endpoint must show, whatever site or adapter it runs on. */
export const contractFixtures: Fixture[] = [
  { name: "not JSON → 415", init: { method: "POST", headers: { "content-type": "text/plain" }, body: "a@example.com" }, status: 415, body: '{"ok":false,"error":"invalid"}' },
  { name: "body over 2 KB → 413", init: { method: "POST", headers: J, body: JSON.stringify({ email: "a@example.com", pad: "x".repeat(2100) }) }, status: 413, body: '{"ok":false,"error":"invalid"}' },
  { name: "malformed JSON → 400", init: { method: "POST", headers: J, body: "{" }, status: 400, body: '{"ok":false,"error":"invalid"}' },
  { name: "non-string email → 400", init: { method: "POST", headers: J, body: JSON.stringify({ email: 42 }) }, status: 400, body: '{"ok":false,"error":"invalid"}' },
  { name: "bad format → 400", init: { method: "POST", headers: J, body: JSON.stringify({ email: "a@@b" }) }, status: 400, body: '{"ok":false,"error":"invalid"}' },
  { name: "disposable domain → 400", init: { method: "POST", headers: J, body: JSON.stringify({ email: "a@mailinator.com" }) }, status: 400, body: '{"ok":false,"error":"invalid"}' },
  { name: "no mail server → 400", init: { method: "POST", headers: J, body: JSON.stringify({ email: "a@nomail.example" }) }, status: 400, body: '{"ok":false,"error":"invalid"}' },
  { name: "honeypot → 200", init: { method: "POST", headers: J, body: JSON.stringify({ email: "a@example.com", company: "Acme" }) }, status: 200, body: '{"ok":true}' },
  { name: "new address → 200", init: { method: "POST", headers: J, body: JSON.stringify({ email: "new@example.com" }) }, status: 200, body: '{"ok":true}' },
  { name: "repeat address → 200, same bytes", init: { method: "POST", headers: J, body: JSON.stringify({ email: "new@example.com" }) }, status: 200, body: '{"ok":true}' },
]

export type ContractResult = { name: string; pass: boolean; status: number; body: string; expected: Fixture }

export type ContractOptions = {
  url?: string
  /** Address used for the new/repeat rows. Offline tests keep the default; live probes pass one with real MX (e.g. delivered@resend.dev). */
  address?: string
  /** Live probes skip the row that needs a domain with no mail server. */
  skipNoMail?: boolean
}

/** Runs every fixture in order against a handler and reports each result. */
export async function runContract(handler: (req: Request) => Promise<Response>, opts: ContractOptions | string = {}): Promise<ContractResult[]> {
  const o: ContractOptions = typeof opts === "string" ? { url: opts } : opts
  const url = o.url ?? "https://site.test/api/signup"
  const out: ContractResult[] = []
  for (const fixture of contractFixtures) {
    if (o.skipNoMail && fixture.name.startsWith("no mail server")) continue
    const f = o.address && typeof fixture.init.body === "string" ? { ...fixture, init: { ...fixture.init, body: fixture.init.body.replaceAll("new@example.com", o.address) } } : fixture
    const res = await handler(new Request(url, f.init as RequestInit))
    const body = await res.text()
    out.push({ name: f.name, status: res.status, body, expected: fixture, pass: res.status === f.status && (f.body === undefined || body === f.body) && res.headers.get("cache-control") === "no-store" })
  }
  return out
}
