import { describe, expect, it } from "vitest"
import { ConfigError, poolFor, readSecrets } from "../src/core/config"
import { newsletterSite, waitlistSite } from "./helpers"

describe("defineSite", () => {
  it("accepts a valid waitlist and newsletter config", () => {
    expect(waitlistSite().domain).toBe("ntabc.co")
    expect(newsletterSite().poolLimit).toBe(40)
    expect(waitlistSite().poolLimit).toBe(20)
  })
  it.each([
    ["a table with SQL in it", { table: "x; drop table y" }],
    ["a from address on another domain", { from: "X <che@evil.com>" }],
    ["a malformed from", { from: "che@ntabc.co" }],
    ["a non-https url", { url: "http://ntabc.co" }],
    ["a url with a path", { url: "https://ntabc.co/x" }],
    ["a bad site id", { site: "NTABC!" }],
    ["missing welcome copy", { copy: {} }],
    ["an unsafe path", { paths: { unsubscribePage: "/x?y", unsubscribeApi: "/x" } }],
  ])("rejects %s", (_n, over) => {
    expect(() => waitlistSite(over as never)).toThrow(ConfigError)
  })
  it("requires confirm copy and paths for a newsletter", () => {
    expect(() => newsletterSite({ copy: { confirm: undefined, already: undefined } })).toThrow(ConfigError)
  })
  it("reads the new Supabase secret key and falls back to the legacy one", () => {
    const site = waitlistSite()
    const base = { RESEND_API_KEY: "r", SIGNUP_SECRET: "s", SUPABASE_URL: "u" }
    expect(readSecrets(site, { ...base, SUPABASE_SECRET_KEY: "new", SUPABASE_SERVICE_ROLE_KEY: "old" })?.supabaseKey).toBe("new")
    expect(readSecrets(site, { ...base, SUPABASE_SERVICE_ROLE_KEY: "old" })?.supabaseKey).toBe("old")
    expect(readSecrets(site, base)).toBeNull()
  })
  it("uses configurable env names (rcdot keeps NEWSLETTER_*)", () => {
    const s = readSecrets(newsletterSite(), { NEWSLETTER_RESEND_API_KEY: "r", NEWSLETTER_SECRET: "s", SUPABASE_URL: "u", SUPABASE_SECRET_KEY: "k" })
    expect(s).toEqual({ resendKey: "r", tokenSecret: "s", supabaseUrl: "u", supabaseKey: "k" })
  })
  it("sends every site's non-production traffic to one shared dev pool of 5 (review S4)", () => {
    expect(poolFor(waitlistSite(), { VERCEL_ENV: "production" })).toEqual({ pool: "ntabc-waitlist", limit: 20 })
    expect(poolFor(waitlistSite(), { VERCEL_ENV: "preview" })).toEqual({ pool: "dev", limit: 5 })
    expect(poolFor(waitlistSite({ site: "pf", table: "pf_waitlist_signups", url: "https://passwordfreedom.co", from: "PF <che@passwordfreedom.co>" }), {})).toEqual({ pool: "dev", limit: 5 })
  })
})
