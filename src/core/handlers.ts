import { createHmac, timingSafeEqual } from "node:crypto"
import { cap, cleanSource, poolFor, readSecrets, type PageCopy, type Secrets, type Site } from "./config"
import { readCapped, readForm, readJson } from "./body"
import { acceptableAddress, isEmail, normalizeEmail, type Resolver } from "./email"
import { idempotencyKey, renderMail, resendMailer, unsubscribeHeaders, type Mailer } from "./mail"
import { supabaseStore } from "./supabase-store"
import { utcDay, type NlRow, type Store } from "./store"
import { DEFAULT_PAGES, htmlResponse, page } from "./html"
import { TOKEN_RE, confirmUrl, hashToken, newConfirmToken, unsubscribeApiUrl, unsubscribePageUrl, unsubscribeTokenValid } from "./tokens"

/* The request handlers, framework-free (Web Request in, Response out). Adapters in ../next.ts and
   ../node.ts supply `defer`, which runs work after the reply has gone. */

export type Defer = (work: () => Promise<void>) => void

export type Deps = {
  defer: Defer
  env?: Record<string, string | undefined>
  /** Overrides for tests; built from the site's secrets when absent. */
  store?: Store
  mailer?: Mailer
  resolver?: Resolver
  now?: () => Date
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** A confirmation link is good for 48 h; the purge job uses the same window. */
export const CONFIRM_WINDOW_MS = 48 * HOUR
export const PENDING_COOLDOWN_MS = HOUR
export const CONFIRMED_COOLDOWN_MS = DAY
export const WELCOME_GAP_MS = DAY
export const MAX_SENDS_PER_PENDING_ROW = 3
const WEBHOOK_MAX_BYTES = 65536
const WEBHOOK_TOLERANCE_S = 300

const NO_STORE = { "cache-control": "no-store" }
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE })
const OK = () => json(200, { ok: true })
const INVALID = (status: 400 | 413 | 415 = 400) => json(status, { ok: false, error: "invalid" })
const UNAVAILABLE = () => json(503, { ok: false, error: "unavailable" })

type Ctx = { site: Site; secrets: Secrets; store: Store; mailer: Mailer; now: () => Date; env: Record<string, string | undefined> }

function context(site: Site, deps: Deps): Ctx | null {
  const env = deps.env ?? process.env
  const secrets = readSecrets(site, env)
  if (!secrets) return null
  return {
    site,
    secrets,
    env,
    store: deps.store ?? supabaseStore(secrets.supabaseUrl, secrets.supabaseKey),
    mailer: deps.mailer ?? resendMailer(secrets.resendKey),
    now: deps.now ?? (() => new Date()),
  }
}

/** Runs deferred work and logs a failure without the address. Never throws. */
function later(deps: Deps, label: string, work: () => Promise<void>): void {
  deps.defer(async () => {
    try {
      await work()
    } catch (err) {
      console.error(`[signup-kit] ${label} failed:`, err instanceof Error ? err.message : "error")
    }
  })
}

type Parsed = { kind: "reply"; res: Response } | { kind: "email"; email: string; body: Record<string, unknown> }

/** Body, honeypot, format, throwaway domain and mail server — the same steps, in the same order, for both processes. */
async function parseSignup(req: Request, resolver?: Resolver): Promise<Parsed> {
  if (req.method !== "POST") return { kind: "reply", res: json(405, { ok: false, error: "invalid" }) }
  const body = await readJson(req)
  if (!body.ok) return { kind: "reply", res: INVALID(body.status) }
  const v = body.value
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "reply", res: INVALID() }
  const obj = v as Record<string, unknown>
  if (obj.company !== undefined && typeof obj.company !== "string") return { kind: "reply", res: INVALID() }
  if (typeof obj.company === "string" && obj.company.trim() !== "") return { kind: "reply", res: OK() }
  const email = await acceptableAddress(obj.email, resolver)
  if (!email) return { kind: "reply", res: INVALID() }
  return { kind: "email", email, body: obj }
}

/* ───────────────────────────── waitlist ───────────────────────────── */

