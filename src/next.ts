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

export const createWaitlistPost = (site: Site, o?: Overrides): Handler => (req) => waitlistSignup(req, site, deps(o))
export const createNewsletterPost = (site: Site, o?: Overrides): Handler => (req) => newsletterSignup(req, site, deps(o))
export const createNewsletterWebhook = (site: Site, o?: Overrides): Handler => (req) => newsletterWebhook(req, site, deps(o))

export function createUnsubscribe(site: Site, o?: Overrides): { GET: Handler; POST: Handler } {
  const h: Handler = (req) => unsubscribe(req, site, deps(o))
  return { GET: h, POST: h }
}
export const createWaitlistUnsubscribe = createUnsubscribe
export const createNewsletterUnsubscribe = createUnsubscribe

export function createNewsletterConfirm(site: Site, o?: Overrides): { GET: Handler; POST: Handler } {
  const h: Handler = (req) => newsletterConfirm(req, site, deps(o))
  return { GET: h, POST: h }
}

export { defineSite } from "./core/config"
