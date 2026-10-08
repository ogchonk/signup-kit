/* Resend admin operations, through a full-access key the owner keeps in the macOS Keychain
   (item `signup-kit-resend-admin`). Sending keys can't list domains or keys, so without the admin
   key every Resend step reports that the owner is needed. Tokens returned by createSendingKey go
   straight to the caller, which pipes them into Vercel; nothing here logs them. */

export type ResendDomain = { id: string; name: string; status: string }
export type DnsRecord = { type: string; name: string; value: string; priority?: number }
export type ResendEmail = { from: string; last_event: string; created_at: string }

export interface ResendAdmin {
  listDomains(): Promise<ResendDomain[]>
  createDomain(name: string): Promise<{ id: string; records: DnsRecord[] }>
  verifyDomain(id: string): Promise<void>
  listApiKeyNames(): Promise<string[]>
  createSendingKey(name: string, domainId: string): Promise<string>
  listWebhookEndpoints(): Promise<string[]>
  listEmailsSince(since: Date): Promise<ResendEmail[]>
}

export const RESEND_FREE_DOMAIN_LIMIT = 3

export function resendAdmin(key: string, f: typeof fetch = fetch): ResendAdmin {
  const call = async (path: string, init: RequestInit = {}): Promise<any> => {
    const res = await f(`https://api.resend.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Resend ${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status}`)
    return res.status === 204 ? null : res.json()
  }
  return {
    async listDomains() {
      const r = await call("/domains")
      return (r.data ?? []).map((d: any) => ({ id: d.id, name: d.name, status: d.status }))
    },
    async createDomain(name) {
      const r = await call("/domains", { method: "POST", body: JSON.stringify({ name, region: "us-east-1" }) })
      return { id: r.id, records: (r.records ?? []).map((x: any) => ({ type: x.type, name: x.name, value: x.value, priority: x.priority })) }
    },
    async verifyDomain(id) {
      await call(`/domains/${encodeURIComponent(id)}/verify`, { method: "POST" })
    },
    async listApiKeyNames() {
      const r = await call("/api-keys")
      return (r.data ?? []).map((k: any) => String(k.name))
    },
    async createSendingKey(name, domainId) {
      const r = await call("/api-keys", { method: "POST", body: JSON.stringify({ name, permission: "sending_access", domain_id: domainId }) })
      return String(r.token)
    },
    async listWebhookEndpoints() {
      const r = await call("/webhooks")
      return (r.data ?? []).map((w: any) => String(w.endpoint))
    },
    async listEmailsSince(since) {
      const out: ResendEmail[] = []
      let after: string | undefined
      for (let page = 0; page < 20; page++) {
        const r = await call(`/emails?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`)
        const data: any[] = r.data ?? []
        for (const e of data) {
          if (new Date(e.created_at) < since) return out
          out.push({ from: String(e.from), last_event: String(e.last_event ?? ""), created_at: String(e.created_at) })
        }
        if (!r.has_more || data.length === 0) break
        after = data[data.length - 1].id
      }
      return out
    },
  }
}

/** The sending key's name for a domain: dots become hyphens, e.g. ntabc.co → ntabc-co-send. */
export const sendingKeyName = (domain: string) => `${domain.replaceAll(".", "-")}-send`
