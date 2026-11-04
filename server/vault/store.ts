import type { Db } from '../money/db'
import { HttpError } from '../money/store'
import type { UserRow } from '../money/auth'
import type { ShareTargets, UploadItem, UploadTicket, VaultGroup, VaultImage, VaultLibrary, VaultPerson } from '../../src/vault/types'
import { MAX_ORIGINAL_BYTES, MAX_THUMB_BYTES } from '../../src/vault/types'
import { sniffImage, type VaultStorage } from './storage'

// The photo vault: who can see which photo. The rule, enforced here for every read:
// you can see a photo if you uploaded it, if it was shared to you, or if it was shared to a
// group you're a current member of. "Everyone in the group" is worked out when you ask, so
// someone who joins later sees what was shared before, and someone removed stops seeing it
// unless the admin chose to let them keep it (see keepGroupPhotos).

export interface VaultLimits { maxCount: number; maxBytes: number }

interface ImageRow {
  id: string; owner_id: string; original_key: string; thumb_key: string; mime: string; bytes: number; file_name: string | null
  width: number | null; height: number | null; taken_at: string | null; gps_lat: number | null; gps_lng: number | null
  place_label: string | null; status: 'pending' | 'ready'; created_at: number
}

const THUMB_URL_SECONDS = 3 * 3600
const ORIGINAL_URL_SECONDS = 15 * 60
// an upload the browser never finished is cleared away after this
const PENDING_MS = 24 * 3600_000

// the groups someone is in right now
const MY_GROUPS = 'SELECT group_id FROM members WHERE user_id = ? AND left_at IS NULL'

const VISIBLE = `i.status = 'ready' AND (
  i.owner_id = ?
  OR EXISTS (SELECT 1 FROM vault_shares s WHERE s.image_id = i.id AND (
    (s.target_type = 'user' AND s.target_id = ?)
    OR (s.target_type = 'group' AND s.target_id IN (${MY_GROUPS}))
  ))
)`

async function canSee(db: Db, userId: string, imageId: string): Promise<ImageRow | null> {
  return await db.one<ImageRow>(`SELECT i.* FROM vault_images i WHERE i.id = ? AND ${VISIBLE}`, imageId, userId, userId, userId) ?? null
}

async function ownImage(db: Db, userId: string, imageId: string): Promise<ImageRow> {
  const row = await db.one<ImageRow>('SELECT * FROM vault_images WHERE id = ? AND owner_id = ?', imageId, userId)
  if (!row) throw new HttpError(404, 'That photo is gone')
  return row
}

// People you can send a photo to: anyone with an account who's in a group with you now.
async function reachablePeople(db: Db, userId: string): Promise<VaultPerson[]> {
  return db.all<VaultPerson>(`
    SELECT DISTINCT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.left_at IS NULL AND m.user_id != ? AND m.group_id IN (${MY_GROUPS})
    ORDER BY u.name, u.id`, userId, userId)
}

async function myGroups(db: Db, userId: string): Promise<VaultGroup[]> {
  const rows = await db.all<{ id: string; name: string; role: string }>(`
    SELECT g.id, g.name, m.role FROM members m JOIN money_groups g ON g.id = m.group_id
    WHERE m.user_id = ? AND m.left_at IS NULL ORDER BY g.created_at DESC`, userId)
  return rows.map(r => ({ id: r.id, name: r.name, admin: r.role === 'owner' }))
}

// Only groups you're in, and people you share one with: a photo can't be sent to a stranger.
// Someone the photo already went to can stay on it, even if they're no longer in a group
// with you (an admin let them keep it, or one of you left).
async function checkTargets(db: Db, userId: string, share: ShareTargets, alreadyOn = new Set<string>()): Promise<ShareTargets> {
  const groups = [...new Set(share.groups)]
  const users = [...new Set(share.users)].filter(u => u !== userId)
  const mine = new Set((await myGroups(db, userId)).map(g => g.id))
  if (groups.some(g => !mine.has(g) && !alreadyOn.has(`group:${g}`))) throw new HttpError(403, 'You can only share to groups you’re in')
  const reachable = new Set((await reachablePeople(db, userId)).map(p => p.id))
  if (users.some(u => !reachable.has(u) && !alreadyOn.has(`user:${u}`))) throw new HttpError(403, 'You can only share with people in one of your groups')
  return { groups, users }
}

