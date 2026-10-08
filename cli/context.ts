import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { HOST_RE, SITE_RE, TABLE_RE } from "../src/core/config"

/* What one setup run is about: which site, which process, where its code and Vercel project live,
   and the names it uses. Every value that reaches a URL, a SQL template or a subprocess argument is
   validated here first (G-18). */

export type Kind = "waitlist" | "newsletter"
export type Stack = "next-app" | "vercel-plain"

export type Ctx = {
  kind: Kind
  domain: string
  site: string
  table: string
  url: string
  dir: string
  repo: string
  vercelProject: string
  scope: string
  stack: Stack
  srcPrefix: "" | "src/"
  from: string
  replyTo?: string
  signer: string
  pool: string
  sources: string[]
  env: { resendKey: string; tokenSecret: string; webhookSecret: string }
  paths: { signup: string; unsubscribe: string; confirm?: string; webhook?: string }
  supabaseRef: string
  release: { version: string; url: string }
  dryRun: boolean
  confirmDns?: string
  probeUrl?: string
  branch: string
  /** "deferred": the owner chose not to add the site's firewall rule (e.g. robbychoate.com, whose one Hobby slot holds the chat rule). */
  firewall: "rule" | "deferred"
  /** Optional DMARC aggregate-report address for the mail-DNS step. */
  dmarcRua?: string
}

export class UsageError extends Error {}

const ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const PATH_RE = /^\/[A-Za-z0-9/_-]*$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PROJECT_RE = /^[a-z0-9._-]{1,100}$/
const FROM_RE = /^[^<>\r\n"]{1,80} <che@([^<>@\s]+)>$/
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

export function parseFlags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument "${a}"`)
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

function pkgVersion(): string {
  for (const p of [join(__dirnameSafe(), "..", "package.json"), join(__dirnameSafe(), "..", "..", "package.json")]) {
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version
  }
  return "0.0.0"
}

function __dirnameSafe(): string {
  // dist/cli.js (ESM) and cli/*.ts under vitest both resolve from the process's own file location.
  return typeof __dirname === "string" ? __dirname : new URL(".", import.meta.url).pathname
}

export const releaseUrl = (v: string) => `https://github.com/ogchonk/signup-kit/releases/download/v${v}/ogchonk-signup-kit-${v}.tgz`

export function detectStack(dir: string): { stack: Stack; srcPrefix: "" | "src/" } {
  let deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    deps = { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    /* no package.json: a plain static site */
  }
  const stack: Stack = deps.next ? "next-app" : "vercel-plain"
  return { stack, srcPrefix: stack === "next-app" && existsSync(join(dir, "src", "app")) ? "src/" : "" }
}

export function defaultPaths(stack: Stack, kind: Kind): Ctx["paths"] {
  if (stack === "next-app") {
    return kind === "waitlist"
      ? { signup: "/api/waitlist", unsubscribe: "/api/waitlist/unsubscribe" }
      : { signup: "/api/newsletter", unsubscribe: "/api/newsletter/unsubscribe", confirm: "/api/newsletter/confirm", webhook: "/api/newsletter/webhook" }
  }
  return kind === "waitlist"
    ? { signup: "/api/subscribe", unsubscribe: "/api/unsubscribe" }
    : { signup: "/api/subscribe", unsubscribe: "/api/unsubscribe", confirm: "/api/confirm", webhook: "/api/webhook" }
}

export function buildCtx(flags: Record<string, string | true>, cwd = process.cwd()): Ctx {
  const str = (k: string): string | undefined => {
    const v = flags[k]
    if (v === true) throw new UsageError(`--${k} needs a value`)
    return v
  }
  const need = (k: string): string => {
    const v = str(k)
    if (!v) throw new UsageError(`--${k} is required`)
    return v
  }
  const kind = need("kind")
  if (kind !== "waitlist" && kind !== "newsletter") throw new UsageError("--kind must be waitlist or newsletter")
  const domain = need("domain").toLowerCase()
  if (!HOST_RE.test(domain)) throw new UsageError("--domain is not a valid hostname")
  const label = domain.split(".")[0]!
  const site = str("site") ?? label
  if (!SITE_RE.test(site)) throw new UsageError(`--site must match ${SITE_RE}`)
  const table = str("table") ?? (kind === "waitlist" ? `${site.replaceAll("-", "_")}_waitlist_signups` : `${site.replaceAll("-", "_")}_subscribers`)
  if (!TABLE_RE.test(table)) throw new UsageError(`--table must match ${TABLE_RE}`)
  const dir = resolve(cwd, need("dir"))
  if (!existsSync(dir)) throw new UsageError(`--dir ${dir} does not exist`)
  const repo = need("repo")
  if (!REPO_RE.test(repo)) throw new UsageError("--repo must look like owner/name")
  const vercelProject = need("vercel-project")
  if (!PROJECT_RE.test(vercelProject)) throw new UsageError("--vercel-project is not a valid project name")
  const scope = str("scope") ?? "chonky2024-7036s-projects"
  if (!PROJECT_RE.test(scope)) throw new UsageError("--scope is not a valid team slug")
  const detected = detectStack(dir)
  const stack = (str("stack") as Stack | undefined) ?? detected.stack
  if (stack !== "next-app" && stack !== "vercel-plain") throw new UsageError("--stack must be next-app or vercel-plain")
  const signer = str("signer") ?? domain
  if (/[\r\n<>"]/.test(signer) || signer.length > 80) throw new UsageError("--signer has unsafe characters")
  const from = str("from") ?? `${signer} <che@${domain}>`
  const fm = FROM_RE.exec(from)
  if (!fm || fm[1]!.toLowerCase() !== domain) throw new UsageError(`--from must look like "Name <che@${domain}>"`)
  const replyTo = str("reply-to")
  if (replyTo && !EMAIL_RE.test(replyTo)) throw new UsageError("--reply-to is not an email address")
  const sources = (str("sources") ?? site).split(",").map((s) => s.trim())
  for (const s of sources) if (!/^[a-z0-9-]{1,40}$/.test(s)) throw new UsageError(`source "${s}" must be lowercase letters, digits or hyphens`)
  const env = {
    resendKey: str("resend-key-env") ?? "RESEND_API_KEY",
    tokenSecret: str("token-secret-env") ?? "SIGNUP_SECRET",
    webhookSecret: str("webhook-secret-env") ?? "RESEND_WEBHOOK_SECRET",
  }
  for (const [k, v] of Object.entries(env)) if (!ENV_RE.test(v)) throw new UsageError(`${k} env name "${v}" is not valid`)
  const paths = { ...defaultPaths(stack, kind), ...(str("signup-path") ? { signup: str("signup-path")! } : {}), ...(str("unsubscribe-path") ? { unsubscribe: str("unsubscribe-path")! } : {}) }
  for (const p of Object.values(paths)) if (p && !PATH_RE.test(p)) throw new UsageError(`path "${p}" has unsafe characters`)
  const supabaseRef = str("supabase-ref") ?? "zuawlcsjwneqjdeklvyh"
  if (!/^[a-z]{20}$/.test(supabaseRef)) throw new UsageError("--supabase-ref is not a project ref")
  const confirmDns = str("confirm-dns")?.toLowerCase()
  const probeUrl = str("probe-url")
  if (probeUrl && !/^https:\/\/[A-Za-z0-9.-]+(\/.*)?$/.test(probeUrl)) throw new UsageError("--probe-url must be an https URL")
  const dmarcRua = str("dmarc-rua")
  if (dmarcRua && !EMAIL_RE.test(dmarcRua)) throw new UsageError("--dmarc-rua is not an email address")
  const firewall = str("firewall") ?? "rule"
  if (firewall !== "rule" && firewall !== "deferred") throw new UsageError("--firewall must be rule or deferred")
  const version = pkgVersion()
  return {
    kind,
    domain,
    site,
    table,
    url: `https://${domain}`,
    dir,
    repo,
    vercelProject,
    scope,
    stack,
    srcPrefix: stack === "next-app" ? detected.srcPrefix : "",
    from,
    replyTo,
    signer,
    pool: str("pool") ?? `${site}-${kind}`,
    sources,
    env,
    paths,
    supabaseRef,
    release: { version, url: releaseUrl(version) },
    dryRun: flags["dry-run"] === true,
    confirmDns,
    probeUrl,
    branch: `iter/${site}-signup-${kind}`,
    firewall,
    dmarcRua,
  }
}
