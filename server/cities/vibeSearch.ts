import { z } from 'zod'
import type { City, Place, PlaceKind, TripBrief, Vibe } from '../../src/types'
import { cityById } from '../../src/data/cities'
import { resolveBudgetTier } from '../../src/planner/intake'
import { hasMood, moodOf, storyLines } from '../../src/planner/story'

export { hasMood, moodOf }
import { FALLBACK, MODEL, brainEnabled, client, textOf } from '../claude'
import { OPENAI_MODEL, openai } from '../openai'
import { collectOpenAISources, collectResults, resolvePlace } from '../places'
import { track } from '../dev/activity'
import { promoteFind, recallVibe, rememberVibe, sameSpot } from './store'

// Places a local would pick for this trip's mood. Built cities come from travel guides, which
// lean to the famous sights; this searches the web for the places that fit what the travellers
// told us (a surprise date night, live music, nothing touristy), finds each on OpenStreetMap,
// and adds it to the city's catalog for everyone (found.via 'vibe'), with the know-how a local
// would give. The same mood in the same city isn't searched again for a month.
//
// Nothing is invented: a place is kept only if the page it came from is one the search really
// returned, and only if the map finds it near the city.

const KINDS: PlaceKind[] = ['food', 'cafe', 'bar', 'experience', 'viewpoint', 'park', 'market', 'museum', 'sight']
const MAX_AGE = 30 * 86_400_000
const WANT = 20

const str = { type: 'string' } as const
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['places'],
  properties: {
    places: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'area', 'kind', 'why', 'order', 'arrive', 'move', 'heads', 'price', 'best_at', 'minutes', 'moods', 'source_url'],
        properties: {
          name: { type: 'string', description: 'The name as it appears on maps.' },
          area: { type: 'string', description: 'Neighbourhood.' },
          kind: { type: 'string', enum: KINDS },
          why: { type: 'string', description: 'One sentence on why it fits this trip, in terms of what they told you.' },
          order: { type: 'string', description: 'What to get, or "".' },
          arrive: { type: 'string', description: 'When to arrive and why, or "".' },
          move: { type: 'string', description: 'The insider tip: where to sit, what to ask for, or "".' },
          heads: { type: 'string', description: 'What to know first: booking, dress code, cash only, closed days, or "".' },
          price: { type: 'integer', description: '0 free, 1 cheap, 2 mid, 3 splurge.' },
          best_at: { type: 'string', enum: ['morning', 'midday', 'evening', 'night'] },
          minutes: { type: 'integer', description: 'A typical visit, in minutes.' },
          moods: { type: 'array', items: str, description: '3-5 plain words for its feel: "romantic", "sunset", "live music", "local", "quiet".' },
          source_url: { type: 'string', description: 'The exact URL of the page you found it on.' },
        },
      },
    },
  },
} as const

const Found = z.object({
  places: z.array(z.object({
    name: z.string(), area: z.string(), kind: z.enum(KINDS as [PlaceKind, ...PlaceKind[]]), why: z.string(), order: z.string(), arrive: z.string(), move: z.string(), heads: z.string(),
    price: z.number().int(), best_at: z.enum(['morning', 'midday', 'evening', 'night']), minutes: z.number().int(), moods: z.array(z.string()), source_url: z.string(),
  })),
})
type Candidate = z.infer<typeof Found>['places'][number]

