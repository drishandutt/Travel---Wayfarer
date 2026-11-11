import { z } from 'zod'
import type { City, DayPlan, Hotel, HotelScore, Place, PlaceKind, TripBrief } from '../src/types'
import { cityById, findCity } from '../src/data/cities'
import { buildDay, scoreHotel, withHotel } from '../src/planner/core'
import { findPlaces } from '../src/planner/edits'
import { existingSpot } from '../src/planner/customPlaces'
import { haversineKm } from '../src/planner/geo'
import { FALLBACK, MODEL, brainEnabled, client, textOf } from './claude'
import { OPENAI_MODEL, openai } from './openai'
import { buildStatus, lookupCity } from './cities/store'
import { resolvePlace } from './places'

// An itinerary someone already made (in Claude, ChatGPT, a doc, a friend's notes), pasted as
// text, turned into a Wayfarer trip: the model reads the city, dates and each day's stops in
// order; places Wayfarer already knows are matched by name and the rest are looked up on the
// map; each day keeps the stops' order and the first stop's time. Used by the trip chat
// (POST /api/import-itinerary) and by Claude through the MCP server (import_itinerary).

export const MAX_DAYS = 14
const KINDS: PlaceKind[] = ['sight', 'food', 'cafe', 'bar', 'park', 'museum', 'market', 'viewpoint']

export class ImportError extends Error {}