async function writeShares(db: Db, imageId: string, share: ShareTargets, at: number) {
  for (const g of share.groups) await db.run(`INSERT INTO vault_shares (image_id, target_type, target_id, created_at) VALUES (?, 'group', ?, ?) ON CONFLICT DO NOTHING`, imageId, g, at)
  for (const u of share.users) await db.run(`INSERT INTO vault_shares (image_id, target_type, target_id, created_at) VALUES (?, 'user', ?, ?) ON CONFLICT DO NOTHING`, imageId, u, at)
}

async function usageOf(db: Db, userId: string) {
  const row = await db.one<{ n: number; b: number | null }>('SELECT COUNT(*)::int AS n, SUM(bytes)::bigint AS b FROM vault_images WHERE owner_id = ?', userId)
  return { count: row?.n ?? 0, bytes: Number(row?.b ?? 0) }
}

// Uploads the browser started and never finished, so their space isn't held forever.
async function clearStale(db: Db, storage: VaultStorage, userId: string) {
  const stale = await db.all<ImageRow>(`SELECT * FROM vault_images WHERE owner_id = ? AND status = 'pending' AND created_at < ?`, userId, Date.now() - PENDING_MS)
  if (!stale.length) return
  await db.run(`DELETE FROM vault_images WHERE owner_id = ? AND status = 'pending' AND created_at < ?`, userId, Date.now() - PENDING_MS)
  await storage.remove(stale.flatMap(r => [r.original_key, r.thumb_key])).catch(err => console.warn('[vault] clearing stale uploads:', (err as Error).message))
}

// ── uploading ─────────────────────────────────────────────────────────────────

