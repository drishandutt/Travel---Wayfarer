import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ApiError, NetworkError, api, liveUrl, readLocal, writeLocal } from '../money/client'
import { isRefusal } from '../money/hooks'
import { tripSummaryOf } from '../money/util'
import type { TripSummary } from '../money/types'
import { newId } from '../state/persistence'
import { snapshotOf, type Action, type TripState } from '../state/tripStore'
import { myVotes } from './votes'
import type { PlaceVote, SharedPlan, SharedTrip, TripNote, VoteValue } from './types'

// Keeps this browser and the group's shared trip in step. The admin's changes are published
// as they happen; everyone else receives them, and their votes and messages go the other way.
// The stream only says "something changed": fetching goes through the normal endpoint, so
// every read passes the same permission checks.

export type TripLive = 'connecting' | 'live' | 'offline'

const PUBLISH_EVERY_MS = 1000
const RETRY_MS = 8000
const POLL_MS = 20_000
const MAX_VOTE_TRIES = 20

const PHASE_NEWS: Partial<Record<string, (admin: string) => string>> = {
  swipe: admin => `${admin} opened the places: time to vote`,
  planning: admin => `${admin} is mapping the trip`,
  review: () => 'The plan is ready to look at',
  final: () => 'The plan is final, base camp included',
}

type VoteQueue = Record<string, VoteValue | null>
type Callbacks = { gone: () => void; signedOut: () => void; news: (text: string) => void }

interface Screen {
  dispatch: Dispatch<Action>
  on: { current: Callbacks }
  setTrip: (trip: SharedTrip | null) => void
  setLive: Dispatch<SetStateAction<TripLive>>
  setReady: (ready: boolean) => void
  setVotes: (votes: VoteQueue) => void
  setNotes: (notes: TripNote[]) => void
}

interface Outgoing { json: string; plan: SharedPlan; summary: TripSummary | null; base: number }

const roleOf = (t: SharedTrip) => (t.role === 'owner' ? 'admin' as const : 'member' as const)

// Opening a group that has no plan yet shouldn't tell everyone it has an empty one.
const isBlank = (p: SharedPlan) => !p.brief.destination && !p.messages.some(m => m.role === 'user') && !p.days.length && !p.deck.length

const overlayVotes = (votes: PlaceVote[], me: string, pending: VoteQueue): PlaceVote[] => {
  const kept = votes.filter(v => v.memberId !== me || !(v.placeId in pending))
  const mine = Object.entries(pending).filter(([, v]) => v).map(([placeId, v]) => ({ placeId, memberId: me, vote: v as VoteValue }))
  return [...kept, ...mine]
}

