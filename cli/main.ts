import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildCtx, parseFlags, UsageError, type Ctx } from "./context"
import { run, type Run } from "./exec"
import { resendAdmin, type ResendAdmin } from "./clients/resend"
import { supabaseMgmt } from "./clients/supabase"
import { vercelCli } from "./clients/vercel"
import { loadNamecheapCreds, namecheap, publicIp, systemDns } from "./clients/dns"
import { repoOps } from "./repo"
import { format, runSetup } from "./runner"
import { formatHealth, health } from "./health"
import { probe } from "./probe"
import type { Deps } from "./steps"

const USAGE = `signup-kit — uniform waitlist and newsletter setup

  signup-kit setup --kind waitlist|newsletter --domain <d> --dir <site folder> --repo <owner/name>
                   --vercel-project <name> [--site <id>] [--table <name>] [--signer <name>]
                   [--from "Name <che@d>"] [--reply-to <email>] [--sources a,b]
                   [--resend-key-env NAME] [--token-secret-env NAME] [--webhook-secret-env NAME]
                   [--firewall rule|deferred] [--dmarc-rua <email>] [--scope <team>]
                   [--dry-run] [--confirm-dns <domain>] [--probe-url <url>]
  signup-kit probe --url <https://deployment> --path <signup path> [--tag <t>] [--firewall]
  signup-kit health [--days 7]

Secrets come from the environment (SUPABASE_ACCESS_TOKEN), the Keychain item
signup-kit-resend-admin, and ~/.namecheap-api.env. None is ever printed.`

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = existsSync(join(here, "..", "templates")) ? join(here, "..") : join(here, "..", "..")

async function resendFromKeychain(r: Run): Promise<ResendAdmin | null> {
  const env = process.env.RESEND_ADMIN_KEY
  if (env) return resendAdmin(env)
  if (process.platform !== "darwin") return null
  const res = await r("security", ["find-generic-password", "-s", "signup-kit-resend-admin", "-w"])
  const key = res.code === 0 ? res.stdout.trim() : ""
  return key.startsWith("re_") ? resendAdmin(key) : null
}

export async function realDeps(ctx: Ctx, r: Run = run): Promise<Deps> {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const creds = await loadNamecheapCreds()
  let namecheapReady = { ok: false, reason: "~/.namecheap-api.env missing or incomplete" }
  if (creds) {
    const ip = await publicIp()
    namecheapReady = ip === creds.clientIp ? { ok: true, reason: "" } : { ok: false, reason: "this machine's public IP isn't the one whitelisted at Namecheap" }
  }
  const linked = (() => {
    try {
      return (JSON.parse(readFileSync(join(ctx.dir, ".vercel", "project.json"), "utf8")) as { projectName?: string }).projectName === ctx.vercelProject
    } catch {
      return false
    }
  })()
  const vercel = vercelCli(r, ctx.dir, ctx.scope)
  return {
    run: r,
    resend: await resendFromKeychain(r),
    supabase: token ? supabaseMgmt(token, ctx.supabaseRef) : null,
    vercel,
    dns: systemDns,
    namecheap: creds ? namecheap(creds) : null,
    namecheapReady,
    repo: repoOps(r, ctx.dir),
    templatesDir: join(pkgRoot, "templates"),
    sqlDir: join(pkgRoot, "sql"),
    backupDir: join(homedir(), ".signup-kit", "dns-backups"),
    fetch,
    ghReady: (await r("gh", ["auth", "status"])).code === 0,
    vercelReady: linked && (await vercel.whoami()),
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE)
    return 0
  }
  const flags = parseFlags(rest)
  if (cmd === "setup") {
    const ctx = buildCtx(flags)
    console.log(`signup-kit v${ctx.release.version} setup: ${ctx.domain} (${ctx.kind}, ${ctx.stack})${ctx.dryRun ? " — dry run" : ""}`)
    const lines = await runSetup(ctx, await realDeps(ctx), (l) => console.log(format(l)))
    const owner = lines.filter((l) => l.status === "needs owner").length
    const blocked = lines.filter((l) => l.status === "blocked").length
    console.log(`\n${lines.filter((l) => l.status === "exists").length} exist, ${lines.filter((l) => l.status === "created").length} created, ${owner} need the owner, ${blocked} blocked`)
    return blocked ? 2 : owner ? 1 : 0
  }
  if (cmd === "probe") {
    const url = flags.url
    const path = flags.path
    if (typeof url !== "string" || !/^https:\/\//.test(url) || typeof path !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new UsageError("probe needs --url https://… and --path /api/…")
    const tag = typeof flags.tag === "string" && /^[a-z0-9-]{1,30}$/.test(flags.tag) ? flags.tag : `probe-${Date.now().toString(36)}`
    const results = await probe(url, path, { tag, firewall: flags.firewall === true })
    for (const r of results) console.log(`${r.pass ? "pass" : "FAIL"}  ${r.name}${r.pass ? "" : `  (got ${r.got})`}`)
    console.log(`probe address: delivered+${tag}@resend.dev (delete its row afterwards)`)
    return results.every((r) => r.pass) ? 0 : 1
  }
  if (cmd === "health") {
    const days = typeof flags.days === "string" ? Math.max(1, Math.min(30, Number(flags.days) || 7)) : 7
    const r = await resendFromKeychain(run)
    if (!r) {
      console.log("health needs the Resend admin key: add a full-access key to the Keychain item signup-kit-resend-admin")
      return 1
    }
    console.log(formatHealth(await health(r, days), days))
    return 0
  }
  throw new UsageError(`unknown command "${cmd}"`)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof UsageError ? `${err.message}\n\n${USAGE}` : `signup-kit: ${(err as Error).message}`)
    process.exit(err instanceof UsageError ? 64 : 1)
  },
)