export async function startUploads(db: Db, storage: VaultStorage, limits: VaultLimits, user: UserRow, items: UploadItem[], share: ShareTargets): Promise<UploadTicket[]> {
  await clearStale(db, storage, user.id)
  const targets = await checkTargets(db, user.id, share)
  const at = Date.now()
  await db.tx(async () => {
    const used = await usageOf(db, user.id)
    if (used.count + items.length > limits.maxCount) throw new HttpError(409, `The vault holds up to ${limits.maxCount} photos each`)
    if (used.bytes + items.reduce((n, i) => n + i.bytes + i.thumbBytes, 0) > limits.maxBytes) throw new HttpError(409, 'Your vault is full')
    for (const item of items) {
      if (await db.one('SELECT 1 FROM vault_images WHERE id = ?', item.id)) throw new HttpError(409, 'That photo is already uploading')
      const key = `${user.id}/${item.id}`
      await db.run(`INSERT INTO vault_images (id, owner_id, original_key, thumb_key, mime, bytes, file_name, width, height, taken_at, gps_lat, gps_lng, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        item.id, user.id, `${key}-original`, `${key}-thumb`, item.mime, item.bytes + item.thumbBytes, item.fileName, item.width, item.height,
        item.takenAt, item.lat, item.lng, at)
      await writeShares(db, item.id, targets, at)
    }
  })
  return Promise.all(items.map(async item => ({
    id: item.id,
    original: await storage.uploadTarget(`${user.id}/${item.id}-original`, item.mime),
    thumb: await storage.uploadTarget(`${user.id}/${item.id}-thumb`, 'image/jpeg'),
  })))
}

// The browser says it's done: check what actually arrived before anyone else can see it.
export async function finishUpload(db: Db, storage: VaultStorage, user: UserRow, imageId: string): Promise<ImageRow> {
  const row = await ownImage(db, user.id, imageId)
  if (row.status === 'ready') return row
  const [original, thumb] = await Promise.all([storage.probe(row.original_key), storage.probe(row.thumb_key)])
  const problem = !original || !thumb ? 'The upload didn’t arrive. Try again.'
    : original.size > MAX_ORIGINAL_BYTES || thumb.size > MAX_THUMB_BYTES ? 'That photo is too large'
    : sniffImage(original.head) !== row.mime || !sniffImage(thumb.head) ? 'That doesn’t look like a photo'
    : null
  if (problem) {
    await db.run('DELETE FROM vault_images WHERE id = ?', row.id)
    await storage.remove([row.original_key, row.thumb_key]).catch(() => {})
    throw new HttpError(422, problem)
  }
  await db.run(`UPDATE vault_images SET status = 'ready', bytes = ? WHERE id = ?`, original!.size + thumb!.size, row.id)
  return { ...row, status: 'ready', bytes: original!.size + thumb!.size }
}

// ── reading ───────────────────────────────────────────────────────────────────

export async function library(db: Db, storage: VaultStorage, limits: VaultLimits, user: UserRow): Promise<VaultLibrary> {
  const [rows, groups, people, usage] = await Promise.all([
    db.all<ImageRow & { owner_name: string }>(`
      SELECT i.*, u.name AS owner_name FROM vault_images i JOIN users u ON u.id = i.owner_id
      WHERE ${VISIBLE}
      ORDER BY COALESCE(i.taken_at, to_char(to_timestamp(i.created_at / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SS')) DESC, i.created_at DESC
      LIMIT 5000`, user.id, user.id, user.id),
    myGroups(db, user.id),
    reachablePeople(db, user.id),
    usageOf(db, user.id),
  ])
  const ids = rows.map(r => r.id)
  const shares = ids.length
    ? await db.all<{ image_id: string; target_type: 'group' | 'user'; target_id: string }>(
      `SELECT image_id, target_type, target_id FROM vault_shares WHERE image_id IN (${ids.map(() => '?').join(', ')})`, ...ids)
    : []
  const byImage = new Map<string, typeof shares>()
  for (const s of shares) byImage.set(s.image_id, [...(byImage.get(s.image_id) ?? []), s])
  const inGroup = new Set(groups.map(g => g.id))
  const urls = await storage.readUrls(rows.map(r => r.thumb_key), THUMB_URL_SECONDS)

  const images: VaultImage[] = rows.map(r => {
    const mine = r.owner_id === user.id
    const s = byImage.get(r.id) ?? []
    return {
      id: r.id,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      mine,
      takenAt: r.taken_at,
      createdAt: r.created_at,
      width: r.width,
      height: r.height,
      place: r.place_label,
      fileName: mine ? r.file_name : null,
      thumbUrl: urls.get(r.thumb_key) ?? '',
      viaGroups: s.filter(x => x.target_type === 'group' && inGroup.has(x.target_id)).map(x => x.target_id),
      direct: s.some(x => x.target_type === 'user' && x.target_id === user.id),
      // who else got it is the uploader's business
      ...(mine ? { sharedWith: { groups: s.filter(x => x.target_type === 'group').map(x => x.target_id), users: s.filter(x => x.target_type === 'user').map(x => x.target_id) } } : {}),
    }
  })
  // names for everyone your own photos went to, including people no longer in a group with you
  const sharedTo = [...new Set(images.flatMap(i => i.sharedWith?.users ?? []))]
  const named = sharedTo.length
    ? await db.all<VaultPerson>(`SELECT id, name FROM users WHERE id IN (${sharedTo.map(() => '?').join(', ')})`, ...sharedTo)
    : []
  const names = Object.fromEntries([...people, ...named].map(p => [p.id, p.name]))
  return { images, groups, people, names, usage: { ...usage, maxCount: limits.maxCount, maxBytes: limits.maxBytes } }
}

export async function originalUrl(db: Db, storage: VaultStorage, user: UserRow, imageId: string): Promise<string> {
  const row = await canSee(db, user.id, imageId)
  if (!row) throw new HttpError(404, 'That photo is gone')
  const url = (await storage.readUrls([row.original_key], ORIGINAL_URL_SECONDS)).get(row.original_key)
  if (!url) throw new HttpError(404, 'That photo is gone')
  return url
}

// ── changing ──────────────────────────────────────────────────────────────────

export async function setShares(db: Db, user: UserRow, imageIds: string[], share: ShareTargets) {
  await db.tx(async () => {
    for (const id of imageIds) {
      await ownImage(db, user.id, id)
      const existing = await db.all<{ target_type: string; target_id: string }>('SELECT target_type, target_id FROM vault_shares WHERE image_id = ?', id)
      const targets = await checkTargets(db, user.id, share, new Set(existing.map(e => `${e.target_type}:${e.target_id}`)))
      await db.run('DELETE FROM vault_shares WHERE image_id = ?', id)
      await writeShares(db, id, targets, Date.now())
    }
  })
}

export async function setPlace(db: Db, user: UserRow, imageIds: string[], place: string | null) {
  await db.tx(async () => {
    for (const id of imageIds) {
      await ownImage(db, user.id, id)
      await db.run('UPDATE vault_images SET place_label = ? WHERE id = ?', place, id)
    }
  })
}

export async function deleteImages(db: Db, storage: VaultStorage, user: UserRow, imageIds: string[]) {
  const rows = await db.tx(async () => {
    const out: ImageRow[] = []
    for (const id of imageIds) out.push(await ownImage(db, user.id, id))
    for (const r of out) await db.run('DELETE FROM vault_images WHERE id = ?', r.id)
    return out
  })
  // the rows are gone, so nobody can reach the files even if removing them fails
  await storage.remove(rows.flatMap(r => [r.original_key, r.thumb_key])).catch(err => console.warn('[vault] removing files:', (err as Error).message))
}

// ── group membership ──────────────────────────────────────────────────────────

// Photos someone can see only because they're in this group: what they'd lose on removal.
export async function photosThroughGroup(db: Db, groupId: string, userId: string): Promise<number> {
  const row = await db.one<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM vault_images i
    WHERE i.status = 'ready' AND i.owner_id != ?
      AND EXISTS (SELECT 1 FROM vault_shares s WHERE s.image_id = i.id AND s.target_type = 'group' AND s.target_id = ?)
      AND NOT EXISTS (SELECT 1 FROM vault_shares s WHERE s.image_id = i.id AND s.target_type = 'user' AND s.target_id = ?)`, userId, groupId, userId)
  return row?.n ?? 0
}

// "Keep what they had": before someone leaves the group, everything shared to it so far is
// shared to them directly. They get nothing shared to the group after this.
export async function keepGroupPhotos(db: Db, groupId: string, userId: string) {
  await db.run(`
    INSERT INTO vault_shares (image_id, target_type, target_id, created_at)
    SELECT i.id, 'user', ?, ? FROM vault_images i
    WHERE i.status = 'ready' AND i.owner_id != ?
      AND EXISTS (SELECT 1 FROM vault_shares s WHERE s.image_id = i.id AND s.target_type = 'group' AND s.target_id = ?)
    ON CONFLICT DO NOTHING`, userId, Date.now(), userId, groupId)
}

export async function forgetGroup(db: Db, groupId: string) {
  await db.run(`DELETE FROM vault_shares WHERE target_type = 'group' AND target_id = ?`, groupId)
}

// ── place names ───────────────────────────────────────────────────────────────

export type Geocoder = (lat: number, lng: number) => Promise<string | null>

// about 100 m: coarser lands a photo in the next town over near a boundary
const placeKey = (lat: number, lng: number) => `${lat.toFixed(3)},${lng.toFixed(3)}`

// Names a photo's place once per rough location, then reuses it for every photo taken nearby.
export async function labelPlace(db: Db, geocode: Geocoder, imageId: string) {
  const row = await db.one<ImageRow>('SELECT * FROM vault_images WHERE id = ?', imageId)
  if (!row || row.place_label || row.gps_lat == null || row.gps_lng == null) return
  const key = placeKey(row.gps_lat, row.gps_lng)
  let cached = await db.one<{ label: string | null }>('SELECT label FROM vault_places WHERE key = ?', key)
  if (!cached) {
    const label = await geocode(row.gps_lat, row.gps_lng).catch(() => undefined)
    // a failed lookup isn't cached, so it's tried again for the next photo
    if (label === undefined) return
    await db.run('INSERT INTO vault_places (key, label, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING', key, label, Date.now())
    cached = { label }
  }
  if (cached.label) await db.run('UPDATE vault_images SET place_label = ? WHERE id = ? AND place_label IS NULL', cached.label, imageId)
}

// OpenStreetMap's Nominatim: free, at most one request a second, and it asks to be told who's
// calling. Coordinates are rounded to about 100 m before they leave this server.
export function nominatim(): Geocoder {
  let last = 0
  let chain: Promise<unknown> = Promise.resolve()
  return (lat, lng) => {
    const run = chain.then(async () => {
      const wait = last + 1100 - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      last = Date.now()
      const q = new URLSearchParams({ format: 'jsonv2', lat: lat.toFixed(3), lon: lng.toFixed(3), zoom: '10', 'accept-language': 'en' })
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${q}`, { headers: { 'User-Agent': 'Wayfarer trip planner (photo vault)' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`Nominatim ${res.status}`)
      const data = await res.json() as { address?: Record<string, string> }
      const a = data.address ?? {}
      // Portugal's cities come back as "Sintra (Santa Maria e São Miguel, …)": the parishes go
      const town = (a.city ?? a.town ?? a.municipality ?? a.village ?? a.county ?? a.state)?.replace(/\s*\(.*\)\s*$/, '')
      return [town, a.country].filter(Boolean).join(', ') || null
    })
    chain = run.catch(() => {})
    return run
  }
}
