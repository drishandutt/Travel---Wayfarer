import type { DayPlan, PlannerEvent, TripBrief } from '../types'
import type { PlannerEngine, Picks } from './engine'

// Streams PlannerEvents from the server, where a model (Claude or OpenAI) does the planning.
// Same interface as MockPlanner, so the UI cannot tell them apart.
export class RemotePlanner implements PlannerEngine {
  planItinerary(brief: TripBrief, signal: AbortSignal, picks?: Picks) {
    return sse('/api/plan', { brief, picks }, signal)
  }

  findHotels(brief: TripBrief, days: DayPlan[], signal: AbortSignal) {
    return sse('/api/hotels', { brief, days }, signal)
  }
}

async function* sse(url: string, body: unknown, signal: AbortSignal): AsyncGenerator<PlannerEvent> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    yield { type: 'error', message: await errorText(res) }
    return
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let cut: number
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
      if (data) yield JSON.parse(data) as PlannerEvent
    }
  }
}

export async function errorText(res: Response): Promise<string> {
  try {
    const j = await res.json()
    return j.error ?? `Server error ${res.status}`
  } catch {
    return `Server error ${res.status}`
  }
}

// The model planner, with the offline one behind it: if the server can't plan (no credits left,
// too busy, unreachable) before it has drawn anything that counts, the offline planner takes over,
// with a plain line in the thinking log rather than the provider's error.
export class FallbackPlanner implements PlannerEngine {
  constructor(private remote: PlannerEngine, private offline: PlannerEngine) {}

  planItinerary(brief: TripBrief, signal: AbortSignal, picks?: Picks) {
    return this.guard(s => this.remote.planItinerary(brief, s, picks), s => this.offline.planItinerary(brief, s, picks), 'day', signal)
  }

  findHotels(brief: TripBrief, days: DayPlan[], signal: AbortSignal) {
    return this.guard(s => this.remote.findHotels(brief, days, s), s => this.offline.findHotels(brief, days, s), 'hotel-pick', signal)
  }

  private async *guard(first: (s: AbortSignal) => AsyncGenerator<PlannerEvent>, second: (s: AbortSignal) => AsyncGenerator<PlannerEvent>, counts: PlannerEvent['type'], signal: AbortSignal): AsyncGenerator<PlannerEvent> {
    let started = false
    try {
      for await (const e of first(signal)) {
        if (e.type === 'error' && !started) {
          console.warn('[planner] the model planner failed, planning offline:', e.message)
          yield { type: 'thought', text: 'The planner is busy right now, so I’m mapping this one myself.', tone: 'warn' }
          yield* second(signal)
          return
        }
        if (e.type === counts) started = true
        yield e
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || started) throw err
      console.warn('[planner] the model planner failed, planning offline:', (err as Error).message)
      yield { type: 'thought', text: 'The planner is busy right now, so I’m mapping this one myself.', tone: 'warn' }
      yield* second(signal)
    }
  }
}
