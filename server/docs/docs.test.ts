import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { resetLimits } from '../money/auth'
import { Db } from '../money/db'
import { createMoneyApi } from '../money/routes'
import { signInVia } from '../money/signInForTests'
import { diskStorage } from '../vault/storage'
import { lastMail } from '../mail'
import type { AlertItem, DocItem, Extracted, UploadTarget } from '../../src/docs/types'
import { setReader } from './store'
import { deliverDue } from './notify'

// The documents vault over real HTTP: an upload has to be a real PDF or photo; it's read (by a
// stand-in for the model here) into alerts; the alerts follow the document and its trip; and
// due ones are delivered in the app and by email, once.

let server: Server
let origin = ''
let dir = ''
let db: Db

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 32)])
const soon = (h: number) => { const d = new Date(Date.now() + h * 3_600_000); return d.toISOString().slice(0, 16) }
let next: Extracted
const base: Extracted = { kind: 'other', title: 'x', summary: '', reference: null, people: [], segments: [], place: null, start: null, end: null, checkinUrl: null, holder: null, country: null, numberTail: null, expires: null, notes: [] }

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wayfarer-docs-'))
  db = await Db.local()
  setReader(async () => next)
  const handle = createMoneyApi(db, { storage: diskStorage(dir, 30 * 1024 * 1024), geocode: null, limits: { maxCount: 20, maxBytes: 50 * 1024 * 1024 } })
  server = createServer((req, res) => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
  await new Promise<void>(r => server.listen(0, r))
  const addr = server.address()
  origin = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => resetLimits())

after(async () => {
  setReader(null)
  server.closeAllConnections()
  await new Promise(r => server.close(r))
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

class Person {
  cookie = ''
  email = ''
  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${origin}/api/money${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    const text = await res.text()
    return { status: res.status, data: (text ? JSON.parse(text) : {}) as T }
  }
  async ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, data } = await this.call<T>(method, path, body)
    assert.ok(status >= 200 && status < 300, `${method} ${path} -> ${status} ${JSON.stringify(data)}`)
    return data
  }
  docs = async () => (await this.ok<{ docs: DocItem[] }>('GET', '/docs')).docs
}

async function person(name: string): Promise<Person> {
  const p = new Person()
  p.email = `${name.toLowerCase()}-${randomUUID()}@example.com`
  await signInVia((m, path, b) => p.call(m, path, b), p.email, name)
  return p
}

async function upload(who: Person, bytes = PDF, over: Record<string, unknown> = {}): Promise<{ id: string; status: number; data: unknown }> {
  const id = randomUUID().replace(/-/g, '')
  const { upload } = await who.ok<{ upload: UploadTarget }>('POST', '/docs/uploads', { id, mime: 'application/pdf', bytes: bytes.length, fileName: 'ticket.pdf', tzOffset: 0, tripId: null, ...over })
  const put = await fetch(origin + upload.url, { method: 'PUT', body: bytes })
  assert.equal(put.status, 200)
  const done = await who.call('POST', `/docs/${id}/done`, {})
  return { id, ...done }
}

async function settled(who: Person, id: string): Promise<DocItem> {
  for (let i = 0; i < 50; i++) {
    const d = (await who.docs()).find(x => x.id === id)!
    if (d.status !== 'reading') return d
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('never finished reading')
}

describe('documents vault', () => {
  it('reads a ticket into alerts, delivers due ones once, in the app and by email', async () => {
    const ana = await person('Ana')
    next = { ...base, kind: 'flight', title: 'TP 1351 London → Lisbon', reference: 'ABC123',
      segments: [{ carrier: 'TAP', number: 'TP 1351', from: 'London Heathrow (LHR)', to: 'Lisbon (LIS)', depart: { at: soon(20), offset: '+00:00' }, arrive: null, terminal: '2', seat: '12C' }] }
    const { id } = await upload(ana)
    const doc = await settled(ana, id)
    assert.equal(doc.status, 'ready')
    assert.equal(doc.kind, 'flight')
    assert.equal(doc.data?.reference, 'ABC123')
    assert.deepEqual(doc.alerts.map(a => a.kind).sort(), ['checkin', 'depart'])

    // check-in (within 24h) is due now; leaving isn't
    assert.ok(await deliverDue(db) >= 1)
    const mine = await ana.ok<{ arrived: AlertItem[]; coming: AlertItem[]; unread: number }>('GET', '/alerts')
    assert.deepEqual(mine.arrived.map(a => a.kind), ['checkin'])
    assert.equal(mine.unread, 1)
    assert.deepEqual(mine.coming.map(a => a.kind), ['depart'])
    const mail = lastMail(ana.email)!
    assert.match(mail.subject, /Check in for TP 1351/)
    assert.match(mail.text, /ABC123/)
    assert.equal(await deliverDue(db), 0, 'never twice')

    await ana.ok('POST', '/alerts/read', { ids: 'all' })
    assert.equal((await ana.ok<{ unread: number }>('GET', '/alerts')).unread, 0)

    // the file can be opened; others can't see it or its alerts
    assert.match((await ana.ok<{ url: string }>('GET', `/docs/${id}/file`)).url, /blob/)
    const ben = await person('Ben')
    assert.deepEqual(await ben.docs(), [])
    assert.equal((await ben.call('GET', `/docs/${id}/file`)).status, 404)
    assert.deepEqual((await ben.ok<{ arrived: AlertItem[] }>('GET', '/alerts')).arrived, [])

    // deleting it takes its alerts with it
    await ana.ok('DELETE', `/docs/${id}`)
    assert.deepEqual((await ana.ok<{ coming: AlertItem[] }>('GET', '/alerts')).coming, [])
  })

  it('skips the email for someone who turned it off', async () => {
    const cal = await person('Cal')
    await cal.ok('PATCH', '/auth/me', { alertEmail: false })
    next = { ...base, kind: 'event', title: 'Fado night', start: { at: soon(1), offset: '+00:00' } }
    const { id } = await upload(cal)
    await settled(cal, id)
    await deliverDue(db)
    assert.equal((await cal.ok<{ arrived: AlertItem[] }>('GET', '/alerts')).arrived.length, 1)
    assert.match(lastMail(cal.email)!.subject, /Wayfarer code/, 'the last email is still the sign-in code')
  })

  it('checks a passport against a trip it’s linked to, and only real files get in', async () => {
    const dee = await person('Dee')
    const g = await dee.ok<{ group: { id: string } }>('POST', '/groups', { name: 'Lisbon', currency: 'EUR', members: [] })
    await db.run('UPDATE money_groups SET trip = ? WHERE id = ?', JSON.stringify({ city: 'Lisbon', startDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), days: 4 }), g.group.id)
    next = { ...base, kind: 'passport', title: 'Passport', holder: 'Dee Rao', expires: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10) }
    const { id } = await upload(dee, PDF, { tripId: g.group.id })
    const doc = await settled(dee, id)
    assert.match(doc.alerts.find(a => a.kind === 'invalid-for-trip')!.title, /Dee’s passport has under 6 months left on your Lisbon trip/)

    const bad = await upload(dee, Buffer.from('not a pdf at all, just text'))
    assert.equal(bad.status, 422)
    assert.equal((await dee.docs()).length, 1)
    assert.equal((await dee.call('POST', '/docs/uploads', { id: randomUUID().replace(/-/g, ''), mime: 'application/pdf', bytes: 10, fileName: 'x.pdf', tzOffset: 0, tripId: 'someoneelsestrip1' })).status, 404)
  })
})
