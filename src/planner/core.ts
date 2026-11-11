import type { DayPlan, Hotel, HotelScore, Leg, LngLat, Place, Stop, TripBrief, Vibe } from '../types'
import { estimateTravel, haversineKm, kmeans, trafficOf } from './geo'
import { resolveBudgetTier } from './intake'
import { audiencesOf, profileFit, profileOf } from './profile'
import { arrivalFloor, isSpecial, moodFit } from './story'

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
  // who it suits, from its profile: what the guides and travellers who kept it say
  const fit = profileFit(p, brief, audiencesOf(brief))
  score += fit.score
  // what they told us: the feel, the occasion, the people, against the place's own mood words
  const mood = moodFit(p, brief)
  score += mood.score
  // the kinds of place a vibe is really about: a nightlife trip is bars first, not gardens
  const kind = kindFit(p, brief)
  score += kind
  // searched for this very mood by someone who knows the city (server/cities/vibeSearch.ts)
  if (p.found?.via === 'vibe' && brief.story) score += 1.5
  // a trip meant to be remembered: the memorable over the everyday, for eating, drinking and doing
  const special = isSpecial(brief) ? specialFit(p) : 0
  score += special
  const gem = local >= 0.6 && p.rank !== undefined && p.rank <= 0.4
  const icon = local <= 0.4 && p.rank !== undefined && p.rank >= 0.8
  const why = special >= 2 && memorable(p) ? (p.kind === 'food' ? 'a dinner to remember' : p.kind === 'bar' ? 'a night to remember' : 'one to remember')
    : mood.match ? `fits your ${mood.match}`
    : loved.length ? `your kind of thing: ${loved.join(' + ')}`
    : tuned.why ? tuned.why
    : fit.why ? fit.why
    : hits.length && kind > 0 ? `for your ${hits.join(' + ')}`
    : gem ? 'off the tourist trail'
    : icon ? 'a must on a first visit'
    : hits.length ? `matches ${hits.join(' + ')}`
    : tier === 'shoestring' && p.price >= 3 ? 'over budget' : brief.vibes.length ? 'weak vibe match' : 'worth a look'
  return { score, why }
}

// How much a place's kind serves the trip's vibes. Tags say what a place touches on; this says
// what the vibe is mostly made of, so a nightlife trip deals bars and late spots before forts and
// gardens, and a food trip deals restaurants and markets before museums.
const KIND_FIT: Partial<Record<Vibe, (p: Place) => number>> = {
  nightlife: p => (p.kind === 'bar' ? 5 : p.bestAt === 'night' ? 3 : p.kind === 'experience' && p.bestAt === 'evening' ? 2 : p.kind === 'food' && p.bestAt !== 'morning' ? 1 : p.kind === 'park' || p.kind === 'museum' || p.kind === 'market' ? -2 : p.kind === 'sight' && !p.tags.includes('nightlife') ? -1.5 : 0),
  romantic: p => (p.kind === 'food' && p.bestAt !== 'morning' ? 1.5 : p.kind === 'bar' || p.kind === 'viewpoint' || p.kind === 'experience' ? 1.5 : 0),
  food: p => (p.kind === 'food' ? 3 : p.kind === 'cafe' || (p.kind === 'market' && p.tags.includes('food')) ? 2 : p.kind === 'bar' ? 1 : 0),
  nature: p => (p.kind === 'park' ? 3 : p.kind === 'viewpoint' ? 1.5 : 0),
  art: p => (p.kind === 'museum' ? 2.5 : 0),
  culture: p => (p.kind === 'museum' || p.kind === 'sight' ? 1 : p.kind === 'experience' ? 1.5 : 0),
  history: p => (p.kind === 'sight' || p.kind === 'museum' ? 1.5 : 0),
  shopping: p => (p.kind === 'market' ? 2.5 : 0),
  adventure: p => (p.kind === 'experience' ? 2.5 : 0),
  relaxed: p => (p.kind === 'cafe' || p.kind === 'park' ? 1 : 0),
}
// What a special trip wants from a place: the splurge, the view, the thing to do, not the canteen.
export const memorable = (p: Place) => /unforgettable|rooftop|view|sunset|sea[- ]?(facing|view|side|front)|by the sea|waterfront|private|chef|tasting|speakeasy|live (music|jazz|band)|candle|romantic|luxur|iconic|skyline|terrace|yacht|boat|cruise/.test([...(p.moods ?? []), ...(p.keywords ?? []), p.blurb].join(' ').toLowerCase())
const everyday = (p: Place) => /food court|canteen|\bmess\b|lunch home|fast food|\bchain\b|mall/.test(`${p.name} ${p.blurb}`.toLowerCase())
function specialFit(p: Place): number {
  const wow = memorable(p)
  if (p.kind === 'food' || p.kind === 'bar') return (p.price >= 3 ? 1.5 : p.price === 2 ? 0.5 : -2) + (wow ? 2 : 0) - (everyday(p) ? 3 : 0)
  if (p.kind === 'cafe') return p.price <= 1 && !wow ? -1.5 : 0
  if (p.kind === 'experience' || p.kind === 'viewpoint') return 1.5 + (wow ? 1 : 0)
  return 0
}

