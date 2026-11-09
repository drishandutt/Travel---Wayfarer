import type { City, LngLat, Place, PlaceSource, TripBrief } from '../types'
import { findCity, tripCity } from '../data/cities'
import { findPlaces } from './edits'
import { haversineKm } from './geo'

// Places the travellers researched themselves, added from chat by name ("add Fuunji ramen to
// day 2") or by sharing a link from a maps app. Reading the message and the link happens here,
// with no network, so the browser and the server agree; finding the place is the server's job
// (`server/places.ts`), since short links and geocoding need it.

export interface CustomPlaceRequest {
  link?: string     // a maps link, as shared
  name?: string     // what they called it, or the text that came with a link
  day?: number      // "… to day 2"; -1 for the last day
  loose?: boolean   // "I want to go to …" rather than "add …": only a find if it reads like a name
}

// What a maps link says on its face. Short links say nothing until they're followed.
export interface MapsLink {
  from: PlaceSource['from']
  name?: string
  coord?: LngLat
  short?: boolean
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi

const MAPS_HOSTS: [RegExp, PlaceSource['from']][] = [
  [/^(?:www\.|maps\.)?google\.[a-z.]+$/, 'google'],
  [/^(?:maps\.app\.)?goo\.gl$/, 'google'],
  [/^(?:maps\.)?apple\.com$/, 'apple'],
  [/^maps\.apple$/, 'apple'],
  [/^(?:www\.)?openstreetmap\.org$/, 'osm'],
  [/^osm\.org$/, 'osm'],
  [/^(?:www\.|ul\.)?waze\.com$/, 'waze'],
]

export function mapsHost(url: string): PlaceSource['from'] | undefined {
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const host = u.hostname.toLowerCase()
  const hit = MAPS_HOSTS.find(([re]) => re.test(host))?.[1]
  // google.com is maps only under /maps (or maps.google.*); goo.gl only under /maps or maps.app
  if (hit === 'google' && /^(?:www\.)?google\./.test(host) && !u.pathname.startsWith('/maps')) return undefined
  if (hit === 'google' && host === 'goo.gl' && !u.pathname.startsWith('/maps')) return undefined
  if (hit === 'apple' && host === 'apple.com') return undefined
  return hit
}

export function findMapsLink(text: string): string | undefined {
  return text.match(URL_RE)?.map(u => u.replace(/[.,;!?]+$/, '')).find(u => mapsHost(u))
}

const num = (s: string | null | undefined) => (s == null || s.trim() === '' ? NaN : Number(s))
function latLng(lat: number, lng: number): LngLat | undefined {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0) ? [lng, lat] : undefined
}
function pair(s: string | null | undefined): LngLat | undefined {
  const m = s?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  return m ? latLng(Number(m[1]), Number(m[2])) : undefined
}
const plus = (s: string) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')).trim() } catch { return s.replace(/\+/g, ' ').trim() }
}

