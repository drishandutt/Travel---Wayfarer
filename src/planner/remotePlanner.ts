import type { DayPlan, PlannerEvent, TripBrief } from '../types'
import type { PlannerEngine, Picks } from './engine'

// Streams PlannerEvents from the server, where Claude does the planning.
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
