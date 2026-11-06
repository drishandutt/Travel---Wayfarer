import type { City, DayPlan, HotelScore, Place, TripBrief } from '../types'
import type { Candidate } from '../state/tripStore'
import { CITIES, tripCity } from '../data/cities'
import { PACE, bestInsertIndex, buildDay, groupDays, hotelLegs, orderDay, rebalanceDays, scoreHotel, scorePlace, type DeckCard } from './core'
import { centroid, fmtClock, haversineKm } from './geo'
import { resolveBudgetTier } from './intake'

// Live plan editing. A chat request ("swap Skytree for something cheaper and add
// a day") is split into clauses, each clause becomes an operation on a draft of
// the plan, and the draft is re-timed into a new itinerary in one go. Nothing is
// ever thrown away: the caller keeps the previous plan for undo.
//
// This rule-based interpreter is the offline stand-in for an LLM call with
// edit tools; the inputs (request + plan) and output (EditResult) stay the same.

export interface PlanSlice {
  brief: TripBrief
  days: DayPlan[]
  hotel?: HotelScore
  hotelScores: HotelScore[]
  candidates: Record<string, Candidate>
  picks: Record<string, 'like' | 'nope'>
}

export interface EditResult {
  plan: PlanSlice
  changes: string[]       // what happened, for the reply and the planner log
  notes: string[]         // what could not be done, and why
  touchedDays: number[]   // to highlight and frame on the map
  recentre: boolean       // big reshuffle: frame the whole city
  understood: boolean
}

interface Draft {
  city: City
  brief: TripBrief
  lists: Place[][]              // one ordered stop list per day
  starts: (number | undefined)[]
  hotelMode: 'keep' | 'best' | ((s: HotelScore) => number)
  rejected: Set<string>
  touched: Set<number>          // day indexes (0-based)
  recentre: boolean
  changes: string[]
  notes: string[]
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1 }
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }
const GENERIC = new Set(['the', 'and', 'in', 'of', 'de', 'da', 'do', 'at', 'to', 'temple', 'shrine', 'park', 'market', 'museum', 'street', 'garden', 'gardens', 'tower', 'house', 'sky', 'ride', 'lanes'])

const norm = (s: string) => s.replace(/[’‘]/g, "'").normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const words = (s: string) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
const num = (s?: string) => (s === undefined ? undefined : Number.isFinite(Number(s)) ? Number(s) : NUM[s])

// Category words → which places they mean.
const CATEGORIES: { re: RegExp; label: string; test: (p: Place) => boolean }[] = [
  { re: /\b(museums?|galler(y|ies)|exhibitions?)\b/, label: 'museums', test: p => p.kind === 'museum' },
  { re: /\b(art|arty|artsy)\b/, label: 'art', test: p => p.kind === 'museum' || p.tags.includes('art') },
  { re: /\b(bars?|nightlife|drinks?|drinking|clubs?|pubs?|night ?out)\b/, label: 'nightlife', test: p => p.kind === 'bar' || p.tags.includes('nightlife') },
  { re: /\b(cafes?|coffee)\b/, label: 'cafés', test: p => p.kind === 'cafe' },
  { re: /\b(food|restaurants?|eat|eating|meals?|dining|foodie)\b/, label: 'food', test: p => p.kind === 'food' || p.kind === 'cafe' || p.tags.includes('food') },
  { re: /\b(markets?)\b/, label: 'markets', test: p => p.kind === 'market' },
  { re: /\b(parks?|gardens?|nature|green|outdoors?)\b/, label: 'nature', test: p => p.kind === 'park' || p.tags.includes('nature') },
  { re: /\b(shopping|shops?|stores?)\b/, label: 'shopping', test: p => p.tags.includes('shopping') },
  { re: /\b(temples?|shrines?|culture|cultural)\b/, label: 'culture', test: p => p.tags.includes('culture') },
  { re: /\b(history|historic|historical|old town)\b/, label: 'history', test: p => p.tags.includes('history') },
  { re: /\b(views?|viewpoints?|lookouts?|skyline|sunsets?)\b/, label: 'viewpoints', test: p => p.kind === 'viewpoint' },
  { re: /\b(romantic|romance|date)\b/, label: 'romantic spots', test: p => p.tags.includes('romantic') },
  { re: /\b(adventure|adventurous|thrills?)\b/, label: 'adventure', test: p => p.tags.includes('adventure') },
]

// ── helpers on the draft ──────────────────────────────────────────────────────

const planned = (d: Draft) => new Set(d.lists.flat().map(p => p.id))
const dayOfId = (d: Draft, id: string) => d.lists.findIndex(l => l.some(p => p.id === id))
const label = (i: number) => `Day ${i + 1}`
const score = (p: Place, d: Draft) => scorePlace(p, d.brief).score

function pool(d: Draft): Place[] {
  const used = planned(d)
  return d.city.places.filter(p => !used.has(p.id) && !d.rejected.has(p.id))
}

// Place names mentioned in a phrase, best match first.
export function findPlaces(phrase: string, places: Place[], minScore = 0.5): Place[] {
  const have = new Set(words(phrase))
  const flat = ` ${words(phrase).join(' ')} `
  return places
    .map(p => {
      const name = words(p.name)
      const distinct = name.filter(t => !GENERIC.has(t) && t.length > 2)
      if (flat.includes(` ${name.join(' ')} `)) return { p, s: 1.5 }
      if (!distinct.length) return { p, s: 0 }
      const hits = distinct.filter(t => have.has(t))
      const strong = hits.some(t => t.length >= 4)
      return { p, s: strong ? hits.length / distinct.length : 0 }
    })
    .filter(x => x.s >= minScore)
    .sort((a, b) => b.s - a.s || a.p.name.length - b.p.name.length)
    .map(x => x.p)
}

// "X and Y" / "both" / "all" → every full match; otherwise only the single best one,
// so "nonbei yokocho" doesn't also grab Omoide Yokochō.
function pick(phrase: string, places: Place[]): Place[] {
  const all = findPlaces(phrase, places)
  if (!all.length) return []
  if (!/\b(and|both|all)\b/.test(phrase)) return all.slice(0, 1)
  const full = findPlaces(phrase, places, 1)
  return full.length ? full : all.slice(0, 1)
}

