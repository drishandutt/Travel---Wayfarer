import { z } from 'zod'
import type { City, Essentials, Hotel, LngLat, Place, Transport } from '../../src/types'
import { CITIES, findCity } from '../../src/data/cities'
import { currencySymbol } from '../../src/money/currency'
import { FALLBACK, brainEnabled, client, textOf, MODEL_LIGHT } from '../claude'
import { openai, openaiLightModel } from '../openai'
import { nominatim } from '../places'
import { UA, articleKind, dedupe, districtLinks, geoOf, listingsOf, placeholderHotels, shapeCatalog, slug, type Listing, type Money } from './wikivoyage'
import { asJob } from '../usage'

// Builds a city the app doesn't know yet, from public guides, when a traveller names it:
//   1. its Wikivoyage article (and its district pages, for a big city) give every sight,
//      museum, park, market, restaurant, bar and stay, each with its own coordinates;
//   2. Wikidata says how well known each one is;
//   3. OpenStreetMap says which country it's in, and so its money;
//   4. Claude (or OpenAI) fills in the practical essentials the dashboard shows: plugs,
//      tipping, the transit card, a few phrases. Without one, those stay plain.
// The result is a `City` like the hand-made ones, kept in the database (./store.ts).

export class BuildError extends Error {}

export type Progress = (text: string) => void

const API = 'https://en.wikivoyage.org/w/api.php'
const MAX_PAGES = 60
const MIN_PLACES = 15

interface Page { title: string; text: string }

async function wiki<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params })
  const res = await fetch(`${API}?${q}`, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(15_000) })
  if (!res.ok) throw new BuildError(`Wikivoyage answered ${res.status}`)
  return res.json() as Promise<T>
}

// The article's wikitext, following redirects ("Lisboa" → "Lisbon").
export async function wikiPage(title: string, signal?: AbortSignal): Promise<Page | undefined> {
  const body = await wiki<{ query?: { pages?: { title: string; missing?: boolean; revisions?: { slots: { main: { content: string } } }[] }[] } }>(
    { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title, redirects: '1' }, signal)
  const page = body.query?.pages?.[0]
  const text = page?.revisions?.[0]?.slots.main.content
  return page && !page.missing && text ? { title: page.title, text } : undefined
}

