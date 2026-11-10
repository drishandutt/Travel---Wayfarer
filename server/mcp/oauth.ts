import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from '../money/db'
import { clientIp, currentUser, overLimit, type UserRow } from '../money/auth'
import { track } from '../dev/activity'

// Signing apps in to Wayfarer on a person's behalf: OAuth 2.1 with PKCE, the way MCP clients
// (Claude, Claude Code, others) connect to a remote MCP server.
//
//   GET  /.well-known/oauth-protected-resource[/api/mcp]   which server issues tokens for /api/mcp
//   GET  /.well-known/oauth-authorization-server           the endpoints below
//   POST /api/oauth/register    a client registers itself (dynamic client registration)
//   GET  /api/oauth/authorize   the person signs in (an emailed code, as in the app) and allows it
//   POST /api/oauth/token       a code (with its PKCE verifier) or a refresh token → tokens
//   POST /api/oauth/revoke      a client gives a token back
//
// Tokens are random and kept only as hashes: access tokens last an hour, refresh tokens 60 days
// and are replaced each time they're used. A person sees and cuts off connected apps from their
// account (`connections`, `disconnect`). Under /api, so the app's sign-in cookie reaches the
// authorize page.

const SCOPE = 'trips'
const ACCESS_MS = 3_600_000
const REFRESH_MS = 60 * 86_400_000
const CODE_MS = 5 * 60_000
const CONSENT_MS = 10 * 60_000

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

// Where this server is reached from outside: WAYFARER_PUBLIC_URL, or the request's own host.
export function publicBase(req: IncomingMessage): string {
  if (process.env.WAYFARER_PUBLIC_URL) return process.env.WAYFARER_PUBLIC_URL.replace(/\/+$/, '')
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http'
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`
}
export const mcpUrl = (req: IncomingMessage) => `${publicBase(req)}/api/mcp`

export function protectedResource(req: IncomingMessage) {
  const base = publicBase(req)
  return { resource: `${base}/api/mcp`, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Wayfarer' }
}

export function authorizationServer(req: IncomingMessage) {
  const base = publicBase(req)
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    service_documentation: `${base}/`,
  }
}

// ── clients ──────────────────────────────────────────────────────────────────

interface ClientRow { id: string; name: string; redirect_uris: string; created_at: number }

// https anywhere, or http only back to this computer (Claude Code and other local apps).
export function goodRedirect(uri: string): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
}

export async function registerClient(db: Db, req: IncomingMessage, body: Record<string, unknown>) {
  if (overLimit(`oauth-register:${clientIp(req)}`, 30, 3_600_000)) throw new OAuthError('invalid_client_metadata', 'Too many registrations from here. Try again later.', 429)
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (!uris.length || uris.length > 10 || uris.some(u => u.length > 500 || !goodRedirect(u))) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must be https, or http back to this computer.')
  const name = (typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'An app').slice(0, 80)
  const id = `wfc_${randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  await db.run('INSERT INTO oauth_clients (id, name, redirect_uris, created_at, ip) VALUES (?, ?, ?, ?, ?)', id, name, JSON.stringify(uris), now, clientIp(req))
  track('oauth.client_registered', { ip: clientIp(req), subject: id, detail: { name, redirects: uris.map(u => new URL(u).host) } })
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  }
}

async function clientOf(db: Db, id: string | null): Promise<ClientRow | undefined> {
  if (!id) return undefined
  return db.one<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id)
}

// ── the authorize page ───────────────────────────────────────────────────────

interface AuthorizeAsk { clientId: string; redirectUri: string; challenge: string; state: string | null; scope: string }

