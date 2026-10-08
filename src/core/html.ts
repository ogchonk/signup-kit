import { esc } from "./mail"
import type { PageCopy } from "./config"

/* One page shell for every landing page (audit fault 10: the confirm and unsubscribe pages duplicated
   theirs). Used by sites that have no page of their own; GET only renders, the button POSTs. */

export function page(copy: PageCopy, form?: { action: string; fields: Record<string, string> }): string {
  const hidden = form ? Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("") : ""
  const button = form && copy.button ? `<form method="post" action="${esc(form.action)}">${hidden}<button type="submit">${esc(copy.button)}</button></form>` : ""
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(copy.title)}</title>
<style>body{margin:0;font:17px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1917;background:#faf9f7}main{max-width:32rem;margin:15vh auto;padding:0 16px}button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#1a1917;color:#fff;cursor:pointer}button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}</style></head>
<body><main><h1>${esc(copy.heading)}</h1><p>${esc(copy.body)}</p>${button}</main></body></html>`
}

export const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })

export const DEFAULT_PAGES: Record<string, PageCopy> = {
  unsubscribePage: { title: "Unsubscribe", heading: "Unsubscribe", body: "Press the button to stop these emails.", button: "Unsubscribe" },
  unsubscribed: { title: "Unsubscribed", heading: "You're unsubscribed", body: "You won't get any more emails from this list." },
  invalidLink: { title: "Link not valid", heading: "That link isn't valid", body: "It may be incomplete. Copy the whole link from the email and try again." },
  confirmPage: { title: "Confirm", heading: "Confirm your subscription", body: "Press the button to confirm.", button: "Confirm" },
  confirmed: { title: "Confirmed", heading: "You're on the list", body: "Thanks for confirming." },
  expired: { title: "Link expired", heading: "That link has expired", body: "Sign up again to get a fresh one." },
}
