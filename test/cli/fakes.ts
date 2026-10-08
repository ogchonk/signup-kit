import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Ctx } from "../../cli/context"
import { buildCtx } from "../../cli/context"
import type { ResendAdmin } from "../../cli/clients/resend"
import type { SupabaseMgmt } from "../../cli/clients/supabase"
import type { FirewallRule, Target, VercelOps } from "../../cli/clients/vercel"
import type { DnsLookup, Host, Namecheap } from "../../cli/clients/dns"
import type { RepoOps } from "../../cli/repo"
import type { Deps } from "../../cli/steps"

export const SECRET_RESEND = "re_FAKE_SECRET_TOKEN_123"
export const SECRET_SUPABASE = "sb_secret_FAKE_SECRET_456"

export function fakeResend(domains: { id: string; name: string; status: string }[], keys: string[] = [], webhooks: string[] = []) {
  const calls: string[] = []
  const r: ResendAdmin & { calls: string[]; domains: typeof domains; keys: string[] } = {
    calls,
    domains,
    keys,
    async listDomains() {
      return domains
    },
    async createDomain(name) {
      calls.push(`createDomain ${name}`)
      domains.push({ id: "d-new", name, status: "pending" })
      return { id: "d-new", records: [{ type: "TXT", name: `resend._domainkey.${name}`, value: "p=KEY" }, { type: "MX", name: `send.${name}`, value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }] }
    },
    async verifyDomain(id) {
      calls.push(`verifyDomain ${id}`)
    },
    async listApiKeyNames() {
      return keys
    },
    async createSendingKey(name, domainId) {
      calls.push(`createSendingKey ${name} ${domainId}`)
      keys.push(name)
      return SECRET_RESEND
    },
    async listWebhookEndpoints() {
      return webhooks
    },
    async listEmailsSince() {
      return []
    },
  }
  return r
}

export function fakeSupabase(opts: { keys?: string[]; infra?: boolean; table?: Partial<{ cols: number; rls: boolean | null; uniq: number; cons: number; grants: number }> } = {}) {
  const calls: string[] = []
  const keys = opts.keys ?? []
  let infra = opts.infra ?? true
  let table = { cols: 8, rls: true as boolean | null, uniq: 1, cons: 2, grants: 0, ...opts.table }
  const s: SupabaseMgmt & { calls: string[] } = {
    calls,
    ref: "abcdefghijklmnopqrst",
    projectUrl: "https://abcdefghijklmnopqrst.supabase.co",
    async ping() {
      return true
    },
    async listKeyNames() {
      return keys
    },
    async createSecretKey(name) {
      calls.push(`createSecretKey ${name}`)
      keys.push(name)
      return SECRET_SUPABASE
    },
    async query(sql: string, readOnly: boolean): Promise<any[]> {
      calls.push(readOnly ? "read" : `write ${sql.slice(0, 40).replace(/\s+/g, " ")}`)
      if (!readOnly) {
        if (sql.includes("signup_send_quota")) infra = true
        if (sql.includes("create table if not exists")) table = { cols: 8, rls: true, uniq: 1, cons: table.cons, grants: 0 }
        if (sql.includes("_text_caps")) table.cons = 2
        return []
      }
      if (sql.includes("from pg_proc")) return [{ n: infra ? 3 : 0 }]
      return [table]
    },
  }
  return s
}

export function fakeVercel(env: Record<Target, string[]>, rules: FirewallRule[] = []) {
  const calls: string[] = []
  const values: string[] = []
  const v: VercelOps & { calls: string[]; values: string[]; env: Record<Target, string[]>; rules: FirewallRule[] } = {
    calls,
    values,
    env,
    rules,
    async whoami() {
      return true
    },
    async envNames(t) {
      return new Set(env[t])
    },
    async envAdd(name, t, value, sensitive) {
      calls.push(`envAdd ${name} ${t} ${sensitive ? "secret" : "config"}`)
      values.push(value)
      env[t].push(name)
    },
    async firewallRules() {
      return rules
    },
    async addRateLimitRule(name, paths, limit, windowS) {
      calls.push(`addRule ${name} ${paths.join(",")} ${limit}/${windowS}`)
      rules.push({ name, rateLimit: true, paths: paths.map((p) => ({ op: "eq", value: p })) })
    },
    async publishFirewall() {
      calls.push("publish")
    },
  }
  return v
}

export function fakeDns(records: Record<string, { txt?: string[]; mx?: string[] }>): DnsLookup {
  return {
    async txt(n) {
      return records[n]?.txt ?? []
    },
    async mx(n) {
      return records[n]?.mx ?? []
    },
  }
}

