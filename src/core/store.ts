/* Everything the handlers need from the database, as one interface. The Supabase implementation is in
   supabase-store.ts; an in-memory fake with the same behaviour is in ../testing.ts. Any database
   failure throws StoreError. */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

export type NlStatus = "pending" | "confirmed" | "unsubscribed"
export type UnsubscribeReason = "user" | "bounced" | "complained"

export type NlRow = {
  email: string
  status: NlStatus
  confirm_token_hash: string | null
  confirm_sent_at: string | null
  confirm_sends: number
  unsubscribed_at: string | null
  unsubscribe_reason: string | null
}

export type WlRow = { unsubscribed_at: string | null; welcome_sent_at: string | null }

export type PendingFields = {
  confirm_token_hash: string
  confirm_sent_at: string
  confirm_sends: number
}

export interface Store {
  /** Read-only: is there room left in today's pool? */
  poolOpen(pool: string, limit: number): Promise<boolean>
  /** Atomically takes one slot; false when the pool is spent. */
  takeSend(pool: string, limit: number): Promise<boolean>
  /** Gives one slot back to the given UTC day (yyyy-mm-dd). */
  giveBack(pool: string, day: string): Promise<void>

  wlInsert(table: string, row: { email: string; source: string; user_agent: string | null; referrer: string | null }): Promise<"new" | "repeat">
  wlGet(table: string, email: string): Promise<WlRow | null>
  /** Clears unsubscribed_at. */
  wlResubscribe(table: string, email: string): Promise<void>
  /** Sets welcome_sent_at = now only while the address is subscribed and the previous stamp equals `previous`. */
  wlClaimWelcome(table: string, email: string, now: string, previous: string | null): Promise<boolean>
  /** Puts welcome_sent_at back to `previous`, only if it still holds `claimed`. */
  wlReleaseWelcome(table: string, email: string, claimed: string, previous: string | null): Promise<void>
  wlUnsubscribe(table: string, email: string, now: string): Promise<"done" | "unknown">

  nlFind(table: string, email: string): Promise<NlRow | null>
  /** Confirmed row only: stamps confirm_sent_at = now if the previous stamp is null or older than cutoff. */
  nlStampConfirmed(table: string, email: string, now: string, cutoff: string): Promise<boolean>
  /** Puts a confirmed row's stamp back, only if it still holds `claimed`. */
  nlRestoreConfirmed(table: string, email: string, claimed: string, previous: string | null): Promise<void>
  /** Pending or unsubscribed row in `expect` status, stamp null or older than cutoff: becomes pending with the new token. */
  nlToPending(table: string, email: string, expect: NlStatus, cutoff: string, fields: PendingFields): Promise<boolean>
  nlInsertPending(table: string, email: string, source: string, fields: PendingFields): Promise<"new" | "race">
  /** Undo of nlToPending/nlInsertPending, only while the row is pending with the given token hash. */
  nlRestorePending(table: string, email: string, tokenHash: string, previous: NlRow | null): Promise<void>
  nlConfirm(table: string, tokenHash: string, since: string, now: string): Promise<boolean>
  nlUnsubscribe(table: string, email: string, reason: UnsubscribeReason, now: string): Promise<"done" | "already" | "unknown">
  nlMarkUndeliverable(table: string, emails: string[], reason: "bounced" | "complained", now: string): Promise<void>
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10)
