import { describe, expect, it } from "vitest"
import { statusFor, submitSignup } from "../src/form"

describe("form helper", () => {
  it("maps reply codes to the site's message keys", () => {
    expect(statusFor(200)).toBe("ok")
    expect([400, 413, 415].map(statusFor)).toEqual(["invalid", "invalid", "invalid"])
    expect(statusFor(429)).toBe("busy")
    expect([503, 500, null].map(statusFor)).toEqual(["unavailable", "unavailable", "unavailable"])
  })
  it("posts JSON with the honeypot field and maps a network error to unavailable", async () => {
    let sent: unknown
    const ok = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    expect(await submitSignup({ endpoint: "/api/x", email: "a@b.co", source: "footer", fetchImpl: ok })).toBe("ok")
    expect(sent).toEqual({ email: "a@b.co", company: "", source: "footer" })
    const down = (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    expect(await submitSignup({ endpoint: "/api/x", email: "a@b.co", fetchImpl: down })).toBe("unavailable")
  })
})

describe("runContract options", () => {
  it("swaps in a live address and can skip the no-mail row", async () => {
    const { runContract } = await import("../src/testing")
    const seen: string[] = []
    const results = await runContract(async (r) => {
      seen.push(await r.clone().text())
      return new Response('{"ok":true}', { headers: { "cache-control": "no-store" } })
    }, { address: "delivered@resend.dev", skipNoMail: true })
    expect(results.some((r) => r.name.startsWith("no mail server"))).toBe(false)
    expect(seen.some((b) => b.includes("delivered@resend.dev"))).toBe(true)
    expect(seen.some((b) => b.includes("new@example.com"))).toBe(false)
  })
})
