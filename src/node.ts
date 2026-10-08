import type { IncomingMessage, ServerResponse } from "node:http"
import { waitUntil } from "@vercel/functions"
import type { Site } from "./core/config"
import { MAX_BODY_BYTES } from "./core/body"
import { newsletterConfirm, newsletterSignup, newsletterWebhook, unsubscribe, waitlistSignup, type Deps } from "./core/handlers"

/* Factories for plain Vercel functions (CommonJS or ESM, `(req, res)` signature):

     module.exports = require("@ogchonk/signup-kit/node").createWaitlistHandler(require("../signup-config"))

   The raw request stream is read here with a cap; Vercel's lazy req.body parser is never touched.
   Deferred work runs through waitUntil from @vercel/functions. */

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
type Overrides = Omit<Deps, "defer"> & { defer?: Deps["defer"] }
type Core = (req: Request, site: Site, deps: Deps) => Promise<Response>

/** The webhook needs a bigger cap than a sign-up. */
const capFor = (core: Core) => (core === newsletterWebhook ? 65536 : MAX_BODY_BYTES)

/** Past the cap, the rest of the body is drained and discarded (so the 413 can still be sent), up to a hard stop. */
const DRAIN_LIMIT = 1024 * 1024

async function readStream(req: IncomingMessage, max: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    total += b.byteLength
    if (total > DRAIN_LIMIT) {
      req.destroy()
      return null
    }
    if (total <= max) chunks.push(b)
  }
  return total > max ? null : new Uint8Array(Buffer.concat(chunks))
}

function toRequest(req: IncomingMessage, body: Uint8Array | undefined): Request {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost")
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }
  /* The URL only supplies path and query to the handlers; every link they build uses the site's configured origin. */
  return new Request(`https://${host}${req.url ?? "/"}`, { method: req.method, headers, body: body && body.byteLength ? (body as unknown as BodyInit) : undefined })
}

async function write(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status
  r.headers.forEach((v, k) => res.setHeader(k, v))
  res.end(Buffer.from(await r.arrayBuffer()))
}

function factory(core: Core) {
  return (site: Site, o?: Overrides): NodeHandler =>
    async (req, res) => {
      const deps: Deps = { ...o, defer: o?.defer ?? ((work) => waitUntil(work())) }
      try {
        let body: Uint8Array | undefined
        if (req.method !== "GET" && req.method !== "HEAD") {
          const declared = Number(req.headers["content-length"] ?? 0)
          const max = capFor(core)
          const raw = declared > max ? null : await readStream(req, max)
          if (raw === null) {
            await write(res, Response.json({ ok: false, error: "invalid" }, { status: 413, headers: { "cache-control": "no-store" } }))
            return
          }
          body = raw
        }
        await write(res, await core(toRequest(req, body), site, deps))
      } catch (err) {
        console.error("[signup-kit] handler failed:", err instanceof Error ? err.message : "error")
        if (!res.headersSent) await write(res, Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }))
      }
    }
}

export const createWaitlistHandler = factory(waitlistSignup)
export const createNewsletterHandler = factory(newsletterSignup)
export const createNewsletterWebhookHandler = factory(newsletterWebhook)
export const createNewsletterConfirmHandler = factory(newsletterConfirm)
export const createUnsubscribeHandler = factory(unsubscribe)
export const createWaitlistUnsubscribeHandler = createUnsubscribeHandler
export const createNewsletterUnsubscribeHandler = createUnsubscribeHandler

export { defineSite } from "./core/config"
