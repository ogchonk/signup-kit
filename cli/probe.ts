/* The live probe: the behaviour contract against a deployed site, from outside. It uses a
   delivered+<tag>@resend.dev address (Resend's sandbox, so nothing reaches a person) and never reads
   the database; the skill deletes the probe row afterwards. The 6-request firewall check is optional
   because it spends the visitor's 10-minute window. */

export type ProbeResult = { name: string; pass: boolean; got: string }

export async function probe(base: string, signupPath: string, opts: { tag: string; firewall: boolean; headers?: Record<string, string>; f?: typeof fetch }): Promise<ProbeResult[]> {
  const f = opts.f ?? fetch
  const url = base.replace(/\/$/, "") + signupPath
  const post = async (body: string, type = "application/json") => {
    const res = await f(url, { method: "POST", headers: { "content-type": type, ...opts.headers }, body, signal: AbortSignal.timeout(20_000) })
    return { status: res.status, text: await res.text(), cache: res.headers.get("cache-control") }
  }
  const out: ProbeResult[] = []
  const check = (name: string, pass: boolean, got: string) => out.push({ name, pass, got })
  const address = `delivered+${opts.tag}@resend.dev`
  const a = await post("hello", "text/plain")
  check("wrong content type → 415", a.status === 415, String(a.status))
  const b = await post(JSON.stringify({ email: "x@example.com", company: "bot" }))
  check("honeypot → 200", b.status === 200, String(b.status))
  const c = await post(JSON.stringify({ email: "a@@b" }))
  check("bad address → 400", c.status === 400, String(c.status))
  const first = await post(JSON.stringify({ email: address }))
  check("new address → 200", first.status === 200, `${first.status} ${first.text}`)
  check("no-store on replies", first.cache === "no-store", String(first.cache))
  const second = await post(JSON.stringify({ email: address }))
  check("repeat address → identical reply", second.status === first.status && second.text === first.text, `${second.status} ${second.text}`)
  if (opts.firewall) {
    const extra = await post(JSON.stringify({ email: "a@@b" }))
    check("6th request in 10 minutes → 429", extra.status === 429, String(extra.status))
  }
  return out
}
