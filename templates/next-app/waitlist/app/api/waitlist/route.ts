import { createWaitlistPost } from "@ogchonk/signup-kit/next"
import { site } from "{{configImport}}"

/* Waitlist sign-up on the shared @ogchonk/signup-kit package. The reply is the same for a new and a
   repeat address; the insert and the welcome email run after the reply. runtime and maxDuration
   stay literals in this file. */

export const runtime = "nodejs"
export const maxDuration = 30

export const POST = createWaitlistPost(site)
