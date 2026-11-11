import assert from 'node:assert/strict'
import { after, afterEach, describe, it } from 'node:test'
import type { PlannerEvent, TripBrief } from '../src/types'
import { applyStory, datesIn, extractStory, readBack, storyLines } from '../src/planner/story'
import { converse, nextField } from '../src/planner/intake'
import { buildDay, stayHotel } from '../src/planner/core'
import { estimateTravel } from '../src/planner/geo'
import { MockPlanner } from '../src/planner/mockPlanner'
import { tripCity } from '../src/data/cities'
import { setOpenAIKey } from './openai'
import { provider } from './llm'
import { runIntake } from './intake'
import { planWithModel } from './planAgent'
import { hotelsWithModel } from './hotelAgent'

const TODAY = new Date('2026-11-11T10:00:00')
const MUMBAI = 'I am going to Mumbai with my girlfriend on the 24, 25, 26, 24th I wanna plan a crazy date night with my girlfriend and surprise her as well, I am staying at Sun N Sands Hotel, tell me fun things to do and plan the whole trip, we are not looking for touristy vibes but a romantic trip.'

describe('reading the trip from what they wrote, offline', () => {
  it('catches dates, who, where they stay, the occasion, the moment and what to avoid in one message', () => {
    const b = extractStory(MUMBAI, { vibes: [] }, TODAY)
    assert.equal(b.startDate, '2026-11-24')
    assert.equal(b.days, 3)
    assert.equal(b.travelers, 2)
    assert.deepEqual(b.story?.people, [{ who: 'girlfriend' }])
    assert.equal(b.story?.stay?.name, 'Sun N Sands Hotel')
    assert.match(b.story?.occasion ?? '', /date night, as a surprise/)
    assert.deepEqual(b.story?.avoid, ['touristy'])
    assert.ok(b.story?.feel?.includes('romantic'))
    assert.deepEqual(b.story?.moments, [{ what: 'crazy date night, a surprise', day: 1, when: 'night' }])
  })

  it('reads when they land, and when they have to leave', () => {
    const b = extractStory('We are reaching by 1 pm, to the hotel. Flying home at 6pm on the last day', { vibes: [] }, TODAY)
    assert.equal(b.story?.arrive, 13 * 60)
    assert.equal(b.story?.leave, 18 * 60)
  })

  it('reads dates in the usual ways, and not counts or money', () => {
    assert.deepEqual(datesIn('Dec 3-6', TODAY), { start: '2026-12-03', days: 4, first: 3 })
    assert.equal(datesIn('from the 12th to the 14th', TODAY)?.days, 3)
    assert.equal(datesIn('24 to 26 Nov', TODAY)?.start, '2026-11-24')
    assert.equal(datesIn('the 3rd', TODAY)?.start, '2026-12-03', 'a day already past this month is next month')
    assert.equal(datesIn('4 days in Tokyo for two, $4000', TODAY), undefined)
    assert.equal(datesIn('3, 4 or 5 people', TODAY), undefined)
  })

  it('keeps a sentence giving the dates from becoming a moment', () => {
    const b = extractStory('Bachelor party in Berlin 12th to 14th, 8 of us, we hate museums and don’t want early starts', { vibes: [] }, TODAY)
    assert.equal(b.story?.occasion, 'a bachelor party')
    assert.equal(b.story?.moments, undefined)
    assert.deepEqual(b.story?.avoid, ['museums', 'early starts'])
  })

  it('turns the story into the settings the planners read, without overriding the sliders', () => {
    const b = applyStory({ vibes: [], story: { avoid: ['touristy', 'crowds', 'early starts'], feel: ['romantic'], people: [{ who: 'kids' }] } })
    assert.equal(b.familiarity, 0.75)
    assert.equal(b.crowds, 0.75)
    assert.equal(b.rhythm, 0.75)
    assert.equal(b.kids, 0.75)
    assert.ok(b.vibes.includes('romantic'))
    assert.equal(applyStory({ vibes: [], familiarity: 0, story: { avoid: ['touristy'] } }).familiarity, 0, 'a slider they moved stays where it is')
  })

  it('says the story to a model planner in words', () => {
    const lines = storyLines({ vibes: [], startDate: '2026-11-24', days: 3, story: { stay: { name: 'Sun-n-Sand' }, arrive: 780, avoid: ['touristy'] } }).join('\n')
    assert.match(lines, /Tue 24 Nov to Thu 26 Nov/)
    assert.match(lines, /Staying at: Sun-n-Sand/)
    assert.match(lines, /free from 13:00 on day 1/)
    assert.match(lines, /Avoid: touristy/)
  })

  it('shows back everything it heard, and each piece can be taken out', () => {
    const b = extractStory(MUMBAI, { vibes: [] }, TODAY)
    const chips = readBack(b, 'Mumbai')
    const labels = chips.map(c => c.label)
    for (const want of ['Mumbai', 'Tue 24 Nov – Thu 26 Nov', 'You + girlfriend', 'Sun N Sands Hotel', 'touristy']) assert.ok(labels.includes(want), want)
    const avoid = chips.find(c => c.label === 'touristy')!
    assert.deepEqual(avoid.drop?.story?.avoid, [])
  })
})

