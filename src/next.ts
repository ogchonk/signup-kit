import { after } from "next/server"
import type { Site } from "./core/config"
import { newsletterConfirm, newsletterSignup, newsletterWebhook, unsubscribe, waitlistSignup, type Deps } from "./core/handlers"

/* App Router factories. Each route file keeps its own literal `runtime` and `maxDuration`:

     import { createWaitlistPost } from "@ogchonk/signup-kit/next"
     import { site } from "@/lib/signup-config"
     export const runtime = "nodejs"
     export const maxDuration = 30
     export const POST = createWaitlistPost(site)

   Deferred work runs through next/server's after(), so it continues once the reply has gone. */

type Handler = (req: Request) => Promise<Response>
type Overrides = Omit<Deps, "defer">

const deps = (o?: Overrides): Deps => ({ ...o, defer: (work) => after(work) })

/** Any unexpected throw becomes the contract's 503, never Next's 500 page — the same as the node adapter. */
const guard =
  (h: Handler): Handler =>
  async (req) => {
    try {
      return await h(req)
    } catch (err) {
      console.error("[signup-kit] handler failed:", err instanceof Error ? err.message : "error")
      return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } })
    }
  }

export const createWaitlistPost = (site: Site, o?: Overrides): Handler => guard((req) => waitlistSignup(req, site, deps(o)))
export const createNewsletterPost = (site: Site, o?: Overrides): Handler => guard((req) => newsletterSignup(req, site, deps(o)))
export const createNewsletterWebhook = (site: Site, o?: Overrides): Handler => guard((req) => newsletterWebhook(req, site, deps(o)))

export function createUnsubscribe(site: Site, o?: Overrides): { GET: Handler; POST: Handler } {
  const h: Handler = guard((req) => unsubscribe(req, site, deps(o)))
  return { GET: h, POST: h }
}
export const createWaitlistUnsubscribe = createUnsubscribe
export const createNewsletterUnsubscribe = createUnsubscribe

export function createNewsletterConfirm(site: Site, o?: Overrides): { GET: Handler; POST: Handler } {
  const h: Handler = guard((req) => newsletterConfirm(req, site, deps(o)))
  return { GET: h, POST: h }
}

export { defineSite } from "./core/config"
