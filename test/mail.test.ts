import { describe, expect, it } from "vitest"
import { esc, idempotencyKey, renderMail, resendMailer } from "../src/core/mail"

describe("mail", () => {
  it("escapes every HTML-significant character, including inside an href (audit fault 7)", () => {
    expect(esc(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;")
    const { html } = renderMail({ subject: "s", greeting: "g", body: "b", button: "go", note: "n" }, 'https://x.test/a"onmouseover="alert(1)', "S")
    expect(html).toContain('href="https://x.test/a&quot;onmouseover=&quot;alert(1)"')
    expect(html).not.toContain('"onmouseover="')
  })
  it("keys confirmations by token hash so a resend later the same day is a new key", () => {
    const a = idempotencyKey("rcdot", "a@b.co", "confirm", "hash1")
    const b = idempotencyKey("rcdot", "a@b.co", "confirm", "hash2")
    expect(a).not.toBe(b)
    expect(idempotencyKey("ntabc", "a@b.co", "welcome", "2026-10-08")).toBe(idempotencyKey("ntabc", "a@b.co", "welcome", "2026-10-08"))
  })
  it("sends the Idempotency-Key and List-Unsubscribe headers to Resend", async () => {
    let seen: { headers: Record<string, string>; body: { headers?: Record<string, string> } } | null = null
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const r = await resendMailer("k", fetchImpl).send({ from: "A <a@b.co>", to: "c@d.co", subject: "s", text: "t", html: "h", headers: { "List-Unsubscribe": "<x>" }, idempotencyKey: "abc" })
    expect(r).toEqual({ ok: true })
    expect(seen!.headers["idempotency-key"]).toBe("abc")
    expect(seen!.body.headers!["List-Unsubscribe"]).toBe("<x>")
  })
  it("counts a 409 idempotency conflict as a failed send", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch
    expect(await resendMailer("k", fetchImpl).send({ from: "a", to: "b", subject: "s", text: "t", html: "h", idempotencyKey: "k" })).toEqual({ ok: false, reason: "rejected" })
  })
  it("aborts a send slower than its budget and reports a timeout", async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const t = Date.now()
    expect(await resendMailer("k", fetchImpl, 100).send({ from: "a", to: "b", subject: "s", text: "t", html: "h", idempotencyKey: "k" })).toEqual({ ok: false, reason: "timeout" })
    expect(Date.now() - t).toBeLessThan(1000)
  })
})
