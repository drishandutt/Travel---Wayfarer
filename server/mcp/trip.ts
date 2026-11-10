import type { Db } from '../money/db'
import type { UserRow } from '../money/auth'
import * as store from '../money/store'
import { HttpError, type GroupRow, type MemberRow } from '../money/store'
import { publish } from '../money/routes'
import type { SharedPlan } from '../../src/trip/types'
import { initialState, reducer, snapshotOf, type Action, type TripState } from '../../src/state/tripStore'
import { cityById, tripCity } from '../../src/data/cities'
import { tripSummaryOf } from '../../src/money/util'
import type { City, Place } from '../../src/types'

// One MCP session's view of a trip. A session works on one trip at a time, chosen by the
// person (`choose_trip`). Changes to the plan run through the app's own reducer, the same
// actions as its buttons and chat, and are published as the next version of the shared plan,
// so the admin's screen and everyone else's update live. The session keeps its own copy for
// undo, and starts again from the server's copy whenever someone else changed the plan.

export class ToolError extends Error {}

export interface Session {
  user: UserRow
  clientName: string
  tripId?: string
  state?: TripState
  stateVersion?: number
}

export interface Loaded { group: GroupRow; me: MemberRow; plan: SharedPlan | null }

export async function loadTrip(db: Db, s: Session): Promise<Loaded> {
  if (!s.tripId) throw new ToolError('No trip chosen yet. Call list_trips, ask the person which trip they mean, then call choose_trip.')
  try {
    const { group, me } = await store.requireSeat(db, s.tripId, s.user.id)
    return { group, me, plan: group.plan ? JSON.parse(group.plan) as SharedPlan : null }
  } catch (err) {
    if (err instanceof HttpError) { s.tripId = undefined; throw new ToolError('That trip isn’t available to you any more. Call list_trips again.') }
    throw err
  }
}

// The trip as the app's state, from the shared plan (or this session's copy, if it's current).
export function stateOf(s: Session, t: Loaded): TripState {
  if (!t.plan) throw new ToolError('This trip has no plan yet. It gets one once its admin has picked places in the app, or make a new trip with create_trip.')
  if (s.state && s.stateVersion === t.group.plan_version && s.tripId === t.group.id) return s.state
  if (!cityById(t.plan.brief.destination)) throw new ToolError(`The trip’s city (${t.plan.brief.destination}) isn’t loaded on the server right now. Try again in a minute.`)
  const st = reducer(initialState, { type: 'shared-plan', plan: t.plan, role: t.me.role === 'owner' ? 'admin' : 'member', version: t.group.plan_version, votes: {} })
  s.state = st
  s.stateVersion = t.group.plan_version
  return st
}

export const cityOf = (st: TripState): City => {
  const c = tripCity(st.brief)
  if (!c) throw new ToolError('The trip has no city.')
  return c
}

export const hasItinerary = (st: TripState) => (st.phase === 'review' || st.phase === 'final') && st.days.length > 0

export function placeOf(st: TripState, id: string): Place | undefined {
  return st.candidates[id]?.place ?? tripCity(st.brief)?.places.find(p => p.id === id)
}

// The AI's lines the app would have shown for a change.
export const said = (before: TripState, after: TripState) =>
  after.messages.length > before.messages.length ? after.messages.slice(before.messages.length).filter(m => m.role === 'ai').map(m => m.text).join('\n') : ''

// Runs actions on the trip and publishes the result. `check` turns before/after into the
// answer for the model; nothing is published if nothing changed. One retry if someone else
// published in between.
export async function change(db: Db, s: Session, actions: Action[], check: (before: TripState, after: TripState) => string, o: { needItinerary?: boolean } = {}): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await loadTrip(db, s)
    if (t.me.role !== 'owner') throw new ToolError(`Only the trip’s admin can change the plan. ${s.user.name}, you can still post in the trip chat (post_note), log expenses and look at everything.`)
    const before = stateOf(s, t)
    if (o.needItinerary !== false && !hasItinerary(before)) throw new ToolError('This trip has no itinerary yet to change.')
    let after = before
    for (const a of actions) after = reducer(after, a)
    const plan = snapshotOf(after)
    const answer = check(before, after)
    if (JSON.stringify(plan) === JSON.stringify(snapshotOf(before))) return answer
    try {
      const version = await store.publishPlan(db, t.group, t.me, { plan, summary: tripSummaryOf(after), baseVersion: t.group.plan_version })
      await publish(db, t.group.id)
      s.state = { ...after, shared: after.shared ? { ...after.shared, base: version } : after.shared }
      s.stateVersion = version
      return answer
    } catch (err) {
      if (err instanceof HttpError && err.status === 409 && attempt === 0) { s.state = undefined; continue }
      throw err
    }
  }
  throw new ToolError('The plan kept changing while this was being saved. Try again.')
}
