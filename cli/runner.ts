import type { Ctx } from "./context"
import { steps as defaultSteps, type Deps, type Step } from "./steps"

/* Runs the steps in order and prints one line per step:
     exists | created | skipped (reason) | needs owner (reason) | blocked (reason)
   A blocked step blocks every later step, which then shows what it would have done. In --dry-run
   nothing is applied: a missing piece prints "skipped (dry run: would …)". The probe runs only when
   something was created (or --probe-url is given); when every step already existed it is skipped. */

export type Status = "exists" | "created" | "skipped" | "needs owner" | "blocked"
export type Line = { id: string; title: string; status: Status; detail: string }

export async function runSetup(ctx: Ctx, d: Deps, out: (l: Line) => void = () => {}, list: Step[] = defaultSteps): Promise<Line[]> {
  const lines: Line[] = []
  const emit = (l: Line) => {
    lines.push(l)
    out(l)
  }
  let blockedBy: string | null = null
  for (const step of list) {
    if (step.applies && !step.applies(ctx)) continue
    if (blockedBy) {
      emit({ id: step.id, title: step.title, status: "blocked", detail: `after ${blockedBy}; would ${step.would(ctx)}` })
      continue
    }
    let c
    try {
      c = await step.check(ctx, d)
    } catch (err) {
      emit({ id: step.id, title: step.title, status: "blocked", detail: `check failed: ${(err as Error).message}` })
      blockedBy = step.title
      continue
    }
    if (c.state === "ok") emit({ id: step.id, title: step.title, status: "exists", detail: c.detail })
    else if (c.state === "skip") emit({ id: step.id, title: step.title, status: "skipped", detail: c.reason })
    else if (c.state === "owner") emit({ id: step.id, title: step.title, status: "needs owner", detail: c.reason })
    else if (c.state === "blocked") {
      emit({ id: step.id, title: step.title, status: "blocked", detail: c.reason })
      blockedBy = step.title
    } else if (ctx.dryRun || !step.apply) {
      emit({ id: step.id, title: step.title, status: ctx.dryRun ? "skipped" : "needs owner", detail: ctx.dryRun ? `dry run: would ${c.would}` : c.would })
    } else {
      try {
        const a = await step.apply(ctx, d)
        emit({ id: step.id, title: step.title, status: a.status, detail: a.detail })
        if (a.status === "blocked") blockedBy = step.title
      } catch (err) {
        emit({ id: step.id, title: step.title, status: "blocked", detail: `failed: ${(err as Error).message}` })
        blockedBy = step.title
      }
    }
  }
  const changed = lines.some((l) => l.status === "created")
  if (blockedBy) emit({ id: "probe", title: "Live probe", status: "blocked", detail: `after ${blockedBy}` })
  else if (!changed && !ctx.probeUrl) emit({ id: "probe", title: "Live probe", status: "skipped", detail: ctx.dryRun ? "dry run" : "nothing changed" })
  else if (!ctx.probeUrl) emit({ id: "probe", title: "Live probe", status: "skipped", detail: "no preview URL yet: once Vercel posts the PR's preview, run `signup-kit probe --url <preview>`" })
  return lines
}

export function format(l: Line): string {
  const s = l.status === "exists" || l.status === "created" ? l.status : `${l.status} (${l.detail})`
  return `${l.title.padEnd(36)} ${s}${l.status === "exists" || l.status === "created" ? `  ${l.detail}` : ""}`
}
