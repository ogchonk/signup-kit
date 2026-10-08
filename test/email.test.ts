import { describe, expect, it } from "vitest"
import { acceptableAddress, hasMailServer, isEmail, normalizeEmail } from "../src/core/email"
import { fakeResolver } from "../src/testing"

describe("address checks", () => {
  it("accepts a dot-atom address and rejects malformed ones", () => {
    expect(isEmail("a.b+c@d.co")).toBe(true)
    for (const bad of ["a@b", "a@@b.co", "a b@c.co", '"q"@c.co', "a@b.co,c@d.co", `${"a".repeat(250)}@b.co`]) expect(isEmail(bad)).toBe(false)
  })
  it("normalises case and whitespace and rejects non-strings", () => {
    expect(normalizeEmail("  A@B.Co ")).toBe("a@b.co")
    expect(normalizeEmail(42)).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
  })
  it("rejects throwaway domains and domains with no mail server", async () => {
    const r = fakeResolver(["nomail.example"])
    expect(await acceptableAddress("x@mailinator.com", r)).toBeNull()
    expect(await acceptableAddress("x@nomail.example", r)).toBeNull()
    expect(await acceptableAddress("X@Example.com", r)).toBe("x@example.com")
  })
  it("fails open on a resolver error", async () => {
    const r = { resolveMx: async () => Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" })), resolve4: async () => [], resolve6: async () => [] }
    expect(await hasMailServer("example.com", r)).toBe(true)
  })
  it("bounds the whole check with a resolver that hangs, and fails open", async () => {
    const hang = () => new Promise<never>(() => {})
    const t = Date.now()
    expect(await hasMailServer("example.com", { resolveMx: hang, resolve4: hang, resolve6: hang }, 200)).toBe(true)
    expect(Date.now() - t).toBeLessThan(500)
  })
  it("treats a null MX as no mail", async () => {
    expect(await hasMailServer("example.com", { resolveMx: async () => [{ exchange: "" }], resolve4: async () => ["1.2.3.4"], resolve6: async () => [] })).toBe(false)
  })
})
