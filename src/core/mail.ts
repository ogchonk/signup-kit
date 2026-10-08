import { createHash } from "node:crypto"
import { SEND_MS, freshSignal } from "./timeout"
import type { MailCopy } from "./config"

/* Resend, called over plain fetch so the request carries an Idempotency-Key and its own deadline.
   Escaping covers attribute context too (audit fault 7: the old esc() left double quotes alone and the
   result went inside href="…"). */

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

export type Message = {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
  idempotencyKey: string
}

export type SendResult = { ok: true } | { ok: false; reason: "timeout" | "rejected" | "network" }

export interface Mailer {
  send(m: Message): Promise<SendResult>
}

export function resendMailer(apiKey: string, fetchImpl: typeof fetch = fetch, ms = SEND_MS): Mailer {
  return {
    async send(m) {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": m.idempotencyKey,
          },
          body: JSON.stringify({
            from: m.from,
            to: m.to,
            reply_to: m.replyTo,
            subject: m.subject,
            text: m.text,
            html: m.html,
            headers: m.headers,
          }),
          signal: freshSignal(ms),
        })
        if (res.ok) return { ok: true }
        /* 409 (idempotency conflict) and every other non-2xx count as a failed send. The address is never logged. */
        console.error("[signup-kit] send rejected:", res.status)
        return { ok: false, reason: "rejected" }
      } catch (err) {
        const timeout = (err as { name?: string })?.name === "TimeoutError" || (err as { name?: string })?.name === "AbortError"
        console.error("[signup-kit] send failed:", timeout ? "timed out" : "network")
        return { ok: false, reason: timeout ? "timeout" : "network" }
      }
    },
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/** The pool is part of the key, so a preview (dev pool) and a production send of the same mail never share one. */
export function idempotencyKey(site: string, pool: string, email: string, kind: "confirm" | "welcome" | "already", part: string): string {
  return sha256(`${site}|${pool}|${email}|${kind}|${part}`)
}

/** Plain text first, the same words in minimal HTML so the link is a button. */
export function renderMail(copy: MailCopy, link: string, signer: string, noteFirst = false): { text: string; html: string } {
  const text = noteFirst
    ? [copy.greeting, "", copy.body, "", copy.note, link, "", `— ${signer}`].join("\n")
    : [copy.greeting, "", copy.body, "", link, "", copy.note, "", `— ${signer}`].join("\n")
  const note = `<p style="color:#666;font-size:14px">${esc(copy.note)}</p>`
  const button = `<p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1a1917;color:#fff;text-decoration:none">${esc(copy.button)}</a></p>`
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1917;background:#fff">
<p>${esc(copy.greeting)}</p>
<p>${esc(copy.body)}</p>
${noteFirst ? note + button : button + note}
<p>— ${esc(signer)}</p>
</body></html>`
  return { text, html }
}

export function unsubscribeHeaders(oneClickUrl: string): Record<string, string> {
  return { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
}
