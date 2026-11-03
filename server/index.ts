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

// Minimal API server. The browser holds no secrets: the Anthropic key lives here.
//   GET  /api/health   -> { claude, model, money }
//   POST /api/intake   -> { reply, brief }
//   POST /api/plan     -> text/event-stream of PlannerEvent
//   POST /api/hotels   -> text/event-stream of PlannerEvent
//   /api/money/*       -> shared expenses (server/money/routes.ts)

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
      return json(res, 200, { claude: brainEnabled, model: brainEnabled ? MODEL : null, money: Boolean(moneyApi()) })
    }
    // Before the check below: shared expenses have nothing to do with Claude and must work without a key.
    if (url.pathname.startsWith('/api/money/')) {
      const money = moneyApi()
      if (!money) return json(res, 503, { error: 'Money tracking isn’t set up on this server yet.', code: 'no-storage' })
      return await money(req, res, url)
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
    console.error('[api]', err)
    if (!res.headersSent) json(res, 500, { error: describeError(err) })
  }
})

server.listen(PORT, () => {
  console.log(`Wayfarer API on http://localhost:${PORT} — brain: ${brainEnabled ? MODEL : 'offline (no ANTHROPIC_API_KEY)'}`)
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
  closeMoneyDb()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
