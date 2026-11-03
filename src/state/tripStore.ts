import type { DayPlan, HotelScore, Leg, LngLat, Place, PlannerEvent, TripBrief } from '../types'
import { applyGapFill, bestInsertIndex, buildDeck, findGapFill, orderDay, rebuildDay, withHotel, type DeckCard } from '../planner/core'
import { cityById } from '../data/cities'
import { applyDeckPicks, applyEdit, planDeckRequest, type DeckRequest, type EditResult, type PlanSlice } from '../planner/edits'
import { centroid } from '../planner/geo'
import type { SharedPlan, VoteValue } from '../trip/types'

// Trip lifecycle:  intake → swipe → planning → review → hotels → final
export type Phase = 'intake' | 'swipe' | 'planning' | 'review' | 'hotels' | 'final'

export interface ChatMessage { id: string; role: 'user' | 'ai'; text: string }
export interface Thought { id: string; text: string; tone: 'info' | 'decide' | 'warn' }
export interface Candidate { place: Place; verdict: 'consider' | 'keep' | 'drop' }

export interface TripState {
  phase: Phase
  messages: ChatMessage[]
  brief: TripBrief
  thoughts: Thought[]
  candidates: Record<string, Candidate>
  legs: { leg: Leg; color: string }[]
  days: DayPlan[]
  hotelScores: HotelScore[]
  hotel?: HotelScore
  camera?: { center: LngLat; zoom: number; key: number }
  scan?: { center: LngLat; radiusKm: number; key: number }
  activeDay: number | null
  hoverPlace: string | null
  selectedPlace: string | null
  deck: DeckCard[]              // swipe cards, best match first
  deckIndex: number
  picks: Record<string, 'like' | 'nope'>
  tripId?: string               // set once the trip is saved to My trips
  history: { plan: PlanSlice; label: string }[]  // undo stack for plan edits
  flash?: { days: number[]; key: number }        // days that just changed, for a highlight
  // set while browsing a mini deck opened from chat over an existing plan
  deckMode?: { returnPhase: 'review' | 'final'; replaceId?: string; day?: number; label: string }
  sharedDeck: DeckCard[]        // the tiles the whole group votes on; `deck` may be a private mini deck
  // set when this trip belongs to a group. `phase` is where the plan has got to, which
  // can differ from the top-level phase while someone is voting over an existing plan.
  // base: the plan version this is built on. synced: this trip as the server has it, for telling a real change from an echo.
  shared?: { role: 'admin' | 'member'; phase: Phase; voting: boolean; base: number; synced?: string }
}

export type Action =
  | { type: 'chat'; role: 'user' | 'ai'; text: string }
  | { type: 'brief'; brief: TripBrief }
  | { type: 'phase'; phase: Phase }
  | { type: 'planner'; event: PlannerEvent }
  | { type: 'active-day'; day: number | null }
  | { type: 'hover-place'; id: string | null }
  | { type: 'choose-hotel'; id: string }
  | { type: 'replan' }
  | { type: 'select-place'; id: string | null }
  | { type: 'remove-stop'; id: string }
  | { type: 'move-stop'; id: string; toDay: number }
  | { type: 'shift-stop'; id: string; dir: -1 | 1 }
  | { type: 'add-stop'; id: string; day: number }
  | { type: 'optimize-day'; day: number }
  | { type: 'fill-gap'; day: number }
  | { type: 'restore'; trip: SavedTrip }
  | { type: 'saved'; id: string }
  | { type: 'start-deck' }
  | { type: 'swipe'; like: boolean }
  | { type: 'undo-swipe' }
  | { type: 'chat-edit'; text: string }
  | { type: 'undo' }
  | { type: 'finish-deck'; cancel?: boolean }
  | { type: 'shared-plan'; plan: SharedPlan; role: 'admin' | 'member'; version: number; votes: Record<string, VoteValue>; voting?: boolean }
  | { type: 'shared-role'; role: 'admin' | 'member' | null; version?: number }
  | { type: 'shared-synced'; json: string; version: number }
  | { type: 'reset' }

