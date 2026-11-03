import type { City, DayPlan, HotelScore, Place, TripBrief } from '../types'
import { fmtClock, travelOptions } from './geo'
import { resolveBudgetTier } from './intake'
import { isWet, type TripWeather } from '../services/weather'

// Everything the trip dashboard derives from a plan: costs, stats, what to book,
// what to pack, and exports. Pure functions over the plan, so they stay in sync
// with every live edit.

// ── costs ─────────────────────────────────────────────────────────────────────

export interface CostLine { key: string; label: string; amount: number; note: string }
export interface CostSummary {
  lines: CostLine[]
  total: number
  perPerson: number
  perDay: number
  budget?: number
  estimatedStay: boolean      // true until a hotel is chosen
}

const ENTRY = [0, 8, 20, 40]          // per person, by price level, for sights/museums/views
const MEAL = [8, 15, 35, 90]          // per person, for food/café/bar stops
const DAILY_FOOD = { shoestring: 18, comfort: 35, luxury: 70 } // breakfast, snacks & the meals not on the plan
const STAY_GUESS = { shoestring: 90, comfort: 220, luxury: 450 }

const isMeal = (p: Place) => p.kind === 'food' || p.kind === 'cafe' || p.kind === 'bar'

export function estimateCosts(brief: TripBrief, days: DayPlan[], city: City, hotel?: HotelScore): CostSummary {
  const people = brief.travelers ?? 2
  const nights = Math.max(1, days.length)
  const rooms = Math.ceil(people / 2)
  const tier = resolveBudgetTier(brief)
  const stops = days.flatMap(d => d.stops.map(s => s.place))

  const nightly = hotel?.hotel.nightly ?? STAY_GUESS[tier]
  const stay = nightly * nights * rooms
  const entry = stops.filter(p => !isMeal(p)).reduce((s, p) => s + ENTRY[p.price] * people, 0)
  const meals = stops.filter(isMeal).reduce((s, p) => s + MEAL[p.price] * people, 0)
  const food = meals + DAILY_FOOD[tier] * people * days.length
  const transport = days.flatMap(d => d.legs).reduce((s, leg) => s + (travelOptions(leg.from, leg.to, city.transport, people).find(o => o.best)?.cost ?? 0), 0)
  const subtotal = stay + entry + food + transport
  const buffer = Math.round(subtotal * 0.08)

  const lines: CostLine[] = [
    { key: 'stay', label: 'Stay', amount: stay, note: hotel ? `${hotel.hotel.name} · $${nightly} × ${nights} night${nights > 1 ? 's' : ''}${rooms > 1 ? ` × ${rooms} rooms` : ''}` : `Estimate until you pick a base (~$${nightly}/night)` },
    { key: 'food', label: 'Food & drink', amount: food, note: `Planned meals + ~$${DAILY_FOOD[tier]}/person/day for breakfast & snacks` },
    { key: 'entry', label: 'Tickets & entry', amount: entry, note: `${stops.filter(p => !isMeal(p) && p.price > 0).length} paid sights · ${stops.filter(p => !isMeal(p) && p.price === 0).length} free` },
    { key: 'transport', label: 'Getting around', amount: transport, note: `${city.transport.transitName} + walking between every stop` },
    { key: 'buffer', label: 'Buffer', amount: buffer, note: 'Souvenirs, snacks & surprises (~8%)' },
  ]
  const total = lines.reduce((s, l) => s + l.amount, 0)
  return { lines, total, perPerson: total / people, perDay: total / days.length, budget: brief.budgetAmount, estimatedStay: !hotel }
}

// ── stats ─────────────────────────────────────────────────────────────────────

export interface TripStats {
  stops: number
  walkKm: number
  transitMin: number
  freeHours: number
  foodStops: number
  freeStops: number
  earliest: string
  latest: string
  busiestDay: number
}

export function tripStats(days: DayPlan[]): TripStats {
  const legs = days.flatMap(d => d.legs)
  const stops = days.flatMap(d => d.stops)
  const free = stops.reduce((s, st, i) => s + (st.bufferAfter >= 45 && i < stops.length - 1 ? st.bufferAfter : 0), 0)
  const busiest = [...days].sort((a, b) => b.stops.length - a.stops.length)[0]
  return {
    stops: stops.length,
    walkKm: legs.filter(l => l.mode === 'walk').reduce((s, l) => s + l.km, 0),
    transitMin: legs.filter(l => l.mode === 'transit').reduce((s, l) => s + l.minutes, 0),
    freeHours: free / 60,
    foodStops: stops.filter(s => isMeal(s.place)).length,
    freeStops: stops.filter(s => s.place.price === 0).length,
    earliest: fmtClock(Math.min(...days.map(d => d.stops[0]?.arrive ?? 24 * 60))),
    latest: fmtClock(Math.max(...days.map(d => d.stops[d.stops.length - 1]?.depart ?? 0))),
    busiestDay: busiest?.day ?? 1,
  }
}

// ── book ahead ────────────────────────────────────────────────────────────────

export interface BookItem { id: string; title: string; why: string; day?: number }

export function bookAhead(days: DayPlan[], hotel?: HotelScore): BookItem[] {
  const items: BookItem[] = []
  if (hotel) items.push({ id: `hotel-${hotel.hotel.id}`, title: hotel.hotel.name, why: 'Your base — lock in the room first' })
  for (const d of days) for (const s of d.stops) if (s.place.book) items.push({ id: s.place.id, title: s.place.name, why: s.place.book, day: d.day })
  return items
}

