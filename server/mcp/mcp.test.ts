import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Db } from '../money/db'
import { createMoneyApi } from '../money/routes'
import { resetLimits } from '../money/auth'
import { signInVia } from '../money/signInForTests'
import { oauthAndMcp } from './http'

// Wayfarer as an MCP server: an app signs a person in with OAuth (PKCE), and then every tool
// acts as them, on the trip they chose, with the app's own rules.

let server: Server
let origin = ''
let db: Db

before(async () => {
  db = await Db.local()
  const money = createMoneyApi(db)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/api/money/')) return void money(req, res, url)
    return void oauthAndMcp(db, req, res, url).catch(err => { console.error(err); res.writeHead(500); res.end() })
  })
  await new Promise<void>(r => server.listen(0, r))
  origin = `http://localhost:${(server.address() as { port: number }).port}`
  process.env.WAYFARER_PUBLIC_URL = origin
})
beforeEach(() => resetLimits())
after(async () => {
  delete process.env.WAYFARER_PUBLIC_URL
  server.closeAllConnections()
  await new Promise(r => server.close(r))
  await db.close()
})

// A browser: keeps its sign-in cookie.
class Browser {
  cookie = ''
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${origin}/api/money${path}`, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.getSetCookie()
    if (set.length) this.cookie = set.filter(c => !/Max-Age=0/.test(c)).map(c => c.split(';')[0]).join('; ') || this.cookie
    const text = await res.text()
    return { status: res.status, data: text ? JSON.parse(text) : {} }
  }
}

const REDIRECT = 'http://localhost:9999/callback'

// The whole OAuth dance an MCP client does, for a signed-in browser. Returns the tokens.
async function connect(browser: Browser, name = 'Claude') {
  const reg = await fetch(`${origin}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) })
  assert.equal(reg.status, 201)
  const client = await reg.json() as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'trips' })
  const page = await (await fetch(`${origin}/api/oauth/authorize?${q}`, { headers: { Cookie: browser.cookie } })).text()
  const consent = page.match(/name="consent" value="([^"]+)"/)?.[1]
  assert.ok(consent, 'the consent form')
  const allowed = await fetch(`${origin}/api/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: browser.cookie }, body: new URLSearchParams({ consent, decision: 'allow' }) })
  assert.equal(allowed.status, 302)
  const back = new URL(allowed.headers.get('location')!)
  assert.equal(back.origin + back.pathname, REDIRECT)
  assert.equal(back.searchParams.get('state'), 'xyz')
  const code = back.searchParams.get('code')!
  const tok = await fetch(`${origin}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })
  assert.equal(tok.status, 200)
  return { ...(await tok.json() as { access_token: string; refresh_token: string; expires_in: number }), clientId: client.client_id, code, verifier }
}

async function mcp(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean }
    return { text: r.content.map(c => c.text).join('\n'), error: Boolean(r.isError) }
  }
  return { client, call }
}

const signedIn = async (email: string, name: string) => {
  const b = new Browser()
  await signInVia((m, p, body) => b.call(m, p, body), email, name)
  return b
}

describe('signing an app in', () => {
  it('publishes where to sign in, for the MCP endpoint', async () => {
    const pr = await (await fetch(`${origin}/.well-known/oauth-protected-resource/api/mcp`)).json() as { resource: string; authorization_servers: string[] }
    assert.equal(pr.resource, `${origin}/api/mcp`)
    const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as { token_endpoint: string; code_challenge_methods_supported: string[] }
    assert.equal(as.token_endpoint, `${origin}/api/oauth/token`)
    assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
    const none = await fetch(`${origin}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(none.status, 401)
    assert.match(none.headers.get('www-authenticate')!, /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/api\/mcp"/)
  })

  it('refuses redirects that aren’t https or this computer, and shows sign-in to someone signed out', async () => {
    const bad = await fetch(`${origin}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) })
    assert.equal(bad.status, 400)
    const reg = await (await fetch(`${origin}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'X', redirect_uris: [REDIRECT] }) })).json() as { client_id: string }
    const q = (o: Record<string, string>) => new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', ...o })
    const elsewhere = await fetch(`${origin}/api/oauth/authorize?${q({ redirect_uri: 'https://evil.example/cb' })}`)
    assert.equal(elsewhere.status, 400, 'never sent to a redirect it didn’t register')
    const signedOut = await (await fetch(`${origin}/api/oauth/authorize?${q({})}`)).text()
    assert.match(signedOut, /Sign in to Wayfarer/)
    const noPkce = await fetch(`${origin}/api/oauth/authorize?${q({ code_challenge_method: 'plain' })}`, { redirect: 'manual' })
    assert.equal(noPkce.status, 302)
    assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request')
  })

  it('gives tokens for the code once, rotates refresh tokens, and cuts the app off if an old one comes back', async () => {
    const b = await signedIn('oauth@example.test', 'Oauth')
    const t = await connect(b)
    const again = await fetch(`${origin}/api/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: t.code, client_id: t.clientId, redirect_uri: REDIRECT, code_verifier: t.verifier }) })
    assert.equal(again.status, 400)
    assert.equal((await mcp(t.access_token).catch(() => null)), null, 'a reused code revokes what it made')

    const fresh = await connect(b)
    const r1 = await fetch(`${origin}/api/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: fresh.clientId }) })
    const next = await r1.json() as { access_token: string; refresh_token: string }
    assert.ok(next.access_token && next.refresh_token !== fresh.refresh_token)
    const { call } = await mcp(next.access_token)
    assert.match((await call('list_trips')).text, /No trips yet/)
    const reused = await fetch(`${origin}/api/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: fresh.clientId }) })
    assert.equal(reused.status, 400)
    await assert.rejects(mcp(next.access_token), 'the whole app is cut off')
  })

  it('lists connected apps for the person, and disconnecting one stops it', async () => {
    const b = await signedIn('apps@example.test', 'Apps')
    const t = await connect(b, 'Claude')
    const list = await b.call('GET', '/auth/connections')
    assert.equal(list.data.connections[0].name, 'Claude')
    assert.equal(list.data.mcpUrl, `${origin}/api/mcp`)
    assert.equal((await b.call('DELETE', `/auth/connections/${t.clientId}`)).status, 200)
    await assert.rejects(mcp(t.access_token))
  })
})

