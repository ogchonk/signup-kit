import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { CONFIRMED_COOLDOWN_MS, newsletterConfirm, newsletterSignup, newsletterWebhook, unsubscribe } from "../src/core/handlers"
import { runContract } from "../src/testing"
import { DNS_MS } from "../src/core/email"
import { ROUTE_MAX_DURATION_S, worstCaseMs } from "../src/core/timeout"
import { harness, newsletterSite, post } from "./helpers"

const site = newsletterSite()
const URL = "https://robbychoate.com/api/newsletter"
const rows = (h: ReturnType<typeof harness>) => h.store.newsletter.get(site.table)!

async function signUp(h: ReturnType<typeof harness>, email: string, deps = h.deps) {
  const res = await newsletterSignup(post(URL, { email }), site, deps)
  await h.settle()
  return res
}

function confirmToken(h: ReturnType<typeof harness>): string {
  const text = h.mailer.sent.at(-1)!.text
  return /t=([A-Za-z0-9_-]{43})/.exec(text)![1]!
}

describe("newsletter contract", () => {
  it("passes every contract fixture", async () => {
    const h = harness()
    for (const r of await runContract((req) => newsletterSignup(req, site, h.deps), URL)) expect(r, r.name).toMatchObject({ pass: true })
  })
  it("the summed per-call budgets fit inside the route's maxDuration (audit fault 2)", () => {
    expect(worstCaseMs(DNS_MS)).toBeLessThanOrEqual(ROUTE_MAX_DURATION_S * 1000)
  })
})

describe("no membership leak", () => {
  it("before the reply, touches only the read-only pool gate, for new, pending, confirmed and bounced addresses alike", async () => {
    const h = harness()
    await signUp(h, "pending@example.com")
    await signUp(h, "confirmed@example.com")
    rows(h).get("confirmed@example.com")!.status = "confirmed"
    await signUp(h, "bounced@example.com")
    Object.assign(rows(h).get("bounced@example.com")!, { status: "unsubscribed", unsubscribe_reason: "bounced" })
    const logs: string[][] = []
    for (const e of ["new@example.com", "pending@example.com", "confirmed@example.com", "bounced@example.com"]) {
      h.store.calls.length = 0
      const res = await newsletterSignup(post(URL, { email: e }), site, h.deps)
      expect(await res.text()).toBe('{"ok":true}')
      logs.push([...h.store.calls])
      await h.settle()
    }
    for (const l of logs) expect(l).toEqual(["poolOpen"])
  })
  it("a spent pool gives everyone the same 503 before any lookup", async () => {
    const h = harness()
    for (let i = 0; i < 40; i++) await h.store.takeSend("rcdot-newsletter", 40)
    h.store.calls.length = 0
    const res = await newsletterSignup(post(URL, { email: "x@example.com" }), site, h.deps)
    expect(res.status).toBe(503)
    expect(h.store.calls).toEqual(["poolOpen"])
  })
})

describe("double opt-in", () => {
  it("sends a confirmation after the reply and confirms through the POST button only", async () => {
    const h = harness()
    await signUp(h, "a@example.com")
    expect(h.mailer.sent).toHaveLength(1)
    const t = confirmToken(h)
    const get = await newsletterConfirm(new Request(`https://robbychoate.com/api/newsletter/confirm?t=${t}`), site, h.deps)
    expect(get.status).toBe(303)
    expect(rows(h).get("a@example.com")!.status).toBe("pending")
    const res = await newsletterConfirm(new Request("https://robbychoate.com/api/newsletter/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${t}` }), site, h.deps)
    expect(res.headers.get("location")).toBe("https://robbychoate.com/?newsletter=confirmed#newsletter")
    expect(rows(h).get("a@example.com")!.status).toBe("confirmed")
  })
  it("throttles a pending address to one send per hour and three per row", async () => {
    let now = new Date("2026-10-08T00:00:00Z")
    const h = harness()
    const deps = { ...h.deps, now: () => now }
    await signUp(h, "p@example.com", deps)
    await signUp(h, "p@example.com", deps)
    expect(h.mailer.sent).toHaveLength(1)
    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 61 * 60 * 1000)
      await signUp(h, "p@example.com", deps)
    }
    expect(h.mailer.sent).toHaveLength(3)
  })
  it("sends a confirmed address 'already on the list' at most once per 24 h (audit fault 4)", async () => {
    let now = new Date("2026-10-08T00:00:00Z")
    const h = harness()
    const deps = { ...h.deps, now: () => now }
    await signUp(h, "c@example.com", deps)
    rows(h).get("c@example.com")!.status = "confirmed"
    now = new Date(now.getTime() + CONFIRMED_COOLDOWN_MS)
    for (let i = 0; i < 5; i++) {
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000)
      await signUp(h, "c@example.com", deps)
    }
    expect(h.mailer.sent.filter((m) => m.subject === "Already")).toHaveLength(1)
    now = new Date(now.getTime() + CONFIRMED_COOLDOWN_MS)
    await signUp(h, "c@example.com", deps)
    expect(h.mailer.sent.filter((m) => m.subject === "Already")).toHaveLength(2)
  })
  it("never mails a bounced or complained address again", async () => {
    const h = harness()
    await signUp(h, "b@example.com")
    Object.assign(rows(h).get("b@example.com")!, { status: "unsubscribed", unsubscribe_reason: "complained" })
    await signUp(h, "b@example.com")
    expect(h.mailer.sent).toHaveLength(1)
  })
  it("a slow failed send restores the row, so a retry gets a fresh confirmation (audit fault 1)", async () => {
    const h = harness()
    h.mailer.mode = "slow-fail"
    h.mailer.delayMs = 50
    await signUp(h, "s@example.com")
    const row = rows(h).get("s@example.com")!
    expect(row.confirm_sent_at).toBeNull()
    expect(row.confirm_sends).toBe(0)
    h.mailer.mode = "ok"
    h.mailer.delayMs = 0
    await signUp(h, "s@example.com")
    expect(h.mailer.sent).toHaveLength(1)
  })
  it("a restore never overwrites an unsubscribe that landed in between (audit fault 5)", async () => {
    const h = harness()
    h.mailer.mode = "fail"
    let unsubscribedMidway = false
    const send = h.mailer.send
    h.mailer.send = async (m) => {
      await h.store.nlUnsubscribe(site.table, "race@example.com", "user", new Date().toISOString())
      unsubscribedMidway = true
      return send(m)
    }
    await signUp(h, "race@example.com")
    expect(unsubscribedMidway).toBe(true)
    expect(rows(h).get("race@example.com")!.status).toBe("unsubscribed")
  })
  it("builds every link on the configured origin, never the request's Host (audit fault 8)", async () => {
    const h = harness()
    await newsletterSignup(post("https://evil.example/api/newsletter", { email: "h@example.com" }, { host: "evil.example", "x-forwarded-proto": "http" }), site, h.deps)
    await h.settle()
    expect(h.mailer.sent[0]!.text).toContain("https://robbychoate.com/newsletter/confirm?t=")
    expect(h.mailer.sent[0]!.text).not.toContain("evil.example")
  })
})

