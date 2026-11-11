import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import type { Account } from '../../src/money/types'
import type { Db } from './db'
import { track } from '../dev/activity'

// Accounts. Your email is your account, and proving it is required: every sign-up and sign-in
// sends a six-digit code to the address (`issueCode`, ../mail.ts), and only the right code
// (`useCode`) makes an account or a session. A password, if someone adds one, is asked for as
// well. Sessions of an account whose address was never confirmed open nothing.

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>
const COOKIE = 'wf_session'
const SESSION_MS = 365 * 86_400_000
const N = 16384, R = 8, P = 1, KEYLEN = 32

export interface UserRow { id: string; name: string; email: string; password_hash: string | null; pay_handle: string | null; created_at: number; email_verified_at: number | null; alert_email?: boolean }

export const toAccount = (u: UserRow): Account => ({ id: u.id, name: u.name, email: u.email, hasPassword: Boolean(u.password_hash), payHandle: u.pay_handle, createdAt: Number(u.created_at), alertEmail: u.alert_email !== false })

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, n, r, p, salt, key] = stored.split('$')
  const expected = Buffer.from(key, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 })
  return timingSafeEqual(actual, expected)
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

function readCookie(req: IncomingMessage, name = COOKIE): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
}

// Secure only when the request really came over https: a phone testing over
// plain http on the LAN would never send a Secure cookie back.
const isHttps = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https'
// The whole API sees who's signed in (finding places, cities, the assistant), not only the
// money API, where sessions used to be scoped. `wf_scope` marks a browser already moved over.
const SCOPE = 'wf_scope'
const cookieAttrs = (req: IncomingMessage, path = '/api') => `Path=${path}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`
const sessionCookies = (req: IncomingMessage, token: string) => [
  `${COOKIE}=${token}; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs(req)}`,
  `${COOKIE}=; Max-Age=0; ${cookieAttrs(req, '/api/money')}`,
  `${SCOPE}=api; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs(req)}`,
]

export async function startSession(db: Db, req: IncomingMessage, res: ServerResponse, userId: string) {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash(token), userId, now, now + SESSION_MS)
  res.setHeader('Set-Cookie', sessionCookies(req, token))
}

export async function endSession(db: Db, req: IncomingMessage, res: ServerResponse) {
  const token = readCookie(req)
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token))
  res.setHeader('Set-Cookie', [`${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`, `${COOKIE}=; Max-Age=0; ${cookieAttrs(req, '/api/money')}`, `${SCOPE}=; Max-Age=0; ${cookieAttrs(req)}`])
}

// A session from before the move, signed in under /api/money only: the same token is set
// again for the whole API, once. Call with a request whose session checked out.
export function widenSession(req: IncomingMessage, res: ServerResponse) {
  const token = readCookie(req)
  if (!token || readCookie(req, SCOPE) || res.headersSent) return
  res.setHeader('Set-Cookie', sessionCookies(req, token))
}

export async function currentUser(db: Db, req: IncomingMessage): Promise<UserRow | null> {
  const token = readCookie(req)
  if (!token) return null
  return await db.one<UserRow>(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.email_verified_at IS NOT NULL',
    tokenHash(token), Date.now(),
  ) ?? null
}

// ── email codes ───────────────────────────────────────────────────────────────

export const CODE_MS = 10 * 60_000
export const RESEND_MS = 30_000
const MAX_ATTEMPTS = 5

export type CodePurpose = 'signin' | 'signup' | 'change'

const codeHash = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex')

export class CodeError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

interface CodeRow { id: string; email: string; purpose: CodePurpose; user_id: string | null; name: string | null; code_hash: string; attempts: number; created_at: number; expires_at: number; used_at: number | null }

// A new code for an address, or null when one was sent moments ago and is still good (they
// should use that one). The caller emails it.
export async function issueCode(db: Db, o: { email: string; purpose: CodePurpose; userId?: string | null; name?: string | null; ip?: string | null }): Promise<{ code: string; id: string } | { wait: number }> {
  const now = Date.now()
  const last = await db.one<CodeRow>('SELECT * FROM email_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', o.email)
  if (last && last.purpose === o.purpose && last.user_id === (o.userId ?? null) && now - last.created_at < RESEND_MS && last.expires_at > now && last.attempts < MAX_ATTEMPTS) {
    // a new account's name can still be corrected while the code is on its way
    if (o.name && o.name !== last.name) await db.run('UPDATE email_codes SET name = ? WHERE id = ?', o.name, last.id)
    return { wait: Math.ceil((RESEND_MS - (now - last.created_at)) / 1000) }
  }
  const id = randomUUID()
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  // only the newest code for an address works
  await db.run('UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL', now, o.email)
  await db.run('INSERT INTO email_codes (id, email, purpose, user_id, name, code_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, o.email, o.purpose, o.userId ?? null, o.name ?? null, codeHash(id, code), now, now + CODE_MS, o.ip ?? null)
  // now and then, forget old ones
  if (randomInt(0, 50) === 0) await db.run('DELETE FROM email_codes WHERE created_at < ?', now - 7 * 86_400_000)
  return { code, id }
}

// Checks a code without using it up (a wrong password after the right code can be tried again).
// Wrong codes count against it; after five it's spent.
export async function checkCode(db: Db, email: string, code: string, purpose: CodePurpose[], userId?: string): Promise<CodeRow> {
  const row = await db.one<CodeRow>('SELECT * FROM email_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', email)
  if (!row || !purpose.includes(row.purpose) || (userId !== undefined && row.user_id !== userId)) throw new CodeError('Ask for a new code: there isn’t one waiting for this address.')
  if (row.expires_at < Date.now()) throw new CodeError('That code has expired. Ask for a new one.')
  if (row.attempts >= MAX_ATTEMPTS) throw new CodeError('Too many wrong codes. Ask for a new one.', 429)
  const given = Buffer.from(codeHash(row.id, code.replace(/\D/g, '')), 'hex')
  if (!timingSafeEqual(given, Buffer.from(row.code_hash, 'hex'))) {
    await db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', row.id)
    const left = MAX_ATTEMPTS - row.attempts - 1
    throw new CodeError(left > 0 ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code isn’t right, and it’s used up. Ask for a new one.', 401)
  }
  return row
}

export const spendCode = (db: Db, id: string) => db.run('UPDATE email_codes SET used_at = ? WHERE id = ?', Date.now(), id)

// Slows down password guessing and invite-link scraping. In memory, because one server
// runs this app and a restart forgetting the counts does no harm.
const buckets = new Map<string, { n: number; reset: number }>()

export function overLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k)
  const b = buckets.get(key)
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return false }
  b.n++
  // once per window, the moment it trips: who or what is pushing (the key says: "login-ip:1.2.3.4")
  if (b.n === max + 1) track('security.rate_limit', { subject: key.split(':')[0], detail: { key: key.slice(0, 200), max, windowMinutes: Math.round(windowMs / 60_000) } })
  return b.n > max
}

export const clearLimit = (key: string) => { buckets.delete(key) }
export const resetLimits = () => buckets.clear()

// Behind Railway's proxy the socket address is the proxy itself.
export const clientIp = (req: IncomingMessage) =>
  (process.env.NODE_ENV === 'production' ? req.headers['x-real-ip'] as string : undefined) ?? req.socket.remoteAddress ?? 'unknown'
