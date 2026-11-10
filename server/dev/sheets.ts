import { inflateRawSync } from 'node:zlib'
import type { PlaceKind, Vibe } from '../../src/types'

// Reading the owner's lists of places for a bulk import: Excel (.xlsx), CSV or TSV, and
// Markdown or pasted text. Each becomes the same rows (`ImportRow`), shown in the dev tools
// before anything is added. No dependency: an .xlsx file is a zip of XML, and Node can inflate.

export interface ImportRow {
  line: number              // where it came from, for the preview: a sheet row or a text line
  name: string
  city?: string
  country?: string
  area?: string
  kind?: PlaceKind
  vibes?: Vibe[]
  price?: 0 | 1 | 2 | 3
  notes?: string
  lat?: number
  lng?: number
  link?: string
  minutes?: number
  bestAt?: 'morning' | 'midday' | 'evening' | 'night'
  keywords?: string[]
}

export class SheetError extends Error {}

export const MAX_ROWS = 1000

// ── xlsx ─────────────────────────────────────────────────────────────────────

// The files in a zip, by name, inflated. Reads the central directory at the end, which is
// where sizes are reliable.
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new SheetError('That file isn’t a readable .xlsx (no zip directory).')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new SheetError('That .xlsx is damaged.')
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    at += 46 + nameLen + extraLen + commentLen
    if (!/\.(xml|rels)$/i.test(name)) continue
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new SheetError('That .xlsx is damaged.')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }))
  }
  return out
}

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('')

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// The first sheet of a workbook, as rows of text.
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf)
  const shared = files.get('xl/sharedStrings.xml')?.toString('utf8')
  const strings = shared ? [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1])) : []
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const book = files.get('xl/workbook.xml')?.toString('utf8')
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8')
  const rid = book?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1]
  const target = rid && rels ? rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1] : undefined
  if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  const sheet = files.get(sheetPath)?.toString('utf8') ?? [...files.entries()].find(([k]) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))?.[1].toString('utf8')
  if (!sheet) throw new SheetError('That workbook has no sheet I can read.')
  const rows: string[][] = []
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]
      const body = c[2] ?? ''
      const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1]
      const type = attrs.match(/\bt="([^"]+)"/)?.[1]
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let value = ''
      if (type === 's') value = strings[Number(v)] ?? ''
      else if (type === 'inlineStr') value = texts(body)
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
      else value = v !== undefined ? decode(v) : ''
      row[ref ? colIndex(ref) : row.length] = value.trim()
    }
    rows.push(Array.from(row, x => x ?? ''))
  }
  return rows.filter(r => r.some(Boolean))
}

// ── csv / tsv ────────────────────────────────────────────────────────────────

export function readCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const first = t.split(/\r?\n/, 1)[0] ?? ''
  const sep = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === sep) { row.push(cell.trim()); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++
      row.push(cell.trim()); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row) }
  return rows.filter(r => r.some(Boolean))
}

// ── from a table to rows ─────────────────────────────────────────────────────

type Field = keyof Omit<ImportRow, 'line'> | 'coords'
const HEADERS: [Field, RegExp][] = [
  ['name', /^(?:place|place name|name|title|venue|spot|attraction|restaurant|bar|what)$/],
  ['city', /^(?:city|town|destination|city name)$/],
  ['country', /^(?:country|nation)$/],
  ['area', /^(?:area|neighbou?rhood|district|address|location|where|region|quarter)$/],
  ['kind', /^(?:kind|type|category|place type)$/],
  ['vibes', /^(?:vibes?|tags?|style|mood|good for)$/],
  ['price', /^(?:price|cost|budget|price level|price range|\$+)$/],
  ['notes', /^(?:notes?|description|desc|why|blurb|comments?|about|details|summary|tip|tips)$/],
  ['lat', /^(?:lat|latitude)$/],
  ['lng', /^(?:lng|lon|long|longitude)$/],
  ['coords', /^(?:coordinates|coords|lat ?[,/] ?lng|lat ?[,/] ?lon|latlng|gps)$/],
  ['link', /^(?:link|url|maps?|map link|google maps|maps link|apple maps|website)$/],
  ['minutes', /^(?:minutes|duration|time needed|visit length|how long|time)$/],
  ['bestAt', /^(?:best time|best at|when to go|time of day|when)$/],
  ['keywords', /^(?:keywords|cuisine|food|dishes|known for)$/],
]

