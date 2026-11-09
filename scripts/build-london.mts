// Builds London's places and hotels from Wikivoyage's district guides, ranked by how well known
// each place is on Wikidata. Writes src/data/london.json, which the app ships as London's catalog.
//
//   npx tsx scripts/build-london.mts
//
// Wikivoyage listings are CC BY-SA 4.0 (credited in the app); Wikidata is CC0. The listings
// carry their own coordinates, so nothing here guesses where a place is.

import { writeFileSync } from 'node:fs'
import type { Hotel, LngLat, Place, PlaceKind, Vibe } from '../src/types'

const DISTRICTS = [
  'City of London', 'Westminster', 'Covent Garden', 'Soho', 'Leicester Square', 'Mayfair-Marylebone', 'Bloomsbury',
  'Holborn-Clerkenwell', 'South Bank', 'Southwark and Lewisham', 'Lambeth', 'South Kensington-Chelsea',
  'Notting Hill-North Kensington', 'Paddington-Maida Vale', 'Camden', 'Islington', 'Hampstead', 'Hackney',
  'East End', 'Greenwich', 'Richmond-Kew', 'Hammersmith and Fulham', 'Wandsworth', 'Wimbledon',
  'North', 'East', 'South', 'West',
]
const UA = 'Wayfarer catalog builder (https://github.com/drishandutt/Travel---Wayfarer)'
const CENTER: LngLat = [-0.1276, 51.5072]
const MAX_KM = 40
const GBP_TO_USD = 1.27

interface Listing {
  type: 'see' | 'do' | 'eat' | 'drink' | 'buy' | 'sleep'
  name: string
  coord: LngLat
  content: string
  price: string
  wikidata?: string
  district: string
  band?: 'budget' | 'mid' | 'splurge' // the section it sits in: Budget / Mid-range / Splurge
}

// ── reading the wikitext ─────────────────────────────────────────────────────