// ── packing ───────────────────────────────────────────────────────────────────

export interface PackItem { id: string; label: string; why?: string; group: 'essentials' | 'weather' | 'plans' | 'local' }

export function packingList(days: DayPlan[], city: City, weather?: TripWeather): PackItem[] {
  const stats = tripStats(days)
  const stops = days.flatMap(d => d.stops.map(s => s.place))
  const tags = new Set(stops.flatMap(p => p.tags))
  const list: PackItem[] = [
    { id: 'passport', label: 'Passport & a photo of it on your phone', group: 'essentials' },
    { id: 'cards', label: 'Two payment cards (keep one separate)', group: 'essentials' },
    { id: 'adapter', label: `Plug adapter — ${city.essentials.plugs.split(' (')[0]}`, group: 'essentials' },
    { id: 'charger', label: 'Phone charger & power bank (maps all day)', group: 'essentials' },
    { id: 'insurance', label: 'Travel insurance details', group: 'essentials' },
  ]
  if (stats.walkKm / Math.max(1, days.length) > 2) list.push({ id: 'shoes', label: 'Comfortable walking shoes', why: `~${(stats.walkKm / days.length).toFixed(1)} km on foot a day between stops`, group: 'plans' })
  if (tags.has('culture') || tags.has('history')) list.push({ id: 'modest', label: 'A layer that covers shoulders', why: 'For temples, shrines and churches', group: 'plans' })
  if (tags.has('nightlife')) list.push({ id: 'id', label: 'Photo ID for bars', group: 'plans' })
  if (stops.some(p => p.price >= 3)) list.push({ id: 'smart', label: 'One smarter outfit', why: 'For the nicer dinner on the plan', group: 'plans' })
  if (stops.some(p => p.kind === 'park')) list.push({ id: 'bottle', label: 'Refillable water bottle', why: city.essentials.water, group: 'plans' })

  if (weather?.days.length) {
    const hi = Math.max(...weather.days.map(d => d.hi))
    const lo = Math.min(...weather.days.map(d => d.lo))
    const wet = weather.days.filter(d => isWet(d, weather.mode)).length
    if (wet) list.push({ id: 'umbrella', label: 'Compact umbrella or rain jacket', why: `${wet} wet day${wet > 1 ? 's' : ''} ${weather.mode === 'forecast' ? 'in the forecast' : 'on these dates last year'}`, group: 'weather' })
    if (lo < 10) list.push({ id: 'warm', label: 'Warm jacket, layers & a scarf', why: `Down to ${Math.round(lo)}°C`, group: 'weather' })
    else if (lo < 16) list.push({ id: 'layer', label: 'A light jacket for evenings', why: `Evenings around ${Math.round(lo)}°C`, group: 'weather' })
    if (hi > 26) list.push({ id: 'sun', label: 'Sunscreen, sunglasses & a hat', why: `Highs up to ${Math.round(hi)}°C`, group: 'weather' })
  }
  city.essentials.packing.forEach((label, i) => list.push({ id: `local-${i}`, label, group: 'local' }))
  list.push({ id: 'transit', label: city.essentials.transitCard.split(':')[0], why: 'Set it up before you land', group: 'local' })
  return list
}

// ── exports ───────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const icsTime = (date: Date, minutes: number) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}00`
const icsText = (s: string) => s.replace(/[\\,;]/g, m => `\\${m}`).replace(/\n/g, '\\n')

// One calendar event per stop, in the city's local time zone.
export function toICS(city: City, days: DayPlan[], start: string, hotelName?: string): string {
  const first = new Date(`${start}T00:00:00Z`)
  const tz = city.essentials.timezone
  const events = days.flatMap(d => {
    const date = new Date(first.getTime() + (d.day - 1) * 86_400_000)
    return d.stops.map((s, i) => [
      'BEGIN:VEVENT',
      `UID:${d.day}-${i}-${s.place.id}@wayfarer`,
      `DTSTAMP:${icsTime(new Date(), 0)}Z`,
      `DTSTART;TZID=${tz}:${icsTime(date, s.arrive)}`,
      `DTEND;TZID=${tz}:${icsTime(date, s.depart)}`,
      `SUMMARY:${icsText(`${s.place.name} (Day ${d.day})`)}`,
      `LOCATION:${icsText(`${s.place.name}, ${city.name}`)}`,
      `GEO:${s.place.coord[1]};${s.place.coord[0]}`,
      `DESCRIPTION:${icsText(`${s.place.blurb}${s.place.book ? `\nBook ahead: ${s.place.book}` : ''}${hotelName ? `\nBase: ${hotelName}` : ''}`)}`,
      'END:VEVENT',
    ].join('\r\n'))
  })
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wayfarer//Trip//EN', `X-WR-CALNAME:${icsText(`${city.name} trip`)}`, ...events, 'END:VCALENDAR'].join('\r\n')
}

export function toText(city: City, days: DayPlan[], hotel?: HotelScore, start?: string): string {
  const head = `${city.name} — ${days.length} day${days.length > 1 ? 's' : ''}${start ? ` from ${start}` : ''}${hotel ? ` · staying at ${hotel.hotel.name}` : ''}`
  return [head, ...days.map(d => `\nDay ${d.day}: ${d.title}\n${d.stops.map(s => `  ${fmtClock(s.arrive)}  ${s.place.name}`).join('\n')}`)].join('\n')
}