describe('the tools', () => {
  it('starts by asking which trip, then plans, edits, splits costs and chats as the person', async () => {
    const owner = await signedIn('planner@example.test', 'Asha')
    const t = await connect(owner)
    const { client, call } = await mcp(t.access_token)
    assert.match(client.getInstructions() ?? '', /call list_trips/)
    const names = (await client.listTools()).tools.map(x => x.name)
    for (const n of ['list_trips', 'choose_trip', 'get_itinerary', 'add_places', 'travel_needs', 'save_booking', 'money_summary', 'add_expense', 'create_trip']) assert.ok(names.includes(n), n)
    assert.deepEqual((await client.listPrompts()).prompts.map(p => p.name).sort(), ['analyse_spending', 'find_flights_and_hotels', 'research_places'])

    const before = await call('get_itinerary')
    assert.ok(before.error)
    assert.match(before.text, /No trip chosen yet/)

    const made = await call('create_trip', { city: 'Tokyo', days: 2, travelers: 2, vibes: ['food'], start_date: '2026-12-01' })
    assert.ok(!made.error, made.text)
    assert.match(made.text, /Day 1/)
    const tripId = made.text.match(/\[([0-9a-f-]{36})\]/)![1]
    assert.match((await call('list_trips')).text, new RegExp(tripId))
    assert.match((await call('travel_needs')).text, /arrive 2026-12-01, leave 2026-12-03 \(2 nights\)/)

    const itin = (await call('get_itinerary')).text
    const firstStop = itin.match(/\[(tk-[a-z-]+)\]/)![1]
    const v0 = (await db.one<{ plan_version: number }>('SELECT plan_version FROM money_groups WHERE id = ?', tripId))!.plan_version
    assert.match((await call('remove_stop', { place_id: firstStop })).text, /Removed|only stop/)
    assert.match((await call('change_trip', { instruction: 'add a day' })).text, /day/i)
    const after = (await db.one<{ plan: string; plan_version: number }>('SELECT plan, plan_version FROM money_groups WHERE id = ?', tripId))!
    assert.ok(after.plan_version > v0, 'published as a new version, live for everyone')
    assert.equal(JSON.parse(after.plan).days.length, 3)
    assert.match((await call('undo')).text, /./)
    assert.equal(JSON.parse((await db.one<{ plan: string }>('SELECT plan FROM money_groups WHERE id = ?', tripId))!.plan).days.length, 2)

    assert.match((await call('search_places', { query: 'sushi' })).text, /sushi/i)
    assert.match((await call('add_expense', { title: 'Sushi dinner', amount: 12000, currency: 'JPY' })).text, /Logged “Sushi dinner”/)
    const summary = (await call('money_summary')).text
    assert.match(summary, /1 expenses/)
    assert.match((await call('list_expenses', { query: 'sushi' })).text, /Sushi dinner/)
    assert.match((await call('save_booking', { kind: 'flight', title: 'BA 7 London to Tokyo', date: '2026-12-01' })).text, /Saved/)
    assert.match((await call('read_chat')).text, /Booked: BA 7 London to Tokyo/)
    assert.match((await call('invite_person', { email: 'ben@example.test' })).text, /Added ben@example.test/)

    // a member sees it all but can't change the plan; a stranger can't open it
    const ben = await signedIn('ben@example.test', 'Ben')
    const benTools = await mcp((await connect(ben)).access_token)
    assert.match((await benTools.call('list_trips')).text, new RegExp(tripId))
    assert.ok(!(await benTools.call('choose_trip', { trip_id: tripId })).error)
    const refused = await benTools.call('add_stop', { place_id: firstStop, day: 1 })
    assert.ok(refused.error)
    assert.match(refused.text, /Only the trip’s admin/)
    assert.ok(!(await benTools.call('post_note', { text: 'Can’t wait!' })).error)
    const stranger = await mcp((await connect(await signedIn('stranger@example.test', 'Stranger'))).access_token)
    const no = await stranger.call('choose_trip', { trip_id: tripId })
    assert.ok(no.error)
    assert.match(no.text, /isn’t available to you/)
    await client.close()
  })
})
