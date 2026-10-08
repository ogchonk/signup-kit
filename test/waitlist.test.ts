import { describe, expect, it } from "vitest"
import { unsubscribe, waitlistSignup, WELCOME_GAP_MS } from "../src/core/handlers"
import { runContract } from "../src/testing"
import { unsubscribeToken } from "../src/core/tokens"
import { harness, post, waitlistSite } from "./helpers"

const site = waitlistSite()
const URL = "https://ntabc.co/api/subscribe"

describe("waitlist contract", () => {
  it("passes every contract fixture with exact status and bytes", async () => {
    const h = harness()
    const results = await runContract((r) => waitlistSignup(r, site, h.deps), URL)
    for (const r of results) expect(r, r.name).toMatchObject({ pass: true })
  })
  it("answers 503, never a crash, when secrets are missing", async () => {
    const h = harness()
    const res = await waitlistSignup(post(URL, { email: "a@example.com" }), site, { ...h.deps, env: {} })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"ok":false,"error":"unavailable"}')
  })
  it("answers 503, never a crash, when a secret is malformed (createClient throws on a bad URL)", async () => {
    const h = harness()
    const res = await waitlistSignup(post(URL, { email: "a@example.com" }), site, { defer: h.deps.defer, resolver: h.deps.resolver, env: { ...h.deps.env, SUPABASE_URL: "nope" } })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"ok":false,"error":"unavailable"}')
  })
  it("answers the same 200 when the database is down: the insert runs after the reply (decision 10)", async () => {
    const h = harness()
    h.store.failNext("wlInsert")
    const res = await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    expect(await res.text()).toBe('{"ok":true}')
    await h.settle()
    expect(h.store.waitlist.get(site.table)?.get("a@example.com")).toBeUndefined()
    expect(h.mailer.sent).toHaveLength(0)
  })
})

