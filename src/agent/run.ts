import type { Dispatch } from 'react'
import type { Action, ChatMessage, TripState } from '../state/tripStore'
import type { Place } from '../types'
import type { SharedTrip } from '../trip/types'
import type { Expense, ExpenseInput, GroupState } from '../money/types'
import { AGENT_TOOLS, MAX_ROUNDS, isToolName, type ToolCall, type ToolResult } from './tools'
import { tripCity } from '../data/cities'
import { fmtClock, haversineKm } from '../planner/geo'
import { scorePlace, shortlist } from '../planner/core'
import { getVideos, watchUrl, PLATFORM_NAME } from '../services/videos'
import { resolveCustomPlace } from '../planner/customPlaces'
import { api } from '../money/client'
import { netBalances } from '../money/engine'
import { currencyDigits, fmtMoney } from '../money/currency'
import { categoryForKind, guessCategory } from '../money/categories'
import { newId } from '../state/persistence'
import { errorText } from '../planner/remotePlanner'
import { estimateCosts } from '../planner/insights'

// The trip chatbot in the browser. The server relays to the model (server/agent.ts); every tool
// call it hands back runs here, through the app's own actions, as the signed-in traveller.
// A call runs only if it's on the allowlist (./tools) and its arguments pass that tool's schema;
// money and people tools wait for the traveller to tap Confirm.

export interface AgentHost {
  state: () => TripState                       // the latest state, after any dispatch has rendered
  dispatch: Dispatch<Action>
  trip: () => SharedTrip | null                // the group this trip is shared with, if any
  ensureGroup: () => Promise<string>           // shares the trip if it isn't yet
  confirm: (question: string, yes: string) => Promise<boolean>
}

interface Reply { state: unknown; text: string; calls: ToolCall[] }

// `before` is the chat as it was before this message.
export async function runAgent(message: string, before: ChatMessage[], host: AgentHost): Promise<string> {
  let reply = await post({
    message,
    context: contextOf(host.state(), host.trip()),
    history: before.filter(m => !m.id.startsWith('welcome-')).slice(-8).map(m => ({ role: m.role, text: m.text.slice(0, 2000) })),
  })
  for (let round = 1; reply.calls.length && round < MAX_ROUNDS; round++) {
    const results: ToolResult[] = []
    for (const call of reply.calls) results.push({ id: call.id, name: call.name, output: await runTool(call, host) })
    reply = await post({ state: reply.state, results })
  }
  return reply.text.trim() || (reply.calls.length ? 'That took too many steps. Try asking for one thing at a time.' : 'Done.')
}

async function post(body: unknown): Promise<Reply> {
  const res = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(await errorText(res))
  return res.json() as Promise<Reply>
}

// ── the tools ────────────────────────────────────────────────────────────────