const headerOf = (cell: string): Field | undefined => {
  const h = cell.toLowerCase().replace(/[*_:]/g, '').replace(/\s+/g, ' ').trim()
  return HEADERS.find(([, re]) => re.test(h))?.[0]
}

export function rowsFromTable(table: string[][], startLine = 1, defaults: Partial<ImportRow> = {}): ImportRow[] {
  if (!table.length) return []
  const head = table[0].map(headerOf)
  const hasHeader = head.includes('name') || head.filter(Boolean).length >= 2
  const cols: (Field | undefined)[] = hasHeader ? head : table[0].map((_, i) => (i === 0 ? 'name' : i === 1 ? 'city' : i === 2 ? 'notes' : undefined))
  // a header row without a name column: the first unrecognised column is the name
  if (hasHeader && !cols.includes('name')) { const i = cols.findIndex(c => !c); if (i >= 0) cols[i] = 'name' }
  const out: ImportRow[] = []
  const body = hasHeader ? table.slice(1) : table
  body.forEach((cells, i) => {
    const raw: Partial<Record<Field, string>> = {}
    cols.forEach((f, j) => { if (f && cells[j]?.trim() && raw[f] === undefined) raw[f] = cells[j].trim() })
    const row = shape(raw, startLine + i + (hasHeader ? 1 : 0), defaults)
    if (row) out.push(row)
  })
  return out
}

// ── markdown and pasted text ─────────────────────────────────────────────────

// Section headings that say what kind of place follows, not where.
const KIND_HEADINGS: [RegExp, PlaceKind][] = [
  [/\b(eat|food|restaurants?|dinner|lunch|breakfast|brunch|street food)\b/i, 'food'],
  [/(?<!\p{L})(caf[eé]s?|coffee|bakeries|bakery)(?!\p{L})/iu, 'cafe'],
  [/\b(drinks?|bars?|pubs?|nightlife|clubs?|cocktails?)\b/i, 'bar'],
  [/\b(parks?|gardens?|nature|outdoors?|beaches?|hikes?)\b/i, 'park'],
  [/\b(museums?|galleries|gallery|art)\b/i, 'museum'],
  [/\b(markets?|shopping|shops?)\b/i, 'market'],
  [/\b(views?|viewpoints?|lookouts?|miradouros?|rooftops?)\b/i, 'viewpoint'],
  [/\b(see|sights?|sightseeing|landmarks?|things to do|do|attractions?)\b/i, 'sight'],
]
const NOT_A_CITY = /\b(day \d+|days?|itinerary|plan|notes?|list|places|to do|todo|ideas?|must|maybe|bucket|favou?rites?|hidden gems?|gems|week|weekend|trip|overview|intro|tips?|budget)\b/i

