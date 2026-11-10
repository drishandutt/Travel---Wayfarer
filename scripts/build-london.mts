// Builds London's places and hotels from Wikivoyage's district guides, ranked by how well known
// each place is on Wikidata. Writes src/data/london.json, which the app ships as London's catalog.
//
//   npx tsx scripts/build-london.mts
//
// The reading and shaping live in server/cities/wikivoyage.ts, which also builds any other city
// a traveller names (server/cities/build.ts). London keeps its own district list and the hand-set
// feel of each area for its hotels.

import { writeFileSync } from 'node:fs'
import type { LngLat, Vibe } from '../src/types'
import { fame, wikiPage } from '../server/cities/build'
import { dedupe, listingsOf, shapeCatalog, type Listing } from '../server/cities/wikivoyage'

export { blurbOf, plain, priceOf } from '../server/cities/wikivoyage'

const DISTRICTS = [
  'City of London', 'Westminster', 'Covent Garden', 'Soho', 'Leicester Square', 'Mayfair-Marylebone', 'Bloomsbury',
  'Holborn-Clerkenwell', 'South Bank', 'Southwark and Lewisham', 'Lambeth', 'South Kensington-Chelsea',
  'Notting Hill-North Kensington', 'Paddington-Maida Vale', 'Camden', 'Islington', 'Hampstead', 'Hackney',
  'East End', 'Greenwich', 'Richmond-Kew', 'Hammersmith and Fulham', 'Wandsworth', 'Wimbledon',
  'North', 'East', 'South', 'West',
]
const CENTER: LngLat = [-0.1276, 51.5072]
const MAX_KM = 40

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

async function main() {
  const all: Listing[] = []
  for (const d of DISTRICTS) {
    const page = await wikiPage(`London/${d}`)
    if (!page) throw new Error(`${d}: missing`)
    const ls = listingsOf(page.text, d)
    console.log(`${d}: ${ls.length} listings`)
    all.push(...ls)
  }
  const seen = dedupe(all, CENTER, MAX_KM)
  const links = await fame([...new Set(seen.flatMap(l => (l.wikidata ? [l.wikidata] : [])))])
  const { places, hotels } = shapeCatalog(seen, { prefix: 'ldn', center: CENTER, maxKm: MAX_KM, money: { code: 'GBP', symbol: '£', perUsd: 0.79 }, fame: links, areaVibes: AREA_VIBES })

  writeFileSync(new URL('../src/data/london.json', import.meta.url), `${JSON.stringify({ source: 'Wikivoyage (CC BY-SA 4.0), Wikidata (CC0)', built: new Date().toISOString().slice(0, 10), places, hotels })}\n`)
  const byKind = places.reduce<Record<string, number>>((n, p) => ({ ...n, [p.kind]: (n[p.kind] ?? 0) + 1 }), {})
  console.log(`\n${places.length} places`, byKind, `\n${hotels.length} hotels`)
  console.log('top 15:', places.slice(0, 15).map(p => p.name).join(', '))
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(err); process.exit(1) })