// Everything a maps link gives away without being fetched.
export function parseMapsLink(url: string): MapsLink | undefined {
  const from = mapsHost(url)
  if (!from) return undefined
  const u = new URL(url)
  const q = u.searchParams
  const host = u.hostname.toLowerCase()

  if (from === 'google') {
    if (host === 'goo.gl' || host === 'maps.app.goo.gl') return { from, short: true }
    const path = u.pathname
    // the pin itself (!3d lat !4d lng) is more exact than where the map was looking (@lat,lng)
    const pin = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
    const view = path.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
    const placeName = path.match(/\/maps\/place\/([^/@]+)/)?.[1]
    const query = q.get('q') ?? q.get('query') ?? q.get('destination') ?? q.get('daddr')
    const coord = (pin && latLng(Number(pin[1]), Number(pin[2]))) || pair(query) || pair(q.get('ll')) || featureCoord(q.get('ftid'))
      || (placeName && pair(plus(placeName))) || (view && placeName ? latLng(Number(view[1]), Number(view[2])) : undefined)
    const named = [placeName, query].map(s => (s ? plus(s) : '')).find(s => s && !pair(s))
    return { from, name: named || undefined, coord }
  }
  if (from === 'apple') {
    if (host === 'maps.apple' || /^\/p\//.test(u.pathname)) return { from, short: !q.get('ll') && !q.get('coordinate') }
    const coord = pair(q.get('coordinate')) ?? pair(q.get('ll')) ?? pair(q.get('q')) ?? pair(q.get('daddr'))
    const name = [q.get('name'), q.get('q'), q.get('address')].find(s => s && !pair(s))
    return { from, name: name?.trim() || undefined, coord }
  }
  if (from === 'osm') {
    const m = u.hash.match(/map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/)
    const coord = latLng(num(q.get('mlat')), num(q.get('mlon'))) ?? (m ? latLng(Number(m[1]), Number(m[2])) : undefined)
    return { from, name: q.get('query')?.trim() || undefined, coord }
  }
  return { from, coord: pair(q.get('ll')), name: q.get('q')?.trim() || undefined }
}

// Google's feature ids (`ftid=0x60188908e728e749:0x6de4…`, what a shared short link often leads
// to) start with the S2 cell holding the place: a public geometry scheme, so decoding it gives
// the spot to within a few centimetres without asking Google anything.
export function featureCoord(ftid: string | null | undefined): LngLat | undefined {
  const hex = ftid?.match(/^0x([0-9a-f]{1,16}):0x[0-9a-f]+$/i)?.[1]
  if (!hex) return undefined
  const ll = s2CellCenter(BigInt(`0x${hex}`))
  return ll && latLng(ll[1], ll[0])
}

// S2 cell id → centre [lng, lat], after the reference implementation (s2geometry, Apache 2.0).
const LOOKUP_BITS = 4
const POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]]
const POS_TO_ORIENTATION = [1, 0, 0, 3]
let lookupIJ: number[] | undefined
function buildLookup(): number[] {
  const table: number[] = []
  const cell = (level: number, i: number, j: number, orig: number, pos: number, orientation: number) => {
    if (level === LOOKUP_BITS) { table[(pos << 2) + orig] = (((i << LOOKUP_BITS) + j) << 2) + orientation; return }
    const r = POS_TO_IJ[orientation]
    for (let k = 0; k < 4; k++) cell(level + 1, (i << 1) + (r[k] >> 1), (j << 1) + (r[k] & 1), orig, (pos << 2) + k, orientation ^ POS_TO_ORIENTATION[k])
  }
  for (let o = 0; o < 4; o++) cell(0, 0, 0, o, 0, o)
  return table
}

export function s2CellCenter(id: bigint): LngLat | undefined {
  if (id <= 0n || id >= 1n << 64n) return undefined
  lookupIJ ??= buildLookup()
  const face = Number(id >> 61n)
  if (face > 5) return undefined
  let bits = face & 1
  let i = 0
  let j = 0
  for (let k = 7; k >= 0; k--) {
    const n = k === 7 ? 30 - 7 * LOOKUP_BITS : LOOKUP_BITS
    bits += Number((id >> BigInt(k * 2 * LOOKUP_BITS + 1)) & ((1n << BigInt(2 * n)) - 1n)) << 2
    bits = lookupIJ[bits]
    i += (bits >> (LOOKUP_BITS + 2)) * 2 ** (k * LOOKUP_BITS)
    j += ((bits >> 2) & ((1 << LOOKUP_BITS) - 1)) * 2 ** (k * LOOKUP_BITS)
    bits &= 3
  }
  const uv = (ij: number) => {
    const s = (ij + 0.5) / 2 ** 30
    return s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3
  }
  const [u, v] = [uv(i), uv(j)]
  const [x, y, z] = [[1, u, v], [-u, 1, v], [-u, -v, 1], [-1, -v, -u], [v, -1, -u], [v, u, -1]][face]
  return [(Math.atan2(y, x) * 180) / Math.PI, (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI]
}

// Bare coordinates, as copied from any maps app: "35.6869, 139.6967".
export function parseCoords(text: string): LngLat | undefined {
  const m = text.match(/(?:^|[\s(])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?=$|[\s)])/)
  return m ? latLng(Number(m[1]), Number(m[2])) : undefined
}

// Words that mean a kind of place, a day or more of something: those are plan edits, not a find.
const NOT_A_NAME = /^(?:(?:a|an|another|one|two|three|more|less|fewer|some|any|something|somewhere|anything|extra)\b|(?:day|days|stop|stops|night|nights|hotel|museums?|food|bars?|cafes?|coffee|parks?|markets?|nature|shopping|culture|history|views?|time|break|buffer|rest)$)/i

const DAY_TAIL = /\s+(?:to|on|in|into|for)\s+(?:(?:my|our|the)\s+)?(?:day\s*(\d+|one|two|three|four|five)|(first|second|third|fourth|fifth|last)\s+day)\b.*$/i
const DAY_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }
const LIST_TAIL = /\s+(?:to|on|in|into|onto)\s+(?:(?:my|our|the)\s+)?(?:trip|plan|list|itinerary|map|deck|places|picks)\b.*$/i