describe('the conversation, offline', () => {
  it('asks about the person before the budget, and keeps the answer in their words', () => {
    const first = converse(MUMBAI, { vibes: [] }, 'tokyo')
    assert.equal(nextField(first.brief), 'person')
    assert.match(first.reply, /What’s your girlfriend into\?/)
    assert.match(first.reply, /staying at Sun N Sands Hotel/)
    assert.match(first.reply, /nothing touristy/)
    const second = converse('She loves live music and cocktails', first.brief)
    assert.equal(second.brief.story?.people?.[0].notes, 'She loves live music and cocktails')
    assert.equal(nextField(second.brief), undefined, 'a hotel says enough about the budget to start')
  })
})

describe('planning around real time', () => {
  const city = tripCity({ destination: 'tokyo', vibes: [] })!
  const two = [city.places[0], city.places[1]]

  it('starts day 1 after they’ve arrived and dropped their bags', () => {
    const plan = buildDay(1, two, { destination: 'tokyo', vibes: [], story: { arrive: 13 * 60 } })
    assert.ok(plan.stops[0].arrive >= 14 * 60 + 15, `starts at ${plan.stops[0].arrive}`)
    assert.ok(buildDay(2, two, { destination: 'tokyo', vibes: [], story: { arrive: 13 * 60 } }).stops[0].arrive < 13 * 60, 'only day 1')
  })

  it('makes a cross-town hop slower at rush hour, more so in a city that jams', () => {
    const a: [number, number] = [72.826, 19.099] // Juhu
    const b: [number, number] = [72.834, 18.922] // Colaba
    const midday = estimateTravel(a, b, 1.4, { at: 13 * 60, traffic: 1.8 }).minutes
    const evening = estimateTravel(a, b, 1.4, { at: 18 * 60, traffic: 1.8 }).minutes
    const calmer = estimateTravel(a, b, 1.4, { at: 18 * 60, traffic: 1.05 }).minutes
    assert.equal(midday, estimateTravel(a, b).minutes)
    assert.ok(evening > midday * 1.6, `${evening} vs ${midday}`)
    assert.ok(calmer < evening)
  })

  it('uses where they’re staying as the base instead of choosing one', async () => {
    const brief: TripBrief = { destination: 'tokyo', days: 1, vibes: [], story: { stay: { name: 'Our Airbnb', coord: city.center } } }
    assert.equal(stayHotel(brief)?.name, 'Our Airbnb')
    assert.equal(stayHotel({ ...brief, story: { stay: { name: 'Our Airbnb' } } }), undefined, 'not until it’s on the map')
    const events: PlannerEvent[] = []
    for await (const e of new MockPlanner(0).findHotels(brief, [buildDay(1, two, brief)], new AbortController().signal)) events.push(e)
    const pick = events.find(e => e.type === 'hotel-pick')
    assert.equal(pick?.type === 'hotel-pick' && pick.score.hotel.name, 'Our Airbnb')
  })
})

// OpenAI's Responses API, faked at fetch, so the OpenAI path runs without a key or a network.
const realFetch = globalThis.fetch
let sent: Record<string, unknown>[] = []
function fakeOpenAI(replies: unknown[][]) {
  sent = []
  let n = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')))
    const output = replies[Math.min(n, replies.length - 1)]
    n++
    return new Response(JSON.stringify({ id: `resp_${n}`, object: 'response', created_at: 0, status: 'completed', model: 'test', output }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  setOpenAIKey('sk-test')
}
const text = (t: string) => ({ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: t, annotations: [] }] })
const call = (name: string, args: unknown, id = name) => ({ type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: 'completed' })

