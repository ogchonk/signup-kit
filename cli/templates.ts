import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { Ctx } from "./context"

/* Code wiring for a new site, derived from the live ntabc.co (plain function), passwordfreedom.co
   (Next waitlist) and robbychoate.com (Next newsletter) wiring. Route files come from templates/;
   the config file is generated here because its copy and paths depend on the site. Copy is a plain
   starting point: the skill checks it against the owner's banned-copy list (G-30) before the PR. */

export type FileOut = { path: string; content: string }

const q = (s: string, quote: string) => {
  const use = s.includes(quote) && !s.includes(quote === "'" ? '"' : "'") ? (quote === "'" ? '"' : "'") : quote
  return use + s.replaceAll("\\", "\\\\").replaceAll(use, "\\" + use) + use
}

export function brandName(ctx: Ctx): string {
  return ctx.signer
}

export function defaultCopy(ctx: Ctx) {
  const brand = brandName(ctx)
  const pages = {
    unsubscribePage: { title: "Unsubscribe", heading: `Leave the ${brand} list`, body: "Press the button and we'll stop emailing this address.", button: "Unsubscribe" },
    unsubscribed: { title: "Unsubscribed", heading: "You're off the list", body: "We won't email this address again unless you sign up again." },
    invalidLink: { title: "Link not valid", heading: "That link didn't work", body: "It may be incomplete. Copy the whole link from the email, or reply to our email and we'll take you off the list." },
    unavailable: { title: "Try again later", heading: "Something went wrong on our side", body: "Try the link again in a few minutes." },
  }
  if (ctx.kind === "waitlist") {
    return {
      welcome: {
        subject: `You're on the ${brand} waitlist`,
        greeting: "Thanks for signing up.",
        body: `You're on the ${brand} waitlist. We'll write again when there's news to share.`,
        button: "Unsubscribe",
        note: "If you didn't sign up, or you've changed your mind, you can unsubscribe here.",
      },
      ...pages,
    }
  }
  return {
    confirm: {
      subject: `Confirm your ${brand} subscription`,
      greeting: "One more step.",
      body: `Press the button to confirm you want the ${brand} newsletter.`,
      button: "Confirm",
      note: "The link works for 48 hours. If you didn't sign up, ignore this email.",
    },
    already: {
      subject: `You're already on the ${brand} list`,
      greeting: "Hello again.",
      body: `This address is already subscribed to the ${brand} newsletter.`,
      button: "Unsubscribe",
      note: "If you'd rather stop getting it, you can unsubscribe here.",
    },
    confirmPage: { title: "Confirm", heading: "Confirm your subscription", body: "Press the button to finish signing up.", button: "Confirm" },
    confirmed: { title: "Confirmed", heading: "You're subscribed", body: "Thanks. The next letter will reach this address." },
    expired: { title: "Link expired", heading: "That link has expired", body: "Sign up again and we'll send a fresh link." },
    ...pages,
  }
}

function literal(v: unknown, indent: string, quote: string): string {
  if (typeof v === "string") return q(v, quote)
  if (Array.isArray(v)) return `[${v.map((x) => literal(x, indent, quote)).join(", ")}]`
  if (v && typeof v === "object") {
    const inner = indent + "  "
    const lines = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${inner}${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : q(k, quote)}: ${literal(x, inner, quote)},`)
    return `{\n${lines.join("\n")}\n${indent}}`
  }
  return String(v)
}

export function siteObject(ctx: Ctx): Record<string, unknown> {
  const o: Record<string, unknown> = {
    site: ctx.site,
    kind: ctx.kind,
    url: ctx.url,
    table: ctx.table,
    from: ctx.from,
    replyTo: ctx.replyTo,
    signer: ctx.signer,
    pool: ctx.pool,
    sources: ctx.sources,
  }
  const env: Record<string, string> = {}
  if (ctx.env.resendKey !== "RESEND_API_KEY") env.resendKey = ctx.env.resendKey
  if (ctx.env.tokenSecret !== "SIGNUP_SECRET") env.tokenSecret = ctx.env.tokenSecret
  if (ctx.kind === "newsletter" && ctx.env.webhookSecret !== "RESEND_WEBHOOK_SECRET") env.webhookSecret = ctx.env.webhookSecret
  if (Object.keys(env).length) o.env = env
  o.paths =
    ctx.kind === "waitlist"
      ? { unsubscribePage: ctx.paths.unsubscribe, unsubscribeApi: ctx.paths.unsubscribe }
      : { unsubscribePage: ctx.paths.unsubscribe, unsubscribeApi: ctx.paths.unsubscribe, confirmPage: ctx.paths.confirm!, confirmApi: ctx.paths.confirm! }
  o.copy = defaultCopy(ctx)
  return o
}

export function renderConfig(ctx: Ctx): FileOut {
  const obj = literal(siteObject(ctx), "", ctx.stack === "vercel-plain" ? "'" : '"')
  if (ctx.stack === "vercel-plain") {
    return {
      path: "signup-config.js",
      content: `// ${ctx.domain} ${ctx.kind} settings for @ogchonk/signup-kit. Copy lives here; behaviour lives in the\n// shared package. No secrets in this file: they are read from the environment at request time.\nconst { defineSite } = require('@ogchonk/signup-kit/core')\n\nmodule.exports = defineSite(${obj})\n`,
    }
  }
  return {
    path: `${ctx.srcPrefix}lib/signup-config.ts`,
    content: `import { defineSite } from "@ogchonk/signup-kit/core"\n\n/* ${ctx.domain} ${ctx.kind} settings for the shared @ogchonk/signup-kit package. Copy lives here;\n   behaviour lives in the package. No secrets in this file: they are read from the environment at\n   request time. */\n\nexport const site = defineSite(${obj})\n`,
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

/** Every file the code-wiring step writes for this site, with placeholders filled. */
export async function renderFiles(ctx: Ctx, templatesDir: string): Promise<FileOut[]> {
  const base = join(templatesDir, ctx.stack, ctx.kind)
  const vars: Record<string, string> = {
    configImport: ctx.stack === "next-app" ? "@/lib/signup-config" : "../signup-config",
    signupPath: ctx.paths.signup,
    url: ctx.url,
    domainRe: ctx.domain.replaceAll(".", "\\."),
  }
  const files: FileOut[] = []
  for (const abs of (await walk(base)).sort()) {
    let rel = relative(base, abs)
    if (ctx.stack === "next-app" && rel.startsWith("app/")) rel = ctx.srcPrefix + rel
    const text = (await readFile(abs, "utf8")).replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      if (!(k in vars)) throw new Error(`template ${rel} uses unknown placeholder ${k}`)
      return vars[k]!
    })
    files.push({ path: rel, content: text })
  }
  files.push(renderConfig(ctx))
  return files
}
