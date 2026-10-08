import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createWaitlistHandler } from "../src/node"
import { contractFixtures } from "../src/testing"
import { harness, waitlistSite } from "./helpers"

const afterCalls: (() => Promise<void>)[] = []
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => afterCalls.push(fn) }))

const site = waitlistSite()

describe("node adapter over a real HTTP server", () => {
  const h = harness()
  let deferred: Promise<void>[] = []
  let server: Server
  let base = ""
  beforeAll(async () => {
    const handler = createWaitlistHandler(site, { ...h.deps, defer: (w) => void deferred.push(w()) })
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it("passes every contract fixture, reading the raw stream (never req.body)", async () => {
    for (const f of contractFixtures) {
      const res = await fetch(`${base}/api/subscribe`, f.init as RequestInit)
      expect(res.status, f.name).toBe(f.status)
      if (f.body) expect(await res.text(), f.name).toBe(f.body)
      expect(res.headers.get("cache-control"), f.name).toBe("no-store")
    }
  })
  it("413 for a chunked body with no content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 6; i++) c.enqueue(new TextEncoder().encode("x".repeat(500)))
        c.close()
      },
    })
    const res = await fetch(`${base}/api/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit)
    expect(res.status).toBe(413)
  })
  it("sends the reply before the deferred work finishes", async () => {
    deferred = []
    h.mailer.delayMs = 300
    const t = Date.now()
    const res = await fetch(`${base}/api/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "slow@example.com" }) })
    expect(res.status).toBe(200)
    expect(Date.now() - t).toBeLessThan(250)
    await Promise.all(deferred)
    expect(h.mailer.sent.some((m) => m.to === "slow@example.com")).toBe(true)
    h.mailer.delayMs = 0
  })
  it("answers 503 when secrets are missing, never a crash", async () => {
    const handler = createWaitlistHandler(site, { ...h.deps, env: {} })
    const s = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => s.listen(0, r))
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"a@example.com"}' })
    expect(res.status).toBe(503)
    await new Promise<void>((r) => s.close(() => r()))
  })
})

describe("next adapter", () => {
  it("defers through next/server after()", async () => {
    const { createWaitlistPost } = await import("../src/next")
    const h = harness()
    const POST = createWaitlistPost(site, { store: h.store, mailer: h.mailer, resolver: h.deps.resolver, env: h.deps.env })
    const res = await POST(new Request("https://ntabc.co/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"n@example.com"}' }))
    expect(res.status).toBe(200)
    expect(h.mailer.sent).toHaveLength(0)
    expect(afterCalls).toHaveLength(1)
    await afterCalls[0]!()
    expect(h.mailer.sent).toHaveLength(1)
  })
})
