import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newId } from '../state/persistence'
import { ApiError, NetworkError, api, clearLocal, liveUrl, localKeys, readLocal, writeLocal } from './client'
import { applyOps, enqueue, nextToSend, requestFor, type Op } from './outbox'
import type { Account, ActivityItem, ExpenseInput, GroupState, GroupSummary, SettlementInput } from './types'

// What's cached on this device belongs to whoever was signed in. A session can end
// without a sign-out (a password changed elsewhere), so check on every sign-in: the next
// person must never see the last person's private expenses, or send their queued changes.
export function claimLocal(user: Account | null) {
  if (!user || readLocal<string | null>('owner', null) === user.id) return
  clearLocal()
  writeLocal('owner', user.id)
}

// ── who's signed in ───────────────────────────────────────────────────────────

export type AccountStatus = 'loading' | 'ready' | 'offline' | 'unavailable'

export function useAccount() {
  const [account, setAccount] = useState<Account | null>(() => readLocal('account', null))
  const [status, setStatus] = useState<AccountStatus>('loading')

  const load = useCallback(async () => {
    try {
      const { user } = await api<{ user: Account | null }>('GET', '/auth/me')
      claimLocal(user)
      setAccount(user)
      writeLocal('account', user)
      setStatus('ready')
    } catch (err) {
      setStatus(err instanceof ApiError && err.data.code === 'no-storage' ? 'unavailable' : 'offline')
    }
  }, [])
  useEffect(() => { load() }, [load])

  const signedIn = useCallback((user: Account) => {
    claimLocal(user)
    setAccount(user)
    writeLocal('account', user)
    setStatus('ready')
  }, [])

  const signOut = useCallback(async () => {
    await api('POST', '/auth/logout', {})
    clearLocal()
    setAccount(null)
  }, [])

  return { account, status, signedIn, signOut, retry: load }
}

export type AccountHandle = ReturnType<typeof useAccount>

// ── the list of groups ────────────────────────────────────────────────────────

