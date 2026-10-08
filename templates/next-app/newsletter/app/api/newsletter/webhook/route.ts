import { createNewsletterWebhook } from "@ogchonk/signup-kit/next"
import { site } from "{{configImport}}"

/* Resend delivery events, Svix-signed. A bounced or complaining address is marked unsubscribed with
   the reason; a failed write answers 500 so Resend retries. */

export const runtime = "nodejs"
export const maxDuration = 30

export const POST = createNewsletterWebhook(site)
