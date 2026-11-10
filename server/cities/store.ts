import type { Audience, City, Place, PlaceProfile, TripBrief } from '../../src/types'
import { CITIES, addCatalogPlaces, cityById, findCity, registerCity } from '../../src/data/cities'
import { audiencesOf, ruleProfile } from '../../src/planner/profile'
import type { Db } from '../money/db'
import { getRates } from '../money/fx'
import { BuildError, buildCity, findArticle } from './build'
import { profileBatch, profilingEnabled } from './profile'

// The cities the server knows: the hand-made ones, plus every city built from public guides
// (./build.ts), with travellers' promoted finds and the profiles a model or travellers' swipes
// have given their places. All of it lives in the database and is registered into the same
// in-memory catalog the planners read (src/data/cities.ts); the browser fetches a city from here.

let db: Db | null = null
export function attachCityDb(d: Db | null) { db = d }

interface CityRow { id: string; name: string; country: string; city: string; built_at: number }
interface PlaceRow { id: string; city_id: string; place: string; added_by: string | null; added_at: number }
interface ProfileRow { city_id: string; place_id: string; profile: string }

// ── loading ──────────────────────────────────────────────────────────────────

const loadedProfiles = new Map<string, number>() // city id → how many model profiles it has

// Registers everything the database holds: built cities, promoted finds and profiles for every
// city, then what travellers' swipes have taught. Run once at start, and again for a city when
// something about it changes.
export async function loadCities(): Promise<void> {
  if (!db) return
  for (const row of await db.all<CityRow>('SELECT * FROM cities')) {
    try { registerCity(JSON.parse(row.city) as City) } catch (err) { console.warn('[cities] bad city row', row.id, (err as Error).message) }
  }
  for (const city of CITIES) await refreshCity(city.id)
}

async function refreshCity(cityId: string): Promise<void> {
  if (!db || !cityById(cityId)) return
  const finds = await db.all<PlaceRow>('SELECT * FROM city_places WHERE city_id = ? AND hidden = 0', cityId)
  addCatalogPlaces(cityId, finds.map(r => JSON.parse(r.place) as Place))
  const profiles = await db.all<ProfileRow>('SELECT * FROM place_profiles WHERE city_id = ?', cityId)
  loadedProfiles.set(cityId, profiles.length)
  const city = cityById(cityId)!
  const byId = new Map(profiles.map(r => [r.place_id, JSON.parse(r.profile) as PlaceProfile]))
  const learned = await learnedFor(cityId)
  const changed: Place[] = []
  for (const p of city.places) {
    const prof = byId.get(p.id)
    const l = learned.get(p.id)
    if (!prof && !l) continue
    changed.push({ ...p, profile: { ...(prof ?? ruleProfile(p)), ...(l ? { learned: l } : {}) } })
  }
  addCatalogPlaces(cityId, changed)
}

// ── keeping ──────────────────────────────────────────────────────────────────

export async function saveCity(city: City): Promise<void> {
  await db?.run(`INSERT INTO cities (id, name, country, city, built_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, country = excluded.country, city = excluded.city, built_at = excluded.built_at`,
    city.id, city.name, city.country, JSON.stringify(city), Date.now())
}

export async function saveProfiles(cityId: string, profiles: Map<string, PlaceProfile>): Promise<void> {
  if (!db) return
  for (const [placeId, prof] of profiles) {
    await db.run(`INSERT INTO place_profiles (city_id, place_id, profile, profiled_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (city_id, place_id) DO UPDATE SET profile = excluded.profile, profiled_at = excluded.profiled_at`,
      cityId, placeId, JSON.stringify(prof), prof.at)
  }
}

// A traveller's find, promoted into the city's catalog for everyone. The catalog's copy loses
// the "Your find" marker and the link they shared; the traveller's own copy keeps both. Nothing
// is promoted twice: the same spot already listed means the catalog's copy wins.
export async function promoteFind(cityId: string, found: Place, userId: string | null): Promise<Place | undefined> {
  const city = cityById(cityId)
  if (!city) return undefined
  if (city.places.some(x => x.id === found.id || sameSpot(x, found))) return undefined
  const at = Date.now()
  const { custom, ...rest } = found
  void custom
  const place: Place = { ...rest, blurb: rest.blurb.replace(/^Your find: /, ''), found: { at }, profile: rest.profile ?? { ...ruleProfile(rest), at } }
  await db?.run('INSERT INTO city_places (id, city_id, place, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', place.id, cityId, JSON.stringify(place), userId, at)
  if (place.profile && place.profile.by !== 'rules') await saveProfiles(cityId, new Map([[place.id, place.profile]]))
  addCatalogPlaces(cityId, [place])
  return place
}

