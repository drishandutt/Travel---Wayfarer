import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { DayPlan, PlannerEvent, TripBrief } from '../src/types'
import type { Picks } from '../src/planner/engine'
import { MODEL, brainEnabled, describeError } from './claude'
import { runIntake, type IntakeRequest } from './intake'
import { planWithClaude } from './planAgent'
import { hotelsWithClaude } from './hotelAgent'
import { closeMoneyDb, moneyApi } from './money/routes'
import { clientIp, overLimit } from './money/auth'
import { PlaceError, cachedVideos, placeVideos, resolvePlace, traceSocial, type ResolveRequest } from './places'
import { openaiEnabled } from './openai'
import { AgentError, agentEnabled, agentTurn } from './agent'
import { captureServerConsole, flush as flushLogs } from './dev/log'
import { chromiumPath, closeBrowser } from './share/browser'
import { cityById } from '../src/data/cities'
import { currentUser } from './money/auth'
import { buildStatus, knownCities, lookupCity, profileCityInBackground, recordSignals } from './cities/store'
import { cityDb } from './money/routes'

// first, so nothing logged from here on is missed
captureServerConsole()

// Minimal API server. The browser holds no secrets: the Anthropic key lives here.
//   GET  /api/health   -> { claude, model, money, openai, agent }
//   POST /api/agent    -> { state, text, calls }   one round of the trip chatbot (server/agent.ts)
//   POST /api/intake   -> { reply, brief }
//   POST /api/plan     -> text/event-stream of PlannerEvent
//   POST /api/hotels   -> text/event-stream of PlannerEvent
//   POST /api/places/resolve -> { place, note?, shared? }  a traveller's own place, from a maps link or a name
//   GET  /api/places/videos  -> PlaceVideos       reels & videos of a place, by name and city
//   GET  /api/cities         -> every city the app can plan
//   GET  /api/cities/:id     -> the City (places, hotels, essentials), promoted finds and profiles included
//   POST /api/cities/lookup  -> { status: known | building | failed | unknown, … }  the city a message names, built if need be
//   GET  /api/cities/:id/status -> how a build is going
//   POST /api/cities/:id/signals -> what a traveller kept and skipped on the deck, so places learn who they suit
//   /api/money/*       -> shared expenses (server/money/routes.ts), the photo vault, reading
//                         shared links (/share/read) and the dev tools (/dev/*, server/dev)

// In production this one server also serves the built site, on the host's PORT.
const PRODUCTION = process.env.NODE_ENV === 'production'
// In dev, not PORT: dev tools often set that for Vite.
const PORT = Number(process.env.WAYFARER_API_PORT ?? (PRODUCTION ? process.env.PORT : undefined) ?? 8787)
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

async function serveStatic(pathname: string, res: ServerResponse) {
  // resolve() collapses any "../", so anything outside dist falls back to the app shell
  let file = resolve(DIST, `.${decodeURIComponent(pathname)}`)
  const inside = file === DIST || file.startsWith(DIST + sep)
  const isFile = inside && (await stat(file).then(s => s.isFile(), () => false))
  if (!isFile) file = join(DIST, 'index.html')
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    // hashed build assets never change; the HTML must always be fresh
    'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  await pipeline(createReadStream(file), res)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('Request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Abort Claude calls when the browser goes away (Start over, tab closed).
function abortOnClose(res: ServerResponse): AbortController {
  const ctrl = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ctrl.abort() })
  return ctrl
}