export async function waitlistSignup(req: Request, site: Site, deps: Deps): Promise<Response> {
  const parsed = await parseSignup(req, deps.resolver)
  if (parsed.kind === "reply") return parsed.res
  const ctx = context(site, deps)
  if (!ctx) return UNAVAILABLE()
  const { email, body } = parsed
  let outcome: "new" | "repeat"
  try {
    /* One insert, the same for a new and a repeat address: the reply never depends on which it was. */
    outcome = await ctx.store.wlInsert(site.table, {
      email,
      source: cleanSource(site, body.source),
      user_agent: cap(req.headers.get("user-agent")),
      referrer: cap(req.headers.get("referer")),
    })
  } catch (err) {
    console.error("[signup-kit] waitlist insert failed:", err instanceof Error ? err.message : "error")
    return UNAVAILABLE()
  }
  later(deps, "waitlist welcome", () => afterWaitlistSignup(ctx, email, outcome))
  return OK()
}

async function afterWaitlistSignup(ctx: Ctx, email: string, outcome: "new" | "repeat"): Promise<void> {
  const { store, site } = ctx
  let previous: string | null = null
  if (outcome === "repeat") {
    const row = await store.wlGet(site.table, email)
    if (!row) return
    if (row.unsubscribed_at) {
      /* Signing up again after unsubscribing puts the address back on the list (owner, 2026-10-08). */
      await store.wlResubscribe(site.table, email)
    } else if (row.welcome_sent_at) {
      return
    }
    previous = row.welcome_sent_at
    if (previous && ctx.now().getTime() - Date.parse(previous) < WELCOME_GAP_MS) return
  }
  await sendWelcome(ctx, email, previous)
}

async function sendWelcome(ctx: Ctx, email: string, previous: string | null): Promise<void> {
  const { store, site, mailer, secrets } = ctx
  const now = ctx.now()
  const stamp = now.toISOString()
  if (!(await store.wlClaimWelcome(site.table, email, stamp, previous))) return
  const { pool, limit } = poolFor(site, ctx.env)
  if (!(await store.takeSend(pool, limit))) {
    await store.wlReleaseWelcome(site.table, email, stamp, previous)
    return
  }
  const copy = site.copy.welcome!
  const { text, html } = renderMail(copy, unsubscribePageUrl(site, secrets.tokenSecret, email), site.signer, true)
  const sent = await mailer.send({
    from: site.from,
    to: email,
    replyTo: site.replyTo,
    subject: copy.subject,
    text,
    html,
    headers: unsubscribeHeaders(unsubscribeApiUrl(site, secrets.tokenSecret, email)),
    idempotencyKey: idempotencyKey(site.site, email, "welcome", utcDay(now)),
  })
  if (!sent.ok) {
    await store.giveBack(pool, utcDay(now))
    await store.wlReleaseWelcome(site.table, email, stamp, previous)
  }
}

/* ───────────────────────────── newsletter ───────────────────────────── */

export async function newsletterSignup(req: Request, site: Site, deps: Deps): Promise<Response> {
  const parsed = await parseSignup(req, deps.resolver)
  if (parsed.kind === "reply") return parsed.res
  const ctx = context(site, deps)
  if (!ctx) return UNAVAILABLE()
  const { pool, limit } = poolFor(site, ctx.env)
  try {
    /* Read-only and the same for every address: a spent pool gives everyone the same 503. */
    if (!(await ctx.store.poolOpen(pool, limit))) return UNAVAILABLE()
  } catch {
    return UNAVAILABLE()
  }
  const { email, body } = parsed
  /* Every lookup, write, send and restore happens after the reply, so the reply's timing says nothing about the address. */
  later(deps, "newsletter sign-up", () => afterNewsletterSignup(ctx, email, cleanSource(site, body.source)))
  return OK()
}

const neverMailAgain = (row: NlRow) => row.status === "unsubscribed" && (row.unsubscribe_reason === "bounced" || row.unsubscribe_reason === "complained")

