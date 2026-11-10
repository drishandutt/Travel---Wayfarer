import type { City, TripBrief } from '../types'
import { cityById, registerCity } from './cities'

// The browser's side of the city catalog (server/cities). A trip's city is fetched when the
// trip opens, hand-made or built, so it carries every traveller's promoted finds and the
// profiles the server has learned; a city nobody has mapped yet is built on request.

const fetched = new Map<string, Promise<City | undefined>>()

// The city, registered into the catalog. Once per session unless `force`; a city the server
// can't be reached for stays as the app shipped it (or absent, for a built one).
export function ensureCity(id: string, force = false): Promise<City | undefined> {
  if (!force) {
    const running = fetched.get(id)
    if (running) return running
  }
  const run = (async () => {
    try {
      const res = await fetch(`/api/cities/${encodeURIComponent(id)}`)
      if (!res.ok) return cityById(id)
      const city = (await res.json()) as City
      if (!city?.id || !Array.isArray(city.places)) return cityById(id)
      return registerCity(city)
    } catch {
      return cityById(id)
    }
  })()
  fetched.set(id, run)
  return run
}

export type CityLookup =
  | { status: 'known'; id: string; name: string }
  | { status: 'building'; id: string; name: string; progress: string }
  | { status: 'failed'; id: string; name: string; error: string }
  | { status: 'unknown' }

// The city a message names, built from public guides if the app doesn't have it yet.
export async function lookupCity(text: string): Promise<CityLookup> {
  const res = await fetch('/api/cities/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `Couldn’t look that city up (error ${res.status}).`)
  return res.json()
}

export interface BuildStatus { id: string; name: string; status: 'building' | 'ready' | 'failed'; progress: string; error?: string }

// Waits for a build to finish, reporting progress, then registers the city. Rejects if it fails.
export async function waitForCity(id: string, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<City> {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < 5 * 60_000) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const res = await fetch(`/api/cities/${encodeURIComponent(id)}/status`)
    const s = (await res.json()) as BuildStatus & { error?: string }
    if (!res.ok) throw new Error(s.error ?? 'The city build was lost.')
    if (s.status === 'failed') throw new Error(s.error ?? `Couldn’t build ${s.name}.`)
    if (s.status === 'ready') {
      const city = await ensureCity(id, true)
      if (!city) throw new Error(`Couldn’t load ${s.name}.`)
      return city
    }
    if (s.progress !== last) { last = s.progress; onProgress?.(s.progress) }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Building the city is taking too long. Try again in a minute.')
}

// What a traveller kept and skipped on the deck, so the places learn who they suit. Fire and forget.
export function sendSignals(cityId: string, liked: string[], rejected: string[], brief: TripBrief): void {
  if (!liked.length && !rejected.length) return
  const { customPlaces, moneyGroupId, ...rest } = brief
  void customPlaces; void moneyGroupId
  fetch(`/api/cities/${encodeURIComponent(cityId)}/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liked, rejected, brief: rest }), keepalive: true }).catch(() => {})
}