async function searchTitles(q: string, signal?: AbortSignal): Promise<string[]> {
  const body = await wiki<{ query?: { search?: { title: string }[] } }>({ action: 'query', list: 'search', srsearch: q, srlimit: '5', srnamespace: '0' }, signal)
  return (body.query?.search ?? []).map(s => s.title)
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

// Words that aren't a city: what people say around one ("3 days in", "a trip to").
const FILLER = /\b(?:a|an|the|to|in|at|for|and|or|of|on|with|from|about|around|my|our|me|us|we|i|i'm|im|you|they|them|there|here|let's|lets|do|see|going|go|trip|travel|travelling|traveling|visit|visiting|heading|head|fly|flying|plan|planning|want|wanna|like|love|thinking|maybe|somewhere|place|city|town|please|pls|hi|hello|hey|days?|nights?|weeks?|weekend|people|friends|family|wife|husband|partner|kids|budget|cheap|luxury|next|this|month|year|summer|winter|spring|autumn|fall|\d+)\b/gi

// What in the message could be a city: capitalised runs first ("New York"), then the message
// with the filler taken out. Short and common words aren't tried on their own.
export function cityCandidates(text: string): string[] {
  const out: string[] = []
  const add = (s: string) => { const t = s.trim(); if (t.length >= 3 && !out.some(o => fold(o) === fold(t))) out.push(t) }
  for (const m of text.matchAll(/\b(\p{Lu}[\p{L}'’.-]+(?:\s+(?:de|del|da|do|la|le|el|of|on|the|am|an|sur|upon)?\s*\p{Lu}[\p{L}'’.-]+){0,3})/gu)) {
    const s = m[1].replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
    if (s && !/^(I|I'm|Im|The|A|An)$/.test(s)) add(s)
  }
  const rest = text.replace(/[^\p{L}\p{N}\s'’-]+/gu, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
  if (rest) add(rest)
  return out.slice(0, 4)
}

// The guide for what they named, if there is one and it's a city. `title` is Wikivoyage's own.
export async function findArticle(text: string, signal?: AbortSignal): Promise<{ title: string; page: Page } | undefined> {
  for (const q of cityCandidates(text)) {
    const direct = await wikiPage(q, signal)
    const titles = direct ? [direct.title] : await searchTitles(q, signal)
    for (const title of titles.slice(0, 3)) {
      const bare = fold(title.replace(/\s*\(.*\)$/, ''))
      // the title must be what they said, not a guide that merely mentions it
      if (!(fold(q).includes(bare) || bare.includes(fold(q)) || bare.split(' ').every(w => fold(text).includes(w)))) continue
      const page = direct && direct.title === title ? direct : await wikiPage(title, signal)
      if (!page) continue
      const kind = articleKind(page.text)
      if (kind === 'other') continue
      return { title: page.title, page }
    }
  }
  return undefined
}

// How many Wikipedias have an article on each: a fair measure of how well known a place is.
export async function fame(ids: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&format=json&ids=${batch.join('|')}`, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(15_000) })
    if (!res.ok) throw new BuildError(`Wikidata answered ${res.status}`)
    const body = await res.json() as { entities?: Record<string, { sitelinks?: Record<string, unknown> }> }
    for (const [id, e] of Object.entries(body.entities ?? {})) {
      out.set(id, Object.keys(e.sitelinks ?? {}).filter(k => k.endsWith('wiki') && k !== 'commonswiki' && k !== 'specieswiki').length)
    }
  }
  return out
}

// ── money and time ───────────────────────────────────────────────────────────

// Which money a country uses (ISO 3166 → ISO 4217). The euro area and the big travel countries;
// anything else falls back to dollars, with the dashboard saying so.
const CURRENCY_OF: Record<string, string> = {
  at: 'EUR', be: 'EUR', hr: 'EUR', cy: 'EUR', ee: 'EUR', fi: 'EUR', fr: 'EUR', de: 'EUR', gr: 'EUR', ie: 'EUR', it: 'EUR', lv: 'EUR', lt: 'EUR', lu: 'EUR', mt: 'EUR', nl: 'EUR', pt: 'EUR', sk: 'EUR', si: 'EUR', es: 'EUR', me: 'EUR', xk: 'EUR', ad: 'EUR', mc: 'EUR', sm: 'EUR', va: 'EUR', bg: 'EUR',
  gb: 'GBP', us: 'USD', ec: 'USD', pa: 'USD', sv: 'USD', jp: 'JPY', cn: 'CNY', hk: 'HKD', tw: 'TWD', kr: 'KRW', sg: 'SGD', my: 'MYR', th: 'THB', vn: 'VND', id: 'IDR', ph: 'PHP', in: 'INR', np: 'NPR', lk: 'LKR', bd: 'BDT', pk: 'PKR',
  ae: 'AED', sa: 'SAR', qa: 'QAR', kw: 'KWD', bh: 'BHD', om: 'OMR', il: 'ILS', tr: 'TRY', eg: 'EGP', ma: 'MAD', za: 'ZAR', ke: 'KES', tz: 'TZS', ng: 'NGN', gh: 'GHS',
  ch: 'CHF', li: 'CHF', se: 'SEK', no: 'NOK', dk: 'DKK', is: 'ISK', pl: 'PLN', cz: 'CZK', hu: 'HUF', ro: 'RON', rs: 'RSD', ba: 'BAM', mk: 'MKD', al: 'ALL', ua: 'UAH', ge: 'GEL', am: 'AMD', az: 'AZN', kz: 'KZT', uz: 'UZS', ru: 'RUB',
  ca: 'CAD', mx: 'MXN', br: 'BRL', ar: 'ARS', cl: 'CLP', co: 'COP', pe: 'PEN', uy: 'UYU', bo: 'BOB', cr: 'CRC', gt: 'GTQ', do: 'DOP', cu: 'CUP', jm: 'JMD', au: 'AUD', nz: 'NZD', fj: 'FJD', mv: 'MVR', kh: 'KHR', la: 'LAK', mm: 'MMK', mn: 'MNT', jo: 'JOD', lb: 'LBP', tn: 'TND', et: 'ETB',
}

// Rough units per dollar when no live rates are at hand: enough to band a price, never to pay with.
const ROUGH_PER_USD: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, JPY: 150, CNY: 7.2, HKD: 7.8, TWD: 32, KRW: 1350, SGD: 1.35, MYR: 4.7, THB: 35, VND: 25000, IDR: 16000, PHP: 56, INR: 83, NPR: 133, LKR: 300, BDT: 110, PKR: 280,
  AED: 3.67, SAR: 3.75, QAR: 3.64, KWD: 0.31, BHD: 0.38, OMR: 0.38, ILS: 3.7, TRY: 32, EGP: 48, MAD: 10, ZAR: 18.5, KES: 130, TZS: 2600, NGN: 1500, GHS: 15,
  CHF: 0.9, SEK: 10.5, NOK: 10.7, DKK: 6.9, ISK: 138, PLN: 4, CZK: 23, HUF: 360, RON: 4.6, RSD: 108, BAM: 1.8, MKD: 57, ALL: 94, UAH: 40, GEL: 2.7, AMD: 390, AZN: 1.7, KZT: 460, UZS: 12600, RUB: 90,
  CAD: 1.36, MXN: 17.5, BRL: 5, ARS: 900, CLP: 950, COP: 4000, PEN: 3.75, UYU: 39, BOB: 6.9, CRC: 520, GTQ: 7.8, DOP: 59, CUP: 24, JMD: 156, AUD: 1.52, NZD: 1.65, FJD: 2.25, MVR: 15.4, KHR: 4100, LAK: 21000, MMK: 2100, MNT: 3400, JOD: 0.71, LBP: 89500, TND: 3.1, ETB: 57,
}

export interface Rates { (code: string): number | undefined }

export function moneyFor(countryCode: string | undefined, rates?: Rates): Money & { known: boolean } {
  const code = CURRENCY_OF[(countryCode ?? '').toLowerCase()]
  if (!code) return { code: 'USD', symbol: '$', perUsd: 1, known: false }
  const perUsd = rates?.(code) ?? ROUGH_PER_USD[code] ?? 1
  const digits = perUsd >= 100 ? 0 : perUsd >= 10 ? 1 : 2
  return { code, symbol: currencySymbol(code), perUsd: Number(perUsd.toFixed(digits)), known: true }
}

// An IANA zone from the longitude alone, for when nobody can say better: right to the hour
// across most of the world, and always a name the dashboard's clock can use.
export function roughTimezone(center: LngLat): string {
  const h = Math.round(center[0] / 15)
  // Etc/GMT signs are reversed: Etc/GMT-9 is UTC+9
  return h === 0 ? 'Etc/UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`
}

export function validZone(tz: string | undefined): tz is string {
  if (!tz) return false
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false }
}

// ── the essentials, from a model that knows the city ─────────────────────────

const ESSENTIALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['timezone', 'plugs', 'tipping', 'emergency', 'transit_card', 'water', 'etiquette', 'phrases', 'packing', 'transit_name', 'transit_fare_usd', 'taxi_base_usd', 'taxi_per_km_usd', 'aliases'],
  properties: {
    timezone: { type: 'string', description: 'IANA zone, e.g. Europe/Paris' },
    plugs: { type: 'string' },
    tipping: { type: 'string' },
    emergency: { type: 'string' },
    transit_card: { type: 'string' },
    water: { type: 'string' },
    etiquette: { type: 'array', items: { type: 'string' } },
    phrases: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['en', 'local', 'say'], properties: { en: { type: 'string' }, local: { type: 'string' }, say: { type: 'string' } } } },
    packing: { type: 'array', items: { type: 'string' } },
    transit_name: { type: 'string' },
    transit_fare_usd: { type: 'number' },
    taxi_base_usd: { type: 'number' },
    taxi_per_km_usd: { type: 'number' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'Other names travellers use for the city: its local name, a short form, the country if the city is its obvious destination.' },
  },
} as const

