import { randomUUID } from 'node:crypto'
import type { Place } from '../../src/types'
import { cityById, findCity } from '../../src/data/cities'
import { mapsHost } from '../../src/planner/customPlaces'
import { PlaceError, resolvePlace } from '../places'
import { track } from '../dev/activity'
import type { ImportRow } from '../dev/sheets'
import { buildStatus, lookupCity, promoteFind, sameSpot } from './store'

// The owner's bulk import from the dev tools: rows from a spreadsheet, a Markdown list or
// pasted text, each found on the map (OpenStreetMap, one lookup a second), shaped by what the
// sheet says about it (kind, vibes, price, notes, best time), described by the AI when asked,
// and added to its city's catalog for everyone. A city the app doesn't have is built first.
// The owner chose these, so nothing goes to the review queue. Runs in the background; the dev
// tools poll the job.

export type RowStatus = 'waiting' | 'added' | 'exists' | 'failed' | 'skipped'

export interface RowResult { line: number; name: string; city: string | null; status: RowStatus; message?: string; placeId?: string; cityId?: string }

export interface ImportJob {
  id: string
  by: string | null
  label: string
  status: 'running' | 'done' | 'cancelled'
  progress: string
  describe: boolean
  startedAt: number
  finishedAt: number | null
  rows: RowResult[]
  counts: Record<RowStatus, number>
}

const jobs = new Map<string, ImportJob>()
const cancelled = new Set<string>()
const BUILD_WAIT_MS = 5 * 60_000

export const importJob = (id: string) => jobs.get(id)
export const importJobs = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)
export function cancelImport(id: string) { if (jobs.get(id)?.status === 'running') cancelled.add(id) }

const countOf = (rows: RowResult[]) => rows.reduce((n, r) => ({ ...n, [r.status]: n[r.status] + 1 }), { waiting: 0, added: 0, exists: 0, failed: 0, skipped: 0 } as Record<RowStatus, number>)

export interface ImportOptions { by: string | null; label: string; defaultCity?: string; describe: boolean; wait?: (ms: number) => Promise<void> }

export function startImport(rows: ImportRow[], o: ImportOptions): ImportJob {
  const job: ImportJob = {
    id: `im_${randomUUID().slice(0, 10)}`,
    by: o.by,
    label: o.label.slice(0, 120),
    status: 'running',
    progress: 'Starting',
    describe: o.describe,
    startedAt: Date.now(),
    finishedAt: null,
    rows: rows.map(r => ({ line: r.line, name: r.name, city: r.city ?? o.defaultCity ?? null, status: 'waiting' })),
    counts: countOf([]),
  }
  job.counts = countOf(job.rows)
  jobs.set(job.id, job)
  if (jobs.size > 40) jobs.delete([...jobs.keys()][0])
  track('place.import.start', { userId: o.by, subject: job.id, detail: { label: job.label, rows: rows.length, describe: o.describe } })
  void run(job, rows, o).catch(err => {
    job.progress = `Stopped: ${(err as Error).message}`
    console.error('[import]', err)
  }).finally(() => {
    if (job.status === 'running') job.status = cancelled.has(job.id) ? 'cancelled' : 'done'
    cancelled.delete(job.id)
    job.finishedAt = Date.now()
    job.counts = countOf(job.rows)
    track('place.import.done', { userId: o.by, subject: job.id, detail: { label: job.label, status: job.status, ...job.counts, ms: job.finishedAt - job.startedAt } })
  })
  return job
}

