import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { AGENT_TOOLS, toolSchemas } from '../src/agent/tools'
import { contextOf, runTool, type AgentHost } from '../src/agent/run'
import { reducer, initialState, type Action, type TripState } from '../src/state/tripStore'
import { tripCity } from '../src/data/cities'
import { buildDay } from '../src/planner/core'
import type { TripBrief } from '../src/types'
import type { GroupState } from '../src/money/types'
import { AgentError, agentTurn } from './agent'

const brief: TripBrief = { destination: 'tokyo', days: 2, vibes: ['food'], moneyGroupId: 'g1' }

function planned(): TripState {
  const city = tripCity(brief)!
  const pick = (ids: string[]) => ids.map(id => city.places.find(p => p.id === id)!)
  return { ...initialState, phase: 'review', brief, days: [buildDay(1, pick(['tk-sensoji', 'tk-ueno']), brief), buildDay(2, pick(['tk-meiji', 'tk-harajuku']), brief)] }
}

function host(start: TripState, opts: { confirm?: boolean } = {}) {
  let s = start
  const asked: string[] = []
  const h: AgentHost = {
    state: () => s,
    dispatch: (a: Action) => { s = reducer(s, a) },
    trip: () => null,
    ensureGroup: async () => 'g1',
    confirm: async q => { asked.push(q); return opts.confirm ?? false },
  }
  return { h, asked, now: () => s }
}

const group: GroupState = {
  group: { id: 'g1', name: 'Tokyo trip', currency: 'JPY', simplify: true, budget: null, inviteToken: 't', trip: null, version: 1, createdAt: 0 },
  me: 'm1',
  members: [
    { id: 'm1', name: 'Dee', role: 'owner', joined: true, waitingEmail: null, left: false, payHandle: null, budget: null },
    { id: 'm2', name: 'Ana', role: 'member', joined: true, waitingEmail: null, left: false, payHandle: null, budget: null },
  ],
  expenses: [], settlements: [], comments: [], activity: [],
}

// the money API, recorded
const realFetch = globalThis.fetch
let calls: { method: string; url: string; body?: unknown }[] = []
function fakeMoney() {
  calls = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(init?.method === 'GET' || !init?.method ? group : {}), { status: 200 })
  }) as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })

