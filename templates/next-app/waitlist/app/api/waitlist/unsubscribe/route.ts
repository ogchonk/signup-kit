import { createWaitlistUnsubscribe } from "@ogchonk/signup-kit/next"
import { site } from "{{configImport}}"

/* Unsubscribe link target. GET shows a page with one button and never changes anything (mail
   scanners follow links); the button's POST, or a mail client's RFC 8058 one-click POST, does. */

export const runtime = "nodejs"
export const maxDuration = 30

export const { GET, POST } = createWaitlistUnsubscribe(site)