export async function runTool(call: ToolCall, host: AgentHost): Promise<string> {
  if (!isToolName(call.name)) return `Error: “${call.name}” is not something you can do.`
  const tool = AGENT_TOOLS[call.name]
  const parsed = tool.args.safeParse(call.args ?? {})
  if (!parsed.success) return `Error: bad arguments for ${call.name}: ${parsed.error.issues.map(i => `${i.path.join('.') || 'arguments'} ${i.message}`).join('; ')}`
  const args = parsed.data as Record<string, any>
  try {
    if (tool.risk === 'confirm') {
      const ask = await question(call.name, args, host)
      if (typeof ask === 'string' && ask.startsWith('Error:')) return ask
      const [q, yes] = ask as [string, string]
      if (!await host.confirm(q, yes)) return 'The traveller declined, so nothing was done.'
    }
    return await TOOLS[call.name](args, host)
  } catch (err) {
    return `Error: ${messageOf(err)}`
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const settle = () => new Promise(r => setTimeout(r, 60)) // let the dispatch render, so state() is current

function placeOf(s: TripState, id: string): Place | undefined {
  return s.candidates[id]?.place ?? tripCity(s.brief)?.places.find(p => p.id === id)
}
const dayOfStop = (s: TripState, id: string) => s.days.find(d => d.stops.some(st => st.place.id === id))
const hasPlan = (s: TripState) => (s.phase === 'review' || s.phase === 'final') && s.days.length > 0
const lastAi = (before: TripState, after: TripState) =>
  after.messages.length > before.messages.length ? after.messages.slice(before.messages.length).filter(m => m.role === 'ai').map(m => m.text).join('\n') : ''

// a plan edit through the reducer, reported by what actually changed
async function edit(host: AgentHost, action: Action, check: (before: TripState, after: TripState) => string): Promise<string> {
  const before = host.state()
  if (!hasPlan(before)) return 'Error: there is no plan yet to change.'
  host.dispatch(action)
  await settle()
  return check(before, host.state())
}

const TOOLS: Record<keyof typeof AGENT_TOOLS, (a: Record<string, any>, host: AgentHost) => Promise<string>> = {
  async find_videos({ place_id }, host) {
    const s = host.state()
    const p = placeOf(s, place_id)
    if (!p) return `Error: no place with id ${place_id}.`
    const { videos } = await getVideos(p, tripCity(s.brief)?.name)
    if (!videos.length) return `No reels or videos found that name ${p.name}. They can still open its pin for links to search Instagram, TikTok and YouTube.`
    host.dispatch({ type: 'select-place', id: p.id }) // its card holds the feed
    return `${videos.length} clips of ${p.name} (its card is now open, with the feed):\n${videos.map(v => `- ${PLATFORM_NAME[v.platform]}${v.short ? ' Short' : ''}${v.by ? ` by ${v.by}` : ''}: “${v.title}” ${watchUrl(v)}`).join('\n')}`
  },

  async search_places({ query, kind, near_place_id }, host) {
    const s = host.state()
    const city = tripCity(s.brief)
    if (!city) return 'Error: the trip has no city yet.'
    if (!query && !kind && !near_place_id) return 'Error: give words to search for, a kind, or a place to search near.'
    const near = near_place_id ? placeOf(s, near_place_id) : undefined
    if (near_place_id && !near) return `Error: no place with id ${near_place_id}.`
    const words: string[] = String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2)
    const planned = new Set(s.days.flatMap(d => d.stops.map(x => x.place.id)))
    const hits = city.places
      .filter(p => !kind || p.kind === kind)
      .map(p => {
        const text = `${p.name} ${p.keywords?.join(' ') ?? ''} ${p.tags.join(' ')} ${p.blurb}`.toLowerCase()
        const matched = words.filter(w => text.includes(w)).length + words.filter(w => p.name.toLowerCase().includes(w)).length
        const km = near ? haversineKm(near.coord, p.coord) : 0
        return { p, matched, km, score: scorePlace(p, s.brief).score }
      })
      .filter(x => (!words.length || x.matched > 0) && (!near || (x.p.id !== near.id && x.km <= 2.5)))
      .sort((a, b) => b.matched - a.matched || (near ? a.km - b.km : 0) || b.score - a.score)
      .slice(0, 15)
    if (!hits.length) return `Nothing like that in the ${city.name} catalog${near ? ` within 2.5 km of ${near.name}` : ''}. For a real place you know of, use add_own_place.`
    return hits.map(({ p, km }) => `${placeLine(s, p)}${planned.has(p.id) ? ' | already in the plan' : ''}${near ? ` | ${km.toFixed(1)} km away` : ''}`).join('\n')
  },

  async money_summary(_, host) {
    const g = await groupState(host)
    if (typeof g === 'string') return g
    const net = netBalances(g.expenses, g.settlements)
    const name = nameOf(g)
    const shared = g.expenses.filter(e => !e.deletedAt && !e.privateTo)
    const total = shared.reduce((n, e) => n + e.baseAmount, 0)
    const recent = [...shared].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)
    return [
      `Group “${g.group.name}”, currency ${g.group.currency}. You are member ${g.me}.`,
      `People: ${g.members.filter(m => !m.left).map(m => `${name(m.id)} [${m.id}]${m.role === 'owner' ? ' (admin)' : ''}${m.joined ? '' : ' (invited, not joined yet)'}`).join(', ')}`,
      `Total shared spending: ${fmtMoney(total, g.group.currency)}${g.group.budget ? ` of a ${fmtMoney(g.group.budget, g.group.currency)} budget` : ''}.`,
      `Balances (positive = is owed): ${Object.entries(net).filter(([, n]) => n).map(([id, n]) => `${name(id)} ${fmtMoney(n, g.group.currency, { sign: true })}`).join(', ') || 'everyone is settled'}.`,
      recent.length ? `Recent: ${recent.map(e => `“${e.title}” ${fmtMoney(e.baseAmount, g.group.currency)} paid by ${payerNames(e, name)}`).join('; ')}` : 'No expenses yet.',
    ].join('\n')
  },

  add_stop: async ({ place_id, day }, host) => {
    const p = placeOf(host.state(), place_id)
    if (!p) return `Error: no place with id ${place_id}. For somewhere not in the catalog, use add_own_place.`
    if (dayOfStop(host.state(), place_id)) return `${p.name} is already on Day ${dayOfStop(host.state(), place_id)!.day}.`
    if (!host.state().days.some(d => d.day === day)) return `Error: there is no Day ${day}.`
    return edit(host, { type: 'add-stop', id: place_id, day }, (_, s) => {
      const st = s.days.find(d => d.day === day)?.stops.find(x => x.place.id === place_id)
      return st ? `Added ${p.name} to Day ${day}, ${fmtClock(st.arrive)}–${fmtClock(st.depart)}.` : `Error: couldn’t add ${p.name}.`
    })
  },

  remove_stop: async ({ place_id }, host) => {
    const d = dayOfStop(host.state(), place_id)
    if (!d) return `Error: ${place_id} isn’t in the plan.`
    const name = d.stops.find(x => x.place.id === place_id)!.place.name
    return edit(host, { type: 'remove-stop', id: place_id }, (_, s) =>
      dayOfStop(s, place_id) ? `Couldn’t remove ${name}: it’s the only stop on Day ${d.day}. Swap it with change_trip, or remove the whole day.` : `Removed ${name} from Day ${d.day}.`)
  },

  move_stop: async ({ place_id, to_day }, host) => {
    const d = dayOfStop(host.state(), place_id)
    if (!d) return `Error: ${place_id} isn’t in the plan.`
    if (!host.state().days.some(x => x.day === to_day)) return `Error: there is no Day ${to_day}.`
    const name = d.stops.find(x => x.place.id === place_id)!.place.name
    return edit(host, { type: 'move-stop', id: place_id, toDay: to_day }, (_, s) =>
      dayOfStop(s, place_id)?.day === to_day ? `Moved ${name} to Day ${to_day}.` : `Couldn’t move ${name}: Day ${d.day} needs at least one stop.`)
  },

  reorder_stop: async ({ place_id, direction }, host) => {
    if (!dayOfStop(host.state(), place_id)) return `Error: ${place_id} isn’t in the plan.`
    return edit(host, { type: 'shift-stop', id: place_id, dir: direction === 'earlier' ? -1 : 1 }, (_, s) => {
      const d = dayOfStop(s, place_id)!
      return `Day ${d.day} is now: ${d.stops.map(x => x.place.name).join(' → ')}.`
    })
  },

  tidy_day: async ({ day }, host) =>
    edit(host, { type: 'optimize-day', day }, (_, s) => {
      const d = s.days.find(x => x.day === day)
      return d ? `Day ${day} is now: ${d.stops.map(x => x.place.name).join(' → ')}.` : `Error: there is no Day ${day}.`
    }),

  fill_gap: async ({ day }, host) =>
    edit(host, { type: 'fill-gap', day }, (before, after) => after.thoughts.slice(before.thoughts.length).map(t => t.text).join(' ') || `Nothing changed on Day ${day}.`),

  choose_hotel: async ({ hotel_id }, host) => {
    const h = host.state().hotelScores.find(x => x.hotel.id === hotel_id)
    if (!h) return `Error: ${hotel_id} isn’t one of the scored hotels${host.state().hotelScores.length ? '' : ' (approve the plan to find hotels first)'}.`
    return edit(host, { type: 'choose-hotel', id: hotel_id }, () => `${h.hotel.name} is now the base ($${h.hotel.nightly} a night, ~${Math.round(h.avgCommute)} min to each day).`)
  },

  change_trip: async ({ instruction }, host) =>
    edit(host, { type: 'chat-edit', text: instruction }, (before, after) => lastAi(before, after) || 'Nothing changed.'),

  undo: async (_, host) =>
    edit(host, { type: 'undo' }, (before, after) => lastAi(before, after) || 'Nothing to undo.'),

  async add_own_place({ name, link, kind, day }, host) {
    if (!name && !link) return 'Error: give a name or a maps link.'
    const s = host.state()
    const { place, note } = await resolveCustomPlace({ name: name ?? undefined, link: link ?? undefined, kind: kind ?? undefined, day: day ?? undefined }, s.brief)
    host.dispatch({ type: 'add-custom-place', place, day: day ?? undefined, note })
    await settle()
    return `${lastAi(s, host.state())} (place id ${place.id})`
  },

  async log_expense(a, host) {
    const g = await groupState(host)
    if (typeof g === 'string') return g
    const e = expenseOf(a, g, host.state())
    if (typeof e === 'string') return e
    await api('POST', `/groups/${g.group.id}/expenses`, e)
    return `Logged “${e.title}”, ${fmtMoney(e.amount, e.currency)}.`
  },

  async invite_person({ email }, host) {
    const gid = await host.ensureGroup()
    await api('POST', `/groups/${gid}/members`, { email })
    return `Added ${email} to the group. If they have an account they can see the trip now; otherwise it’s theirs as soon as they sign up with that address.`
  },

  async remove_person({ member_id }, host) {
    const g = await groupState(host)
    if (typeof g === 'string') return g
    const who = g.members.find(m => m.id === member_id && !m.left)
    if (!who) return `Error: no member ${member_id} in the group.`
    await api('DELETE', `/groups/${g.group.id}/members/${encodeURIComponent(member_id)}`)
    return `Removed ${who.name} from the group.`
  },
}

