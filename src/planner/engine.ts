import type { DayPlan, PlannerEvent, TripBrief } from '../types'

// The seam between UI and "brain". Today: MockPlanner (local heuristics + seed
// data). Next: RemotePlanner that opens an SSE stream to /api/plan, where a
// Claude agent calls places/routing/hotel tools and emits these same events.

// What the traveller chose on the swipe deck. `fresh`: a re-plan after the sliders moved, so
// the liked places stay but the rest is chosen again from the whole city (never the rejected).
export interface Picks { liked: string[]; rejected: string[]; fresh?: boolean }

export interface PlannerEngine {
  planItinerary(brief: TripBrief, signal: AbortSignal, picks?: Picks): AsyncGenerator<PlannerEvent>
  findHotels(brief: TripBrief, days: DayPlan[], signal: AbortSignal): AsyncGenerator<PlannerEvent>
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
  })
}