async function stream(res: ServerResponse, events: (signal: AbortSignal) => AsyncGenerator<PlannerEvent>) {
  const ctrl = abortOnClose(res)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const send = (e: PlannerEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`)
  try {
    for await (const e of events(ctrl.signal)) send(e)
  } catch (err) {
    if (!ctrl.signal.aborted) {
      console.error('[plan]', err)
      send({ type: 'error', message: describeError(err) })
    }
  }
  res.end()
}

const server = createServer(async (req, res) => {
  try {
    // inside the try: a malformed path like "//" throws here, and must not stop the server
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { claude: brainEnabled, model: brainEnabled ? MODEL : null, money: Boolean(await moneyApi()), openai: openaiEnabled, agent: agentEnabled(), linkReader: chromiumPath() ? 'browser' : 'fetch' })
    }
    // Before the check below: shared expenses have nothing to do with Claude and must work without a key.
    if (url.pathname.startsWith('/api/money/')) {
      const money = await moneyApi()
      if (!money) return json(res, 503, { error: 'Money tracking isn’t set up on this server yet.', code: 'no-storage' })
      return await money(req, res, url)
    }
    // Before the check below too: these work without Claude, just with less detail.
    if (req.method === 'POST' && url.pathname === '/api/places/resolve') {
      if (overLimit(`place:${clientIp(req)}`, 40, 3_600_000)) return json(res, 429, { error: 'That’s a lot of places in a short while. Try again in a bit.' })
      try {
        const db = await cityDb()
        const user = db ? await currentUser(db, req).catch(() => null) : null
        return json(res, 200, await resolvePlace(await readJson<ResolveRequest>(req), abortOnClose(res).signal, user?.id ?? null))
      } catch (err) {
        if (err instanceof PlaceError) return json(res, 422, { error: err.message })
        throw err
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/places/videos') {
      const q = { name: (url.searchParams.get('name') ?? '').slice(0, 120).trim(), city: (url.searchParams.get('city') ?? '').slice(0, 60).trim(), area: url.searchParams.get('area')?.slice(0, 120) || undefined }
      if (!q.name || !q.city) return json(res, 400, { error: 'name and city are required' })
      await moneyApi() // opens the database the found clips are kept in, once
      // each fresh lookup can run a web search, so fresh ones are limited; cached ones are free
      const held = url.searchParams.get('debug') === '1' ? undefined : await cachedVideos(q)
      if (held) {
        res.setHeader('Cache-Control', 'private, max-age=3600')
        // served from what's kept, with a background refresh when it's getting old
        return json(res, 200, await placeVideos(q))
      }
      if (overLimit(`videos:${clientIp(req)}`, 30, 3_600_000)) return json(res, 429, { error: 'Too many lookups. Try again in a bit.' })
      // ?debug=1: run the Instagram/TikTok search fresh and show what it found and kept (temporary, for checking it live)
      if (url.searchParams.get('debug') === '1') return json(res, 200, await traceSocial(q))
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return json(res, 200, await placeVideos(q))
    }
    // Cities: the hand-made ones, and any other built from public guides when someone names it.
    if (req.method === 'GET' && url.pathname === '/api/cities') {
      await cityDb()
      return json(res, 200, { cities: knownCities() })
    }
    if (req.method === 'POST' && url.pathname === '/api/cities/lookup') {
      await cityDb()
      const { text } = await readJson<{ text?: string }>(req)
      if (!text?.trim()) return json(res, 400, { error: 'Say which city.' })
      // a lookup that starts a build reads a guide and asks a model; the rest is cheap
      if (overLimit(`city:${clientIp(req)}`, 30, 3_600_000)) return json(res, 429, { error: 'That’s a lot of cities in a short while. Try again in a bit.' })
      return json(res, 200, await lookupCity(text.slice(0, 200), abortOnClose(res).signal))
    }
    const cityPath = url.pathname.match(/^\/api\/cities\/([a-z0-9-]{1,40})(?:\/(status|signals))?$/)
    if (cityPath && req.method === 'GET' && cityPath[2] === 'status') {
      const job = buildStatus(cityPath[1])
      const city = cityById(cityPath[1])
      if (!job && !city) return json(res, 404, { error: 'No such city' })
      return json(res, 200, job ?? { id: city!.id, name: city!.name, status: 'ready', progress: `${city!.places.length} places` })
    }
    if (cityPath && req.method === 'GET' && !cityPath[2]) {
      await cityDb()
      const city = cityById(cityPath[1])
      if (!city) return json(res, 404, { error: 'No such city' })
      // a model's read on its best-known places, once per city, in the background
      profileCityInBackground(city.id)
      res.setHeader('Cache-Control', 'private, max-age=120')
      return json(res, 200, city)
    }
    if (cityPath && req.method === 'POST' && cityPath[2] === 'signals') {
      await cityDb()
      if (overLimit(`signals:${clientIp(req)}`, 60, 3_600_000)) return json(res, 429, { error: 'Too many in a short while.' })
      const body = await readJson<{ liked?: unknown; rejected?: unknown; brief?: TripBrief }>(req)
      const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 80).slice(0, 200) : [])
      const n = await recordSignals(cityPath[1], ids(body.liked), ids(body.rejected), body.brief && typeof body.brief === 'object' ? { ...body.brief, vibes: Array.isArray(body.brief.vibes) ? body.brief.vibes : [] } : { vibes: [] })
      return json(res, 200, { recorded: n })
    }
    if (req.method === 'POST' && url.pathname === '/api/agent') {
      if (!agentEnabled()) return json(res, 503, { error: 'The assistant isn’t switched on here.' })
      // every round is a model call, so rounds are limited per visitor
      if (overLimit(`agent:${clientIp(req)}`, 150, 3_600_000)) return json(res, 429, { error: 'That’s a lot of requests in a short while. Try again in a bit.' })
      try {
        return json(res, 200, await agentTurn(await readJson(req), abortOnClose(res).signal))
      } catch (err) {
        if (err instanceof AgentError) return json(res, 422, { error: err.message })
        if (err instanceof Error && err.name === 'ZodError') return json(res, 400, { error: 'Bad request' })
        throw err
      }
    }
    if (!brainEnabled && url.pathname.startsWith('/api/')) {
      return json(res, 503, { error: 'Claude is not configured. Set ANTHROPIC_API_KEY in .env.' })
    }
    if (req.method === 'POST' && url.pathname === '/api/intake') {
      const body = await readJson<IntakeRequest>(req)
      return json(res, 200, await runIntake(body, abortOnClose(res).signal))
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const { brief, picks } = await readJson<{ brief: TripBrief; picks?: Picks }>(req)
      return stream(res, signal => planWithClaude(brief, signal, picks))
    }
    if (req.method === 'POST' && url.pathname === '/api/hotels') {
      const { brief, days } = await readJson<{ brief: TripBrief; days: DayPlan[] }>(req)
      return stream(res, signal => hotelsWithClaude(brief, days, signal))
    }
    if (PRODUCTION && !url.pathname.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
      return await serveStatic(url.pathname, res)
    }
    json(res, 404, { error: 'Not found' })
  } catch (err) {
    console.error('[api]', req.method, req.url, err)
    if (!res.headersSent) json(res, 500, { error: describeError(err) })
  }
})

server.listen(PORT, () => {
  console.log(`Wayfarer API on http://localhost:${PORT} — brain: ${brainEnabled ? MODEL : 'offline (no ANTHROPIC_API_KEY)'}`)
  // connect (and run any migration) now, not on someone's first tap
  void moneyApi()
})

// A redeploy stops the old container with SIGTERM. Without a handler the process dies on
// the signal, which the host records as a crash; this exits cleanly instead.
let stopping = false
function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: shutting down`)
  server.close()
  server.closeAllConnections() // live-sync streams would otherwise hold the close open
  // a transaction still in flight is rolled back by the database, so nothing half-written stays
  void Promise.race([flushLogs().then(() => Promise.all([closeMoneyDb(), closeBrowser()])), new Promise(r => setTimeout(r, 3000))]).finally(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
