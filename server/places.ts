import { z } from 'zod'
import type { City, LngLat, Place, PlaceKind, PlaceSource, Vibe } from '../src/types'
import type { PlaceVideos, Video } from '../src/services/videos'
import { NEARBY_KM, cityById } from '../src/data/cities'
import { mapsHost, parseCoords, parseMapsLink, type MapsLink } from '../src/planner/customPlaces'
import { haversineKm } from '../src/planner/geo'
import { FALLBACK, brainEnabled, client, textOf, MODEL_LIGHT } from './claude'
import { openai, openaiLightModel } from './openai'
import type { Db } from './money/db'
import { PROFILE_PROPS, PROFILE_REQUIRED, ProfileOut, profileFrom } from './cities/profile'
import { priorReview, promoteFind, queueReview } from './cities/store'
import { track } from './dev/activity'
import { asJob, canSearch } from './usage'

// Travellers' own places: find what they shared or typed, and the reels and videos of it.
//   resolvePlace  a maps link (Google, Apple, OpenStreetMap, Waze, bare coordinates) or a name
//                 → a Place, located with OpenStreetMap and described by Claude (or OpenAI)
//   placeVideos   YouTube from its search page (or the Data API with YOUTUBE_API_KEY), and
//                 Instagram reels and TikToks through Claude's (or OpenAI's) web search, since
//                 neither has an open search to ask. Claude when ANTHROPIC_API_KEY is set,
//                 otherwise OpenAI when OPENAI_API_KEY is

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const VIBES: Vibe[] = ['food', 'culture', 'nightlife', 'nature', 'art', 'shopping', 'relaxed', 'adventure', 'romantic', 'history']
const KINDS: PlaceKind[] = ['sight', 'food', 'cafe', 'bar', 'park', 'museum', 'market', 'viewpoint', 'experience']

export class PlaceError extends Error {}

// ── links ────────────────────────────────────────────────────────────────────

// Short links (maps.app.goo.gl, maps.apple/p/…) only say where they go when followed. Only maps
// hosts are ever fetched, hop by hop, so a link can't send this server anywhere else.
export async function expandLink(url: string, signal?: AbortSignal): Promise<MapsLink & { url: string }> {
  let current = url
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current)
    // Google asks for cookie consent in the EU before redirecting; the place is in `continue`
    if (/^consent\.google\./.test(u.hostname)) {
      const next = u.searchParams.get('continue')
      if (!next) break
      current = next
      continue
    }
    const parsed = parseMapsLink(current)
    if (!parsed) break
    if (!parsed.short && (parsed.coord || parsed.name)) return { ...parsed, url: current }
    // an honest, plain user agent: Google answers a browser's with an "open in the app" page instead of the redirect
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'Wayfarer trip planner (link preview)', 'Accept-Language': 'en' }, signal: anySignal(signal, 8000) })
    const location = res.headers.get('location')
    if (location && res.status >= 300 && res.status < 400) {
      current = new URL(location, current).toString()
      continue
    }
    if (res.ok) {
      const fromPage = readPlacePage(await res.text())
      if (fromPage.coord || fromPage.name) return { ...parsed, ...fromPage, short: false, url: current }
    }
    break
  }
  const parsed = parseMapsLink(current)
  if (parsed && (parsed.coord || parsed.name)) return { ...parsed, url: current }
  throw new PlaceError('That link didn’t lead to a place I could read. Try sharing it again, or just type the place’s name.')
}

// A maps page that didn't redirect still names the place in its meta tags, or links to itself in full.
export function readPlacePage(html: string): { name?: string; coord?: LngLat } {
  const meta = (prop: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'))?.[1]
  const lat = Number(meta('place:location:latitude'))
  const lng = Number(meta('place:location:longitude'))
  const full = html.match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps\/place\/[^"'\s\\<>]+|https:\/\/maps\.apple\.com\/(?:place)?\?[^"'\s\\<>]+/)?.[0]
  const inner = full ? parseMapsLink(full.replace(/&amp;/g, '&')) : undefined
  const coord: LngLat | undefined = Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? [lng, lat] : inner?.coord
  const title = meta('og:title')?.replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/\s*[-–·|]\s*(?:Google Maps|Apple Maps)\s*$/i, '').trim()
  return { coord, name: inner?.name ?? (title && !/^(?:Google|Apple) Maps$/i.test(title) ? title : undefined) }
}

// ── OpenStreetMap ────────────────────────────────────────────────────────────

interface OsmHit {
  lat: string
  lon: string
  name?: string
  display_name: string
  category?: string
  type?: string
  importance?: number
  address?: Record<string, string>
  namedetails?: Record<string, string> | null
  extratags?: Record<string, string> | null
}

// Nominatim allows one request a second and asks to be told who's calling.
let lastCall = 0
let queue: Promise<unknown> = Promise.resolve()
export function nominatim<T>(path: 'search' | 'reverse', params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + 1100 - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastCall = Date.now()
    const q = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', namedetails: '1', extratags: '1', 'accept-language': 'en', ...params })
    const res = await fetch(`https://nominatim.openstreetmap.org/${path}?${q}`, { headers: { 'User-Agent': 'Wayfarer trip planner (custom places)' }, signal: anySignal(signal, 8000) })
    if (!res.ok) throw new PlaceError(`The map lookup is busy right now (OpenStreetMap ${res.status}). Try again in a moment.`)
    return res.json() as Promise<T>
  })
  queue = run.catch(() => {})
  return run
}

const hitCoord = (h: OsmHit): LngLat => [Number(h.lon), Number(h.lat)]
const hitName = (h: OsmHit) => h.namedetails?.['name:en'] ?? h.name ?? h.namedetails?.name

function box(c: LngLat, dLng: number, dLat: number) {
  return { viewbox: [c[0] - dLng, c[1] + dLat, c[0] + dLng, c[1] - dLat].map(n => n.toFixed(5)).join(','), bounded: '1' }
}