// What the client asked for, checked. A bad client or redirect is shown on the page (never
// sent anywhere); anything else wrong goes back to the client as an error.
async function readAsk(db: Db, q: URLSearchParams): Promise<{ ask: AuthorizeAsk; client: ClientRow } | { page: string } | { redirect: string }> {
  const client = await clientOf(db, q.get('client_id'))
  const redirectUri = q.get('redirect_uri') ?? ''
  if (!client) return { page: 'This app isn’t registered with Wayfarer. Try connecting it again.' }
  const allowed = JSON.parse(client.redirect_uris) as string[]
  if (!allowed.includes(redirectUri)) return { page: 'This app asked to come back somewhere it didn’t register. Try connecting it again.' }
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri)
    u.searchParams.set('error', error)
    u.searchParams.set('error_description', description)
    if (q.get('state')) u.searchParams.set('state', q.get('state')!)
    return { redirect: u.toString() }
  }
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'Only the code flow is supported.')
  const challenge = q.get('code_challenge') ?? ''
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request', 'PKCE with S256 is required.')
  const scopes = (q.get('scope') ?? SCOPE).split(/\s+/).filter(Boolean)
  if (scopes.some(s => s !== SCOPE)) return back('invalid_scope', `The only scope is “${SCOPE}”.`)
  return { ask: { clientId: client.id, redirectUri, challenge, state: q.get('state'), scope: SCOPE }, client }
}