const EssentialsOut = z.object({
  timezone: z.string(),
  plugs: z.string(),
  tipping: z.string(),
  emergency: z.string(),
  transit_card: z.string(),
  water: z.string(),
  etiquette: z.array(z.string()),
  phrases: z.array(z.object({ en: z.string(), local: z.string(), say: z.string() })),
  packing: z.array(z.string()),
  transit_name: z.string(),
  transit_fare_usd: z.number(),
  taxi_base_usd: z.number(),
  taxi_per_km_usd: z.number(),
  aliases: z.array(z.string()),
})

const essentialsBrief = `You fill in the practical facts a trip dashboard shows for a city, for travellers arriving from abroad. Be accurate and specific to this city; if something is genuinely unknown to you, say "Check locally" rather than guess. Style, like these examples: plugs "Type F · 230 V (EU two-pin)"; tipping "Optional: round up, or 5–10% for great table service"; emergency "All emergencies 112"; transit card "Navegante card: load it for metro, trams, buses and the river ferries"; water "Tap water is safe to drink". Etiquette: 3 short, useful points. Phrases: 4 everyday ones in the local language (hello, thank you, excuse me, cheers) with a plain pronunciation; none if English is the local language. Packing: 2 city-specific extras. Transit: the main network's name ("Metro", "Tube", "MRT") and a typical single fare in US dollars; taxi flag-fall and per-km in US dollars. Aliases: 2-5 lowercase, at least 4 letters each.`