// The city a row names, building it if need be. Cached per import, so a sheet of fifty
// Lisbon places looks Lisbon up once.
async function cityFor(text: string, job: ImportJob, o: ImportOptions, cache: Map<string, { id?: string; error?: string }>): Promise<{ id?: string; error?: string }> {
  const key = text.toLowerCase().trim()
  const held = cache.get(key)
  if (held) return held
  const wait = o.wait ?? (ms => new Promise(r => setTimeout(r, ms)))
  let out: { id?: string; error?: string }
  const known = cityById(key) ?? findCity(key)
  if (known) out = { id: known.id }
  else {
    job.progress = `Looking up ${text}`
    const look = await lookupCity(text, undefined, o.by).catch(err => ({ status: 'failed' as const, id: '', name: text, error: (err as Error).message }))
    if (look.status === 'known') out = { id: look.id }
    else if (look.status === 'building') {
      const started = Date.now()
      out = { error: `Building ${look.name} took too long` }
      while (Date.now() - started < BUILD_WAIT_MS && !cancelled.has(job.id)) {
        const s = buildStatus(look.id)
        job.progress = `Building ${look.name}: ${s?.progress ?? 'starting'}`
        if (s?.status === 'ready' || cityById(look.id)) { out = { id: look.id }; break }
        if (s?.status === 'failed') { out = { error: s.error ?? `Couldn’t build ${look.name}` }; break }
        await wait(1500)
      }
    } else if (look.status === 'failed') out = { error: look.error }
    else out = { error: `No travel guide found for “${text}”` }
  }
  cache.set(key, out)
  return out
}

async function run(job: ImportJob, rows: ImportRow[], o: ImportOptions) {
  const cities = new Map<string, { id?: string; error?: string }>()
  for (let i = 0; i < rows.length; i++) {
    if (cancelled.has(job.id)) { job.status = 'cancelled'; job.rows.filter(r => r.status === 'waiting').forEach(r => { r.status = 'skipped'; r.message = 'Cancelled' }); break }
    const row = rows[i]
    const result = job.rows[i]
    job.progress = `${i + 1} of ${rows.length}: ${row.name}`
    const cityText = row.city ?? o.defaultCity
    try {
      if (!cityText) throw new PlaceError('No city: add a City column, or choose one for the whole import.')
      const c = await cityFor(cityText, job, o, cities)
      if (!c.id) throw new PlaceError(c.error ?? 'Unknown city')
      result.cityId = c.id
      const place = await placeFor(row, c.id, o.describe)
      const city = cityById(c.id)!
      const added = await promoteFind(c.id, place, o.by, 'import')
      if (added) { result.status = 'added'; result.placeId = added.id }
      else {
        result.status = 'exists'
        result.placeId = city.places.find(p => p.id === place.id || sameSpot(p, place))?.id
        result.message = 'Already in the catalog'
      }
    } catch (err) {
      result.status = 'failed'
      result.message = err instanceof PlaceError ? err.message : `Something went wrong: ${(err as Error).message}`
    }
    job.counts = countOf(job.rows)
    track('place.import.row', { userId: o.by, subject: result.cityId && result.placeId ? `${result.cityId}/${result.placeId}` : job.id, detail: { job: job.id, line: row.line, name: row.name, city: cityText ?? null, status: result.status, message: result.message ?? null } })
  }
  job.progress = job.status === 'cancelled' ? 'Cancelled' : `Done: ${job.counts.added} added, ${job.counts.exists} already there, ${job.counts.failed} not found`
}

// One row on the map, shaped by what the sheet says. What the owner wrote wins over the map's
// guess and the AI's.
export async function placeFor(row: ImportRow, cityId: string, describe: boolean): Promise<Place> {
  const link = row.link && mapsHost(row.link) ? row.link : undefined
  const coord: [number, number] | undefined = row.lat !== undefined && row.lng !== undefined ? [row.lng, row.lat] : undefined
  const found = await resolvePlace({ city: cityId, name: row.name, link, coord, kind: row.kind, describe })
  const p: Place = { ...found.place, id: found.place.id.replace(/^my-/, 'imp-') }
  if (!link && !coord) p.name = row.name.slice(0, 80)
  if (row.kind) p.kind = row.kind
  if (row.vibes?.length) p.tags = row.vibes
  if (row.price !== undefined) p.price = row.price
  if (row.notes) p.blurb = row.notes.length > 110 ? `${row.notes.slice(0, 105).replace(/\s+\S*$/, '')}…` : row.notes
  if (row.minutes && row.minutes >= 10 && row.minutes <= 480) p.minutes = row.minutes
  if (row.bestAt) p.bestAt = row.bestAt
  if (row.keywords?.length) p.keywords = row.keywords
  if (row.area && p.custom) p.custom = { ...p.custom, address: row.area }
  return p
}
