import { mustRun, type Run } from "../exec"

/* Vercel through its CLI, run in the site's linked project folder. Env listings are parsed for
   names only; values (readable for Config variables) are dropped on the spot. Secrets are written
   with `vercel env add … --sensitive --force` and passed on stdin. Firewall rules use the CLI
   (`rules add` + `publish`) because the full-replace API answers 404 on a project with no config. */

export type Target = "production" | "preview"
export type FirewallRule = { name: string; rateLimit: boolean; paths: { op: string; value: string }[] }

export interface VercelOps {
  whoami(): Promise<boolean>
  envNames(target: Target): Promise<Set<string>>
  envAdd(name: string, target: Target, value: string, sensitive: boolean): Promise<void>
  firewallRules(): Promise<FirewallRule[]>
  addRateLimitRule(name: string, paths: string[], limit: number, windowS: number, description: string): Promise<void>
  publishFirewall(): Promise<void>
}

export function vercelCli(r: Run, dir: string, scope: string): VercelOps {
  const base = ["--scope", scope, "--non-interactive"]
  return {
    async whoami() {
      return (await r("vercel", ["whoami", ...base], { cwd: dir })).code === 0
    },
    async envNames(target) {
      const out = await mustRun(r, "vercel", ["env", "ls", target, "--format", "json", ...base], { cwd: dir })
      const json = JSON.parse(out.slice(out.indexOf("{"))) as { envs?: { key: string; target?: string[] }[] }
      return new Set((json.envs ?? []).filter((e) => !e.target || e.target.includes(target)).map((e) => e.key))
    },
    async envAdd(name, target, value, sensitive) {
      const args = ["env", "add", name, target, sensitive ? "--sensitive" : "--no-sensitive", "--force", "--yes", ...base]
      await mustRun(r, "vercel", args, { cwd: dir, input: value })
    },
    async firewallRules() {
      const out = await mustRun(r, "vercel", ["firewall", "rules", "list", "--json", ...base], { cwd: dir })
      const json = JSON.parse(out.slice(out.indexOf("{"))) as { rules?: any[] }
      return (json.rules ?? []).map((rule) => ({
        name: String(rule.name),
        rateLimit: rule.action?.mitigate?.action === "rate_limit",
        paths: (rule.conditionGroup ?? []).flatMap((g: any) =>
          (g.conditions ?? []).filter((c: any) => c.type === "path").map((c: any) => ({ op: String(c.op), value: String(c.value) })),
        ),
      }))
    },
    async addRateLimitRule(name, paths, limit, windowS, description) {
      const args = ["firewall", "rules", "add", name, "--action", "rate_limit", "--rate-limit-requests", String(limit), "--rate-limit-window", String(windowS), "--rate-limit-keys", "ip", "--description", description]
      paths.forEach((p, i) => {
        if (i > 0) args.push("--or")
        args.push("--condition", JSON.stringify({ type: "path", op: "eq", value: p }))
      })
      await mustRun(r, "vercel", [...args, "--yes", ...base], { cwd: dir })
    },
    async publishFirewall() {
      await mustRun(r, "vercel", ["firewall", "publish", "--yes", ...base], { cwd: dir })
    },
  }
}

/** True when a path condition set covers the path: an exact match, or a prefix match. */
export const covers = (conds: { op: string; value: string }[], path: string) =>
  conds.some((c) => (c.op === "eq" && c.value === path) || (c.op === "pre" && path.startsWith(c.value)))
