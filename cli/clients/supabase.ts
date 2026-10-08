/* Supabase Management API for the hub project (ai-memory). Uses SUPABASE_ACCESS_TOKEN from the
   environment. SQL goes through /database/query: checks run with read_only true; only the package's
   own sql/*.sql files are ever applied. A secret key returned by createSecretKey is handed to the
   caller to pipe into Vercel and never logged. */

export interface SupabaseMgmt {
  readonly ref: string
  readonly projectUrl: string
  ping(): Promise<boolean>
  listKeyNames(): Promise<string[]>
  createSecretKey(name: string): Promise<string>
  query<T = Record<string, unknown>>(sql: string, readOnly: boolean): Promise<T[]>
}

export const DEFAULT_SUPABASE_REF = "zuawlcsjwneqjdeklvyh"

export function supabaseMgmt(token: string, ref = DEFAULT_SUPABASE_REF, f: typeof fetch = fetch): SupabaseMgmt {
  const call = async (path: string, init: RequestInit = {}): Promise<any> => {
    const res = await f(`https://api.supabase.com/v1/projects/${ref}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Supabase ${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status}`)
    return res.json()
  }
  return {
    ref,
    projectUrl: `https://${ref}.supabase.co`,
    async ping() {
      try {
        await call("")
        return true
      } catch {
        return false
      }
    },
    async listKeyNames() {
      const r = await call("/api-keys")
      return (r as any[]).filter((k) => k.type === "secret").map((k) => String(k.name))
    },
    async createSecretKey(name) {
      const r = await call("/api-keys?reveal=true", {
        method: "POST",
        body: JSON.stringify({ type: "secret", name, description: `signup-kit for ${name}`, secret_jwt_template: { role: "service_role" } }),
      })
      const key = String(r.api_key ?? "")
      if (!key.startsWith("sb_secret_")) throw new Error("Supabase returned an unexpected key shape")
      return key
    },
    async query(sql, readOnly) {
      return (await call("/database/query", { method: "POST", body: JSON.stringify({ query: sql, read_only: readOnly }) })) as any[]
    },
  }
}

/** The per-site secret key's name: the domain's first label, e.g. passwordfreedom.co → passwordfreedom_signup. */
export const supabaseKeyName = (domain: string) => `${domain.split(".")[0]!.replaceAll("-", "_")}_signup`