export async function afterNewsletterSignup(ctx: Ctx, email: string, source: string): Promise<void> {
  const { store, site, mailer, secrets } = ctx
  const now = ctx.now()
  const stamp = now.toISOString()
  const row = await store.nlFind(site.table, email)
  if (row && neverMailAgain(row)) return
  const { pool, limit } = poolFor(site, ctx.env)

  if (row?.status === "confirmed") {
    /* "Already on the list" at most once per 24 h (audit fault 4). */
    const cutoff = new Date(now.getTime() - CONFIRMED_COOLDOWN_MS).toISOString()
    if (!(await store.nlStampConfirmed(site.table, email, stamp, cutoff))) return
    const undo = () => store.nlRestoreConfirmed(site.table, email, stamp, row.confirm_sent_at)
    if (!(await store.takeSend(pool, limit))) return undo()
    const copy = site.copy.already!
    const { text, html } = renderMail(copy, unsubscribePageUrl(site, secrets.tokenSecret, email), site.signer, true)
    const sent = await mailer.send({
      from: site.from,
      to: email,
      replyTo: site.replyTo,
      subject: copy.subject,
      text,
      html,
      headers: unsubscribeHeaders(unsubscribeApiUrl(site, secrets.tokenSecret, email)),
      idempotencyKey: idempotencyKey(site.site, email, "already", utcDay(now)),
    })
    if (!sent.ok) {
      await store.giveBack(pool, utcDay(now))
      await undo()
    }
    return
  }

  if (row?.status === "pending" && row.confirm_sends >= MAX_SENDS_PER_PENDING_ROW) return
  const token = newConfirmToken()
  const tokenHash = hashToken(token)
  const fields = { confirm_token_hash: tokenHash, confirm_sent_at: stamp, confirm_sends: row?.status === "pending" ? row.confirm_sends + 1 : 1 }
  if (row) {
    const cutoff = new Date(now.getTime() - PENDING_COOLDOWN_MS).toISOString()
    if (!(await store.nlToPending(site.table, email, row.status, cutoff, fields))) return
  } else if ((await store.nlInsertPending(site.table, email, source, fields)) === "race") {
    return
  }
  /* Each restore call builds its own deadline, so a slow failed send can't leave the row stuck (audit fault 1). */
  const undo = () => store.nlRestorePending(site.table, email, tokenHash, row)
  if (!(await store.takeSend(pool, limit))) return undo()
  const copy = site.copy.confirm!
  const { text, html } = renderMail(copy, confirmUrl(site, token), site.signer)
  const sent = await mailer.send({
    from: site.from,
    to: email,
    replyTo: site.replyTo,
    subject: copy.subject,
    text,
    html,
    idempotencyKey: idempotencyKey(site.site, email, "confirm", tokenHash),
  })
  if (!sent.ok) {
    await store.giveBack(pool, utcDay(now))
    await undo()
  }
}

/* ───────────────────────── confirm (newsletter) ───────────────────────── */

const pageCopy = (site: Site, key: keyof Site["copy"]): PageCopy => (site.copy[key] as PageCopy | undefined) ?? DEFAULT_PAGES[key]!

function resultRedirect(site: Site, result: string): Response {
  const target = `${site.url}${site.paths.resultPage ?? "/"}?${site.kind}=${encodeURIComponent(result)}#${site.kind}`
  return new Response(null, { status: 303, headers: { location: target, ...NO_STORE } })
}

export async function newsletterConfirm(req: Request, site: Site, deps: Deps): Promise<Response> {
  const url = new URL(req.url)
  const ownPage = site.paths.confirmPage !== site.paths.confirmApi
  if (req.method === "GET") {
    const t = url.searchParams.get("t") ?? ""
    if (ownPage) return new Response(null, { status: 303, headers: { location: `${site.url}${site.paths.confirmPage}?t=${encodeURIComponent(t)}`, ...NO_STORE } })
    if (!TOKEN_RE.test(t)) return htmlResponse(page(pageCopy(site, "expired")), 400)
    return htmlResponse(page(pageCopy(site, "confirmPage"), { action: site.paths.confirmApi!, fields: { t } }))
  }
  if (req.method !== "POST") return new Response(null, { status: 405 })
  const form = await readForm(req)
  const t = form?.get("t") ?? url.searchParams.get("t") ?? ""
  let result: "confirmed" | "expired" = "expired"
  const ctx = context(site, deps)
  if (ctx && TOKEN_RE.test(t)) {
    try {
      const now = ctx.now()
      const since = new Date(now.getTime() - CONFIRM_WINDOW_MS).toISOString()
      if (await ctx.store.nlConfirm(site.table, hashToken(t), since, now.toISOString())) result = "confirmed"
    } catch (err) {
      console.error("[signup-kit] confirm failed:", err instanceof Error ? err.message : "error")
    }
  }
  if (ownPage) return resultRedirect(site, result)
  return htmlResponse(page(pageCopy(site, result)), result === "confirmed" ? 200 : 400)
}

/* ───────────────────────── unsubscribe (both) ───────────────────────── */

const ONE_CLICK = "List-Unsubscribe=One-Click"

