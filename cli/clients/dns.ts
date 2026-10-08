import { promises as dns } from "node:dns"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/* DNS: read-only lookups through the system resolver, and Namecheap writes. Namecheap's setHosts
   replaces a domain's whole record set, so a write always carries every existing record over, saves a
   backup first, and only runs when the owner has confirmed this exact domain (--confirm-dns). The API
   credentials come from ~/.namecheap-api.env at run time and are never printed. */

export interface DnsLookup {
  txt(name: string): Promise<string[]>
  mx(name: string): Promise<string[]>
}

export const systemDns: DnsLookup = {
  async txt(name) {
    try {
      return (await dns.resolveTxt(name)).map((parts) => parts.join(""))
    } catch {
      return []
    }
  },
  async mx(name) {
    try {
      return (await dns.resolveMx(name)).map((r) => r.exchange.toLowerCase().replace(/\.$/, ""))
    } catch {
      return []
    }
  },
}

export type Host = { name: string; type: string; address: string; mxPref?: string; ttl?: string }

export interface Namecheap {
  getHosts(domain: string): Promise<{ hosts: Host[]; emailType: string }>
  setHosts(domain: string, hosts: Host[], emailType: string): Promise<void>
}

export type NamecheapCreds = { apiUser: string; apiKey: string; username: string; clientIp: string }

export async function loadNamecheapCreds(path = join(homedir(), ".namecheap-api.env")): Promise<NamecheapCreds | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return null
  }
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line)
    if (m) env[m[1]!] = m[2]!
  }
  const c = { apiUser: env.NAMECHEAP_API_USER ?? "", apiKey: env.NAMECHEAP_API_KEY ?? "", username: env.NAMECHEAP_USERNAME ?? "", clientIp: env.NAMECHEAP_CLIENT_IP ?? "" }
  return c.apiUser && c.apiKey && c.username && c.clientIp ? c : null
}

const split = (domain: string) => {
  const i = domain.indexOf(".")
  return { sld: domain.slice(0, i), tld: domain.slice(i + 1) }
}

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? ""
const xmlEsc = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'")

export function namecheap(creds: NamecheapCreds, f: typeof fetch = fetch): Namecheap {
  const call = async (command: string, params: Record<string, string>, method: "GET" | "POST" = "GET") => {
    const q = new URLSearchParams({ ApiUser: creds.apiUser, ApiKey: creds.apiKey, UserName: creds.username, ClientIp: creds.clientIp, Command: command, ...params })
    const res =
      method === "GET"
        ? await f(`https://api.namecheap.com/xml.response?${q}`, { signal: AbortSignal.timeout(20_000) })
        : await f("https://api.namecheap.com/xml.response", { method: "POST", body: q, signal: AbortSignal.timeout(20_000) })
    const xml = await res.text()
    if (!/Status="OK"/.test(xml)) {
      const err = /<Error Number="(\d+)">([^<]*)/.exec(xml)
      throw new Error(`Namecheap ${command} failed${err ? ` (${err[1]}: ${err[2]})` : ""}`)
    }
    return xml
  }
  return {
    async getHosts(domain) {
      const xml = await call("namecheap.domains.dns.getHosts", split(domain))
      const emailType = /EmailType="([^"]*)"/.exec(xml)?.[1] ?? "MX"
      const hosts = [...xml.matchAll(/<host [^>]*\/?>/g)].map((m) => ({
        name: xmlEsc(attr(m[0], "Name")),
        type: attr(m[0], "Type"),
        address: xmlEsc(attr(m[0], "Address")),
        mxPref: attr(m[0], "MXPref") || undefined,
        ttl: attr(m[0], "TTL") || undefined,
      }))
      return { hosts, emailType }
    },
    async setHosts(domain, hosts, emailType) {
      const p: Record<string, string> = { ...split(domain), EmailType: emailType }
      hosts.forEach((h, i) => {
        const n = i + 1
        p[`HostName${n}`] = h.name
        p[`RecordType${n}`] = h.type
        p[`Address${n}`] = h.address
        p[`TTL${n}`] = h.ttl ?? "1800"
        if (h.type === "MX") p[`MXPref${n}`] = h.mxPref ?? "10"
      })
      await call("namecheap.domains.dns.setHosts", p, "POST")
    },
  }
}

/** Adds the wanted records to the current set (existing records are kept; exact duplicates skipped). Returns the merged list and what was added. */
export function mergeHosts(current: Host[], wanted: Host[]): { merged: Host[]; added: Host[] } {
  const key = (h: Host) => `${h.type}|${h.name.toLowerCase()}|${h.address.toLowerCase().replace(/\.$/, "")}`
  const have = new Set(current.map(key))
  const added = wanted.filter((w) => !have.has(key(w)))
  return { merged: [...current, ...added], added }
}

export async function publicIp(f: typeof fetch = fetch): Promise<string | null> {
  try {
    return (await (await f("https://api.ipify.org", { signal: AbortSignal.timeout(5_000) })).text()).trim()
  } catch {
    return null
  }
}
