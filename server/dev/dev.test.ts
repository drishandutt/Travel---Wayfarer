import assert from 'node:assert/strict'
import { lastCode } from '../mail'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { resetLimits } from '../money/auth'
import { Db } from '../money/db'
import { createMoneyApi } from '../money/routes'
import { attachLogDb, flush, record } from './log'
import { parseCookies, siteOf } from './cookies'
import { kindOf, publicHost, splitShared } from '../share/read'

// The dev tools: only the owner gets in, the extension's token can set sessions and nothing
// else, logs from browsers are kept, and the link reader's helpers read links right.

let server: Server
let origin = ''
let db: Db

before(async () => {
  process.env.WAYFARER_OWNER_EMAIL = 'owner@example.test'
  db = await Db.local()
  const handle = createMoneyApi(db)
  attachLogDb(db)
  server = createServer((req, res) => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
  await new Promise<void>(r => server.listen(0, r))
  const addr = server.address()
  origin = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => resetLimits())

after(async () => {
  attachLogDb(null)
  delete process.env.WAYFARER_OWNER_EMAIL
  server.closeAllConnections()
  await new Promise(r => server.close(r))
  await db.close()
})

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; cookie?: string }> {
  const res = await fetch(`${origin}/api/money${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as T, cookie: res.headers.get('set-cookie')?.split(';')[0] }
}

async function signIn(email: string, name: string): Promise<Record<string, string>> {
  let r = await call('POST', '/auth/email', { email })
  if ((r.data as { next?: string }).next === 'name') r = await call('POST', '/auth/email', { email, name })
  const v = await call('POST', '/auth/verify', { email, code: lastCode(email) })
  assert.ok(v.cookie, 'signed in')
  return { Cookie: v.cookie! }
}

describe('dev tools access', () => {
  it('belongs to one account by id: the owner keeps it after moving address, and whoever takes the old one gets nothing', async () => {
    const owner = await signIn('owner@example.test', 'Owner')
    assert.equal((await call<{ admin: boolean }>('GET', '/dev/me', undefined, owner)).data.admin, true)
    const moved = 'owner-moved@example.test'
    assert.equal((await call<{ next: string }>('POST', '/auth/secure', { email: moved }, owner)).data.next, 'code')
    assert.equal((await call('POST', '/auth/secure', { email: moved, code: lastCode(moved) }, owner)).status, 200)
    assert.equal((await call<{ admin: boolean }>('GET', '/dev/me', undefined, owner)).data.admin, true, 'pinned by id')
    const taker = await signIn('owner@example.test', 'Taker')
    assert.equal((await call<{ admin: boolean }>('GET', '/dev/me', undefined, taker)).data.admin, false)
    assert.equal((await call('GET', '/dev/activity', undefined, taker)).status, 403)
    // and back, so the rest of the tests have their owner where they expect
    assert.equal((await call('POST', '/auth/secure', { email: 'taker@example.test' }, taker)).status, 200)
    await call('POST', '/auth/secure', { email: 'taker@example.test', code: lastCode('taker@example.test') }, taker)
    await call('POST', '/auth/secure', { email: 'owner@example.test' }, owner)
    assert.equal((await call('POST', '/auth/secure', { email: 'owner@example.test', code: lastCode('owner@example.test') }, owner)).status, 200)
  })

  it('lets only the owner in', async () => {
    const owner = await signIn('owner@example.test', 'Owner')
    const other = await signIn('someone@example.test', 'Someone')
    assert.equal((await call<{ admin: boolean }>('GET', '/dev/me', undefined, owner)).data.admin, true)
    assert.equal((await call<{ admin: boolean }>('GET', '/dev/me', undefined, other)).data.admin, false)
    assert.equal((await call('GET', '/dev/logs', undefined, other)).status, 403)
    assert.equal((await call('GET', '/dev/cookies', undefined, other)).status, 403)
    assert.equal((await call('GET', '/dev/logs')).status, 401)
    assert.equal((await call('GET', '/dev/logs', undefined, owner)).status, 200)
  })

  it('takes sessions from the owner or an extension token, and never gives the values back', async () => {
    const owner = await signIn('owner@example.test', 'Owner')
    const saved = await call<{ saved: { site: string; count: number }[] }>('PUT', '/dev/cookies', { site: 'www.instagram.com', cookies: 'sessionid=abc; csrftoken=def' }, owner)
    assert.deepEqual(saved.data.saved, [{ site: 'instagram.com', count: 2 }])

    assert.equal((await call('PUT', '/dev/cookies', { cookies: [{ name: 'li_at', value: 'x', domain: '.linkedin.com' }] }, { Authorization: 'Bearer wfdev_notarealtokenatallxxxxxx' })).status, 401)
    const { data: { token } } = await call<{ token: string }>('POST', '/dev/tokens', { label: 'Test Chrome' }, owner)
    const bearer = { Authorization: `Bearer ${token}` }
    const fromExt = await call<{ saved: { site: string }[] }>('PUT', '/dev/cookies', { site: 'linkedin.com', cookies: [{ name: 'li_at', value: 'x', domain: '.linkedin.com', expirationDate: Date.now() / 1000 + 86400, sameSite: 'no_restriction', secure: true }] }, bearer)
    assert.equal(fromExt.status, 200)
    // the token sets sessions and does nothing else
    assert.equal((await call('GET', '/dev/cookies', undefined, bearer)).status, 401)

    const sites = await call<{ sites: { domain: string; signedIn: boolean; source: string }[] }>('GET', '/dev/cookies', undefined, owner)
    assert.deepEqual(sites.data.sites.map(s => [s.domain, s.signedIn, s.source]), [['instagram.com', true, 'dev tools'], ['linkedin.com', true, 'extension: Test Chrome']])
    assert.ok(!JSON.stringify(sites.data).includes('abc'), 'cookie values stay on the server')

    const tokens = await call<{ tokens: { id: string; lastUsedAt: number | null }[] }>('GET', '/dev/tokens', undefined, owner)
    assert.ok(tokens.data.tokens[0].lastUsedAt)
    await call('DELETE', `/dev/tokens/${tokens.data.tokens[0].id}`, undefined, owner)
    assert.equal((await call('PUT', '/dev/cookies', { site: 'linkedin.com', cookies: 'li_at=y' }, bearer)).status, 401)
  })
})

describe('dev logs', () => {
  it('keeps what browsers send, and the server’s own lines, newest first', async () => {
    const owner = await signIn('owner@example.test', 'Owner')
    const sent = await call('POST', '/dev/log', { entries: [{ level: 'error', message: 'TypeError: x is undefined', detail: 'at App.tsx:10', url: 'http://localhost/' }] })
    assert.equal(sent.status, 200)
    record({ at: Date.now(), level: 'warn', source: 'server', message: '[test] a server line' })
    await flush()
    const { data } = await call<{ logs: { level: string; source: string; message: string; detail: string | null }[]; last24h: Record<string, number> }>('GET', '/dev/logs?level=error,warn', undefined, owner)
    const mine = data.logs.filter(l => l.message.includes('x is undefined') || l.message.includes('a server line'))
    assert.deepEqual(mine.map(l => [l.source, l.level]), [['server', 'warn'], ['client', 'error']])
    assert.equal(mine[1].detail, 'at App.tsx:10')
    const found = await call<{ logs: unknown[] }>('GET', '/dev/logs?q=x%20is%20undefined', undefined, owner)
    assert.equal(found.data.logs.length, 1)
  })

  it('refuses a malformed batch', async () => {
    assert.equal((await call('POST', '/dev/log', { entries: [{ level: 'loud', message: 'x' }] })).status, 400)
  })
})

describe('reading shared links', () => {
  it('needs someone signed in', async () => {
    assert.equal((await call('POST', '/share/read', { url: 'https://www.youtube.com/watch?v=x' })).status, 401)
  })

  it('reads a maps link without opening anything', async () => {
    const me = await signIn('someone@example.test', 'Someone')
    const { data } = await call<{ kind: string; places: { name: string; link?: string }[] }>('POST', '/share/read', { url: 'https://www.google.com/maps/place/Fuunji/@35.687,139.6966,17z' }, me)
    assert.equal(data.kind, 'maps')
    assert.equal(data.places[0].name, 'Fuunji')
    assert.ok(data.places[0].link)
  })

  it('won’t open a private address', async () => {
    const me = await signIn('someone@example.test', 'Someone')
    for (const url of ['http://localhost:8787/api/health', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://[::1]/']) {
      const r = await call<{ error: string }>('POST', '/share/read', { url }, me)
      assert.equal(r.status, 422, url)
    }
  })
})

describe('link helpers', () => {
  it('knows what kind of link it is', () => {
    const k = (u: string) => kindOf(new URL(u))
    assert.equal(k('https://www.instagram.com/reel/abc/'), 'video')
    assert.equal(k('https://www.instagram.com/someone/'), 'post')
    assert.equal(k('https://youtu.be/abc'), 'video')
    assert.equal(k('https://x.com/a/status/1'), 'post')
    assert.equal(k('https://www.linkedin.com/posts/abc'), 'post')
    assert.equal(k('https://www.google.com/search?q=cafes+lisbon'), 'search')
    assert.equal(k('https://maps.app.goo.gl/abc'), 'maps')
    assert.equal(k('https://www.timeout.com/tokyo'), 'page')
  })

  it('finds the link in shared text', () => {
    assert.deepEqual(splitShared('Look at this! https://www.instagram.com/reel/abc/?igsh=x.'), { url: 'https://www.instagram.com/reel/abc/?igsh=x', words: 'Look at this!' })
    assert.equal(splitShared('no link here'), null)
  })

  it('reads every cookie format', () => {
    assert.equal(siteOf('www.instagram.com'), 'instagram.com')
    assert.equal(siteOf('.bbc.co.uk'), 'bbc.co.uk')
    const chrome = parseCookies([{ name: 'sessionid', value: 'v', domain: '.instagram.com', path: '/', expirationDate: 2e9, httpOnly: true, secure: true, sameSite: 'no_restriction' }])
    assert.deepEqual(chrome[0], { name: 'sessionid', value: 'v', domain: '.instagram.com', path: '/', expires: 2e9, httpOnly: true, secure: true, sameSite: 'None' })
    const header = parseCookies('Cookie: a=1; b=2=3', 'x.com')
    assert.deepEqual(header.map(c => [c.name, c.value, c.domain, c.expires]), [['a', '1', '.x.com', -1], ['b', '2=3', '.x.com', -1]])
    const txt = parseCookies('# Netscape HTTP Cookie File\n.linkedin.com\tTRUE\t/\tTRUE\t2000000000\tli_at\tAQE\n#HttpOnly_.linkedin.com\tTRUE\t/\tTRUE\t0\tJSESSIONID\tajax')
    assert.deepEqual(txt.map(c => [c.name, c.httpOnly, c.expires]), [['li_at', false, 2000000000], ['JSESSIONID', true, -1]])
    assert.throws(() => parseCookies('a=1'), /which site/)
  })

  it('sees private addresses for what they are', async () => {
    assert.equal(await publicHost('127.0.0.1'), false)
    assert.equal(await publicHost('192.168.1.10'), false)
    assert.equal(await publicHost('localhost'), false)
    assert.equal(await publicHost('8.8.8.8'), true)
  })
})