describe('the assistant’s allowlist', () => {
  it('offers the model exactly the listed tools, each with a JSON schema', () => {
    const schemas = toolSchemas()
    assert.deepEqual(schemas.map(t => t.name).sort(), Object.keys(AGENT_TOOLS).sort())
    for (const t of schemas) assert.equal(t.parameters.type, 'object', t.name)
  })

  it('refuses a tool that isn’t on the list', async () => {
    const { h } = host(planned())
    assert.match(await runTool({ id: '1', name: 'run_shell', args: { cmd: 'rm -rf /' } }, h), /not something you can do/)
    assert.match(await runTool({ id: '1', name: '__proto__', args: {} }, h), /not something you can do/)
  })

  it('refuses arguments that don’t fit, including extra ones', async () => {
    const { h, now } = host(planned())
    assert.match(await runTool({ id: '1', name: 'add_stop', args: { place_id: 'tk-skytree', day: 'two' } }, h), /bad arguments/)
    assert.match(await runTool({ id: '1', name: 'add_stop', args: { place_id: 'tk-skytree', day: 1, sudo: true } }, h), /bad arguments/)
    assert.equal(now().days[0].stops.length, 2)
  })

  it('edits the plan through the app’s own actions, and reports what really happened', async () => {
    const { h, now } = host(planned())
    assert.match(await runTool({ id: '1', name: 'add_stop', args: { place_id: 'tk-skytree', day: 1 } }, h), /^Added Tokyo Skytree to Day 1/)
    assert.ok(now().days[0].stops.some(st => st.place.id === 'tk-skytree'))
    assert.match(await runTool({ id: '2', name: 'move_stop', args: { place_id: 'tk-skytree', to_day: 2 } }, h), /Moved Tokyo Skytree to Day 2/)
    assert.match(await runTool({ id: '3', name: 'undo', args: {} }, h), /Undid/)
    assert.ok(now().days[0].stops.some(st => st.place.id === 'tk-skytree'), 'undoing the move puts it back on Day 1')
    assert.ok(!now().days[1].stops.some(st => st.place.id === 'tk-skytree'))
    assert.match(await runTool({ id: '4', name: 'add_stop', args: { place_id: 'made-up', day: 1 } }, h), /no place with id made-up/)
  })

  it('can’t edit as a normal group member, because the reducer ignores them', async () => {
    const { h, now } = host({ ...planned(), shared: { role: 'member', phase: 'review', voting: false, base: 1 } })
    await runTool({ id: '1', name: 'add_stop', args: { place_id: 'tk-skytree', day: 1 } }, h)
    assert.ok(!now().days[0].stops.some(st => st.place.id === 'tk-skytree'))
  })

  it('asks before money changes, and does nothing when declined', async () => {
    fakeMoney()
    const { h, asked } = host(planned(), { confirm: false })
    const out = await runTool({ id: '1', name: 'log_expense', args: { title: 'Dinner', amount: 3000, paid_by: null, split_between: null, place_id: null, day: null } }, h)
    assert.match(asked[0], /Log “Dinner”: ¥3,000, paid by you, split equally between everyone \(2\)\?/)
    assert.match(out, /declined/)
    assert.ok(!calls.some(c => c.method === 'POST'), 'nothing was posted')
  })

  it('logs the expense once confirmed, in the group’s currency', async () => {
    fakeMoney()
    const { h } = host(planned(), { confirm: true })
    const out = await runTool({ id: '1', name: 'log_expense', args: { title: 'Taxi', amount: 2400, paid_by: 'm2', split_between: ['m1', 'm2'], place_id: null, day: null } }, h)
    assert.match(out, /Logged “Taxi”/)
    const post = calls.find(c => c.method === 'POST')!
    assert.equal(post.url, '/api/money/groups/g1/expenses')
    assert.deepEqual((post.body as any).payers, [{ memberId: 'm2', amount: 2400 }])
    assert.equal((post.body as any).category, 'transport')
  })

  it('won’t log against someone who isn’t in the group', async () => {
    fakeMoney()
    const { h, asked } = host(planned(), { confirm: true })
    const out = await runTool({ id: '1', name: 'log_expense', args: { title: 'Taxi', amount: 10, paid_by: 'stranger', split_between: null, place_id: null, day: null } }, h)
    assert.match(out, /isn’t a member id/)
    assert.equal(asked.length, 0)
  })

  it('asks before inviting or removing people', async () => {
    fakeMoney()
    const { h, asked } = host(planned(), { confirm: false })
    await runTool({ id: '1', name: 'invite_person', args: { email: 'ana@example.com' } }, h)
    await runTool({ id: '2', name: 'remove_person', args: { member_id: 'm2' } }, h)
    assert.match(asked[0], /Add ana@example.com/)
    assert.match(asked[1], /Remove Ana from the group/)
    assert.ok(!calls.some(c => c.method === 'POST' || c.method === 'DELETE'))
  })

  it('shows the model the plan with ids', () => {
    const text = contextOf(planned(), null)
    assert.match(text, /Day 1 “.*”:\n {2}\d\d:\d\d–\d\d:\d\d Sensō-ji Temple \[tk-sensoji\]/)
    assert.match(text, /Other places \(not in the plan\):\ntk-/)
    assert.match(text, /Estimated cost for the whole trip, in USD .*: \$[\d,]+ total, \$[\d,]+ per person/)
    assert.match(text, /\n {2}Stay: \$[\d,]+ \(/)
  })
})

describe('the assistant endpoint', () => {
  it('stops a run that goes on too long', async () => {
    await assert.rejects(agentTurn({ state: { provider: 'openai', previousId: 'r', round: 7 }, results: [] }, new AbortController().signal), AgentError)
  })
  it('rejects malformed requests', async () => {
    await assert.rejects(agentTurn({ message: 'x'.repeat(5000) }, new AbortController().signal))
    await assert.rejects(agentTurn({ results: [{ id: 1 }] }, new AbortController().signal))
  })
})