export const healthyDns = (domain: string) =>
  fakeDns({
    [domain]: { txt: ["v=spf1 include:_spf.google.com ~all", "google-site-verification=abc"], mx: ["smtp.google.com"] },
    [`_dmarc.${domain}`]: { txt: ["v=DMARC1; p=none"] },
    [`resend._domainkey.${domain}`]: { txt: ["p=KEY"] },
  })

export function fakeNamecheap(hosts: Host[]) {
  const calls: { domain: string; hosts: Host[]; emailType: string }[] = []
  const n: Namecheap & { calls: typeof calls } = {
    calls,
    async getHosts() {
      return { hosts: [...hosts], emailType: "MX" }
    },
    async setHosts(domain, hs, emailType) {
      calls.push({ domain, hosts: hs, emailType })
    },
  }
  return n
}

export function fakeRepo(files: Record<string, string>, opts: { clean?: boolean; pr?: string | null } = {}) {
  const calls: string[] = []
  let branch = "main"
  const r: RepoOps & { calls: string[]; files: Record<string, string> } = {
    calls,
    files,
    dir: "/fake/site",
    exists: (rel) => rel in files,
    async read(rel) {
      return files[rel] ?? null
    },
    async write(rel, content) {
      calls.push(`write ${rel}`)
      files[rel] = content
    },
    async isClean() {
      return opts.clean ?? true
    },
    async currentBranch() {
      return branch
    },
    async startBranch(b) {
      calls.push(`branch ${b}`)
      branch = b
    },
    async install(url) {
      calls.push(`install ${url}`)
      const pkg = JSON.parse(files["package.json"] ?? "{}")
      pkg.dependencies = { ...pkg.dependencies, "@ogchonk/signup-kit": url }
      files["package.json"] = JSON.stringify(pkg)
    },
    async commitAndPush(b) {
      calls.push(`push ${b}`)
    },
    async openPr() {
      return opts.pr ?? null
    },
    async createPr(b) {
      calls.push(`pr ${b}`)
      return "https://github.com/o/r/pull/9"
    },
  }
  return r
}

/** A site folder on disk for buildCtx (it checks --dir exists and reads package.json for the stack). */
export function siteDir(pkg: object, withSrcApp = false): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-site-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg))
  if (withSrcApp) mkdirSync(join(dir, "src", "app"), { recursive: true })
  return dir
}

export function ctxFor(over: Record<string, string | true> = {}, pkg: object = { dependencies: {} }, withSrcApp = false): Ctx {
  return buildCtx({ kind: "waitlist", domain: "ntabc.co", dir: siteDir(pkg, withSrcApp), repo: "ogchonk/site", "vercel-project": "site", ...over })
}

export function deps(over: Partial<Deps> = {}): Deps {
  return {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    resend: fakeResend([{ id: "d1", name: "ntabc.co", status: "verified" }], ["ntabc-co-send"]),
    supabase: fakeSupabase({ keys: ["ntabc_signup"] }),
    vercel: fakeVercel({ production: ["RESEND_API_KEY", "SIGNUP_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_URL"], preview: ["RESEND_API_KEY", "SIGNUP_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_URL"] }, [
      { name: "signup", rateLimit: true, paths: [{ op: "eq", value: "/api/subscribe" }, { op: "eq", value: "/api/unsubscribe" }] },
    ]),
    dns: healthyDns("ntabc.co"),
    namecheap: fakeNamecheap([]),
    namecheapReady: { ok: true, reason: "" },
    repo: fakeRepo(wiredPlain()),
    templatesDir: join(__dirname, "..", "..", "templates"),
    sqlDir: join(__dirname, "..", "..", "sql"),
    backupDir: mkdtempSync(join(tmpdir(), "sk-backup-")),
    fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
    ghReady: true,
    vercelReady: true,
    ...over,
  }
}

export const RELEASE = "https://github.com/ogchonk/signup-kit/releases/download/v0.1.3/ogchonk-signup-kit-0.1.3.tgz"

export function wiredPlain(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ dependencies: { "@ogchonk/signup-kit": RELEASE } }),
    "package-lock.json": JSON.stringify({ packages: { "node_modules/@ogchonk/signup-kit": { resolved: RELEASE, integrity: "sha512-AAAA" } } }),
    "api/subscribe.js": "module.exports = require('@ogchonk/signup-kit/node').createWaitlistHandler(require('../signup-config'))",
    "api/unsubscribe.js": "module.exports = require('@ogchonk/signup-kit/node').createWaitlistUnsubscribeHandler(require('../signup-config'))",
  }
}
