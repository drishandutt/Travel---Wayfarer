import { randomUUID } from 'node:crypto'
import type { Db } from '../money/db'
import type { UserRow } from '../money/auth'
import { HttpError } from '../money/store'
import type { VaultStorage } from '../vault/storage'
import { sniffFile } from '../vault/storage'
import { track } from '../dev/activity'
import { alertsFor, type TripDates } from '../../src/docs/alerts'
import { MAX_DOC_BYTES, type AlertItem, type DocItem, type DocKind, type DocMime, type Extracted, type UploadTarget } from '../../src/docs/types'
import { ReadError, readDocument } from './read'

// The documents vault's records: each document's file sits privately in the vault's bucket
// (under the owner's id), is read by the model once it arrives, and raises alerts that are
// kept in step with it: reading it again, linking it to a trip, or a trip's dates changing
// replaces the alerts that haven't gone out yet.

export const MAX_DOCS = 300

// what reads a file; the tests put a stand-in here
type Reader = typeof readDocument
let reader: Reader = readDocument
export function setReader(r: Reader | null) { reader = r ?? readDocument }

interface DocRow {
  id: string; owner_id: string; storage_key: string; mime: DocMime; bytes: number; file_name: string
  status: DocItem['status']; error: string | null; kind: DocKind | null; data: string | null
  trip_id: string | null; tz_offset: number; created_at: number; read_at: number | null
}
interface AlertRow {
  id: string; user_id: string; doc_id: string | null; key: string; kind: AlertItem['kind']; title: string; body: string
  due_at: number; delivered_at: number | null; emailed_at: number | null; read_at: number | null; created_at: number
}

const toAlert = (a: AlertRow): AlertItem => ({ id: a.id, docId: a.doc_id, kind: a.kind, title: a.title, body: a.body, dueAt: Number(a.due_at), deliveredAt: a.delivered_at === null ? null : Number(a.delivered_at), readAt: a.read_at === null ? null : Number(a.read_at) })

async function own(db: Db, userId: string, id: string): Promise<DocRow> {
  const row = await db.one<DocRow>('SELECT * FROM documents WHERE id = ? AND owner_id = ?', id, userId)
  if (!row) throw new HttpError(404, 'That document isn’t here')
  return row
}

async function checkTrip(db: Db, userId: string, tripId: string | null) {
  if (tripId && !await db.one('SELECT 1 FROM members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', tripId, userId)) throw new HttpError(404, 'That trip isn’t one of yours')
}