async function searchName(name: string, near: LngLat, radius: 'spot' | 'city', city: City, signal?: AbortSignal, widen = true): Promise<OsmHit | undefined> {
  const area = radius === 'spot' ? box(near, 0.006, 0.005) : box(near, 0.6, 0.45)
  const hits = await nominatim<OsmHit[]>('search', { q: name, limit: '5', ...area }, signal)
  // OpenStreetMap ranks by fame, so "Sintra Palace" would be whichever palace is best known:
  // the words they typed, in the place's own name first, decide before fame does
  const ranked = hits
    .map(h => ({ h, km: haversineKm(hitCoord(h), near), words: wordsMatched(name, h) }))
    .filter(x => (radius === 'spot' ? x.km < 0.4 : true))
    .sort((a, b) => (radius === 'spot' ? a.km - b.km : b.words - a.words || (b.h.importance ?? 0) - (a.h.importance ?? 0)))
  if (ranked.length || radius === 'spot' || !widen) return ranked[0]?.h
  // not in the city's box: perhaps a day trip, so ask again by name and city and keep it if it's in reach
  const wider = await nominatim<OsmHit[]>('search', { q: `${name}, ${city.name}`, limit: '3' }, signal)
  return wider.find(h => haversineKm(hitCoord(h), city.center) <= NEARBY_KM)
}

// The ways a typed name can be put to the map: "ATOM (Atom Shinjuku)" is "ATOM", "Atom Shinjuku",
// and, since many places carry their city in their name, "ATOM Tokyo".
export function nameVariants(name: string, city: string): string[] {
  const inner = name.match(/\(([^)]+)\)/)?.[1]?.trim()
  const outer = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const bare = [outer, inner].filter((s): s is string => Boolean(s) && !fold(s!).includes(fold(city)))
  const all = [name.trim(), outer, inner, ...bare.map(s => `${s} ${city}`)]
  return [...new Set(all.filter((s): s is string => Boolean(s && s.length > 1)))].slice(0, 5)
}

// Does the map call it what they asked for? "nightclub" for amenity=nightclub, "club" too.
export function isKind(h: Pick<OsmHit, 'category' | 'type'>, kind: string | undefined): boolean {
  const k = fold(kind ?? '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length >= 3).map(w => w.replace(/s$/, ''))
  const t = fold(`${h.type ?? ''}`)
  return k.length > 0 && t.length > 0 && k.some(w => t.includes(w) || w.includes(t))
}

// By name alone, across the city: the first hit whose own name carries every word they typed and,
// when they said what it is, is that kind of place; otherwise the best of what came back.
async function findByName(name: string, kind: string | undefined, city: City, signal?: AbortSignal): Promise<OsmHit | undefined> {
  let best: OsmHit | undefined
  for (const v of nameVariants(name, city.name)) {
    const hit = await searchName(v, city.center, 'city', city, signal, false)
    if (!hit) continue
    const whole = wordsMatched(v, hit) >= 2 * fold(v).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3).length
    if (kind ? isKind(hit, kind) : whole) return hit
    if (!best || (kind && isKind(hit, kind))) best = hit
  }
  // not in the city's box: perhaps a day trip
  return best ?? searchName(name, city.center, 'city', city, signal)
}

function wordsMatched(query: string, h: OsmHit): number {
  const own = fold([hitName(h), h.name].join(' '))
  const all = fold(h.display_name)
  return fold(query).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3).reduce((n, w) => n + (own.includes(w) ? 2 : all.includes(w) ? 1 : 0), 0)
}

// The map's own spelling when it's the same place in a script they can read, so "fuunji"
// stays theirs but "sintra palace" becomes "Sintra National Palace".
function displayName(typed: string | undefined, hit: OsmHit | undefined): string | undefined {
  const own = hit && hitName(hit)
  if (own && /^[\p{Script=Latin}\P{L}]+$/u.test(own) && (!typed || mentions(own, typed))) return own
  return typed && typed === typed.toLowerCase() ? typed.replace(/(^|\s)\p{L}/gu, c => c.toUpperCase()) : typed
}

// ── what kind of place it is ─────────────────────────────────────────────────

interface Shape { kind: PlaceKind; tags: Vibe[]; label: string }

export function shapeOf(category = '', type = '', extra: Record<string, string> = {}): Shape {
  const t = type.replace(/_/g, ' ')
  if (category === 'amenity') {
    if (['restaurant', 'fast_food', 'food_court'].includes(type)) return { kind: 'food', tags: ['food'], label: extra.cuisine ? `${extra.cuisine.split(';')[0].replace(/_/g, ' ')} restaurant` : t }
    if (['cafe', 'ice_cream'].includes(type)) return { kind: 'cafe', tags: ['food', 'relaxed'], label: t }
    if (['bar', 'pub', 'biergarten', 'nightclub'].includes(type)) return { kind: 'bar', tags: ['nightlife'], label: t }
    if (type === 'marketplace') return { kind: 'market', tags: ['food', 'shopping'], label: 'market' }
    if (type === 'place_of_worship') return { kind: 'sight', tags: ['culture', 'history'], label: extra.religion === 'shinto' ? 'shrine' : extra.religion === 'buddhist' ? 'temple' : 'place of worship' }
    if (['theatre', 'arts_centre', 'cinema'].includes(type)) return { kind: 'sight', tags: ['art', 'culture'], label: t }
  }
  if (category === 'tourism') {
    if (['museum', 'gallery'].includes(type)) return { kind: 'museum', tags: ['art', 'culture'], label: t }
    if (type === 'viewpoint') return { kind: 'viewpoint', tags: ['romantic'], label: 'viewpoint' }
    if (['theme_park', 'zoo', 'aquarium'].includes(type)) return { kind: 'sight', tags: ['adventure'], label: t }
  }
  if (category === 'leisure' && ['park', 'garden', 'nature_reserve'].includes(type)) return { kind: 'park', tags: ['nature', 'relaxed'], label: t }
  if (category === 'natural') return type === 'peak' ? { kind: 'viewpoint', tags: ['nature', 'adventure'], label: 'peak' } : { kind: 'park', tags: ['nature'], label: t }
  if (category === 'historic') return { kind: 'sight', tags: ['history', 'culture'], label: t === 'yes' ? 'historic site' : t }
  if (category === 'shop') return { kind: 'sight', tags: ['shopping'], label: type === 'yes' ? 'shop' : `${t} shop` }
  return { kind: 'sight', tags: ['culture'], label: category === 'tourism' && type === 'attraction' ? 'sight' : 'spot' }
}

