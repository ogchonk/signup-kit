import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { TOKEN_RE, hashToken, newConfirmToken, unsubscribeToken, unsubscribeTokenValid } from "../src/core/tokens"
import { page } from "../src/core/html"

describe("tokens", () => {
  it("verifies a token minted exactly the way robbychoate.com's lib/newsletter.ts mints them today", () => {
    /* rcdot: createHmac("sha256", process.env.NEWSLETTER_SECRET ?? "").update(email).digest("base64url") */
    const legacy = createHmac("sha256", "s3cret").update("a@b.co").digest("base64url")
    expect(unsubscribeToken("s3cret", "a@b.co")).toBe(legacy)
    expect(unsubscribeTokenValid("s3cret", "a@b.co", legacy)).toBe(true)
  })
  it("rejects a tampered token, a wrong address and an empty secret", () => {
    const t = unsubscribeToken("s", "a@b.co")
    expect(unsubscribeTokenValid("s", "a@b.co", t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBe(false)
    expect(unsubscribeTokenValid("s", "x@b.co", t)).toBe(false)
    expect(unsubscribeTokenValid("", "a@b.co", t)).toBe(false)
  })
  it("uses one 43-character pattern for both token kinds (audit fault 9)", () => {
    expect(TOKEN_RE.test(newConfirmToken())).toBe(true)
    expect(TOKEN_RE.test(unsubscribeToken("s", "a@b.co"))).toBe(true)
    expect(hashToken("x")).toMatch(/^[0-9a-f]{64}$/)
  })
  it("renders landing pages with every value escaped", () => {
    const html = page({ title: "<t>", heading: "h", body: "b", button: "go" }, { action: "/x", fields: { e: '"><script>' } })
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;t&gt;")
  })
})
