// Gate for this site's sign-up: runs the shared behaviour contract from @ogchonk/signup-kit against
// the site config, checks the handlers answer 503 (never crash) without secrets, and checks form.js
// is the installed package build. Run with: npm test
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { runContract, fakeStore, fakeMailer, fakeResolver, fakeEnv } = require('@ogchonk/signup-kit/testing')

const root = path.join(__dirname, '..')

async function invoke(handler, request) {
  const raw = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0)
  const req = Readable.from(raw.length ? [raw] : [])
  req.method = request.method
  req.url = new URL(request.url).pathname + new URL(request.url).search
  req.headers = Object.fromEntries(request.headers)
  if (raw.length && !req.headers['content-length']) req.headers['content-length'] = String(raw.length)
  return new Promise((resolve) => {
    const headers = new Headers()
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) { headers.set(k, String(v)) },
      end(b) { res.headersSent = true; resolve(new Response(b ?? null, { status: res.statusCode, headers })) },
    }
    Promise.resolve(handler(req, res)).catch((e) => resolve(new Response(String(e), { status: 599 })))
  })
}

const withoutSecrets = () => {
  for (const k of ['RESEND_API_KEY', 'SIGNUP_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k]
}

test('the full contract holds for this site config (fake database and mail)', async () => {
  const site = require('../signup-config')
  const { createWaitlistHandler } = require('@ogchonk/signup-kit/node')
  const store = fakeStore()
  const mailer = fakeMailer()
  const pending = []
  const handler = createWaitlistHandler(site, { store, mailer, resolver: fakeResolver(['nomail.example']), env: fakeEnv({ VERCEL_ENV: 'production' }), defer: (w) => pending.push(w()) })
  const results = await runContract((r) => invoke(handler, r))
  await Promise.all(pending)
  for (const r of results) assert.ok(r.pass, `${r.name}: got ${r.status} ${r.body}`)
  assert.equal(mailer.sent.length, 1, 'one welcome for one new address')
  assert.match(mailer.sent[0].from, /<che@{{domainRe}}>$/)
})

test('{{signupPath}} answers 503 without secrets, never a crash', async () => {
  withoutSecrets()
  const handler = require('../api/subscribe.js')
  const valid = await invoke(handler, new Request('{{url}}{{signupPath}}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"someone@gmail.com"}' }))
  assert.equal(valid.status, 503)
  assert.equal(await valid.text(), '{"ok":false,"error":"unavailable"}')
})

test('form.js is the installed package build, byte for byte', () => {
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  const installed = require.resolve('@ogchonk/signup-kit/form.iife.js')
  assert.equal(sha(path.join(root, 'form.js')), sha(installed), 'run: cp node_modules/@ogchonk/signup-kit/dist/form.iife.js form.js')
})
