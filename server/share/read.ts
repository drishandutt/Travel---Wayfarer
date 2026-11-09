import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { findCity } from '../../src/data/cities'
import { mapsHost, parseMapsLink } from '../../src/planner/customPlaces'
import type { FoundPlace, LinkKind, ShareRead } from '../../src/share/types'
import { FALLBACK, MODEL, brainEnabled, client, textOf } from '../claude'
import { OPENAI_MODEL, openai } from '../openai'
import type { Db } from '../money/db'
import { cookiesFor, siteOf } from '../dev/cookies'
import { chromiumPath, withPage } from './browser'

// A link shared to Wayfarer (a reel, a video, a post, a search, a web page or a map) → the
// places it's about. Maps links are read as they always were (server/places.ts); anything else
// is opened in a headless Chromium with that site's saved session, its words are read, and
// Claude (or OpenAI) names the places in them.

export class ShareError extends Error {}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const MAX_TEXT = 12_000
const PAGE_MS = 25_000

// ── what kind of link ────────────────────────────────────────────────────────

export function kindOf(url: URL): LinkKind {
  const site = siteOf(url.hostname)
  if (mapsHost(url.toString())) return 'maps'
  if (site === 'youtube.com' || site === 'youtu.be') return 'video'
  if (site === 'instagram.com' || site === 'tiktok.com') return /\/(?:reel|reels|p|tv|video)\//.test(url.pathname) || site === 'tiktok.com' ? 'video' : 'post'
  if (['x.com', 'twitter.com', 'linkedin.com', 'facebook.com', 'threads.net', 'threads.com', 'reddit.com'].includes(site)) return 'post'
  if (/^(?:www\.)?(?:google|bing|duckduckgo)\.[a-z.]+$/.test(url.hostname) && /\/search|^\/$/.test(url.pathname) && url.searchParams.get('q')) return 'search'
  return 'page'
}

// "Look at this! https://…" from a share sheet: the link, and the words around it.
export function splitShared(raw: string): { url: string; words: string } | null {
  const m = raw.match(/\bhttps?:\/\/[^\s<>"']+/i)
  if (!m) return null
  return { url: m[0].replace(/[.,;!?)\]]+$/, ''), words: raw.replace(m[0], ' ').replace(/\s+/g, ' ').trim() }
}

// ── never somewhere private ──────────────────────────────────────────────────

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const a = ip.toLowerCase()
    if (a.startsWith('::ffff:')) return privateAddress(a.slice(7))
    return a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a)
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

const hostChecks = new Map<string, Promise<boolean>>()
// A link can't make this server read its own API, the cloud's metadata service or anything else inside.
export function publicHost(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return Promise.resolve(false)
  if (isIP(h)) return Promise.resolve(!privateAddress(h))
  let check = hostChecks.get(h)
  if (!check) {
    check = lookup(h, { all: true }).then(addrs => addrs.length > 0 && addrs.every(a => !privateAddress(a.address)), () => false)
    hostChecks.set(h, check)
    if (hostChecks.size > 2000) hostChecks.delete(hostChecks.keys().next().value!)
  }
  return check
}

// ── reading the page ─────────────────────────────────────────────────────────

export interface PageRead {
  finalUrl: string
  title: string
  description: string
  image: string | null
  text: string
  needsLogin: boolean
  via: 'browser' | 'fetch'
}

// Login walls, by where a site sends you when it wants you signed in.
const LOGIN_WALL = /\/(?:accounts\/login|login|signin|sign-in|authwall|checkpoint|i\/flow\/login|uas\/login)\b/i

// As a string so the bundler's helpers never end up inside the page.
const EXTRACT = `(() => {
  const meta = n => document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]')?.content || ''
  let extra = ''
  try { extra = window.ytInitialPlayerResponse?.videoDetails?.shortDescription || '' } catch {}
  const main = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]') || document.body
  return {
    title: meta('og:title') || document.title || '',
    description: [meta('og:description') || meta('description') || meta('twitter:description'), extra].filter(Boolean).join('\\n\\n'),
    image: meta('og:image') || null,
    text: (main && main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT}),
  }
})()`

