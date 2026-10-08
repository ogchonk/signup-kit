import { createNewsletterConfirm } from "@ogchonk/signup-kit/next"
import { site } from "{{configImport}}"

/* Confirmation link target. GET shows a page with one button (or redirects to the site's own page);
   only the button's POST confirms, because mail scanners fetch every link. */

export const runtime = "nodejs"
export const maxDuration = 30

export const { GET, POST } = createNewsletterConfirm(site)