const DEFAULTS: Record<PlaceKind, Pick<Place, 'minutes' | 'price' | 'bestAt'>> = {
  food: { minutes: 60, price: 2, bestAt: 'evening' },
  cafe: { minutes: 45, price: 1, bestAt: 'midday' },
  bar: { minutes: 90, price: 2, bestAt: 'night' },
  museum: { minutes: 90, price: 2, bestAt: 'midday' },
  park: { minutes: 60, price: 0, bestAt: 'morning' },
  viewpoint: { minutes: 45, price: 0, bestAt: 'evening' },
  market: { minutes: 60, price: 1, bestAt: 'midday' },
  sight: { minutes: 60, price: 1, bestAt: 'midday' },
  experience: { minutes: 120, price: 2, bestAt: 'midday' },
}

function shortAddress(a: Record<string, string> = {}): string | undefined {
  const local = a.neighbourhood ?? a.quarter ?? a.suburb ?? a.city_district
  const wider = a.city_district && a.city_district !== local ? a.city_district : a.city ?? a.town
  return [local, wider].filter(Boolean).join(', ') || undefined
}

// ── Claude's read on it (optional) ───────────────────────────────────────────

const DESCRIBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'tags', 'price', 'minutes', 'best_at', 'blurb', 'keywords', 'public', 'profile'],
  properties: {
    kind: { type: 'string', enum: KINDS },
    tags: { type: 'array', items: { type: 'string', enum: VIBES } },
    price: { type: 'integer' },
    minutes: { type: 'integer' },
    best_at: { type: 'string', enum: ['morning', 'midday', 'evening', 'night'] },
    blurb: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    public: { type: 'string', enum: ['yes', 'no', 'unsure'], description: 'yes if other travellers could visit it: an attraction, restaurant, café, bar, park, market, shop, street or viewpoint worth going to. no for a private home, an address, an office, a hotel room, a school or anything not open to visitors. unsure if you can’t tell.' },
    profile: { type: 'object', additionalProperties: false, required: [...PROFILE_REQUIRED], properties: PROFILE_PROPS },
  },
} as const

const Described = z.object({
  kind: z.enum(KINDS as [PlaceKind, ...PlaceKind[]]),
  tags: z.array(z.enum(VIBES as [Vibe, ...Vibe[]])),
  price: z.number().int(),
  minutes: z.number().int(),
  best_at: z.enum(['morning', 'midday', 'evening', 'night']),
  blurb: z.string(),
  keywords: z.array(z.string()),
  public: z.enum(['yes', 'no', 'unsure']),
  profile: ProfileOut,
})

const describeBrief = (city: City) => `You describe a place a traveller found themselves and added to their ${city.name} trip, for a trip planner. Use what you know about the place itself; if you don't recognise it, describe only what its map data says and keep it plain. Never invent awards, dishes or history. Blurb: one short line, under 60 characters, in the style "Solo-booth tonkotsu, open late." Price: 0 free to 3 splurge. Minutes: a typical visit. Keywords: up to 6 lowercase words people would search by (cuisine, style), or none. Tags: 1-3 that truly fit. Public: whether other travellers could go there too. Profile: what it does well, what to know before going, and who it suits (first-timers, locals, families, couples, solo, groups, foodies, night-owls, early-birds, budget, splurge, crowd-averse, wanderers, adventurous, chill); known=false if you don't actually recognise the place.`

interface Described { place: Partial<Place>; public?: 'yes' | 'no' | 'unsure' }

async function describe(p: Place, city: City, osm: string, signal?: AbortSignal): Promise<Described> {
  return asJob('describe', async () => {
    const about = `Name: ${p.name}\nWhere: ${p.custom?.address ?? city.name}, ${city.name}\nMap data: ${osm}`
    let json: string
    let by: 'claude' | 'openai' = 'claude'
    if (brainEnabled) {
      const response = await client.beta.messages.create({
        ...FALLBACK,
        model: MODEL_LIGHT,
        max_tokens: 4000,
        system: describeBrief(city),
        output_config: { effort: 'low', format: { type: 'json_schema', schema: DESCRIBE_SCHEMA } },
        messages: [{ role: 'user', content: about }],
      }, { signal: anySignal(signal, 20_000) })
      if (response.stop_reason !== 'end_turn') return { place: {} }
      json = textOf(response)
    } else if (openai) {
      const response = await openai.responses.create({
        model: openaiLightModel(),
        reasoning: { effort: 'low' },
        instructions: describeBrief(city),
        input: about,
        text: { format: { type: 'json_schema', name: 'place', strict: true, schema: DESCRIBE_SCHEMA as unknown as Record<string, unknown> } },
      }, { signal: anySignal(signal, 20_000) })
      if (response.status !== 'completed') return { place: {} }
      json = response.output_text
      by = 'openai'
    } else return { place: {} }
    const d = Described.parse(JSON.parse(json))
    const place: Partial<Place> = {
      kind: d.kind,
      tags: d.tags.length ? [...new Set(d.tags)].slice(0, 3) : p.tags,
      price: Math.max(0, Math.min(3, d.price)) as Place['price'],
      minutes: Math.max(15, Math.min(240, d.minutes)),
      bestAt: d.best_at,
      blurb: d.blurb.trim().slice(0, 90) || p.blurb,
      keywords: d.keywords.map(k => k.toLowerCase().trim()).filter(Boolean).slice(0, 6),
    }
    const profile = profileFrom(d.profile, { ...p, ...place }, by)
    return { place: profile ? { ...place, profile } : place, public: d.public }
  })
}