async function readWithBrowser(url: string, db: Db | null): Promise<PageRead> {
  const cookies = await cookiesFor(db, new URL(url).hostname)
  return withPage(cookies, async ctx => {
    // every request the page makes is checked too, redirects included
    await ctx.route('**/*', async route => {
      const u = new URL(route.request().url())
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !(await publicHost(u.hostname))) return route.abort('blockedbyclient')
      return route.fallback()
    })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_MS })
    // posts fill in after the page itself has loaded
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    const got = await page.evaluate(EXTRACT) as Omit<PageRead, 'finalUrl' | 'needsLogin' | 'via'>
    const finalUrl = page.url()
    return { ...got, finalUrl, needsLogin: LOGIN_WALL.test(new URL(finalUrl).pathname) && !LOGIN_WALL.test(new URL(url).pathname), via: 'browser' as const }
  })
}

// Without a browser: the page's own HTML, which on most sites still carries its title and summary.
async function readWithFetch(url: string, db: Db | null): Promise<PageRead> {
  let current = url
  let res: Response | undefined
  const cookies = await cookiesFor(db, new URL(url).hostname)
  for (let hop = 0; hop < 6; hop++) {
    if (!(await publicHost(new URL(current).hostname))) throw new ShareError('That link points somewhere I can’t open.')
    res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-GB,en;q=0.9', ...(cookies.length ? { Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') } : {}) },
      signal: AbortSignal.timeout(12_000),
    })
    const next = res.headers.get('location')
    if (!next || res.status < 300 || res.status >= 400) break
    current = new URL(next, current).toString()
  }
  if (!res?.ok) throw new ShareError(`The site answered ${res?.status ?? 'nothing'} when I opened that link.`)
  const html = (await res.text()).slice(0, 2_000_000)
  const meta = (n: string) => decode(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${n}["']`, 'i'))?.[1] ?? '')
  const yt = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1]
  const body = decode(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return {
    finalUrl: current,
    title: meta('og:title') || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? ''),
    description: [meta('og:description') || meta('description'), yt ? JSON.parse(`"${yt}"`) as string : ''].filter(Boolean).join('\n\n'),
    image: meta('og:image') || null,
    text: body.slice(0, MAX_TEXT),
    needsLogin: LOGIN_WALL.test(new URL(current).pathname),
    via: 'fetch',
  }
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, '’').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).trim()

export async function readPage(url: string, db: Db | null): Promise<PageRead> {
  if (chromiumPath()) {
    try {
      return await readWithBrowser(url, db)
    } catch (err) {
      console.warn('[share] the browser couldn’t read', url, '-', (err as Error).message)
    }
  }
  return readWithFetch(url, db)
}

// ── naming the places ────────────────────────────────────────────────────────

const PLACES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'places'],
  properties: {
    summary: { type: 'string' },
    places: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'area', 'city', 'country', 'why'],
        properties: {
          name: { type: 'string' },
          area: { type: 'string' },
          city: { type: 'string' },
          country: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
  },
} as const

const Found = z.object({
  summary: z.string(),
  places: z.array(z.object({ name: z.string(), area: z.string(), city: z.string(), country: z.string(), why: z.string() })),
})

const PLACES_BRIEF = `Someone shared a link to their trip planner: a reel, a video, a social post, a web search or a web page. From what it says, list the specific real places it shows or recommends that a traveller could go to: restaurants, cafes, bars, sights, museums, shops, markets, parks, viewpoints, beaches. Only places named (or unmistakably identified) in the text. Never invent one, and skip vague ones ("a hidden cafe"). Use the place's usual name, without emoji or hashtags. area: its neighbourhood or street if the text says, else "". city and country: where it is, from the text or your knowledge of the place; "" if you can't tell. why: under 80 characters, what the post says about it ("Best tonkotsu in Shibuya, go before 11"). summary: one line on what the link is, under 100 characters. At most 15 places, in the order the text gives them. No places → an empty list. A web search is the one exception to naming only what the text names: answer the search with the real, well-known places that best fit it, as a local would.`

