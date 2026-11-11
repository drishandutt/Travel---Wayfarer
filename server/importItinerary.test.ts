import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DAYS, fromParsed, importSummary, type ParsedItinerary } from './importItinerary'
import { looksLikeItinerary } from '../src/planner/itineraryPaste'

const stop = (name: string, time = '', kind: ParsedItinerary['days'][number]['stops'][number]['kind'] = 'sight') => ({ name, kind, time, minutes: 0, note: '' })
const lisbon = (over: Partial<ParsedItinerary> = {}): ParsedItinerary => ({
  city: 'Lisbon', start_date: '2026-12-03', travelers: 3, hotel: '',
  days: [
    { title: 'Belém', stops: [stop('Jerónimos Monastery', '09:30'), stop('Torre de Belém'), stop('Pastéis de Belém', '', 'cafe')] },
    { title: '', stops: [stop('Castelo de São Jorge', '10:00', 'viewpoint'), stop('Miradouro da Graça', '', 'viewpoint')] },
  ],
  ...over,
})

test('a pasted itinerary keeps its days, order, times and dates', async () => {
  const r = await fromParsed(lisbon())
  assert.equal(r.city.id, 'lisbon')
  assert.equal(r.brief.destination, 'lisbon')
  assert.equal(r.brief.days, 2)
  assert.equal(r.brief.travelers, 3)
  assert.equal(r.brief.startDate, '2026-12-03')
  assert.deepEqual(r.days[0].stops.map(s => s.place.name), ['Jerónimos Monastery', 'Torre de Belém', 'Pastéis de Belém'])
  assert.equal(r.days[0].stops[0].arrive, 9 * 60 + 30)
  assert.equal(r.days[0].title, 'Belém')
  assert.equal(r.days[1].stops[0].arrive, 10 * 60)
  assert.ok(r.days[1].title, 'an untitled day gets a title')
  assert.equal(r.places.length, 5)
  assert.deepEqual(r.custom, [])
  assert.deepEqual(r.missed, [])
  assert.ok(r.hotel, 'a base is picked when none is named')
  assert.ok(r.days.every(d => d.legs.some(l => l.kind === 'hotel')), 'days are routed from the base')
  assert.match(importSummary(r), /Lisbon itinerary into a trip: 2 days, 5 places/)
})

test('the traveller’s times hold, and nothing waits for a place’s usual time of day', async () => {
  const r = await fromParsed(lisbon({ days: [{ title: '', stops: [stop('Castelo de São Jorge', '10:00', 'viewpoint'), stop('Alfama Lanes'), stop('Pastéis de Belém', '19:00', 'cafe')] }] }))
  const [castle, lanes, pasteis] = r.days[0].stops
  assert.equal(castle.arrive, 10 * 60)
  assert.ok(lanes.arrive < 13 * 60, `straight on after the castle, not held to the evening (${lanes.arrive})`)
  assert.equal(pasteis.arrive, 19 * 60)
})

test('a hotel Wayfarer knows is used as the base', async () => {
  const r = await fromParsed(lisbon({ hotel: 'Alfama Rooftop Inn' }))
  assert.equal(r.hotel?.hotel.name, 'Alfama Rooftop Inn')
})

test('the trip keeps what was already said, and the itinerary wins where it says more', async () => {
  const r = await fromParsed(lisbon({ travelers: 0, start_date: 'next week' }), { base: { vibes: ['food'], budgetTier: 'luxury', travelers: 4 } })
  assert.deepEqual(r.brief.vibes, ['food'])
  assert.equal(r.brief.budgetTier, 'luxury')
  assert.equal(r.brief.travelers, 4)
  assert.equal(r.brief.startDate, undefined)
})

test('a free day stays a day, and days past the limit are left out', async () => {
  const many = Array.from({ length: MAX_DAYS + 2 }, (_, i) => (i === 1 ? { title: 'Rest day', stops: [] } : { title: '', stops: [stop('Torre de Belém')] }))
  const r = await fromParsed(lisbon({ days: many }))
  assert.equal(r.days.length, MAX_DAYS)
  assert.equal(r.days[1].stops.length, 0)
  assert.equal(r.days[1].title, 'Rest day')
  assert.equal(r.trimmed, 2)
  assert.match(importSummary(r), /left out the last 2/)
})

test('no days or no city is a clear refusal', async () => {
  await assert.rejects(fromParsed(lisbon({ days: [] })), /doesn’t look like an itinerary/)
  await assert.rejects(fromParsed(lisbon({ city: ' ' })), /Which city/)
})

test('the chat tells a pasted itinerary from an ordinary message', () => {
  const plan = `Lisbon, 3 days\n\nDay 1 – Belém\n9:30 Jerónimos Monastery\n11:00 Torre de Belém\nLunch: Pastéis de Belém\n\nDay 2 – Alfama\nCastelo de São Jorge, then Miradouro da Graça\nDinner at a fado house`
  assert.ok(looksLikeItinerary(plan))
  assert.ok(looksLikeItinerary(`**Monday**\n- Morning: LX Factory and the river walk along Belém\n- Afternoon: MAAT\n\n**Tuesday**\n- Morning: Alfama lanes and the castle\n- Evening: Bairro Alto bars and a late dinner`))
  assert.ok(!looksLikeItinerary('move the castle to day 2'))
  assert.ok(!looksLikeItinerary('4 days in Tokyo for two, food and nightlife, $4000'))
  assert.ok(!looksLikeItinerary('We loved day 1!\nCan you add more food on day 2?\nAnd something relaxed in the evening, maybe a viewpoint or a bar with a view of the river?\nThanks'))
})