export async function unsubscribe(req: Request, site: Site, deps: Deps): Promise<Response> {
  const url = new URL(req.url)
  const ownPage = site.paths.unsubscribePage !== site.paths.unsubscribeApi
  if (req.method === "GET") {
    /* A GET never changes anything: mail scanners follow every link. */
    if (ownPage) return new Response(null, { status: 303, headers: { location: `${site.url}${site.paths.unsubscribePage}${url.search}`, ...NO_STORE } })
    const e = normalizeEmail(url.searchParams.get("e"))
    const t = url.searchParams.get("t") ?? ""
    if (!e || !TOKEN_RE.test(t)) return htmlResponse(page(pageCopy(site, "invalidLink")), 400)
    return htmlResponse(page(pageCopy(site, "unsubscribePage"), { action: `${site.paths.unsubscribeApi}?e=${encodeURIComponent(e)}&t=${t}`, fields: { e, t } }))
  }
  if (req.method !== "POST") return new Response(null, { status: 405 })
  const form = await readForm(req)
  const oneClick = form?.get("List-Unsubscribe") === "One-Click" || (form?.toString() ?? "") === ONE_CLICK
  const e = normalizeEmail(form?.get("e") ?? url.searchParams.get("e"))
  const t = form?.get("t") ?? url.searchParams.get("t") ?? ""
  const ctx = context(site, deps)
  let result: "unsubscribed" | "invalid" = "invalid"
  if (ctx && e && unsubscribeTokenValid(ctx.secrets.tokenSecret, e, t)) {
    try {
      const nowIso = ctx.now().toISOString()
      const r = site.kind === "newsletter" ? await ctx.store.nlUnsubscribe(site.table, e, "user", nowIso) : await ctx.store.wlUnsubscribe(site.table, e, nowIso)
      if (r !== "unknown") result = "unsubscribed"
    } catch (err) {
      console.error("[signup-kit] unsubscribe failed:", err instanceof Error ? err.message : "error")
      if (oneClick) return new Response(null, { status: 503, headers: NO_STORE })
    }
  }
  if (oneClick) return new Response(null, { status: result === "unsubscribed" ? 200 : 400, headers: NO_STORE })
  if (ownPage) return resultRedirect(site, result)
  return htmlResponse(page(pageCopy(site, result === "unsubscribed" ? "unsubscribed" : "invalidLink")), result === "unsubscribed" ? 200 : 400)
}

/* ───────────────────────── Resend webhook (newsletter) ───────────────────────── */

export function verifySvix(raw: string, headers: Headers, secret: string | undefined, nowS = Date.now() / 1000): boolean {
  const id = headers.get("svix-id")
  const ts = headers.get("svix-timestamp")
  const sigs = headers.get("svix-signature")
  if (!secret || !id || !ts || !sigs) return false
  const age = Math.abs(nowS - Number(ts))
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_S) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest()
  return sigs.split(" ").some((entry) => {
    const [version, value] = entry.split(",")
    if (version !== "v1" || !value) return false
    const given = Buffer.from(value, "base64")
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

export async function newsletterWebhook(req: Request, site: Site, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 })
  let raw: string | null
  try {
    raw = await readCapped(req.body, Number(req.headers.get("content-length") ?? 0), WEBHOOK_MAX_BYTES)
  } catch {
    return new Response(null, { status: 400 })
  }
  if (raw === null) return new Response(null, { status: 413 })
  const env = deps.env ?? process.env
  if (!verifySvix(raw, req.headers, env[site.env.webhookSecret], (deps.now?.() ?? new Date()).getTime() / 1000)) return new Response(null, { status: 401 })
  let event: { type?: string; data?: { to?: unknown } }
  try {
    event = JSON.parse(raw)
  } catch {
    return new Response(null, { status: 400 })
  }
  if (event.type === "email.bounced" || event.type === "email.complained") {
    const given = event.data?.to
    const list: unknown[] = Array.isArray(given) ? given : given == null ? [] : [given]
    const to = list.filter((a): a is string => typeof a === "string").map((a) => a.trim().toLowerCase()).filter(isEmail)
    if (to.length > 0) {
      const ctx = context(site, deps)
      if (!ctx) return new Response(null, { status: 500 })
      try {
        await ctx.store.nlMarkUndeliverable(site.table, to, event.type === "email.bounced" ? "bounced" : "complained", ctx.now().toISOString())
      } catch {
        /* Resend sends the event again on any non-2xx, so a bounce is never acknowledged until the row says so. */
        return new Response(null, { status: 500 })
      }
    }
  }
  return new Response(null, { status: 204 })
}
