import { defineSite, type SiteInput } from "../src/core/config"
import { fakeEnv, fakeMailer, fakeResolver, fakeStore } from "../src/testing"
import type { Deps } from "../src/core/handlers"

const copy = (s: string) => ({ subject: s, greeting: "Hi,", body: `${s} body`, button: "Open", note: "note" })

export const waitlistSite = (over: Partial<SiteInput> = {}) =>
  defineSite({
    site: "ntabc",
    kind: "waitlist",
    url: "https://ntabc.co",
    table: "ntabc_waitlist_signups",
    from: "NTABC <che@ntabc.co>",
    replyTo: "yola@robbychoate.com",
    signer: "NTABC",
    sources: ["ntabc-landing"],
    paths: { unsubscribePage: "/api/unsubscribe", unsubscribeApi: "/api/unsubscribe" },
    copy: { welcome: copy("Welcome") },
    ...over,
  })

export const newsletterSite = (over: Partial<SiteInput> = {}) =>
  defineSite({
    site: "rcdot",
    kind: "newsletter",
    url: "https://robbychoate.com",
    table: "rc_subscribers",
    from: "Robby Choate <che@robbychoate.com>",
    replyTo: "yola@robbychoate.com",
    signer: "Robby Choate",
    sources: ["footer"],
    env: { resendKey: "NEWSLETTER_RESEND_API_KEY", tokenSecret: "NEWSLETTER_SECRET" },
    paths: { unsubscribePage: "/newsletter/unsubscribe", unsubscribeApi: "/api/newsletter/unsubscribe", confirmPage: "/newsletter/confirm", confirmApi: "/api/newsletter/confirm" },
    copy: { confirm: copy("Confirm"), already: copy("Already") },
    ...over,
  })

export function harness(envExtra: Record<string, string> = {}) {
  const store = fakeStore()
  const mailer = fakeMailer()
  const pending: (() => Promise<void>)[] = []
  const deps: Deps = {
    store,
    mailer,
    resolver: fakeResolver(["nomail.example"]),
    env: fakeEnv({ NEWSLETTER_RESEND_API_KEY: "k", NEWSLETTER_SECRET: "test-secret", VERCEL_ENV: "production", ...envExtra }),
    /* Like after()/waitUntil: nothing runs until the reply is out — here, until settle(). */
    defer: (work) => {
      pending.push(work)
    },
  }
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0).map((w) => w()))
  }
  return { store, mailer, deps, settle, pending }
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
