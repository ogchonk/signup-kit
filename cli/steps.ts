import { randomBytes } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Ctx } from "./context"
import type { Run } from "./exec"
import { RESEND_FREE_DOMAIN_LIMIT, sendingKeyName, type ResendAdmin } from "./clients/resend"
import { supabaseKeyName, type SupabaseMgmt } from "./clients/supabase"
import { covers, type Target, type VercelOps } from "./clients/vercel"
import { mergeHosts, type DnsLookup, type Host, type Namecheap } from "./clients/dns"
import { dependencyUrl, lockIntegrity, repairPnpmIntegrity, sha512b64, versionOf, type RepoOps } from "./repo"
import { renderFiles } from "./templates"

/* The setup steps, in order. Each one checks before it acts: `check` is read-only and returns
   ok / missing (with what it would do) / owner (a person must act) / blocked / skip; `apply` runs
   only for "missing", and never in --dry-run. No step prints a secret. */

export type Deps = {
  run: Run
  resend: ResendAdmin | null
  supabase: SupabaseMgmt | null
  vercel: VercelOps
  dns: DnsLookup
  namecheap: Namecheap | null
  namecheapReady: { ok: boolean; reason: string }
  repo: RepoOps
  templatesDir: string
  sqlDir: string
  backupDir: string
  fetch: typeof fetch
  ghReady: boolean
  vercelReady: boolean
}

export type Check =
  | { state: "ok"; detail: string }
  | { state: "missing"; would: string }
  | { state: "owner"; reason: string }
  | { state: "blocked"; reason: string }
  | { state: "skip"; reason: string }

export type Applied = { status: "created" | "needs owner" | "blocked"; detail: string }

export type Step = {
  id: string
  title: string
  /** What the step does, shown when it is blocked by an earlier step. */
  would: (ctx: Ctx) => string
  applies?: (ctx: Ctx) => boolean
  check: (ctx: Ctx, d: Deps) => Promise<Check>
  apply?: (ctx: Ctx, d: Deps) => Promise<Applied>
}

const TARGETS: Target[] = ["production", "preview"]
const ADMIN_MISSING = "Resend admin key missing: add a full-access key to the Keychain item signup-kit-resend-admin"

async function envHas(d: Deps, name: string): Promise<boolean> {
  for (const t of TARGETS) if (!(await d.vercel.envNames(t)).has(name)) return false
  return true
}

async function putSecret(d: Deps, name: string, value: string, sensitive = true) {
  for (const t of TARGETS) await d.vercel.envAdd(name, t, value, sensitive)
}

/** The records Resend gives for the domain, in Namecheap host form (names relative to the domain). */
function toHosts(domain: string, records: { type: string; name: string; value: string; priority?: number }[]): Host[] {
  return records.map((r) => {
    let name = r.name.toLowerCase().replace(/\.$/, "")
    if (name === domain) name = "@"
    else if (name.endsWith("." + domain)) name = name.slice(0, -domain.length - 1)
    return { name, type: r.type.toUpperCase(), address: r.value, mxPref: r.priority !== undefined ? String(r.priority) : undefined, ttl: "1800" }
  })
}

