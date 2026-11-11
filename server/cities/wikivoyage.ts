import type { Hotel, LngLat, Place, PlaceKind, Vibe } from '../../src/types'

// Reads Wikivoyage guides into places and hotels, for any city. Listings are CC BY-SA 4.0
// (credited in the app) and carry their own coordinates, so nothing here guesses where a
// place is. Fame comes from Wikidata (CC0): how many Wikipedias have an article on it.
// Pure functions over wikitext; fetching is in ./build.ts.

export const UA = 'Wayfarer catalog builder (https://github.com/drishandutt/Travel---Wayfarer)'

export interface Listing {
  type: 'see' | 'do' | 'eat' | 'drink' | 'buy' | 'sleep'
  name: string
  coord: LngLat
  content: string
  price: string
  wikidata?: string
  district: string
  band?: 'budget' | 'mid' | 'splurge' // the section it sits in: Budget / Mid-range / Splurge
}

// The city's money, for reading "€12" or "¥1,500" into a price band.
export interface Money { code: string; symbol: string; perUsd: number }

// ── reading the wikitext ─────────────────────────────────────────────────────

// Every top-level {{…}} in the page, with where it starts, braces matched.
export function templates(text: string): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = []
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '{' || text[i + 1] !== '{') continue
    let depth = 0
    let j = i
    for (; j < text.length - 1; j++) {
      if (text[j] === '{' && text[j + 1] === '{') { depth++; j++ } else if (text[j] === '}' && text[j + 1] === '}') { depth--; j++; if (!depth) break }
    }
    out.push({ at: i, body: text.slice(i + 2, j - 1) })
    i = j
  }
  return out
}

// "see | name=Foo | lat=51.5" → { '': 'see', name: 'Foo', lat: '51.5' }, splitting only on top-level pipes.
export function params(body: string): Record<string, string> {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2)
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue }
    if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue }
    if (body[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += body[i]
  }
  parts.push(cur)
  const out: Record<string, string> = { '': parts[0].trim().toLowerCase() }
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim()
  }
  return out
}

// Wikitext to plain words: links, bold, inner templates and references gone.
export function plain(s: string): string {
  return s
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, '')
    .replace(/\{\{\s*(?:km|mi|convert)\s*\|([^|}]+)\|?([^|}]*)[^}]*\}\}/gi, '$1 $2')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/\[https?:\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const TYPES = new Set(['see', 'do', 'eat', 'drink', 'buy', 'sleep'])

export function listingsOf(text: string, district: string): Listing[] {
  // where each section heading sits, to know a listing's type and price band from its place
  const heads = [...text.matchAll(/^(={2,4})\s*([^=]+?)\s*\1\s*$/gm)].map(m => ({ at: m.index!, level: m[1].length, title: m[2].toLowerCase() }))
  const out: Listing[] = []
  for (const t of templates(text)) {
    const p = params(t.body)
    let type = p['']
    if (type === 'listing' || type === 'marker') type = (p.type ?? '').toLowerCase()
    const before = heads.filter(h => h.at < t.at)
    const section = [...before].reverse().find(h => h.level === 2)?.title ?? ''
    if (!TYPES.has(type)) type = TYPES.has(section) ? section : ''
    if (!TYPES.has(type)) continue
    const lat = Number(p.lat)
    const lng = Number(p.long ?? p.lon)
    const name = plain(p.name ?? '')
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) continue
    // the price band is the Budget / Mid-range / Splurge heading inside this section, not one left over from the last
    const sec = [...before].reverse().find(h => h.level === 2)
    const sub = [...before].reverse().find(h => h.level === 3 && (!sec || h.at > sec.at))?.title ?? ''
    const band = /budget|cheap/.test(sub) ? 'budget' : /mid/.test(sub) ? 'mid' : /splurge|expensive|luxury|upmarket/.test(sub) ? 'splurge' : undefined
    out.push({
      type: type as Listing['type'],
      name: name.replace(/\s*\([^)]*\)\s*$/, '').slice(0, 70),
      coord: [lng, lat],
      content: plain(p.content ?? p.description ?? ''),
      price: plain(p.price ?? ''),
      wikidata: /^Q\d+$/.test(p.wikidata ?? '') ? p.wikidata : undefined,
      district,
      band,
    })
  }
  return out
}