// Somewhere other travellers could go, by what the map calls it: not a house, an office, a
// school or a hotel. The model's own view is read on top of this (`decideFind`).
const VENUE_AMENITY = new Set(['restaurant', 'fast_food', 'food_court', 'cafe', 'ice_cream', 'bar', 'pub', 'biergarten', 'nightclub', 'marketplace', 'place_of_worship', 'theatre', 'arts_centre', 'cinema', 'casino', 'library', 'planetarium', 'fountain', 'public_bath', 'spa', 'events_venue', 'music_venue'])
const STAYS = new Set(['hotel', 'hostel', 'guest_house', 'motel', 'apartment', 'chalet', 'camp_site', 'caravan_site', 'information', 'alpine_hut'])
const LEISURE = new Set(['park', 'garden', 'nature_reserve', 'water_park', 'beach_resort', 'stadium', 'ice_rink', 'amusement_arcade', 'marina', 'playground', 'miniature_golf', 'escape_game', 'bowling_alley'])
// What the map says it is: clearly somewhere to visit, clearly someone's home or work, or
// something in between (a street, a building, a spot with no category) that needs a look.
const PRIVATE_BUILDINGS = new Set(['house', 'residential', 'apartments', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'dormitory', 'farm', 'garage', 'garages', 'shed', 'hut', 'static_caravan', 'houseboat'])
const PRIVATE_AMENITY = new Set(['school', 'kindergarten', 'childcare', 'hospital', 'clinic', 'doctors', 'dentist', 'pharmacy', 'police', 'fire_station', 'bank', 'atm', 'parking', 'parking_space', 'fuel', 'post_office', 'toilets', 'recycling', 'waste_basket', 'waste_disposal', 'bench', 'shelter', 'social_facility', 'nursing_home', 'prison', 'courthouse', 'bicycle_parking', 'charging_station', 'vending_machine', 'telephone'])
export function mapSays(h: Pick<OsmHit, 'category' | 'type'> | undefined): 'venue' | 'private' | 'unclear' {
  if (!h?.category || !h.type) return 'unclear'
  if (isVenue(h)) return 'venue'
  if (h.category === 'building' && PRIVATE_BUILDINGS.has(h.type)) return 'private'
  if (h.category === 'place' && ['house', 'houses', 'plot'].includes(h.type)) return 'private'
  if (h.category === 'landuse' && ['residential', 'industrial', 'commercial', 'construction', 'farmyard', 'garages'].includes(h.type)) return 'private'
  if (h.category === 'office' || h.category === 'craft') return 'private'
  if (h.category === 'amenity' && PRIVATE_AMENITY.has(h.type)) return 'private'
  if (h.category === 'tourism' && STAYS.has(h.type)) return 'private'
  return 'unclear'
}

export type FindDecision = { decision: 'share' | 'review' | 'private'; reason: string }

// Whether a traveller's find joins the city's catalog for everyone. Clear either way, the
// system decides; when the map and the model disagree, or neither can tell, the owner does,
// from the dev tools' review queue.
export function decideFind(map: 'venue' | 'private' | 'unclear', model: 'yes' | 'no' | 'unsure' | undefined, name: string): FindDecision {
  if (/^\d+[\s,]/.test(name) || /\b(?:flat|apt|apartment|unit|suite)\s*\d/i.test(name)) return { decision: 'private', reason: 'its name reads like an address' }
  if (map === 'venue') {
    if (model === 'yes' || model === undefined) return { decision: 'share', reason: model ? 'the map and the AI agree it’s somewhere to visit' : 'the map lists it as somewhere to visit' }
    return { decision: 'review', reason: model === 'no' ? 'the map lists it as somewhere to visit, but the AI thinks it isn’t open to visitors' : 'the map lists it as somewhere to visit, but the AI couldn’t tell' }
  }
  if (map === 'private') {
    if (model === 'yes') return { decision: 'review', reason: 'the map calls it a home or workplace, but the AI thinks it’s somewhere to visit' }
    return { decision: 'private', reason: 'the map calls it a home or workplace' }
  }
  if (model === 'no') return { decision: 'private', reason: 'the AI thinks it isn’t open to visitors, and the map doesn’t say' }
  return { decision: 'review', reason: model === 'yes' ? 'the AI thinks it’s somewhere to visit, but the map doesn’t say what it is' : model === 'unsure' ? 'neither the map nor the AI can tell what it is' : 'the map doesn’t say what it is, and no AI is connected to ask' }
}

export function isVenue(h: Pick<OsmHit, 'category' | 'type'> | undefined): boolean {
  if (!h?.category || !h.type) return false
  switch (h.category) {
    case 'tourism': return !STAYS.has(h.type)
    case 'amenity': return VENUE_AMENITY.has(h.type)
    case 'leisure': return LEISURE.has(h.type)
    case 'natural': case 'historic': case 'shop': return true
    default: return false
  }
}

// ── resolve ──────────────────────────────────────────────────────────────────

export interface ResolveRequest { link?: string; name?: string; city?: string; kind?: string; coord?: LngLat; describe?: boolean }

export interface Resolved { place: Place; note?: string; shared?: boolean; review?: boolean; map: 'venue' | 'private' | 'unclear'; category: string | null; model?: 'yes' | 'no' | 'unsure' }

