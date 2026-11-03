import type { LngLat } from '../types'
import { haversineKm } from '../planner/geo'

// Free, key-less photos from Wikipedia + Wikimedia Commons.
//  1. Wikipedia geosearch around the pin; if an article's title matches the
//     place name, its lead image is a photo *of* the place.
//  2. Commons geosearch adds freely licensed photos taken *near* the pin.
// Swap for Google Places / Foursquare photos later; callers only see Photo[].

export interface Photo {
  url: string          // ~800px rendition
  full: string         // original, for "view full size"
  credit: string       // photographer / author
  license?: string     // absent when the source page holds the licence details
  source: string       // page to credit and link to
  exact: boolean       // true = photo of this place, false = taken nearby
  related?: boolean    // file is named after the place, but not its article photo
  caption?: string
}

// Nearby shots of roads and junctions say nothing about a place.
const DULL = /(expressway|highway|interchange|junction|parking|overpass|road ?sign|bus stop)/i

const WIKI = 'https://en.wikipedia.org/w/api.php'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const GENERIC = new Set(['the', 'and', 'in', 'of', 'de', 'da', 'do', 'temple', 'shrine', 'park', 'market', 'mercado', 'museum', 'museu', 'street', 'garden', 'gardens', 'tower', 'house', 'hotel', 'bar', 'cafe', 'sky'])
const TRANSIT = /\b(station|railway|line|subway|metro)\b/i
const AREA = /\b(district|neighbou?rhood|parish|ward|area|quarter)\b/i

// A file naming another kind of venue (Meiji Jingu *Stadium*, Shin-Toyosu *Station*)
// is a different place, unless that word is part of this place's own name.
const OTHER_VENUE = new Set(['stadium', 'station', 'hospital', 'school', 'university', 'hotel', 'office', 'building', 'airport', 'bridge', 'railway', 'subway', 'line'])
const otherVenue = (title: string, name: string) => {
  const own = new Set(tokens(name))
  return tokens(title).some(t => OTHER_VENUE.has(t) && !own.has(t))
}

const cache = new Map<string, Promise<Photo[]>>()

async function api(base: string, params: Record<string, string>, signal?: AbortSignal) {
  const res = await fetch(`${base}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`, { signal })
  if (!res.ok) throw new Error(`Photo lookup failed (${res.status})`)
  return res.json()
}

const tokens = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

// Two-way overlap of distinctive words, so "Sensō-ji Temple" ↔ "Sensō-ji" matches
// but "Tempura in Asakusa" ↔ "Asakusa" (the whole district) does not.
function nameMatch(place: string, title: string): number {
  const a = tokens(place).filter(t => !GENERIC.has(t))
  const b = tokens(title).filter(t => !GENERIC.has(t))
  if (!a.length || !b.length) return 0
  const inB = a.filter(t => b.includes(t)).length / a.length
  const inA = b.filter(t => a.includes(t)).length / b.length
  return Math.min(inA, inB)
}

const stripHtml = (s = '') => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

async function articlePhoto(name: string, [lng, lat]: LngLat, allowArea: boolean, signal?: AbortSignal): Promise<Photo | undefined> {
  const data = await api(WIKI, {
    action: 'query', generator: 'geosearch', ggscoord: `${lat}|${lng}`, ggsradius: '600', ggslimit: '15',
    prop: 'pageimages|description', piprop: 'thumbnail|original', pithumbsize: '900',
  }, signal)
  const pages: { title: string; description?: string; thumbnail?: { source: string }; original?: { source: string } }[] =
    Object.values(data.query?.pages ?? {})
  const best = pages
    .filter(p => p.thumbnail)
    // a station or (for a restaurant/bar) a whole district is not a photo of the place
    .filter(p => TRANSIT.test(name) || !TRANSIT.test(`${p.title} ${p.description ?? ''}`))
    .filter(p => allowArea || !AREA.test(p.description ?? ''))
    .map(p => ({ p, score: nameMatch(name, p.title) }))
    .filter(x => x.score >= 0.6)
    .sort((a, b) => b.score - a.score)[0]
  if (!best) return undefined
  return {
    url: best.p.thumbnail!.source,
    full: best.p.original?.source ?? best.p.thumbnail!.source,
    credit: 'Wikipedia',
    source: `https://en.wikipedia.org/wiki/${encodeURIComponent(best.p.title.replace(/ /g, '_'))}`,
    exact: true,
    caption: best.p.description ? `${best.p.title} — ${best.p.description}` : best.p.title,
  }
}

