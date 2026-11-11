import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertsFor, fmtLocal, instant } from '../../src/docs/alerts'
import type { Extracted } from '../../src/docs/types'

const base: Extracted = { kind: 'other', title: '', summary: '', reference: null, people: [], segments: [], place: null, start: null, end: null, checkinUrl: null, holder: null, country: null, numberTail: null, expires: null, notes: [] }
const at = (iso: string) => Date.parse(iso)

test('local times become instants with their place’s offset, or the uploader’s', () => {
  assert.equal(instant({ at: '2026-12-03T10:30', offset: '+00:00' }, 0), at('2026-12-03T10:30:00Z'))
  assert.equal(instant({ at: '2026-12-03T10:30', offset: '+01:00' }, 0), at('2026-12-03T09:30:00Z'))
  assert.equal(instant({ at: '2026-12-03T10:30', offset: '-05:00' }, 0), at('2026-12-03T15:30:00Z'))
  assert.equal(instant({ at: '2026-12-03T10:30', offset: null }, 330), at('2026-12-03T05:00:00Z'), 'India, from the uploader')
  assert.equal(fmtLocal('2026-12-03T10:30'), 'Thu 3 Dec, 10:30')
})

test('a flight: check-in opens a day before, and a nudge three hours before it leaves', () => {
  const flight: Extracted = { ...base, kind: 'flight', title: 'BA 432', reference: 'X7K2PQ', checkinUrl: 'https://ba.com/checkin',
    segments: [{ carrier: 'British Airways', number: 'BA 432', from: 'London Heathrow (LHR)', to: 'Lisbon (LIS)', depart: { at: '2026-12-03T10:30', offset: '+00:00' }, arrive: { at: '2026-12-03T13:05', offset: '+00:00' }, terminal: '5', seat: '14A' }] }
  const out = alertsFor('d1', flight, { fallbackOffset: 0, trips: [], now: at('2026-11-20T12:00:00Z') })
  const checkin = out.find(a => a.kind === 'checkin')!
  const depart = out.find(a => a.kind === 'depart')!
  assert.equal(checkin.dueAt, at('2026-12-02T10:30:00Z'))
  assert.match(checkin.title, /BA 432 London Heathrow → Lisbon/)
  assert.match(checkin.body, /ba\.com\/checkin.*X7K2PQ/)
  assert.equal(depart.dueAt, at('2026-12-03T07:30:00Z'))
  assert.match(depart.title, /Flight BA 432 leaves at 10:30/)
  assert.match(depart.body, /Terminal 5 · Seat 14A/)
  assert.equal(new Set(out.map(a => a.key)).size, out.length, 'stable, unique keys')

  // inside the check-in window: due straight away; after it leaves: nothing
  const late = alertsFor('d1', flight, { fallbackOffset: 0, trips: [], now: at('2026-12-03T01:00:00Z') })
  assert.equal(late.find(a => a.kind === 'checkin')!.dueAt, at('2026-12-03T01:00:00Z'))
  assert.deepEqual(alertsFor('d1', flight, { fallbackOffset: 0, trips: [], now: at('2026-12-03T11:00:00Z') }), [])
})

test('a stay: the morning of check-in and of check-out', () => {
  const hotel: Extracted = { ...base, kind: 'hotel', title: 'Hotel Avenida', place: { name: 'Hotel Avenida', address: 'Av. da Liberdade 1' },
    start: { at: '2026-12-03T15:00', offset: '+00:00' }, end: { at: '2026-12-06T11:00', offset: '+00:00' } }
  const out = alertsFor('h', hotel, { fallbackOffset: 0, trips: [], now: at('2026-11-01T00:00:00Z') })
  assert.equal(out.find(a => a.kind === 'stay-in')!.dueAt, at('2026-12-03T09:00:00Z'))
  assert.match(out.find(a => a.kind === 'stay-in')!.body, /From 15:00 · Hotel Avenida · Av\. da Liberdade 1/)
  assert.equal(out.find(a => a.kind === 'stay-out')!.dueAt, at('2026-12-06T08:00:00Z'))
})

test('a passport: reminders before it expires, and a warning for a trip it won’t last', () => {
  const passport: Extracted = { ...base, kind: 'passport', title: 'Passport', holder: 'Priya Shah', expires: '2027-03-01' }
  const trips = [{ id: 'g1', name: 'Lisbon trip', start: '2026-12-03', days: 4 }, { id: 'g2', name: 'Kyoto trip', start: '2027-04-10', days: 5 }, { id: 'g0', name: 'Old trip', start: '2025-01-01', days: 3 }]
  const now = at('2026-08-01T00:00:00Z')
  const out = alertsFor('p', passport, { fallbackOffset: 0, trips, now })
  assert.deepEqual(out.filter(a => a.kind === 'expires').map(a => a.title), ['Priya’s passport expires in 6 months', 'Priya’s passport expires in 3 months', 'Priya’s passport expires in 1 month'])
  assert.equal(out.find(a => a.key === 'p:expires:6')!.dueAt, at('2026-09-01T09:00:00Z'))
  const lisbon = out.find(a => a.key === 'p:trip:g1')!
  assert.match(lisbon.title, /under 6 months left on Lisbon trip/)
  assert.equal(lisbon.dueAt, now)
  assert.match(out.find(a => a.key === 'p:trip:g2')!.title, /runs out before Kyoto trip ends/)
  assert.equal(out.find(a => a.key === 'p:trip:g0'), undefined, 'past trips are left alone')
})

test('insurance: a week’s notice before it ends, and trips it doesn’t cover', () => {
  const cover: Extracted = { ...base, kind: 'insurance', title: 'Travel cover', reference: 'POL-1', start: { at: '2026-11-01', offset: null }, end: { at: '2026-12-05', offset: null } }
  const out = alertsFor('i', cover, { fallbackOffset: 0, trips: [{ id: 'g1', name: 'Lisbon trip', start: '2026-12-03', days: 4 }], now: at('2026-11-02T00:00:00Z') })
  assert.equal(out.find(a => a.kind === 'cover-ends')!.dueAt, at('2026-11-28T09:00:00Z'))
  assert.match(out.find(a => a.kind === 'trip-uncovered')!.title, /doesn’t cover all of Lisbon trip/)
})

test('nothing to say about a plain document', () => {
  assert.deepEqual(alertsFor('x', { ...base, title: 'Menu' }, { fallbackOffset: 0, trips: [], now: Date.now() }), [])
})
