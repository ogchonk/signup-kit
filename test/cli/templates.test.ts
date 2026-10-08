import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { defineSite } from "../../src/core/config"
import { renderFiles, siteObject } from "../../cli/templates"
import { summarize, formatHealth } from "../../cli/health"
import { probe } from "../../cli/probe"
import { ctxFor } from "./fakes"

const templatesDir = join(__dirname, "..", "..", "templates")

const cases = [
  { name: "plain waitlist (ntabc.co shape)", flags: { signer: "NTABC", "reply-to": "owner@example.com", sources: "ntabc-landing" }, pkg: {}, src: false },
  { name: "plain newsletter", flags: { kind: "newsletter", domain: "letters.example", signer: "Letters" }, pkg: {}, src: false },
  { name: "Next waitlist with src/ (passwordfreedom.co shape)", flags: { domain: "passwordfreedom.co", site: "pf", signer: "Password Freedom", sources: "hero-stripe,closing-cta" }, pkg: { dependencies: { next: "16.2.6" } }, src: true },
  { name: "Next newsletter (robbychoate.com shape)", flags: { kind: "newsletter", domain: "robbychoate.com", site: "rcdot", table: "rc_subscribers", signer: "Robby Choate", "resend-key-env": "NEWSLETTER_RESEND_API_KEY", "token-secret-env": "NEWSLETTER_SECRET" }, pkg: { dependencies: { next: "16.3.3" } }, src: false },
] as const

describe("templates", () => {
  for (const c of cases) {
    it(`renders ${c.name}`, async () => {
      const ctx = ctxFor(c.flags as Record<string, string>, c.pkg, c.src)
      const files = await renderFiles(ctx, templatesDir)
      for (const f of files) {
        expect(f.content, f.path).not.toMatch(/\{\{\w+\}\}/)
        expect(f.content, `${f.path} has an em dash (G-30)`).not.toContain("—")
      }
      expect(Object.fromEntries(files.map((f) => [f.path, f.content]))).toMatchSnapshot()
      // The generated config is accepted by the package itself.
      expect(() => defineSite(siteObject(ctx) as never)).not.toThrow()
      const site = defineSite(siteObject(ctx) as never)
      expect(site.domain).toBe(ctx.domain)
      expect(site.env.resendKey).toBe(ctx.env.resendKey)
    })
  }

  it("Next routes keep runtime and maxDuration as literals", async () => {
    const files = await renderFiles(ctxFor({ domain: "passwordfreedom.co", site: "pf" }, { dependencies: { next: "16" } }, true), templatesDir)
    const routes = files.filter((f) => f.path.endsWith("route.ts"))
    expect(routes.map((f) => f.path).sort()).toEqual(["src/app/api/waitlist/route.ts", "src/app/api/waitlist/unsubscribe/route.ts"])
    for (const r of routes) {
      expect(r.content).toContain('export const runtime = "nodejs"')
      expect(r.content).toContain("export const maxDuration = 30")
      expect(r.content).toContain('from "@/lib/signup-config"')
    }
    expect(files.some((f) => f.path === "src/lib/signup-config.ts")).toBe(true)
  })

  it("plain sites get vercel.json with npm ci and a 30 s limit", async () => {
    const files = await renderFiles(ctxFor(), templatesDir)
    const v = JSON.parse(files.find((f) => f.path === "vercel.json")!.content)
    expect(v).toEqual({ installCommand: "npm ci", functions: { "api/*.js": { maxDuration: 30 } } })
  })
})

describe("health", () => {
  it("groups by sending domain and flags a bounce rate over 4%", () => {
    const e = (from: string, last_event: string) => ({ from, last_event, created_at: "2026-10-08T00:00:00Z" })
    const rows = summarize([e("NTABC <che@ntabc.co>", "delivered"), e("NTABC <che@ntabc.co>", "bounced"), e("Robby <che@robbychoate.com>", "delivered"), e("Robby <che@robbychoate.com>", "complained")])
    expect(rows).toEqual([
      { domain: "ntabc.co", sent: 2, bounced: 1, complained: 0, bounceRate: 0.5 },
      { domain: "robbychoate.com", sent: 2, bounced: 0, complained: 1, bounceRate: 0 },
    ])
    const text = formatHealth(rows, 7)
    expect(text).toMatch(/ntabc\.co .*over Resend's 4% bounce threshold/)
    expect(text).not.toMatch(/@/)
  })
})

describe("probe", () => {
  it("passes against a site that follows the contract", async () => {
    let n = 0
    const f = (async (_url: string, init: RequestInit) => {
      n++
      const type = (init.headers as Record<string, string>)["content-type"]
      const body = String(init.body)
      const json = (s: number, b: string) => new Response(b, { status: s, headers: { "cache-control": "no-store" } })
      if (n >= 6) return json(429, "")
      if (type !== "application/json") return json(415, '{"ok":false,"error":"invalid"}')
      if (body.includes("company")) return json(200, '{"ok":true}')
      if (body.includes("a@@b")) return json(400, '{"ok":false,"error":"invalid"}')
      return json(200, '{"ok":true}')
    }) as unknown as typeof fetch
    const r = await probe("https://site.example", "/api/subscribe", { tag: "t1", firewall: true, f })
    expect(r.filter((x) => !x.pass)).toEqual([])
  })
  it("fails when a repeat address answers differently (membership leak)", async () => {
    let seen = false
    const f = (async (_u: string, init: RequestInit) => {
      const b = String(init.body)
      if (b.includes("delivered+")) {
        const r = new Response(seen ? '{"ok":true,"message":"already"}' : '{"ok":true}', { status: 200, headers: { "cache-control": "no-store" } })
        seen = true
        return r
      }
      return new Response("", { status: b === "hello" ? 415 : b.includes("company") ? 200 : 400 })
    }) as unknown as typeof fetch
    const r = await probe("https://site.example", "/api/subscribe", { tag: "t2", firewall: false, f })
    expect(r.find((x) => x.name.startsWith("repeat"))!.pass).toBe(false)
  })
})
