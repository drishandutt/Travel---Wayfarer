import type { IncomingMessage } from 'node:http'
import type { Db } from '../money/db'

// Every activity, for the dev tools and the analyst (./analyst.ts): each API request, sign-ins
// and refusals, rate limits tripping, cities looked up and built, what the system decided about
// each new place, imports, reviews, and what people do in the app (sent by src/dev/activity.ts).
// Like the log lines (./log.ts), events wait in memory and are written in batches, so tracking
// never slows a request down, and a burst is cut short rather than swamping the database.
//
// Kinds are dotted, family first: http.request, auth.signin, security.rate_limit,
// city.build.done, place.decision, app.action, app.click … The family is what the dev tools
// filter by and what the analyst groups on.

export type Source = 'server' | 'app'

export interface Activity {
  at: number
  kind: string
  source: Source
  userId?: string | null
  device?: string | null
  ip?: string | null
  agent?: string | null
  subject?: string | null
  detail?: Record<string, unknown> | null
}

export interface ActivityRow { id: number; at: number; kind: string; source: Source; user_id: string | null; device: string | null; ip: string | null; agent: string | null; subject: string | null; detail: string | null }

const MAX_PENDING = 20_000
const FLUSH_MS = 2000
const KEEP_DAYS = 90
const KEEP_ROWS = 2_000_000
const MAX_DETAIL = 8000

const pending: Activity[] = []
let dropped = 0
let db: Db | null = null
let flushing = false
let flushes = 0
let timer: NodeJS.Timeout | undefined

export function attachActivityDb(d: Db | null) {
  db = d
  if (d && !timer) timer = setInterval(() => { void flushActivity() }, FLUSH_MS).unref()
  if (!d && timer) { clearInterval(timer); timer = undefined }
}

// Behind Railway's proxy the socket address is the proxy itself.
export const ipOf = (req: IncomingMessage) =>
  (process.env.NODE_ENV === 'production' ? req.headers['x-real-ip'] as string : undefined) ?? req.socket.remoteAddress ?? null

// Who and where, from a request: for track(kind, { ...from(req, user) }).
export const from = (req: IncomingMessage | undefined, userId?: string | null) => ({
  userId: userId ?? null,
  ip: req ? ipOf(req) : null,
  agent: req ? String(req.headers['user-agent'] ?? '').slice(0, 300) || null : null,
  device: req ? String(req.headers['x-wayfarer-device'] ?? '').slice(0, 64) || null : null,
})

// Records one activity. Never throws, never waits.
export function track(kind: string, e: Omit<Activity, 'at' | 'kind' | 'source'> & { source?: Source; at?: number } = {}) {
  try {
    if (pending.length >= MAX_PENDING) { dropped++; return }
    pending.push({ at: e.at ?? Date.now(), kind: kind.slice(0, 80), source: e.source ?? 'server', userId: e.userId ?? null, device: e.device ?? null, ip: e.ip ?? null, agent: e.agent ?? null, subject: e.subject ? String(e.subject).slice(0, 200) : null, detail: e.detail ?? null })
  } catch { /* tracking must never break what it watches */ }
}

const detailText = (d: Record<string, unknown> | null | undefined) => {
  if (!d) return null
  const s = JSON.stringify(d)
  return s.length > MAX_DETAIL ? JSON.stringify({ clipped: true, text: s.slice(0, MAX_DETAIL) }) : s
}

export async function flushActivity() {
  if (!db || flushing || !pending.length) return
  flushing = true
  const batch = pending.splice(0, 1000)
  try {
    if (dropped) {
      batch.push({ at: Date.now(), kind: 'system.dropped', source: 'server', detail: { events: dropped } })
      dropped = 0
    }
    const values: string[] = []
    const params: (string | number | null)[] = []
    for (const e of batch) {
      values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      params.push(e.at, e.kind, e.source, e.userId ?? null, e.device ?? null, e.ip ?? null, e.agent ?? null, e.subject ?? null, detailText(e.detail))
    }
    await db.run(`INSERT INTO activity_events (at, kind, source, user_id, device, ip, agent, subject, detail) VALUES ${values.join(', ')}`, ...params)
    if (++flushes % 300 === 1) {
      await db.run('DELETE FROM activity_events WHERE at < ?', Date.now() - KEEP_DAYS * 86_400_000)
      await db.run('DELETE FROM activity_events WHERE id <= (SELECT id FROM activity_events ORDER BY id DESC OFFSET ? LIMIT 1)', KEEP_ROWS)
    }
  } catch (err) {
    if (pending.length < MAX_PENDING) pending.unshift(...batch.slice(0, MAX_PENDING - pending.length))
    process.stderr.write(`[activity] couldn’t save events: ${(err as Error).message}\n`)
  } finally {
    flushing = false
  }
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface ActivityQuery {
  kind?: string          // a kind, or a family ("place" → place.*)
  userId?: string
  device?: string
  ip?: string
  subject?: string
  text?: string          // anywhere in the subject or detail
  since?: number
  until?: number
  before?: number        // id, for paging back
  source?: Source
  limit?: number
}

const like = (s: string) => `%${s.replace(/[%_\\]/g, m => `\\${m}`)}%`

export function whereOf(q: ActivityQuery): { sql: string; params: (string | number)[] } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (q.kind) { where.push('(kind = ? OR kind LIKE ?)'); params.push(q.kind, `${q.kind.replace(/[%_\\]/g, m => `\\${m}`)}.%`) }
  if (q.userId) { where.push('user_id = ?'); params.push(q.userId) }
  if (q.device) { where.push('device = ?'); params.push(q.device) }
  if (q.ip) { where.push('ip = ?'); params.push(q.ip) }
  if (q.subject) { where.push('subject = ?'); params.push(q.subject) }
  if (q.text) { where.push('(subject ILIKE ? OR detail ILIKE ? OR kind ILIKE ?)'); const l = like(q.text); params.push(l, l, l) }
  if (q.since) { where.push('at >= ?'); params.push(q.since) }
  if (q.until) { where.push('at < ?'); params.push(q.until) }
  if (q.before) { where.push('id < ?'); params.push(q.before) }
  if (q.source) { where.push('source = ?'); params.push(q.source) }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

export async function queryActivity(d: Db, q: ActivityQuery): Promise<ActivityRow[]> {
  await flushActivity()
  const { sql, params } = whereOf(q)
  const rows = await d.all<ActivityRow>(`SELECT * FROM activity_events ${sql} ORDER BY id DESC LIMIT ?`, ...params, Math.min(1000, Math.max(1, q.limit ?? 200)))
  return rows.map(r => ({ ...r, id: Number(r.id) }))
}

export const parseDetail = (r: Pick<ActivityRow, 'detail'>): Record<string, unknown> => {
  try { return r.detail ? JSON.parse(r.detail) : {} } catch { return {} }
}

// ── what an app event may carry ──────────────────────────────────────────────

// Shallow, short and plain: the app sends a summary of each action, never a whole trip.
export function cleanDetail(d: unknown, depth = 0): Record<string, unknown> | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (++n > 24) break
    const key = k.slice(0, 40)
    if (typeof v === 'string') out[key] = v.slice(0, 600)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[key] = v
    else if (Array.isArray(v)) out[key] = v.slice(0, 20).map(x => (typeof x === 'string' ? x.slice(0, 120) : typeof x === 'number' || typeof x === 'boolean' ? x : null))
    else if (depth < 1 && typeof v === 'object') out[key] = cleanDetail(v, depth + 1)
  }
  return out
}