describe("newsletter unsubscribe and webhook", () => {
  it("accepts a link minted by today's robbychoate.com code (same secret env and format)", async () => {
    const h = harness()
    await signUp(h, "old@example.com")
    rows(h).get("old@example.com")!.status = "confirmed"
    const legacy = createHmac("sha256", "test-secret").update("old@example.com").digest("base64url")
    const res = await unsubscribe(new Request(`https://robbychoate.com/api/newsletter/unsubscribe?e=old%40example.com&t=${legacy}`, { method: "POST", body: "List-Unsubscribe=One-Click" }), site, h.deps)
    expect(res.status).toBe(200)
    expect(rows(h).get("old@example.com")!.status).toBe("unsubscribed")
  })
  it("GET on the API redirects to the site's own page and changes nothing", async () => {
    const h = harness()
    const res = await unsubscribe(new Request("https://robbychoate.com/api/newsletter/unsubscribe?e=a%40b.co&t=x"), site, h.deps)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("https://robbychoate.com/newsletter/unsubscribe?e=a%40b.co&t=x")
  })
  const signed = (body: string, secret: string, ts = Math.floor(Date.now() / 1000)) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
    const sig = createHmac("sha256", key).update(`msg_1.${ts}.${body}`).digest("base64")
    return { "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` }
  }
  it("marks a bounced address unsubscribed on a valid signature", async () => {
    const h = harness()
    await signUp(h, "bounce@example.com")
    const body = JSON.stringify({ type: "email.bounced", data: { to: ["Bounce@example.com"] } })
    const res = await newsletterWebhook(new Request("https://robbychoate.com/api/newsletter/webhook", { method: "POST", headers: signed(body, h.deps.env!.RESEND_WEBHOOK_SECRET!), body }), site, h.deps)
    expect(res.status).toBe(204)
    expect(rows(h).get("bounce@example.com")).toMatchObject({ status: "unsubscribed", unsubscribe_reason: "bounced" })
  })
  it("401 for a bad or stale signature, 413 over 64 KB, 500 when the write fails", async () => {
    const h = harness()
    const secret = h.deps.env!.RESEND_WEBHOOK_SECRET!
    const body = JSON.stringify({ type: "email.complained", data: { to: "z@example.com" } })
    const req = (headers: Record<string, string>, b = body) => new Request("https://x/", { method: "POST", headers, body: b })
    expect((await newsletterWebhook(req(signed(body, "whsec_" + Buffer.from("wrong").toString("base64"))), site, h.deps)).status).toBe(401)
    expect((await newsletterWebhook(req(signed(body, secret, Math.floor(Date.now() / 1000) - 600)), site, h.deps)).status).toBe(401)
    const big = "x".repeat(70000)
    expect((await newsletterWebhook(req(signed(big, secret), big), site, h.deps)).status).toBe(413)
    h.store.failNext("nlMarkUndeliverable")
    expect((await newsletterWebhook(req(signed(body, secret)), site, h.deps)).status).toBe(500)
  })
})