// ── money ────────────────────────────────────────────────────────────────────

async function groupState(host: AgentHost): Promise<GroupState | string> {
  const gid = host.trip()?.groupId ?? host.state().brief.moneyGroupId
  if (!gid) return 'Error: this trip isn’t shared with a group yet, so there are no shared expenses. Inviting someone shares it.'
  return api<GroupState>('GET', `/groups/${gid}`)
}

const nameOf = (g: GroupState) => (id: string) => (id === g.me ? 'you' : g.members.find(m => m.id === id)?.name ?? 'someone')
const payerNames = (e: Expense, name: (id: string) => string) => e.payers.map(p => name(p.memberId)).join(' & ')

function expenseOf(a: Record<string, any>, g: GroupState, s: TripState): ExpenseInput | string {
  const active = new Set(g.members.filter(m => !m.left).map(m => m.id))
  const payer: string = a.paid_by ?? g.me
  const between: string[] = a.split_between ?? [...active]
  const unknown = [payer, ...between].find(id => !active.has(id))
  if (unknown) return `Error: ${unknown} isn’t a member id. Call money_summary for the ids.`
  const currency = g.group.currency
  const amount = Math.round(a.amount * 10 ** currencyDigits(currency))
  const place = a.place_id ? placeOf(s, a.place_id) : undefined
  const start = s.brief.startDate
  const date = start && a.day ? new Date(new Date(`${start}T00:00:00Z`).getTime() + (a.day - 1) * 86_400_000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
  return {
    id: newId(),
    title: a.title,
    amount,
    currency,
    fxRate: 1,
    category: place ? categoryForKind(place.kind) : guessCategory(a.title) ?? 'other',
    date,
    notes: '',
    payers: [{ memberId: payer, amount }],
    split: { method: 'equal', entries: [...new Set(between)].map(memberId => ({ memberId, value: 1 })) },
    private: false,
    placeId: place?.id ?? null,
    placeName: place?.name ?? null,
  }
}

// What the traveller is asked before a money or people tool runs: exactly what will happen.
async function question(name: string, a: Record<string, any>, host: AgentHost): Promise<[string, string] | string> {
  if (name === 'invite_person') {
    const shared = Boolean(host.trip()?.groupId ?? host.state().brief.moneyGroupId)
    return [`Add ${a.email} to ${shared ? 'the trip’s group' : 'this trip (it’ll be shared as a group)'}? They’ll see the plan, vote on places and split costs.`, 'Add them']
  }
  const g = await groupState(host)
  if (typeof g === 'string') return g
  const name_ = nameOf(g)
  if (name === 'remove_person') {
    const who = g.members.find(m => m.id === a.member_id && !m.left)
    if (!who) return `Error: no member ${a.member_id} in the group.`
    return [`Remove ${who.name} from the group? They’ll lose access to the trip.`, 'Remove']
  }
  const e = expenseOf(a, g, host.state())
  if (typeof e === 'string') return e
  const between = e.split.entries.map(x => name_(x.memberId))
  const everyone = between.length === g.members.filter(m => !m.left).length
  return [`Log “${e.title}”: ${fmtMoney(e.amount, e.currency)}, paid by ${name_(e.payers[0].memberId)}, split equally between ${everyone ? `everyone (${between.length})` : between.join(', ')}?`, 'Log it']
}

// ── what the model sees of the trip ──────────────────────────────────────────

// The same estimate the trip's dashboard shows, so the assistant and the dashboard agree.
function costLine(s: TripState, city: NonNullable<ReturnType<typeof tripCity>>): string {
  if (!s.days.length) return ''
  const c = estimateCosts(s.brief, s.days, city, s.hotel)
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  return [
    `Estimated cost for the whole trip, in USD (what the dashboard shows; ${s.days.length} night${s.days.length > 1 ? 's' : ''}, one per planned day): ${usd(c.total)} total, ${usd(c.perPerson)} per person, ${usd(c.perDay)} per day${c.budget ? `, against a ${usd(c.budget)} budget (${c.total <= c.budget ? `${usd(c.budget - c.total)} under` : `${usd(c.total - c.budget)} over`})` : ''}.`,
    ...c.lines.map(l => `  ${l.label}: ${usd(l.amount)} (${l.note})`),
  ].join('\n')
}

// A big city lists only its best matches here; search_places reaches the rest.
const OTHERS_SHOWN = 150

const placeLine = (s: TripState, p: Place) => `${p.id} | ${p.name} | ${p.kind} | ${'$'.repeat(p.price) || 'free'} | ${p.tags.join(',')} | best ${p.bestAt ?? 'any'} | ${p.blurb}${p.book ? ` | book ahead: ${p.book}` : ''}${p.custom ? ' | added by the traveller' : ''}${s.picks[p.id] === 'nope' ? ' | skipped earlier' : ''}`

export function contextOf(s: TripState, trip: SharedTrip | null): string {
  const city = tripCity(s.brief)
  if (!city) return 'No destination yet.'
  const b = s.brief
  const planned = new Set(s.days.flatMap(d => d.stops.map(x => x.place.id)))
  const line = (p: Place) => placeLine(s, p)
  const others = city.places.filter(p => !planned.has(p.id))
  const shown = shortlist(others, b, OTHERS_SHOWN)
  const out = [
    `City: ${city.name}. Stage: ${s.phase === 'final' ? 'planned, with a hotel' : 'plan drafted, no hotel chosen yet'}.`,
    `Trip: ${b.days ?? s.days.length} days, ${b.travelers ?? 2} travellers, vibe ${b.vibes.join(', ') || 'a bit of everything'}, ${b.budgetTier ?? 'comfort'} budget${b.budgetAmount ? ` ($${b.budgetAmount} total)` : ''}, ${b.pace ?? 'balanced'} pace${b.startDate ? `, starts ${b.startDate}` : ''}${b.tastes?.length ? `, likes ${b.tastes.join(', ')}` : ''}.`,
    trip ? `Shared with ${trip.people.length} people: ${trip.people.map(p => p.name).join(', ')}.` : 'Not shared with anyone yet.',
    '',
    'Plan:',
    ...s.days.flatMap(d => [
      `Day ${d.day} “${d.title}”:`,
      ...d.stops.map(st => `  ${fmtClock(st.arrive)}–${fmtClock(st.depart)} ${st.place.name} [${st.place.id}]${st.legIn ? ` (${st.legIn.minutes} min ${st.legIn.mode} in)` : ''}${st.bufferAfter >= 45 ? `, then ${st.bufferAfter} min free` : ''}`),
    ]),
    '',
    s.hotel ? `Hotel: ${s.hotel.hotel.name} [${s.hotel.hotel.id}], $${s.hotel.hotel.nightly}/night.` : 'Hotel: none chosen yet.',
    costLine(s, city),
    ...(s.hotelScores.length ? [`Scored hotels: ${s.hotelScores.map(h => `${h.hotel.name} [${h.hotel.id}] $${h.hotel.nightly}/night, ~${Math.round(h.avgCommute)} min to each day`).join('; ')}`] : []),
    '',
    'Places in the plan (id | name | kind | price | tags | best time | about):',
    ...city.places.filter(p => planned.has(p.id)).map(line),
    '',
    `Other places (not in the plan)${shown.length < others.length ? `, the best ${shown.length} of ${others.length} for this trip; search_places finds the rest` : ''}:`,
    ...shown.map(line),
  ]
  return out.join('\n').slice(0, 39_000)
}
