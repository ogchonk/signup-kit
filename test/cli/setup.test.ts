import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { buildCtx, UsageError } from "../../cli/context"
import { runSetup, type Line } from "../../cli/runner"
import { sendingKeyName } from "../../cli/clients/resend"
import { supabaseKeyName } from "../../cli/clients/supabase"
import { mergeHosts } from "../../cli/clients/dns"
import { covers } from "../../cli/clients/vercel"
import { lockIntegrity, repairPnpmIntegrity } from "../../cli/repo"
import { RELEASE, SECRET_RESEND, SECRET_SUPABASE, ctxFor, deps, fakeDns, fakeNamecheap, fakeRepo, fakeResend, fakeSupabase, fakeVercel, siteDir, wiredPlain } from "./fakes"

const byId = (lines: Line[]) => Object.fromEntries(lines.map((l) => [l.id, l]))

describe("input validation", () => {
  const base = () => ({ kind: "waitlist", domain: "ntabc.co", dir: siteDir({}), repo: "o/r", "vercel-project": "p" }) as Record<string, string | true>
  it.each([
    ["domain", "not a domain"],
    ["domain", "evil.com;rm -rf /"],
    ["table", "Robert'); drop table x;--"],
    ["table", "UPPER"],
    ["site", "-bad"],
    ["repo", "no-slash"],
    ["vercel-project", "Has Space"],
    ["resend-key-env", "lower"],
    ["from", "Name <someone@other.com>"],
    ["from", 'Evil" <che@ntabc.co>'],
    ["reply-to", "nope"],
    ["signup-path", "/api/../x;"],
    ["firewall", "maybe"],
    ["kind", "forum"],
    ["probe-url", "http://plain.example"],
    ["supabase-ref", "short"],
  ])("rejects --%s %s", (k, v) => {
    expect(() => buildCtx({ ...base(), [k]: v })).toThrow(UsageError)
  })
  it("rejects a missing required flag", () => {
    const f = base()
    delete f.repo
    expect(() => buildCtx(f)).toThrow(/--repo is required/)
  })
  it("derives names from the domain", () => {
    const c = ctxFor()
    expect(c).toMatchObject({ site: "ntabc", table: "ntabc_waitlist_signups", url: "https://ntabc.co", stack: "vercel-plain", pool: "ntabc-waitlist", branch: "iter/ntabc-signup-waitlist", firewall: "rule" })
    expect(c.paths).toEqual({ signup: "/api/subscribe", unsubscribe: "/api/unsubscribe" })
  })
  it("detects a Next app with src/", () => {
    const c = ctxFor({ site: "pf" }, { dependencies: { next: "16" } }, true)
    expect(c).toMatchObject({ stack: "next-app", srcPrefix: "src/", table: "pf_waitlist_signups" })
    expect(c.paths.signup).toBe("/api/waitlist")
  })
})

describe("names", () => {
  it("sending key and Supabase key names match the live ones", () => {
    expect(sendingKeyName("ntabc.co")).toBe("ntabc-co-send")
    expect(sendingKeyName("robbychoate.com")).toBe("robbychoate-com-send")
    expect(supabaseKeyName("passwordfreedom.co")).toBe("passwordfreedom_signup")
    expect(supabaseKeyName("robbychoate.com")).toBe("robbychoate_signup")
  })
})