// `userId`: who's asking, when they're signed in. Given at all (null for a guest), a find that's
// somewhere other travellers could visit goes into the city's shared catalog too (`shared`), and
// one the system can't call goes to the owner's review queue (`review`). `coord`: where it is,
// when already known (an import with coordinates).
export async function resolvePlace(req: ResolveRequest, signal?: AbortSignal, userId?: string | null): Promise<Resolved> {
  const city = cityById(req.city)
  if (!city) throw new PlaceError('Tell me which city the trip is in first, then send the place again.')
  const typed = req.name?.trim().slice(0, 120) || undefined

  let source: PlaceSource = { from: 'name' }
  let name = typed
  let coord: LngLat | undefined
  if (req.link) {
    if (!mapsHost(req.link)) throw new PlaceError('I can read links from Google Maps, Apple Maps, OpenStreetMap and Waze.')
    const link = await expandLink(req.link, signal)
    source = { from: link.from, url: req.link }
    coord = link.coord
    // the words that came with a shared link are usually its name; the link's own name is better still
    name = link.name ?? typed
  } else if (typed && parseCoords(typed)) {
    coord = parseCoords(typed)
    source = { from: 'coords' }
    name = undefined
  } else if (req.coord && Number.isFinite(req.coord[0]) && Number.isFinite(req.coord[1]) && Math.abs(req.coord[1]) <= 90 && Math.abs(req.coord[0]) <= 180) {
    coord = req.coord
    source = { from: 'coords' }
  }
  if (!name && !coord) throw new PlaceError('Which place? Send its name or a link from your maps app.')

  let hit: OsmHit | undefined
  if (coord && name) hit = await searchName(name, coord, 'spot', city, signal)
  if (coord && !hit) {
    const rev = await nominatim<OsmHit & { error?: string }>('reverse', { lat: coord[1].toFixed(6), lon: coord[0].toFixed(6), zoom: '18' }, signal)
    if (!rev.error) hit = rev
  }
  if (!coord && name) {
    hit = await findByName(name, req.kind?.slice(0, 40), city, signal)
    if (!hit) throw new PlaceError(`I couldn’t find “${name}” on the map around ${city.name}. A link from Google Maps or Apple Maps always works, or try its full name.`)
    coord = hitCoord(hit)
  }
  coord = coord!
  name = displayName(name, hit) ?? hit?.address?.road
  if (!name) {
    const where = shortAddress(hit?.address)
    throw new PlaceError(`I found the spot${where ? ` (${where})` : ''}, but the map I use doesn’t have its name. What’s it called? Send the name with the link, e.g. “Fuunji ${req.link ?? ''}”.`.replace(/\s+”/, '”'))
  }

  const km = haversineKm(coord, city.center)
  if (km > NEARBY_KM) throw new PlaceError(`${name} is about ${Math.round(km)} km from ${city.name}, too far to fit into this trip.`)

  const shape = shapeOf(hit?.category, hit?.type, hit?.extratags ?? {})
  const address = shortAddress(hit?.address)
  const place: Place = {
    id: `my-${slug(name)}-${Math.round(coord[0] * 1e4).toString(36)}${Math.round(coord[1] * 1e4).toString(36)}`.replace(/--+/g, '-'),
    name: name.slice(0, 80),
    kind: shape.kind,
    coord: [Number(coord[0].toFixed(6)), Number(coord[1].toFixed(6))],
    tags: shape.tags,
    ...DEFAULTS[shape.kind],
    blurb: `Your find: ${article(shape.label)} ${shape.label}${address ? ` in ${address}` : ''}.`,
    keywords: hit?.extratags?.cuisine?.split(';').map(c => c.replace(/_/g, ' ')).slice(0, 4),
    ...(hit?.extratags?.opening_hours ? { hours: hit.extratags.opening_hours.slice(0, 160) } : {}),
    ...(linksOf(hit?.extratags) ? { links: linksOf(hit?.extratags) } : {}),
    custom: { ...source, ...(address ? { address } : {}) },
  }

  const notes: string[] = []
  if (km > 25) notes.push(`It’s about ${Math.round(km)} km out of ${city.name}, so it may want a day of its own.`)
  let modelSays: 'yes' | 'no' | 'unsure' | undefined
  if ((brainEnabled || openai) && req.describe !== false) {
    const osm = hit ? `${hit.category}/${hit.type}; ${Object.entries(hit.extratags ?? {}).filter(([k]) => /cuisine|opening_hours|description|religion|website/.test(k)).map(([k, v]) => `${k}=${v}`).join('; ')}` : 'none'
    try {
      const d = await describe(place, city, osm, signal)
      Object.assign(place, d.place)
      modelSays = d.public
    } catch (err) {
      console.warn('[places] describing', place.name, (err as Error).message)
    }
  }

  // A real attraction, restaurant or bar joins the city's catalog for every traveller; a home,
  // an office or an address stays the traveller's own; and one the system can't call waits
  // for the owner in the dev tools.
  const map = mapSays(hit)
  const category = hit?.category ? `${hit.category}/${hit.type}` : null
  let shared = false
  let review = false
  if (userId !== undefined) {
    const d = decideFind(map, modelSays, place.name)
    const prior = d.decision === 'private' ? undefined : await priorReview(city.id, place).catch(() => undefined)
    const decision = prior?.status === 'denied' ? 'private' : d.decision
    const reason = prior?.status === 'denied' ? 'the owner turned this spot down before' : d.reason
    try {
      if (decision === 'share') {
        shared = Boolean(await promoteFind(city.id, place, userId))
        if (shared) notes.push(`It’s now in ${city.name}’s places for other travellers too.`)
      } else if (decision === 'review') {
        review = Boolean(await queueReview(city.id, place, reason, { map, category, model: modelSays ?? null, address }, userId))
      }
    } catch (err) {
      console.warn('[places] sharing', place.name, (err as Error).message)
    }
    track('place.decision', { userId, subject: `${city.id}/${place.id}`, detail: { city: city.id, name: place.name, kind: place.kind, decision, reason, map, category, model: modelSays ?? null, shared, from: source.from } })
  }
  return { place, note: notes.join(' ') || undefined, shared, review, map, category, model: modelSays }
}