function categoryOf(phrase: string) {
  const t = norm(phrase)
  return CATEGORIES.find(c => c.re.test(t))
}

function dayRef(phrase: string, d: Draft): number | undefined {
  const t = norm(phrase)
  const m = t.match(/\bday\s*(\d+|one|two|three|four|five)\b/)
  if (m) return num(m[1])! - 1
  const o = t.match(/\b(first|second|third|fourth|fifth|last)\s+day\b/)
  if (o) return o[1] === 'last' ? d.lists.length - 1 : ORD[o[1]] - 1
  return undefined
}

function nearestDay(d: Draft, p: Place): number {
  let best = 0
  let bestKm = Infinity
  d.lists.forEach((l, i) => {
    if (!l.length) return
    const km = haversineKm(centroid(l.map(x => x.coord)), p.coord)
    if (km < bestKm) { bestKm = km; best = i }
  })
  return best
}

function insert(d: Draft, p: Place, day: number) {
  const list = [...d.lists[day]]
  list.splice(bestInsertIndex(list, p), 0, p)
  d.lists[day] = list
  d.touched.add(day)
}

function remove(d: Draft, p: Place): boolean {
  const i = dayOfId(d, p.id)
  if (i < 0) return false
  if (d.lists[i].length <= 1) {
    d.notes.push(`${p.name} is the only stop on ${label(i)}. Say “swap ${p.name} for something nearby”, “show me options instead of ${p.name}”, or “remove ${label(i).toLowerCase()}” to drop the whole day.`)
    return false
  }
  d.lists[i] = d.lists[i].filter(x => x.id !== p.id)
  d.touched.add(i)
  d.rejected.add(p.id)
  return true
}

// "near my day 2 places" / "close to Ginza" / "around Golden Gai" → where to look.
function anchorFrom(text: string, d: Draft): { coord: [number, number]; label: string } | undefined {
  const t = norm(text)
  const dm = t.match(/\b(?:near|close to|around|by|next to|nearby)\s+(?:my |the |our )?(?:day\s*(\d+|one|two|three|four|five)|(first|second|third|fourth|fifth|last)\s+day)\b/)
  if (dm) {
    const i = dm[1] ? num(dm[1])! - 1 : dm[2] === 'last' ? d.lists.length - 1 : ORD[dm[2]] - 1
    if (d.lists[i]?.length) return { coord: centroid(d.lists[i].map(p => p.coord)), label: `your Day ${i + 1} stops` }
  }
  const pm = t.match(/\b(?:near|close to|around|by|next to)\s+(.+)$/)
  const place = pm ? findPlaces(pm[1], d.city.places)[0] : undefined
  if (place) return { coord: place.coord, label: place.name }
  return undefined
}

// A replacement that keeps the spirit of the original: similar kind/tags,
// matching the ask (cheaper / closer), and close to that day's other stops.
function alternative(d: Draft, original: Place, want: string, day: number): Place | undefined {
  const t = norm(want)
  const cheaper = /cheap|budget|less expensive|affordable|free/.test(t)
  const named = anchorFrom(want, d)
  const closer = /close|near|walk/.test(t) || Boolean(named)
  const cat = categoryOf(want)
  const anchor = named?.coord ?? (d.lists[day]?.length ? centroid(d.lists[day].filter(p => p.id !== original.id).map(p => p.coord).concat([original.coord])) : original.coord)
  let options = pool(d)
    .filter(p => !cheaper || p.price < original.price || (original.price === 0 && p.price === 0))
    .filter(p => !cat || cat.test(p))
  // an explicit "near X" is a hard preference: stay within ~3 km when anything is there
  if (named) {
    const close = options.filter(p => haversineKm(named.coord, p.coord) <= 3)
    if (close.length) options = close
  }
  return options
    .map(p => {
      const shared = p.tags.filter(x => original.tags.includes(x)).length + (p.kind === original.kind ? 1.5 : 0)
      const km = haversineKm(anchor, p.coord)
      // likeness to the original counts most, then fit to the trip, then distance
      return { p, v: (cat ? 0 : shared * 2) + score(p, d) * 0.4 - km * (closer ? 1.2 : 0.35) + (cheaper ? (original.price - p.price) * 0.5 : 0) }
    })
    .sort((a, b) => b.v - a.v)[0]?.p
}

// Re-group every planned place into n days (used when the number of days changes).
// `addedDays` > 0 tops up with roughly one day's worth of the best unused matches per new day.
function regroup(d: Draft, n: number, addedDays = 0) {
  const perDay = PACE[d.brief.pace ?? 'balanced'].perDay
  let places = d.lists.flat()
  if (addedDays > 0) {
    const extra = pool(d).sort((a, b) => score(b, d) - score(a, d)).slice(0, addedDays * (perDay - 1))
    if (extra.length) d.changes.push(`Filled the new day${addedDays > 1 ? 's' : ''} with ${extra.map(p => p.name).join(', ')}`)
    places = [...places, ...extra]
  }
  let groups = groupDays(places, Math.min(n, places.length), perDay, perDay + 1)
    .sort((a, b) => centroid(a.map(p => p.coord))[0] - centroid(b.map(p => p.coord))[0])
  // fewer days than before: trim overfull days, keeping the best matches
  const dropped: Place[] = []
  groups = groups.map(g => {
    if (g.length <= perDay + 1) return g
    const keep = [...g].sort((a, b) => score(b, d) - score(a, d)).slice(0, perDay + 1)
    dropped.push(...g.filter(p => !keep.includes(p)))
    return g.filter(p => keep.includes(p))
  })
  if (dropped.length) d.notes.push(`To fit ${n} day${n > 1 ? 's' : ''} I left out ${dropped.map(p => p.name).join(', ')} — ask to add any back.`)
  d.lists = groups.map(g => orderDay(g))
  d.starts = d.lists.map(() => undefined)
  d.touched = new Set(d.lists.map((_, i) => i))
  d.recentre = true
}