export async function startUpload(db: Db, storage: VaultStorage, user: UserRow, item: { id: string; mime: DocMime; bytes: number; fileName: string; tzOffset: number; tripId: string | null }): Promise<UploadTarget> {
  await checkTrip(db, user.id, item.tripId)
  const n = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?', user.id)
  if (Number(n?.n ?? 0) >= MAX_DOCS) throw new HttpError(409, `The documents vault holds up to ${MAX_DOCS} documents each`)
  if (await db.one('SELECT 1 FROM documents WHERE id = ?', item.id)) throw new HttpError(409, 'That document is already uploading')
  const key = `${user.id}/doc-${item.id}`
  await db.run(`INSERT INTO documents (id, owner_id, storage_key, mime, bytes, file_name, status, trip_id, tz_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
    item.id, user.id, key, item.mime, item.bytes, item.fileName, item.tripId, Math.round(item.tzOffset), Date.now())
  return storage.uploadTarget(key, item.mime)
}

// The browser says it's done: check what arrived, then read it in the background.
export async function finishUpload(db: Db, storage: VaultStorage, user: UserRow, id: string): Promise<void> {
  const row = await own(db, user.id, id)
  if (row.status !== 'uploading') return
  const got = await storage.probe(row.storage_key)
  const problem = !got ? 'The upload didn’t arrive. Try again.'
    : got.size > MAX_DOC_BYTES ? 'That file is too large'
    : sniffFile(got.head) !== row.mime ? 'That doesn’t look like a PDF or a photo'
    : null
  if (problem) {
    await db.run('DELETE FROM documents WHERE id = ?', row.id)
    await storage.remove([row.storage_key]).catch(() => {})
    throw new HttpError(422, problem)
  }
  await db.run(`UPDATE documents SET status = 'reading', bytes = ? WHERE id = ?`, got!.size, row.id)
  void analyse(db, storage, row.id)
}

// Read it with the model and raise its alerts. Failing leaves it stored, marked, to try again.
export async function analyse(db: Db, storage: VaultStorage, id: string): Promise<void> {
  const row = await db.one<DocRow>('SELECT * FROM documents WHERE id = ?', id)
  if (!row) return
  try {
    const data = await reader(await storage.read(row.storage_key), row.mime, row.file_name, AbortSignal.timeout(120_000))
    await db.run(`UPDATE documents SET status = 'ready', error = NULL, kind = ?, data = ?, read_at = ? WHERE id = ?`, data.kind, JSON.stringify(data), Date.now(), id)
    await syncAlerts(db, id)
    track('docs.read', { userId: row.owner_id, subject: id, detail: { kind: data.kind, segments: data.segments.length } })
  } catch (err) {
    const message = err instanceof ReadError ? err.message : 'Couldn’t read this one. Try again in a bit.'
    console.warn('[docs] reading', id, (err as Error).message)
    await db.run(`UPDATE documents SET status = 'failed', error = ? WHERE id = ?`, message, id)
    track('docs.read_failed', { userId: row.owner_id, subject: id, detail: { error: (err as Error).message.slice(0, 200) } })
  }
}

// The person's trips with dates: every trip for a passport or ID; for a visa or insurance,
// the trip it's linked to if it is, else all of them.
async function tripsFor(db: Db, userId: string, only: string | null): Promise<TripDates[]> {
  const rows = await db.all<{ id: string; name: string; trip: string | null }>(
    `SELECT g.id, g.name, g.trip FROM money_groups g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? AND m.left_at IS NULL${only ? ' AND g.id = ?' : ''}`, ...(only ? [userId, only] : [userId]))
  return rows.flatMap(r => {
    try {
      const t = r.trip ? JSON.parse(r.trip) as { startDate?: string | null; days?: number; city?: string } : null
      return t?.startDate ? [{ id: r.id, name: t.city ? `your ${t.city} trip` : r.name, start: t.startDate, days: t.days ?? 1 }] : []
    } catch { return [] }
  })
}

// Bring a document's alerts in line with what it says now. Ones already delivered stay as they were.
export async function syncAlerts(db: Db, id: string, now = Date.now()): Promise<void> {
  const row = await db.one<DocRow>('SELECT * FROM documents WHERE id = ?', id)
  if (!row || row.status !== 'ready' || !row.data) return
  const data = JSON.parse(row.data) as Extracted
  const scoped = data.kind === 'visa' || data.kind === 'insurance' ? row.trip_id : null
  const planned = alertsFor(row.id, data, { fallbackOffset: row.tz_offset, trips: await tripsFor(db, row.owner_id, scoped), now })
  await db.tx(async () => {
    const have = await db.all<AlertRow>('SELECT * FROM alerts WHERE doc_id = ?', id)
    const keys = new Set(planned.map(p => p.key))
    for (const a of have) if (a.delivered_at === null && !keys.has(a.key)) await db.run('DELETE FROM alerts WHERE id = ?', a.id)
    for (const p of planned) {
      const old = have.find(a => a.key === p.key)
      if (!old) await db.run('INSERT INTO alerts (id, user_id, doc_id, key, kind, title, body, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', randomUUID(), row.owner_id, id, p.key, p.kind, p.title, p.body, p.dueAt, now)
      else if (old.delivered_at === null) await db.run('UPDATE alerts SET kind = ?, title = ?, body = ?, due_at = ? WHERE id = ?', p.kind, p.title, p.body, p.dueAt, old.id)
    }
  })
}

// Every ready document of the kinds that look at trips, again: run now and then, as trips
// get dates and new trips are made.
export async function resyncTripChecks(db: Db): Promise<number> {
  const rows = await db.all<{ id: string }>(`SELECT id FROM documents WHERE status = 'ready' AND kind IN ('passport', 'id', 'visa', 'insurance')`)
  for (const r of rows) await syncAlerts(db, r.id).catch(err => console.warn('[docs] resync', r.id, (err as Error).message))
  return rows.length
}

export async function library(db: Db, user: UserRow): Promise<DocItem[]> {
  // uploads that never finished, after an hour, are let go
  await db.run(`DELETE FROM documents WHERE owner_id = ? AND status = 'uploading' AND created_at < ?`, user.id, Date.now() - 3_600_000)
  const docs = await db.all<DocRow>('SELECT * FROM documents WHERE owner_id = ? ORDER BY created_at DESC', user.id)
  const alerts = await db.all<AlertRow>('SELECT * FROM alerts WHERE user_id = ? AND doc_id IS NOT NULL ORDER BY due_at', user.id)
  return docs.map(d => ({
    id: d.id, fileName: d.file_name, mime: d.mime, bytes: Number(d.bytes), status: d.status, error: d.error, kind: d.kind,
    data: d.data ? JSON.parse(d.data) as Extracted : null, tripId: d.trip_id, createdAt: Number(d.created_at),
    alerts: alerts.filter(a => a.doc_id === d.id).map(toAlert),
  }))
}

export async function fileUrl(db: Db, storage: VaultStorage, user: UserRow, id: string): Promise<string> {
  const row = await own(db, user.id, id)
  const urls = await storage.readUrls([row.storage_key], 600)
  const url = urls.get(row.storage_key)
  if (!url) throw new HttpError(404, 'That file is gone')
  return url
}

export async function reread(db: Db, storage: VaultStorage, user: UserRow, id: string) {
  const row = await own(db, user.id, id)
  if (row.status === 'uploading' || row.status === 'reading') return
  await db.run(`UPDATE documents SET status = 'reading', error = NULL WHERE id = ?`, id)
  void analyse(db, storage, id)
}

export async function setTrip(db: Db, user: UserRow, id: string, tripId: string | null) {
  await own(db, user.id, id)
  await checkTrip(db, user.id, tripId)
  await db.run('UPDATE documents SET trip_id = ? WHERE id = ?', tripId, id)
  await syncAlerts(db, id)
}

export async function remove(db: Db, storage: VaultStorage, user: UserRow, id: string) {
  const row = await own(db, user.id, id)
  await db.run('DELETE FROM documents WHERE id = ?', id)
  await storage.remove([row.storage_key]).catch(err => console.warn('[docs] removing a file', (err as Error).message))
}

// ── alerts ────────────────────────────────────────────────────────────────────

// What's arrived (newest first) and what's coming in the next 60 days, for the app and the phone.
export async function alertsOf(db: Db, user: UserRow, now = Date.now()) {
  const arrived = await db.all<AlertRow>('SELECT * FROM alerts WHERE user_id = ? AND delivered_at IS NOT NULL ORDER BY delivered_at DESC LIMIT 50', user.id)
  const coming = await db.all<AlertRow>('SELECT * FROM alerts WHERE user_id = ? AND delivered_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 200', user.id, now + 60 * 86_400_000)
  return { arrived: arrived.map(toAlert), coming: coming.map(toAlert), unread: arrived.filter(a => a.read_at === null).length }
}

export async function markRead(db: Db, user: UserRow, ids: string[] | 'all') {
  if (ids === 'all') await db.run('UPDATE alerts SET read_at = ? WHERE user_id = ? AND delivered_at IS NOT NULL AND read_at IS NULL', Date.now(), user.id)
  else for (const id of ids) await db.run('UPDATE alerts SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', Date.now(), id, user.id)
}

// Alerts that are due, claimed one at a time so two passes never send one twice.
export async function claimDue(db: Db, now = Date.now(), limit = 50): Promise<(AlertRow & { email: string; name: string; alert_email: boolean })[]> {
  const due = await db.all<{ id: string }>('SELECT id FROM alerts WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?', now, limit)
  const out: (AlertRow & { email: string; name: string; alert_email: boolean })[] = []
  for (const { id } of due) {
    const r = await db.run('UPDATE alerts SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL', now, id)
    if (!r.changes) continue
    const row = await db.one<AlertRow & { email: string; name: string; alert_email: boolean }>('SELECT a.*, u.email, u.name, u.alert_email FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.id = ?', id)
    if (row) out.push(row)
  }
  return out
}

export const markEmailed = (db: Db, id: string) => db.run('UPDATE alerts SET emailed_at = ? WHERE id = ?', Date.now(), id)