const cleanName = (s: string) => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`~]+/g, '')
  .replace(/^\[[ xX]\]\s*/, '')
  .replace(/\s+/g, ' ')
  .trim()

export function rowsFromMarkdown(text: string, defaults: Partial<ImportRow> = {}): ImportRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const out: ImportRow[] = []
  let city = defaults.city
  let kind = defaults.kind
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
    if (heading) {
      const h = cleanName(heading[1])
      const k = KIND_HEADINGS.find(([re]) => re.test(h))?.[1]
      if (k) kind = k
      else if (!NOT_A_CITY.test(h) && h.split(' ').length <= 4) { city = h.replace(/^(?:in|around)\s+/i, ''); kind = defaults.kind }
      continue
    }
    // a table: header, separator, rows
    if (/^\|.*\|$/.test(line) && /^\|?\s*:?-{2,}/.test(lines[i + 1]?.trim() ?? '')) {
      const table: string[][] = []
      let j = i
      for (; j < lines.length && /^\|.*\|$/.test(lines[j].trim()); j++) {
        if (j === i + 1) continue
        table.push(lines[j].trim().replace(/^\||\|$/g, '').split('|').map(c => cleanName(c)))
      }
      out.push(...rowsFromTable(table, i + 1, { ...defaults, city, kind }))
      i = j - 1
      continue
    }
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/)
    const body = item ? item[1] : line
    if (!item && (body.length > 70 || /[.!?]$/.test(body) || body.split(/\s+/).length > 9)) continue
    const link = body.match(/\]\((https?:\/\/[^)\s]+)\)/)?.[1] ?? body.match(/https?:\/\/\S+/)?.[0]
    // "Name — note", "Name: note", "Name - note", "Name (Area)"
    const stripped = body.replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)\s]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
    const bold = stripped.match(/^\s*(?:\[[ xX]\]\s*)?\*\*([^*]+)\*\*\s*(.*)$/)
    let name = bold ? bold[1] : stripped
    let note = bold ? bold[2] : ''
    if (!bold) {
      const split = name.match(/^(.+?)\s+(?:[—–]|-{1,2})\s+(.+)$/) ?? name.match(/^([^:]{2,60}):\s+(.+)$/)
      if (split) { name = split[1]; note = split[2] }
    }
    note = cleanName(note.replace(/^[\s:—–-]+/, ''))
    let area: string | undefined
    const paren = cleanName(name).match(/^(.+?)\s*\(([^)]{2,60})\)$/)
    if (paren) { name = paren[1]; area = paren[2] }
    const row = shape({ name: cleanName(name), notes: note || undefined, area, link }, i + 1, { ...defaults, city, kind })
    if (row) out.push(row)
  }
  return out
}

// ── one row, tidied ──────────────────────────────────────────────────────────

const KIND_WORDS: [RegExp, PlaceKind][] = [
  [/(?<!\p{L})(caf[eé]|coffee|bakery|patisserie|tea ?room|brunch spot)(?!\p{L})/iu, 'cafe'],
  [/\b(restaurant|food|eat|eatery|dining|bistro|diner|street food|food truck|izakaya|tapas|ramen|pizzeria)\b/i, 'food'],
  [/\b(bar|pub|club|nightclub|nightlife|drink|cocktail|wine|brewery|speakeasy)\b/i, 'bar'],
  [/\b(museum|gallery|exhibition)\b/i, 'museum'],
  [/\b(park|garden|nature|beach|forest|lake|hike|trail|reserve)\b/i, 'park'],
  [/\b(market|bazaar|souk|shopping|shop|store)\b/i, 'market'],
  [/\b(viewpoint|view|lookout|rooftop|observation|miradouro|mirador)\b/i, 'viewpoint'],
  [/\b(sight|landmark|monument|church|temple|shrine|castle|palace|attraction|historic|square|street|neighbou?rhood)\b/i, 'sight'],
]
const VIBE_WORDS: [Vibe, RegExp][] = [
  ['food', /\b(food|foodie|eat|culinary|cuisine)\b/i],
  ['culture', /\b(culture|cultural|traditional|local)\b/i],
  ['nightlife', /\b(nightlife|party|bars?|clubbing|night out|drinks)\b/i],
  ['nature', /\b(nature|outdoors?|green|parks?|hiking|beach)\b/i],
  ['art', /\b(art|arts|museum|gallery|design|street art)\b/i],
  ['shopping', /\b(shopping|shops?|fashion|vintage|market)\b/i],
  ['relaxed', /\b(relaxed|chill|calm|slow|quiet|peaceful|laid[- ]back)\b/i],
  ['adventure', /\b(adventure|adventurous|thrill|active|sporty)\b/i],
  ['romantic', /\b(romantic|date|couples?|sunset)\b/i],
  ['history', /\b(history|historic|historical|heritage|old town|ancient)\b/i],
]

const num = (s: string | undefined) => {
  if (!s) return undefined
  const n = Number(s.replace(',', '.').replace(/[^\d.+-]/g, ''))
  return Number.isFinite(n) && s.match(/\d/) ? n : undefined
}

function shape(raw: Partial<Record<Field, string>>, line: number, defaults: Partial<ImportRow>): ImportRow | undefined {
  const name = cleanName(raw.name ?? '').slice(0, 100)
  if (!name || name.length < 2 || /^(?:name|place|places|total|n\/a|-+)$/i.test(name)) return undefined
  const row: ImportRow = { line, name }
  const city = raw.city?.trim() || defaults.city
  if (city) row.city = city.slice(0, 80)
  if (raw.country) row.country = raw.country.slice(0, 80)
  if (raw.area) row.area = cleanName(raw.area).slice(0, 120)
  const kindText = raw.kind ?? ''
  const kind = KIND_WORDS.find(([re]) => re.test(kindText))?.[1] ?? defaults.kind
  if (kind) row.kind = kind
  const vibeText = raw.vibes ?? ''
  const vibes = VIBE_WORDS.filter(([, re]) => re.test(vibeText)).map(([v]) => v)
  if (vibes.length) row.vibes = vibes.slice(0, 3)
  const price = priceOf(raw.price)
  if (price !== undefined) row.price = price
  if (raw.notes) row.notes = cleanName(raw.notes).slice(0, 300)
  let lat = num(raw.lat)
  let lng = num(raw.lng)
  const pair = raw.coords?.match(/(-?\d{1,2}(?:[.,]\d+)?)\s*[,;/ ]\s*(-?\d{1,3}(?:[.,]\d+)?)/)
  if (pair && (lat === undefined || lng === undefined)) { lat = num(pair[1]); lng = num(pair[2]) }
  if (lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) { row.lat = lat; row.lng = lng }
  const link = raw.link?.match(/https?:\/\/\S+/)?.[0]
  if (link) row.link = link.slice(0, 500)
  const minutes = num(raw.minutes)
  if (minutes !== undefined) row.minutes = Math.round(/h(ou)?r/i.test(raw.minutes ?? '') ? minutes * 60 : minutes)
  const best = (raw.bestAt ?? '').toLowerCase()
  const bestAt = /night|late/.test(best) ? 'night' : /evening|sunset|dinner/.test(best) ? 'evening' : /morning|early|breakfast|sunrise/.test(best) ? 'morning' : /midday|noon|afternoon|lunch|day/.test(best) ? 'midday' : undefined
  if (bestAt) row.bestAt = bestAt
  if (raw.keywords) row.keywords = raw.keywords.split(/[,;/|]/).map(k => k.trim().toLowerCase()).filter(Boolean).slice(0, 6)
  return row
}

function priceOf(s: string | undefined): ImportRow['price'] {
  if (!s) return undefined
  const t = s.trim().toLowerCase()
  if (/^free$|^0$|\bfree\b/.test(t)) return 0
  const dollars = t.match(/^[$€£¥]{1,4}$/)?.[0].length
  if (dollars) return Math.min(3, dollars) as ImportRow['price']
  if (/^[1-3]$/.test(t)) return Number(t) as ImportRow['price']
  if (/cheap|budget|low|inexpensive/.test(t)) return 1
  if (/mid|moderate|medium|average/.test(t)) return 2
  if (/expensive|luxury|splurge|high|fine dining/.test(t)) return 3
  return undefined
}

// ── any upload ───────────────────────────────────────────────────────────────

export type FileKind = 'xlsx' | 'csv' | 'md' | 'text'

export function fileKind(name: string, bytes: Buffer): FileKind {
  if (bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50) return 'xlsx'
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'xls') throw new SheetError('Old .xls workbooks can’t be read. Save it as .xlsx or .csv and upload that.')
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'md' || ext === 'markdown') return 'md'
  return 'text'
}

// Rows from an uploaded file (or pasted text), deduplicated by name and city, at most MAX_ROWS.
export function readUpload(name: string, bytes: Buffer, defaults: Partial<ImportRow> = {}): { kind: FileKind; rows: ImportRow[]; skipped: number } {
  const kind = fileKind(name, bytes)
  const rows = kind === 'xlsx' ? rowsFromTable(readXlsx(bytes), 1, defaults)
    : kind === 'csv' ? rowsFromTable(readCsv(bytes.toString('utf8')), 1, defaults)
    : rowsFromMarkdown(bytes.toString('utf8'), defaults)
  const seen = new Set<string>()
  const unique = rows.filter(r => {
    const k = `${r.name.toLowerCase()}|${(r.city ?? '').toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (!unique.length) throw new SheetError(kind === 'xlsx' || kind === 'csv' ? 'No places found: the sheet needs a column of place names (headed "Name" or "Place").' : 'No places found: put one place per line, or as a list.')
  return { kind, rows: unique.slice(0, MAX_ROWS), skipped: rows.length - Math.min(unique.length, MAX_ROWS) }
}