function parseClock(t: string): number | undefined {
  const m = t.match(/\b(?:at|by|from|around)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (!m) return undefined
  let h = Number(m[1])
  if (h > 23) return undefined
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  return h * 60 + Number(m[2] ?? 0)
}

// ── clause handlers ───────────────────────────────────────────────────────────
// Each returns true when it understood the clause.

type Handler = (c: string, d: Draft) => boolean

const handlers: Handler[] = [
  // undo is handled by the caller; listed here so it never falls through
  c => /^(undo|revert|go back|put it back)\b/.test(c),

  // number of days
  (c, d) => {
    const remDay = c.match(/\b(?:remove|drop|cut|skip|lose|delete)\s+(?:the\s+)?(?:day\s*(\d+)|(first|second|third|fourth|fifth|last)\s+day)\b/)
    if (remDay) {
      const i = remDay[1] ? Number(remDay[1]) - 1 : remDay[2] === 'last' ? d.lists.length - 1 : ORD[remDay[2]] - 1
      if (i < 0 || i >= d.lists.length) { d.notes.push(`There is no ${label(i)}.`); return true }
      if (d.lists.length === 1) { d.notes.push('That’s the only day — I need at least one.'); return true }
      const gone = d.lists[i]
      d.lists.splice(i, 1)
      d.starts.splice(i, 1)
      gone.forEach(p => d.rejected.add(p.id))
      d.brief = { ...d.brief, days: d.lists.length }
      d.touched = new Set(d.lists.map((_, k) => k).filter(k => k >= i))
      d.changes.push(`Removed ${label(i)} (${gone.map(p => p.name).join(', ')}); later days moved up`)
      return true
    }
    let n: number | undefined
    const cur = d.lists.length
    if (/\b(add|one more|another|extra|extend( by)?)\s+(a\s+)?day\b|\bday longer\b/.test(c)) n = cur + 1
    else if (/\b(one|a)\s+(less|fewer)\s+day\b|\bday shorter\b|\bshorten\b/.test(c)) n = cur - 1
    else {
      const m = c.match(/\b(?:make it|only|just|instead|change to|for|now|have|stay)\s*(\d+|one|two|three|four|five)\s+days?\b/) ?? c.match(/^(\d+|one|two|three|four|five)\s+days?\b/)
      if (m) n = num(m[1])
    }
    if (n === undefined) return false
    n = Math.max(1, Math.min(5, n))
    if (n === cur) { d.notes.push(`It’s already ${n} day${n > 1 ? 's' : ''}.`); return true }
    d.brief = { ...d.brief, days: n }
    d.changes.push(`${n > cur ? 'Extended' : 'Shortened'} the trip to ${n} day${n > 1 ? 's' : ''} and regrouped the stops by neighbourhood`)
    regroup(d, n, Math.max(0, n - cur))
    return true
  },

  // start times
  (c, d) => {
    if (!/\b(start|begin|leave|head out|wake|sleep in|lie in|later start|earlier start|early start)\b/.test(c)) return false
    const day = dayRef(c, d)
    const which = day === undefined ? d.lists.map((_, i) => i) : [day]
    const pace = PACE[d.brief.pace ?? 'balanced']
    let set: (cur: number) => number
    let what: string
    const at = /\bat\b|\d/.test(c.replace(/\bday\s*\d+/, '')) ? parseClock(c.replace(/\bday\s*\d+/, '')) : undefined
    if (at !== undefined) { set = () => at; what = `start at ${fmtClock(at)}` }
    else if (/sleep in|lie in|later|late/.test(c)) { set = cur => cur + 75; what = 'start later' }
    else if (/earl(y|ier)/.test(c)) { set = cur => cur - 60; what = 'start earlier' }
    else return false
    for (const i of which) {
      const cur = d.starts[i] ?? pace.start
      d.starts[i] = Math.max(6 * 60, Math.min(14 * 60, set(cur)))
      d.touched.add(i)
    }
    const when = at === undefined ? ` (${which.map(i => fmtClock(d.starts[i]!)).join(', ')})` : ''
    d.changes.push(`${which.length === d.lists.length ? 'Every day' : which.map(label).join(', ')} now ${what.replace('start', 'starts')}${when}`)
    return true
  },

  // pace
  (c, d) => {
    let pace: TripBrief['pace']
    if (/\b(relax(ed|ing)?|slow(er)?|chill(er)?|less (packed|rushed|busy)|fewer stops|lighter|take it easy|too (much|busy|packed))\b/.test(c)) pace = 'slow'
    else if (/\b(packed|busier|more stops|squeeze|cram|see more|fit more|pack (it|more) in)\b/.test(c)) pace = 'packed'
    else if (/\b(balanced|normal pace|medium pace)\b/.test(c)) pace = 'balanced'
    if (!pace) return false
    d.brief = { ...d.brief, pace }
    const per = PACE[pace].perDay
    const trimmed: Place[] = []
    const added: Place[] = []
    d.lists = d.lists.map((l, i) => {
      if (l.length > per) {
        const keep = [...l].sort((a, b) => score(b, d) - score(a, d)).slice(0, per)
        trimmed.push(...l.filter(p => !keep.includes(p)))
        d.touched.add(i)
        return l.filter(p => keep.includes(p))
      }
      return l
    })
    if (pace === 'packed') {
      // top each day up with the best unused match near that day's stops
      for (let i = 0; i < d.lists.length; i++) {
        while (d.lists[i].length < per) {
          const anchor = centroid(d.lists[i].map(p => p.coord))
          const value = (p: Place) => score(p, d) - haversineKm(anchor, p.coord) * 0.4
          const next = pool(d).sort((a, b) => value(b) - value(a))[0]
          if (!next) break
          insert(d, next, i)
          added.push(next)
        }
      }
    }
    d.lists.forEach((_, i) => d.touched.add(i))
    d.changes.push(`Switched to a ${pace} pace (${PACE[pace].buffer}-min buffers${trimmed.length ? `; dropped ${trimmed.map(p => p.name).join(', ')}` : ''}${added.length ? `; added ${added.map(p => p.name).join(', ')}` : ''})`)
    return true
  },

  // tidy routes
  (c, d) => {
    if (!/\b(optimi[sz]e|tidy|reorder|less (travel|walking|time travel(l)?ing)|shorter routes?|efficient)\b/.test(c)) return false
    const day = dayRef(c, d)
    const which = day === undefined ? d.lists.map((_, i) => i) : [day]
    // the whole trip can also move stops between days; one day can only re-order itself
    if (day === undefined) d.lists = rebalanceDays(d.lists, PACE[d.brief.pace ?? 'balanced'].perDay + 1)
    else d.lists[day] = orderDay(d.lists[day])
    which.forEach(i => d.touched.add(i))
    d.changes.push(day === undefined ? 'Re-planned every day for less travel, moving stops between days where it helped' : `Re-ordered ${label(day)} for the shortest route`)
    return true
  },

  // "remove X and get something else near my day 2 places": a swap, so it never empties a day
  (c, d) => {
    const m = c.match(/\b(?:remove|drop|skip|ditch|lose|get rid of|take out|swap out|replace)\s+(.+?)\s*(?:,|\band\b)?\s*(?:get|find|add|put in|give me|go (?:for|with)|do|pick|choose|use|have)\s+((?:something|somewhere|anything|another|a different|some|an? (?:other|new|alternative))\b.*)$/)
    if (!m) return false
    const original = pick(m[1], d.lists.flat())[0]
    if (!original) return false
    const day = dayOfId(d, original.id)
    const alt = alternative(d, original, m[2], day)
    if (!alt) { d.notes.push(`Nothing unused fits that for ${original.name}.`); return true }
    d.lists[day] = orderDay(d.lists[day].map(x => (x.id === original.id ? alt : x)))
    d.rejected.add(original.id)
    d.touched.add(day)
    const near = anchorFrom(m[2], d)
    d.changes.push(`Swapped ${original.name} for ${alt.name} on ${label(day)}${near ? ` — ${haversineKm(near.coord, alt.coord).toFixed(1)} km from ${near.label}` : ''}`)
    return true
  },

  // replace / swap
  (c, d) => {
    const m = c.match(/\b(?:replace|swap|switch|change|substitute|trade)\s+(.+?)\s+(?:with|for|to|into)\s+(.+)$/) ?? c.match(/\binstead of\s+(.+?),?\s+(?:do|go to|see|visit|try)\s+(.+)$/)
    if (!m) return false
    if (/^(?:the\s+)?(?:day\s*\S+|\S+\s+day)$/.test(m[2].trim())) return false // "switch X to day 2" is a move
    if (/\b(hotel|stay|base|budget)\b/.test(m[1])) return false // "change the hotel to…" / "change budget to $2000"
    const original = findPlaces(m[1], d.lists.flat())[0]
    if (!original) return false
    const day = dayOfId(d, original.id)
    // "something near Ginza" describes a replacement; it doesn't name one
    const vague = /^(?:something|somewhere|anything|another|a different|some|an? (?:other|new|alternative))\b/.test(m[2].trim())
    const named = vague ? undefined : findPlaces(m[2], pool(d))[0]
    const alt = named ?? alternative(d, original, m[2], day)
    if (!alt) { d.notes.push(`Nothing unused fits “${m[2]}” for ${original.name}.`); return true }
    d.lists[day] = d.lists[day].map(x => (x.id === original.id ? alt : x))
    d.lists[day] = orderDay(d.lists[day])
    d.rejected.add(original.id)
    d.touched.add(day)
    d.changes.push(`Swapped ${original.name} for ${alt.name} on ${label(day)}${named ? '' : ` (${alt.price < original.price ? 'cheaper, ' : ''}${alt.blurb.toLowerCase().replace(/\.$/, '')})`}`)
    return true
  },

  // move to a day
  (c, d) => {
    const target = dayRef(c, d)
    if (target === undefined || !/\b(move|put|shift|switch|do|on|to|into)\b/.test(c) || /\b(add|include|start|remove|drop)\b/.test(c)) return false
    const subject = c.replace(/\b(?:to|on|into)?\s*(?:the\s+)?(?:day\s*\S+|\S+\s+day)\b.*$/, '')
    const places = pick(subject, d.lists.flat())
    if (!places.length) return false
    if (target >= d.lists.length) { d.notes.push(`There is no ${label(target)} — the trip has ${d.lists.length} day${d.lists.length > 1 ? 's' : ''}.`); return true }
    for (const p of places) {
      const from = dayOfId(d, p.id)
      if (from === target) { d.notes.push(`${p.name} is already on ${label(target)}.`); continue }
      if (d.lists[from].length <= 1) { d.notes.push(`${p.name} is the only stop on ${label(from)}.`); continue }
      d.lists[from] = d.lists[from].filter(x => x.id !== p.id)
      d.touched.add(from)
      insert(d, p, target)
      d.changes.push(`Moved ${p.name} from ${label(from)} to ${label(target)}`)
    }
    return true
  },

  // first / last within its day
  (c, d) => {
    const m = c.match(/^(?:do|visit|see|put|make|add)?\s*(.+?)\s+(first|last|at the (?:start|end))\b/)
    if (!m || /\bday\b/.test(m[1])) return false
    const p = findPlaces(m[1], d.city.places)[0]
    if (!p) return false
    const first = /first|start/.test(m[2])
    let i = dayOfId(d, p.id)
    const isNew = i < 0
    if (isNew) { i = dayRef(c, d) ?? nearestDay(d, p); d.rejected.delete(p.id) } // not planned yet: add it there
    const rest = d.lists[i].filter(x => x.id !== p.id)
    d.lists[i] = first ? [p, ...rest] : [...rest, p]
    d.touched.add(i)
    d.changes.push(isNew ? `Added ${p.name} as the ${first ? 'first' : 'last'} stop on ${label(i)}` : `${p.name} is now ${first ? 'first' : 'last'} on ${label(i)}`)
    return true
  },

  // hotel
  (c, d) => {
    if (!/\b(hotel|stay|staying|base|accommodation|room)\b/.test(c)) return false
    if (!d.city.hotels.length) return false
    const near = c.match(/\b(?:near|close to|by|in|around)\s+(.+)$/)
    if (/\b(cheap(er)?|budget|less expensive|affordable)\b/.test(c)) {
      d.hotelMode = s => s.total * 0.4 + (1 - s.hotel.nightly / 600) * 1.2
      d.changes.push('Looking for a cheaper base')
    } else if (/\b(nicer|luxur(y|ious)|fancier|better|upgrade|splurge)\b/.test(c)) {
      d.hotelMode = s => s.total * 0.5 + s.hotel.nightly / 400
      d.changes.push('Upgrading the base')
    } else if (near) {
      const target = findPlaces(near[1], d.city.places)[0]
      const area = target?.coord ?? d.city.hotels.find(h => words(h.name).some(w => words(near[1]).includes(w)))?.coord
      if (!area) { d.notes.push(`I don’t know where “${near[1]}” is on the map yet.`); return true }
      d.hotelMode = s => -haversineKm(s.hotel.coord, area)
      d.changes.push(`Moving the base close to ${target?.name ?? near[1]}`)
    } else if (/\b(change|different|another|switch|other)\b/.test(c)) {
      d.hotelMode = s => (s.hotel.id === currentHotelId ? -1 : s.total)
      d.changes.push('Trying a different base')
    } else return false
    return true
  },

  // travellers
  (c, d) => {
    const m = c.match(/\b(?:we(?:'re| are)|now|there(?:'s| are| will be)|party of|group of)\s*(\d+|two|three|four|five)\b/) ?? c.match(/\b(\d+|two|three|four|five)\s+(?:of us|people|travell?ers|adults|friends)\b/)
    const joining = /\b(joining|coming too|coming along|tagging along|bringing)\b/.test(c)
    if (!m && !joining) return false
    const n = m ? num(m[1])! : (d.brief.travelers ?? 2) + 1
    d.brief = { ...d.brief, travelers: n }
    d.hotelMode = d.hotelMode === 'keep' ? 'best' : d.hotelMode
    d.changes.push(`Now planning for ${n} traveller${n > 1 ? 's' : ''} (room count and transport costs updated)`)
    return true
  },

  // budget
  (c, d) => {
    const amount = c.match(/\$\s?(\d[\d,]*)(k)?|(\d[\d,]*)(k)?\s?(?:usd|dollars)/)
    let tier: TripBrief['budgetTier']
    if (/\b(cheap(er)?|on a budget|budget (trip|travel)|save money|too expensive|less expensive|affordable|tight)\b/.test(c)) tier = 'shoestring'
    else if (/\b(luxur(y|ious)|splurge|fancier|treat (ourselves|myself)|upscale)\b/.test(c)) tier = 'luxury'
    if (!amount && !tier) return false
    // a relative ask ("cheaper", "splurge") nudges an existing dollar budget too,
    // since the amount is what hotel prices are matched against
    const nudged = !amount && d.brief.budgetAmount ? Math.round(d.brief.budgetAmount * (tier === 'shoestring' ? 0.65 : 1.5) / 50) * 50 : undefined
    d.brief = {
      ...d.brief,
      budgetTier: tier ?? (amount ? undefined : d.brief.budgetTier), // an explicit amount decides the tier itself
      budgetAmount: amount ? Number((amount[1] ?? amount[3]).replace(/,/g, '')) * ((amount[2] ?? amount[4]) ? 1000 : 1) : nudged ?? d.brief.budgetAmount,
    }
    const nowTier = resolveBudgetTier(d.brief)
    const total = d.brief.budgetAmount ? ` (~$${d.brief.budgetAmount.toLocaleString()} total)` : ''
    if (nowTier === 'shoestring') {
      const pricey = d.lists.flat().filter(p => p.price >= 3)
      const swaps: string[] = []
      for (const p of pricey) {
        const day = dayOfId(d, p.id)
        const alt = alternative(d, p, 'cheaper', day)
        if (!alt) continue
        d.lists[day] = d.lists[day].map(x => (x.id === p.id ? alt : x))
        d.rejected.add(p.id)
        d.touched.add(day)
        swaps.push(`${p.name} → ${alt.name}`)
      }
      d.changes.push(`Budget is now ${nowTier}${total}${swaps.length ? `; swapped ${swaps.join(', ')}` : ''}`)
    } else {
      d.changes.push(`Budget is now ${nowTier}${total}`)
    }
    if (d.hotelMode === 'keep') d.hotelMode = 'best'
    return true
  },

  // more / less of a category
  (c, d) => {
    const m = c.match(/\b(more|extra|another|less|fewer|no more|not so many|too many)\s+(.+)$/)
    if (!m) return false
    const cat = categoryOf(m[2])
    if (!cat) return false
    const more = /more|extra|another/.test(m[1]) && !/no more|too many/.test(m[1])
    if (more) {
      const added: string[] = []
      for (const p of pool(d).filter(cat.test).sort((a, b) => score(b, d) - score(a, d)).slice(0, 2)) {
        const day = nearestDay(d, p)
        insert(d, p, day)
        added.push(`${p.name} (${label(day)})`)
      }
      if (!added.length) d.notes.push(`I’ve already used every ${cat.label} spot I know nearby.`)
      else d.changes.push(`More ${cat.label}: added ${added.join(', ')}`)
      d.brief = { ...d.brief, vibes: d.brief.vibes }
    } else {
      const gone: string[] = []
      for (const p of d.lists.flat().filter(cat.test).sort((a, b) => score(a, d) - score(b, d)).slice(0, 2)) {
        if (remove(d, p)) gone.push(p.name)
      }
      if (gone.length) d.changes.push(`Less ${cat.label}: removed ${gone.join(', ')}`)
      else d.notes.push(`There’s no ${cat.label} in the plan to cut.`)
    }
    return true
  },

  // remove
  (c, d) => {
    const m = c.match(/\b(?:remove|drop|skip|cut|delete|lose|ditch|scrap|get rid of|take out|don'?t (?:want|need|like)|not interested in|no|without|hate)\s+(.+)$/)
    if (!m) return false
    // a category word ("museums") beats a partial name match ("Ueno Park & Museums")
    const exact = findPlaces(m[1], d.lists.flat(), 1)
    const places = exact.length || !categoryOf(m[1]) ? pick(m[1], d.lists.flat()) : []
    if (places.length) {
      for (const p of places) {
        const day = dayOfId(d, p.id)
        if (remove(d, p)) d.changes.push(`Removed ${p.name} from ${label(day)}`)
      }
      return true
    }
    const cat = categoryOf(m[1])
    if (cat) {
      const all = /\b(no|without|any|all|hate|don'?t)\b/.test(c)
      const hits = d.lists.flat().filter(cat.test)
      const gone = (all ? hits : hits.slice(0, 1)).filter(p => remove(d, p)).map(p => p.name)
      if (gone.length) d.changes.push(`No ${cat.label}: removed ${gone.join(', ')}`)
      else d.notes.push(hits.length ? `I kept the last stop on a day — ask to remove that day instead.` : `There’s no ${cat.label} in the plan.`)
      return true
    }
    d.notes.push(`I couldn’t find “${m[1].trim()}” in your plan.`)
    return true
  },

  // add
  (c, d) => {
    const m = c.match(/\b(?:add|include|see|visit|go to|fit in|throw in|squeeze in|want to (?:see|go|visit|try)|also|plus|try)\s+(.+)$/)
    const phrase = m?.[1] ?? c
    const day = dayRef(c, d)
    const named = findPlaces(phrase, d.city.places)
    if (named.length) {
      const p = named[0]
      if (planned(d).has(p.id)) {
        const at = dayOfId(d, p.id)
        if (day !== undefined && day !== at) return false // it's really a move
        d.notes.push(`${p.name} is already on ${label(at)}.`)
        return true
      }
      if (day !== undefined && day >= d.lists.length) { d.notes.push(`There is no ${label(day)}.`); return true }
      const target = day ?? nearestDay(d, p)
      insert(d, p, target)
      d.rejected.delete(p.id)
      d.changes.push(`Added ${p.name} to ${label(target)}`)
      return true
    }
    if (!m) return false
    const cat = categoryOf(phrase)
    if (!cat) { d.notes.push(`I don’t have “${phrase.trim()}” on my ${d.city.name} map yet.`); return true }
    const p = pool(d).filter(cat.test).sort((a, b) => score(b, d) - score(a, d))[0]
    if (!p) { d.notes.push(`I’ve already used every ${cat.label} spot I know.`); return true }
    const target = day ?? nearestDay(d, p)
    insert(d, p, target)
    d.changes.push(`Added ${p.name} (${cat.label}) to ${label(target)}`)
    return true
  },
]

let currentHotelId: string | undefined

// Split "swap X for Y and add a day, then start later" into clauses, without
// breaking "Fado in Alfama" or "replace X with Y".
function clauses(text: string): string[] {
  return norm(text)
    .replace(/[!?]/g, '.')
    .split(/\s*(?:[.;\n]|,\s*(?:and\s+|then\s+)?|\s+(?:and then|then|also|plus)\s+|\s+and\s+(?=(?:add|remove|move|drop|replace|swap|switch|start|make|put|skip|cut|change|include|give|let|we|i|more|less|fewer|no|get|take|do|stay|find)\b)(?!(?:get|find|add|give me|pick|choose|use|have|do|put in)\s+(?:something|somewhere|anything|another|a different|some|an? (?:other|new|alternative))\b))/)
    .map(c => c.replace(/^(?:please|can you|could you|let'?s|i'?d like to|i want to|maybe|actually|and|also|oh|ok(?:ay)?|hey|also,)\s+/g, '').trim())
    .filter(c => c.length > 1)
}

export function applyEdit(plan: PlanSlice, text: string): EditResult {
  const city = tripCity(plan.brief)!
  currentHotelId = plan.hotel?.hotel.id
  const d: Draft = {
    city,
    brief: plan.brief,
    lists: plan.days.map(day => day.stops.map(s => s.place)),
    starts: plan.days.map(day => day.stops[0]?.arrive),
    hotelMode: 'keep',
    rejected: new Set(Object.keys(plan.picks).filter(id => plan.picks[id] === 'nope')),
    touched: new Set(),
    recentre: false,
    changes: [],
    notes: [],
  }

  // A different city is the biggest change of all: replan there, in place.
  const otherCity = CITIES.find(c => c.id !== city.id && c.aliases.some(a => new RegExp(`\\b${a}\\b`).test(norm(text))))
  if (otherCity) return switchCity(plan, otherCity)

  let understood = false
  for (const c of clauses(text)) {
    const before = d.changes.length + d.notes.length
    const ok = handlers.some(h => h(c, d))
    if (ok || d.changes.length + d.notes.length > before) understood = true
  }

  return { ...materialise(plan, d), understood }
}

function materialise(plan: PlanSlice, d: Draft): Omit<EditResult, 'understood'> {
  let days = d.lists.map((l, i) => buildDay(i + 1, l, d.brief, { keepOrder: true, start: d.starts[i] }))
  let hotel = plan.hotel
  let hotelScores = plan.hotelScores
  if (plan.hotel || plan.hotelScores.length) {
    hotelScores = d.city.hotels.map(h => scoreHotel(h, d.brief, days))
    if (plan.hotel) {
      const rank = d.hotelMode === 'keep' ? undefined : d.hotelMode === 'best' ? (s: HotelScore) => s.total : d.hotelMode
      const pick = rank ? [...hotelScores].sort((a, b) => rank(b) - rank(a))[0] : hotelScores.find(s => s.hotel.id === plan.hotel!.hotel.id)
      if (pick && pick.hotel.id !== plan.hotel.hotel.id) d.changes.push(`New base: ${pick.hotel.name} ($${pick.hotel.nightly}/night, ~${Math.round(pick.avgCommute)} min to each day)`)
      hotel = pick
      if (hotel) days = hotelLegs(hotel.hotel, days)
    }
  }
  const used = new Set(days.flatMap(x => x.stops.map(s => s.place.id)))
  const candidates: Record<string, Candidate> = {}
  for (const [id, c] of Object.entries(plan.candidates)) candidates[id] = { ...c, verdict: used.has(id) ? 'keep' : c.verdict === 'keep' ? 'drop' : c.verdict }
  for (const day of days) for (const s of day.stops) if (!candidates[s.place.id]) candidates[s.place.id] = { place: s.place, verdict: 'keep' }
  const picks = { ...plan.picks }
  // remember removals so later edits never quietly bring them back; adding one explicitly clears it
  d.rejected.forEach(id => { if (!used.has(id)) picks[id] = 'nope' })
  used.forEach(id => { if (picks[id] === 'nope') picks[id] = 'like' })
  return {
    plan: { brief: d.brief, days, hotel, hotelScores, candidates, picks },
    changes: d.changes,
    notes: d.notes,
    touchedDays: [...d.touched].filter(i => i < days.length).map(i => i + 1),
    recentre: d.recentre,
  }
}

function switchCity(plan: PlanSlice, city: City): EditResult {
  const brief: TripBrief = { ...plan.brief, destination: city.id }
  const n = brief.days ?? plan.days.length
  // seed with the best matches there, then group them into days like any other plan
  const perDay = PACE[brief.pace ?? 'balanced'].perDay
  const best = [...city.places].sort((a, b) => scorePlace(b, brief).score - scorePlace(a, brief).score).slice(0, n * perDay)
  const d: Draft = {
    city, brief, lists: [best], starts: [], hotelMode: plan.hotel ? 'best' : 'keep',
    rejected: new Set(), touched: new Set(), recentre: true,
    changes: [`Moved the whole trip to ${city.name}: same ${n} day${n > 1 ? 's' : ''}, vibe and budget, with my best matches there`],
    notes: ['Tap any pin to swap things in or out, or tell me what to change.'],
  }
  regroup(d, n)
  // the old city's hotel scores are meaningless here; materialise re-scores when there's a base to replace
  const res = materialise({ ...plan, brief, candidates: {}, picks: {}, hotelScores: [] }, d)
  return { ...res, understood: true }
}

// ── "Not sure? Let me try some" → a mini swipe deck ───────────────────────────
// When the traveller wants to browse rather than decide, deal a fresh deck that
// follows their spec (near a day or place, a category, cheaper), then slot the
// keeps into the plan. Nothing changes until they finish swiping.

const DECK_INTENT = /\b(not sure|unsure|don'?t know|no idea|undecided|options?|show me|let me (?:pick|choose|see|decide|browse)|what else|any ideas|ideas|suggest(?:ions?)?|recommend(?:ations?)?|browse|swipe|choices|alternatives|wanna try|want to try|try (?:something|somewhere|some|a few|other|another|new|out)|see what'?s)\b/

// Questions and preferences: "some good places to eat?", "where should we eat",
// "I like traditional Japanese food", "craving ramen".
const ASKING = /(\?|\b(?:where|what|which|any|some|good|best|nice|great|tasty|cool)\s+(?:places?|spots?|restaurants?|food|bars?|cafes?|options?|ideas?|eats?)\b|\bwhere (?:to|should|can|could|do)\b|\blooking for\b|\bin the mood for\b|\bcraving\b|\bfancy\b|\b(?:i|we)\s+(?:really\s+)?(?:like|love|want|prefer|enjoy|adore)\b|\binto\b)/
// …but a direct instruction ("I want to add a day", "add more food") is an edit, not a browse.
const DECISIVE = /\b(add|remove|move|swap|replace|drop|skip|cut|delete|more|less|fewer|start|make it|switch|put|undo)\b/

export interface DeckRequest {
  cards: DeckCard[]
  replaceId?: string      // the place the first keep replaces
  day?: number            // 1-based day the keeps go to (default: nearest day)
  label: string           // deck heading, e.g. "Ideas near your Day 2 stops"
  intro: string           // chat message that opens the deck
  tastes: string[]        // preferences heard in the request, to remember on the trip
}

// Cuisine & style words this city's places are known by, found in the text.
function tastesIn(t: string, city: City): string[] {
  const vocab = [...new Set(city.places.flatMap(p => p.keywords ?? []))]
  // plurals too: "pastries" → pastry, "noodles" → noodle(s)
  return vocab
    .filter(k => new RegExp(`\\b(?:${k}|${k.replace(/y$/, 'ie')})(?:e?s)?\\b`).test(t))
    .sort((a, b) => t.indexOf(a.replace(/y$/, '')) - t.indexOf(b.replace(/y$/, ''))) // keep their word order

}

const tasteHits = (p: Place, tastes: string[]) => tastes.filter(k => p.keywords?.includes(k))
const titleCase = (s: string) => s.replace(/\b[a-z]/g, c => c.toUpperCase())

function draftOf(plan: PlanSlice): Draft {
  return {
    city: tripCity(plan.brief)!,
    brief: plan.brief,
    lists: plan.days.map(day => day.stops.map(s => s.place)),
    starts: plan.days.map(day => day.stops[0]?.arrive),
    hotelMode: 'keep',
    rejected: new Set(Object.keys(plan.picks).filter(id => plan.picks[id] === 'nope')),
    touched: new Set(),
    recentre: false,
    changes: [],
    notes: [],
  }
}

// `force`: last resort for a message no edit understood — browse if it names any food/style/category.
export function planDeckRequest(plan: PlanSlice, text: string, force = false): DeckRequest | null {
  const t = norm(text)
  const city = tripCity(plan.brief)
  if (!city) return null
  const d = draftOf(plan)
  const planned = d.lists.flat()
  const tastes = tastesIn(t, city)
  const named = planned.concat(city.places).reduce((s, p) => s.replace(norm(p.name), ' '), t)
  const describesSomething = tastes.length > 0 || Boolean(categoryOf(named))
  const intent = DECK_INTENT.test(t) || (ASKING.test(t) && describesSomething && !DECISIVE.test(t))
  if (!intent && !(force && describesSomething)) return null

  // which planned place (if any) they want gone: only when they say so
  const wantsOut = /\b(remove|drop|skip|replace|swap|instead of|ditch|lose|get rid of|don'?t (?:like|want)|not (?:keen|into)|change)\b/.test(t)
  const replaced = wantsOut ? findPlaces(t.replace(/\b(?:near|close to|around|by|next to)\b.*$/, ''), planned)[0] : undefined

  const anchor = anchorFrom(t, d)
  const dm = t.match(/\b(?:on|for|to|into)\s+(?:my |the )?day\s*(\d+|one|two|three|four|five)\b/)
  const explicitDay = dm ? num(dm[1])! - 1 : undefined
  const targetDay = explicitDay ?? (replaced ? dayOfId(d, replaced.id) : undefined)
  const where = anchor?.coord
    ?? replaced?.coord
    ?? (targetDay !== undefined && d.lists[targetDay]?.length ? centroid(d.lists[targetDay].map(p => p.coord)) : undefined)

  // category & price, read from the request minus any place names in it
  const cat = categoryOf(named)
  const cheaper = /\b(cheap(er)?|budget|affordable|free|less expensive)\b/.test(named)

  let pool = d.city.places
    .filter(p => !planned.some(x => x.id === p.id) && !d.rejected.has(p.id))
    .filter(p => !cat || cat.test(p))
    .filter(p => !cheaper || p.price <= Math.min(1, replaced?.price ?? 1))
  // what they described ("traditional japanese") narrows the deck when enough places fit
  let fewMatches = false
  if (tastes.length) {
    const fit = pool.filter(p => tasteHits(p, tastes).length > 0)
    if (fit.length >= 2) pool = fit
    else fewMatches = true
  }
  if (where) {
    const close = pool.filter(p => haversineKm(where, p.coord) <= 4)
    if (close.length >= 3) pool = close // otherwise widen the net rather than show nothing
  }
  // "tonight" / "for breakfast" → favour places at their best at that time
  const when = /\b(tonight|dinner|evening|night|late)\b/.test(t) ? ['evening', 'night'] : /\b(breakfast|morning|brunch)\b/.test(t) ? ['morning'] : /\blunch\b/.test(t) ? ['midday'] : []
  const ranked = pool
    .map(p => ({ p, v: score(p, d) + tasteHits(p, tastes).length * 2.5 + (when.includes(p.bestAt ?? '') ? 1.5 : 0) - (where ? haversineKm(where, p.coord) * 0.7 : 0) + (replaced ? p.tags.filter(x => replaced.tags.includes(x)).length * 0.5 : 0) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 10)
  const top = Math.max(...ranked.map(r => r.v), 1)
  const cards: DeckCard[] = ranked.map(({ p, v }) => {
    const hits = tasteHits(p, tastes)
    const bits = [
      hits.length ? `${hits.join(' + ')}` : '',
      where ? `${haversineKm(where, p.coord).toFixed(1)} km from ${anchor?.label ?? (replaced ? replaced.name : `your Day ${targetDay! + 1} stops`)}` : '',
      hits.length ? '' : scorePlace(p, d.brief).why,
    ].filter(Boolean)
    return { id: p.id, why: bits.join(' · '), match: Math.max(0.2, Math.min(1, v / top)) }
  })

  // things they'd like that are already on the plan are worth saying out loud
  const already = tastes.length
    ? d.lists.flatMap((l, i) => l.filter(p => (!cat || cat.test(p)) && tasteHits(p, tastes).length).map(p => `${p.name} (${label(i)})`))
    : []

  const focus = anchor?.label ?? (replaced ? `${replaced.name}` : targetDay !== undefined ? `your Day ${targetDay + 1} stops` : '')
  // "Traditional Japanese food", but never "Street Food food"
  const catWord = cat && !tastes.join(' ').includes(cat.label.split(' ')[0]) ? `${cat.label} ` : ''
  const what = `${tastes.length ? `${titleCase(tastes.join(' '))} ` : ''}${catWord || (cheaper && !cat ? 'cheaper ' : '')}`
  const heading = replaced
    ? `Swap ideas for ${replaced.name}`
    : `${what ? what[0].toUpperCase() + what.slice(1) : ''}${what ? 'ideas' : 'Ideas'}${focus ? ` near ${focus}` : ''}`
  const remember = tastes.filter(k => !(plan.brief.tastes ?? []).includes(k))
  const intro = !cards.length
    ? ''
    : [
        `Here are ${cards.length} ${what}option${cards.length > 1 ? 's' : ''}${focus ? ` near ${focus}` : ''} — swipe right on anything you’d like.`,
        replaced ? `Your first keep replaces ${replaced.name}; skip them all and I’ll keep it.` : 'I’ll slot your keeps into the plan where they fit best.',
        already.length ? `Already on your plan: ${already.join(', ')}.` : '',
        fewMatches ? `Only a few spots match “${tastes.join(' ')}” exactly, so I’ve added close alternatives.` : '',
        remember.length ? `I’ll remember you like ${remember.join(' ')} and favour it from now on.` : '',
      ].filter(Boolean).join(' ')
  // only a day they named pins every keep there; otherwise each goes where it fits best
  return { cards, replaceId: replaced?.id, day: explicitDay !== undefined ? explicitDay + 1 : undefined, label: heading, intro, tastes }
}

export function applyDeckPicks(plan: PlanSlice, liked: string[], replaceId?: string, day?: number): EditResult {
  const d = draftOf(plan)
  const places = liked.map(id => d.city.places.find(p => p.id === id)).filter((p): p is Place => Boolean(p))
  places.forEach((p, i) => {
    if (i === 0 && replaceId) {
      const at = dayOfId(d, replaceId)
      if (at >= 0) {
        const old = d.lists[at].find(x => x.id === replaceId)!
        d.lists[at] = orderDay(d.lists[at].map(x => (x.id === replaceId ? p : x)))
        d.rejected.add(replaceId)
        d.touched.add(at)
        d.changes.push(`Swapped ${old.name} for ${p.name} on ${label(at)}`)
        return
      }
    }
    const target = day !== undefined && day - 1 < d.lists.length ? day - 1 : nearestDay(d, p)
    insert(d, p, target)
    d.changes.push(`Added ${p.name} to ${label(target)}`)
  })
  return { ...materialise(plan, d), understood: true }
}
