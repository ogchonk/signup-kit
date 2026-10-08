/* The one JSON boundary reader (ported from robbychoate.com lib/read-json-body.ts). A body over the
   cap is refused as soon as the running byte count passes it, never buffered whole first. */

export const MAX_BODY_BYTES = 2048

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 }

/** Reads a stream as UTF-8 text, giving up past maxBytes (null). Throws when the stream itself fails. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, declared: number, maxBytes: number): Promise<string | null> {
  if (declared > maxBytes) return null
  const chunks: Uint8Array[] = []
  if (body) {
    const reader = body.getReader()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  }
  return new TextDecoder().decode(concat(chunks))
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

export function contentType(req: Request): string {
  return (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
}

export async function readJson(req: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  if (contentType(req) !== "application/json") return { ok: false, status: 415 }
  let text: string | null
  try {
    text = await readCapped(req.body, Number(req.headers.get("content-length") ?? 0), maxBytes)
  } catch {
    return { ok: false, status: 400 }
  }
  if (text === null) return { ok: false, status: 413 }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, status: 400 }
  }
}

/** Reads a small form-encoded body (unsubscribe and confirm buttons, RFC 8058 one-click). */
export async function readForm(req: Request, maxBytes = MAX_BODY_BYTES): Promise<URLSearchParams | null> {
  try {
    const text = await readCapped(req.body, Number(req.headers.get("content-length") ?? 0), maxBytes)
    return text === null ? null : new URLSearchParams(text)
  } catch {
    return null
  }
}