// What we persist: enough to redraw the map and itinerary exactly.
export interface SavedTrip {
  id: string
  name: string
  savedAt: number
  brief: TripBrief
  days: DayPlan[]
  hotel?: HotelScore
  hotelScores: HotelScore[]
  candidates: Record<string, Candidate>
  messages: ChatMessage[]
}

let seq = 0
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

export const initialState: TripState = {
  phase: 'intake',
  messages: [{
    id: 'hello',
    role: 'ai',
    text: 'Tell me about the trip: where, how long, who’s coming, and the budget.',
  }],
  brief: { vibes: [] },
  thoughts: [],
  candidates: {},
  legs: [],
  days: [],
  hotelScores: [],
  activeDay: null,
  hoverPlace: null,
  selectedPlace: null,
  deck: [],
  deckIndex: 0,
  picks: {},
  history: [],
  sharedDeck: [],
}

export const isMember = (s: TripState) => s.shared?.role === 'member'

function applyEvent(s: TripState, e: PlannerEvent): TripState {
  switch (e.type) {
    case 'thought':
      return { ...s, thoughts: [...s.thoughts, { id: uid(), text: e.text, tone: e.tone ?? 'info' }] }
    case 'camera':
      return { ...s, camera: { center: e.center, zoom: e.zoom, key: seq++ } }
    case 'scan':
      return { ...s, scan: { center: e.center, radiusKm: e.radiusKm, key: seq++ } }
    case 'candidate':
      return { ...s, candidates: { ...s.candidates, [e.place.id]: { place: e.place, verdict: e.verdict } } }
    case 'leg':
      return { ...s, legs: [...s.legs, { leg: e.leg, color: e.color }] }
    case 'day':
      return { ...s, days: [...s.days, e.plan] }
    case 'plan-ready':
      return { ...s, phase: 'review' }
    case 'hotel-candidate':
      return { ...s, hotelScores: [...s.hotelScores, e.score] }
    case 'hotel-pick':
      return { ...s, hotel: e.score, days: e.days, legs: legsOf(e.days), phase: 'final' }
    case 'error': {
      const thoughts = [...s.thoughts, { id: uid(), text: e.message, tone: 'warn' as const }]
      // Fall back to the last stable phase so the user is never stuck on a spinner.
      if (s.phase === 'planning') {
        return s.days.length
          ? { ...s, thoughts, phase: 'review' }
          : { ...s, thoughts, phase: 'intake', messages: [...s.messages, { id: uid(), role: 'ai', text: `Planning hit a snag: ${e.message}` }] }
      }
      if (s.phase === 'hotels') return { ...s, thoughts, phase: 'review' }
      return { ...s, thoughts }
    }
  }
}

const legsOf = (days: DayPlan[]) => days.flatMap(d => d.legs.map(leg => ({ leg, color: d.color })))

// Apply a structural edit to the itinerary, then re-time affected days, re-wire
// hotel legs and keep pin verdicts in sync with what is actually planned.
function editDays(s: TripState, touched: number[], mutate: (lists: Map<number, Place[]>) => void): TripState {
  const lists = new Map(s.days.map(d => [d.day, d.stops.map(x => x.place)]))
  mutate(lists)
  if ([...lists.values()].some(l => l.length === 0)) return s // a day must keep at least one stop
  const days = s.days.map(d => (touched.includes(d.day) ? rebuildDay(d, lists.get(d.day)!, s.brief, s.hotel?.hotel) : d))
  const used = new Set(days.flatMap(d => d.stops.map(x => x.place.id)))
  const candidates: Record<string, Candidate> = {}
  for (const [id, c] of Object.entries(s.candidates)) {
    candidates[id] = { ...c, verdict: used.has(id) ? 'keep' : c.verdict === 'keep' ? 'drop' : c.verdict }
  }
  for (const d of days) for (const st of d.stops) if (!candidates[st.place.id]) candidates[st.place.id] = { place: st.place, verdict: 'keep' }
  return { ...s, days, candidates, legs: legsOf(days) }
}

// "Welcome back" notes are added on every reopen; never persist or stack them.
export const isWelcome = (m: ChatMessage) => m.id.startsWith('welcome-') || m.text.startsWith('Welcome back — I’ve reopened')