// The page's {{geo|lat|long|zoom}}: where the guide says the city is.
export function geoOf(text: string): { center: LngLat; zoom?: number } | undefined {
  const m = text.match(/\{\{\s*geo\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)(?:\s*\|\s*(?:zoom\s*=\s*)?(\d+(?:\.\d+)?))?/i)
  if (!m) return undefined
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) return undefined
  return { center: [lng, lat], zoom: m[3] ? Number(m[3]) : undefined }
}

// What kind of article this is, from its status template: a city or district guide can be
// built; a country, region or park can't.
export function articleKind(text: string): 'city' | 'district' | 'other' {
  const m = text.match(/\{\{\s*(?:outline|usable|guide|star)(city|district|region|country|park|itinerary|topic|airport|diveguide)\b/i)
  if (!m) return /\{\{\s*(see|do|eat|drink|sleep)\b/i.test(text) ? 'city' : 'other'
  const k = m[1].toLowerCase()
  return k === 'city' ? 'city' : k === 'district' ? 'district' : 'other'
}

// A huge city's guide splits into district pages, listed in its Districts section (and as
// its subpages). Those pages carry the listings.
export function districtLinks(text: string, title: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (target: string) => {
    const t = target.split('#')[0].replace(/_/g, ' ').trim()
    if (!t || t.includes(':') || seen.has(t) || t === title) return
    seen.add(t)
    out.push(t)
  }
  const heads = [...text.matchAll(/^(={2})\s*([^=]+?)\s*\1\s*$/gm)]
  for (let i = 0; i < heads.length; i++) {
    if (!/\b(districts?|boroughs?|neighbou?rhoods?|areas|quarters|wards|arrondissements)\b/i.test(heads[i][2])) continue
    const from = heads[i].index! + heads[i][0].length
    const to = heads[i + 1]?.index ?? text.length
    for (const m of text.slice(from, to).matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) add(m[1])
  }
  // subpages anywhere on the page ("[[Paris/1st arrondissement|…]]")
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) if (m[1].startsWith(`${title}/`)) add(m[1])
  return out
}

// ── shaping a listing into a place ───────────────────────────────────────────

const has = (s: string, re: RegExp) => re.test(s.toLowerCase())

export function kindOf(l: Listing): PlaceKind {
  const s = `${l.name} ${l.content}`
  if (l.type === 'eat') return has(l.name, /(?<!\p{L})(caf[eé]|coffee|bakery|patisserie|pastelaria|konditorei|tea ?room|brunch)(?!\p{L})/u) ? 'cafe' : 'food'
  if (l.type === 'drink') return has(l.name, /(?<!\p{L})(caf[eé]|coffee|espresso|tea)(?!\p{L})/u) ? 'cafe' : 'bar'
  if (l.type === 'buy') return has(s, /\b(market|mercado|marché|markt|bazaar|souk)\b/) ? 'market' : 'sight'
  const lead = l.content.split(/(?<=[.!?])\s/)[0] ?? ''
  if (has(l.name, /\b(church|cathedral|chapel|abbey|priory|basilica|mosque|synagogue|temple|shrine|pagoda)\b/) || has(l.name, /^st\.? /)) return 'sight'
  if (has(l.name, /\b(museum|museu|musée|museo|gallery|galleries|galerie|collection|exhibition|academy of arts)\b/) || has(lead, /\b(museum|art gallery|gallery of|galleries)\b/)) return 'museum'
  if (has(l.name, /\b(park|parque|parc|gardens?|jardi(?:m|ns?)|giardin[oi]|garten|botanical|heath|common|green|fields|wood|woods|forest|nature reserve|wetland|cemetery|marshes|lake)\b/)) return 'park'
  if (has(l.name, /\b(market|mercado|marché|markt|bazaar|souk)\b/)) return 'market'
  if (has(s, /\b(viewpoint|observation deck|viewing platform|panoramic view|skyline view|lookout|belvedere|miradouro|mirador)\b/) || has(l.name, /\b(sky ?deck|sky garden|observatory|lookout|viewpoint|miradouro|mirador|belvedere)\b/)) return 'viewpoint'
  return 'sight'
}

export function tagsOf(l: Listing, kind: PlaceKind): Vibe[] {
  const s = `${l.name} ${l.content}`.toLowerCase()
  const t = new Set<Vibe>()
  if (kind === 'food' || kind === 'cafe' || kind === 'market' && /food|street food|cheese|deli|fish/.test(s)) t.add('food')
  if (kind === 'bar' || /\b(nightclub|clubbing|cocktails?|live music|gigs?|dj|dancefloor)\b/.test(s)) t.add('nightlife')
  if (kind === 'park' || /\b(garden|river walk|heath|nature|wildlife|trees|beach|waterfall|hike|hiking)\b/.test(s)) t.add('nature')
  if (kind === 'museum' && /\b(art|gallery|paint|sculpture|design|photograph)\b/.test(s) || /\b(gallery|street art|contemporary art)\b/.test(s)) t.add('art')
  if (l.type === 'buy' || kind === 'market' || /\b(shopping|boutique|department store)\b/.test(s)) t.add('shopping')
  if (/\b(histor|medieval|roman|baroque|gothic|renaissance|ottoman|moorish|edo|tudor|victorian|georgian|century|built in|royal|imperial|palace|castle|fort|abbey|cathedral|war|tower|ruins?)\b/.test(s)) t.add('history')
  if (/\b(theatre|theater|church|cathedral|abbey|mosque|temple|shrine|museum|opera|ballet|concert|literary|library)\b/.test(s) || kind === 'museum') t.add('culture')
  if (/\b(romantic|candle|sunset|rooftop|views?)\b/.test(s)) t.add('romantic')
  if (/\b(climb|zip|kayak|boat|surf|cycling|bike|escape room|go-?kart|thrill|rollercoaster|theme park)\b/.test(s)) t.add('adventure')
  if (kind === 'park' || /\b(quiet|peaceful|relax|calm|tranquil|spa|onsen|hammam)\b/.test(s)) t.add('relaxed')
  // somewhere to eat or drink is that, whatever its walls are: the café in a crypt isn't culture
  if (kind === 'food' || kind === 'cafe' || kind === 'bar') for (const v of ['culture', 'history', 'art', 'shopping', 'nature', 'adventure'] as Vibe[]) t.delete(v)
  if (!t.size) t.add(kind === 'bar' ? 'nightlife' : 'culture')
  if (kind === 'food' || kind === 'cafe') t.add('food')
  return [...t].slice(0, 3)
}

// Rough dollars for the currencies a guide names outright; anything else is the city's own.
const EXPLICIT: Record<string, number> = { 'us$': 1, usd: 1, '€': 0.92, eur: 0.92, '£': 0.79, gbp: 0.79 }
const MARKER = String.raw`us\$|usd|€|eur|£|gbp|¥|jpy|cny|rmb|₹|inr|rs\.?|฿|thb|₩|krw|r\$|brl|chf|fr\.|kr|nok|sek|dkk|isk|zł|pln|kč|czk|ft|huf|lei|ron|лв|bgn|₺|tl|try|aed|sar|sgd|s\$|hk\$|hkd|a\$|aud|nz\$|nzd|c\$|cad|mx\$|mxn|rm|myr|rp|idr|₱|php|₫|vnd|₪|ils|₽|rub|egp|zar|mad|dh|kn|hrk|lkr|npr|pkr|tk|bdt|\$`

// Every amount in a price string, in US dollars: "£12", "€8-15", "¥1,500", "12 €", "150 kr".
export function amountsUsd(text: string, money: Money): number[] {
  const t = text.toLowerCase()
  const out: number[] = []
  const local = [money.symbol.toLowerCase(), money.code.toLowerCase()]
  const toUsd = (marker: string, n: number) => {
    const m = marker.replace(/\s+/g, '')
    const rate = local.includes(m) ? money.perUsd : EXPLICIT[m] ?? money.perUsd
    return n / rate
  }
  const num = (s: string) => Number(s.replace(/,/g, '').replace(/\.$/, ''))
  for (const m of t.matchAll(new RegExp(String.raw`(${MARKER})\s?(\d[\d,]*(?:\.\d+)?)`, 'g'))) if (Number.isFinite(num(m[2]))) out.push(toUsd(m[1], num(m[2])))
  for (const m of t.matchAll(new RegExp(String.raw`(\d[\d,]*(?:\.\d+)?)\s?(${MARKER})(?![a-z])`, 'g'))) if (Number.isFinite(num(m[1]))) out.push(toUsd(m[2], num(m[1])))
  return out
}

// "Free", "£12", "£8-15", "adult £25.50": a band from the most a typical adult pays.
export function priceOf(l: Pick<Listing, 'price' | 'band' | 'type'>, kind: PlaceKind, money: Money = { code: 'GBP', symbol: '£', perUsd: 0.79 }): Place['price'] {
  if (l.band) return l.band === 'budget' ? 1 : l.band === 'mid' ? 2 : 3
  const p = l.price.toLowerCase()
  if (/^free\b|free entry|free admission|admission free|^free$|^gratis\b/.test(p)) return 0
  const usd = amountsUsd(l.price, money)
  if (usd.length) {
    const top = Math.max(...usd)
    return top === 0 ? 0 : top < 19 ? 1 : top < 50 ? 2 : 3
  }
  return kind === 'park' || kind === 'viewpoint' ? 0 : kind === 'cafe' || kind === 'market' ? 1 : kind === 'sight' ? 1 : 2
}

export const MINUTES: Record<PlaceKind, number> = { food: 75, cafe: 45, bar: 90, museum: 100, park: 60, viewpoint: 45, market: 60, sight: 60, experience: 120 }
export const BEST: Record<PlaceKind, Place['bestAt']> = { food: 'evening', cafe: 'morning', bar: 'night', museum: 'midday', park: 'morning', viewpoint: 'evening', market: 'midday', sight: 'midday', experience: 'midday' }

// The first sentence, short enough for a card.
export function blurbOf(content: string, kind: PlaceKind, district: string): string {
  const first = content.split(/(?<=[.!?])\s+(?=[A-Z])/)[0]?.trim() ?? ''
  if (first.length >= 12 && first.length <= 110) return first.replace(/[.!]?$/, '.')
  if (first.length > 110) return `${first.slice(0, 105).replace(/\s+\S*$/, '')}…`
  const what = { food: 'Restaurant', cafe: 'Café', bar: 'Bar', museum: 'Museum', park: 'Green space', viewpoint: 'Viewpoint', market: 'Market', sight: 'Sight', experience: 'Experience' }[kind]
  return `${what} in ${district.replace(/-/g, ' and ')}.`
}

const KEYWORDS = [
  'indian', 'curry', 'italian', 'pizza', 'pasta', 'french', 'bistro', 'chinese', 'dim sum', 'dumplings', 'japanese', 'sushi', 'ramen', 'izakaya', 'yakitori', 'tempura', 'thai', 'vietnamese', 'pho', 'korean', 'turkish', 'kebab', 'lebanese', 'falafel', 'greek', 'spanish', 'tapas', 'paella', 'portuguese', 'mexican', 'tacos', 'caribbean', 'ethiopian', 'german', 'austrian', 'polish', 'american', 'bbq', 'barbecue', 'burger', 'steak',
  'vegan', 'vegetarian', 'halal', 'seafood', 'oysters', 'fish and chips', 'pie', 'british', 'afternoon tea', 'brunch', 'breakfast', 'bakery', 'pastry', 'patisserie', 'gelato', 'ice cream', 'coffee', 'tea', 'michelin', 'fine dining', 'street food', 'cheap eats', 'food hall',
  'pub', 'gastropub', 'cocktails', 'wine', 'wine bar', 'beer', 'craft beer', 'gin', 'whisky', 'sake', 'live music', 'jazz', 'fado', 'flamenco', 'karaoke', 'nightclub', 'club', 'comedy', 'theatre', 'rooftop',
]
export function keywordsOf(l: Listing): string[] | undefined {
  // what's on the menu, so only for somewhere you eat or drink: a museum's "Greek" is its collection
  if (l.type !== 'eat' && l.type !== 'drink') return undefined
  const s = ` ${`${l.name} ${l.content}`.toLowerCase()} `
  const k = KEYWORDS.filter(w => s.includes(` ${w}`))
  return k.length ? k.slice(0, 6) : undefined
}

// Things that happen rather than places to go: a guide lists them, a day plan can't visit them.
export const EVENT = /\b(marathon|festival|carnival|parade|regatta|championships?|boat race|bonfire night|fireworks|new year'?s?|pride|proms|lord mayor'?s show|trooping the colour|open house|half marathon|grand prix|biennale|oktoberfest)\b/i

// Listed for convenience, not worth a stop: stations, supermarkets, chains, shopping centres.
export const NOT_A_VISIT = /\b(station|terminal|airport|shopping cent(?:re|er)|mall|supermarket|sainsbury'?s|tesco|waitrose|lidl|aldi|carrefour|walmart|7-eleven|lawson|familymart|m&s|marks (?:&|and) spencer|boots|pret(?: a manger)?|starbucks|costa|caffe nero|mcdonald'?s|burger king|kfc|nando'?s|wetherspoons?|hard rock cafe|rainforest cafe|planet hollywood|premier inn|travelodge|ibis|holiday inn|tourist (?:information|office)|visitor cent(?:re|er)|post office|hospital|pharmacy|police)\b|^cardinal place$/i

// "Clérigos Tower" → "clerigos-tower": accents off, not turned into dashes
export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
export const km = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 111 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111)

// ── building the catalog ─────────────────────────────────────────────────────

export interface ShapeOptions {
  prefix: string                      // place ids start with this ("ldn")
  center: LngLat
  maxKm: number                       // listings further out than this are left out
  money: Money
  fame: Map<string, number>           // Wikidata id → how many Wikipedias have an article
  areaVibes?: Record<string, Vibe[]>  // what staying in each district is like; derived from its places if not given
  hotelsPerTier?: number
}

// One entry per place: the same Wikidata item, or the same name within 150 m.
export function dedupe(all: Listing[], center: LngLat, maxKm: number): Listing[] {
  const seen: Listing[] = []
  for (const l of all.filter(l => km(l.coord, center) <= maxKm && !EVENT.test(l.name) && !NOT_A_VISIT.test(l.name))) {
    const twin = seen.find(s => (l.wikidata && s.wikidata === l.wikidata) || (slug(s.name) === slug(l.name) && km(s.coord, l.coord) < 0.15))
    if (!twin) seen.push(l)
    else if (l.content.length > twin.content.length) Object.assign(twin, { ...l, wikidata: twin.wikidata ?? l.wikidata })
  }
  return seen
}

export function shapeCatalog(seen: Listing[], o: ShapeOptions): { places: Place[]; hotels: Hotel[] } {
  const top = Math.max(1, ...o.fame.values())
  const ids = new Set<string>()
  const places: Place[] = []
  for (const l of seen.filter(l => l.type !== 'sleep')) {
    const kind = kindOf(l)
    let id = `${o.prefix}-${slug(l.name)}`
    while (ids.has(id)) id += '-2'
    ids.add(id)
    const n = l.wikidata ? o.fame.get(l.wikidata) ?? 0 : 0
    // 0..1: a Wikipedia article in many languages is famous; a guide listing alone is still a find
    // a football club's article is famous in every language; its ground is a niche visit
    const sport = /^(?:f\.?c\.?|s\.?c\.?|a\.?c\.?|s\.?l\.?|c\.?f\.?)\s|\b(?:f\.?c\.?|c\.?f\.?|united|athletic|rovers|wanderers|rfc|cricket club|stadium|arena|est[áa]dio|stadion)\b/i.test(l.name) ? 0.35 : 1
    // a restaurant or bar with a Wikipedia article is usually a famous building it sits in: it leads
    // the other restaurants, not the landmarks
    const cap = l.type === 'eat' || l.type === 'drink' ? 0.45 : 1
    const rank = Number(Math.min(cap, (l.wikidata ? 0.25 + 0.75 * Math.sqrt(n / top) : 0.15) * sport).toFixed(3))
    const keywords = keywordsOf(l)
    places.push({
      id,
      name: l.name,
      kind,
      coord: [Number(l.coord[0].toFixed(5)), Number(l.coord[1].toFixed(5))],
      tags: tagsOf(l, kind),
      price: priceOf(l, kind, o.money),
      minutes: MINUTES[kind],
      blurb: blurbOf(l.content, kind, l.district),
      bestAt: BEST[kind],
      ...(keywords ? { keywords } : {}),
      rank,
    })
  }
  places.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))

  // What staying in each district is like: what its places are mostly for.
  const areaVibes = o.areaVibes ?? {}
  if (!o.areaVibes) {
    const byArea = new Map<string, Map<Vibe, number>>()
    seen.filter(l => l.type !== 'sleep').forEach((l, i) => {
      const p = places.find(x => x.name === l.name)
      if (!p) return
      const n = byArea.get(l.district) ?? new Map<Vibe, number>()
      for (const t of p.tags) n.set(t, (n.get(t) ?? 0) + 1)
      byArea.set(l.district, n)
      void i
    })
    for (const [area, n] of byArea) areaVibes[area] = [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0])
  }

  const per = o.hotelsPerTier ?? 10
  const hotels: Hotel[] = seen
    .filter(l => l.type === 'sleep')
    .map(l => {
      const usd = amountsUsd(l.price, o.money).filter(n => n >= 20 && n <= 2000)
      const nightly = usd.length ? Math.round(Math.min(...usd)) : l.band === 'budget' ? 90 : l.band === 'splurge' ? 450 : l.band === 'mid' ? 200 : 0
      return { l, nightly }
    })
    .filter(x => x.nightly > 0 && km(x.l.coord, o.center) <= 12)
    .map(({ l, nightly }) => ({
      id: `${o.prefix}-h-${slug(l.name)}`,
      name: l.name,
      coord: [Number(l.coord[0].toFixed(5)), Number(l.coord[1].toFixed(5))] as LngLat,
      nightly,
      tier: nightly < 120 ? 'shoestring' as const : nightly < 350 ? 'comfort' as const : 'luxury' as const,
      tags: areaVibes[l.district]?.length ? areaVibes[l.district] : ['culture', 'history'] as Vibe[],
      blurb: blurbOf(l.content, 'sight', l.district).replace(/^Sight in/, 'Stay in'),
    }))
    .filter((h, i, a) => a.findIndex(x => x.id === h.id) === i)
    // a choice, not a directory: the most central of each tier
    .sort((a, b) => km(a.coord, o.center) - km(b.coord, o.center))
    .filter((h, _, a) => a.filter(x => x.tier === h.tier).indexOf(h) < per)

  return { places, hotels }
}