// A place's own accounts and site from OpenStreetMap's contact tags: a handle becomes its page.
const PROFILE = { instagram: 'https://www.instagram.com/', tiktok: 'https://www.tiktok.com/@', facebook: 'https://www.facebook.com/' } as const
export function linksOf(tags?: Record<string, string> | null): Place['links'] | undefined {
  if (!tags) return undefined
  const out: NonNullable<Place['links']> = {}
  const web = (u?: string) => (u && /^https?:\/\/[^\s]+$/i.test(u.trim()) ? u.trim().slice(0, 300) : u && /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u.trim()) ? `https://${u.trim()}`.slice(0, 300) : undefined)
  for (const k of ['instagram', 'tiktok', 'facebook'] as const) {
    const raw = (tags[`contact:${k}`] ?? tags[k])?.trim()
    if (!raw) continue
    const url = /^https?:\/\//i.test(raw) ? raw : `${PROFILE[k]}${raw.replace(/^@/, '').replace(/\/$/, '')}`
    if (new RegExp(`^https?://(www\\.)?${k}\\.com/`, 'i').test(url)) out[k] = url.slice(0, 300)
  }
  const site = web(tags['contact:website'] ?? tags.website ?? tags.url)
  if (site) out.website = site
  return Object.keys(out).length ? out : undefined
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'place'
const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a')

// ── reels & videos ───────────────────────────────────────────────────────────

const FILLER = new Set(['the', 'and', 'of', 'de', 'da', 'do', 'at', 'in', 'cafe', 'café', 'bar', 'restaurant', 'ramen', 'sushi', 'coffee', 'shop', 'store', 'market', 'park', 'museum', 'temple', 'shrine', 'tokyo', 'lisbon', 'lisboa', 'japan', 'portugal'])
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// A clip only counts if it names the place: its own words, not just "ramen" or the city.
export function mentions(text: string, name: string): boolean {
  const t = fold(text)
  const tokens = fold(name).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !FILLER.has(w))
  if (!tokens.length) return t.includes(fold(name).trim())
  return tokens.some(w => t.includes(w))
}

interface VideoQuery { name: string; city: string; area?: string }

// A place's clips, kept with it for good: in memory, and in the database so a restart or a
// deploy doesn't forget them and every traveller shares them. Two kinds of looking:
// - YouTube (free: its own search page) runs the first time a place shows anywhere.
// - Instagram reels and TikToks need a web search through the model, which costs, so they're
//   looked for only when someone asks on that place (`social`), and never again once found.
// Finding nothing is remembered for a week, then may be tried again.
const DAY_MS = 86_400_000
const EMPTY_MS = 7 * DAY_MS

interface Held { at: number; value: PlaceVideos }
const memory = new Map<string, Held>()
const running = new Map<string, Promise<PlaceVideos>>()
let videoDb: Db | null = null

export function attachVideoDb(db: Db | null) { videoDb = db }

const videoKey = (q: VideoQuery) => fold(`${q.name.trim()}|${q.city.trim()}`)
const usable = (h: Held | undefined, now = Date.now()) => Boolean(h && (h.value.videos.length || now - h.at < EMPTY_MS))

function remember(key: string, held: Held) {
  memory.delete(key)
  if (memory.size >= 2000) memory.delete(memory.keys().next().value!)
  memory.set(key, held)
}

async function stored(key: string): Promise<Held | undefined> {
  const mem = memory.get(key)
  if (mem || !videoDb) return mem
  try {
    const row = await videoDb.one<{ videos: string; found_at: number }>('SELECT videos, found_at FROM place_videos WHERE key = ?', key)
    if (!row) return undefined
    const held = { at: row.found_at, value: JSON.parse(row.videos) as PlaceVideos }
    remember(key, held)
    return held
  } catch (err) {
    console.warn('[videos] reading the cache:', (err as Error).message)
    return undefined
  }
}

// One search per place at a time, however many travellers open it together.
function search(q: VideoQuery, key: string, previous: Held | undefined, social: boolean): Promise<PlaceVideos> {
  const runKey = `${key}|${social ? 'social' : 'youtube'}`
  let run = running.get(runKey)
  if (run) return run
  run = findVideos(q, social, previous?.value)
    .then(async value => {
      const held = { at: Date.now(), value }
      remember(key, held)
      await videoDb?.run(`INSERT INTO place_videos (key, name, city, videos, found_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET videos = excluded.videos, found_at = excluded.found_at, name = excluded.name`,
        key, q.name.slice(0, 120), q.city.slice(0, 60), JSON.stringify(value), held.at)
        .catch(err => console.warn('[videos] saving to the cache:', (err as Error).message))
      return value
    })
    .finally(() => running.delete(runKey))
  running.set(runKey, run)
  return run
}

export async function cachedVideos(q: VideoQuery): Promise<PlaceVideos | undefined> {
  const held = await stored(videoKey(q))
  return usable(held) ? held!.value : undefined
}

// What's kept for a place, found the free way (YouTube) if nothing is kept yet; with `social`,
// the reels and TikToks too, searched for once and kept for good.
export async function placeVideos(q: VideoQuery, social = false): Promise<PlaceVideos> {
  const key = videoKey(q)
  const held = await stored(key)
  if (usable(held) && (!social || held!.value.social)) return held!.value
  return search(q, key, held, social)
}

// Whether a place's reels and TikToks have been looked for already.
export const socialSearched = async (q: VideoQuery) => Boolean((await stored(videoKey(q)))?.value.social)