// Every top-level {{…}} in the page, with where it starts, braces matched.
function templates(text: string): { at: number; body: string }[] {
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
function params(body: string): Record<string, string> {
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

function listingsOf(text: string, district: string): Listing[] {
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
    const sub = [...before].reverse().find(h => h.level === 3)?.title ?? ''
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

// ── shaping a listing into a place ───────────────────────────────────────────

const has = (s: string, re: RegExp) => re.test(s.toLowerCase())

function kindOf(l: Listing): PlaceKind {
  const s = `${l.name} ${l.content}`
  if (l.type === 'eat') return has(l.name, /\b(caf[eé]|coffee|bakery|patisserie|tea ?room|brunch)\b/) ? 'cafe' : 'food'
  if (l.type === 'drink') return has(l.name, /\b(caf[eé]|coffee|espresso|tea)\b/) ? 'cafe' : 'bar'
  if (l.type === 'buy') return has(s, /\bmarket\b/) ? 'market' : 'sight'
  const lead = l.content.split(/(?<=[.!?])\s/)[0] ?? ''
  if (has(l.name, /\b(church|cathedral|chapel|abbey|priory)\b/) || has(l.name, /^st\.? /)) return 'sight'
  if (has(l.name, /\b(museum|gallery|galleries|collection|exhibition|tate|academy of arts)\b/) || has(lead, /\b(museum|art gallery|gallery of|galleries)\b/)) return 'museum'
  if (has(l.name, /\b(park|gardens?|heath|common|green|fields|wood|woods|nature reserve|wetland|cemetery|marshes)\b/)) return 'park'
  if (has(l.name, /\bmarket\b/)) return 'market'
  if (has(s, /\b(viewpoint|observation deck|viewing platform|panoramic view|skyline view)\b/) || has(l.name, /\b(shard|sky garden|london eye|hill)\b/)) return 'viewpoint'
  return 'sight'
}

function tagsOf(l: Listing, kind: PlaceKind): Vibe[] {
  const s = `${l.name} ${l.content}`.toLowerCase()
  const t = new Set<Vibe>()
  if (kind === 'food' || kind === 'cafe' || kind === 'market' && /food|street food|cheese|deli/.test(s)) t.add('food')
  if (kind === 'bar' || /\b(nightclub|clubbing|cocktails?|live music|gigs?|dj|dancefloor)\b/.test(s)) t.add('nightlife')
  if (kind === 'park' || /\b(garden|river walk|heath|nature|wildlife|trees)\b/.test(s)) t.add('nature')
  if (kind === 'museum' && /\b(art|gallery|paint|sculpture|design|photograph)\b/.test(s) || /\b(gallery|street art|contemporary art)\b/.test(s)) t.add('art')
  if (l.type === 'buy' || kind === 'market' || /\b(shopping|boutique|department store)\b/.test(s)) t.add('shopping')
  if (/\b(histor|medieval|roman|tudor|victorian|georgian|century|built in|royal|palace|castle|abbey|cathedral|war|tower)\b/.test(s)) t.add('history')
  if (/\b(theatre|church|cathedral|abbey|museum|opera|ballet|concert|literary|library)\b/.test(s) || kind === 'museum') t.add('culture')
  if (/\b(romantic|candle|sunset|rooftop|views?)\b/.test(s)) t.add('romantic')
  if (/\b(climb|zip|kayak|boat|cycling|bike|escape room|go-?kart|thrill)\b/.test(s)) t.add('adventure')
  if (kind === 'park' || /\b(quiet|peaceful|relax|calm|tranquil|spa)\b/.test(s)) t.add('relaxed')
  // somewhere to eat or drink is that, whatever its walls are: the café in a crypt isn't culture
  if (kind === 'food' || kind === 'cafe' || kind === 'bar') for (const v of ['culture', 'history', 'art', 'shopping', 'nature', 'adventure'] as Vibe[]) t.delete(v)
  if (!t.size) t.add(kind === 'bar' ? 'nightlife' : 'culture')
  if (kind === 'food' || kind === 'cafe') t.add('food')
  return [...t].slice(0, 3)
}

// "Free", "£12", "£8-15", "adult £25.50": a band from the most a typical adult pays.
export function priceOf(l: Pick<Listing, 'price' | 'band' | 'type'>, kind: PlaceKind): Place['price'] {
  if (l.band) return l.band === 'budget' ? 1 : l.band === 'mid' ? 2 : 3
  const p = l.price.toLowerCase()
  if (/^free\b|free entry|free admission|admission free|^free$/.test(p)) return 0
  const pounds = [...p.matchAll(/£\s?(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]))
  if (pounds.length) {
    const top = Math.max(...pounds)
    return top === 0 ? 0 : top < 15 ? 1 : top < 40 ? 2 : 3
  }
  return kind === 'park' || kind === 'viewpoint' ? 0 : kind === 'cafe' || kind === 'market' ? 1 : kind === 'sight' ? 1 : 2
}

const MINUTES: Record<PlaceKind, number> = { food: 75, cafe: 45, bar: 90, museum: 100, park: 60, viewpoint: 45, market: 60, sight: 60 }
const BEST: Record<PlaceKind, Place['bestAt']> = { food: 'evening', cafe: 'morning', bar: 'night', museum: 'midday', park: 'morning', viewpoint: 'evening', market: 'midday', sight: 'midday' }

// The first sentence, short enough for a card.
export function blurbOf(content: string, kind: PlaceKind, district: string): string {
  const first = content.split(/(?<=[.!?])\s+(?=[A-Z])/)[0]?.trim() ?? ''
  if (first.length >= 12 && first.length <= 110) return first.replace(/[.!]?$/, '.')
  if (first.length > 110) return `${first.slice(0, 105).replace(/\s+\S*$/, '')}…`
  const what = { food: 'Restaurant', cafe: 'Café', bar: 'Bar', museum: 'Museum', park: 'Green space', viewpoint: 'Viewpoint', market: 'Market', sight: 'Sight' }[kind]
  return `${what} in ${district.replace(/-/g, ' and ')}.`
}

const KEYWORDS = ['indian', 'curry', 'italian', 'pizza', 'french', 'chinese', 'dim sum', 'japanese', 'sushi', 'ramen', 'thai', 'vietnamese', 'korean', 'turkish', 'lebanese', 'greek', 'spanish', 'tapas', 'mexican', 'caribbean', 'ethiopian', 'vegan', 'vegetarian', 'seafood', 'fish and chips', 'pie', 'steak', 'burger', 'british', 'afternoon tea', 'brunch', 'breakfast', 'bakery', 'pub', 'gastropub', 'cocktails', 'wine', 'beer', 'craft beer', 'gin', 'whisky', 'live music', 'jazz', 'nightclub', 'club', 'comedy', 'theatre', 'street food', 'cheap eats', 'rooftop']
function keywordsOf(l: Listing): string[] | undefined {
  // what's on the menu, so only for somewhere you eat or drink: a museum's "Greek" is its collection
  if (l.type !== 'eat' && l.type !== 'drink') return undefined
  const s = ` ${`${l.name} ${l.content}`.toLowerCase()} `
  const k = KEYWORDS.filter(w => s.includes(` ${w}`))
  return k.length ? k.slice(0, 6) : undefined
}

// What staying in each district is like, for matching a hotel to the trip's vibe.
const AREA_VIBES: Record<string, Vibe[]> = {
  'City of London': ['history', 'culture'], Westminster: ['history', 'culture'], 'Covent Garden': ['culture', 'shopping'],
  Soho: ['nightlife', 'food'], 'Leicester Square': ['nightlife', 'culture'], 'Mayfair-Marylebone': ['shopping', 'romantic'],
  Bloomsbury: ['culture', 'history'], 'Holborn-Clerkenwell': ['food', 'nightlife'], 'South Bank': ['art', 'culture'],
  'Southwark and Lewisham': ['food', 'art'], Lambeth: ['culture', 'relaxed'], 'South Kensington-Chelsea': ['art', 'shopping'],
  'Notting Hill-North Kensington': ['shopping', 'romantic'], 'Paddington-Maida Vale': ['relaxed', 'nature'], Camden: ['nightlife', 'shopping'],
  Islington: ['food', 'nightlife'], Hampstead: ['nature', 'relaxed'], Hackney: ['nightlife', 'art'], 'East End': ['art', 'food'],
  Greenwich: ['history', 'nature'], 'Richmond-Kew': ['nature', 'relaxed'],
}

// Things that happen rather than places to go: a guide lists them, a day plan can't visit them.
const EVENT = /\b(marathon|festival|carnival|parade|regatta|championships?|boat race|bonfire night|fireworks|new year'?s?|pride|proms|lord mayor'?s show|trooping the colour|open house|half marathon)\b/i

// Listed for convenience, not worth a stop: stations, supermarkets, chains, shopping centres.
const NOT_A_VISIT = /\b(station|terminal|shopping cent(?:re|er)|mall|supermarket|sainsbury'?s|tesco|waitrose|lidl|aldi|m&s|marks (?:&|and) spencer|boots|pret(?: a manger)?|starbucks|costa|caffe nero|mcdonald'?s|burger king|kfc|nando'?s|wetherspoons?|hard rock cafe|rainforest cafe|planet hollywood|premier inn|travelodge)\b|^cardinal place$/i

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const km = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 111 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111)

// ── fetching ─────────────────────────────────────────────────────────────────

async function page(district: string): Promise<string> {
  const res = await fetch(`https://en.wikivoyage.org/w/index.php?action=raw&title=${encodeURIComponent(`London/${district}`)}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${district}: ${res.status}`)
  return res.text()
}

// How many Wikipedias have an article on each: a fair measure of how well known a place is.
async function fame(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&format=json&ids=${batch.join('|')}`, { headers: { 'User-Agent': UA } })
    const body = await res.json() as { entities?: Record<string, { sitelinks?: Record<string, unknown> }> }
    for (const [id, e] of Object.entries(body.entities ?? {})) {
      out.set(id, Object.keys(e.sitelinks ?? {}).filter(k => k.endsWith('wiki') && k !== 'commonswiki' && k !== 'specieswiki').length)
    }
  }
  return out
}

// ── building ─────────────────────────────────────────────────────────────────

async function main() {
  const all: Listing[] = []
  for (const d of DISTRICTS) {
    const ls = listingsOf(await page(d), d)
    console.log(`${d}: ${ls.length} listings`)
    all.push(...ls)
  }

  // one entry per place: the same Wikidata item, or the same name within 150 m
  const seen: Listing[] = []
  for (const l of all.filter(l => km(l.coord, CENTER) <= MAX_KM && !EVENT.test(l.name) && !NOT_A_VISIT.test(l.name))) {
    const twin = seen.find(s => (l.wikidata && s.wikidata === l.wikidata) || (slug(s.name) === slug(l.name) && km(s.coord, l.coord) < 0.15))
    if (!twin) seen.push(l)
    else if (l.content.length > twin.content.length) Object.assign(twin, { ...l, wikidata: twin.wikidata ?? l.wikidata })
  }

  const links = await fame([...new Set(seen.flatMap(l => (l.wikidata ? [l.wikidata] : [])))])
  const top = Math.max(1, ...links.values())

  const ids = new Set<string>()
  const places: Place[] = []
  for (const l of seen.filter(l => l.type !== 'sleep')) {
    const kind = kindOf(l)
    let id = `ldn-${slug(l.name)}`
    while (ids.has(id)) id += '-2'
    ids.add(id)
    const n = l.wikidata ? links.get(l.wikidata) ?? 0 : 0
    // 0..1: a Wikipedia article in many languages is famous; a guide listing alone is still a find
    // a football club's article is famous in every language; its ground is a niche visit
    const sport = /\b(f\.?c\.?|united|athletic|rovers|wanderers|rfc|cricket club)$/i.test(l.name) ? 0.4 : 1
    // a restaurant or bar with a Wikipedia article is usually a famous building it sits in: it leads
    // the other restaurants, not the landmarks
    const cap = l.type === 'eat' || l.type === 'drink' ? 0.45 : 1
    const rank = Number(Math.min(cap, (l.wikidata ? 0.25 + 0.75 * Math.sqrt(n / top) : 0.15) * sport).toFixed(3))
    places.push({
      id,
      name: l.name,
      kind,
      coord: [Number(l.coord[0].toFixed(5)), Number(l.coord[1].toFixed(5))],
      tags: tagsOf(l, kind),
      price: priceOf(l, kind),
      minutes: MINUTES[kind],
      blurb: blurbOf(l.content, kind, l.district),
      bestAt: BEST[kind],
      ...(keywordsOf(l) ? { keywords: keywordsOf(l) } : {}),
      rank,
    })
  }
  places.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))

  const hotels: Hotel[] = seen
    .filter(l => l.type === 'sleep')
    .map(l => {
      const pounds = [...l.price.matchAll(/£\s?(\d{2,4})/g)].map(m => Number(m[1])).filter(n => n >= 20 && n <= 2000)
      const nightly = pounds.length ? Math.round(Math.min(...pounds) * GBP_TO_USD) : l.band === 'budget' ? 90 : l.band === 'splurge' ? 450 : l.band === 'mid' ? 200 : 0
      return { l, nightly }
    })
    .filter(x => x.nightly > 0 && km(x.l.coord, CENTER) <= 12)
    .map(({ l, nightly }) => ({
      id: `ldn-h-${slug(l.name)}`,
      name: l.name,
      coord: [Number(l.coord[0].toFixed(5)), Number(l.coord[1].toFixed(5))] as LngLat,
      nightly,
      tier: nightly < 120 ? 'shoestring' as const : nightly < 350 ? 'comfort' as const : 'luxury' as const,
      tags: AREA_VIBES[l.district] ?? ['culture', 'history'],
      blurb: blurbOf(l.content, 'sight', l.district).replace(/^Sight in/, 'Stay in'),
    }))
    .filter((h, i, a) => a.findIndex(x => x.id === h.id) === i)
    // a choice, not a directory: the ten most central of each tier
    .sort((a, b) => km(a.coord, CENTER) - km(b.coord, CENTER))
    .filter((h, _, a) => a.filter(x => x.tier === h.tier).indexOf(h) < 10)

  writeFileSync(new URL('../src/data/london.json', import.meta.url), `${JSON.stringify({ source: 'Wikivoyage (CC BY-SA 4.0), Wikidata (CC0)', built: new Date().toISOString().slice(0, 10), places, hotels })}\n`)
  const byKind = places.reduce<Record<string, number>>((n, p) => ({ ...n, [p.kind]: (n[p.kind] ?? 0) + 1 }), {})
  console.log(`\n${places.length} places`, byKind, `\n${hotels.length} hotels`)
  console.log('top 15:', places.slice(0, 15).map(p => p.name).join(', '))
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(err); process.exit(1) })