export async function essentialsFor(name: string, country: string, signal?: AbortSignal): Promise<z.infer<typeof EssentialsOut> | undefined> {
  return asJob('city', async () => {
    const ask = `City: ${name}, ${country}`
    let json: string
    if (brainEnabled) {
      const response = await client.beta.messages.create({
        ...FALLBACK,
        model: MODEL_LIGHT,
        max_tokens: 4000,
        system: essentialsBrief,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ESSENTIALS_SCHEMA } },
        messages: [{ role: 'user', content: ask }],
      }, { signal: signal ?? AbortSignal.timeout(60_000) })
      if (response.stop_reason !== 'end_turn') return undefined
      json = textOf(response)
    } else if (openai) {
      const response = await openai.responses.create({
        model: openaiLightModel(),
        reasoning: { effort: 'low' },
        instructions: essentialsBrief,
        input: ask,
        text: { format: { type: 'json_schema', name: 'essentials', strict: true, schema: ESSENTIALS_SCHEMA as unknown as Record<string, unknown> } },
      }, { signal: signal ?? AbortSignal.timeout(60_000) })
      if (response.status !== 'completed') return undefined
      json = response.output_text
    } else return undefined
    return EssentialsOut.parse(JSON.parse(json))
  })
}

// ── building ─────────────────────────────────────────────────────────────────

export interface BuildOptions {
  rates?: Rates
  signal?: AbortSignal
  progress?: Progress
  // for a known huge city, the district pages to read instead of discovering them
  districts?: string[]
  essentials?: boolean            // ask a model for the essentials (default: when one is configured)
  rebuild?: boolean               // building a built city again, from its guide as it is now
}

