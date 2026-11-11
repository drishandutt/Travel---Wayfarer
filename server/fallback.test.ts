import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlannerEvent } from '../src/types'
import type { PlannerEngine } from '../src/planner/engine'
import { FallbackPlanner } from '../src/planner/remotePlanner'

const engine = (events: PlannerEvent[], fail?: Error): PlannerEngine => ({
  async *planItinerary() { for (const e of events) yield e; if (fail) throw fail },
  async *findHotels() { for (const e of events) yield e; if (fail) throw fail },
})
const all = async (g: AsyncGenerator<PlannerEvent>) => { const out: PlannerEvent[] = []; for await (const e of g) out.push(e); return out }
const offline = engine([{ type: 'thought', text: 'offline' }, { type: 'plan-ready' }])
const signal = new AbortController().signal

describe('planning when the model can’t', () => {
  it('hands over to the offline planner, with a plain line instead of the provider’s error', async () => {
    const out = await all(new FallbackPlanner(engine([{ type: 'thought', text: 'reading' }, { type: 'error', message: 'You have no credits remaining.' }]), offline).planItinerary({ vibes: [] }, signal))
    assert.ok(out.some(e => e.type === 'thought' && e.text === 'offline'))
    assert.ok(!out.some(e => e.type === 'error'))
    assert.ok(!JSON.stringify(out).includes('credits'))
  })

  it('also when the request itself fails', async () => {
    const out = await all(new FallbackPlanner(engine([], new Error('network down')), offline).planItinerary({ vibes: [] }, signal))
    assert.ok(out.some(e => e.type === 'thought' && e.text === 'offline'))
  })

  it('keeps a model plan that has started drawing days', async () => {
    const day = { type: 'day', plan: { day: 1, color: '', stops: [], legs: [], title: '' } } as PlannerEvent
    const out = await all(new FallbackPlanner(engine([day, { type: 'error', message: 'late' }]), offline).planItinerary({ vibes: [] }, signal))
    assert.ok(out.some(e => e.type === 'error'))
    assert.ok(!out.some(e => e.type === 'thought' && e.text === 'offline'))
  })
})
