import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { UserRow } from '../money/auth'
import { clientIp, overLimit } from '../money/auth'
import type { Db } from '../money/db'
import { HttpError } from '../money/store'
import { brainEnabled } from '../claude'
import { openaiEnabled } from '../openai'
import { chromiumPath } from '../share/browser'
import { ShareError, readShare } from '../share/read'
import { listCookieSites, parseCookies, saveCookies } from './cookies'
import { clip, flush, record, type Level } from './log'

// The dev tools' API, under /api/money/dev (where the sign-in cookie goes), and the share
// reader's. Only the people in WAYFARER_DEV_EMAILS get the dev tools; the extension signs
// in with a token made in them instead.

interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; user: UserRow | null }

const PRODUCTION = process.env.NODE_ENV === 'production'
// Whose dev tools these are. In dev with nothing set, anyone signed in, so it can be tried out.
const DEFAULT_ADMINS = ['drishandutt9@gmail.com']
const admins = () => (process.env.WAYFARER_DEV_EMAILS ?? DEFAULT_ADMINS.join(',')).split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
export const isDevAdmin = (u: UserRow | null) => Boolean(u && (admins().includes(u.email) || (!PRODUCTION && !process.env.WAYFARER_DEV_EMAILS)))

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex')

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
const clientLog = z.object({
  level: z.enum(LEVELS),
  message: z.string().max(5000),
  detail: z.string().max(20_000).nullish(),
  url: z.string().max(1000).nullish(),
  at: z.number().int().optional(),
})