const dayOf = (s: TripState, id: string) => s.days.find(d => d.stops.some(x => x.place.id === id))?.day

// ── live editing & undo ──────────────────────────────────────────────────────

const sliceOf = (s: TripState): PlanSlice => ({ brief: s.brief, days: s.days, hotel: s.hotel, hotelScores: s.hotelScores, candidates: s.candidates, picks: s.picks })

function restoreSlice(s: TripState, p: PlanSlice): TripState {
  return { ...s, ...p, legs: legsOf(p.days), selectedPlace: null }
}

const EDIT_HELP = 'I can change anything in the plan, live — try “swap Skytree for something cheaper”, “add a day”, “move teamLab to day 1”, “more food”, “no museums”, “start later”, “more relaxed”, “cheaper hotel”, “we’re 4 now”, or “undo”.'

function chatEdit(s: TripState, text: string): TripState {
  const say = (t: string, extra: Partial<TripState> = {}): TripState =>
    ({ ...s, ...extra, messages: [...(extra.messages ?? s.messages), { id: uid(), role: 'ai', text: t }] })
  if (/^\s*(undo|revert|go back|put it back|change it back)\b/i.test(text)) return undo(s)
  if (!s.days.length || !cityById(s.brief.destination)) return say(EDIT_HELP)

  // "not sure / show me options / let me try something" → browse a deck instead of deciding for them
  const browse = planDeckRequest(sliceOf(s), text)
  if (browse) {
    if (!browse.cards.length) return say('I’ve already used or ruled out everything I know that fits that. Try a different area or category — or “undo” to bring something back.')
    return openEditDeck(s, browse)
  }

  const res = applyEdit(sliceOf(s), text)
  if (!res.understood) {
    // not an edit, but it names a food, style or kind of place: show some to browse
    const loose = planDeckRequest(sliceOf(s), text, true)
    if (loose?.cards.length) return openEditDeck(s, loose)
    return say(`I didn’t catch a change there. ${EDIT_HELP}`)
  }
  if (!res.changes.length) return say(res.notes.join(' ') || EDIT_HELP)
  return commit(s, res)
}

// Apply an edit result: new plan, undo entry, highlight, camera, log and reply.
function commit(s: TripState, res: EditResult): TripState {
  const city = cityById(res.plan.brief.destination)!
  const moved = res.plan.brief.destination !== s.brief.destination
  const focus = res.recentre
    ? undefined
    : res.plan.days.filter(d => res.touchedDays.includes(d.day)).flatMap(d => d.stops.map(st => st.place.coord))
  const next: TripState = {
    ...restoreSlice(s, res.plan),
    history: [...s.history, { plan: sliceOf(s), label: res.changes[0] }].slice(-20),
    flash: { days: res.touchedDays, key: seq++ },
    activeDay: null,
    camera: focus?.length
      ? { center: centroid(focus), zoom: city.zoom + 1.2, key: seq++ }
      : { center: city.center, zoom: city.zoom + 0.4, key: seq++ },
    thoughts: [...s.thoughts, ...res.changes.map(t => ({ id: uid(), text: t, tone: 'decide' as const }))],
    ...(moved ? { deck: [], deckIndex: 0, sharedDeck: [] } : {}),
  }
  const lines = ['Done:', ...res.changes.map(c => `• ${c}`)]
  if (res.notes.length) lines.push('', `Heads up: ${res.notes.join(' ')}`)
  const reply = lines.join('\n')
  return { ...next, messages: [...next.messages, { id: uid(), role: 'ai', text: reply }] }
}

