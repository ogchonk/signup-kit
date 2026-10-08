import { createNewsletterPost } from "@ogchonk/signup-kit/next"
import { site } from "{{configImport}}"

/* Newsletter sign-up (double opt-in) on the shared @ogchonk/signup-kit package. The reply comes right
   after the body, honeypot, format and mail-server checks and the daily send pool; the row, the
   confirmation email and any restore happen after the reply. */

export const runtime = "nodejs"
export const maxDuration = 30

export const POST = createNewsletterPost(site)
