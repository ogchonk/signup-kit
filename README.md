# signup-kit

One tested sign-up for every site: a **waitlist** (address + one welcome email) or a **newsletter**
(double opt-in), on Vercel, backed by Supabase and Resend. Each site keeps only a config object,
thin route files and its own form markup. A fix here reaches every site by bumping one version.

The design, the behaviour contract and the review record are in the plan:
`plans/2026-10-08-signup-uniform-waitlist-newsletter.md`.

## Install

```json
"@ogchonk/signup-kit": "https://github.com/ogchonk/signup-kit/releases/download/v0.1.1/ogchonk-signup-kit-0.1.1.tgz"
```

Releases are immutable and built in GitHub Actions with a provenance attestation; lockfiles pin
each tarball's hash.

## Use

Next.js App Router (`app/api/waitlist/route.ts`):

```ts
import { createWaitlistPost } from "@ogchonk/signup-kit/next"
import { site } from "@/lib/signup-config"
export const runtime = "nodejs"
export const maxDuration = 30
export const POST = createWaitlistPost(site)
```

Plain Vercel function (`api/subscribe.js`):

```js
module.exports = require("@ogchonk/signup-kit/node").createWaitlistHandler(require("../signup-config"))
```

Config (`defineSite` validates it at import time):

```ts
import { defineSite } from "@ogchonk/signup-kit/core"
export const site = defineSite({
  site: "ntabc", kind: "waitlist", url: "https://ntabc.co", table: "ntabc_waitlist_signups",
  from: "NTABC <che@ntabc.co>", replyTo: "yola@robbychoate.com", signer: "NTABC",
  sources: ["ntabc-landing"],
  paths: { unsubscribePage: "/api/unsubscribe", unsubscribeApi: "/api/unsubscribe" },
  copy: { welcome: { subject: "…", greeting: "…", body: "…", button: "Unsubscribe", note: "…" } },
})
```

Environment (names configurable per site): `RESEND_API_KEY`, `SIGNUP_SECRET`, `SUPABASE_URL`,
`SUPABASE_SECRET_KEY` (falls back to `SUPABASE_SERVICE_ROLE_KEY`), and for newsletters
`RESEND_WEBHOOK_SECRET`. Missing or malformed secrets answer 503, never a crash.

Database (all idempotent): `sql/001_shared_infra.sql` once per project. Per waitlist:
`sql/010_waitlist_table.sql.tmpl` (structure; safe while a site's old code is still live), then
`sql/011_waitlist_constraints.sql.tmpl` at that site's cutover (row checks old code may violate).
Per newsletter: `sql/020_newsletter_table.sql.tmpl`.

Non-production traffic (`VERCEL_ENV` other than `production`) shares one `dev` pool of 5 sends a day.

## Develop

`pnpm test` (unit), `pnpm test:db` (real Postgres plus PostgREST: `DATABASE_URL` and
`POSTGREST_URL`, or local containers on ports 55432 and 53000 — see `.github/workflows/ci.yml` for the
settings), `pnpm typecheck`, `pnpm lint`, `pnpm build`.

Site tests use `@ogchonk/signup-kit/testing`: `fakeStore()`, `fakeMailer()`,
`fakeResolver(["nomail.example"])`, `fakeEnv()`, `runContract(handler)`.