// A mini swipe deck over the live plan: routes stay on the map, nothing changes
// until the traveller finishes, and finishing returns to where they were.
function openEditDeck(s: TripState, req: DeckRequest): TripState {
  const city = cityById(s.brief.destination)!
  const first = city.places.find(p => p.id === req.cards[0].id)!
  // remember stated tastes on the trip; they lift matching places in every later pick
  const tastes = [...new Set([...(s.brief.tastes ?? []), ...req.tastes])]
  return {
    ...s,
    brief: req.tastes.length ? { ...s.brief, tastes } : s.brief,
    phase: 'swipe',
    deck: req.cards,
    deckIndex: 0,
    deckMode: { returnPhase: s.phase === 'final' ? 'final' : 'review', replaceId: req.replaceId, day: req.day, label: req.label },
    candidates: { ...s.candidates, [first.id]: { place: first, verdict: 'consider' } },
    selectedPlace: null,
    activeDay: null,
    messages: [...s.messages, { id: uid(), role: 'ai', text: req.intro }],
  }
}

function finishEditDeck(s: TripState, cancel: boolean): TripState {
  const mode = s.deckMode
  if (!mode) return s
  const liked = cancel ? [] : s.deck.filter(c => s.picks[c.id] === 'like').map(c => c.id)
  // tidy away deck pins that never made it into the plan
  const planned = new Set(s.days.flatMap(d => d.stops.map(st => st.place.id)))
  const candidates = { ...s.candidates }
  for (const c of s.deck) if (!planned.has(c.id) && (cancel || candidates[c.id]?.verdict !== 'drop')) delete candidates[c.id]
  const picks = { ...s.picks }
  if (cancel) for (const c of s.deck) delete picks[c.id]
  const base: TripState = { ...s, phase: mode.returnPhase, deck: [], deckIndex: 0, deckMode: undefined, candidates, picks }
  if (!liked.length) {
    const kept = mode.replaceId ? ` I kept ${cityById(s.brief.destination)?.places.find(p => p.id === mode.replaceId)?.name ?? 'your stop'}.` : ''
    return { ...base, messages: [...base.messages, { id: uid(), role: 'ai', text: `${cancel ? 'Cancelled' : 'Nothing kept'} — your plan is unchanged.${kept}` }] }
  }
  return commit(base, applyDeckPicks(sliceOf(base), liked, mode.replaceId, mode.day))
}

function undo(s: TripState): TripState {
  const last = s.history[s.history.length - 1]
  if (!last) return { ...s, messages: [...s.messages, { id: uid(), role: 'ai', text: 'Nothing to undo yet.' }] }
  const city = cityById(last.plan.brief.destination)
  return {
    ...restoreSlice(s, last.plan),
    history: s.history.slice(0, -1),
    flash: { days: last.plan.days.map(d => d.day), key: seq++ },
    camera: city && last.plan.brief.destination !== s.brief.destination ? { center: city.center, zoom: city.zoom + 0.4, key: seq++ } : s.camera,
    thoughts: [...s.thoughts, { id: uid(), text: `Undid: ${last.label}`, tone: 'info' }],
    messages: [...s.messages, { id: uid(), role: 'ai', text: `Undid: ${last.label}.` }],
  }
}

// Manual edits (pin cards, itinerary buttons) share the undo stack with chat edits.
const UNDOABLE: Partial<Record<Action['type'], string>> = {
  'remove-stop': 'removed a stop',
  'move-stop': 'moved a stop',
  'shift-stop': 'reordered a stop',
  'add-stop': 'added a stop',
  'optimize-day': 'tidied a route',
  'fill-gap': 'filled a gap',
  'choose-hotel': 'changed the hotel',
}

// Normal users can look around and vote; the plan itself is the admin's to change. The server
// refuses their edits anyway; this keeps the screen from pretending one happened.
const ADMIN_ONLY = new Set<Action['type']>([
  'chat', 'brief', 'phase', 'planner', 'choose-hotel', 'replan', 'remove-stop', 'move-stop', 'shift-stop', 'add-stop',
  'optimize-day', 'fill-gap', 'saved', 'start-deck', 'chat-edit', 'undo', 'finish-deck',
])

// What the group gets to see of this trip.
export function snapshotOf(s: TripState): SharedPlan {
  return {
    // a private mini deck over the plan isn't the group's business
    phase: s.deckMode ? s.deckMode.returnPhase : s.phase,
    brief: s.brief,
    deck: s.sharedDeck,
    days: s.days,
    hotel: s.hotel,
    hotelScores: s.hotelScores,
    candidates: s.candidates,
    messages: s.messages.filter(m => !isWelcome(m)).slice(-60).map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, 5000) })),
    thoughts: s.thoughts.slice(-20),
  }
}