// A city whose guide lists no stays with prices still needs somewhere to base the trip: a
// placeholder stay per budget in the busiest districts, named for the area, not a real hotel.
export function placeholderHotels(prefix: string, seen: Listing[], center: LngLat, areaVibes: Record<string, Vibe[]> = {}): Hotel[] {
  const areas = new Map<string, { n: number; coords: LngLat[] }>()
  for (const l of seen) {
    if (km(l.coord, center) > 8) continue
    const a = areas.get(l.district) ?? { n: 0, coords: [] }
    a.n++
    a.coords.push(l.coord)
    areas.set(l.district, a)
  }
  const busiest = [...areas.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3)
  if (!busiest.length) return []
  const tiers = [{ tier: 'shoestring' as const, nightly: 85, what: 'A budget stay' }, { tier: 'comfort' as const, nightly: 190, what: 'A mid-range stay' }, { tier: 'luxury' as const, nightly: 420, what: 'A luxury stay' }]
  return tiers.map((t, i) => {
    const [area, a] = busiest[i % busiest.length]
    const c: LngLat = [a.coords.reduce((s, x) => s + x[0], 0) / a.coords.length, a.coords.reduce((s, x) => s + x[1], 0) / a.coords.length]
    return {
      id: `${prefix}-h-${t.tier}-${slug(area)}`,
      name: `${t.what} in ${area.split('/').pop()}`,
      coord: [Number(c[0].toFixed(5)), Number(c[1].toFixed(5))],
      nightly: t.nightly,
      tier: t.tier,
      tags: areaVibes[area]?.length ? areaVibes[area] : ['culture', 'history'],
      blurb: 'A placeholder base: pick a real hotel in this area when you book.',
    }
  })
}