export function useGroups(enabled: boolean) {
  const [groups, setGroups] = useState<GroupSummary[] | null>(() => (enabled ? readLocal('groups', null) : null))
  const refresh = useCallback(async () => {
    try {
      const { groups: list } = await api<{ groups: GroupSummary[] }>('GET', '/groups')
      setGroups(list)
      writeLocal('groups', list)
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    drainClosedGroups().finally(() => refresh().catch(() => {}))
  }, [enabled, refresh])
  return { groups, refresh }
}

// ── the offline queue ─────────────────────────────────────────────────────────

// The server said no, so retrying won't help. Network trouble, rate limits, an expired
// session and server errors are all worth another try later.
export const isRefusal = (err: unknown) => err instanceof ApiError && err.status < 500 && err.status !== 401 && err.status !== 429

const openGroups = new Set<string>()
let draining = false

// Queued changes for a group that isn't on screen still need to reach the server: someone
// may log a coffee offline, close the screen and never reopen that group.
export async function drainClosedGroups() {
  if (draining) return
  draining = true
  try {
    for (const key of localKeys('ops:')) {
      const groupId = key.slice('ops:'.length)
      if (openGroups.has(groupId)) continue
      for (;;) {
        const ops = readLocal<Op[]>(key, [])
        const op = nextToSend(ops)
        if (!op) break
        writeLocal(key, ops.map(o => (o.opId === op.opId ? { ...o, attempted: true } : o)))
        const [method, path, body] = requestFor(op, groupId)
        try {
          await api(method, path, body)
          const left = readLocal<Op[]>(key, []).filter(o => o.opId !== op.opId)
          writeLocal(key, left.length ? left : null)
        } catch (err) {
          if (!isRefusal(err)) return
          writeLocal(key, readLocal<Op[]>(key, []).map(o => (o.opId === op.opId ? { ...o, error: (err as Error).message } : o)))
        }
      }
    }
  } finally {
    draining = false
  }
}

// Changes on this device the server hasn't got yet, in any group.
export function unsentCount(): number {
  const ops = localKeys('ops:').reduce((n, key) => n + readLocal<Op[]>(key, []).filter(o => !o.error && !o.sent).length, 0)
  const votes = localKeys('votes:').reduce((n, key) => n + Object.keys(readLocal<Record<string, unknown>>(key, {})).length, 0)
  const notes = localKeys('notes:').reduce((n, key) => n + readLocal<unknown[]>(key, []).length, 0)
  return ops + votes + notes
}

// ── one group, live ───────────────────────────────────────────────────────────

export type LiveStatus = 'connecting' | 'live' | 'offline'
export type GroupStatus = 'loading' | 'ready' | 'gone' | 'signed-out'

const RETRY_MS = 15_000
const POLL_MS = 20_000

export function useGroup(groupId: string) {
  const [server, setServer] = useState<GroupState | null>(() => readLocal(`state:${groupId}`, null))
  const [ops, setOpsState] = useState<Op[]>(() => readLocal(`ops:${groupId}`, []))
  const [status, setStatus] = useState<GroupStatus>(server ? 'ready' : 'loading')
  const [live, setLive] = useState<LiveStatus>('connecting')
  const [incoming, setIncoming] = useState<ActivityItem[]>([])

  const opsRef = useRef(ops)
  const version = useRef(server?.group.version ?? 0)
  const lastSeq = useRef(server?.activity[0]?.seq ?? 0)
  const running = useRef<Promise<void> | null>(null)
  const stream = useRef<EventSource | null>(null)
  const stopped = useRef(false)

  const setOps = useCallback((next: Op[]) => {
    opsRef.current = next
    writeLocal(`ops:${groupId}`, next.length ? next : null)
    setOpsState(next)
  }, [groupId])

  const refresh = useCallback(async () => {
    // only what was already through when this fetch began is sure to be in its answer
    const through = new Set(opsRef.current.filter(o => o.sent).map(o => o.opId))
    try {
      const out = await api<GroupState | { unchanged: true }>('GET', `/groups/${groupId}${version.current ? `?since=${version.current}` : ''}`)
      // a stream that stayed up all along never fires another open event
      setLive(stream.current?.readyState === EventSource.OPEN ? 'live' : 'connecting')
      setStatus('ready')
      if (through.size) setOps(opsRef.current.filter(o => !through.has(o.opId)))
      if ('unchanged' in out) return
      // what other people did since we last looked, for the little "just now" toasts
      if (lastSeq.current) {
        const fresh = out.activity.filter(a => a.seq > lastSeq.current && a.actor !== out.me)
        if (fresh.length) setIncoming(i => [...i, ...fresh.slice(0, 3)])
      }
      lastSeq.current = out.activity[0]?.seq ?? lastSeq.current
      version.current = out.group.version
      setServer(out)
      writeLocal(`state:${groupId}`, out)
    } catch (err) {
      if (err instanceof NetworkError) { setLive('offline'); return }
      if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 404)) return
      // no access any more, so there's nothing left to keep checking on
      stopped.current = true
      stream.current?.close()
      if (err.status === 401) { setStatus('signed-out'); return }
      writeLocal(`state:${groupId}`, null)
      setStatus('gone')
    }
  }, [groupId, setOps])

  // Sends queued changes in order. Network trouble stops the run and keeps them for later.
  // A refusal marks just that one change: the person sees why, and the rest carry on.
  // Everyone asking while a run is going waits for the same run, which also picks up
  // anything queued in the meantime, so "after flush" really means after.
  const flush = useCallback((): Promise<void> => {
    if (running.current) return running.current
    const mark = (opId: string, patch: Partial<Op>) => setOps(opsRef.current.map(o => (o.opId === opId ? { ...o, ...patch } as Op : o)))
    const run = async () => {
      for (;;) {
        let changed = false
        let blocked = false
        for (;;) {
          const op = nextToSend(opsRef.current)
          if (!op) break
          mark(op.opId, { attempted: true })
          const [method, path, body] = requestFor(op, groupId)
          try {
            await api(method, path, body)
            mark(op.opId, { sent: true })
            changed = true
          } catch (err) {
            if (isRefusal(err)) { mark(op.opId, { error: (err as Error).message }); continue }
            if (err instanceof NetworkError) setLive('offline')
            if (err instanceof ApiError && err.status === 401) setStatus('signed-out')
            blocked = true
            break
          }
        }
        if (changed) await refresh()
        if (blocked || !nextToSend(opsRef.current)) return
      }
    }
    running.current = run().finally(() => { running.current = null })
    return running.current
  }, [groupId, refresh, setOps])

  const queue = useCallback((op: Op) => {
    setOps(enqueue(opsRef.current, op))
    return flush()
  }, [flush, setOps])

  // The stream only says "something changed"; fetching goes through the normal endpoint.
  // EventSource reconnects by itself. While it's down, polling keeps things moving, and
  // phones drop background connections, so coming back to the app always checks in.
  useEffect(() => {
    openGroups.add(groupId)
    const es = new EventSource(liveUrl(groupId))
    stream.current = es
    es.onopen = () => { setLive('live'); flush() }
    es.onmessage = e => {
      setLive('live')
      if (JSON.parse(e.data).version !== version.current) refresh()
    }
    es.onerror = () => setLive(l => (l === 'offline' ? l : 'connecting'))
    const poll = setInterval(() => { if (!stopped.current && es.readyState !== EventSource.OPEN) refresh() }, POLL_MS)
    const retry = setInterval(() => { if (!stopped.current && nextToSend(opsRef.current)) flush() }, RETRY_MS)
    const wake = () => { if (!stopped.current && document.visibilityState === 'visible') { refresh(); flush() } }
    const online = () => { if (!stopped.current) { refresh(); flush() } }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', online)
    refresh().then(flush)
    return () => {
      openGroups.delete(groupId)
      es.close()
      clearInterval(poll)
      clearInterval(retry)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', online)
    }
  }, [groupId, refresh, flush])

  const state = useMemo(() => (server ? applyOps(server, ops) : null), [server, ops])

  const actions = useMemo(() => ({
    createExpense: (input: ExpenseInput) => queue({ opId: newId(), kind: 'expense.create', input }),
    updateExpense: (input: ExpenseInput, baseRev: number) => queue({ opId: newId(), kind: 'expense.update', input, baseRev }),
    deleteExpense: (id: string, title: string) => queue({ opId: newId(), kind: 'expense.delete', id, title }),
    restoreExpense: (id: string, title: string) => queue({ opId: newId(), kind: 'expense.restore', id, title }),
    createSettlement: (input: SettlementInput) => queue({ opId: newId(), kind: 'settlement.create', input }),
    deleteSettlement: (id: string) => queue({ opId: newId(), kind: 'settlement.delete', id }),
    addComment: (expenseId: string, body: string) => queue({ opId: newId(), kind: 'comment.create', id: newId(), expenseId, body, createdAt: Date.now() }),
    dismissOp: (opId: string) => setOps(opsRef.current.filter(o => o.opId !== opId)),
    // these need the server's answer, so they don't queue
    call: async <T,>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> => {
      const out = await api<T>(method, `/groups/${groupId}${path}`, body, raw)
      await refresh()
      return out
    },
    flushNow: flush,
  }), [groupId, queue, setOps, refresh, flush])

  const clearIncoming = useCallback(() => setIncoming([]), [])
  const failed = ops.filter(o => o.error)
  const waiting = ops.filter(o => !o.error && !o.sent).length

  return { state, status, live, waiting, failed, incoming, clearIncoming, actions, refresh }
}

export type GroupHandle = ReturnType<typeof useGroup>

// ── exchange rates ────────────────────────────────────────────────────────────

export interface Rates { base: string; date: string; rates: Record<string, number>; stale: boolean; source: string }

// Kept on the device too, so logging a coffee on a plane still gets a sensible rate.
export function useRates(base: string) {
  const [rates, setRates] = useState<Rates | null>(() => readLocal(`rates:${base}`, null))
  useEffect(() => {
    let alive = true
    api<Rates>('GET', `/fx?base=${base}`).then(r => {
      if (!alive) return
      setRates(r)
      writeLocal(`rates:${base}`, r)
    }).catch(() => {})
    return () => { alive = false }
  }, [base])
  return rates
}

// 1 unit of `currency` in the group's currency, rounded enough to read and type.
export function rateTo(rates: Rates | null, currency: string): number | null {
  const r = rates?.rates[currency]
  return r ? Number((1 / r).toPrecision(6)) : null
}

export const todayLocal = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