/** The owner-confirmed Namecheap write: read, merge, back up, diff, and write only with --confirm-dns <domain>. */
async function writeDns(ctx: Ctx, d: Deps, wanted: Host[], why: string): Promise<Applied> {
  if (!d.namecheap || !d.namecheapReady.ok) return { status: "needs owner", detail: `DNS for ${why}: ${d.namecheapReady.reason}. Records to add: ${fmt(wanted)}` }
  const { hosts, emailType } = await d.namecheap.getHosts(ctx.domain)
  const { merged, added } = mergeHosts(hosts, wanted)
  if (added.length === 0) return { status: "created", detail: `DNS for ${why} already present at Namecheap` }
  await mkdir(d.backupDir, { recursive: true })
  const backup = join(d.backupDir, `${ctx.domain}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  await writeFile(backup, JSON.stringify({ domain: ctx.domain, emailType, hosts }, null, 2))
  if (ctx.confirmDns !== ctx.domain) {
    return { status: "needs owner", detail: `DNS for ${why}: Namecheap replaces the whole record set, so confirm first. Would add ${fmt(added)} and keep all ${hosts.length} existing records (backup: ${backup}). Re-run with --confirm-dns ${ctx.domain}` }
  }
  const mxPresent = merged.some((h) => h.type === "MX")
  await d.namecheap.setHosts(ctx.domain, merged, mxPresent ? "MX" : emailType)
  return { status: "created", detail: `added ${fmt(added)} at Namecheap (kept ${hosts.length} records; backup ${backup})` }
}

const fmt = (hs: Host[]) => hs.map((h) => `${h.type} ${h.name}${h.mxPref ? ` ${h.mxPref}` : ""} ${h.address.length > 40 ? h.address.slice(0, 37) + "…" : h.address}`).join("; ")

const sqlFile = async (d: Deps, name: string, table?: string) => {
  const text = await readFile(join(d.sqlDir, name), "utf8")
  return table ? text.replaceAll("{{table}}", table) : text
}

export const steps: Step[] = [
  {
    id: "preflight",
    title: "Preflight",
    would: () => "check the Vercel, Supabase, GitHub, Resend and Namecheap logins",
    async check(_ctx, d) {
      if (!d.vercelReady) return { state: "blocked", reason: "Vercel CLI not logged in or the project folder isn't linked (run `vercel link` in --dir)" }
      if (!d.supabase) return { state: "blocked", reason: "SUPABASE_ACCESS_TOKEN is not set" }
      if (!(await d.supabase.ping())) return { state: "blocked", reason: "SUPABASE_ACCESS_TOKEN can't reach the project" }
      const gaps: string[] = []
      if (!d.ghReady) gaps.push("GitHub CLI not logged in (`gh auth login`)")
      if (!d.resend) gaps.push(ADMIN_MISSING)
      if (!d.namecheapReady.ok) gaps.push(`Namecheap: ${d.namecheapReady.reason}`)
      return gaps.length ? { state: "owner", reason: gaps.join("; ") } : { state: "ok", detail: "Vercel, Supabase, GitHub, Resend admin and Namecheap all ready" }
    },
  },
  {
    id: "resend-domain",
    title: "Resend sending domain",
    would: (ctx) => `add ${ctx.domain} to Resend, write its DKIM/SPF records at Namecheap, verify`,
    async check(ctx, d) {
      if (!d.resend) {
        const dkim = (await d.dns.txt(`resend._domainkey.${ctx.domain}`)).some((t) => t.includes("p="))
        return dkim
          ? { state: "owner", reason: `${ADMIN_MISSING} (DNS shows Resend's DKIM record for ${ctx.domain}, so it is likely set up; the API check can't run)` }
          : { state: "blocked", reason: `${ADMIN_MISSING}; ${ctx.domain} has no Resend DKIM record, so it can't be added or the 3-domain limit checked` }
      }
      const domains = await d.resend.listDomains()
      const found = domains.find((x) => x.name === ctx.domain)
      if (found?.status === "verified") return { state: "ok", detail: `${ctx.domain} verified in Resend` }
      if (found) return { state: "missing", would: `finish verifying ${ctx.domain} (status ${found.status})` }
      if (domains.length >= RESEND_FREE_DOMAIN_LIMIT) {
        return { state: "blocked", reason: `Resend free plan is at its ${RESEND_FREE_DOMAIN_LIMIT}-domain limit (${domains.map((x) => x.name).join(", ")}); a paid plan or removing a domain is the owner's call` }
      }
      return { state: "missing", would: `add ${ctx.domain} to Resend and write its DNS records` }
    },
    async apply(ctx, d) {
      const r = d.resend!
      let id = (await r.listDomains()).find((x) => x.name === ctx.domain)?.id
      let records: Host[] = []
      if (!id) {
        const created = await r.createDomain(ctx.domain)
        id = created.id
        records = toHosts(ctx.domain, created.records)
      }
      if (records.length) {
        const dns = await writeDns(ctx, d, records, "Resend sending")
        if (dns.status !== "created") return dns
      }
      await r.verifyDomain(id)
      return { status: "created", detail: `${ctx.domain} added to Resend; verification started` }
    },
  },
  {
    id: "sending-key",
    title: "Resend sending key",
    would: (ctx) => `create the sending-only key ${sendingKeyName(ctx.domain)} and store it in Vercel as ${ctx.env.resendKey}`,
    async check(ctx, d) {
      const env = await envHas(d, ctx.env.resendKey)
      if (!d.resend) return env ? { state: "owner", reason: `${ADMIN_MISSING} (Vercel has ${ctx.env.resendKey}; the key's name in Resend can't be checked)` } : { state: "owner", reason: `${ADMIN_MISSING}; Vercel has no ${ctx.env.resendKey}` }
      const name = sendingKeyName(ctx.domain)
      const has = (await d.resend.listApiKeyNames()).includes(name)
      if (has && env) return { state: "ok", detail: `${name} exists and Vercel has ${ctx.env.resendKey}` }
      if (has && !env) return { state: "missing", would: `Resend can't reveal ${name}'s token: create ${name}-2, store it as ${ctx.env.resendKey}, and list ${name} for the owner to delete` }
      return { state: "missing", would: `create ${name} and store it as ${ctx.env.resendKey}` }
    },
    async apply(ctx, d) {
      const r = d.resend!
      const domain = (await r.listDomains()).find((x) => x.name === ctx.domain)
      if (!domain) return { status: "blocked", detail: `${ctx.domain} is not in Resend yet` }
      const base = sendingKeyName(ctx.domain)
      const hadOld = (await r.listApiKeyNames()).includes(base)
      const name = hadOld ? `${base}-2` : base
      const token = await r.createSendingKey(name, domain.id)
      await putSecret(d, ctx.env.resendKey, token)
      return hadOld
        ? { status: "needs owner", detail: `created ${name} and stored it as ${ctx.env.resendKey}; delete the old key ${base} in Resend` }
        : { status: "created", detail: `created ${name} and stored it as ${ctx.env.resendKey} (Secret, Production and Preview)` }
    },
  },
  {
    id: "supabase-key",
    title: "Supabase secret key",
    would: (ctx) => `create the Supabase secret key ${supabaseKeyName(ctx.domain)} and store it in Vercel as SUPABASE_SECRET_KEY (plus SUPABASE_URL)`,
    async check(ctx, d) {
      const name = supabaseKeyName(ctx.domain)
      const has = (await d.supabase!.listKeyNames()).includes(name)
      const env = (await envHas(d, "SUPABASE_SECRET_KEY")) && (await envHas(d, "SUPABASE_URL"))
      if (has && env) return { state: "ok", detail: `${name} exists and Vercel has SUPABASE_SECRET_KEY and SUPABASE_URL` }
      return { state: "missing", would: has ? `create ${name}_2 (Supabase can't reveal ${name}) and store it as SUPABASE_SECRET_KEY; set SUPABASE_URL` : `create ${name} and store it as SUPABASE_SECRET_KEY; set SUPABASE_URL` }
    },
    async apply(ctx, d) {
      const s = d.supabase!
      const base = supabaseKeyName(ctx.domain)
      if (!(await envHas(d, "SUPABASE_SECRET_KEY"))) {
        const hadOld = (await s.listKeyNames()).includes(base)
        const key = await s.createSecretKey(hadOld ? `${base}_2` : base)
        await putSecret(d, "SUPABASE_SECRET_KEY", key)
      }
      if (!(await envHas(d, "SUPABASE_URL"))) await putSecret(d, "SUPABASE_URL", s.projectUrl, false)
      return { status: "created", detail: `SUPABASE_SECRET_KEY (Secret) and SUPABASE_URL set for Production and Preview` }
    },
  },
  {
    id: "shared-infra",
    title: "Shared send pool (database)",
    would: () => "apply sql/001_shared_infra.sql (signup_send_quota and its three functions)",
    async check(_ctx, d) {
      const rows = await d.supabase!.query<{ n: number }>(
        "select count(*)::int as n from pg_proc where proname in ('signup_take_send','signup_pool_open','signup_give_back_send') and pronamespace = 'public'::regnamespace and (proname <> 'signup_take_send' or pg_get_function_result(oid) = 'date')",
        true,
      )
      return rows[0]?.n === 3 ? { state: "ok", detail: "signup_send_quota functions present (take_send returns date)" } : { state: "missing", would: "apply sql/001_shared_infra.sql" }
    },
    async apply(_ctx, d) {
      await d.supabase!.query(await sqlFile(d, "001_shared_infra.sql"), false)
      return { status: "created", detail: "applied sql/001_shared_infra.sql" }
    },
  },
  {
    id: "table",
    title: "Subscriber table",
    would: (ctx) => `create ${ctx.table} from the ${ctx.kind} template (RLS on, no public grants)`,
    async check(ctx, d) {
      const t = ctx.table
      const cols = ctx.kind === "waitlist" ? ["id", "email", "submitted_at", "source", "user_agent", "referrer", "welcome_sent_at", "unsubscribed_at"] : ["id", "email", "status", "source", "confirm_token_hash", "confirm_sent_at", "confirmed_at", "unsubscribed_at", "created_at", "updated_at", "confirm_sends", "unsubscribe_reason"]
      const cons = ctx.kind === "waitlist" ? [`${t}_email_shape`, `${t}_text_caps`] : [`${t}_email_lower`, `${t}_email_shape`, `${t}_status_check`, `${t}_unsubscribe_reason_check`]
      const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",")
      const [row] = await d.supabase!.query<{ cols: number; rls: boolean | null; uniq: number; cons: number; grants: number }>(
        `select
          (select count(*)::int from information_schema.columns where table_schema='public' and table_name='${t}' and column_name in (${list(cols)})) as cols,
          (select relrowsecurity from pg_class where oid = to_regclass('public.${t}')) as rls,
          (select count(*)::int from pg_indexes where schemaname='public' and tablename='${t}' and indexdef ~* '^create unique index [^ ]+ on public\\.${t} using btree \\((email|lower\\(email\\))\\)$') as uniq,
          (select count(*)::int from pg_constraint where conrelid = to_regclass('public.${t}') and conname in (${list(cons)})) as cons,
          (select count(*)::int from information_schema.role_table_grants where table_schema='public' and table_name='${t}' and grantee in ('anon','authenticated')) as grants`,
        true,
      )
      if (!row || row.rls === null) return { state: "missing", would: `create ${t} from the ${ctx.kind} template` }
      const gaps = [row.cols !== cols.length && `${cols.length - row.cols} column(s) missing`, !row.rls && "RLS off", row.uniq < 1 && "no unique email index", row.cons !== cons.length && "row checks missing", row.grants > 0 && "public roles have grants"].filter(Boolean)
      return gaps.length ? { state: "missing", would: `bring ${t} up to the template (${gaps.join(", ")})` } : { state: "ok", detail: `${t}: columns, unique email index, row checks, RLS on, no public grants` }
    },
    async apply(ctx, d) {
      const files = ctx.kind === "waitlist" ? ["010_waitlist_table.sql.tmpl", "011_waitlist_constraints.sql.tmpl"] : ["020_newsletter_table.sql.tmpl"]
      for (const f of files) await d.supabase!.query(await sqlFile(d, f, ctx.table), false)
      return { status: "created", detail: `applied ${files.join(" and ")} for ${ctx.table}` }
    },
  },
  {
    id: "token-secret",
    title: "Link-signing secret",
    would: (ctx) => `generate ${ctx.env.tokenSecret} and store it in Vercel (Secret)`,
    async check(ctx, d) {
      return (await envHas(d, ctx.env.tokenSecret)) ? { state: "ok", detail: `Vercel has ${ctx.env.tokenSecret}` } : { state: "missing", would: `generate ${ctx.env.tokenSecret}` }
    },
    async apply(ctx, d) {
      await putSecret(d, ctx.env.tokenSecret, randomBytes(32).toString("base64"))
      return { status: "created", detail: `generated ${ctx.env.tokenSecret} (Secret, Production and Preview)` }
    },
  },
  {
    id: "webhook",
    title: "Bounce webhook",
    applies: (ctx) => ctx.kind === "newsletter",
    would: (ctx) => `point Resend's webhook at ${ctx.url}${ctx.paths.webhook} and store its secret as ${ctx.env.webhookSecret}`,
    async check(ctx, d) {
      const env = await envHas(d, ctx.env.webhookSecret)
      if (!d.resend) return { state: "owner", reason: `${ADMIN_MISSING} (Vercel ${env ? "has" : "lacks"} ${ctx.env.webhookSecret})` }
      const endpoints = await d.resend.listWebhookEndpoints()
      const target = `${ctx.url}${ctx.paths.webhook}`
      if (endpoints.includes(target) && env) return { state: "ok", detail: `Resend webhook → ${target}; Vercel has ${ctx.env.webhookSecret}` }
      if (endpoints.length >= 1 && !endpoints.includes(target)) return { state: "owner", reason: `Resend's free plan allows one webhook and it points at ${endpoints[0]}; a second newsletter needs a paid plan or a shared receiver` }
      return { state: "owner", reason: `create the Resend webhook for ${target} in the dashboard and store its signing secret as ${ctx.env.webhookSecret}` }
    },
  },
  {
    id: "firewall",
    title: "Per-visitor limit (Vercel firewall)",
    would: (ctx) => `add rate-limit rule "signup" (5 per 10 min per IP) on ${ctx.paths.signup} and ${ctx.paths.unsubscribe}`,
    async check(ctx, d) {
      if (ctx.firewall === "deferred") return { state: "skip", reason: "deferred by owner" }
      const rules = await d.vercel.firewallRules()
      const mine = rules.find((r) => r.name === "signup" && r.rateLimit)
      const paths = [ctx.paths.signup, ctx.paths.unsubscribe]
      if (mine && paths.every((p) => covers(mine.paths, p))) return { state: "ok", detail: `rule "signup" covers ${paths.join(" and ")}` }
      if (mine) return { state: "owner", reason: `rule "signup" exists but doesn't cover ${paths.filter((p) => !covers(mine.paths, p)).join(", ")}` }
      const other = rules.find((r) => r.rateLimit)
      if (other) return { state: "owner", reason: `Hobby allows one rate-limit rule per project and "${other.name}" holds it. Options: fold the sign-up paths into it (shared counter), move that limit into app code, upgrade, or re-run with --firewall deferred` }
      return { state: "missing", would: `add rule "signup" on ${paths.join(" and ")}` }
    },
    async apply(ctx, d) {
      await d.vercel.addRateLimitRule("signup", [ctx.paths.signup, ctx.paths.unsubscribe], 5, 600, "signup-kit: 5 sign-up or unsubscribe requests per 10 min per IP")
      await d.vercel.publishFirewall()
      return { status: "created", detail: `rule "signup" published` }
    },
  },
  {
    id: "mail-dns",
    title: "Mail DNS (replies to che@)",
    would: (ctx) => `add Google MX, SPF and DMARC records for ${ctx.domain} at Namecheap`,
    async check(ctx, d) {
      const mx = await d.dns.mx(ctx.domain)
      const txt = await d.dns.txt(ctx.domain)
      const dmarc = await d.dns.txt(`_dmarc.${ctx.domain}`)
      const gaps = [!mx.some((m) => m === "smtp.google.com" || m.endsWith("google.com")) && "Google MX", !txt.some((t) => t.startsWith("v=spf1")) && "SPF", !dmarc.some((t) => t.startsWith("v=DMARC1")) && "DMARC"].filter(Boolean)
      return gaps.length ? { state: "missing", would: `add ${gaps.join(", ")} for ${ctx.domain}` } : { state: "ok", detail: "Google MX, SPF and DMARC present" }
    },
    async apply(ctx, d) {
      const mx = await d.dns.mx(ctx.domain)
      const txt = await d.dns.txt(ctx.domain)
      const dmarc = await d.dns.txt(`_dmarc.${ctx.domain}`)
      const wanted: Host[] = []
      if (!mx.some((m) => m.endsWith("google.com"))) wanted.push({ name: "@", type: "MX", address: "smtp.google.com", mxPref: "1", ttl: "1800" })
      if (!txt.some((t) => t.startsWith("v=spf1"))) wanted.push({ name: "@", type: "TXT", address: "v=spf1 include:_spf.google.com ~all", ttl: "1800" })
      if (!dmarc.some((t) => t.startsWith("v=DMARC1"))) wanted.push({ name: "_dmarc", type: "TXT", address: `v=DMARC1; p=none${ctx.dmarcRua ? `; rua=mailto:${ctx.dmarcRua}` : ""}`, ttl: "1800" })
      return writeDns(ctx, d, wanted, "mail")
    },
  },
  {
    id: "workspace",
    title: "Google Workspace alias che@",
    would: (ctx) => `add ${ctx.domain} to Google Workspace and the alias che@${ctx.domain}`,
    async check(ctx, d) {
      const verified = (await d.dns.txt(ctx.domain)).some((t) => t.startsWith("google-site-verification="))
      const mx = (await d.dns.mx(ctx.domain)).some((m) => m.endsWith("google.com"))
      if (verified && mx) return { state: "ok", detail: `${ctx.domain} is verified for Google Workspace and routes mail to Google (the che@ alias itself is visible only in Admin)` }
      return { state: "owner", reason: `attended step: in Google Admin add ${ctx.domain} as a secondary domain (its verification TXT goes through the DNS step), then add che@${ctx.domain} as an alias on the owner's account` }
    },
  },
  {
    id: "code-wiring",
    title: "Code wiring",
    would: (ctx) => `branch ${ctx.branch}: install signup-kit v${ctx.release.version}, write the ${ctx.stack} ${ctx.kind} config and route files`,
    async check(ctx, d) {
      const manager = d.repo.exists("pnpm-lock.yaml") ? "pnpm" : "npm"
      const url = dependencyUrl(await d.repo.read("package.json"))
      if (!url) return { state: "missing", would: `install signup-kit v${ctx.release.version} and write the ${ctx.stack} ${ctx.kind} files` }
      const lock = await d.repo.read(manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json")
      const integrity = lockIntegrity(lock, manager, url)
      if (!integrity) return { state: "missing", would: `restore the lockfile integrity hash for ${url} (pnpm 11 can drop it)` }
      const wired = await routesWired(ctx, d)
      if (!wired.ok) return { state: "missing", would: `write ${wired.missing.join(", ")}` }
      const v = versionOf(url)
      return { state: "ok", detail: `signup-kit v${v} installed with a pinned integrity hash; ${wired.files.length} route file(s) use the package${v !== ctx.release.version ? ` (v${ctx.release.version} available: upgrading is a separate PR)` : ""}` }
    },
    async apply(ctx, d) {
      if (!(await d.repo.isClean())) return { status: "needs owner", detail: `${d.repo.dir} has uncommitted changes; commit or stash them, then re-run` }
      const manager = d.repo.exists("pnpm-lock.yaml") ? "pnpm" : "npm"
      const url0 = dependencyUrl(await d.repo.read("package.json"))
      await d.repo.startBranch(ctx.branch)
      const conflicts: string[] = []
      for (const f of await renderFiles(ctx, d.templatesDir)) {
        const cur = await d.repo.read(f.path)
        if (cur !== null && cur !== f.content) {
          conflicts.push(f.path)
          continue
        }
        if (cur === null) await d.repo.write(f.path, f.content)
      }
      if (conflicts.length) return { status: "needs owner", detail: `branch ${ctx.branch}: these files already exist with other content, merge by hand: ${conflicts.join(", ")}` }
      const url = url0 ?? ctx.release.url
      if (!url0) await d.repo.install(url, manager)
      const tgz = Buffer.from(await (await d.fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer())
      const integrity = sha512b64(tgz)
      if (manager === "pnpm") {
        const lock = (await d.repo.read("pnpm-lock.yaml")) ?? ""
        if (!lockIntegrity(lock, "pnpm", url)) await d.repo.write("pnpm-lock.yaml", repairPnpmIntegrity(lock, url, integrity))
      }
      if (ctx.stack === "vercel-plain") {
        const form = await readFile(join(d.repo.dir, "node_modules/@ogchonk/signup-kit/dist/form.iife.js"), "utf8").catch(() => null)
        if (form !== null) await d.repo.write("form.js", form)
        const pkg = JSON.parse((await d.repo.read("package.json")) ?? "{}") as { scripts?: Record<string, string> }
        pkg.scripts = { ...pkg.scripts, test: pkg.scripts?.test ?? "node --test test/" }
        await d.repo.write("package.json", JSON.stringify(pkg, null, 2) + "\n")
      }
      await d.repo.commitAndPush(ctx.branch, `feat(signup): ${ctx.kind} on @ogchonk/signup-kit v${versionOf(url)} — config and route files\n\nWritten by signup-kit setup. Copy in the config file is a starting point; check it before merging.`)
      return { status: "created", detail: `branch ${ctx.branch} pushed (signup-kit v${versionOf(url)}, ${ctx.stack} ${ctx.kind} files)` }
    },
  },
  {
    id: "pr",
    title: "Pull request",
    would: (ctx) => `open a PR from ${ctx.branch}`,
    async check(ctx, d) {
      const open = await d.repo.openPr(ctx.branch)
      if (open) return { state: "ok", detail: `open PR ${open}` }
      const onSetupBranch = (await d.repo.currentBranch()) === ctx.branch
      if (!onSetupBranch) {
        const wired = dependencyUrl(await d.repo.read("package.json")) && (await routesWired(ctx, d)).ok
        return wired ? { state: "ok", detail: "wiring is already on the default branch" } : { state: "skip", reason: "code wiring isn't on a setup branch yet, so there's nothing to open a PR for" }
      }
      if (!d.ghReady) return { state: "owner", reason: "GitHub CLI not logged in" }
      return { state: "missing", would: `open a PR from ${ctx.branch}` }
    },
    async apply(ctx, d) {
      const url = await d.repo.createPr(
        ctx.branch,
        `feat(signup): ${ctx.domain} ${ctx.kind} on @ogchonk/signup-kit`,
        `Wires ${ctx.domain}'s ${ctx.kind} to the shared @ogchonk/signup-kit package (v${ctx.release.version}). Written by \`signup-kit setup\`.\n\nBefore merging: check the copy in the config file against the banned-copy list, run the site's gates, and run \`signup-kit probe\` against this PR's preview.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
      )
      return { status: "created", detail: `opened ${url}` }
    },
  },
]

/** True when the site's route files import the package factories. Files the site moved are accepted wherever they are. */
export async function routesWired(ctx: Ctx, d: Deps): Promise<{ ok: boolean; files: string[]; missing: string[] }> {
  const candidates =
    ctx.stack === "next-app"
      ? [ctx.paths.signup, ctx.paths.unsubscribe, ctx.paths.confirm, ctx.paths.webhook].filter((p): p is string => Boolean(p)).map((p) => `${ctx.srcPrefix}app${p}/route.ts`)
      : ["api/subscribe.js", "api/unsubscribe.js", ...(ctx.kind === "newsletter" ? ["api/confirm.js", "api/webhook.js"] : [])]
  const files: string[] = []
  const missing: string[] = []
  for (const f of candidates) {
    const text = await d.repo.read(f)
    if (text && /@ogchonk\/signup-kit\/(next|node)/.test(text)) files.push(f)
    else missing.push(f)
  }
  return { ok: missing.length === 0, files, missing }
}