async function findVideos(q: VideoQuery, social: boolean, had?: PlaceVideos): Promise<PlaceVideos> {
  const kept = had?.videos ?? []
  // the web search costs: only when asked, and only while the day's searches last
  const lookSocial = social && !had?.social && canSearch(2)
  const [yt, found] = await Promise.all([
    kept.some(v => v.platform === 'youtube') ? Promise.resolve(kept.filter(v => v.platform === 'youtube')) : youtube(q).catch(err => { console.warn('[videos] youtube:', (err as Error).message); return [] as Video[] }),
    lookSocial ? (brainEnabled ? socialWithClaude(q) : openai ? socialWithOpenAI(q) : Promise.resolve([])).catch(err => { console.warn('[videos] social:', (err as Error).message); return null }) : Promise.resolve(kept.filter(v => v.platform !== 'youtube')),
  ])
  const socialClips = found ?? kept.filter(v => v.platform !== 'youtube')
  const lanes: Video[][] = [
    socialClips.filter(v => v.platform === 'instagram'),
    yt.filter(v => !v.short),
    socialClips.filter(v => v.platform === 'tiktok'),
    yt.filter(v => v.short),
  ]
  const videos: Video[] = []
  for (let i = 0; videos.length < 12 && lanes.some(l => l.length > i); i++) for (const l of lanes) if (l[i] && videos.length < 12) videos.push(l[i])
  // a failed search (found === null) isn't "looked for": it can be asked again
  return { ...(had?.topic ? { topic: had.topic } : {}), videos, ...((had?.social || (lookSocial && found !== null)) ? { social: true } : {}) }
}

async function youtube(q: VideoQuery): Promise<Video[]> {
  const query = `${q.name} ${q.city}`
  const key = process.env.YOUTUBE_API_KEY
  if (key) {
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '15', q: query, key })
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`YouTube API ${res.status}`)
    const data = await res.json() as { items?: { id: { videoId?: string }; snippet: { title: string; channelTitle: string } }[] }
    return (data.items ?? [])
      .filter(i => i.id.videoId && mentions(i.snippet.title, q.name))
      .sort((a, b) => Number(mentions(b.snippet.title, q.city)) - Number(mentions(a.snippet.title, q.city)))
      .slice(0, 6)
      .map(i => ({ platform: 'youtube' as const, id: i.id.videoId!, title: unescapeHtml(i.snippet.title), by: i.snippet.channelTitle }))
  }
  const res = await fetch(`https://www.youtube.com/results?${new URLSearchParams({ search_query: query, hl: 'en', gl: 'US' })}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`YouTube ${res.status}`)
  // a chain's other branches name it too, so clips that also name the city come first
  const found = parseYouTube(await res.text()).filter(v => mentions(v.title, q.name))
  return [...found.filter(v => mentions(v.title, q.city)), ...found.filter(v => !mentions(v.title, q.city))].slice(0, 6)
}

// YouTube's results page carries its data as one JSON blob: long videos are `videoRenderer`s,
// Shorts are `shortsLockupViewModel`s.
export function parseYouTube(html: string): Video[] {
  const blob = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1]
  if (!blob) return []
  const out: Video[] = []
  const seen = new Set<string>()
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    const r = o as Record<string, any>
    const v = r.videoRenderer
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId)
      out.push({ platform: 'youtube', id: v.videoId, title: v.title?.runs?.[0]?.text ?? '', by: v.ownerText?.runs?.[0]?.text ?? '', views: v.shortViewCountText?.simpleText })
    }
    const s = r.shortsLockupViewModel
    const sid = s?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
    if (sid && !seen.has(sid)) {
      seen.add(sid)
      out.push({ platform: 'youtube', id: sid, short: true, title: s.overlayMetadata?.primaryText?.content ?? '', by: '', views: s.overlayMetadata?.secondaryText?.content?.replace(/\s*views?$/i, '') })
    }
    for (const k in r) if (k !== 'videoRenderer' && k !== 'shortsLockupViewModel') walk(r[k])
  }
  try { walk(JSON.parse(blob)) } catch { return [] }
  return out.filter(v => v.title)
}

const TIKTOK_RE = /https?:\/\/(?:www\.)?tiktok\.com\/@([\w.-]+)\/video\/(\d{8,})/g
const REEL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?reels?\/([\w-]{6,})/g

// Instagram and TikTok have no open search, so Claude or OpenAI searches the web for them. Only
// links in the search results themselves are used, never ones written by the model.
const socialAsk = (q: VideoQuery) => `Find Instagram reels and TikTok videos about this specific place: ${q.name}${q.area ? ` (${q.area})` : ''} in ${q.city}. Search Instagram and TikTok separately, using the place's name with the city.`

async function socialWithClaude(q: VideoQuery): Promise<Video[]> {
  return asJob('videos', async () => {
    const messages: import('@anthropic-ai/sdk').default.Beta.BetaMessageParam[] = [{
      role: 'user',
      content: `${socialAsk(q)} Then reply "done".`,
    }]
    const results = new Map<string, string>() // url → title, from the search results
    for (let turn = 0; turn < 3; turn++) {
      const response = await client.beta.messages.create({
        ...FALLBACK,
        model: MODEL_LIGHT,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4, allowed_domains: ['instagram.com', 'tiktok.com'] }],
        messages,
      }, { signal: AbortSignal.timeout(60_000) })
      collectResults(response.content, results)
      if (response.stop_reason !== 'pause_turn') break
      messages.push({ role: 'assistant', content: response.content })
    }
    return clipsFrom(results, q)
  })
}

const CLIPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clips'],
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'creator', 'caption'],
        properties: { url: { type: 'string' }, creator: { type: 'string' }, caption: { type: 'string' } },
      },
    },
  },
}

const Clips = z.object({ clips: z.array(z.object({ url: z.string(), creator: z.string(), caption: z.string() })) })