// A planner that was running in a tab that closed isn't coming back, so the admin carries on
// from what it had finished.
function resumable(p: SharedPlan): SharedPlan {
  if (p.phase !== 'planning' && p.phase !== 'hotels') return p
  return { ...p, phase: p.days.length ? 'review' : p.deck.length ? 'swipe' : 'intake' }
}

// The pins for a voting deck: what you've decided, and the card in front of you.
function deckPins(deck: DeckCard[], picks: Record<string, VoteValue>, nextId: string | undefined, destination?: string): Record<string, Candidate> {
  const city = cityById(destination)
  const out: Record<string, Candidate> = {}
  for (const c of deck) {
    const place = city?.places.find(p => p.id === c.id)
    if (place && picks[c.id]) out[c.id] = { place, verdict: picks[c.id] === 'like' ? 'keep' : 'drop' }
  }
  const place = city?.places.find(p => p.id === nextId)
  if (place) out[place.id] = { place, verdict: 'consider' }
  return out
}

function receivePlan(s: TripState, a: Extract<Action, { type: 'shared-plan' }>, p: SharedPlan): TripState {
  const city = cityById(p.brief.destination)
  const prev = s.shared
  // A deck opened because the admin is collecting votes closes when they move on. One a
  // person opened themselves over a finished plan stays open until they're done with it.
  const voting = a.voting ?? (p.phase === 'swipe' || Boolean(prev?.voting && prev.phase !== 'swipe'))
  const moved = !prev || p.brief.destination !== s.brief.destination
  // a place since dropped from the city's data can't be shown or voted on
  const tiles = p.deck.filter(c => city?.places.some(x => x.id === c.id))
  const base: TripState = {
    ...s,
    shared: { role: a.role, phase: p.phase, voting, base: a.version },
    brief: p.brief,
    days: p.days,
    hotel: p.hotel,
    hotelScores: p.hotelScores,
    legs: legsOf(p.days),
    messages: p.messages.length ? p.messages : s.messages,
    thoughts: p.thoughts,
    sharedDeck: tiles,
    history: a.role === 'member' ? [] : s.history,
    camera: moved && city ? { center: city.center, zoom: city.zoom + 0.4, key: seq++ } : s.camera,
  }
  if (!voting) return { ...base, phase: p.phase, candidates: p.candidates, deck: [], deckIndex: 0, picks: {} }
  // keep your place in a deck you're part-way through
  const sameDeck = s.phase === 'swipe' && s.sharedDeck.length === tiles.length && s.sharedDeck.every((c, i) => c.id === tiles[i].id)
  if (sameDeck) return { ...base, phase: 'swipe', deck: s.deck, deckIndex: s.deckIndex, picks: s.picks, candidates: s.candidates }
  // otherwise it's just what you haven't decided yet: a vote only changes when you mean it to
  const deck = tiles.filter(c => !a.votes[c.id])
  return { ...base, phase: 'swipe', deck, deckIndex: 0, picks: a.votes, candidates: deckPins(tiles, a.votes, deck[0]?.id, p.brief.destination) }
}

export function reducer(s: TripState, a: Action): TripState {
  if (isMember(s) && ADMIN_ONLY.has(a.type)) return s
  const next = baseReducer(s, a)
  const label = UNDOABLE[a.type]
  if (label && next !== s && (next.days !== s.days || next.hotel !== s.hotel) && (s.phase === 'review' || s.phase === 'final')) {
    return { ...next, history: [...s.history, { plan: sliceOf(s), label }].slice(-20) }
  }
  return next
}

