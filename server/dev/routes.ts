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
import { checkOpenAIKey, openaiKeyInfo, setOpenAIKey } from '../openai'
import { isDevAdmin } from './owner'
import { mailConfigured, mailProvider } from '../mail'
import { OPENAI_KEY, setSetting, settingMeta } from './settings'
import { cleanDetail, from, parseDetail, queryActivity, track } from './activity'
import { analyse, analystEnabled, digest, listReports, pseudonym, userProfile } from './analyst'
import { ReviewError, buildFromDevTools, decideReview, hideCatalogPlace, listReviews, recentAdditions } from '../cities/store'
import { cancelImport, importJob, importJobs, startImport } from '../cities/importer'
import { MAX_ROWS, SheetError, readUpload, type ImportRow } from './sheets'
import { buildStatus } from '../cities/store'
import { CITIES } from '../../src/data/cities'

// The dev tools' API, under /api/money/dev (where the sign-in cookie goes), and the share
// reader's. Only the owner's account gets the dev tools (./owner.ts); the extension signs
// in with a token made in them instead.

interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; user: UserRow | null }

const PRODUCTION = process.env.NODE_ENV === 'production'
// Whose dev tools these are: one account, by id (./owner.ts). Nobody else, in development too.
export { isDevAdmin }

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
      owner: process.env.WAYFARER_OWNER_ID ? 'WAYFARER_OWNER_ID' : 'the first verified sign-in as the owner’s address',
      mail: mailProvider() ?? (mailConfigured() ? 'test' : PRODUCTION ? null : 'console (dev)'),
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

  // ── settings: the OpenAI key ──
  route('GET', '/dev/settings', async c => {
    needAdmin(c)
    return { openai: { ...openaiKeyInfo(), saved: await settingMeta(OPENAI_KEY) }, claude: brainEnabled, analystEvery: process.env.WAYFARER_ANALYST_HOURS ?? '6' }
  })

  // The key is checked with OpenAI before it's kept, and never sent back: only its last four.
  route('PUT', '/dev/settings/openai', async c => {
    const user = needAdmin(c)
    const body = await readBody(c.req, z.object({ key: z.string().trim().min(20).max(400).regex(/^sk-[A-Za-z0-9_-]+$/, 'That doesn’t look like an OpenAI key (they start with sk-).') }))
    const check = await checkOpenAIKey(body.key)
    if (!check.ok) throw new HttpError(422, check.error)
    await setSetting(OPENAI_KEY, body.key, user.email)
    setOpenAIKey(body.key)
    track('dev.settings.openai', { ...from(c.req, user.id), detail: { action: 'set', tail: body.key.slice(-4) } })
    return { openai: { ...openaiKeyInfo(), saved: await settingMeta(OPENAI_KEY) } }
  })

  route('DELETE', '/dev/settings/openai', async c => {
    const user = needAdmin(c)
    await setSetting(OPENAI_KEY, null, user.email)
    setOpenAIKey(null)
    track('dev.settings.openai', { ...from(c.req, user.id), detail: { action: 'removed' } })
    return { openai: { ...openaiKeyInfo(), saved: null } }
  })

  // ── activity ──
  // What people do in the app, from every browser and the iPhone app (src/dev/activity.ts).
  // Only app.* kinds: the server's own events can't be forged from outside.
  const appEvent = z.object({ kind: z.string().regex(/^app\.[a-z][a-z0-9_.-]{0,40}$/), at: z.number().int().optional(), subject: z.string().max(200).nullish(), detail: z.unknown().optional() })
  route('POST', '/dev/activity', async c => {
    if (overLimit(`activity:${clientIp(c.req)}`, 1200, 3_600_000)) return { ok: false }
    const body = await readBody(c.req, z.object({ device: z.string().max(64).optional(), events: z.array(appEvent).min(1).max(60) }), 256 * 1024)
    const who = from(c.req, c.user?.id)
    const now = Date.now()
    for (const e of body.events) {
      track(e.kind, { ...who, device: body.device ?? who.device, source: 'app', at: e.at && Math.abs(now - e.at) < 86_400_000 ? e.at : now, subject: e.subject ?? null, detail: cleanDetail(e.detail) })
    }
    return { ok: true }
  })

  route('GET', '/dev/activity', async c => {
    needAdmin(c)
    const q = c.url.searchParams
    const userText = q.get('user')?.trim()
    let userId: string | undefined
    if (userText) {
      const u = await db.one<{ id: string }>("SELECT id FROM users WHERE email = ? OR id = ? OR replace(id, '-', '') LIKE ?", userText.toLowerCase(), userText, `${userText.replace(/^u:/, '')}%`)
      if (!u) return { events: [], more: false, users: {} }
      userId = u.id
    }
    const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 200))
    const rows = await queryActivity(db, {
      kind: q.get('kind') || undefined,
      userId,
      ip: q.get('ip') || undefined,
      device: q.get('device') || undefined,
      text: q.get('q')?.trim() || undefined,
      source: q.get('source') === 'app' || q.get('source') === 'server' ? q.get('source') as 'app' | 'server' : undefined,
      since: Number(q.get('since')) || undefined,
      before: Number(q.get('before')) || undefined,
      limit: limit + 1,
    })
    const ids = [...new Set(rows.map(r => r.user_id).filter((u): u is string => Boolean(u)))]
    const users = ids.length ? await db.all<{ id: string; email: string; name: string }>(`SELECT id, email, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids) : []
    const counts = await db.all<{ family: string; n: number }>("SELECT split_part(kind, '.', 1) AS family, COUNT(*)::int AS n FROM activity_events WHERE at > ? GROUP BY 1", Date.now() - 86_400_000)
    return {
      events: rows.slice(0, limit).map(r => ({ id: r.id, at: r.at, kind: r.kind, source: r.source, user: r.user_id, device: r.device, ip: r.ip, agent: r.agent, subject: r.subject, detail: parseDetail(r) })),
      more: rows.length > limit,
      users: Object.fromEntries(users.map(u => [u.id, { email: u.email, name: u.name, alias: pseudonym(u.id) }])),
      last24h: Object.fromEntries(counts.map(x => [x.family, Number(x.n)])),
    }
  })

  // ── the analyst ──
  route('GET', '/dev/analyst/digest', async c => {
    needAdmin(c)
    const hours = Math.max(1, Math.min(720, Number(c.url.searchParams.get('hours')) || 24))
    return { digest: await digest(db, hours), ai: analystEnabled() }
  })

  route('GET', '/dev/analyst/reports', async c => {
    needAdmin(c)
    return { reports: await listReports(db, 20), users: await aliases() }
  })

  let analysing = false
  route('POST', '/dev/analyst/run', async c => {
    const user = needAdmin(c)
    const body = await readBody(c.req, z.object({ hours: z.number().int().min(1).max(720).default(24), question: z.string().trim().max(1000).optional() }))
    if (!analystEnabled()) throw new HttpError(503, 'No AI is connected: add an OpenAI key in Settings first.')
    if (analysing) throw new HttpError(409, 'The analyst is already working on one. Try again when it’s done.')
    if (overLimit(`analyst:${user.id}`, 30, 3_600_000)) throw new HttpError(429, 'That’s a lot of reports this hour.')
    analysing = true
    try {
      const report = await analyse(db, { hours: body.hours, question: body.question || undefined, kind: body.question ? 'ask' : 'manual' })
      return { report, users: await aliases() }
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(502, `The analyst couldn’t finish: ${(err as Error).message}`)
    } finally {
      analysing = false
    }
  })

  route('GET', '/dev/analyst/user/:id', async c => {
    needAdmin(c)
    const p = await userProfile(db, c.params[0], Math.max(1, Math.min(720, Number(c.url.searchParams.get('hours')) || 720)))
    if (!p) throw new HttpError(404, 'Nothing recorded for them yet')
    return { profile: p }
  })

  // pseudonym → who, so the dev tools can show emails where the analyst wrote u:xxxx
  async function aliases(): Promise<Record<string, { email: string; name: string; id: string }>> {
    const users = await db.all<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users ORDER BY created_at DESC LIMIT 5000')
    return Object.fromEntries(users.map(u => [pseudonym(u.id), { email: u.email, name: u.name, id: u.id }]))
  }

  // ── new places: the review queue, what's been added, bulk imports ──
  route('GET', '/dev/places/reviews', async c => {
    needAdmin(c)
    const status = c.url.searchParams.get('status')
    const reviews = await listReviews(status === 'accepted' || status === 'denied' || status === 'all' ? status : 'pending', 300)
    const ids = [...new Set(reviews.map(r => r.addedBy).filter((u): u is string => Boolean(u)))]
    const users = ids.length ? await db.all<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids) : []
    const email = new Map(users.map(u => [u.id, u.email]))
    return { reviews: reviews.map(r => ({ ...r, addedBy: r.addedBy ? email.get(r.addedBy) ?? r.addedBy : null })), cities: Object.fromEntries(CITIES.map(x => [x.id, x.name])) }
  })

  route('POST', '/dev/places/reviews/:id', async c => {
    const user = needAdmin(c)
    const body = await readBody(c.req, z.object({ accept: z.boolean() }))
    try {
      return { review: await decideReview(c.params[0], body.accept, { id: user.id, email: user.email }) }
    } catch (err) {
      if (err instanceof ReviewError) throw new HttpError(409, err.message)
      throw err
    }
  })

  route('GET', '/dev/places/added', async c => {
    needAdmin(c)
    const added = await recentAdditions(Math.min(500, Number(c.url.searchParams.get('limit')) || 150))
    const ids = [...new Set(added.map(a => a.addedBy).filter((u): u is string => Boolean(u)))]
    const users = ids.length ? await db.all<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids) : []
    const email = new Map(users.map(u => [u.id, u.email]))
    return { added: added.map(a => ({ ...a, addedBy: a.addedBy ? email.get(a.addedBy) ?? a.addedBy : null })), cities: Object.fromEntries(CITIES.map(x => [x.id, x.name])) }
  })

  route('DELETE', '/dev/places/added/:city/:id', async c => {
    const user = needAdmin(c)
    if (!await hideCatalogPlace(c.params[0], c.params[1], { id: user.id, email: user.email })) throw new HttpError(404, 'That place isn’t one that was added')
    return { ok: true }
  })

  route('GET', '/dev/cities', async c => {
    needAdmin(c)
    return { cities: CITIES.map(x => ({ id: x.id, name: x.name, country: x.country, places: x.places.length, added: x.places.filter(p => p.found).length, built: x.built ?? null, building: buildStatus(x.id)?.status === 'building' })) }
  })

  // Typing a city's name: build it from its guide (or build a built one again).
  route('POST', '/dev/places/city', async c => {
    const user = needAdmin(c)
    const body = await readBody(c.req, z.object({ city: z.string().trim().min(2).max(120), rebuild: z.boolean().default(false) }))
    const out = await buildFromDevTools(body.city, body.rebuild, user.id)
    track('dev.places.city', { ...from(c.req, user.id), subject: 'id' in out ? out.id : null, detail: { text: body.city, rebuild: body.rebuild, status: out.status } })
    return out
  })

  route('GET', '/dev/places/city/:id', async c => {
    needAdmin(c)
    const job = buildStatus(c.params[0])
    const city = CITIES.find(x => x.id === c.params[0])
    if (!job && !city) throw new HttpError(404, 'No such city')
    return job ?? { id: city!.id, name: city!.name, status: 'ready', progress: `${city!.places.length} places` }
  })

  // A file (an Excel sheet, a CSV, a Markdown list) or pasted text, read into rows for a
  // preview. Nothing is added until the import starts.
  const upload = z.object({
    name: z.string().max(200).default('pasted.md'),
    base64: z.string().max(12_000_000).optional(),
    text: z.string().max(2_000_000).optional(),
    city: z.string().trim().max(120).optional(),
  }).refine(b => b.base64 || b.text, 'Choose a file or paste a list')
  route('POST', '/dev/places/parse', async c => {
    needAdmin(c)
    const body = await readBody(c.req, upload, 16 * 1024 * 1024)
    const bytes = body.base64 ? Buffer.from(body.base64, 'base64') : Buffer.from(body.text ?? '', 'utf8')
    try {
      return readUpload(body.name, bytes, body.city ? { city: body.city } : {})
    } catch (err) {
      if (err instanceof SheetError) throw new HttpError(422, err.message)
      throw new HttpError(422, `Couldn’t read that file: ${(err as Error).message}`)
    }
  })

  const row = z.object({
    line: z.number().int(),
    name: z.string().trim().min(1).max(100),
    city: z.string().max(80).optional(),
    country: z.string().max(80).optional(),
    area: z.string().max(120).optional(),
    kind: z.enum(['sight', 'food', 'cafe', 'bar', 'park', 'museum', 'market', 'viewpoint', 'experience']).optional(),
    vibes: z.array(z.enum(['food', 'culture', 'nightlife', 'nature', 'art', 'shopping', 'relaxed', 'adventure', 'romantic', 'history'])).max(3).optional(),
    price: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    notes: z.string().max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    link: z.string().max(500).optional(),
    minutes: z.number().int().min(1).max(1440).optional(),
    bestAt: z.enum(['morning', 'midday', 'evening', 'night']).optional(),
    keywords: z.array(z.string().max(40)).max(6).optional(),
  })
  route('POST', '/dev/places/import', async c => {
    const user = needAdmin(c)
    const body = await readBody(c.req, z.object({ rows: z.array(row).min(1).max(MAX_ROWS), city: z.string().trim().max(120).optional(), label: z.string().max(120).default('Import'), describe: z.boolean().default(true) }), 4 * 1024 * 1024)
    if (importJobs().some(j => j.status === 'running')) throw new HttpError(409, 'An import is already running. Let it finish, or cancel it, first.')
    const job = startImport(body.rows as ImportRow[], { by: user.id, label: body.label, defaultCity: body.city || undefined, describe: body.describe && analystEnabled() })
    return { job }
  })

  route('GET', '/dev/places/imports', async c => {
    needAdmin(c)
    return { jobs: importJobs().map(({ rows, ...j }) => ({ ...j, rowCount: rows.length })) }
  })

  route('GET', '/dev/places/imports/:id', async c => {
    needAdmin(c)
    const job = importJob(c.params[0])
    if (!job) throw new HttpError(404, 'That import isn’t on this server any more')
    return { job }
  })

  route('DELETE', '/dev/places/imports/:id', async c => {
    needAdmin(c)
    cancelImport(c.params[0])
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
