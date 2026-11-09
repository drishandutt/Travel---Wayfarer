// Everything this browser logs, sent to the dev tools (server/dev): uncaught errors, failed
// promises, and console output. Lines are batched and sent every few seconds, and the rest
// when the page is hidden. The console still prints as normal.

type Level = 'debug' | 'info' | 'warn' | 'error'
interface Entry { level: Level; message: string; detail?: string | null; url: string; at: number }

const ENDPOINT = '/api/money/dev/log'
const EVERY_MS = 4000
const MAX_QUEUE = 300
// a page stuck in a loop of errors mustn't flood the server
const MAX_PER_MINUTE = 120

let queue: Entry[] = []
let sentThisMinute = 0
let installed = false

const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }

function text(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try { return JSON.stringify(v, (_, x) => (x instanceof Error ? `${x.name}: ${x.message}` : x))?.slice(0, 1000) ?? String(v) } catch { return String(v) }
}

export function logToDev(level: Level, args: unknown[]) {
  if (queue.length >= MAX_QUEUE) return
  const message = args.map(text).join(' ').slice(0, 4000)
  // our own sending failing would only log itself again
  if (message.includes(ENDPOINT)) return
  const stack = args.find((a): a is Error => a instanceof Error)?.stack ?? null
  queue.push({ level, message: message || '(empty)', detail: stack, url: location.href, at: Date.now() })
}

function send(beacon = false) {
  if (!queue.length) return
  const room = Math.max(0, MAX_PER_MINUTE - sentThisMinute)
  const batch = queue.splice(0, Math.min(50, room))
  if (!batch.length) return
  sentThisMinute += batch.length
  const body = JSON.stringify({ entries: batch.map(({ level, message, detail, url, at }) => ({ level, message, detail, url, at })) })
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
    return
  }
  fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {
    // offline: try again next time, if there's room
    if (queue.length + batch.length <= MAX_QUEUE) queue = [...batch, ...queue]
  })
}

export function installDevLogger() {
  if (installed) return
  installed = true
  const wrap = (name: keyof typeof original, level: Level) => {
    console[name] = (...args: unknown[]) => {
      original[name](...args)
      try { logToDev(level, args) } catch { /* never break the console */ }
    }
  }
  wrap('error', 'error')
  wrap('warn', 'warn')
  wrap('info', 'info')
  wrap('log', 'info')
  wrap('debug', 'debug')
  window.addEventListener('error', e => {
    // a resource that failed to load (an image, a script) has no message of its own
    const target = e.target as HTMLElement | null
    if (target && target !== (window as unknown) && 'src' in target) {
      logToDev('warn', [`Couldn’t load ${(target as HTMLImageElement).src || target.tagName}`])
      return
    }
    logToDev('error', [e.error instanceof Error ? e.error : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`])
  }, true)
  window.addEventListener('unhandledrejection', e => {
    logToDev('error', [e.reason instanceof Error ? e.reason : `Unhandled rejection: ${text(e.reason)}`])
  })
  setInterval(() => send(), EVERY_MS)
  setInterval(() => { sentThisMinute = 0 }, 60_000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(true) })
  logToDev('info', [`[app] opened ${navigator.userAgent.includes('Wayfarer') || (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() ? 'in the iPhone app' : 'in a browser'}`])
}
