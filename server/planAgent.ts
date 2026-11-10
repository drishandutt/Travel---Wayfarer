import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { City, DayPlan, Place, PlannerEvent, TripBrief } from '../src/types'
import { tripCity } from '../src/data/cities'
import { centroid, estimateTravel, fmtClock } from '../src/planner/geo'
import { buildDay, dayShape, shortlist } from '../src/planner/core'
import { resolveBudgetTier } from '../src/planner/intake'
import { tuningLines } from '../src/planner/sliders'
import { profileLine } from '../src/planner/profile'
import { sleep, type Picks } from '../src/planner/engine'
import { FALLBACK, MODEL, client, effortFor, textOf } from './claude'

// Claude plans; tools turn each decision into map events. Every tool takes a
// `narration` line, which becomes the live "thinking" the user watches.

const MAX_TURNS = 12

const narration = { type: 'string', description: 'One short first-person sentence for the user explaining this step, specific to their trip.' }

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'shortlist_places',
    description: 'Decide which catalog places make the trip. Every catalog id must appear in exactly one of keep or drop. Returns travel times between kept places.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['narration', 'keep', 'drop'],
      properties: {
        narration,
        keep: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string', description: 'Under 8 words, why it fits them.' } } } },
        drop: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'commit_day',
    description: 'Lock in one day: ordered stops (first to last) and a start time. The map draws the route. Returns the computed timeline with travel and free time. Commit days in order, once each.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['narration', 'day', 'title', 'start_time', 'stop_ids'],
      properties: {
        narration,
        day: { type: 'integer' },
        title: { type: 'string', description: 'Evocative 2-5 word name for the day, e.g. "Old Tokyo & lantern bars".' },
        start_time: { type: 'string', description: 'HH:MM, 24h.' },
        stop_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'finish_plan',
    description: 'Call once every day is committed, with a closing note for the user.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: ['narration'], properties: { narration } },
  },
]

const Shortlist = z.object({ narration: z.string(), keep: z.array(z.object({ id: z.string(), reason: z.string() })), drop: z.array(z.string()) })
const CommitDay = z.object({ narration: z.string(), day: z.number().int(), title: z.string(), start_time: z.string(), stop_ids: z.array(z.string()) })
const Finish = z.object({ narration: z.string() })

function system(city: City): string {
  return `You are Wayfarer's trip planner for ${city.name}. The traveller is watching a live map: each tool call you make animates on it, and your narration lines appear as your visible train of thought, so make them concrete and human ("Clustering the east side so Day 2 is all walkable"), never generic.

How to plan:
1. shortlist_places: keep roughly (days x stops-per-day) places, biased to their vibe, budget and group. Include food: each day should have somewhere to eat around midday and in the evening when the catalog allows.
2. commit_day for day 1, 2, ... in order. Each day should be one tight neighbourhood (use the travel times you get back), ordered by time of day: morning sights first, lunch spots mid-day, viewpoints at sunset, bars at night. Respect each place's best time. Use each place at most once.
3. If a committed timeline shows something badly off (huge idle gap, long hop), mention it honestly in the next narration and compensate in later days.
4. finish_plan.

Be decisive: do not ask the user questions, and do not write prose outside tool calls.`
}

// One line per place. "who" is its profile where someone who knows the place, or travellers'
// swipes, have said who it suits; the planner weighs it with the trip's own sliders.
function catalogLines(city: City): string {
  return city.places
    .map(p => {
      const who = profileLine(p)
      return `${p.id} | ${p.name} | ${p.kind} | ${p.tags.join(',')} | price ${p.price}/3 | ${p.minutes} min | best ${p.bestAt ?? 'any'} | fame ${p.rank?.toFixed(1) ?? '?'} | ${p.blurb}${who ? ` | who: ${who}` : ''}`
    })
    .join('\n')
}

