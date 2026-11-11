import type { LngLat, Transport, TravelMode, TravelOption } from '../types'

const R = 6371

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// How much slower getting around is at rush hour, by city: roads and trains that jam badly at
// peak times. Until there's a routing API, a rough factor, with a middling one for the rest.
const RUSH: Record<string, number> = {
  mumbai: 1.8, delhi: 1.7, 'new-delhi': 1.7, bangalore: 1.9, bengaluru: 1.9, kolkata: 1.6, chennai: 1.6, hyderabad: 1.6, pune: 1.6,
  jakarta: 1.9, manila: 1.9, bangkok: 1.7, 'ho-chi-minh-city': 1.6, dhaka: 2, karachi: 1.7, lagos: 1.9, nairobi: 1.7, cairo: 1.7,
  istanbul: 1.6, 'mexico-city': 1.6, 'sao-paulo': 1.6, bogota: 1.6, lima: 1.6, 'los-angeles': 1.5, dubai: 1.3, rome: 1.3, paris: 1.25,
  'new-york-city': 1.3, london: 1.2, lisbon: 1.2, tokyo: 1.05, seoul: 1.15, singapore: 1.1, 'hong-kong': 1.1,
}
export const trafficOf = (cityId?: string): number => (cityId ? RUSH[cityId] ?? 1.3 : 1.3)
// mornings 8–10:30 and evenings 17:00–20:30, with the shoulders in between
function rushAt(at: number): number {
  const h = (at / 60) % 24
  if ((h >= 8 && h < 10.5) || (h >= 17 && h < 20.5)) return 1
  if ((h >= 7.5 && h < 11) || (h >= 16.5 && h < 21)) return 0.5
  return 0
}

// Heuristic travel model. Swap for a routing API (OSRM / Mapbox / Google) later;
// callers only depend on { mode, minutes, km }.
// `walkKm`: how far they'll walk before taking transit (the walking slider; 1.4 km by default).
// `when`: leaving at `at` (minutes after midnight) in a city with that rush-hour `traffic`.
export function estimateTravel(a: LngLat, b: LngLat, walkKm = 1.4, when?: { at: number; traffic: number }): { mode: TravelMode; minutes: number; km: number } {
  const km = haversineKm(a, b) * 1.3 // street-network detour factor
  if (km <= walkKm) return { mode: 'walk', minutes: Math.max(4, Math.round((km / 4.6) * 60)), km }
  const ride = (km / 22) * 60
  const slow = when ? 1 + (when.traffic - 1) * rushAt(when.at) : 1
  return { mode: 'transit', minutes: Math.round(8 + ride * slow), km }
}

// Gently curved line between two points: avoids pretending we know the street
// route before a routing provider is wired in, without bowing so far that the
// hop looks longer than it is.
export function arc(a: LngLat, b: LngLat, steps = 48, bend = 0.06): LngLat[] {
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const cx = mx - dy * bend
  const cy = my + dx * bend
  const pts: LngLat[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]])
  }
  return pts
}

export function centroid(points: LngLat[]): LngLat {
  const s = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0])
  return [s[0] / points.length, s[1] / points.length]
}

// Tiny k-means on lng/lat; good enough to group a city's stops into day-sized neighbourhoods.
export function kmeans<T extends { coord: LngLat }>(items: T[], k: number, maxPerGroup?: number): T[][] {
  if (k <= 1 || items.length <= k) return k <= 1 ? [items] : items.map(i => [i])
  // farthest-point seeding gives stable, well-spread days
  const seeds: LngLat[] = [items[0].coord]
  while (seeds.length < k) {
    let best = items[0].coord
    let bestD = -1
    for (const it of items) {
      const d = Math.min(...seeds.map(s => haversineKm(s, it.coord)))
      if (d > bestD) { bestD = d; best = it.coord }
    }
    seeds.push(best)
  }
  for (let iter = 0; iter < 8; iter++) {
    const groups: T[][] = seeds.map(() => [])
    for (const it of items) {
      let gi = 0
      let gd = Infinity
      seeds.forEach((s, i) => { const d = haversineKm(s, it.coord); if (d < gd) { gd = d; gi = i } })
      groups[gi].push(it)
    }
    groups.forEach((g, i) => { if (g.length) seeds[i] = centroid(g.map(x => x.coord)) })
  }
  // Capacity pass: plain k-means can leave one day with 3 stops and another with 8.
  // Greedily hand out the closest (item, centroid) pairs while each day has room.
  // One stop of slack keeps an outlier with its neighbours instead of across town;
  // callers can allow more (a full day's worth) when geography matters most.
  const cap = Math.max(Math.ceil(items.length / k) + 1, maxPerGroup ?? 0)
  const pairs = items.flatMap(it => seeds.map((s, gi) => ({ it, gi, d: haversineKm(s, it.coord) }))).sort((a, b) => a.d - b.d)
  const balanced: T[][] = seeds.map(() => [])
  const placed = new Set<T>()
  for (const { it, gi } of pairs) {
    if (placed.has(it) || balanced[gi].length >= cap) continue
    balanced[gi].push(it)
    placed.add(it)
  }
  return balanced.filter(g => g.length)
}

export function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = Math.round(min % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Every sensible way to make a hop, for the route tooltip. The "best" option
// matches estimateTravel(), which is what the itinerary timings use.
export function travelOptions(a: LngLat, b: LngLat, t: Transport, travelers = 2): TravelOption[] {
  const best = estimateTravel(a, b)
  const km = best.km
  const walkMin = Math.max(4, Math.round((km / 4.6) * 60))
  const transitMin = Math.round(8 + (km / 22) * 60)
  const taxiMin = Math.round(4 + (km / 20) * 60)
  const cars = Math.ceil(travelers / 4)
  const options: TravelOption[] = [
    { mode: 'walk', label: 'Walk', minutes: walkMin, cost: 0, best: best.mode === 'walk' },
    { mode: 'transit', label: t.transitName, minutes: transitMin, cost: t.transitFare * travelers, best: best.mode === 'transit' },
    { mode: 'taxi', label: 'Taxi', minutes: taxiMin, cost: (t.taxiBase + t.taxiPerKm * km) * cars, best: false },
  ]
  // a 75-minute walk isn't an option worth showing
  return options.filter(o => o.mode !== 'walk' || o.minutes <= 45 || o.best)
}

export function fmtCost(usd: number): string {
  if (usd <= 0) return 'free'
  return usd < 10 ? `≈ $${usd.toFixed(usd < 3 ? 1 : 0)}` : `≈ $${Math.round(usd)}`
}