export function kindFit(p: Place, brief: Pick<TripBrief, 'vibes' | 'kids'>): number {
  if (!brief.vibes.length) return 0
  // little ones along: the kids slider decides about bars and late nights, not the vibe
  const vibes = (brief.kids ?? 0) >= 0.5 ? brief.vibes.filter(v => v !== 'nightlife') : brief.vibes
  // the vibes share the say, so a trip with five vibes isn't pulled five ways at full strength
  const each = vibes.map(v => KIND_FIT[v]?.(p) ?? 0)
  return each.reduce((a, b) => a + b, 0) / Math.max(1, Math.sqrt(brief.vibes.length))
}

// What the other sliders do to one place's score. Each term is zero with its slider in the middle.
// The place's profile says how late, lively, busy and child-friendly it is: from the catalog's
// own columns for most places, from Claude or travellers' swipes where they know better.
function tuning(p: Place, brief: TripBrief): { score: number; why?: string } {
  const off = (v: number | undefined) => (v ?? 0.5) - 0.5   // -0.5 … 0.5
  const has = (...t: Vibe[]) => t.some(x => p.tags.includes(x))
  const prof = profileOf(p)
  const eats = p.kind === 'food' || p.kind === 'cafe' || (p.kind === 'market' && has('food'))
  const late = prof.late * 2 - 1                                               // -1 a morning thing … 1 a night thing
  const mood = prof.lively * 2 - 1                                             // -1 calm … 1 lively
  const roam = p.kind === 'park' || p.kind === 'market' || (p.kind === 'sight' && p.minutes >= 90)
  const kids = brief.kids ?? 0
  const crowds = brief.crowds ?? 0
  let score = 0
  score += off(brief.rhythm) * 3 * late                                        // night owl: late places
  score += eats ? off(brief.foodie) * 4 : 0                                    // live to eat: more food
  score += off(brief.splurgeOn) * 2 * (p.price >= 2 ? 1 : p.price === 0 ? -0.5 : 0) // spend on doing, not sleeping
  score += off(brief.energy) * 3 * mood                                        // adventurous vs chill
  score += roam ? off(brief.structure) * 2 : 0                                 // wanderers: places to roam
  score -= crowds * 6 * Math.max(0, prof.busy - 0.5)                           // the busiest places
  if (kids) score += kids * (prof.kids - 0.5) * 8                              // bars out, parks and museums in
  const why = kids >= 0.5 && prof.kids >= 0.7 ? 'good with little ones'
    : off(brief.rhythm) >= 0.25 && late >= 0.3 ? 'for a night owl'
    : off(brief.rhythm) <= -0.25 && late <= -0.6 ? 'for an early start'
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

// `times`: the traveller's own day (an imported itinerary): a stop with a time starts then (if it
// can be reached by then), and nothing is held back to the time of day a place is best at.
export function buildDay(day: number, places: Place[], brief: TripBrief, opts: { keepOrder?: boolean; start?: number; title?: string; times?: (number | undefined)[] } = {}): DayPlan {
  const pace = dayShape(brief)
  const color = DAY_COLORS[(day - 1) % DAY_COLORS.length]
  const stops: Stop[] = []
  const legs: Leg[] = []
  // nothing before they've arrived and dropped their bags
  let clock = Math.max(opts.start ?? pace.start, arrivalFloor(brief, day) ?? 0)
  const traffic = trafficOf(brief.destination)
  ;(opts.keepOrder ? places : orderDay(places)).forEach((place, i) => {
    let legIn: Leg | undefined
    if (i > 0) {
      const prev = stops[i - 1]
      const t = estimateTravel(prev.place.coord, place.coord, pace.walkKm, { at: prev.depart + prev.bufferAfter, traffic })
      legIn = { id: `d${day}-${i}`, day, from: prev.place.coord, to: place.coord, kind: 'stop', ...t }
      legs.push(legIn)
      clock = prev.depart + prev.bufferAfter + t.minutes
      const earliest = opts.times ? opts.times[i] ?? clock : EARLIEST[place.bestAt ?? 'midday']
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

// Where they told us they're staying, once it's on the map: their base, chosen already.
export function stayHotel(brief: TripBrief): Hotel | undefined {
  const stay = brief.story?.stay
  if (!stay?.coord) return undefined
  return { id: 'my-stay', name: stay.name, coord: stay.coord, nightly: 0, tier: resolveBudgetTier(brief), tags: [], blurb: 'Where you’re staying.' }
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

// Swiping comes in two runs: places to see, then food and drink, each with its own deck.
export type Lane = 'places' | 'food'
export const laneOf = (p: Pick<Place, 'kind' | 'tags'>): Lane =>
  p.kind === 'food' || p.kind === 'cafe' || p.kind === 'bar' || (p.kind === 'market' && p.tags.includes('food')) ? 'food' : 'places'

// Which run the trip leads with: food and drink (the bars are there) for a trip that's about
// nights out or eating, places to see for the rest.
export const leadsWithFood = (brief: Pick<TripBrief, 'vibes' | 'foodie'>) =>
  brief.vibes.includes('nightlife') || (brief.vibes.includes('food') && !brief.vibes.some(v => v === 'culture' || v === 'history' || v === 'art')) || (brief.foodie ?? 0.5) >= 0.75

// The swipe deck in two runs, each best first: the one the trip is about leads, and gets the
// bigger share. `size` caps a big city's runs; a small one deals everything.
export function laneDeck(places: Place[], brief: TripBrief, size?: { places: number; food: number }): DeckCard[] {
  // found for this trip's own mood: always dealt, ahead of the guidebook's places
  const mine = new Set(brief.curated ?? [])
  const run = (lane: Lane, n?: number) => {
    const all = places.filter(p => laneOf(p) === lane)
    const picked = all.filter(p => mine.has(p.id))
    const rest = n ? shortlist(all.filter(p => !mine.has(p.id)), brief, Math.max(0, n - picked.length)) : all.filter(p => !mine.has(p.id))
    return [...buildDeck(picked, brief), ...buildDeck(rest, brief)]
  }
  if (!leadsWithFood(brief)) return [...run('places', size?.places), ...run('food', size?.food)]
  const bigger = size ? Math.max(size.places, size.food) : undefined
  const smaller = size ? Math.min(size.places, size.food) : undefined
  return [...run('food', bigger), ...run('places', smaller)]
}

export function buildDeck(places: Place[], brief: TripBrief): DeckCard[] {
  if (!places.length) return []
  const scored = places.map(p => ({ p, ...scorePlace(p, brief) }))
  const top = Math.max(...scored.map(s => s.score))
  return scored
    .sort((a, b) => b.score - a.score)
    .map(s => ({ id: s.p.id, why: s.why, match: Math.max(0.15, s.score / top) }))
}
