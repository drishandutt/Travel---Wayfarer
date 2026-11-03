import { isWelcome, type SavedTrip, type TripState } from './tripStore'
import { cityById } from '../data/cities'

// Browser-local persistence. Swap for a real backend (Supabase/Postgres) later:
// the rest of the app only sees load/save/delete of SavedTrip objects.

const TRIPS = 'wayfarer:trips'
const CURRENT = 'wayfarer:current'

// Trips kept in this browser belong to whoever is signed in, so someone else using the same
// device doesn't see them. Anything saved before there were accounts goes to the first person
// to sign in here.
let scope = ''

export function setTripScope(userId: string | null) {
  scope = userId ? `:${userId}` : ''
  if (!userId) return
  for (const key of [TRIPS, CURRENT]) {
    try {
      const old = localStorage.getItem(key)
      if (old === null) continue
      if (localStorage.getItem(key + scope) === null) localStorage.setItem(key + scope, old)
      localStorage.removeItem(key)
    } catch {
      // storage blocked: nothing to move
    }
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full or blocked (private mode): the app still works, it just won't remember
  }
}

// crypto.randomUUID only exists on secure origins (https / localhost); opened from
// a phone over plain http://192.168.x.x it's undefined, so fall back to
// getRandomValues, which works everywhere.
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function snapshot(s: TripState, id = s.tripId ?? newId()): SavedTrip {
  const city = cityById(s.brief.destination)
  const days = s.brief.days ?? s.days.length
  return {
    id,
    name: `${city?.name ?? 'Trip'} · ${days} day${days > 1 ? 's' : ''}${s.brief.vibes.length ? ` · ${s.brief.vibes.slice(0, 2).join(' & ')}` : ''}`,
    savedAt: Date.now(),
    brief: s.brief,
    days: s.days,
    hotel: s.hotel,
    hotelScores: s.hotelScores,
    candidates: s.candidates,
    messages: s.messages.filter(m => !isWelcome(m)).slice(-12),
  }
}

export const loadTrips = () => read<SavedTrip[]>(TRIPS + scope, [])

export function saveTrip(trip: SavedTrip): SavedTrip[] {
  const trips = [trip, ...loadTrips().filter(t => t.id !== trip.id)]
  write(TRIPS + scope, trips)
  return trips
}

export function deleteTrip(id: string): SavedTrip[] {
  const trips = loadTrips().filter(t => t.id !== id)
  write(TRIPS + scope, trips)
  return trips
}

// The in-progress trip, so a refresh never loses work.
// The saved copy a group's row in My trips stands for: the newest one linked to it.
export function groupCopyOf(trips: SavedTrip[], groupId: string): SavedTrip | undefined {
  return trips.filter(t => t.brief.moneyGroupId === groupId).sort((a, b) => b.savedAt - a.savedAt)[0]
}

export const loadCurrent = () => read<SavedTrip | null>(CURRENT + scope, null)
export const saveCurrent = (trip: SavedTrip | null) => write(CURRENT + scope, trip)

// What this browser has of a group's trip, from before its plan was shared.
export function localCopyOf(groupId: string): SavedTrip | null {
  const current = loadCurrent()
  return current?.brief.moneyGroupId === groupId ? current : groupCopyOf(loadTrips(), groupId) ?? null
}

// Which side panels the viewer has tucked away.
export interface PanelPrefs { chat: boolean; journal: boolean }
const PANELS = 'wayfarer:panels'
export const loadPanels = () => read<PanelPrefs>(PANELS, { chat: false, journal: false })
export const savePanels = (p: PanelPrefs) => write(PANELS, p)

// Ticked packing / booking items on a trip's dashboard.
const CHECKS = 'wayfarer:checks:'
export const loadChecks = (key: string) => read<Record<string, boolean>>(CHECKS + key, {})
export const saveChecks = (key: string, v: Record<string, boolean>) => write(CHECKS + key, v)