describe("runner", () => {
  it("everything already set up: every step exists and the probe is skipped", async () => {
    const lines = await runSetup(ctxFor(), deps())
    expect(lines.filter((l) => l.id !== "probe").every((l) => l.status === "exists")).toBe(true)
    expect(byId(lines).probe).toMatchObject({ status: "skipped", detail: "nothing changed" })
  })

  it("makes no write when everything exists", async () => {
    const d = deps()
    await runSetup(ctxFor(), d)
    expect((d.vercel as any).calls).toEqual([])
    expect((d.supabase as any).calls.every((c: string) => c === "read")).toBe(true)
    expect((d.resend as any).calls).toEqual([])
    expect((d.repo as any).calls).toEqual([])
  })

  it("a fourth domain is blocked at the 3-domain limit and every later step is blocked", async () => {
    const resend = fakeResend([
      { id: "1", name: "a.com", status: "verified" },
      { id: "2", name: "b.com", status: "verified" },
      { id: "3", name: "c.com", status: "verified" },
    ])
    const lines = await runSetup(ctxFor({ domain: "newsite.com", "dry-run": true }), deps({ resend, dns: fakeDns({}) }))
    const i = lines.findIndex((l) => l.id === "resend-domain")
    expect(lines[i]).toMatchObject({ status: "blocked" })
    expect(lines[i]!.detail).toMatch(/3-domain limit/)
    for (const l of lines.slice(i + 1)) {
      expect(l.status).toBe("blocked")
      expect(l.id === "probe" || /would /.test(l.detail)).toBe(true)
    }
    expect(resend.calls).toEqual([])
  })

  it("without the admin key: Resend steps need the owner; a new domain with no DKIM blocks", async () => {
    const lines = byId(await runSetup(ctxFor(), deps({ resend: null })))
    expect(lines.preflight!.status).toBe("needs owner")
    expect(lines["resend-domain"]!.status).toBe("needs owner")
    expect(lines["sending-key"]!.status).toBe("needs owner")
    const fresh = await runSetup(ctxFor({ domain: "newsite.com", "dry-run": true }), deps({ resend: null, dns: fakeDns({}) }))
    expect(byId(fresh)["resend-domain"]!.status).toBe("blocked")
  })

  it("dry run prints what it would do and writes nothing", async () => {
    const d = deps({ supabase: fakeSupabase({ keys: [], infra: false, table: { rls: null } }), vercel: fakeVercel({ production: [], preview: [] }), repo: fakeRepo({ "package.json": "{}" }) })
    const lines = byId(await runSetup(ctxFor({ "dry-run": true }), d))
    for (const id of ["supabase-key", "shared-infra", "table", "token-secret", "firewall", "code-wiring"]) {
      expect(lines[id]!.status, id).toBe("skipped")
      expect(lines[id]!.detail, id).toMatch(/^dry run: would /)
    }
    expect((d.vercel as any).calls).toEqual([])
    expect((d.supabase as any).calls.every((c: string) => c === "read")).toBe(true)
  })

  it("a step that throws during its check blocks the rest", async () => {
    const supabase = fakeSupabase()
    supabase.listKeyNames = async () => {
      throw new Error("Supabase GET /api-keys → 500")
    }
    const lines = await runSetup(ctxFor(), deps({ supabase }))
    const i = lines.findIndex((l) => l.id === "supabase-key")
    expect(lines[i]).toMatchObject({ status: "blocked", detail: "check failed: Supabase GET /api-keys → 500" })
    expect(lines.slice(i + 1).every((l) => l.status === "blocked")).toBe(true)
  })
})

describe("secrets", () => {
  it("creates keys and secrets without ever printing them", async () => {
    const resend = fakeResend([{ id: "d1", name: "ntabc.co", status: "verified" }], [])
    const supabase = fakeSupabase({ keys: [] })
    const vercel = fakeVercel({ production: [], preview: [] }, [])
    const out: string[] = []
    const lines = await runSetup(ctxFor(), deps({ resend, supabase, vercel }), (l) => out.push(JSON.stringify(l)))
    expect(byId(lines)["sending-key"], JSON.stringify(byId(lines)["sending-key"])).toMatchObject({ status: "created" })
    expect(byId(lines)["supabase-key"]!.status).toBe("created")
    expect(byId(lines)["token-secret"]!.status).toBe("created")
    const all = out.join("\n")
    expect(all).not.toContain(SECRET_RESEND)
    expect(all).not.toContain(SECRET_SUPABASE)
    for (const v of vercel.values.filter((v) => v !== supabase.projectUrl)) expect(all).not.toContain(v)
    expect(vercel.calls).toContain("envAdd RESEND_API_KEY production secret")
    expect(vercel.calls).toContain("envAdd SUPABASE_SECRET_KEY preview secret")
    expect(vercel.calls).toContain("envAdd SUPABASE_URL production config")
    expect(resend.calls).toContain("createSendingKey ntabc-co-send d1")
    expect(supabase.calls).toContain("createSecretKey ntabc_signup")
  })

  it("sending key exists but Vercel lacks it: creates <name>-2 and asks the owner to delete the old one", async () => {
    const resend = fakeResend([{ id: "d1", name: "ntabc.co", status: "verified" }], ["ntabc-co-send"])
    const vercel = fakeVercel({ production: ["SIGNUP_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_URL"], preview: ["SIGNUP_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_URL"] }, [{ name: "signup", rateLimit: true, paths: [{ op: "pre", value: "/api" }] }])
    const l = byId(await runSetup(ctxFor(), deps({ resend, vercel })))["sending-key"]!
    expect(l.status).toBe("needs owner")
    expect(l.detail).toMatch(/created ntabc-co-send-2 .*delete the old key ntabc-co-send/)
  })

  it("uses the site's own env names (robbychoate.com)", async () => {
    const vercel = fakeVercel({ production: [], preview: [] }, [])
    await runSetup(ctxFor({ "resend-key-env": "NEWSLETTER_RESEND_API_KEY", "token-secret-env": "NEWSLETTER_SECRET" }), deps({ vercel, resend: fakeResend([{ id: "d1", name: "ntabc.co", status: "verified" }], []) }))
    expect(vercel.calls).toContain("envAdd NEWSLETTER_RESEND_API_KEY production secret")
    expect(vercel.calls).toContain("envAdd NEWSLETTER_SECRET preview secret")
  })
})