// "add Fuunji ramen", "add Fuunji to day 2", "I want to go to Fuunji", a maps link with or
// without words around it, or bare coordinates. Anything else isn't a find.
export function customPlaceRequest(text: string): CustomPlaceRequest | null {
  const link = findMapsLink(text)
  let rest = text.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()

  let day: number | undefined
  const tail = rest.match(DAY_TAIL)
  if (tail) {
    const w = (tail[1] ?? tail[2]).toLowerCase()
    day = w === 'last' ? -1 : Number.isFinite(Number(w)) ? Number(w) : DAY_NUM[w]
    rest = rest.slice(0, tail.index).trim()
  }
  rest = rest.replace(LIST_TAIL, '').trim()

  const verb = rest.match(/^(?:(?:please|pls|can you|could you|also|and|oh|ok(?:ay)?|hey)\s+)*(?:(add|include|save|pin|put|throw in|squeeze in)|(?:i|we)(?:'d| would)? (?:want|like|love|wanna|need) to (?:go to|visit|see|try|eat at|check out)|(?:can|could) (?:we|i) (?:go to|visit|see|try|fit in)|let'?s (?:go to|visit|try)|don'?t forget|must (?:visit|see|try))\s+(.+)$/i)
  let name = (verb ? verb[2] : rest).replace(/^(?:this|that|the place|a place called|somewhere called)\s*:?\s*/i, '').replace(/[.!?]+$/, '').trim()
  name = name.replace(/\s+(?:too|as well|please|pls)$/i, '').trim()

  if (link) return { link, name: name || undefined, day }
  const coord = parseCoords(text)
  if (coord) return { name: name.replace(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/, '').trim() || undefined, day }
  if (!verb || !name || name.length > 80 || NOT_A_NAME.test(name)) return null
  return { name, day, loose: !verb[1] }
}

// Would treating this as a find be right? Not for something we already know (that's a normal
// edit), a city, or a kind of food or place ("add ramen", "I want to try street food"), which
// the planner answers with a deck of options. A loose phrasing also needs a Name-like capital.
export function isFind(req: CustomPlaceRequest, brief: TripBrief): boolean {
  if (req.link || !req.name) return Boolean(req.link)
  if (parseCoords(req.name)) return true
  const city = tripCity(brief)
  if (findCity(req.name)) return false
  const vocab = new Set([...GENERIC_WORDS, ...(city?.places.flatMap(p => (p.keywords ?? []).flatMap(k => k.split(' '))) ?? [])])
  const words = wordsOf(req.name)
  if (words.length && words.every(w => vocab.has(w) || vocab.has(w.replace(/s$/, '')))) return false
  // a place we know, unless they named more than it: "skytree" is ours, "fuunji ramen" isn't "Ramen in Shinjuku"
  const known = city && findPlaces(req.name, city.places)[0]
  if (known && words.filter(w => w.length > 2 && !vocab.has(w)).every(w => wordsOf(known.name).includes(w))) return false
  return !req.loose || /\p{Lu}|[^\p{Script=Latin}\P{L}]/u.test(req.name)
}

const wordsOf = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean)

const GENERIC_WORDS = ['food', 'place', 'places', 'spot', 'spots', 'somewhere', 'something', 'local', 'good', 'great', 'nice', 'cheap', 'best', 'some', 'traditional', 'japanese', 'portuguese', 'restaurant', 'cafe', 'bar', 'bars', 'drinks', 'dinner', 'lunch', 'breakfast', 'brunch', 'temple', 'shrine', 'museum', 'gallery', 'park', 'garden', 'market', 'view', 'views', 'sunset', 'nightlife', 'shopping', 'art', 'beach', 'more', 'it', 'there', 'that', 'this', 'them', 'here']

// The same spot added twice (a link, then its name) is one place.
export function sameSpot(a: Pick<Place, 'name' | 'coord'>, b: Pick<Place, 'name' | 'coord'>): boolean {
  const km = haversineKm(a.coord, b.coord)
  if (km < 0.03) return true
  const key = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')
  return km < 0.25 && Boolean(key(a.name)) && (key(a.name).includes(key(b.name)) || key(b.name).includes(key(a.name)))
}

export function existingSpot(p: Place, city: City): Place | undefined {
  return city.places.find(x => sameSpot(x, p))
}

export interface ResolvedPlace { place: Place; note?: string }

export async function resolveCustomPlace(req: CustomPlaceRequest, brief: TripBrief): Promise<ResolvedPlace> {
  const res = await fetch('/api/places/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link: req.link, name: req.name, city: brief.destination, vibes: brief.vibes }),
  })
  const body = await res.json().catch(() => ({})) as { place?: Place; note?: string; error?: string }
  if (!res.ok || !body.place) throw new Error(body.error ?? `Couldn’t look that place up (error ${res.status}).`)
  return { place: body.place, note: body.note }
}