function sameSpot(a: Pick<Place, 'name' | 'coord'>, b: Pick<Place, 'name' | 'coord'>): boolean {
  const dx = (a.coord[0] - b.coord[0]) * 111 * Math.cos((a.coord[1] * Math.PI) / 180)
  const dy = (a.coord[1] - b.coord[1]) * 111
  const km = Math.hypot(dx, dy)
  if (km < 0.03) return true
  const key = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')
  return km < 0.25 && Boolean(key(a.name)) && (key(a.name).includes(key(b.name)) || key(b.name).includes(key(a.name)))
}

// ── what swipes teach ────────────────────────────────────────────────────────

const MIN_SIGNALS = 6      // before a place learns anything
const MIN_AUDIENCE = 4     // swipes from one kind of traveller before they count

// Every swipe on a city's deck, with who the traveller is (their audiences, from the brief:
// never who they are). What they kept and skipped teaches each place who it suits.
export async function recordSignals(cityId: string, liked: string[], rejected: string[], brief: TripBrief): Promise<number> {
  if (!db || !cityById(cityId)) return 0
  const who = JSON.stringify(audiencesOf(brief))
  const at = Date.now()
  let n = 0
  for (const [ids, kept] of [[liked, 1], [rejected, 0]] as [string[], number][]) {
    for (const id of ids.slice(0, 200)) {
      await db.run('INSERT INTO place_signals (city_id, place_id, kept, audiences, at) VALUES (?, ?, ?, ?, ?)', cityId, id, kept, who, at)
      n++
    }
  }
  if (n) scheduleLearning(cityId)
  return n
}

export interface Learned { signals: number; for: Audience[]; notFor: Audience[] }

// From the swipes so far: a place is for the kinds of traveller who keep it clearly more than
// most do, and not for those who skip it. Nothing is learned from a handful.
export function learnFrom(rows: { place_id: string; kept: number; audiences: string }[]): Map<string, Learned> {
  const byPlace = new Map<string, { n: number; kept: number; aud: Map<Audience, { n: number; kept: number }> }>()
  for (const r of rows) {
    const p = byPlace.get(r.place_id) ?? { n: 0, kept: 0, aud: new Map() }
    p.n++
    p.kept += r.kept
    let who: Audience[] = []
    try { who = JSON.parse(r.audiences) } catch { /* an unreadable row teaches nothing */ }
    for (const a of who) {
      const x = p.aud.get(a) ?? { n: 0, kept: 0 }
      x.n++
      x.kept += r.kept
      p.aud.set(a, x)
    }
    byPlace.set(r.place_id, p)
  }
  const out = new Map<string, Learned>()
  for (const [id, p] of byPlace) {
    if (p.n < MIN_SIGNALS) continue
    const overall = p.kept / p.n
    const l: Learned = { signals: p.n, for: [], notFor: [] }
    for (const [a, x] of p.aud) {
      if (x.n < MIN_AUDIENCE) continue
      const rate = x.kept / x.n
      if (rate >= 0.65 && rate >= overall + 0.1) l.for.push(a)
      else if (rate <= 0.3 && rate <= overall - 0.1) l.notFor.push(a)
    }
    if (l.for.length || l.notFor.length) out.set(id, l)
  }
  return out
}

async function learnedFor(cityId: string): Promise<Map<string, Learned>> {
  if (!db) return new Map()
  const rows = await db.all<{ place_id: string; kept: number; audiences: string }>('SELECT place_id, kept, audiences FROM place_signals WHERE city_id = ?', cityId)
  return learnFrom(rows)
}

const LEARN_AFTER_MS = 60_000
const learning = new Map<string, NodeJS.Timeout>()
// Swipes arrive in bursts; a city learns from them a minute later, once.
function scheduleLearning(cityId: string) {
  if (learning.has(cityId)) return
  learning.set(cityId, setTimeout(() => {
    learning.delete(cityId)
    learnCity(cityId).catch(err => console.warn('[cities] learning', cityId, (err as Error).message))
  }, LEARN_AFTER_MS).unref())
}

export async function learnCity(cityId: string): Promise<number> {
  const city = cityById(cityId)
  if (!city) return 0
  const learned = await learnedFor(cityId)
  const changed = city.places.filter(p => learned.has(p.id) || p.profile?.learned).map(p => {
    const l = learned.get(p.id)
    const base = p.profile ?? { ...ruleProfile(p), at: Date.now() }
    const { learned: _old, ...rest } = base
    void _old
    return { ...p, profile: l ? { ...rest, learned: l } : rest }
  })
  addCatalogPlaces(cityId, changed)
  return learned.size
}