describe('planning with OpenAI when there’s no Anthropic key', { skip: Boolean(process.env.ANTHROPIC_API_KEY) && 'Claude is set here' }, () => {
  afterEach(() => { globalThis.fetch = realFetch })
  after(() => setOpenAIKey(null))
  const city = tripCity({ destination: 'tokyo', vibes: [] })!
  const ids = city.places.slice(0, 4).map(p => p.id)

  it('runs the intake on OpenAI, with the story and its own chips', async () => {
    fakeOpenAI([[text(JSON.stringify({
      reply: 'Tokyo for the two of you, with a surprise on night one. What’s she into?',
      chips: ['Food & drinks', 'Art & music'],
      brief: { destination: 'Tokyo', start_date: '2026-11-24', days: 3, travelers: 2, vibes: ['romantic'], budget_tier: '', budget_usd: 0, pace: '' },
      story: { occasion: 'surprise date night', people: [{ who: 'girlfriend', notes: '' }], stay: 'Park Hyatt', arrive: '13:00', leave: '', moments: [{ what: 'crazy date night', day: 1, when: 'night' }], feel: ['romantic', 'fun'], avoid: ['touristy'] },
    }))]])
    assert.equal(provider(), 'openai')
    const out = await runIntake({ messages: [{ role: 'ai', text: 'Where to?' }, { role: 'user', text: 'Tokyo with my girlfriend…' }], brief: { vibes: [], familiarity: 0 } }, new AbortController().signal)
    assert.equal(out.brief.destination, 'tokyo')
    assert.equal(out.brief.startDate, '2026-11-24')
    assert.equal(out.brief.story?.stay?.name, 'Park Hyatt')
    assert.equal(out.brief.story?.arrive, 780)
    assert.deepEqual(out.brief.story?.moments, [{ what: 'crazy date night', day: 1, when: 'night' }])
    assert.equal(out.brief.familiarity, 0, 'the slider they set stays')
    assert.deepEqual(out.chips, ['Food & drinks', 'Art & music'])
    const req = sent[0] as { text: { format: { type: string; strict: boolean } }; input: { role: string }[] }
    assert.equal(req.text.format.type, 'json_schema')
    assert.equal(req.text.format.strict, true)
    assert.deepEqual(req.input.map(m => m.role), ['user'], 'the greeting is left out')
  })

  it('plans on OpenAI through the same tools, round by round', async () => {
    fakeOpenAI([
      [text('Looking at your four picks.'), call('shortlist_places', { narration: 'Keeping all four.', keep: ids.map(id => ({ id, reason: 'you picked it' })), drop: [] })],
      [call('commit_day', { narration: 'Day 1 is the west side.', day: 1, title: 'West', start_time: '09:00', stop_ids: ids.slice(0, 2) }, 'd1'),
        call('commit_day', { narration: 'Day 2 is the east side.', day: 2, title: 'East', start_time: '09:30', stop_ids: ids.slice(2) }, 'd2')],
      [call('finish_plan', { narration: 'All set.' })],
    ])
    const brief: TripBrief = { destination: 'tokyo', days: 2, vibes: [] }
    const events: PlannerEvent[] = []
    for await (const e of planWithModel(brief, new AbortController().signal, { liked: ids, rejected: [] })) events.push(e)
    const days = events.filter(e => e.type === 'day')
    assert.equal(days.length, 2)
    assert.ok(events.some(e => e.type === 'plan-ready'))
    assert.ok(events.some(e => e.type === 'thought' && e.text === 'Looking at your four picks.'))
    assert.equal(sent.length, 3)
    const second = sent[1] as { previous_response_id: string; input: { type: string; call_id: string; output: string }[]; tools: { strict: boolean }[] }
    assert.equal(second.previous_response_id, 'resp_1')
    assert.equal(second.input[0].type, 'function_call_output')
    assert.match(second.input[0].output, /Kept 4/)
    assert.ok(second.tools.every(t => t.strict))
    const third = sent[2] as { input: { call_id: string }[] }
    assert.deepEqual(third.input.map(i => i.call_id), ['call_d1', 'call_d2'])
  })

  it('sends a bad tool call back as an error for the model to fix', async () => {
    fakeOpenAI([
      [call('commit_day', { narration: 'x', day: 1, title: 'x', start_time: '09:00', stop_ids: ['nope'] }, 'bad')],
      [call('commit_day', { narration: 'Day 1.', day: 1, title: 'Day', start_time: '09:00', stop_ids: ids.slice(0, 2) }, 'ok')],
      [call('finish_plan', { narration: 'Done.' })],
    ])
    const events: PlannerEvent[] = []
    for await (const e of planWithModel({ destination: 'tokyo', days: 1, vibes: [] }, new AbortController().signal, { liked: ids.slice(0, 2), rejected: [] })) events.push(e)
    const second = sent[1] as { input: { output: string }[] }
    assert.match(second.input[0].output, /^Error: Unknown or already-used ids: nope/)
    assert.equal(events.filter(e => e.type === 'day').length, 1)
  })

  it('picks the hotel on OpenAI', async () => {
    const hotel = city.hotels[1]
    fakeOpenAI([[text(JSON.stringify({ hotel_id: hotel.id, reason: 'Closest to every day.' }))]])
    const brief: TripBrief = { destination: 'tokyo', days: 1, vibes: [] }
    const events: PlannerEvent[] = []
    for await (const e of hotelsWithModel(brief, [buildDay(1, city.places.slice(0, 2), brief)], new AbortController().signal)) events.push(e)
    const pick = events.find(e => e.type === 'hotel-pick')
    assert.equal(pick?.type === 'hotel-pick' && pick.score.hotel.id, hotel.id)
  })
})

describe('what to avoid', () => {
  it('reads a whole list after "hate" or "no", and stops where the wishes start', () => {
    const b = extractStory('We hate touristy stuff and crowds, want it romantic and slow', { vibes: [] }, TODAY)
    assert.deepEqual(b.story?.avoid, ['touristy', 'crowds'])
    assert.deepEqual(b.story?.feel, ['romantic', 'relaxed'])
    const c = extractStory('no clubs or museums and we love long walks', { vibes: [] }, TODAY)
    assert.deepEqual(c.story?.avoid, ['clubs', 'museums'])
  })
})