function briefText(brief: TripBrief): string {
  const pace = dayShape(brief)
  return [
    `Days: ${brief.days ?? 3}`,
    `Travellers: ${brief.travelers ?? 2}`,
    `Vibe: ${brief.vibes.join(', ') || 'a bit of everything'}`,
    `Budget: ${brief.budgetAmount ? `$${brief.budgetAmount} total` : ''} (${resolveBudgetTier(brief)} tier)`,
    // the chat's sliders they moved; "fame" in the catalog is how well known each place is
    ...tuningLines(brief),
    `Pace: ${brief.pace ?? 'balanced'} (~${pace.perDay} stops/day, ${pace.buffer} min buffers, default start ${fmtClock(pace.start)})`,
  ].join('\n')
}

function neighbours(kept: Place[]): string {
  return kept
    .map(p => {
      const near = kept
        .filter(q => q !== p)
        .map(q => ({ q, t: estimateTravel(p.coord, q.coord) }))
        .sort((a, b) => a.t.minutes - b.t.minutes)
        .slice(0, 6)
        .map(({ q, t }) => `${q.id} ${t.minutes}m ${t.mode}`)
      return `${p.id}: ${near.join(', ')}`
    })
    .join('\n')
}

function timeline(plan: DayPlan): string {
  return plan.stops
    .map((s, i) => {
      const leg = s.legIn ? `  (${s.legIn.minutes} min ${s.legIn.mode})` : ''
      const gap = i < plan.stops.length - 1 && s.bufferAfter >= 45 ? `\n   ↳ ${s.bufferAfter} min free before next stop` : ''
      return `${fmtClock(s.arrive)}-${fmtClock(s.depart)} ${s.place.name}${leg}${gap}`
    })
    .join('\n')
}

function parseClock(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return undefined
  const v = Number(m[1]) * 60 + Number(m[2])
  return v >= 5 * 60 && v <= 14 * 60 ? v : undefined
}