const brief = `You read a travel itinerary someone pasted and pull out its structure for a trip planner. One city: the main one the itinerary is in (in plain English, e.g. "Lisbon"). Each day in order, with its stops in the order they're visited: real, visitable places only (sights, restaurants, cafés, bars, parks, museums, markets, viewpoints, neighbourhoods to walk), named as the itinerary names them (don't translate them); never generic activities like "breakfast", "rest", "check in", "free time", "travel to the airport" or a flight. Time: the stop's start time as 24-hour HH:MM if the text gives one, else "". Minutes: how long it's given if the text says, else 0. Kind: the closest of ${KINDS.join(', ')}. Note: anything the text says about the stop worth keeping (what to order, a booking), short, else "". Hotel: where they're staying if named, else "". Start date as YYYY-MM-DD only if a real date is given, else "". Travellers: the number if stated, else 0. If it isn't an itinerary at all, return no days.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['city', 'start_date', 'travelers', 'hotel', 'days'],
  properties: {
    city: { type: 'string' },
    start_date: { type: 'string' },
    travelers: { type: 'integer' },
    hotel: { type: 'string' },
    days: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'stops'],
        properties: {
          title: { type: 'string', description: 'A short title for the day, e.g. "Alfama & the castle", or "".' },
          stops: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['name', 'kind', 'time', 'minutes', 'note'],
              properties: { name: { type: 'string' }, kind: { type: 'string', enum: KINDS }, time: { type: 'string' }, minutes: { type: 'integer' }, note: { type: 'string' } },
            },
          },
        },
      },
    },
  },
} as const

const Parsed = z.object({
  city: z.string(),
  start_date: z.string(),
  travelers: z.number().int(),
  hotel: z.string(),
  days: z.array(z.object({
    title: z.string(),
    stops: z.array(z.object({ name: z.string(), kind: z.enum(KINDS as [PlaceKind, ...PlaceKind[]]), time: z.string(), minutes: z.number().int(), note: z.string() })),
  })),
})
export type ParsedItinerary = z.infer<typeof Parsed>

export async function parseItinerary(text: string, signal?: AbortSignal): Promise<ParsedItinerary> {
  let json: string
  if (brainEnabled) {
    const response = await client.beta.messages.create({
      ...FALLBACK, model: MODEL, max_tokens: 16000, system: brief,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: text }],
    }, { signal })
    if (response.stop_reason === 'refusal') throw new ImportError('I couldn’t read that itinerary.')
    json = textOf(response)
  } else if (openai) {
    const response = await openai.responses.create({
      model: OPENAI_MODEL, reasoning: { effort: 'low' }, instructions: brief, input: text,
      text: { format: { type: 'json_schema', name: 'itinerary', strict: true, schema: SCHEMA as unknown as Record<string, unknown> } },
    }, { signal })
    if (response.status !== 'completed') throw new ImportError('I couldn’t read that itinerary.')
    json = response.output_text
  } else throw new ImportError('Reading a pasted itinerary needs Claude or OpenAI connected on the server.')
  return Parsed.parse(JSON.parse(json))
}

// The city the itinerary is in, mapped first if Wayfarer doesn't know it yet (up to a minute).
export async function cityFor(name: string, userId?: string | null, signal?: AbortSignal): Promise<City> {
  const known = findCity(name) ?? cityById(name.toLowerCase())
  if (known) return known
  const look = await lookupCity(name, signal, userId ?? null)
  if (look.status === 'unknown') throw new ImportError(`I couldn’t find a travel guide for “${name}”. Try its English name or the nearest city.`)
  if (look.status === 'failed') throw new ImportError(look.error)
  if (look.status === 'building') {
    for (let i = 0; i < 50 && buildStatus(look.id)?.status === 'building'; i++) await new Promise(r => setTimeout(r, 1500))
    if (buildStatus(look.id)?.status === 'failed') throw new ImportError(buildStatus(look.id)?.error ?? `I couldn’t map ${look.name}.`)
  }
  const city = cityById(look.id)
  if (!city) throw new ImportError(`I’m still mapping ${look.name}. Send the itinerary again in a minute.`)
  return city
}

const clock = (t: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : undefined
}

// A name Wayfarer already has for this city: a close match only, so "Time Out Market" isn't
// taken for any market.
const known = <T extends { name: string }>(name: string, pool: T[]): T | undefined => findPlaces(name, pool as unknown as Place[], 0.99)[0] as unknown as T | undefined

// A place found on the map that Wayfarer already has under another name ("Mosteiro dos
// Jerónimos" for "Jerónimos Monastery"): the same spot, or close by and sharing a distinctive word.
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const COMMON = new Set(['museum', 'museu', 'museo', 'musee', 'church', 'igreja', 'market', 'mercado', 'garden', 'jardim', 'palace', 'palacio', 'tower', 'torre', 'square', 'praca', 'plaza', 'street', 'cafe', 'restaurant', 'miradouro', 'viewpoint', 'castle', 'castelo', 'national', 'nacional'])
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(w => w.length >= 5 && !COMMON.has(w))
export function catalogTwin(p: Place, city: City): Place | undefined {
  const same = existingSpot(p, city)
  if (same) return same
  const mine = new Set(words(p.name))
  return mine.size ? city.places.find(x => haversineKm(x.coord, p.coord) < 0.35 && words(x.name).some(w => mine.has(w))) : undefined
}

async function mapAll<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

export interface Imported {
  city: City
  brief: TripBrief
  days: DayPlan[]
  hotel: HotelScore | undefined
  hotelScores: HotelScore[]
  places: Place[]            // every stop's place, in order
  custom: Place[]            // the ones looked up on the map, not in Wayfarer's catalog
  missed: string[]           // stops that couldn't be found
  trimmed: number            // days past MAX_DAYS that were left out
}

interface ImportOptions { userId?: string | null; signal?: AbortSignal; base?: Partial<TripBrief> }

export async function importItinerary(text: string, opts: ImportOptions = {}): Promise<Imported> {
  return fromParsed(await parseItinerary(text, opts.signal), opts)
}

// The trip from what the model read: separate so it can be tested without a model.
export async function fromParsed(parsed: ParsedItinerary, opts: ImportOptions = {}): Promise<Imported> {
  const days = parsed.days.filter(d => d.stops.length || d.title.trim())
  if (!days.length) throw new ImportError('That doesn’t look like an itinerary: I couldn’t find any days with places in it.')
  if (!parsed.city.trim()) throw new ImportError('Which city is this itinerary for? Add the city and paste it again.')
  const city = await cityFor(parsed.city, opts.userId, opts.signal)
  const kept = days.slice(0, MAX_DAYS)

  // each stop: Wayfarer's own place by that name, else found on the map (kept to this trip)
  const missed: string[] = []
  const custom: Place[] = []
  const stops = kept.flatMap((d, di) => d.stops.map(st => ({ ...st, day: di })))
  const found = await mapAll(stops, 3, async st => {
    const have = known(st.name, city.places)
    if (have) return have
    try {
      const r = await resolvePlace({ name: st.name, kind: st.kind, city: city.id, describe: false }, opts.signal)
      const twin = catalogTwin(r.place, city)
      if (twin) return twin
      const place: Place = {
        ...r.place,
        kind: st.kind,
        ...(st.minutes > 0 ? { minutes: Math.min(360, st.minutes) } : {}),
        ...(st.note.trim() ? { blurb: st.note.trim().slice(0, 90) } : {}),
      }
      custom.push(place)
      return place
    } catch {
      missed.push(st.name)
      return undefined
    }
  })

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.start_date) ? parsed.start_date : undefined
  const tb: TripBrief = {
    vibes: [],
    ...opts.base,
    destination: city.id,
    days: kept.length,
    travelers: parsed.travelers > 0 ? parsed.travelers : opts.base?.travelers ?? 2,
    ...(startDate ? { startDate } : {}),
    customPlaces: [...(opts.base?.customPlaces ?? []), ...custom.filter((p, i, all) => all.findIndex(x => x.id === p.id) === i)],
  }
  const places: Place[] = []
  const plans = kept.map((d, di) => {
    const today = stops.flatMap((st, i) => (st.day === di && found[i] ? [{ place: found[i]!, time: clock(st.time) }] : []))
      .filter((x, i, all) => all.findIndex(y => y.place.id === x.place.id) === i)
    const mine = today.map(x => x.place)
    places.push(...mine)
    const title = d.title.trim().slice(0, 60) || (mine.length === 1 ? mine[0].name : undefined)
    const plan = buildDay(di + 1, mine, tb, { keepOrder: true, start: today[0]?.time, times: today.map(x => x.time), ...(title ? { title } : {}) })
    return { ...plan, title: plan.title || `Day ${di + 1}` }
  })

  // their hotel if Wayfarer knows it, or one placed from the map; else the best base for these days
  const hotelScores = city.hotels.map(h => scoreHotel(h, tb, plans))
  let hotel: HotelScore | undefined
  if (parsed.hotel.trim()) {
    const named = known(parsed.hotel, city.hotels)
    if (named) hotel = hotelScores.find(s => s.hotel.id === named.id)
    else {
      try {
        const r = await resolvePlace({ name: parsed.hotel, city: city.id, describe: false }, opts.signal)
        const h: Hotel = { id: `my-hotel-${r.place.id}`, name: r.place.name, coord: r.place.coord, nightly: 0, tier: tb.budgetTier ?? 'comfort', tags: [], blurb: 'Where you’re staying.' }
        hotel = { ...scoreHotel(h, tb, plans), priceFit: 1 }
      } catch { /* left to the best fit below */ }
    }
  }
  hotel ??= [...hotelScores].sort((a, b) => b.total - a.total)[0]
  return {
    city, brief: tb, days: hotel ? withHotel(hotel.hotel, plans) : plans, hotel, hotelScores: hotel && !hotelScores.includes(hotel) ? [hotel, ...hotelScores] : hotelScores,
    places, custom, missed, trimmed: days.length - kept.length,
  }
}

// What was imported, in a sentence or two, for the chat or Claude.
export function importSummary(r: Imported): string {
  const n = r.places.length
  const parts = [`I’ve made your ${r.city.name} itinerary into a trip: ${r.days.length} day${r.days.length > 1 ? 's' : ''}, ${n} place${n === 1 ? '' : 's'} in your order${r.hotel ? `, staying at ${r.hotel.hotel.name}` : ''}.`]
  if (r.custom.length) parts.push(`${r.custom.length} ${r.custom.length === 1 ? 'wasn’t' : 'weren’t'} in Wayfarer yet, so I found ${r.custom.length === 1 ? 'it' : 'them'} on the map.`)
  if (r.missed.length) parts.push(`I couldn’t find ${r.missed.slice(0, 5).map(m => `“${m}”`).join(', ')}${r.missed.length > 5 ? ` and ${r.missed.length - 5} more` : ''}; send ${r.missed.length === 1 ? 'it' : 'them'} with a maps link to add ${r.missed.length === 1 ? 'it' : 'them'}.`)
  if (r.trimmed) parts.push(`Wayfarer plans up to ${MAX_DAYS} days, so I left out the last ${r.trimmed}.`)
  return parts.join(' ')
}