// ── profiles from a model ────────────────────────────────────────────────────

const PROFILE_TOP = 150
const profiling = new Set<string>()

// Asks the model about a city's best-known places, in batches, in the background. Once per
// city: what's learned is kept, so a restart doesn't ask again.
export function profileCityInBackground(cityId: string): void {
  const city = cityById(cityId)
  if (!city || !db || !profilingEnabled() || profiling.has(cityId)) return
  if ((loadedProfiles.get(cityId) ?? 0) >= Math.min(PROFILE_TOP, city.places.length) * 0.6) return
  profiling.add(cityId)
  ;(async () => {
    const todo = [...city.places].filter(p => !p.profile || p.profile.by === 'rules').sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, PROFILE_TOP)
    let done = 0
    for (let i = 0; i < todo.length; i += 20) {
      try {
        const got = await profileBatch(city, todo.slice(i, i + 20))
        await saveProfiles(cityId, got)
        done += got.size
      } catch (err) {
        console.warn('[cities] profiling', city.name, (err as Error).message)
      }
    }
    await refreshCity(cityId)
    console.log(`[cities] ${city.name}: ${done} places profiled`)
  })().finally(() => profiling.delete(cityId))
}

// ── building on request ──────────────────────────────────────────────────────

export interface BuildJob { id: string; name: string; status: 'building' | 'ready' | 'failed'; progress: string; error?: string; startedAt: number }
const jobs = new Map<string, BuildJob>()

export type Lookup =
  | { status: 'known'; id: string; name: string }
  | { status: 'building'; id: string; name: string; progress: string }
  | { status: 'failed'; id: string; name: string; error: string }
  | { status: 'unknown' }

export const buildStatus = (id: string): BuildJob | undefined => jobs.get(id)

// What they named: a city the app knows, one it's building, one it can start building, or nothing.
export async function lookupCity(text: string, signal?: AbortSignal): Promise<Lookup> {
  const known = findCity(text)
  if (known) return { status: 'known', id: known.id, name: known.name }
  const found = await findArticle(text, signal)
  if (!found) return { status: 'unknown' }
  const name = found.title.replace(/\s*\(.*\)$/, '')
  const id = slugOf(name)
  const have = cityById(id)
  if (have) return { status: 'known', id, name: have.name }
  const job = jobs.get(id)
  if (job?.status === 'building') return { status: 'building', id, name, progress: job.progress }
  if (job?.status === 'failed' && Date.now() - job.startedAt < 10 * 60_000) return { status: 'failed', id, name, error: job.error ?? 'It didn’t work' }
  // built by another server since this one started
  if (db) {
    const row = await db.one<CityRow>('SELECT * FROM cities WHERE id = ?', id)
    if (row) { registerCity(JSON.parse(row.city) as City); await refreshCity(id); return { status: 'known', id, name } }
  }
  startBuild(id, name, found)
  return { status: 'building', id, name, progress: jobs.get(id)!.progress }
}

const slugOf = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

function startBuild(id: string, name: string, found: NonNullable<Awaited<ReturnType<typeof findArticle>>>) {
  const job: BuildJob = { id, name, status: 'building', progress: `Finding the ${name} guide`, startedAt: Date.now() }
  jobs.set(id, job)
  ;(async () => {
    let rates: ((code: string) => number | undefined) | undefined
    if (db) {
      const fx = await getRates(db, 'USD').catch(() => null)
      if (fx) rates = code => fx.rates[code]
    }
    const city = await buildCity(found, { rates, progress: text => { job.progress = text } })
    await saveCity(city)
    registerCity(city)
    await refreshCity(city.id)
    job.status = 'ready'
    job.progress = `${city.places.length} places and ${city.hotels.length} stays`
    console.log(`[cities] built ${city.name}: ${city.places.length} places, ${city.hotels.length} stays`)
    profileCityInBackground(city.id)
  })().catch(err => {
    job.status = 'failed'
    job.error = err instanceof BuildError ? err.message : `Couldn’t build ${name}: ${(err as Error).message}`
    console.warn('[cities] build failed', name, err)
  })
}

// Small, for lists: every city the app can plan right now.
export const knownCities = () => CITIES.map(c => ({ id: c.id, name: c.name, country: c.country, places: c.places.length, built: c.built ?? null }))
