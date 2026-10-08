import type { ResendAdmin, ResendEmail } from "./clients/resend"

/* `signup-kit health`: bounces and complaints per sending domain over the last N days, from
   Resend's sent-mail list. Resend may pause an account above a 4% bounce rate, and single opt-in
   waitlists are the main risk, so this is the early warning. Addresses are never printed. */

export type DomainHealth = { domain: string; sent: number; bounced: number; complained: number; bounceRate: number }

export const BOUNCE_ALERT = 0.04

export function summarize(emails: ResendEmail[]): DomainHealth[] {
  const by = new Map<string, DomainHealth>()
  for (const e of emails) {
    const domain = /@([^>\s]+)>?\s*$/.exec(e.from)?.[1]?.toLowerCase() ?? "unknown"
    const h = by.get(domain) ?? { domain, sent: 0, bounced: 0, complained: 0, bounceRate: 0 }
    h.sent++
    if (e.last_event === "bounced") h.bounced++
    if (e.last_event === "complained") h.complained++
    by.set(domain, h)
  }
  return [...by.values()].map((h) => ({ ...h, bounceRate: h.sent ? h.bounced / h.sent : 0 })).sort((a, b) => a.domain.localeCompare(b.domain))
}

export async function health(r: ResendAdmin, days: number, now = new Date()): Promise<DomainHealth[]> {
  return summarize(await r.listEmailsSince(new Date(now.getTime() - days * 86_400_000)))
}

export function formatHealth(rows: DomainHealth[], days: number): string {
  if (!rows.length) return `No emails sent in the last ${days} days.`
  const lines = rows.map((h) => `${h.domain.padEnd(28)} sent ${String(h.sent).padStart(4)}  bounced ${String(h.bounced).padStart(3)} (${(h.bounceRate * 100).toFixed(1)}%)  complained ${h.complained}${h.bounceRate > BOUNCE_ALERT ? "  ⚠ over Resend's 4% bounce threshold" : ""}`)
  return [`Last ${days} days, by sending domain:`, ...lines].join("\n")
}
