import type { DayPlan, Hotel, HotelScore, Leg, LngLat, Place, Stop, TripBrief, Vibe } from '../types'
import { estimateTravel, haversineKm, kmeans } from './geo'
import { resolveBudgetTier } from './intake'

// Deterministic planning primitives shared by the offline MockPlanner (browser)
// and the Claude planning agent (server). Claude decides *what* and *in which
// order*; these turn a decision into timed stops, legs and hotel scores.

export const DAY_COLORS = ['#ffd23f', '#ff6fae', '#2ed3c0', '#a78bfa', '#ff8c42']

export const BEST_AT_RANK = { morning: 0, midday: 1, evening: 2, night: 3 } as const
export const EARLIEST = { morning: 0, midday: 11 * 60 + 30, evening: 17 * 60 + 30, night: 20 * 60 } as const
export const PACE = {
  slow: { perDay: 4, buffer: 25, start: 9 * 60 + 45 },
  balanced: { perDay: 5, buffer: 15, start: 9 * 60 },
  packed: { perDay: 6, buffer: 10, start: 8 * 60 + 30 },
}

// The pace slider's five steps, slowest first; `PACE` above is the same thing by name.
const PACE_STEPS = [
  { perDay: 3, buffer: 35, start: 10 * 60 },
  { perDay: 4, buffer: 25, start: 9 * 60 + 45 },
  { perDay: 5, buffer: 15, start: 9 * 60 },
  { perDay: 6, buffer: 10, start: 8 * 60 + 30 },
  { perDay: 7, buffer: 5, start: 8 * 60 },
]

export interface DayShape {
  perDay: number    // stops
  buffer: number    // minutes between stops
  start: number     // minutes after midnight
  walkKm: number    // further than this, take transit
  visit: number     // multiplies each place's visit length
}

// What a day looks like for this trip: its pace, shaped by the chat's sliders. Every slider
// left alone (or in the middle) changes nothing here.
export function dayShape(brief: TripBrief): DayShape {
  const base = brief.paceLevel !== undefined ? PACE_STEPS[Math.round(brief.paceLevel * 4)] : PACE[brief.pace ?? 'balanced']
  const loose = brief.structure ?? 0.5
  const kids = brief.kids ?? 0
  const walk = brief.walking ?? 0.5
  return {
    // loose days and little ones both mean a stop fewer
    perDay: Math.max(2, base.perDay - (loose >= 0.75 ? 1 : 0) - (kids >= 0.5 ? 1 : 0)),
    buffer: Math.max(5, Math.round(base.buffer + (loose - 0.5) * 30 + kids * 10)),
    // early bird out by 7:30, night owl from 10:30
    start: Math.max(7 * 60, base.start + Math.round(((brief.rhythm ?? 0.5) - 0.5) * 12) * 15),
    // 600 m before a ride for short walks, 1.4 km in the middle, 3 km for keen walkers
    walkKm: walk < 0.5 ? 0.6 + 1.6 * walk : 1.4 + 3.2 * (walk - 0.5),
    visit: 1 - 0.25 * kids,
  }
}

export function scorePlace(p: Place, brief: TripBrief): { score: number; why: string } {
  const tier = resolveBudgetTier(brief)
  const hits = p.tags.filter(t => brief.vibes.includes(t))
  let score = 1 + hits.length * 2
  if (!brief.vibes.length) score += p.tags.length * 0.3
  if (tier === 'shoestring' && p.price >= 3) score -= 3
  if (tier === 'shoestring' && p.price === 0) score += 0.8
  if (tier === 'luxury' && p.price >= 2) score += 0.8
  if ((brief.travelers ?? 2) >= 4 && p.kind === 'bar' && p.minutes < 60) score -= 1
  // remembered tastes ("traditional", "japanese") pull matching places up everywhere
  const loved = (brief.tastes ?? []).filter(t => p.keywords?.includes(t))
  score += loved.length * 1.5
  // How well known a place should be for this traveller: a first-timer wants the famous top band;
  // someone who knows the city wants the broad middle, places people who care know of but the
  // coach tours don't. Not the very bottom: places nobody has written about at all are as often
  // forgettable as hidden.
  const local = brief.familiarity ?? 0
  if (p.rank !== undefined) {
    const lo = 0.8 - 0.55 * local
    const hi = 1 - 0.4 * local
    const off = p.rank < lo ? lo - p.rank : p.rank > hi ? p.rank - hi : 0
    score += 4 * Math.max(0, 1 - off * 2.5)
  }
  const tuned = tuning(p, brief)
  score += tuned.score
  const gem = local >= 0.6 && p.rank !== undefined && p.rank <= 0.4
  const icon = local <= 0.4 && p.rank !== undefined && p.rank >= 0.8
  const why = loved.length ? `your kind of thing: ${loved.join(' + ')}`
    : tuned.why ? tuned.why
    : gem ? 'off the tourist trail'
    : icon ? 'a must on a first visit'
    : hits.length ? `matches ${hits.join(' + ')}`
    : tier === 'shoestring' && p.price >= 3 ? 'over budget' : brief.vibes.length ? 'weak vibe match' : 'a local favourite'
  return { score, why }
}

