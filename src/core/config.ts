/* One config object per site. Everything site-specific lives here: domain, table, sender, copy,
   paths and the names of the environment variables that hold its secrets. defineSite() validates it
   once at import time so a bad config fails the build, not a visitor's request. */

export type Kind = "waitlist" | "newsletter"

export type MailCopy = {
  subject: string
  greeting: string
  body: string
  button: string
  note: string
}

export type PageCopy = {
  title: string
  heading: string
  body: string
  button?: string
}

export type SiteInput = {
  /** Short id, e.g. "ntabc". Used in pool names and idempotency keys. */
  site: string
  kind: Kind
  /** Canonical origin, e.g. "https://ntabc.co". Every link in mail is built on it; request headers are never used. */
  url: string
  table: string
  /** "Name <che@domain>" — must be on the site's own domain. */
  from: string
  replyTo?: string
  signer: string
  pool?: string
  poolLimit?: number
  sources?: string[]
  defaultSource?: string
  env?: Partial<EnvNames>
  paths: {
    /** Where people land from an unsubscribe link. Equal to unsubscribeApi on sites without their own page. */
    unsubscribePage: string
    unsubscribeApi: string
    confirmPage?: string
    confirmApi?: string
    /** Where button posts redirect with ?<kind>=<result>#<kind>. Default "/". */
    resultPage?: string
  }
  copy: {
    welcome?: MailCopy
    confirm?: MailCopy
    already?: MailCopy
    unsubscribePage?: PageCopy
    unsubscribed?: PageCopy
    invalidLink?: PageCopy
    confirmPage?: PageCopy
    confirmed?: PageCopy
    expired?: PageCopy
  }
}

export type EnvNames = {
  resendKey: string
  tokenSecret: string
  webhookSecret: string
  supabaseUrl: string
  supabaseKey: string[]
}

export type Site = Required<Pick<SiteInput, "site" | "kind" | "url" | "table" | "from" | "signer" | "paths" | "copy">> & {
  replyTo?: string
  domain: string
  pool: string
  poolLimit: number
  sources: string[]
  defaultSource: string
  env: EnvNames
}

export const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/
export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
export const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const FROM_RE = /^[^<>\r\n]{1,80} <([^<>@\s]+)@([^<>@\s]+)>$/

const DEFAULT_ENV: EnvNames = {
  resendKey: "RESEND_API_KEY",
  tokenSecret: "SIGNUP_SECRET",
  webhookSecret: "RESEND_WEBHOOK_SECRET",
  supabaseUrl: "SUPABASE_URL",
  supabaseKey: ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
}

export class ConfigError extends Error {}

export function defineSite(input: SiteInput): Site {
  const fail = (msg: string): never => {
    throw new ConfigError(`signup-kit config for "${input.site}": ${msg}`)
  }
  if (!SITE_RE.test(input.site)) fail("site must match " + SITE_RE)
  if (input.kind !== "waitlist" && input.kind !== "newsletter") fail("kind must be waitlist or newsletter")
  if (!TABLE_RE.test(input.table)) fail("table must match " + TABLE_RE)
  let host = ""
  try {
    const u = new URL(input.url)
    if (u.protocol !== "https:" && u.hostname !== "localhost") fail("url must be https")
    if (u.pathname !== "/" || u.search || u.hash) fail("url must be an origin with no path")
    host = u.hostname
  } catch (e) {
    if (e instanceof ConfigError) throw e
    fail("url is not a valid URL")
  }
  const m = FROM_RE.exec(input.from ?? "")
  if (!m) fail('from must look like "Name <local@domain>"')
  const domain = m![2]!.toLowerCase()
  if (!HOST_RE.test(domain)) fail("from domain is not a hostname")
  if (host !== "localhost" && host !== domain && !host.endsWith("." + domain)) fail(`from domain ${domain} is not the site's domain ${host}`)
  if (!input.signer?.trim()) fail("signer is required")
  for (const [k, v] of Object.entries(input.paths ?? {})) {
    if (typeof v === "string" && !/^\/[A-Za-z0-9/_-]*$/.test(v)) fail(`path ${k} must start with / and contain only safe characters`)
  }
  if (!input.paths?.unsubscribePage || !input.paths?.unsubscribeApi) fail("paths.unsubscribePage and paths.unsubscribeApi are required")
  const c = input.copy ?? {}
  if (input.kind === "waitlist" && !c.welcome) fail("copy.welcome is required for a waitlist")
  if (input.kind === "newsletter") {
    if (!c.confirm || !c.already) fail("copy.confirm and copy.already are required for a newsletter")
    if (!input.paths.confirmApi || !input.paths.confirmPage) fail("paths.confirmApi and paths.confirmPage are required for a newsletter")
  }
  const sources = input.sources?.length ? input.sources : [input.defaultSource ?? input.site]
  for (const s of sources) if (!/^[a-z0-9-]{1,40}$/.test(s)) fail(`source "${s}" must be lowercase letters, digits or hyphens`)
  const pool = input.pool ?? `${input.site}-${input.kind}`
  if (!/^[a-z0-9_.-]{1,58}$/.test(pool)) fail("pool must be lowercase letters, digits, _ . or -")
  return {
    site: input.site,
    kind: input.kind,
    url: input.url.replace(/\/$/, ""),
    table: input.table,
    from: input.from,
    replyTo: input.replyTo,
    signer: input.signer,
    paths: input.paths,
    copy: c,
    domain,
    pool,
    poolLimit: input.poolLimit ?? (input.kind === "newsletter" ? 40 : 20),
    sources,
    defaultSource: input.defaultSource ?? sources[0]!,
    env: { ...DEFAULT_ENV, ...input.env },
  }
}

/** Pool and limit for this request. Outside Vercel production, traffic uses a separate small pool so tests and dev never spend real allowance. */
export function poolFor(site: Site, env: Record<string, string | undefined> = process.env): { pool: string; limit: number } {
  return env.VERCEL_ENV === "production" ? { pool: site.pool, limit: site.poolLimit } : { pool: `${site.pool}:dev`, limit: 5 }
}

export type Secrets = { resendKey: string; tokenSecret: string; supabaseUrl: string; supabaseKey: string }

/** Reads the site's secrets at call time. Null when any is missing, so the caller answers 503 rather than crashing. */
export function readSecrets(site: Site, env: Record<string, string | undefined> = process.env): Secrets | null {
  const resendKey = env[site.env.resendKey]
  const tokenSecret = env[site.env.tokenSecret]
  const supabaseUrl = env[site.env.supabaseUrl]
  const supabaseKey = site.env.supabaseKey.map((k) => env[k]).find(Boolean)
  if (!resendKey || !tokenSecret || !supabaseUrl || !supabaseKey) return null
  return { resendKey, tokenSecret, supabaseUrl, supabaseKey }
}

export function cleanSource(site: Site, given: unknown): string {
  return typeof given === "string" && site.sources.includes(given) ? given : site.defaultSource
}

export const cap = (s: string | null | undefined, n = 512): string | null => (s ? s.slice(0, n) : null)