describe("waitlist behaviour", () => {
  it("touches the database only after the reply, for a new and a repeat address alike", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    expect(h.store.calls).toEqual([])
    await h.settle()
    h.store.calls.length = 0
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    expect(h.store.calls).toEqual([])
    await h.settle()
    expect(h.store.calls[0]).toBe("wlInsert")
  })
  it("sends one welcome after the reply, with unsubscribe headers, from the site's address", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    expect(h.mailer.sent).toHaveLength(0)
    await h.settle()
    expect(h.mailer.sent).toHaveLength(1)
    const m = h.mailer.sent[0]!
    expect(m.from).toBe("NTABC <che@ntabc.co>")
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/ntabc\.co\/api\/unsubscribe\?e=a%40example\.com&t=[A-Za-z0-9_-]{43}>$/)
  })
  it("sends nothing to a repeat address that is still subscribed", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    await h.settle()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    await h.settle()
    expect(h.mailer.sent).toHaveLength(1)
  })
  it("sends one welcome when two requests for a new address race", async () => {
    const h = harness()
    await Promise.all([waitlistSignup(post(URL, { email: "r@example.com" }), site, h.deps), waitlistSignup(post(URL, { email: "r@example.com" }), site, h.deps)])
    await h.settle()
    expect(h.mailer.sent).toHaveLength(1)
  })
  it("re-subscribes only together with a welcome, and a re-sign-up within 24 h of the last welcome changes nothing (decision 6, review M1)", async () => {
    let now = new Date("2026-10-08T12:00:00Z")
    const h = harness()
    const deps = { ...h.deps, now: () => now }
    const row = () => h.store.waitlist.get(site.table)!.get("u@example.com")!
    await waitlistSignup(post(URL, { email: "u@example.com" }), site, deps)
    await h.settle()
    expect(h.mailer.sent).toHaveLength(1)
    const unsubbedAt = new Date(now.getTime() + 60_000).toISOString()
    row().unsubscribed_at = unsubbedAt
    now = new Date(now.getTime() + 2 * 60_000)
    const res = await waitlistSignup(post(URL, { email: "u@example.com" }), site, deps)
    expect(await res.text()).toBe('{"ok":true}')
    await h.settle()
    expect(row().unsubscribed_at).toBe(unsubbedAt)
    expect(h.mailer.sent).toHaveLength(1)
    now = new Date(now.getTime() + WELCOME_GAP_MS)
    await waitlistSignup(post(URL, { email: "u@example.com" }), site, deps)
    await h.settle()
    expect(row().unsubscribed_at).toBeNull()
    expect(h.mailer.sent).toHaveLength(2)
  })
  it("a re-sign-up whose welcome can't go (spent pool or failed send) leaves the address unsubscribed", async () => {
    const h = harness()
    const row = () => h.store.waitlist.get(site.table)!.get("v@example.com")!
    await waitlistSignup(post(URL, { email: "v@example.com" }), site, h.deps)
    await h.settle()
    row().welcome_sent_at = "2026-01-01T00:00:00.000Z"
    row().unsubscribed_at = "2026-01-02T00:00:00.000Z"
    h.mailer.mode = "fail"
    await waitlistSignup(post(URL, { email: "v@example.com" }), site, h.deps)
    await h.settle()
    expect(row()).toMatchObject({ unsubscribed_at: "2026-01-02T00:00:00.000Z", welcome_sent_at: "2026-01-01T00:00:00.000Z" })
    h.mailer.mode = "ok"
    for (let i = 0; i < 20; i++) await h.store.takeSend("ntabc-waitlist", 20)
    await waitlistSignup(post(URL, { email: "v@example.com" }), site, h.deps)
    await h.settle()
    expect(row().unsubscribed_at).toBe("2026-01-02T00:00:00.000Z")
  })
  it("still saves the address and answers 200 when the pool is spent; the welcome is skipped", async () => {
    const h = harness()
    for (let i = 0; i < 20; i++) await h.store.takeSend("ntabc-waitlist", 20)
    const res = await waitlistSignup(post(URL, { email: "p@example.com" }), site, h.deps)
    expect(res.status).toBe(200)
    await h.settle()
    expect(h.mailer.sent).toHaveLength(0)
    expect(h.store.waitlist.get(site.table)!.get("p@example.com")!.welcome_sent_at).toBeNull()
  })
  it("gives the slot back and releases the claim when a send fails, so a later sign-up retries", async () => {
    const h = harness()
    h.mailer.mode = "fail"
    await waitlistSignup(post(URL, { email: "f@example.com" }), site, h.deps)
    await h.settle()
    expect(h.store.waitlist.get(site.table)!.get("f@example.com")!.welcome_sent_at).toBeNull()
    expect([...h.store.quota.values()].reduce((a, b) => a + b, 0)).toBe(0)
    h.mailer.mode = "ok"
    await waitlistSignup(post(URL, { email: "f@example.com" }), site, h.deps)
    await h.settle()
    expect(h.mailer.sent).toHaveLength(1)
  })
  it("keeps the source to the allowlist and caps user agent and referrer", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "s@example.com", source: "evil" }, { "user-agent": "u".repeat(900) }), site, h.deps)
    await h.settle()
    expect(h.store.waitlist.get(site.table)!.get("s@example.com")!.source).toBe("ntabc-landing")
  })
  it("uses the dev pool outside production", async () => {
    const h = harness({ VERCEL_ENV: "preview" })
    await waitlistSignup(post(URL, { email: "d@example.com" }), site, h.deps)
    await h.settle()
    expect([...h.store.quota.keys()]).toEqual([expect.stringMatching(/\|dev$/)])
  })
})

describe("waitlist unsubscribe", () => {
  const tok = unsubscribeToken("test-secret", "a@example.com")
  const link = `https://ntabc.co/api/unsubscribe?e=a%40example.com&t=${tok}`
  it("GET renders a page and changes nothing", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    await h.settle()
    const res = await unsubscribe(new Request(link), site, h.deps)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<form method=\"post\"")
    expect(h.store.waitlist.get(site.table)!.get("a@example.com")!.unsubscribed_at).toBeNull()
  })
  it("the button POST unsubscribes", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    await h.settle()
    const res = await unsubscribe(new Request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `e=a%40example.com&t=${tok}` }), site, h.deps)
    expect(res.status).toBe(200)
    expect(h.store.waitlist.get(site.table)!.get("a@example.com")!.unsubscribed_at).not.toBeNull()
  })
  it("RFC 8058 one-click POST answers 200 with an empty body", async () => {
    const h = harness()
    await waitlistSignup(post(URL, { email: "a@example.com" }), site, h.deps)
    await h.settle()
    const res = await unsubscribe(new Request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), site, h.deps)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
  })
  it("a forged token is refused", async () => {
    const h = harness()
    const res = await unsubscribe(new Request(link.replace(tok, "A".repeat(43)), { method: "POST", body: "List-Unsubscribe=One-Click" }), site, h.deps)
    expect(res.status).toBe(400)
  })
})
