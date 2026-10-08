import { promises as dns } from "node:dns"
import disposableList from "disposable-email-domains"

/* Address checks shared by every sign-up. Ported from robbychoate.com lib/email-format.ts and
   lib/email-check.ts. The format check is strict on purpose: the local part is an RFC 5322 dot-atom
   and the domain is dot-separated labels with at least one dot, so nothing a mail library could read
   as a second recipient gets through. At most 254 characters. */

const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const LABEL = "[A-Za-z0-9-]+"
const EMAIL = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})+$`)

export function isEmail(s: string): boolean {
  return s.length <= 254 && EMAIL.test(s)
}

/** Trims and lowercases a candidate address; anything that is not a string becomes null. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null
  const s = input.trim().toLowerCase()
  return isEmail(s) ? s : null
}

const disposable = new Set<string>(disposableList as string[])

export function isDisposable(domain: string): boolean {
  return disposable.has(domain.toLowerCase())
}

/** Whole-check ceiling: past it the check fails open, so a DNS hiccup never rejects a real address. */
export const DNS_MS = 1500

export type Resolver = {
  resolveMx(domain: string): Promise<{ exchange: string }[]>
  resolve4(domain: string): Promise<string[]>
  resolve6(domain: string): Promise<string[]>
}

const DEFINITE_NO = new Set(["ENODATA", "ENOTFOUND", "EBADNAME"])
const definiteNo = (err: unknown) => DEFINITE_NO.has((err as { code?: string })?.code ?? "")
const nullExchange = (exchange: string) => exchange === "" || exchange === "."

async function mailServerLookup(domain: string, r: Resolver): Promise<boolean> {
  try {
    const mx = await r.resolveMx(domain)
    if (mx.some((x) => !nullExchange(x.exchange))) return true
    if (mx.length > 0) return false
  } catch (err) {
    if (!definiteNo(err)) return true
    if ((err as { code?: string }).code === "EBADNAME") return false
  }
  const [a, aaaa] = await Promise.allSettled([r.resolve4(domain), r.resolve6(domain)])
  if ((a.status === "fulfilled" && a.value.length > 0) || (aaaa.status === "fulfilled" && aaaa.value.length > 0)) return true
  const answeredNo = (x: PromiseSettledResult<string[]>) => (x.status === "fulfilled" ? x.value.length === 0 : definiteNo(x.reason))
  return !(answeredNo(a) && answeredNo(aaaa))
}

/** True when the domain can receive mail (MX, or A/AAAA). Unknown counts as yes; the whole check is bounded by DNS_MS. */
export async function hasMailServer(domain: string, r: Resolver = dns, ms = DNS_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const failOpen = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms)
  })
  try {
    return await Promise.race([mailServerLookup(domain, r), failOpen])
  } finally {
    clearTimeout(timer)
  }
}

/** Format, throwaway domain and mail server, in that order. Returns the normalised address or null. */
export async function acceptableAddress(input: unknown, r?: Resolver): Promise<string | null> {
  const email = normalizeEmail(input)
  if (!email) return null
  const domain = email.slice(email.lastIndexOf("@") + 1)
  if (isDisposable(domain)) return null
  return (await hasMailServer(domain, r)) ? email : null
}