// What the other sliders do to one place's score. Each term is zero with its slider in the middle.
function tuning(p: Place, brief: TripBrief): { score: number; why?: string } {
  const off = (v: number | undefined) => (v ?? 0.5) - 0.5   // -0.5 … 0.5
  const has = (...t: Vibe[]) => t.some(x => p.tags.includes(x))
  const eats = p.kind === 'food' || p.kind === 'cafe' || (p.kind === 'market' && has('food'))
  const late = p.bestAt === 'night' ? 1 : p.bestAt === 'evening' ? 0.5 : p.bestAt === 'morning' ? -1 : 0
  const calm = p.kind === 'park' || p.kind === 'cafe' || has('relaxed', 'romantic')
  const thrill = has('adventure', 'nightlife')
  const roam = p.kind === 'park' || p.kind === 'market' || (p.kind === 'sight' && p.minutes >= 90)
  const kids = brief.kids ?? 0
  const crowds = brief.crowds ?? 0
  let score = 0
  score += off(brief.rhythm) * 3 * late                                        // night owl: late places
  score += eats ? off(brief.foodie) * 4 : 0                                    // live to eat: more food
  score += off(brief.splurgeOn) * 2 * (p.price >= 2 ? 1 : p.price === 0 ? -0.5 : 0) // spend on doing, not sleeping
  score += off(brief.energy) * 3 * ((thrill ? 1 : 0) - (calm ? 1 : 0))         // adventurous vs chill
  score += roam ? off(brief.structure) * 2 : 0                                 // wanderers: places to roam
  if (p.rank !== undefined && p.rank > 0.7) score -= crowds * 3 * (p.rank - 0.7) / 0.3 // the busiest sights
  if (kids) score += kids * (p.kind === 'bar' || p.bestAt === 'night' ? -5 : p.kind === 'park' || p.kind === 'museum' ? 1.5 : 0)
  const why = kids >= 0.5 && (p.kind === 'park' || p.kind === 'museum') ? 'good with little ones'
    : off(brief.rhythm) >= 0.25 && late >= 0.5 ? 'for a night owl'
    : off(brief.rhythm) <= -0.25 && late < 0 ? 'for an early start'
    : off(brief.foodie) >= 0.25 && eats ? 'one for the foodie'
    : undefined
  return { score, why }
}

// How a day's route is judged, in minutes of travel. Evening and night stops
// must come in that order, after the daytime ones. Morning vs midday is only a
// preference: a morning spot may slide later when that saves real travel.
const DAY_SLOT = { morning: 0, midday: 0, evening: 1, night: 2 } as const
const OUT_OF_SLOT = 1000
const LATE_MORNING = 8
const LUNCH_FIRST = 15

function routeCost(route: Place[]): number {
  let cost = 0
  let slot = 0
  let middaySeen = false
  route.forEach((p, i) => {
    const at = p.bestAt ?? 'midday'
    if (i > 0) cost += estimateTravel(route[i - 1].coord, p.coord).minutes
    else if (at === 'midday' && p.kind === 'food') cost += LUNCH_FIRST
    if (DAY_SLOT[at] < slot) cost += OUT_OF_SLOT
    slot = Math.max(slot, DAY_SLOT[at])
    if (at === 'midday') middaySeen = true
    else if (at === 'morning' && middaySeen) cost += LATE_MORNING
  })
  return cost
}

