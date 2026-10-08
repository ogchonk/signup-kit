import { describe, expect, it } from "vitest"
import { readJson } from "../src/core/body"

const req = (body: BodyInit, type = "application/json", headers: Record<string, string> = {}) =>
  new Request("https://x.test/", { method: "POST", headers: { "content-type": type, ...headers }, body, ...({ duplex: "half" } as object) })

describe("JSON body reader", () => {
  it("415 for a non-JSON content type", async () => expect(await readJson(req("{}", "text/plain"))).toEqual({ ok: false, status: 415 }))
  it("413 at 2049 bytes with a declared length", async () => expect(await readJson(req("x".repeat(2049)))).toEqual({ ok: false, status: 413 }))
  it("413 while streaming with no declared length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode("x".repeat(500)))
        c.close()
      },
    })
    expect(await readJson(req(stream))).toEqual({ ok: false, status: 413 })
  })
  it("400 for malformed JSON", async () => expect(await readJson(req("{"))).toEqual({ ok: false, status: 400 }))
  it("returns the value for valid JSON", async () => expect(await readJson(req('{"a":1}', "application/json; charset=utf-8"))).toEqual({ ok: true, value: { a: 1 } }))
})