async function nearbyPhotos([lng, lat]: LngLat, radius: number, name: string, signal?: AbortSignal): Promise<Photo[]> {
  const pages = await commonsFiles({ generator: 'geosearch', ggscoord: `${lat}|${lng}`, ggsradius: String(radius), ggsnamespace: '6', ggslimit: '20' }, signal)
  return pages
    .filter(p => !DULL.test(p.title) && !otherVenue(p.title, name))
    .map(p => toPhoto(p, false))
}

// Photos whose file name mentions the place ("teamLab Planets Tokyo 03.jpg"),
// found by Commons full-text search. Ranked by how much of the name they share.
async function namedPhotos(name: string, context: string, coord: LngLat, signal?: AbortSignal): Promise<Photo[]> {
  const want = tokens(name).filter(t => !GENERIC.has(t) && t.length > 2)
  if (!want.length) return []
  const pages = await commonsFiles({ generator: 'search', gsrsearch: `${name} ${context} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '15' }, signal)
  return pages
    .map(p => ({ p, hits: want.filter(t => tokens(p.title).includes(t)).length }))
    .filter(x => x.hits > 0 && !DULL.test(x.p.title) && !otherVenue(x.p.title, name))
    // a same-named landmark elsewhere (Meiji Jingu Stadium vs Meiji Jingu) is not this place
    .filter(x => !x.p.coordinates?.length || haversineKm(coord, [x.p.coordinates[0].lon, x.p.coordinates[0].lat]) < 1.2)
    .sort((a, b) => b.hits - a.hits)
    .map(x => toPhoto(x.p, true))
}

type CommonsPage = { title: string; index?: number; coordinates?: { lat: number; lon: number }[]; imageinfo?: { url: string; thumburl?: string; descriptionurl: string; extmetadata?: Record<string, { value: string }> }[] }

// Photos only (no maps, logos or road infrastructure), in the API's ranking order.
async function commonsFiles(params: Record<string, string>, signal?: AbortSignal): Promise<CommonsPage[]> {
  const data = await api(COMMONS, {
    action: 'query', ...params,
    prop: 'imageinfo|coordinates', iiprop: 'url|extmetadata', iiurlwidth: '900', iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
  }, signal)
  const pages: CommonsPage[] = Object.values(data.query?.pages ?? {})
  return pages
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter(p => p.imageinfo?.length && /\.(jpe?g|webp)$/i.test(p.title) && !/map|logo|diagram|plan|sign/i.test(p.title))
}

function toPhoto(p: CommonsPage, related: boolean): Photo {
  const info = p.imageinfo![0]
  const meta = info.extmetadata ?? {}
  return {
    url: info.thumburl ?? info.url,
    full: info.url,
    credit: stripHtml(meta.Artist?.value) || 'Wikimedia Commons',
    license: meta.LicenseShortName?.value,
    source: info.descriptionurl,
    exact: false,
    related,
    caption: stripHtml(meta.ImageDescription?.value).slice(0, 120) || undefined,
  }
}

export function getPhotos(key: string, name: string, coord: LngLat, opts: { exactLookup?: boolean; allowArea?: boolean; context?: string; lead?: Photo } = {}): Promise<Photo[]> {
  const hit = cache.get(key)
  if (hit) return hit
  let failed = false
  const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => { failed = true; return fallback })
  const job = (async () => {
    const [exact, named, near] = await Promise.all([
      opts.exactLookup === false ? undefined : soft(articlePhoto(name, coord, opts.allowArea ?? true), undefined),
      opts.exactLookup === false ? [] : soft(namedPhotos(name, opts.context ?? '', coord), [] as Photo[]),
      soft(nearbyPhotos(coord, 250, name), [] as Photo[]),
    ])
    // widen the net once if the immediate surroundings are thin
    const around = named.length + near.length >= 3 ? near : [...near, ...(await soft(nearbyPhotos(coord, 700, name), [] as Photo[]))]
    const seen = new Set<string>()
    // best evidence first: a hand-picked photo, the place's own article, photos named after it, then the surroundings
    const photos = [...(opts.lead ? [opts.lead] : []), ...(exact ? [exact] : []), ...named.slice(0, 5), ...around]
      .filter(p => (seen.has(p.full) ? false : (seen.add(p.full), true)))
      .slice(0, 8)
    if (failed) cache.delete(key) // rate-limited or offline: show what we got, but retry next time
    return photos
  })()
  cache.set(key, job)
  return job
}