export async function* planWithClaude(brief: TripBrief, signal: AbortSignal, picks?: Picks): AsyncGenerator<PlannerEvent> {
  const base = tripCity(brief)
  if (!base) throw new Error(`No map data for "${brief.destination}".`)
  // With swipe picks, Claude plans only what the traveller kept; otherwise a big city's best
  // matches for this brief, since nobody (Claude included) weighs 1,600 places well at once.
  // A re-plan (`fresh`) keeps what they liked and their own finds, never what they skipped, and
  // re-chooses the rest for the sliders as they are now.
  const exact = picks && !picks.fresh
  const keepIds = new Set([...(picks?.liked ?? []), ...(picks?.fresh ? brief.customPlaces?.map(p => p.id) ?? [] : [])])
  const open = base.places.filter(p => !picks?.rejected.includes(p.id))
  const city: City = { ...base, places: exact ? base.places.filter(p => picks.liked.includes(p.id)) : [...new Set([...shortlist(open, brief), ...open.filter(p => keepIds.has(p.id))])] }
  if (!city.places.length) throw new Error('No places were picked.')
  const totalDays = Math.min(brief.days ?? 3, city.places.length)
  const byId = new Map(city.places.map(p => [p.id, p]))

  // Open the map immediately so the user sees motion while Claude reads the catalog.
  yield { type: 'camera', center: city.center, zoom: city.zoom }
  yield { type: 'scan', center: city.center, radiusKm: 9 }
  yield { type: 'thought', text: `Reading ${city.places.length} places in ${city.name} against your brief…` }
  for (const p of [...city.places].sort((a, b) => a.coord[0] - b.coord[0])) {
    yield { type: 'candidate', place: p, verdict: 'consider' }
    await sleep(70 * Math.min(1, 40 / city.places.length), signal)
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: `Trip brief:\n${briefText(brief)}\n\n${exact ? 'The traveller hand-picked every place below by swiping: keep all of them in shortlist_places unless one truly cannot fit.\n\n' : keepIds.size ? `This is a re-plan after the traveller changed their settings. Keep the places they chose (${[...keepIds].join(', ')}) unless one truly cannot fit, and choose the rest afresh for the brief as it is now.\n\n` : ''}Catalog (id | name | kind | tags | price | visit length | best time | fame 0-1 | note | who it suits, when known):\n${catalogLines(city)}\n\nPlan all ${totalDays} days.`,
    },
  ]
  const committed = new Map<number, DayPlan>()
  const used = new Set<string>()

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create(
      {
        ...FALLBACK,
        model: MODEL,
        max_tokens: 16000,
        system: system(city),
        tools: TOOLS,
        output_config: { effort: effortFor('plan') },
        messages,
      },
      { signal },
    )
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to plan this trip.')

    const prose = textOf(response).trim()
    if (prose) yield { type: 'thought', text: prose }

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    if (!calls.length) break
    if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room mid-plan; try a shorter trip.')

    // Append the assistant turn unchanged (keeps thinking blocks valid across turns).
    messages.push({ role: 'assistant', content: response.content })
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    let finished = false

    for (const call of calls) {
      const fail = (msg: string) => results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: msg })

      if (call.name === 'shortlist_places') {
        const input = Shortlist.safeParse(call.input)
        if (!input.success) { fail('Invalid input.'); continue }
        yield { type: 'thought', text: input.data.narration }
        const kept: Place[] = []
        for (const k of input.data.keep) {
          const p = byId.get(k.id)
          if (!p) continue
          kept.push(p)
          yield { type: 'candidate', place: p, verdict: 'keep' }
          yield { type: 'thought', text: `✓ ${p.name} — ${k.reason}`, tone: 'decide' }
          await sleep(160, signal)
        }
        for (const id of input.data.drop) {
          const p = byId.get(id)
          if (p) yield { type: 'candidate', place: p, verdict: 'drop' }
        }
        const unknown = input.data.keep.map(k => k.id).filter(id => !byId.has(id))
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `Kept ${kept.length}.${unknown.length ? ` Unknown ids ignored: ${unknown.join(', ')}.` : ''}\nNearest neighbours among kept places (travel minutes, mode):\n${neighbours(kept)}`,
        })
      } else if (call.name === 'commit_day') {
        const input = CommitDay.safeParse(call.input)
        if (!input.success) { fail('Invalid input.'); continue }
        const { day, stop_ids, start_time, title, narration: line } = input.data
        if (day < 1 || day > totalDays) { fail(`Day must be 1-${totalDays}.`); continue }
        if (committed.has(day)) { fail(`Day ${day} is already committed.`); continue }
        const bad = stop_ids.filter(id => !byId.has(id) || used.has(id))
        if (bad.length) { fail(`Unknown or already-used ids: ${bad.join(', ')}.`); continue }
        if (!stop_ids.length) { fail('A day needs at least one stop.'); continue }

        const plan = buildDay(day, stop_ids.map(id => byId.get(id)!), brief, { keepOrder: true, start: parseClock(start_time), title })
        stop_ids.forEach(id => used.add(id))
        committed.set(day, plan)

        yield { type: 'camera', center: centroid(plan.stops.map(s => s.place.coord)), zoom: city.zoom + 1.5 }
        yield { type: 'thought', text: line }
        await sleep(600, signal)
        for (const leg of plan.legs) {
          yield { type: 'leg', leg, color: plan.color }
          await sleep(320, signal)
        }
        yield { type: 'day', plan }
        const moving = plan.legs.reduce((s, l) => s + l.minutes, 0)
        yield { type: 'thought', text: `Day ${day} locked: ${plan.stops.length} stops, ~${moving} min moving, done by ${fmtClock(plan.stops[plan.stops.length - 1].depart)}.`, tone: 'decide' }
        const left = totalDays - committed.size
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `Day ${day} timeline:\n${timeline(plan)}\n${left ? `${left} day(s) left.` : 'All days committed.'}` })
      } else if (call.name === 'finish_plan') {
        const input = Finish.safeParse(call.input)
        if (input.success) yield { type: 'thought', text: input.data.narration, tone: 'decide' }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Done.' })
        finished = true
      } else {
        fail(`Unknown tool ${call.name}.`)
      }
    }

    messages.push({ role: 'user', content: results })
    if (finished && committed.size) break
  }

  if (!committed.size) throw new Error('Claude did not commit any days.')
  if (committed.size < totalDays) yield { type: 'thought', text: `Planned ${committed.size} of ${totalDays} days.`, tone: 'warn' }
  yield { type: 'camera', center: city.center, zoom: city.zoom + 0.4 }
  yield { type: 'plan-ready' }
}