describe("firewall", () => {
  const rateRule = (name: string, paths: { op: string; value: string }[]) => ({ name, rateLimit: true, paths })
  it("deferred by the owner: skipped, never touched", async () => {
    const vercel = fakeVercel((deps().vercel as any).env, [rateRule("Rate limit /api/chat per IP", [{ op: "eq", value: "/api/chat" }])])
    const l = byId(await runSetup(ctxFor({ firewall: "deferred" }), deps({ vercel }))).firewall!
    expect(l).toMatchObject({ status: "skipped", detail: "deferred by owner" })
    expect(vercel.calls).toEqual([])
  })
  it("another rule holds the one Hobby slot: needs the owner, nothing overwritten", async () => {
    const vercel = fakeVercel((deps().vercel as any).env, [rateRule("Rate limit /api/chat per IP", [{ op: "eq", value: "/api/chat" }])])
    const l = byId(await runSetup(ctxFor(), deps({ vercel }))).firewall!
    expect(l.status).toBe("needs owner")
    expect(l.detail).toMatch(/one rate-limit rule per project and "Rate limit \/api\/chat per IP" holds it/)
    expect(vercel.calls).toEqual([])
  })
  it("a prefix rule covers the site's paths (passwordfreedom.co's /api/waitlist)", () => {
    expect(covers([{ op: "pre", value: "/api/waitlist" }], "/api/waitlist/unsubscribe")).toBe(true)
    expect(covers([{ op: "eq", value: "/api/subscribe" }], "/api/unsubscribe")).toBe(false)
  })
  it("missing: adds the rule and publishes", async () => {
    const vercel = fakeVercel((deps().vercel as any).env, [])
    const l = byId(await runSetup(ctxFor(), deps({ vercel }))).firewall!
    expect(l.status).toBe("created")
    expect(vercel.calls).toEqual(["addRule signup /api/subscribe,/api/unsubscribe 5/600", "publish"])
  })
})