// A consent form's one-time key, tied to who saw it and what it asks for.
const consents = new Map<string, { ask: AuthorizeAsk; userId: string; until: number }>()

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function page(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
  })
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Wayfarer</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#6e6e73;--line:#d2d2d7;--accent:#ffd23f;--bad:#d70015}
@media (prefers-color-scheme:dark){:root{--bg:#1d1d1f;--card:#2c2c2e;--ink:#f5f5f7;--dim:#a1a1a6;--line:#3a3a3c;--bad:#ff6961}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,Segoe UI,Helvetica,Arial,sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border:2px solid var(--ink);border-radius:20px;padding:24px;box-shadow:6px 6px 0 var(--ink)}
h1{margin:0 0 8px;font-size:22px}p{margin:8px 0;color:var(--dim)}ul{margin:8px 0 16px;padding-left:20px}li{margin:4px 0}
label{display:block;margin:12px 0 4px;font-size:13px;color:var(--dim)}input{width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
.code{font-size:22px;letter-spacing:.35em;text-align:center}
button{width:100%;margin-top:14px;padding:12px;border-radius:999px;border:2px solid var(--ink);background:var(--accent);color:#1d1d1f;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}.bad{color:var(--bad)}.who{font-weight:600;color:var(--ink)}
</style></head><body><main class="card">${body}</main></body></html>`)
}

const signInScript = `
<form id="f"><h1>Sign in to Wayfarer</h1><p id="lede">to connect it to the app that sent you here.</p>
<div id="e"><label for="email">Email</label><input id="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
<div id="n" hidden><label for="name">Your name</label><input id="name" autocomplete="given-name"></div>
<div id="c" hidden><label for="code">Code from your email</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>
<div id="p" hidden><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"></div>
<p id="err" class="bad" role="alert"></p><button id="go">Continue</button></form>
<script>
const $=id=>document.getElementById(id);let step='email';
async function call(path,body){const r=await fetch('/api/money/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Something went wrong');return d}
$('f').onsubmit=async ev=>{ev.preventDefault();$('err').textContent='';$('go').disabled=true;const email=$('email').value.trim();
try{if(step==='email'||step==='name'){const d=await call('email',step==='name'?{email,name:$('name').value.trim()}:{email});
if(d.next==='name'){step='name';$('n').hidden=false;$('name').focus()}else{step='code';$('e').hidden=true;$('n').hidden=true;$('c').hidden=false;$('p').hidden=!d.password;$('lede').textContent='We sent a 6-digit code to '+email+'.';$('code').focus();$('go').textContent='Sign in'}}
else{const d=await call('verify',{email,code:$('code').value.trim(),...($('pw').value?{password:$('pw').value}:{})});if(d.next==='password'){$('p').hidden=false;$('pw').focus()}else location.reload()}}
catch(e){$('err').textContent=e.message}finally{$('go').disabled=false}};
</script>`

export async function authorizePage(db: Db, req: IncomingMessage, res: ServerResponse, url: URL) {
  const read = await readAsk(db, url.searchParams)
  if ('page' in read) return page(res, 400, 'Can’t connect', `<h1>Can’t connect</h1><p>${esc(read.page)}</p>`)
  if ('redirect' in read) { res.writeHead(302, { Location: read.redirect }); res.end(); return }
  const user = await currentUser(db, req)
  if (!user) return page(res, 200, 'Sign in', signInScript)
  const key = randomBytes(24).toString('base64url')
  const now = Date.now()
  for (const [k, v] of consents) if (v.until < now) consents.delete(k)
  consents.set(key, { ask: read.ask, userId: user.id, until: now + CONSENT_MS })
  const host = new URL(read.ask.redirectUri).host
  page(res, 200, 'Allow access', `<h1>Allow ${esc(read.client.name)}?</h1>
<p>It will use Wayfarer as <span class="who">${esc(user.email)}</span> (returning to ${esc(host)}), and can:</p>
<ul><li>see your trips, plans, places and the people in them</li><li>change the plans of trips you run, and add places</li><li>see and add shared expenses, and post in trip chats</li><li>invite people to your trips</li></ul>
<p>It can’t see your password or other apps, and you can disconnect it any time from your account in Wayfarer.</p>
<form method="post" action="/api/oauth/authorize"><input type="hidden" name="consent" value="${key}">
<button name="decision" value="allow">Allow</button><button class="ghost" name="decision" value="deny">Don’t allow</button></form>`)
}

// The consent form: allow gives the app a one-time code, back at its redirect.
export async function authorizeDecision(db: Db, req: IncomingMessage, res: ServerResponse, form: URLSearchParams) {
  const held = consents.get(form.get('consent') ?? '')
  consents.delete(form.get('consent') ?? '')
  const user = await currentUser(db, req)
  if (!held || held.until < Date.now() || !user || user.id !== held.userId) return page(res, 400, 'Try again', '<h1>That took too long</h1><p>Go back to the app and connect again.</p>')
  const { ask } = held
  const back = new URL(ask.redirectUri)
  if (ask.state) back.searchParams.set('state', ask.state)
  if (form.get('decision') !== 'allow') {
    back.searchParams.set('error', 'access_denied')
    track('oauth.denied', { userId: user.id, subject: ask.clientId })
  } else {
    const code = token('wfcode')
    await db.run('INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      hash(code), ask.clientId, user.id, ask.redirectUri, ask.challenge, ask.scope, Date.now() + CODE_MS)
    back.searchParams.set('code', code)
    back.searchParams.set('iss', publicBase(req))
    track('oauth.allowed', { userId: user.id, subject: ask.clientId })
  }
  res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' })
  res.end()
}

// ── tokens ───────────────────────────────────────────────────────────────────

async function issue(db: Db, clientId: string, userId: string, scope: string, replacing?: string) {
  const access = token('wfat')
  const refresh = token('wfrt')
  const id = randomUUID()
  const now = Date.now()
  await db.tx(async () => {
    if (replacing) await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?', now, replacing)
    await db.run('INSERT INTO oauth_tokens (id, client_id, user_id, access_hash, access_expires, refresh_hash, refresh_expires, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, clientId, userId, hash(access), now + ACCESS_MS, hash(refresh), now + REFRESH_MS, scope, now)
  })
  return { id, body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope } }
}

const verifierOk = (verifier: string, challenge: string) =>
  /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && createHash('sha256').update(verifier).digest('base64url') === challenge

export async function tokenEndpoint(db: Db, req: IncomingMessage, form: URLSearchParams) {
  if (overLimit(`oauth-token:${clientIp(req)}`, 120, 3_600_000)) throw new OAuthError('invalid_request', 'Too many requests. Try again later.', 429)
  const grant = form.get('grant_type')
  const clientId = form.get('client_id') ?? ''
  if (grant === 'authorization_code') {
    const code = form.get('code') ?? ''
    const row = await db.one<{ code_hash: string; client_id: string; user_id: string; redirect_uri: string; challenge: string; scope: string; expires_at: number; used_at: number | null; token_id: string | null }>('SELECT * FROM oauth_codes WHERE code_hash = ?', hash(code))
    if (!row || row.client_id !== clientId) throw new OAuthError('invalid_grant', 'That code isn’t valid.')
    if (row.used_at) {
      // a code used twice: whoever has it isn't to be trusted with what it made
      if (row.token_id) await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), row.token_id)
      track('security.oauth_code_reused', { ip: clientIp(req), userId: row.user_id, subject: clientId })
      throw new OAuthError('invalid_grant', 'That code was already used.')
    }
    if (row.expires_at < Date.now()) throw new OAuthError('invalid_grant', 'That code has expired.')
    if (form.get('redirect_uri') && form.get('redirect_uri') !== row.redirect_uri) throw new OAuthError('invalid_grant', 'The redirect URI doesn’t match.')
    if (!verifierOk(form.get('code_verifier') ?? '', row.challenge)) throw new OAuthError('invalid_grant', 'The PKCE verifier doesn’t match.')
    const out = await issue(db, clientId, row.user_id, row.scope)
    await db.run('UPDATE oauth_codes SET used_at = ?, token_id = ? WHERE code_hash = ?', Date.now(), out.id, row.code_hash)
    track('oauth.connected', { ip: clientIp(req), userId: row.user_id, subject: clientId })
    return out.body
  }
  if (grant === 'refresh_token') {
    const row = await db.one<{ id: string; client_id: string; user_id: string; scope: string; refresh_expires: number; revoked_at: number | null }>('SELECT * FROM oauth_tokens WHERE refresh_hash = ?', hash(form.get('refresh_token') ?? ''))
    if (!row || (clientId && row.client_id !== clientId)) throw new OAuthError('invalid_grant', 'That refresh token isn’t valid.')
    if (row.revoked_at) {
      // an old refresh token coming back means it was copied: cut the app off
      await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL', Date.now(), row.user_id, row.client_id)
      track('security.oauth_refresh_reused', { ip: clientIp(req), userId: row.user_id, subject: row.client_id })
      throw new OAuthError('invalid_grant', 'That refresh token was already used.')
    }
    if (row.refresh_expires < Date.now()) throw new OAuthError('invalid_grant', 'That refresh token has expired. Connect again.')
    return (await issue(db, row.client_id, row.user_id, row.scope, row.id)).body
  }
  throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
}

export async function revokeEndpoint(db: Db, form: URLSearchParams) {
  const t = form.get('token') ?? ''
  await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE (access_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL', Date.now(), hash(t), hash(t))
}

// ── who's calling the MCP endpoint ───────────────────────────────────────────

export interface Caller { user: UserRow; clientId: string; clientName: string; tokenId: string }

export async function bearer(db: Db, req: IncomingMessage): Promise<Caller | null> {
  const t = String(req.headers.authorization ?? '').match(/^Bearer\s+(wfat_[A-Za-z0-9_-]{20,})$/)?.[1]
  if (!t) return null
  const row = await db.one<{ id: string; client_id: string; user_id: string; access_expires: number; revoked_at: number | null; last_used_at: number | null; name: string }>(
    'SELECT t.*, c.name FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE t.access_hash = ?', hash(t))
  if (!row || row.revoked_at || row.access_expires < Date.now()) return null
  const user = await db.one<UserRow>('SELECT * FROM users WHERE id = ? AND email_verified_at IS NOT NULL', row.user_id)
  if (!user) return null
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) await db.run('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?', Date.now(), row.id)
  return { user, clientId: row.client_id, clientName: row.name, tokenId: row.id }
}

export function unauthorized(req: IncomingMessage, res: ServerResponse, why = 'Sign in to Wayfarer to use this.') {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource/api/mcp", scope="${SCOPE}"`,
  })
  res.end(JSON.stringify({ error: 'invalid_token', error_description: why }))
}

// ── a person's connected apps ────────────────────────────────────────────────

export async function connections(db: Db, userId: string) {
  const rows = await db.all<{ client_id: string; name: string; first: number; last: number | null }>(
    `SELECT t.client_id, c.name, MIN(t.created_at) AS first, MAX(t.last_used_at) AS last FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
     WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.refresh_expires > ? GROUP BY t.client_id, c.name ORDER BY MAX(t.created_at) DESC`, userId, Date.now())
  return rows.map(r => ({ id: r.client_id, name: r.name, connectedAt: Number(r.first), lastUsedAt: r.last ? Number(r.last) : null }))
}

export async function disconnect(db: Db, userId: string, clientId: string) {
  const r = await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL', Date.now(), userId, clientId)
  if (r.changes) track('oauth.disconnected', { userId, subject: clientId })
  return r.changes > 0
}