export async function buildCity(found: { title: string; page: Page }, o: BuildOptions = {}): Promise<City> {
  const say = o.progress ?? (() => {})
  const { title, page } = found
  const name = title.replace(/\s*\(.*\)$/, '')
  const id = slug(name)
  if (!o.rebuild && CITIES.some(c => c.id === id)) throw new BuildError(`${name} is already mapped.`)

  // the pages that carry the listings: the article itself, and its districts (a borough's own districts too)
  say(`Reading the ${name} guide`)
  const pages: Page[] = [page]
  const wanted = o.districts ? o.districts.map(d => (d.includes('/') ? d : `${title}/${d}`)) : districtLinks(page.text, title)
  const queue = [...wanted]
  const seenTitles = new Set<string>([title])
  while (queue.length && pages.length < MAX_PAGES) {
    const t = queue.shift()!
    if (seenTitles.has(t)) continue
    seenTitles.add(t)
    say(`Reading the ${name} guide: ${pages.length} of ${Math.min(MAX_PAGES, pages.length + queue.length + 1)} pages`)
    const p = await wikiPage(t, o.signal).catch(() => undefined)
    if (!p || seenTitles.has(p.title) && p.title !== t) continue
    seenTitles.add(p.title)
    pages.push(p)
    // a borough with districts of its own
    if (!o.districts && articleKind(p.text) !== 'other') for (const sub of districtLinks(p.text, p.title)) if (!seenTitles.has(sub)) queue.push(sub)
  }

  const all: Listing[] = []
  for (const p of pages) {
    const district = p.title.includes('/') ? p.title.split('/').slice(1).join(' / ') : p.title === title ? name : p.title
    all.push(...listingsOf(p.text, district))
  }
  if (!all.length) throw new BuildError(`The ${name} guide doesn't list places with map positions, so I can't plan there yet.`)

  // where the city is: the guide says, else the middle of its places
  const geo = geoOf(page.text)
  const mid = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  const center: LngLat = geo?.center ?? [mid(all.map(l => l.coord[0])), mid(all.map(l => l.coord[1]))]
  const huge = pages.length > 8
  const maxKm = huge ? 40 : 25
  const seen = dedupe(all, center, maxKm)
  const listed = seen.filter(l => l.type !== 'sleep').length
  if (listed < MIN_PLACES) throw new BuildError(`The ${name} guide puts only ${listed} places on the map, not enough to plan from.`)

  say(`Ranking ${seen.length} places by how well known they are`)
  const links = await fame([...new Set(seen.flatMap(l => (l.wikidata ? [l.wikidata] : [])))], o.signal)

  say('Working out the country and its money')
  const rev = await nominatim<{ address?: Record<string, string>; error?: string }>('reverse', { lat: center[1].toFixed(5), lon: center[0].toFixed(5), zoom: '10' }, o.signal).catch(() => undefined)
  const country = rev?.address?.country ?? ''
  const money = moneyFor(rev?.address?.country_code, o.rates)
  const prefix = id.slice(0, 3)

  const { places, hotels } = shapeCatalog(seen, { prefix, center, maxKm, money, fame: links })
  const stays: Hotel[] = hotels.length >= 3 ? hotels : [...hotels, ...placeholderHotels(prefix, seen, center).filter(h => !hotels.some(x => x.tier === h.tier))]

  let ess: z.infer<typeof EssentialsOut> | undefined
  if (o.essentials ?? (brainEnabled || Boolean(openai))) {
    say('Asking about plugs, tipping and the transit card')
    try { ess = await essentialsFor(name, country, o.signal) } catch (err) { console.warn('[cities] essentials for', name, (err as Error).message) }
  }
  const essentials: Essentials = {
    timezone: validZone(ess?.timezone) ? ess!.timezone : roughTimezone(center),
    currency: { code: money.code, symbol: money.symbol, perUsd: money.perUsd },
    plugs: ess?.plugs || 'Check the plug type before you go',
    tipping: ess?.tipping || 'Check local custom',
    emergency: ess?.emergency || 'Check the local emergency number (112 works in much of the world)',
    transitCard: ess?.transit_card || 'Ask about a transit card or contactless fares on arrival',
    water: ess?.water || 'Check whether tap water is safe to drink',
    etiquette: ess?.etiquette.slice(0, 4) ?? [],
    phrases: ess?.phrases.slice(0, 5) ?? [],
    packing: ess?.packing.slice(0, 3) ?? [],
  }
  const transport: Transport = {
    transitName: ess?.transit_name || 'Transit',
    transitFare: clampFare(ess?.transit_fare_usd, 2),
    taxiBase: clampFare(ess?.taxi_base_usd, 3),
    taxiPerKm: clampFare(ess?.taxi_per_km_usd, 1.5),
  }

  const aliases = new Set<string>([fold(name)])
  if (/\bcity$/i.test(name)) aliases.add(fold(name.replace(/\s+city$/i, '')))
  for (const a of ess?.aliases ?? []) {
    const f = fold(a)
    // short aliases match inside other words; a city's own name is never dropped
    if (f.length >= 4 && (!findCity(f) || findCity(f)?.id === id)) aliases.add(f)
  }

  return {
    id,
    name,
    country,
    center: [Number(center[0].toFixed(4)), Number(center[1].toFixed(4))],
    zoom: huge ? 11.4 : 12.4,
    aliases: [...aliases],
    places,
    hotels: stays,
    transport,
    essentials,
    credit: 'Places from Wikivoyage (CC BY-SA 4.0) and Wikidata',
    built: new Date().toISOString().slice(0, 10),
  }
}

const clampFare = (n: number | undefined, fallback: number) => (n !== undefined && Number.isFinite(n) && n > 0 && n < 100 ? Number(n.toFixed(2)) : fallback)

export type { Place }