// One open trip. Each trip opened gets its own connection, and everything here checks it's
// still the one on screen, so an answer arriving after someone has moved on can't touch the
// trip they moved to.
function connect(groupId: string, ui: Screen) {
  const cached = readLocal<SharedTrip | null>(`trip:${groupId}`, null)
  let trip = cached
  let planVersion = cached?.plan ? cached.planVersion : -1
  let version = cached?.version ?? -1
  let votes = readLocal<VoteQueue>(`votes:${groupId}`, {})
  let notes = readLocal<TripNote[]>(`notes:${groupId}`, [])

  let alive = true
  let loaded = false              // the server has answered, so we know what we'd be changing
  let outgoing: Outgoing | null = null
  let published = -1              // the last version that came from this browser
  let publishing = false
  let publishes = 0
  let reload = false
  let warned = false
  let asked = 0
  let answered = 0
  let sendingVotes = false
  let votesAgain = false
  let sendingNotes = false
  const voteTries: Record<string, number> = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let wait: ReturnType<typeof setTimeout> | null = null

  const es = new EventSource(liveUrl(groupId))

  const apply = (plan: SharedPlan, t: SharedTrip, voting?: boolean) => {
    outgoing = null // anything waiting to go was made on top of an older plan
    ui.dispatch({ type: 'shared-plan', plan, role: roleOf(t), version: t.planVersion, votes: myVotes(overlayVotes(t.votes, t.me, votes), t.me), voting })
  }

  const stop = () => {
    alive = false
    outgoing = null
    es.close()
  }

  const load = async (): Promise<void> => {
    if (!alive) return
    if (publishing) { reload = true; return }
    const seq = ++asked
    const sentBefore = publishes
    try {
      const out = await api<SharedTrip>('GET', `/groups/${groupId}/trip?planSince=${planVersion}`)
      if (!alive || seq < answered) return
      answered = seq
      // it crossed with something this browser published: look again rather than mistake it for news
      if (publishing) { reload = true; return }
      if (publishes !== sentBefore) return load()

      const before = trip
      const next: SharedTrip = { ...out, plan: out.plan ?? before?.plan ?? null }
      trip = next
      version = out.version
      planVersion = out.planVersion
      writeLocal(`trip:${groupId}`, next)
      ui.setTrip(next)
      ui.setLive(es.readyState === EventSource.OPEN ? 'live' : 'connecting')

      // two fetches can overlap when a screen opens: the same version isn't a change
      const planMoved = Boolean(out.plan) && (!before?.plan || before.planVersion !== out.planVersion)
      const roleMoved = Boolean(before) && before?.role !== out.role // the admin left, and this is who takes over
      if (next.plan && (planMoved || roleMoved)) apply(next.plan, next)
      else if (!out.hasPlan) ui.dispatch({ type: 'shared-role', role: roleOf(out), version: out.planVersion })
      loaded = true
      ui.setReady(true)

      // what changed since we last looked, in a line or two
      if (before) {
        const admin = next.people.find(p => p.role === 'owner')?.name ?? 'The admin'
        const wasIn = new Set(before.people.filter(p => p.joined).map(p => p.id))
        for (const p of next.people) if (p.joined && !wasIn.has(p.id) && p.id !== next.me) ui.on.current.news(`${p.name} joined the trip`)
        if (next.role !== 'owner' && planMoved && out.plan && before.plan && out.plan.phase !== before.plan.phase) {
          const line = PHASE_NEWS[out.plan.phase]?.(admin)
          if (line) ui.on.current.news(line)
        } else if (next.role !== 'owner' && planMoved && out.plan && before.plan && (out.plan.phase === 'review' || out.plan.phase === 'final')) {
          ui.on.current.news(`${admin} updated the plan`)
        }
        if (roleMoved && next.role === 'owner') ui.on.current.news('You’re the admin of this trip now')
        const seen = new Set(before.notes.map(n => n.id))
        for (const n of next.notes.slice(-2)) {
          if (!seen.has(n.id) && n.memberId !== next.me) ui.on.current.news(`${next.people.find(p => p.id === n.memberId)?.name ?? 'Someone'}: ${n.body.slice(0, 80)}`)
        }
      }
    } catch (err) {
      if (!alive) return
      if (err instanceof NetworkError) { ui.setLive('offline'); return }
      if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 404)) return
      stop()
      if (err.status === 401) ui.on.current.signedOut()
      else {
        writeLocal(`trip:${groupId}`, null)
        ui.on.current.gone()
      }
    }
  }

  // Nothing goes out until the server has answered, and every copy says which version it was
  // made from, so a browser holding an old plan gets told rather than undoing newer changes.
  const send = async (): Promise<void> => {
    const sent = outgoing
    if (!sent || publishing || !loaded || trip?.role !== 'owner') return
    publishing = true
    publishes++
    try {
      const out = await api<{ planVersion: number }>('PUT', `/groups/${groupId}/plan`, { plan: sent.plan, summary: sent.summary, baseVersion: Math.max(sent.base, published) })
      planVersion = published = out.planVersion
      // keep what the group has now, or the next reload would bring back an older plan
      trip = { ...trip, plan: sent.plan, hasPlan: true, planVersion: out.planVersion }
      writeLocal(`trip:${groupId}`, trip)
      if (outgoing?.json === sent.json) outgoing = null
      if (alive) {
        ui.setTrip(trip)
        ui.setLive(l => (l === 'offline' ? 'connecting' : l))
        ui.dispatch({ type: 'shared-synced', json: sent.json, version: out.planVersion })
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        if (alive) ui.setLive('offline')
      } else if (err instanceof ApiError && err.status === 409) {
        // changed on another of the admin's devices: take the newer copy rather than undo it
        planVersion = -1
        loaded = false
        outgoing = null
        reload = true
        if (alive) ui.on.current.news('This trip was changed on another device. Showing the latest.')
      } else if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
        reload = true // no longer the admin, or the group has gone: a fresh look says which
      } else {
        console.warn('[trip] publish failed', err)
        if (isRefusal(err) && alive && !warned) {
          warned = true
          ui.on.current.news('Your latest changes couldn’t be shared with the group')
        }
      }
    } finally {
      publishing = false
    }
    if (reload) { reload = false; await load() }
    else if (alive) flushVotes() // votes on a deck that's only just landed
    else if (outgoing) await send()
  }

  // Called with each new state. The server's copy is recorded alongside the plan, so only a
  // change someone actually made goes out: never a reload, a switch of trips or an echo.
  const changed = (state: TripState) => {
    if (!alive) return
    if (!state.shared && loaded && trip) {
      if (trip.plan) apply(trip.plan, trip)
      else ui.dispatch({ type: 'shared-role', role: roleOf(trip), version: trip.planVersion })
      return
    }
    const plan = state.shared?.role === 'admin' ? snapshotOf(state) : null
    const json = plan && JSON.stringify(plan)
    if (!plan || !json || json === state.shared?.synced || isBlank(plan)) { outgoing = null; return }
    outgoing = { json, plan, summary: tripSummaryOf(state), base: state.shared?.base ?? 0 }
    // the group sees changes about a second later, however quickly the planner is working
    if (!timer) timer = setTimeout(() => { timer = null; send() }, PUBLISH_EVERY_MS)
  }

  // Sends from a screen that's since closed still finish, so they tidy up by what they sent:
  // the copy on disk may belong to a newer connection by then.
  const forgetVotes = (sent: [string, VoteValue | null][]) => {
    const without = (q: VoteQueue) => {
      const left = { ...q }
      for (const [placeId, vote] of sent) if (left[placeId] === vote) delete left[placeId]
      return left
    }
    votes = without(votes)
    const stored = without(readLocal<VoteQueue>(`votes:${groupId}`, {}))
    writeLocal(`votes:${groupId}`, Object.keys(stored).length ? stored : null)
    if (alive) ui.setVotes(votes)
  }

  const forgetNote = (id: string) => {
    notes = notes.filter(n => n.id !== id)
    const stored = readLocal<TripNote[]>(`notes:${groupId}`, []).filter(n => n.id !== id)
    writeLocal(`notes:${groupId}`, stored.length ? stored : null)
    if (alive) ui.setNotes(notes)
  }

  const flushVotes = async (): Promise<void> => {
    if (!alive) return
    if (sendingVotes) { votesAgain = true; return }
    const entries = Object.entries(votes).slice(0, 300)
    if (!entries.length) return
    // a place may not be up for a vote yet because the plan with this deck hasn't landed, so
    // give it a while. One that never becomes valid doesn't hold up the others for long.
    const gaveUp = (placeId: string) => (voteTries[placeId] = (voteTries[placeId] ?? 0) + 1) > MAX_VOTE_TRIES
    sendingVotes = true
    try {
      const out = await api<{ skipped: string[] }>('POST', `/groups/${groupId}/votes`, { votes: entries.map(([placeId, vote]) => ({ placeId, vote })) })
      const skipped = new Set(out.skipped)
      forgetVotes(entries.filter(([placeId]) => !skipped.has(placeId) || gaveUp(placeId)))
    } catch (err) {
      if (err instanceof NetworkError) { if (alive) ui.setLive('offline') }
      else if (isRefusal(err)) forgetVotes(entries.filter(([placeId]) => gaveUp(placeId)))
    } finally {
      sendingVotes = false
    }
    if (votesAgain) { votesAgain = false; await flushVotes() }
  }

  const flushNotes = async (): Promise<void> => {
    if (sendingNotes) return
    sendingNotes = true
    try {
      while (alive && notes.length) {
        const note = notes[0]
        try {
          await api('POST', `/groups/${groupId}/notes`, { id: note.id, body: note.body })
          forgetNote(note.id)
        } catch (err) {
          if (err instanceof NetworkError && alive) ui.setLive('offline')
          if (!isRefusal(err)) return // worth another go: a dropped connection, an expired session, a bad moment on the server
          forgetNote(note.id)
          if (alive) ui.on.current.news('A message couldn’t be sent to the group')
        }
      }
    } finally {
      sendingNotes = false
    }
  }

  const sync = () => {
    if (!alive) return
    flushVotes()
    flushNotes()
    send()
  }

  es.onopen = () => {
    if (!alive) return
    ui.setLive('live')
    sync()
  }
  es.onmessage = e => {
    if (!alive) return
    ui.setLive('live')
    const v = JSON.parse(e.data) as { version: number; planVersion: number }
    if ((v.version !== version || v.planVersion !== planVersion) && !wait) {
      wait = setTimeout(() => { wait = null; load() }, 200) // a burst of votes is one refresh
    }
  }
  es.onerror = () => { if (alive) ui.setLive(l => (l === 'offline' ? l : 'connecting')) }

  const poll = setInterval(() => { if (es.readyState !== EventSource.OPEN) load() }, POLL_MS)
  const retry = setInterval(() => {
    if (!loaded) load()
    sync()
  }, RETRY_MS)
  const wake = () => {
    if (document.visibilityState !== 'visible') return
    load()
    sync()
  }
  const online = () => {
    load()
    sync()
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', online)

  ui.setTrip(cached)
  ui.setVotes(votes)
  ui.setNotes(notes)
  ui.setReady(false)
  ui.setLive('connecting')
  // what we last saw, right away; the fetch below only sends the plan again if it changed
  if (cached?.plan) apply(cached.plan, cached)
  load().then(sync)

  return {
    changed,
    load,
    close() {
      if (alive) send() // the last second of changes still belongs to this trip, whatever's on screen next
      alive = false
      es.close()
      if (wait) clearTimeout(wait)
      if (timer) clearTimeout(timer)
      clearInterval(poll)
      clearInterval(retry)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', online)
    },
    vote(placeId: string, value: VoteValue | null) {
      if (!alive) return
      votes = { ...votes, [placeId]: value }
      writeLocal(`votes:${groupId}`, votes)
      ui.setVotes(votes)
      flushVotes()
    },
    postNote(body: string) {
      if (!alive || !trip?.me) return
      notes = [...notes, { id: newId(), memberId: trip.me, body, createdAt: Date.now(), pending: true }]
      writeLocal(`notes:${groupId}`, notes)
      ui.setNotes(notes)
      flushNotes()
    },
    // Normal users can open the tiles at any time; closing them goes back to wherever the plan is.
    setVoting(on: boolean) {
      if (alive && trip?.plan) apply(trip.plan, trip, on)
    },
  }
}

