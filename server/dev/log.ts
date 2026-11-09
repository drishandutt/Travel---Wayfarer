import { inspect } from 'node:util'
import type { Db } from '../money/db'

// Every log line and error, kept for the dev tools. The server's own console is captured here
// (the lines still print as before), browsers send theirs to POST /api/money/dev/log, and both
// land in `dev_logs`. Lines wait in memory until the database is open, and a burst is cut
// short rather than allowed to swamp it.

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Source = 'server' | 'client'

export interface LogEntry {
  at: number
  level: Level
  source: Source
  message: string
  detail?: string | null
  userId?: string | null
  url?: string | null
  agent?: string | null
}

const MAX_MESSAGE = 2000
const MAX_DETAIL = 16_000
const MAX_PENDING = 5000
const FLUSH_MS = 2000
const KEEP_DAYS = 30
const KEEP_ROWS = 200_000

const pending: LogEntry[] = []
let dropped = 0
let db: Db | null = null
let flushing = false
let flushes = 0

// the console as it was, so writing a log line can never log itself
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s)

export function record(e: LogEntry) {
  if (pending.length >= MAX_PENDING) { dropped++; return }
  pending.push({ ...e, message: clip(e.message || '(empty)', MAX_MESSAGE), detail: e.detail ? clip(e.detail, MAX_DETAIL) : null })
}

// "[money] Can’t open the database: Error: …" → the first line is the message, the stack the detail
function fromArgs(args: unknown[]): { message: string; detail: string | null } {
  const parts = args.map(a => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : inspect(a, { depth: 4, breakLength: 160 })))
  const stacks = args.filter((a): a is Error => a instanceof Error).map(e => e.stack ?? '').filter(Boolean)
  return { message: parts.join(' '), detail: stacks.join('\n\n') || null }
}

let installed = false
export function captureServerConsole() {
  if (installed) return
  installed = true
  const wrap = (name: keyof typeof original, level: Level) => {
    console[name] = (...args: unknown[]) => {
      original[name](...args)
      try {
        const line = fromArgs(args)
        // Node's own "(node:123) ExperimentalWarning: …" comes through console.error
        record({ at: Date.now(), level: level === 'error' && /^\(node:\d+\) \w*Warning:/.test(line.message) ? 'warn' : level, source: 'server', ...line })
      } catch { /* never break logging */ }
    }
  }
  wrap('debug', 'debug')
  wrap('log', 'info')
  wrap('info', 'info')
  wrap('warn', 'warn')
  wrap('error', 'error')
  process.on('uncaughtException', err => {
    record({ at: Date.now(), level: 'error', source: 'server', message: `Uncaught: ${err.message}`, detail: err.stack ?? null })
    original.error('[uncaught]', err)
  })
  process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    record({ at: Date.now(), level: 'error', source: 'server', message: `Unhandled rejection: ${err.message}`, detail: err.stack ?? null })
    original.error('[unhandled rejection]', reason)
  })
  setInterval(() => { void flush() }, FLUSH_MS).unref()
}

// Called once the database is open. Lines from before that are written then.
export function attachLogDb(d: Db | null) {
  db = d
}

export async function flush() {
  if (!db || flushing || !pending.length) return
  flushing = true
  const batch = pending.splice(0, 500)
  try {
    if (dropped) {
      batch.push({ at: Date.now(), level: 'warn', source: 'server', message: `[dev] ${dropped} log lines were dropped in a burst` })
      dropped = 0
    }
    const values: string[] = []
    const params: (string | number | null)[] = []
    for (const e of batch) {
      values.push(`(?, ?, ?, ?, ?, ?, ?, ?)`)
      params.push(e.at, e.level, e.source, e.message, e.detail ?? null, e.userId ?? null, e.url ? clip(e.url, 500) : null, e.agent ? clip(e.agent, 300) : null)
    }
    await db.run(`INSERT INTO dev_logs (at, level, source, message, detail, user_id, url, agent) VALUES ${values.join(', ')}`, ...params)
    // now and then, forget the oldest
    if (++flushes % 300 === 1) {
      await db.run('DELETE FROM dev_logs WHERE at < ?', Date.now() - KEEP_DAYS * 86_400_000)
      await db.run('DELETE FROM dev_logs WHERE id <= (SELECT id FROM dev_logs ORDER BY id DESC OFFSET ? LIMIT 1)', KEEP_ROWS)
    }
  } catch (err) {
    // put them back for the next try, unless the database is refusing them outright
    if (pending.length < MAX_PENDING) pending.unshift(...batch.slice(0, MAX_PENDING - pending.length))
    original.warn('[dev] couldn’t save log lines:', (err as Error).message)
  } finally {
    flushing = false
  }
}