// OpenAI's sources carry no titles, so it reports each clip's caption and creator; a clip only
// counts if its reel or video id is among the pages the search actually returned.
// What the last searches found and kept, for checking the search on a live server.
export const socialTrace: { at: string; query: string; status?: string; sources: string[]; listed: string; kept: number; error?: string }[] = []

export async function traceSocial(q: VideoQuery) {
  if (!canSearch(2)) return { error: 'The day’s web searches are used up.' }
  try {
    const videos = await (brainEnabled ? socialWithClaude(q) : openai ? socialWithOpenAI(q) : Promise.resolve([]))
    return { videos, trace: socialTrace.at(-1) }
  } catch (err) {
    return { error: (err as Error).message, trace: socialTrace.at(-1) }
  }
}

async function socialWithOpenAI(q: VideoQuery): Promise<Video[]> {
  return asJob('videos', async () => {
    const response = await openai!.responses.create({
      model: openaiLightModel(),
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search', filters: { allowed_domains: ['instagram.com', 'tiktok.com'] } }],
      include: ['web_search_call.action.sources'],
      input: `${socialAsk(q)} List every reel or video you found that is about this place, with its exact URL from the search results, the creator's handle, and its caption.`,
      text: { format: { type: 'json_schema', name: 'clips', strict: true, schema: CLIPS_SCHEMA } },
    }, { signal: AbortSignal.timeout(90_000) })

    const results = openAIResults(response.output, response.status === 'completed' ? response.output_text : null)
    const kept = await clipsFrom(results, q)
    const sources = new Map<string, string>()
    collectOpenAISources(response.output, sources)
    socialTrace.push({ at: new Date().toISOString(), query: `${q.name} ${q.city}`, status: response.status, sources: [...sources.keys()].slice(0, 40), listed: response.output_text.slice(0, 3000), kept: kept.length })
    if (socialTrace.length > 10) socialTrace.shift()
    console.log(`[videos] openai ${q.name}: ${sources.size} sources, ${results.size} candidates, ${kept.length} kept`)
    return kept
  })
}

// url → title for each clip: what the model reported, kept only when the search returned that clip.
export function openAIResults(output: unknown, text: string | null): Map<string, string> {
  const found = new Map<string, string>()
  collectOpenAISources(output, found)
  const seen = new Set([...found.keys()].flatMap(clipIds))
  const results = new Map<string, string>()
  for (const c of text ? Clips.parse(JSON.parse(text)).clips : []) {
    if (!clipIds(c.url).some(id => seen.has(id))) continue
    const handle = c.creator.replace(/^@/, '')
    results.set(c.url, /instagram\.com/.test(c.url) ? `${handle} on Instagram: "${c.caption}"` : c.caption)
  }
  for (const [url, title] of found) if (!results.has(url) && title) results.set(url, title)
  return results
}

// web_search_call sources and the answer's url_citation annotations: the pages the search returned.
export function collectOpenAISources(output: unknown, into: Map<string, string>) {
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    const r = o as Record<string, unknown>
    if ((r.type === 'url' || r.type === 'url_citation') && typeof r.url === 'string') {
      into.set(r.url, typeof r.title === 'string' ? r.title : into.get(r.url) ?? '')
    }
    for (const k in r) walk(r[k])
  }
  walk(output)
}

const clipIds = (url: string) => [...url.matchAll(REEL_RE)].map(m => `ig:${m[1]}`).concat([...url.matchAll(TIKTOK_RE)].map(m => `tt:${m[2]}`))

async function clipsFrom(results: Map<string, string>, q: VideoQuery): Promise<Video[]> {
  const reels: Video[] = []
  const tiktoks: { id: string; by: string; title: string }[] = []
  for (const [url, title] of results) {
    for (const m of url.matchAll(REEL_RE)) {
      if (!reels.some(r => r.id === m[1]) && mentions(`${title} ${url}`, q.name)) reels.push({ platform: 'instagram', id: m[1], ...instagramByline(title) })
    }
    for (const m of url.matchAll(TIKTOK_RE)) if (!tiktoks.some(t => t.id === m[2])) tiktoks.push({ id: m[2], by: m[1], title })
  }
  // TikTok's oEmbed gives the real caption (it answers for any id, so it isn't proof the video is still up)
  const checked = await Promise.all(tiktoks.slice(0, 8).map(async t => {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/@${t.by}/video/${t.id}`)}`, { signal: AbortSignal.timeout(6000) }).catch(() => null)
    if (!res?.ok) return null
    const o = await res.json().catch(() => null) as { title?: string; author_unique_id?: string } | null
    const title = o?.title?.trim() || t.title
    return o && mentions(`${title} ${t.title}`, q.name) ? { platform: 'tiktok' as const, id: t.id, by: o.author_unique_id ?? t.by, title: clip(title) } : null
  }))
  return [...reels.slice(0, 5), ...checked.filter((v): v is NonNullable<typeof v> => Boolean(v)).slice(0, 5)]
}

export function collectResults(content: unknown, into: Map<string, string>) {
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    const r = o as Record<string, unknown>
    if (r.type === 'web_search_result' && typeof r.url === 'string') into.set(r.url, typeof r.title === 'string' ? r.title : '')
    for (const k in r) walk(r[k])
  }
  walk(content)
}

// Instagram result titles look like `Name (@handle) • Instagram reel` or `handle on Instagram: "caption"`.
function instagramByline(title: string): { by: string; title: string } {
  const handle = title.match(/@([\w.]{2,30})/)?.[1] ?? title.match(/^([\w.]{2,30}) on Instagram/)?.[1] ?? ''
  const caption = title.match(/[:：]\s*["“](.+?)["”]?\s*$/)?.[1] ?? title.replace(/\s*[•|·-]\s*Instagram.*$/i, '').replace(/\(@[\w.]+\)/, '')
  return { by: handle, title: clip(unescapeHtml(caption.trim()) || 'Instagram reel') }
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117).trimEnd()}…` : s)
const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, '’').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

function anySignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

