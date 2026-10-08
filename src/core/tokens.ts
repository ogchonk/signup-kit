import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Site } from "./config"

/* Unsubscribe tokens are base64url(HMAC-SHA256(secret, email)) — the exact format robbychoate.com has
   been sending since 2026-09-20, so every link already in an inbox keeps working. Confirmation tokens
   are 32 random bytes, stored only as a SHA-256 hash. One pattern for both (audit fault 9). */

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function unsubscribeToken(secret: string, email: string): string {
  return createHmac("sha256", secret).update(email).digest("base64url")
}

export function unsubscribeTokenValid(secret: string, email: string, token: string): boolean {
  if (!secret || !TOKEN_RE.test(token)) return false
  const expected = Buffer.from(unsubscribeToken(secret, email))
  const given = Buffer.from(token)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export const newConfirmToken = () => randomBytes(32).toString("base64url")
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

function query(secret: string, email: string): string {
  return `e=${encodeURIComponent(email)}&t=${unsubscribeToken(secret, email)}`
}

/** The link a person clicks: a page with one button, so a mail scanner following it changes nothing. */
export const unsubscribePageUrl = (site: Site, secret: string, email: string) => `${site.url}${site.paths.unsubscribePage}?${query(secret, email)}`
/** The RFC 8058 one-click target: mail clients POST here. */
export const unsubscribeApiUrl = (site: Site, secret: string, email: string) => `${site.url}${site.paths.unsubscribeApi}?${query(secret, email)}`
export const confirmUrl = (site: Site, token: string) => `${site.url}${site.paths.confirmPage}?t=${token}`
