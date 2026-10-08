import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { mustRun, type Run } from "./exec"

/* The site's git checkout: read files, check the lockfile, and (code-wiring step only) branch,
   write the template files, install the release, commit, push and open the PR. */

export interface RepoOps {
  readonly dir: string
  exists(rel: string): boolean
  read(rel: string): Promise<string | null>
  write(rel: string, content: string): Promise<void>
  isClean(): Promise<boolean>
  currentBranch(): Promise<string>
  startBranch(branch: string): Promise<void>
  install(url: string, manager: "pnpm" | "npm"): Promise<void>
  commitAndPush(branch: string, message: string): Promise<void>
  openPr(branch: string): Promise<string | null>
  createPr(branch: string, title: string, body: string): Promise<string>
}

export function repoOps(r: Run, dir: string): RepoOps {
  const git = (...args: string[]) => mustRun(r, "git", args, { cwd: dir })
  return {
    dir,
    exists: (rel) => existsSync(join(dir, rel)),
    async read(rel) {
      try {
        return await readFile(join(dir, rel), "utf8")
      } catch {
        return null
      }
    },
    async write(rel, content) {
      await mkdir(dirname(join(dir, rel)), { recursive: true })
      await writeFile(join(dir, rel), content)
    },
    async isClean() {
      return (await git("status", "--porcelain")).trim() === ""
    },
    async currentBranch() {
      return (await git("rev-parse", "--abbrev-ref", "HEAD")).trim()
    },
    async startBranch(branch) {
      await git("fetch", "origin", "--quiet")
      await git("switch", "-c", branch, "origin/main")
    },
    async install(url, manager) {
      if (manager === "pnpm") await mustRun(r, "pnpm", ["add", url], { cwd: dir, timeoutMs: 600_000 })
      else await mustRun(r, "npm", ["install", "--save", url], { cwd: dir, timeoutMs: 600_000 })
    },
    async commitAndPush(branch, message) {
      await git("add", "-A")
      await git("commit", "-q", "-m", message)
      await git("push", "-q", "-u", "origin", branch)
    },
    async openPr(branch) {
      const res = await r("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "-q", ".[0].url"], { cwd: dir })
      const url = res.stdout.trim()
      return res.code === 0 && url ? url : null
    },
    async createPr(branch, title, body) {
      return (await mustRun(r, "gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body], { cwd: dir })).trim()
    },
  }
}

export const sha512b64 = (buf: Buffer) => "sha512-" + createHash("sha512").update(buf).digest("base64")

/** The signup-kit release URL the site depends on, or null. */
export function dependencyUrl(pkgJson: string | null): string | null {
  if (!pkgJson) return null
  try {
    const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string> }
    const v = pkg.dependencies?.["@ogchonk/signup-kit"]
    return v && /^https:\/\/github\.com\/ogchonk\/signup-kit\/releases\/download\/v[0-9.]+\/ogchonk-signup-kit-[0-9.]+\.tgz$/.test(v) ? v : null
  } catch {
    return null
  }
}

export const versionOf = (url: string) => /\/v([0-9.]+)\//.exec(url)?.[1] ?? "?"

/** The integrity the lockfile records for the release tarball, or null when the entry or its hash is missing. pnpm 11 can drop it. */
export function lockIntegrity(lock: string | null, manager: "pnpm" | "npm", url: string): string | null {
  if (!lock) return null
  if (manager === "npm") {
    try {
      const j = JSON.parse(lock) as { packages?: Record<string, { resolved?: string; integrity?: string }> }
      const e = j.packages?.["node_modules/@ogchonk/signup-kit"]
      return e?.resolved === url && e.integrity ? e.integrity : null
    } catch {
      return null
    }
  }
  const at = lock.indexOf(`'@ogchonk/signup-kit@${url}'`)
  if (at < 0) return null
  const block = lock.slice(at, at + 600)
  return /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(block.split(/\n\n/)[0] ?? "")?.[1] ?? null
}

/** Puts the integrity back into a pnpm lockfile's package entry for the tarball (pnpm 11 sometimes writes `resolution: {tarball: …}` only). */
export function repairPnpmIntegrity(lock: string, url: string, integrity: string): string {
  const key = `'@ogchonk/signup-kit@${url}':\n    resolution: {tarball: ${url}}`
  if (!lock.includes(key)) return lock
  return lock.replace(key, `'@ogchonk/signup-kit@${url}':\n    resolution: {integrity: ${integrity}, tarball: ${url}}`)
}