function baseReducer(s: TripState, a: Action): TripState {
  switch (a.type) {
    case 'chat':
      return { ...s, messages: [...s.messages, { id: uid(), role: a.role, text: a.text }] }
    case 'brief':
      return { ...s, brief: a.brief }
    case 'phase':
      return { ...s, phase: a.phase }
    case 'planner':
      return applyEvent(s, a.event)
    case 'active-day':
      return { ...s, activeDay: a.day }
    case 'hover-place':
      return { ...s, hoverPlace: a.id }
    case 'choose-hotel': {
      const score = s.hotelScores.find(h => h.hotel.id === a.id)
      if (!score) return s
      const days = withHotel(score.hotel, s.days)
      return { ...s, hotel: score, days, legs: legsOf(days) }
    }
    case 'replan':
      return { ...s, phase: 'intake', thoughts: [], candidates: {}, legs: [], days: [], hotelScores: [], hotel: undefined, activeDay: null, selectedPlace: null, tripId: undefined, deck: [], deckIndex: 0, picks: {}, history: [], deckMode: undefined, sharedDeck: [] }
    case 'select-place':
      return { ...s, selectedPlace: a.id }
    case 'remove-stop': {
      const day = dayOf(s, a.id)
      if (day === undefined) return s
      return editDays(s, [day], l => l.set(day, l.get(day)!.filter(p => p.id !== a.id)))
    }
    case 'move-stop': {
      const from = dayOf(s, a.id)
      if (from === undefined || from === a.toDay) return s
      return editDays(s, [from, a.toDay], l => {
        const place = l.get(from)!.find(p => p.id === a.id)!
        l.set(from, l.get(from)!.filter(p => p.id !== a.id))
        const target = [...(l.get(a.toDay) ?? [])]
        target.splice(bestInsertIndex(target, place), 0, place)
        l.set(a.toDay, target)
      })
    }
    case 'shift-stop': {
      const day = dayOf(s, a.id)
      if (day === undefined) return s
      return editDays(s, [day], l => {
        const list = [...l.get(day)!]
        const i = list.findIndex(p => p.id === a.id)
        const j = i + a.dir
        if (j < 0 || j >= list.length) return
        ;[list[i], list[j]] = [list[j], list[i]]
        l.set(day, list)
      })
    }
    case 'add-stop': {
      const place = s.candidates[a.id]?.place ?? cityById(s.brief.destination)?.places.find(p => p.id === a.id)
      if (!place || dayOf(s, a.id) !== undefined) return s
      return editDays(s, [a.day], l => {
        const target = [...(l.get(a.day) ?? [])]
        target.splice(bestInsertIndex(target, place), 0, place)
        l.set(a.day, target)
      })
    }
    case 'optimize-day':
      return editDays(s, [a.day], l => l.set(a.day, orderDay(l.get(a.day)!)))
    case 'fill-gap': {
      const day = s.days.find(d => d.day === a.day)
      const city = cityById(s.brief.destination)
      if (!day || !city) return s
      const used = new Set(s.days.flatMap(d => d.stops.map(x => x.place.id)))
      const fill = findGapFill(day, city.places.filter(p => !used.has(p.id)), s.brief, 45, 9) // asked for explicitly: look further afield
      if (!fill) {
        return { ...s, thoughts: [...s.thoughts, { id: uid(), text: `Nothing nearby fits that gap on Day ${a.day} — enjoy the free time.`, tone: 'info' }] }
      }
      const days = s.days.map(d => (d.day === a.day ? applyGapFill(d, fill, s.brief, s.hotel?.hotel) : d))
      return {
        ...s,
        days,
        legs: legsOf(days),
        candidates: { ...s.candidates, [fill.place.id]: { place: fill.place, verdict: 'keep' } },
        thoughts: [...s.thoughts, { id: uid(), text: `Filled Day ${a.day}'s gap with ${fill.place.name}.`, tone: 'decide' }],
      }
    }
    case 'restore': {
      const t = a.trip
      const city = cityById(t.brief.destination)
      // Saved trips hold copies of places; refresh them from today's city data so
      // details added since (booking notes, new blurbs) show up on old trips too.
      const fresh = <P extends { id: string }>(p: P): P => (city?.places.find(x => x.id === p.id) as P | undefined) ?? p
      const days = t.days.map(d => ({ ...d, stops: d.stops.map(st => ({ ...st, place: fresh(st.place) })) }))
      const candidates = Object.fromEntries(Object.entries(t.candidates).map(([id, c]) => [id, { ...c, place: fresh(c.place) }]))
      return {
        ...initialState,
        phase: t.hotel ? 'final' : 'review',
        brief: t.brief,
        days,
        hotel: t.hotel,
        hotelScores: t.hotelScores,
        candidates,
        legs: legsOf(days),
        messages: [...t.messages.filter(m => !isWelcome(m)), { id: `welcome-${uid()}`, role: 'ai', text: `Welcome back — I’ve reopened “${t.name}”. Edit anything on the map or in the itinerary.` }],
        camera: city ? { center: city.center, zoom: city.zoom + 0.4, key: seq++ } : undefined,
        tripId: t.id,
      }
    }
    case 'saved':
      return { ...s, tripId: a.id }
    case 'chat-edit':
      return chatEdit(s, a.text)
    case 'undo':
      return undo(s)
    case 'finish-deck':
      return finishEditDeck(s, Boolean(a.cancel))
    case 'reset':
      return initialState
    case 'shared-role': {
      if (!a.role) return s.shared ? { ...s, shared: undefined } : s
      const version = a.version ?? 0
      if (s.shared?.role === a.role && s.shared.base === version) return s
      // no plan yet means a normal user has nothing to look at but the waiting screen, even if this browser kept a copy
      const from = a.role === 'member' ? initialState : s
      return { ...from, shared: { role: a.role, phase: from.phase, voting: false, base: version } }
    }
    case 'shared-synced':
      return s.shared ? { ...s, shared: { ...s.shared, base: a.version, synced: a.json } } : s
    case 'shared-plan': {
      const plan = a.role === 'admin' ? resumable(a.plan) : a.plan
      const next = receivePlan(s, a, plan)
      // recording what the server has stops it going straight back. A plan that was just
      // picked back up does need to go: the group is still waiting on the old one.
      return a.role === 'admin' && plan === a.plan ? { ...next, shared: { ...next.shared!, synced: JSON.stringify(snapshotOf(next)) } } : next
    }
    case 'start-deck': {
      const city = cityById(s.brief.destination)
      if (!city) return s
      const deck = buildDeck(city.places, s.brief)
      const first = city.places.find(p => p.id === deck[0]?.id)
      return {
        ...s,
        phase: 'swipe',
        sharedDeck: deck,
        deck,
        deckIndex: 0,
        deckMode: undefined,
        picks: {},
        candidates: first ? { [first.id]: { place: first, verdict: 'consider' } } : {},
        legs: [], days: [], thoughts: [], hotelScores: [], hotel: undefined, selectedPlace: null,
        camera: { center: city.center, zoom: city.zoom, key: seq++ },
      }
    }
    case 'swipe': {
      const card = s.deck[s.deckIndex]
      const city = cityById(s.brief.destination)
      if (!card || !city) return s
      const byId = (id?: string) => city.places.find(p => p.id === id)
      const place = byId(card.id)
      const next = byId(s.deck[s.deckIndex + 1]?.id)
      if (!place) return { ...s, deckIndex: s.deckIndex + 1 } // nothing to pin, so pass over it
      return {
        ...s,
        deckIndex: s.deckIndex + 1,
        picks: { ...s.picks, [card.id]: a.like ? 'like' : 'nope' },
        // decided pins settle (amber = keep, faded = skip); the next card's pin starts pulsing
        candidates: {
          ...s.candidates,
          [card.id]: { place, verdict: a.like ? 'keep' : 'drop' },
          ...(next ? { [next.id]: { place: next, verdict: 'consider' as const } } : {}),
        },
      }
    }
    case 'undo-swipe': {
      if (s.deckIndex === 0) return s
      const prev = s.deck[s.deckIndex - 1]
      const upcoming = s.deck[s.deckIndex]
      const picks = { ...s.picks }
      delete picks[prev.id]
      const candidates = { ...s.candidates }
      if (upcoming) delete candidates[upcoming.id]
      if (candidates[prev.id]) candidates[prev.id] = { ...candidates[prev.id], verdict: 'consider' }
      return { ...s, deckIndex: s.deckIndex - 1, picks, candidates }
    }
  }
}