function ask(city: City, brief: TripBrief): string {
  const stay = brief.story?.stay?.name
  return `You know ${city.name} like a well-connected local. Search the web and find about ${WANT} real places and experiences that fit this trip.

The trip:
Travellers: ${brief.travelers ?? 2}
Vibe: ${brief.vibes.join(', ') || 'open'}
Budget: ${resolveBudgetTier(brief)}
${storyLines(brief).join('\n')}

What to look for:
- Places people who live there love, not the standard tourist list (skip the famous landmarks everyone already knows).
- A real mix for their days: places to eat and drink, a view at sunset, cafés, at least three experiences to do together (a class, a workshop, a boat, a show, a spa, a tour by a local), and two or three surprising ideas they'd never think of.
- ${stay ? `Mostly within easy reach of ${stay}, so evenings aren't spent in traffic.` : 'Spread over the neighbourhoods that suit the trip.'}
- Only places that are open and operating now: check with a search. Never include anything you can't find a page for.

For each, give the exact URL of the page you found it on, and write the why, the order, the arrive, the move and the heads-up as a local friend would: short, specific, useful.`
}

async function searchClaude(city: City, brief: TripBrief, signal?: AbortSignal): Promise<{ found: Candidate[]; sources: Set<string> }> {
  const messages: import('@anthropic-ai/sdk').default.Beta.BetaMessageParam[] = [{ role: 'user', content: ask(city, brief) }]
  const results = new Map<string, string>()
  let text = ''
  for (let turn = 0; turn < 4; turn++) {
    const response = await client.beta.messages.create({
      ...FALLBACK,
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages,
    }, { signal })
    collectResults(response.content, results)
    if (response.stop_reason !== 'pause_turn') { text = textOf(response); break }
    messages.push({ role: 'assistant', content: response.content })
  }
  return { found: text ? Found.parse(JSON.parse(text)).places : [], sources: new Set(results.keys()) }
}

async function searchOpenAI(city: City, brief: TripBrief, signal?: AbortSignal): Promise<{ found: Candidate[]; sources: Set<string> }> {
  const response = await openai!.responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: 'medium' },
    tools: [{ type: 'web_search' }],
    include: ['web_search_call.action.sources'],
    input: ask(city, brief),
    text: { format: { type: 'json_schema', name: 'places', strict: true, schema: SCHEMA as unknown as Record<string, unknown> } },
    max_output_tokens: 16000,
  }, { signal })
  const sources = new Map<string, string>()
  collectOpenAISources(response.output, sources)
  return { found: response.status === 'completed' ? Found.parse(JSON.parse(response.output_text)).places : [], sources: new Set(sources.keys()) }
}

// A page counts when the search returned it, or another page on the same site: the model often
// gives the article's own address where the search returned its section page.
export function fromSearch(url: string, sources: Set<string>): boolean {
  const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
  const host = (u: string) => norm(u).split('/')[0]
  const n = norm(url)
  if (!n) return false
  for (const s of sources) if (norm(s) === n || host(s) === host(url)) return true
  return false
}

const VIBE_OF: [RegExp, Vibe][] = [
  [/romant|date|intimate|candle|couple/, 'romantic'], [/bar|cocktail|drink|night|club|live music|dj|party/, 'nightlife'], [/food|dinner|lunch|brunch|eat|cuisine|chef|street food/, 'food'],
  [/\bart|galler|design|craft/, 'art'], [/garden|park|beach|sea|nature|green|walk/, 'nature'], [/quiet|calm|relax|spa|slow|chill/, 'relaxed'],
  [/adventure|thrill|kayak|sail|surf|climb/, 'adventure'], [/heritage|histor|\bold\b/, 'history'], [/culture|local|tradition|music|theatre/, 'culture'], [/shop|boutique|market/, 'shopping'],
]
const clip = (s: string, n: number) => s.trim().slice(0, n)

// One candidate, found on the map and shaped into a catalog place. Undefined when the map can't find it.
async function placeOf(c: Candidate, city: City, signal?: AbortSignal): Promise<Place | undefined> {
  let resolved
  for (const name of [c.name, `${c.name}, ${c.area}`]) {
    try { resolved = await resolvePlace({ name: name.slice(0, 110), kind: c.kind, city: city.id, describe: false }, signal); break } catch { /* try the next way of naming it */ }
  }
  if (!resolved) return undefined
  const r = resolved.place
  const moods = c.moods.map(m => clip(m.toLowerCase(), 30)).filter(Boolean).slice(0, 5)
  const words = `${moods.join(' ')} ${c.why} ${c.kind}`.toLowerCase()
  const tips = Object.fromEntries((['order', 'arrive', 'move', 'heads'] as const).map(k => [k, clip(c[k], 180)]).filter(([, v]) => v)) as Place['tips']
  const { custom, ...rest } = r
  void custom
  return {
    ...rest,
    id: r.id.replace(/^my-/, 'v-'),
    // the map's kind, unless it's something you do, which the map rarely knows
    kind: c.kind === 'experience' || r.kind === 'sight' ? c.kind : r.kind,
    tags: [...new Set([...r.tags, ...VIBE_OF.filter(([re]) => re.test(words)).map(([, v]) => v)])].slice(0, 4),
    price: Math.max(0, Math.min(3, c.price)) as Place['price'],
    minutes: Math.max(30, Math.min(240, c.minutes || r.minutes)),
    bestAt: c.best_at,
    blurb: clip(c.why, 160),
    moods,
    tips,
    keywords: [...new Set([...(r.keywords ?? []), ...moods])].slice(0, 6),
    rank: 0.3, // known to people who care, not to the coach tours
    source: c.source_url.slice(0, 300),
  }
}

const running = new Map<string, Promise<VibeResult>>()
// what this server searched lately, so a repeat doesn't wait on the database
const recent = new Map<string, { ids: string[]; at: number }>()
export interface VibeResult { places: Place[]; cached: boolean; mood: string; searched: number }

export async function findByVibe(cityId: string, brief: TripBrief, userId: string | null, signal?: AbortSignal): Promise<VibeResult> {
  const city = cityById(cityId)
  if (!city) throw new Error('Which city is the trip in?')
  const mood = moodOf(brief)
  const key = `${cityId}|${mood}`
  const held = recent.get(key)
  const known = held && Date.now() - held.at < MAX_AGE ? held.ids : await recallVibe(key, MAX_AGE).catch(() => undefined)
  if (known) {
    const places = known.map(id => city.places.find(p => p.id === id)).filter((p): p is Place => Boolean(p))
    if (places.length) return { places, cached: true, mood, searched: 0 }
  }
  const pending = running.get(key)
  if (pending) return pending
  const job = search(city, brief, mood, key, userId, signal).finally(() => running.delete(key))
  running.set(key, job)
  return job
}

async function search(city: City, brief: TripBrief, mood: string, key: string, userId: string | null, signal?: AbortSignal): Promise<VibeResult> {
  const started = Date.now()
  const { found, sources } = brainEnabled ? await searchClaude(city, brief, signal) : openai ? await searchOpenAI(city, brief, signal) : { found: [], sources: new Set<string>() }
  const sourced = found.filter(c => c.name.trim() && fromSearch(c.source_url, sources))
  const places: Place[] = []
  let missed = 0
  for (const c of sourced.slice(0, WANT + 5)) {
    if (signal?.aborted) break
    const p = await placeOf(c, city, signal).catch(() => undefined)
    if (!p) { missed++; continue }
    const listed = city.places.find(x => x.id === p.id || sameSpot(x, p))
    if (listed) { if (!places.includes(listed)) places.push(listed); continue }
    const added = await promoteFind(city.id, p, userId, 'vibe').catch(() => undefined)
    places.push(added ?? p)
  }
  if (places.length) {
    recent.set(key, { ids: places.map(p => p.id), at: Date.now() })
    await rememberVibe(key, city.id, mood, places.map(p => p.id)).catch(() => {})
  }
  track('city.vibe', { userId, subject: city.id, detail: { mood: mood.slice(0, 200), suggested: found.length, sourced: sourced.length, notOnMap: missed, kept: places.length, seconds: Math.round((Date.now() - started) / 1000) } })
  return { places, cached: false, mood, searched: found.length }
}