// Untangle a route: keep reversing stretches and moving single stops while that helps.
function untangle(start: Place[]): Place[] {
  let route = start
  let cost = routeCost(route)
  for (let improved = true; improved;) {
    improved = false
    for (let i = 0; i < route.length; i++) {
      for (let j = 0; j < route.length; j++) {
        if (i === j) continue
        const moved = [...route]
        moved.splice(j, 0, moved.splice(i, 1)[0])
        const reversed = i < j ? [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)] : moved
        for (const next of [moved, reversed]) {
          const c = routeCost(next)
          if (c < cost - 0.001) { route = next; cost = c; improved = true }
        }
      }
    }
  }
  return route
}

export function orderDay(places: Place[]): Place[] {
  const sorted = [...places].sort((a, b) => BEST_AT_RANK[a.bestAt ?? 'midday'] - BEST_AT_RANK[b.bestAt ?? 'midday'])
  // the first stop shapes the whole route, so try the first few as the opener
  let best = sorted
  let bestCost = Infinity
  for (let i = 0; i < Math.min(sorted.length, 8); i++) {
    const route = untangle([sorted[i], ...sorted.filter((_, n) => n !== i)])
    const cost = routeCost(route)
    if (cost < bestCost) { best = route; bestCost = cost }
  }
  return best
}

// Beyond distance, a comfortable day isn't far bigger than the others, doesn't
// stack evening stops into the small hours, and has no haul across town: one
// 30-minute hop feels far worse than three 10-minute ones, and on the map it
// reads as a stop on the wrong day.
const UNEVEN = 4
const EXTRA_EVENING = 30
const WORTH_MOVING = 3
const LONG_HOP = 18
const LONG_HOP_WEIGHT = 2

const hopPenalty = (route: Place[]) =>
  route.slice(1).reduce((sum, p, i) => sum + LONG_HOP_WEIGHT * Math.max(0, estimateTravel(route[i].coord, p.coord).minutes - LONG_HOP), 0)

function discomfort(route: Place[], target: number): number {
  const evenings = route.filter(p => DAY_SLOT[p.bestAt ?? 'midday'] > 0).length
  return routeCost(route) + UNEVEN * (route.length - target) ** 2 + EXTRA_EVENING * Math.max(0, evenings - 2) + hopPenalty(route)
}

// Hand stops to another day (or swap them) wherever that makes the whole trip
// more comfortable. Grouping by distance alone can't see this: it never checks
// the routes that come out of it.
export function rebalanceDays(days: Place[][], cap: number): Place[][] {
  const lists = days.map(orderDay)
  const target = lists.flat().length / Math.max(1, lists.length)
  const room = Math.max(cap, Math.ceil(target) + 1) // keeping more places than the pace plans for must not freeze the days
  const dayCost = (route: Place[]) => discomfort(route, target)
  const insert = (route: Place[], p: Place) => {
    let best: Place[] = [p, ...route]
    let bestCost = dayCost(best)
    for (let i = 1; i <= route.length; i++) {
      const next = [...route.slice(0, i), p, ...route.slice(i)]
      const c = dayCost(next)
      if (c < bestCost) { best = next; bestCost = c }
    }
    return best
  }
  for (let round = 0; round < 30; round++) {
    let gain = WORTH_MOVING
    let apply: (() => void) | undefined
    lists.forEach((from, a) => lists.forEach((to, b) => {
      if (a === b) return
      const now = dayCost(from) + dayCost(to)
      for (const p of from) {
        const rest = from.filter(x => x !== p)
        if (!rest.length) continue
        if (to.length < room) {
          const into = insert(to, p)
          const g = now - dayCost(rest) - dayCost(into)
          if (g > gain) { gain = g; apply = () => { lists[a] = orderDay(rest); lists[b] = orderDay(into) } }
        }
        if (a > b) continue // each swap only needs checking once
        for (const q of to) {
          const fromNext = insert(rest, q)
          const toNext = insert(to.filter(x => x !== q), p)
          const g = now - dayCost(fromNext) - dayCost(toNext)
          if (g > gain) { gain = g; apply = () => { lists[a] = orderDay(fromNext); lists[b] = orderDay(toNext) } }
        }
      }
    }))
    if (!apply) break
    apply()
  }
  return lists
}

// Grouping depends on which stop it starts from, and trading stops afterwards
// can't always undo a poor start, so try a few and keep the most comfortable trip.
const STARTS = 4