export function useSharedTrip(groupId: string | null, state: TripState, dispatch: Dispatch<Action>, on: Callbacks) {
  const [trip, setTrip] = useState<SharedTrip | null>(() => (groupId ? readLocal(`trip:${groupId}`, null) : null))
  const [live, setLive] = useState<TripLive>('connecting')
  const [ready, setReady] = useState(false)
  const [pendingVotes, setVotes] = useState<VoteQueue>(() => (groupId ? readLocal(`votes:${groupId}`, {}) : {}))
  const [pendingNotes, setNotes] = useState<TripNote[]>(() => (groupId ? readLocal(`notes:${groupId}`, []) : []))

  const session = useRef<ReturnType<typeof connect> | null>(null)
  const callbacks = useRef(on)
  callbacks.current = on

  useEffect(() => {
    if (!groupId) {
      setTrip(null)
      setReady(false)
      setVotes({})
      setNotes([])
      return
    }
    const opened = connect(groupId, { dispatch, on: callbacks, setTrip, setLive, setReady, setVotes, setNotes })
    session.current = opened
    return () => {
      session.current = null
      opened.close()
    }
  }, [groupId, dispatch])

  useEffect(() => {
    session.current?.changed(state)
  }, [groupId, ready, state.shared?.role, state.shared?.synced, state.shared?.base, state.phase, state.brief, state.days, state.hotel, state.hotelScores, state.candidates, state.messages, state.thoughts, state.sharedDeck])

  const vote = useCallback((placeId: string, value: VoteValue | null) => session.current?.vote(placeId, value), [])
  const postNote = useCallback((body: string) => session.current?.postNote(body), [])
  const setVoting = useCallback((open: boolean) => session.current?.setVoting(open), [])
  const refresh = useCallback(async () => { await session.current?.load() }, [])

  // what this person sees: the server's copy, plus anything of theirs still on its way
  const view = useMemo<SharedTrip | null>(() => {
    if (!trip || trip.groupId !== groupId) return null
    const sent = new Set(trip.notes.map(n => n.id))
    return {
      ...trip,
      votes: overlayVotes(trip.votes, trip.me, pendingVotes),
      notes: [...trip.notes, ...pendingNotes.filter(n => !sent.has(n.id))],
    }
  }, [trip, groupId, pendingVotes, pendingNotes])

  return { trip: view, live, ready, vote, postNote, setVoting, refresh }
}

export type SharedHandle = ReturnType<typeof useSharedTrip>
