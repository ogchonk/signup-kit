import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { DB_MS, freshSignal } from "./timeout"
import { StoreError, type NlRow, type Store } from "./store"

/* The Supabase implementation of Store. Every call builds its own AbortSignal at the moment it starts
   (audit fault 1), and every update filters on the state it expects (audit fault 5). */

const NL_COLUMNS = "email,status,confirm_token_hash,confirm_sent_at,confirm_sends,unsubscribed_at,unsubscribe_reason"
const UNIQUE_VIOLATION = "23505"

type PgError = { code?: string; message?: string } | null

function check(error: PgError, what: string): void {
  if (error) throw new StoreError(`${what}: ${error.message ?? "database error"}`, error.code)
}

/** The PostgREST "or" filter for "stamp is null or older than cutoff". */
const staleOr = (column: string, cutoff: string) => `${column}.is.null,${column}.lt.${cutoff}`

export function supabaseStore(url: string, key: string, client?: SupabaseClient): Store {
  const db = client ?? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const sig = () => freshSignal(DB_MS)

  return {
    async poolOpen(pool, limit) {
      const { data, error } = await db.rpc("signup_pool_open", { p_pool: pool, p_limit: limit }).abortSignal(sig())
      check(error, "pool_open")
      return data === true
    },
    async takeSend(pool, limit) {
      const { data, error } = await db.rpc("signup_take_send", { p_pool: pool, p_limit: limit }).abortSignal(sig())
      check(error, "take_send")
      return data === true
    },
    async giveBack(pool, day) {
      const { error } = await db.rpc("signup_give_back_send", { p_pool: pool, p_day: day }).abortSignal(sig())
      check(error, "give_back")
    },

    async wlInsert(table, row) {
      const { error } = await db.from(table).insert(row).abortSignal(sig())
      if (error?.code === UNIQUE_VIOLATION) return "repeat"
      check(error, "waitlist insert")
      return "new"
    },
    async wlGet(table, email) {
      const { data, error } = await db.from(table).select("unsubscribed_at,welcome_sent_at").eq("email", email).abortSignal(sig()).maybeSingle()
      check(error, "waitlist read")
      return (data as { unsubscribed_at: string | null; welcome_sent_at: string | null } | null) ?? null
    },
    async wlResubscribe(table, email) {
      const { error } = await db.from(table).update({ unsubscribed_at: null }).eq("email", email).not("unsubscribed_at", "is", null).abortSignal(sig())
      check(error, "waitlist resubscribe")
    },
    async wlClaimWelcome(table, email, now, previous) {
      let q = db.from(table).update({ welcome_sent_at: now }).eq("email", email).is("unsubscribed_at", null)
      q = previous === null ? q.is("welcome_sent_at", null) : q.eq("welcome_sent_at", previous)
      const { data, error } = await q.select("email").abortSignal(sig())
      check(error, "waitlist claim")
      return (data?.length ?? 0) > 0
    },
    async wlReleaseWelcome(table, email, claimed, previous) {
      const { error } = await db.from(table).update({ welcome_sent_at: previous }).eq("email", email).eq("welcome_sent_at", claimed).abortSignal(sig())
      check(error, "waitlist release")
    },
    async wlUnsubscribe(table, email, now) {
      const { data, error } = await db.from(table).update({ unsubscribed_at: now }).eq("email", email).is("unsubscribed_at", null).select("email").abortSignal(sig())
      check(error, "waitlist unsubscribe")
      if ((data?.length ?? 0) > 0) return "done"
      const known = await db.from(table).select("email").eq("email", email).abortSignal(sig()).maybeSingle()
      check(known.error, "waitlist unsubscribe lookup")
      return known.data ? "done" : "unknown"
    },

    async nlFind(table, email) {
      const { data, error } = await db.from(table).select(NL_COLUMNS).eq("email", email).abortSignal(sig()).maybeSingle()
      check(error, "newsletter read")
      return (data as NlRow | null) ?? null
    },
    async nlStampConfirmed(table, email, now, cutoff) {
      const { data, error } = await db
        .from(table)
        .update({ confirm_sent_at: now, updated_at: now })
        .eq("email", email)
        .eq("status", "confirmed")
        .or(staleOr("confirm_sent_at", cutoff))
        .select("email")
        .abortSignal(sig())
      check(error, "newsletter stamp")
      return (data?.length ?? 0) > 0
    },
    async nlRestoreConfirmed(table, email, claimed, previous) {
      const { error } = await db
        .from(table)
        .update({ confirm_sent_at: previous })
        .eq("email", email)
        .eq("status", "confirmed")
        .eq("confirm_sent_at", claimed)
        .abortSignal(sig())
      check(error, "newsletter restore stamp")
    },
    async nlToPending(table, email, expect, cutoff, f) {
      const { data, error } = await db
        .from(table)
        .update({ status: "pending", ...f, unsubscribed_at: null, unsubscribe_reason: null, updated_at: f.confirm_sent_at })
        .eq("email", email)
        .eq("status", expect)
        .or(staleOr("confirm_sent_at", cutoff))
        .select("email")
        .abortSignal(sig())
      check(error, "newsletter to pending")
      return (data?.length ?? 0) > 0
    },
    async nlInsertPending(table, email, source, f) {
      const { error } = await db
        .from(table)
        .insert({ email, source, status: "pending", ...f, updated_at: f.confirm_sent_at })
        .abortSignal(sig())
      if (error?.code === UNIQUE_VIOLATION) return "race"
      check(error, "newsletter insert")
      return "new"
    },
    async nlRestorePending(table, email, tokenHash, previous) {
      const back = previous
        ? {
            status: previous.status,
            confirm_token_hash: previous.confirm_token_hash,
            confirm_sent_at: previous.confirm_sent_at,
            confirm_sends: previous.confirm_sends,
            unsubscribed_at: previous.unsubscribed_at,
            unsubscribe_reason: previous.unsubscribe_reason,
          }
        : { confirm_token_hash: null, confirm_sent_at: null, confirm_sends: 0 }
      const { error } = await db
        .from(table)
        .update({ ...back, updated_at: new Date().toISOString() })
        .eq("email", email)
        .eq("status", "pending")
        .eq("confirm_token_hash", tokenHash)
        .abortSignal(sig())
      check(error, "newsletter restore")
    },
    async nlConfirm(table, tokenHash, since, now) {
      const { data, error } = await db
        .from(table)
        .update({ status: "confirmed", confirmed_at: now, confirm_token_hash: null, confirm_sends: 0, updated_at: now })
        .eq("confirm_token_hash", tokenHash)
        .eq("status", "pending")
        .gte("confirm_sent_at", since)
        .select("email")
        .abortSignal(sig())
      check(error, "newsletter confirm")
      return (data?.length ?? 0) > 0
    },
    async nlUnsubscribe(table, email, reason, now) {
      const { data, error } = await db
        .from(table)
        .update({ status: "unsubscribed", unsubscribed_at: now, unsubscribe_reason: reason, confirm_token_hash: null, confirm_sends: 0, updated_at: now })
        .eq("email", email)
        .neq("status", "unsubscribed")
        .select("email")
        .abortSignal(sig())
      check(error, "newsletter unsubscribe")
      if ((data?.length ?? 0) > 0) return "done"
      const known = await db.from(table).select("email").eq("email", email).abortSignal(sig()).maybeSingle()
      check(known.error, "newsletter unsubscribe lookup")
      return known.data ? "already" : "unknown"
    },
    async nlMarkUndeliverable(table, emails, reason, now) {
      if (emails.length === 0) return
      const { error } = await db
        .from(table)
        .update({ status: "unsubscribed", unsubscribed_at: now, unsubscribe_reason: reason, confirm_token_hash: null, confirm_sends: 0, updated_at: now })
        .in("email", emails)
        .abortSignal(sig())
      check(error, "newsletter mark undeliverable")
    },
  }
}
