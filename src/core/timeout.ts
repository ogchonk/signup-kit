/* Every outside call gets its own deadline. robbychoate.com used one AbortController for a whole
   sign-up, so a restore after a slow failed send ran on an already-aborted signal and failed (audit
   fault 1). Here each call builds a fresh signal at the moment it starts. */

/** One database round trip. */
export const DB_MS = 2000
/** One Resend send. */
export const SEND_MS = 5000

export const freshSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms)

/** Worst case for one sign-up, reply and after-reply work together: DNS + three database calls + send + restore. */
export function worstCaseMs(dnsMs: number): number {
  return dnsMs + 3 * DB_MS + SEND_MS + DB_MS
}

/** The literal every route must export as maxDuration (seconds). */
export const ROUTE_MAX_DURATION_S = 30