export function registerDevRoutes(
  db: Db,
  route: (method: string, path: string, handler: (c: Ctx) => unknown) => void,
  readBody: <T>(req: IncomingMessage, schema: z.ZodType<T>, limit?: number) => Promise<T>,
  needUser: (c: Ctx) => UserRow,
) {
  const needAdmin = (c: Ctx): UserRow => {
    const user = needUser(c)
    if (!isDevAdmin(user)) throw new HttpError(403, 'The dev tools are only for the app’s owner')
    return user
  }
  // the dev tools' own sign-in, or an extension token
  const needAdminOrToken = async (c: Ctx): Promise<string> => {
    const bearer = c.req.headers.authorization?.match(/^Bearer\s+(wfdev_[A-Za-z0-9_-]{20,})$/)?.[1]
    if (bearer) {
      const row = await db.one<{ id: string; label: string }>('SELECT id, label FROM dev_tokens WHERE token_hash = ?', tokenHash(bearer))
      if (!row) throw new HttpError(401, 'That token isn’t recognised. Make a new one in the dev tools.')
      await db.run('UPDATE dev_tokens SET last_used_at = ? WHERE id = ?', Date.now(), row.id)
      return `extension: ${row.label}`
    }
    needAdmin(c)
    return 'dev tools'
  }

  // ── reading a shared link (everyone signed in) ──
  route('POST', '/share/read', async c => {
    const user = needUser(c)
    if (overLimit(`share:${user.id}`, 40, 3_600_000)) throw new HttpError(429, 'That’s a lot of links in a short while. Try again in a bit.')
    const body = await readBody(c.req, z.object({ url: z.string().trim().min(1).max(2000), text: z.string().max(2000).optional() }))
    try {
      const { debug: _, ...read } = await readShare(db, body.url, body.text ?? '')
      console.info(`[share] ${read.site} ${read.kind}: ${read.places.length} place${read.places.length === 1 ? '' : 's'}${read.needsLogin ? ' (login wall)' : ''}`)
      return read
    } catch (err) {
      if (err instanceof ShareError) throw new HttpError(422, err.message)
      throw err
    }
  })

  // ── logs ──
  route('POST', '/dev/log', async c => {
    if (overLimit(`devlog:${clientIp(c.req)}`, 600, 3_600_000)) return { ok: false }
    const body = await readBody(c.req, z.object({ entries: z.array(clientLog).min(1).max(50) }), 256 * 1024)
    const agent = c.req.headers['user-agent'] ?? null
    for (const e of body.entries) {
      record({ at: Date.now(), level: e.level, source: 'client', message: clip(e.message, 2000), detail: e.detail ?? null, userId: c.user?.id ?? null, url: e.url ?? null, agent })
    }
    return { ok: true }
  })

  route('GET', '/dev/me', async c => ({ admin: isDevAdmin(c.user) }))

  route('GET', '/dev/status', async c => {
    needAdmin(c)
    return {
      browser: chromiumPath(),
      ai: brainEnabled ? 'claude' : openaiEnabled ? 'openai' : null,
      admins: process.env.WAYFARER_DEV_EMAILS ? 'WAYFARER_DEV_EMAILS' : PRODUCTION ? 'built-in list' : 'anyone signed in (dev)',
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    }
  })

  route('GET', '/dev/logs', async c => {
    needAdmin(c)
    await flush()
    const q = c.url.searchParams
    const levels = (q.get('level') ?? '').split(',').filter((l): l is Level => (LEVELS as readonly string[]).includes(l))
    const source = q.get('source')
    const text = q.get('q')?.trim()
    const before = Number(q.get('before')) || null
    const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 200))
    const where: string[] = []
    const params: (string | number)[] = []
    if (levels.length) { where.push(`level IN (${levels.map(() => '?').join(', ')})`); params.push(...levels) }
    if (source === 'server' || source === 'client') { where.push('source = ?'); params.push(source) }
    if (text) { where.push('(message ILIKE ? OR detail ILIKE ? OR url ILIKE ?)'); const like = `%${text.replace(/[%_\\]/g, m => `\\${m}`)}%`; params.push(like, like, like) }
    if (before) { where.push('id < ?'); params.push(before) }
    const rows = await db.all<{ id: number; at: number; level: string; source: string; message: string; detail: string | null; user_id: string | null; url: string | null; agent: string | null }>(
      `SELECT * FROM dev_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, limit + 1)
    const users = await db.all<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id IN (${[...new Set(rows.map(r => r.user_id).filter(Boolean))].map(() => '?').join(', ') || 'NULL'})`, ...new Set(rows.map(r => r.user_id).filter((u): u is string => Boolean(u))))
    const email = new Map(users.map(u => [u.id, u.email]))
    const counts = await db.all<{ level: string; n: number }>('SELECT level, COUNT(*)::int AS n FROM dev_logs WHERE at > ? GROUP BY level', Date.now() - 86_400_000)
    return {
      logs: rows.slice(0, limit).map(r => ({ id: Number(r.id), at: r.at, level: r.level, source: r.source, message: r.message, detail: r.detail, user: r.user_id ? email.get(r.user_id) ?? r.user_id : null, url: r.url, agent: r.agent })),
      more: rows.length > limit,
      last24h: Object.fromEntries(counts.map(x => [x.level, Number(x.n)])),
    }
  })

  route('DELETE', '/dev/logs', async c => {
    needAdmin(c)
    await db.run('DELETE FROM dev_logs')
    return { ok: true }
  })

  // ── site sessions ──
  route('GET', '/dev/cookies', async c => {
    needAdmin(c)
    return { sites: await listCookieSites(db) }
  })

  route('PUT', '/dev/cookies', async c => {
    const source = await needAdminOrToken(c)
    if (overLimit(`devcookies:${clientIp(c.req)}`, 300, 3_600_000)) throw new HttpError(429, 'Too many updates. Try again later.')
    const body = await readBody(c.req, z.object({ site: z.string().trim().max(120).optional(), cookies: z.union([z.string().max(200_000), z.array(z.unknown()).max(2000)]) }), 1024 * 1024)
    let cookies
    try {
      cookies = parseCookies(body.cookies, body.site)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    if (!cookies.length) throw new HttpError(400, 'No cookies in that')
    const saved = await saveCookies(db, cookies, source)
    console.info(`[dev] sessions updated by ${source}: ${saved.map(s => `${s.site} (${s.count})`).join(', ')}`)
    return { saved }
  })

  route('DELETE', '/dev/cookies/:site', async c => {
    needAdmin(c)
    await db.run('DELETE FROM dev_cookies WHERE domain = ?', c.params[0])
    return { ok: true }
  })

  // ── extension tokens ──
  route('GET', '/dev/tokens', async c => {
    needAdmin(c)
    return { tokens: await db.all('SELECT id, label, created_at AS "createdAt", last_used_at AS "lastUsedAt" FROM dev_tokens ORDER BY created_at DESC') }
  })

  route('POST', '/dev/tokens', async c => {
    needAdmin(c)
    const body = await readBody(c.req, z.object({ label: z.string().trim().min(1).max(60) }))
    const token = `wfdev_${randomBytes(24).toString('base64url')}`
    await db.run('INSERT INTO dev_tokens (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)', randomUUID(), tokenHash(token), body.label, Date.now())
    // shown this once; only its hash is kept
    return { token }
  })

  route('DELETE', '/dev/tokens/:id', async c => {
    needAdmin(c)
    await db.run('DELETE FROM dev_tokens WHERE id = ?', c.params[0])
    return { ok: true }
  })

  // ── trying the link reader ──
  route('POST', '/dev/read', async c => {
    needAdmin(c)
    const body = await readBody(c.req, z.object({ url: z.string().trim().min(1).max(2000) }))
    const started = Date.now()
    try {
      return { ...await readShare(db, body.url, '', { fresh: true }), ms: Date.now() - started }
    } catch (err) {
      if (err instanceof ShareError) throw new HttpError(422, err.message)
      throw err
    }
  })
}