async function namePlaces(about: string, signal?: AbortSignal): Promise<z.infer<typeof Found> | null> {
  let json: string
  if (brainEnabled) {
    const response = await client.beta.messages.create({
      ...FALLBACK,
      model: MODEL,
      max_tokens: 6000,
      system: PLACES_BRIEF,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: PLACES_SCHEMA } },
      messages: [{ role: 'user', content: about }],
    }, { signal })
    if (response.stop_reason !== 'end_turn') return null
    json = textOf(response)
  } else if (openai) {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: 'low' },
      instructions: PLACES_BRIEF,
      input: about,
      text: { format: { type: 'json_schema', name: 'places', strict: true, schema: PLACES_SCHEMA as unknown as Record<string, unknown> } },
    }, { signal })
    if (response.status !== 'completed') return null
    json = response.output_text
  } else return null
  return Found.parse(JSON.parse(json))
}

// ── the whole read ───────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; read: ShareRead }>()
const CACHE_MS = 3_600_000

export async function readShare(db: Db | null, raw: string, words = '', opts: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<ShareRead & { debug?: { text: string; via: string; finalUrl: string } }> {
  const shared = splitShared(raw)
  if (!shared) throw new ShareError('That doesn’t look like a link.')
  const said = [words, shared.words].filter(Boolean).join(' ').slice(0, 500)
  let url: URL
  try { url = new URL(shared.url) } catch { throw new ShareError('That doesn’t look like a link.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ShareError('Only web links can be read.')
  const kind = kindOf(url)
  const site = siteOf(url.hostname)

  // a map is one place, read the way chat reads it
  if (kind === 'maps') {
    const m = parseMapsLink(url.toString())
    return { url: url.toString(), site, kind, title: m?.name ?? 'A place on the map', summary: 'A place from your maps app', image: null, places: [{ name: m?.name ?? 'The place in this link', area: '', city: '', country: '', why: said, cityId: null, link: url.toString() }], needsLogin: false }
  }
  if (!(await publicHost(url.hostname))) throw new ShareError('That link points somewhere I can’t open.')

  const key = `${url}|${said}`
  const hit = cache.get(key)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.read

  // search engines answer a server with a robot check, so a search is answered from the query
  const query = kind === 'search' ? url.searchParams.get('q') ?? '' : ''
  const page: PageRead = query
    ? { finalUrl: url.toString(), title: query, description: '', image: null, text: '', needsLogin: false, via: 'fetch' }
    : await readPage(url.toString(), db)
  const about = [
    `Link: ${url}`,
    `Kind: ${kind}`,
    said && `What they wrote with it: ${said}`,
    query && `Search: ${query}`,
    page.title && `Title: ${page.title}`,
    page.description && `Description:\n${page.description}`,
    page.text && `Page text:\n${page.text}`,
  ].filter(Boolean).join('\n\n')

  const found = await namePlaces(about, opts.signal ?? AbortSignal.timeout(45_000))
  const places: FoundPlace[] = (found?.places ?? []).slice(0, 15).map(p => {
    const city = findCity(`${p.city} ${p.country}`)
    return { name: p.name.trim().slice(0, 80), area: p.area.trim().slice(0, 80), city: p.city.trim().slice(0, 60), country: p.country.trim().slice(0, 60), why: p.why.trim().slice(0, 120), cityId: city?.id ?? null }
  }).filter(p => p.name)

  const read: ShareRead = {
    url: url.toString(),
    site,
    kind,
    title: (page.title || query || site).slice(0, 200),
    summary: found?.summary.slice(0, 200) ?? (page.description || '').slice(0, 200),
    image: page.image,
    places,
    needsLogin: page.needsLogin || (!places.length && Boolean(LOGIN_COOKIE_SITES[site]) && !page.description),
    ...(found ? {} : { note: 'No AI is connected on this server, so the places in it can’t be picked out.' }),
  }
  if (found) {
    cache.set(key, { at: Date.now(), read })
    if (cache.size > 300) cache.delete(cache.keys().next().value!)
  }
  return { ...read, debug: { text: about, via: page.via, finalUrl: page.finalUrl } }
}

// Sites that show little or nothing to a visitor who isn't signed in.
const LOGIN_COOKIE_SITES: Record<string, true> = { 'instagram.com': true, 'x.com': true, 'twitter.com': true, 'linkedin.com': true, 'facebook.com': true, 'threads.net': true, 'threads.com': true, 'tiktok.com': true }