describe("DNS", () => {
  const existing = [
    { name: "@", type: "A", address: "1.2.3.4" },
    { name: "send", type: "MX", address: "feedback-smtp.us-east-1.amazonses.com", mxPref: "10" },
  ]
  it("without --confirm-dns: backs up, shows the diff, writes nothing", async () => {
    const nc = fakeNamecheap(existing)
    const l = byId(await runSetup(ctxFor(), deps({ namecheap: nc, dns: fakeDns({}) })))["mail-dns"]!
    expect(l.status).toBe("needs owner")
    expect(l.detail).toMatch(/keep all 2 existing records/)
    expect(l.detail).toMatch(/--confirm-dns ntabc\.co/)
    expect(nc.calls).toEqual([])
  })
  it("with --confirm-dns for this exact domain: writes every existing record plus the new ones", async () => {
    const nc = fakeNamecheap(existing)
    const l = byId(await runSetup(ctxFor({ "confirm-dns": "ntabc.co", "dmarc-rua": "owner@example.com" }), deps({ namecheap: nc, dns: fakeDns({}) })))["mail-dns"]!
    expect(l.status).toBe("created")
    expect(nc.calls).toHaveLength(1)
    const written = nc.calls[0]!.hosts
    for (const e of existing) expect(written).toContainEqual(expect.objectContaining(e))
    expect(written).toContainEqual(expect.objectContaining({ type: "MX", name: "@", address: "smtp.google.com" }))
    expect(written).toContainEqual(expect.objectContaining({ type: "TXT", name: "_dmarc", address: "v=DMARC1; p=none; rua=mailto:owner@example.com" }))
    expect(nc.calls[0]!.emailType).toBe("MX")
  })
  it("a confirmation for another domain doesn't count", async () => {
    const nc = fakeNamecheap(existing)
    const l = byId(await runSetup(ctxFor({ "confirm-dns": "other.com" }), deps({ namecheap: nc, dns: fakeDns({}) })))["mail-dns"]!
    expect(l.status).toBe("needs owner")
    expect(nc.calls).toEqual([])
  })
  it("merge keeps existing records and skips duplicates", () => {
    const { merged, added } = mergeHosts(existing, [{ name: "send", type: "MX", address: "feedback-smtp.us-east-1.amazonses.com." }, { name: "@", type: "TXT", address: "v=spf1" }])
    expect(added).toEqual([{ name: "@", type: "TXT", address: "v=spf1" }])
    expect(merged).toHaveLength(3)
  })
})

describe("code wiring and lockfile", () => {
  it("a lockfile entry without its integrity hash is missing work (pnpm 11)", async () => {
    const files = { ...wiredPlain(), "package-lock.json": JSON.stringify({ packages: { "node_modules/@ogchonk/signup-kit": { resolved: RELEASE } } }) }
    const l = byId(await runSetup(ctxFor({ "dry-run": true }), deps({ repo: fakeRepo(files) })))["code-wiring"]!
    expect(l.detail).toMatch(/restore the lockfile integrity hash/)
  })
  it("reads pnpm and npm lockfile entries", () => {
    const pnpm = readFileSync(new URL("./fixtures/pnpm-lock-snippet.yaml", import.meta.url), "utf8")
    expect(lockIntegrity(pnpm, "pnpm", RELEASE)).toMatch(/^sha512-8py1q/)
    const broken = pnpm.replace(/\{integrity: sha512-[A-Za-z0-9+\/=]+, tarball: /, "{tarball: ")
    expect(lockIntegrity(broken, "pnpm", RELEASE)).toBeNull()
    expect(lockIntegrity(repairPnpmIntegrity(broken, RELEASE, "sha512-XYZ="), "pnpm", RELEASE)).toBe("sha512-XYZ=")
    expect(lockIntegrity(JSON.stringify({ packages: { "node_modules/@ogchonk/signup-kit": { resolved: RELEASE, integrity: "sha512-Q" } } }), "npm", RELEASE)).toBe("sha512-Q")
  })
  it("an older release still counts as wired, with the upgrade noted", async () => {
    const l = byId(await runSetup(ctxFor(), deps()))["code-wiring"]!
    expect(l.status).toBe("exists")
    expect(l.detail).toMatch(/v0\.1\.3 installed/)
  })
  it("a dirty checkout needs the owner before any branch is made", async () => {
    const repo = fakeRepo({ "package.json": "{}" }, { clean: false })
    const l = byId(await runSetup(ctxFor(), deps({ repo })))["code-wiring"]!
    expect(l.status).toBe("needs owner")
    expect(repo.calls).toEqual([])
  })
  it("a fresh plain site: branch, files, install, push; then a PR", async () => {
    const repo = fakeRepo({ "package.json": JSON.stringify({ name: "s", dependencies: {} }) })
    const lines = byId(await runSetup(ctxFor({ signer: "NTABC" }), deps({ repo })))
    expect(lines["code-wiring"]!.status).toBe("created")
    expect(repo.calls[0]).toBe("branch iter/ntabc-signup-waitlist")
    expect(repo.calls).toContain("write api/subscribe.js")
    expect(repo.calls).toContain("write signup-config.js")
    expect(repo.calls.some((c) => c.startsWith("install https://github.com/ogchonk/signup-kit/releases/download/"))).toBe(true)
    expect(repo.calls).toContain("push iter/ntabc-signup-waitlist")
    expect(lines.pr!.status).toBe("created")
    expect(repo.calls).toContain("pr iter/ntabc-signup-waitlist")
  })
})