export function groupDays(places: Place[], days: number, perDay: number, maxPerGroup?: number): Place[][] {
  let best: Place[][] = []
  let bestCost = Infinity
  for (let s = 0; s < STARTS; s++) {
    const from = Math.floor((s * places.length) / STARTS)
    const groups = rebalanceDays(kmeans([...places.slice(from), ...places.slice(0, from)], days, maxPerGroup), perDay + 1)
    const target = places.length / Math.max(1, groups.length)
    const cost = groups.reduce((sum, g) => sum + discomfort(g, target), 0)
    if (cost < bestCost) { best = groups; bestCost = cost }
  }
  return best
}

export function buildDay(day: number, places: Place[], brief: TripBrief, opts: { keepOrder?: boolean; start?: number; title?: string } = {}): DayPlan {
  const pace = dayShape(brief)
  const color = DAY_COLORS[(day - 1) % DAY_COLORS.length]
  const stops: Stop[] = []
  const legs: Leg[] = []
  let clock = opts.start ?? pace.start
  ;(opts.keepOrder ? places : orderDay(places)).forEach((place, i) => {
    let legIn: Leg | undefined
    if (i > 0) {
      const prev = stops[i - 1]
      const t = estimateTravel(prev.place.coord, place.coord, pace.walkKm)
      legIn = { id: `d${day}-${i}`, day, from: prev.place.coord, to: place.coord, kind: 'stop', ...t }
      legs.push(legIn)
      clock = prev.depart + prev.bufferAfter + t.minutes
      const earliest = EARLIEST[place.bestAt ?? 'midday']
      if (clock < earliest) {
        prev.bufferAfter += earliest - clock // turn the gap into free time, not dead air
        clock = earliest
      }
    }
    stops.push({ place, arrive: clock, depart: clock + Math.round(place.minutes * pace.visit), bufferAfter: pace.buffer, legIn })
  })
  const first = stops[0]?.place.name.split(/[ &(]/)[0]
  const last = stops[stops.length - 1]?.place.name.split(/[ &(]/)[0]
  return { day, color, stops, legs, title: opts.title ?? (first === last ? first : `${first} → ${last}`) }
}

export function hotelLegs(hotel: Hotel, days: DayPlan[]): DayPlan[] {
  return days.map(d => {
    if (!d.stops.length) return d
    const firstStop = d.stops[0]
    const lastStop = d.stops[d.stops.length - 1]
    const out = estimateTravel(hotel.coord, firstStop.place.coord)
    const back = estimateTravel(lastStop.place.coord, hotel.coord)
    return {
      ...d,
      legs: [
        { id: `d${d.day}-out`, day: d.day, from: hotel.coord, to: firstStop.place.coord, kind: 'hotel', ...out },
        ...d.legs.filter(l => l.kind !== 'hotel'),
        { id: `d${d.day}-back`, day: d.day, from: lastStop.place.coord, to: hotel.coord, kind: 'hotel', ...back },
      ],
    }
  })
}

export function scoreHotel(h: Hotel, brief: TripBrief, days: DayPlan[]): HotelScore {
  const tier = resolveBudgetTier(brief)
  const rooms = Math.ceil((brief.travelers ?? 2) / 2)
  const nights = Math.max(1, (brief.days ?? 3) - 0)
  const target = brief.budgetAmount
    ? (brief.budgetAmount * 0.4) / nights / rooms
    : { shoestring: 90, comfort: 220, luxury: 450 }[tier]
  // spending on food and experiences leaves less for the room, and the other way round
  const stayTarget = target * (1.3 - 0.6 * (brief.splurgeOn ?? 0.5))
  const ends: LngLat[] = days.flatMap(d => (d.stops.length ? [d.stops[0].place.coord, d.stops[d.stops.length - 1].place.coord] : []))
  const avgCommute = ends.reduce((s, p) => s + estimateTravel(h.coord, p).minutes, 0) / Math.max(1, ends.length)
  const priceFit = Math.max(0, 1 - Math.abs(h.nightly - stayTarget) / stayTarget)
  const vibeHits = h.tags.filter(t => brief.vibes.includes(t as Vibe)).length
  const vibeFit = brief.vibes.length ? Math.min(1, vibeHits / Math.min(2, brief.vibes.length)) : 0.5
  const commuteFit = Math.max(0, Math.min(1, 1 - (avgCommute - 8) / 40))
  return { hotel: h, avgCommute, priceFit, vibeFit, total: commuteFit * 0.5 + priceFit * 0.3 + vibeFit * 0.2 }
}

export function withHotel(hotel: Hotel, days: DayPlan[]): DayPlan[] {
  return hotelLegs(hotel, days)
}

// ── Editing primitives ────────────────────────────────────────────────────────
// Shared by the planners and by manual edits in the UI, so a hand-edited day
// gets exactly the same timing rules as a generated one.

const rank = (p: Place) => BEST_AT_RANK[p.bestAt ?? 'midday']

// Re-time a day after its stop list changed, keeping its start time and colour.
export function rebuildDay(prev: DayPlan, places: Place[], brief: TripBrief, hotel?: Hotel): DayPlan {
  const plan = buildDay(prev.day, places, brief, { keepOrder: true, start: prev.stops[0]?.arrive })
  return hotel ? hotelLegs(hotel, [plan])[0] : plan
}

// Cheapest place to slot a new stop in: least added distance, without putting
// a night spot before a morning one.
export function bestInsertIndex(places: Place[], p: Place): number {
  let best = places.length
  let bestCost = Infinity
  for (let i = 0; i <= places.length; i++) {
    const a = places[i - 1]
    const b = places[i]
    let cost = (a ? haversineKm(a.coord, p.coord) : 0) + (b ? haversineKm(p.coord, b.coord) : 0) - (a && b ? haversineKm(a.coord, b.coord) : 0)
    if (a && rank(a) > rank(p)) cost += 4
    if (b && rank(b) < rank(p)) cost += 4
    if (cost < bestCost) { bestCost = cost; best = i }
  }
  return best
}

export interface GapFill { day: number; after: number; place: Place; gap: number }

// Long idle stretches (usually waiting for an evening stop) are where a plan
// feels thin. Suggest the nearest unused place that fits inside the gap.
export function findGapFill(day: DayPlan, pool: Place[], brief: TripBrief, minGap = 90, maxKm = 4.5): GapFill | undefined {
  const buffer = dayShape(brief).buffer
  for (let i = 0; i < day.stops.length - 1; i++) {
    const s = day.stops[i]
    const gap = s.bufferAfter - buffer
    if (gap < minGap) continue
    const fits = pool
      .filter(p => rank(p) <= 2 && p.minutes + 2 * estimateTravel(s.place.coord, p.coord).minutes <= gap)
      .map(p => ({ p, km: haversineKm(s.place.coord, p.coord) + (brief.vibes.some(v => p.tags.includes(v)) ? 0 : 1.5) }))
      .filter(x => x.km < maxKm)
      .sort((a, b) => a.km - b.km)
    if (fits.length) return { day: day.day, after: i, place: fits[0].p, gap }
  }
  return undefined
}

export function applyGapFill(day: DayPlan, fill: GapFill, brief: TripBrief, hotel?: Hotel): DayPlan {
  const places = day.stops.map(s => s.place)
  places.splice(fill.after + 1, 0, fill.place)
  return rebuildDay(day, places, brief, hotel)
}

// ── Swipe deck ────────────────────────────────────────────────────────────────

export interface DeckCard { id: string; why: string; match: number }

// Best matches first, so a user who stops early still has a good trip.
// A city with more places than anyone could weigh (London has ~1,600): the ones worth
// considering for this brief, best first, with every kind of place in the mix so a museum trip
// still eats. The travellers' own finds always stay. Small hand-picked cities pass through whole.
export const SHORTLIST = 120
export function shortlist(places: Place[], brief: TripBrief, n = SHORTLIST): Place[] {
  if (places.length <= n) return places
  const scored = places.map(p => ({ p, score: scorePlace(p, brief).score })).sort((a, b) => b.score - a.score)
  const out = new Set(scored.filter(x => x.p.custom).map(x => x.p))
  const kinds = [...new Set(places.map(p => p.kind))]
  const each = Math.max(2, Math.floor(n / (kinds.length * 3)))
  for (const k of kinds) for (const x of scored.filter(x => x.p.kind === k).slice(0, each)) out.add(x.p)
  for (const x of scored) { if (out.size >= n) break; out.add(x.p) }
  const rank = new Map(scored.map((x, i) => [x.p.id, i]))
  return [...out].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
}

export function buildDeck(places: Place[], brief: TripBrief): DeckCard[] {
  const scored = places.map(p => ({ p, ...scorePlace(p, brief) }))
  const top = Math.max(...scored.map(s => s.score))
  return scored
    .sort((a, b) => b.score - a.score)
    .map(s => ({ id: s.p.id, why: s.why, match: Math.max(0.15, s.score / top) }))
}
