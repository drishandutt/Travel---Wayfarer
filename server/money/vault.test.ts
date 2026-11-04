import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { resetLimits } from './auth'
import { Db } from './db'
import { createMoneyApi } from './routes'
import { diskStorage } from '../vault/storage'
import type { GroupState } from '../../src/money/types'
import type { UploadItem, UploadTicket, VaultLibrary } from '../../src/vault/types'
import { readExif } from '../../src/vault/exif'

// The photo vault over real HTTP: who sees which photo, what an upload has to prove, and
// what happens to someone's photos when they're removed from a group.

let server: Server
let origin = ''
let dir = ''
let db: Db
const geocoded: string[] = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wayfarer-vault-'))
  db = await Db.local()
  const handle = createMoneyApi(db, {
    storage: diskStorage(dir, 30 * 1024 * 1024),
    geocode: async (lat, lng) => { geocoded.push(`${lat},${lng}`); return 'Lisbon, Portugal' },
    limits: { maxCount: 20, maxBytes: 50 * 1024 * 1024 },
  })
  server = createServer((req, res) => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
  await new Promise<void>(r => server.listen(0, r))
  const addr = server.address()
  origin = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => resetLimits())

after(async () => {
  server.closeAllConnections()
  await new Promise(r => server.close(r))
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

class Person {
  cookie = ''
  email = ''
  id = ''
  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${origin}/api/money${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
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
  library() { return this.ok<VaultLibrary>('GET', '/vault') }
  async seen() { return new Set((await this.library()).images.map(i => i.id)) }
}

async function person(name: string): Promise<Person> {
  const p = new Person()
  p.email = `${name.toLowerCase()}-${randomUUID()}@example.com`
  const out = await p.ok<{ user: { id: string } }>('POST', '/auth/email', { email: p.email, name })
  p.id = out.user.id
  return p
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])

const item = (over: Partial<UploadItem> = {}): UploadItem => ({
  id: randomUUID().replace(/-/g, ''), mime: 'image/jpeg', bytes: JPEG.length, thumbBytes: JPEG.length, fileName: 'IMG_0001.jpg',
  width: 4032, height: 3024, takenAt: '2026-10-12T14:03:22', lat: null, lng: null, ...over,
})

async function put(ticketUrl: string, body: Buffer) {
  const res = await fetch(origin + ticketUrl, { method: 'PUT', body })
  assert.equal(res.status, 200)
}

// Uploads one photo all the way: ask, send both files, say it's done.
async function upload(who: Person, share: { groups?: string[]; users?: string[] } = {}, over: Partial<UploadItem> = {}, bytes = JPEG): Promise<string> {
  const it = item(over)
  const { tickets } = await who.ok<{ tickets: UploadTicket[] }>('POST', '/vault/uploads', { items: [it], share: { groups: share.groups ?? [], users: share.users ?? [] } })
  await put(tickets[0].thumb.url, JPEG)
  await put(tickets[0].original.url, bytes)
  await who.ok('POST', `/vault/images/${it.id}/done`, {})
  return it.id
}

async function groupWith(owner: Person, ...members: Person[]): Promise<GroupState> {
  return await owner.ok<GroupState>('POST', '/groups', { name: 'Lisbon', currency: 'EUR', members: members.map(m => m.email) })
}

const seatOf = (s: GroupState, name: string) => s.members.find(m => m.name === name)!.id

describe('photo vault', () => {
  it('shows each photo only to the people it was shared with', async () => {
    const ana = await person('Ana'), ben = await person('Ben'), cara = await person('Cara')
    const g = await groupWith(ana, ben)
    const toGroup = await upload(ana, { groups: [g.group.id] })
    const justAna = await upload(ana)
    const toBen = await upload(ana, { users: [ben.id] })

    assert.deepEqual(await ana.seen(), new Set([toGroup, justAna, toBen]))
    assert.deepEqual(await ben.seen(), new Set([toGroup, toBen]))
    assert.equal((await cara.seen()).size, 0)

    const benLib = await ben.library()
    const viaGroup = benLib.images.find(i => i.id === toGroup)!
    assert.deepEqual(viaGroup.viaGroups, [g.group.id])
    assert.equal(viaGroup.sharedWith, undefined, 'who else got it is the uploader’s business')
    assert.equal(viaGroup.fileName, null)
    assert.equal(benLib.images.find(i => i.id === toBen)!.direct, true)
    const anaLib = await ana.library()
    assert.deepEqual(anaLib.images.find(i => i.id === toBen)!.sharedWith, { groups: [], users: [ben.id] })

    // the full-size file: only for people who can see the photo
    const { url } = await ben.ok<{ url: string }>('GET', `/vault/images/${toGroup}/original`)
    const res = await fetch(origin + url)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.equal((await cara.call('GET', `/vault/images/${toGroup}/original`)).status, 404)
    assert.equal((await ben.call('GET', `/vault/images/${justAna}/original`)).status, 404)
    // a link with its signature changed opens nothing
    assert.equal((await fetch(origin + url.replace(/sig=[^&]+/, 'sig=forged'))).status, 403)
  })

  it('lets someone who joins later see what the group already had', async () => {
    const ana = await person('Ana'), dan = await person('Dan')
    const g = await groupWith(ana)
    const early = await upload(ana, { groups: [g.group.id] })
    assert.equal((await dan.seen()).size, 0)
    await ana.ok('POST', `/groups/${g.group.id}/members`, { email: dan.email })
    assert.deepEqual(await dan.seen(), new Set([early]))
  })

  it('only shares to your own groups and the people in them', async () => {
    const ana = await person('Ana'), ben = await person('Ben'), cara = await person('Cara')
    const g = await groupWith(ana, ben)
    const other = await groupWith(cara)
    const it1 = item()
    assert.equal((await ana.call('POST', '/vault/uploads', { items: [it1], share: { groups: [other.group.id], users: [] } })).status, 403)
    assert.equal((await ana.call('POST', '/vault/uploads', { items: [it1], share: { groups: [], users: [cara.id] } })).status, 403)
    // and the owner alone changes who sees a photo, or deletes it
    const photo = await upload(ana, { groups: [g.group.id] })
    assert.equal((await ben.call('POST', '/vault/share', { ids: [photo], share: { groups: [], users: [] } })).status, 404)
    assert.equal((await ben.call('POST', '/vault/delete', { ids: [photo] })).status, 404)
    await ana.ok('POST', '/vault/share', { ids: [photo], share: { groups: [], users: [] } })
    assert.equal((await ben.seen()).size, 0)
    await ana.ok('POST', '/vault/delete', { ids: [photo] })
    assert.equal((await ana.seen()).size, 0)
  })

  it('checks what actually arrived before anyone can see it', async () => {
    const ana = await person('Ana')
    // nothing sent
    const never = item()
    await ana.ok('POST', '/vault/uploads', { items: [never], share: { groups: [], users: [] } })
    assert.equal((await ana.call('POST', `/vault/images/${never.id}/done`, {})).status, 422)
    // something that isn't a photo
    const fake = item()
    const { tickets } = await ana.ok<{ tickets: UploadTicket[] }>('POST', '/vault/uploads', { items: [fake], share: { groups: [], users: [] } })
    await put(tickets[0].thumb.url, JPEG)
    await put(tickets[0].original.url, Buffer.from('<script>alert(1)</script>'))
    const out = await ana.call<{ error: string }>('POST', `/vault/images/${fake.id}/done`, {})
    assert.equal(out.status, 422)
    assert.match(out.data.error, /doesn’t look like a photo/)
    assert.equal((await ana.seen()).size, 0)
    // a PUT without a valid link is refused
    assert.equal((await fetch(`${origin}/api/money/vault/blob?key=${ana.id}/x-original&exp=9999999999999&sig=nope`, { method: 'PUT', body: JPEG })).status, 403)
  })

  it('keeps to the per-person limit', async () => {
    const ana = await person('Ana')
    const items = Array.from({ length: 21 }, () => item())
    const out = await ana.call<{ error: string }>('POST', '/vault/uploads', { items, share: { groups: [], users: [] } })
    assert.equal(out.status, 409)
  })

  it('asks the admin what a removed member keeps', async () => {
    const ana = await person('Ana'), ben = await person('Ben'), eve = await person('Eve')
    const g = await groupWith(ana, ben, eve)
    const shared = await upload(ana, { groups: [g.group.id] })
    const direct = await upload(ana, { users: [ben.id] })

    // no choice given: the admin is asked first, and nothing changes
    const asked = await ana.call<{ code: string; count: number }>('DELETE', `/groups/${g.group.id}/members/${seatOf(g, 'Ben')}`)
    assert.equal(asked.status, 409)
    assert.equal(asked.data.code, 'photo-choice')
    assert.equal(asked.data.count, 1, 'a photo shared to Ben directly isn’t lost by leaving')
    assert.ok((await ben.ok<GroupState>('GET', `/groups/${g.group.id}`)).group)

    // keep: Ben holds on to what the group had, and gets nothing new
    await ana.ok('DELETE', `/groups/${g.group.id}/members/${seatOf(g, 'Ben')}?photos=keep`)
    assert.equal((await ben.call('GET', `/groups/${g.group.id}`)).status, 404)
    assert.deepEqual(await ben.seen(), new Set([shared, direct]))
    const later = await upload(ana, { groups: [g.group.id] })
    assert.ok(!(await ben.seen()).has(later))

    // Ana can still change who sees that photo without dropping Ben from it
    await ana.ok('POST', '/vault/share', { ids: [shared], share: { groups: [], users: [ben.id] } })
    assert.ok((await ben.seen()).has(shared))
    assert.equal((await ana.library()).names[ben.id], 'Ben')

    // revoke: Eve loses every group photo at once
    await ana.ok('DELETE', `/groups/${g.group.id}/members/${seatOf(g, 'Eve')}?photos=revoke`)
    assert.equal((await eve.seen()).size, 0)
  })

  it('doesn’t ask when the person has no group photos, or is leaving themselves', async () => {
    const ana = await person('Ana'), ben = await person('Ben'), cara = await person('Cara')
    const g = await groupWith(ana, ben, cara)
    await ana.ok('DELETE', `/groups/${g.group.id}/members/${seatOf(g, 'Ben')}`)
    await upload(ana, { groups: [g.group.id] })
    await cara.ok('DELETE', `/groups/${g.group.id}/members/${seatOf(g, 'Cara')}`)
    assert.equal((await cara.seen()).size, 0)
  })

  it('drops a deleted group’s shares', async () => {
    const ana = await person('Ana'), ben = await person('Ben')
    const g = await groupWith(ana, ben)
    const photo = await upload(ana, { groups: [g.group.id] })
    await ana.ok('DELETE', `/groups/${g.group.id}`)
    assert.equal((await ben.seen()).size, 0)
    assert.deepEqual(await ana.seen(), new Set([photo]))
  })

  it('names the place a photo was taken, once per rough location', async () => {
    const ana = await person('Ana')
    geocoded.length = 0
    const a = await upload(ana, {}, { lat: 38.7139, lng: -9.1334 })
    const b = await upload(ana, {}, { lat: 38.7141, lng: -9.1331 })
    for (let i = 0; i < 50; i++) {
      const lib = await ana.library()
      if (lib.images.filter(x => x.id === a || x.id === b).every(x => x.place)) break
      await new Promise(r => setTimeout(r, 20))
    }
    const lib = await ana.library()
    assert.equal(lib.images.find(x => x.id === a)!.place, 'Lisbon, Portugal')
    assert.equal(lib.images.find(x => x.id === b)!.place, 'Lisbon, Portugal')
    assert.equal(geocoded.length, 1)
    // the owner can name or rename it
    await ana.ok('POST', '/vault/place', { ids: [a], place: 'Alfama' })
    assert.equal((await ana.library()).images.find(x => x.id === a)!.place, 'Alfama')
  })
})

describe('reading EXIF', () => {
  // A minimal JPEG: SOI, then APP1 with a little-endian TIFF holding IFD0 → Exif IFD
  // (DateTimeOriginal) and → GPS IFD (38°42'50.4" N, 9°8'0.24" W).
  function jpegWithExif(): ArrayBuffer {
    const t: number[] = []
    const u16 = (n: number) => t.push(n & 255, n >> 8)
    const u32 = (n: number) => t.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24)
    const entry = (tag: number, type: number, count: number, value: number) => { u16(tag); u16(type); u32(count); u32(value) }
    // header
    t.push(0x49, 0x49); u16(42); u32(8)
    // IFD0 at 8: two entries → ends at 8 + 2 + 24 + 4 = 38
    u16(2); entry(0x8769, 4, 1, 38); entry(0x8825, 4, 1, 56); u32(0)
    // Exif IFD at 38: one entry → ends at 38 + 2 + 12 + 4 = 56; its string at 112
    u16(1); entry(0x9003, 2, 20, 112); u32(0)
    // GPS IFD at 56: four entries → ends at 56 + 2 + 48 + 4 = 110; pad to 112
    u16(4); entry(1, 2, 2, 0x4e); entry(2, 5, 3, 132); entry(3, 2, 2, 0x57); entry(4, 5, 3, 156); u32(0)
    t.push(0, 0)
    // 112: the date, 20 bytes
    for (const c of '2026:10:12 14:03:22\0') t.push(c.charCodeAt(0))
    // 132: latitude 38/1, 42/1, 504/10 · 156: longitude 9/1, 8/1, 24/100
    for (const [n, d] of [[38, 1], [42, 1], [504, 10], [9, 1], [8, 1], [24, 100]]) { u32(n); u32(d) }
    const app1 = [...Buffer.from('Exif\0\0', 'latin1'), ...t]
    const len = app1.length + 2
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xda]).buffer
  }

  it('finds when and where a photo was taken', () => {
    const facts = readExif(jpegWithExif())
    assert.equal(facts.takenAt, '2026-10-12T14:03:22')
    assert.ok(Math.abs(facts.lat! - 38.714) < 1e-3)
    assert.ok(Math.abs(facts.lng! + 9.1334) < 1e-3)
  })

  it('returns nothing for a file without EXIF', () => {
    assert.deepEqual(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda]).buffer), { takenAt: null, lat: null, lng: null })
    assert.deepEqual(readExif(new Uint8Array([1, 2, 3]).buffer), { takenAt: null, lat: null, lng: null })
  })
})
