import assert from 'node:assert/strict'
import { signInVia } from './signInForTests'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, beforeEach, describe, it } from 'node:test'
import { resetLimits } from './auth'
import { Db } from './db'
import { importSqliteOnce } from './importSqlite'
import { SQLITE_MIGRATIONS } from './sqliteSchema.fixture'
import { createMoneyApi } from './routes'
import type { GroupState, GroupSummary } from '../../src/money/types'
import type { SharedPlan, SharedTrip } from '../../src/trip/types'
import { defaultPicks, myVotes, rankDeck, rejectedPlaces, votingProgress } from '../../src/trip/votes'

// A trip shared with a group: one admin decides, everyone else votes and watches.

let server: Server
let base = ''
let dir = ''
let db: Db

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wayfarer-trip-'))
  db = await Db.local()
  const handle = createMoneyApi(db)
  server = createServer((req, res) => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
  await new Promise<void>(r => server.listen(0, r))
  const addr = server.address()
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}/api/money`
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
  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(base + path, {
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
}

async function person(name: string): Promise<Person> {
  const p = new Person()
  p.email = `${name.toLowerCase()}-${randomUUID()}@example.com`
  await signInVia((m, path, b) => p.call(m, path, b), p.email, name)
  return p
}

const place = (id: string) => ({ place: { id, name: id, kind: 'sight' }, verdict: 'keep' })
const plan = (over: Partial<SharedPlan> = {}): SharedPlan => ({
  phase: 'swipe',
  brief: { destination: 'tokyo', days: 2, travelers: 3, vibes: [] },
  deck: [{ id: 'p1', why: '', match: 1 }, { id: 'p2', why: '', match: 0.9 }, { id: 'p3', why: '', match: 0.8 }],
  days: [],
  hotelScores: [],
  candidates: {},
  messages: [{ id: 'hello', role: 'ai', text: 'Hi' }],
  thoughts: [],
  ...over,
})

// An admin, a friend who's joined, and someone added by email who hasn't signed up.
async function trip() {
  const admin = await person('Admin')
  const friend = await person('Friend')
  const pending = `pending-${randomUUID()}@example.com`
  const created = await admin.ok<GroupState>('POST', '/groups', { name: 'Tokyo', currency: 'USD', members: [friend.email, pending] })
  const groupId = created.group.id
  const friendSeat = created.members.find(m => m.joined && m.id !== created.me)!.id
  const publish = (p: SharedPlan = plan(), baseVersion = 0) => admin.call<{ planVersion: number }>('PUT', `/groups/${groupId}/plan`, { plan: p, baseVersion })
  return { admin, friend, groupId, adminSeat: created.me, friendSeat, pending, publish }
}

const read = (p: Person, groupId: string, since = -1) => p.ok<SharedTrip>('GET', `/groups/${groupId}/trip?planSince=${since}`)

describe('moving the live data from SQLite', () => {
  // the old file as production had it: both SQLite migrations, people, a trip, money and a photo
  function oldFile() {
    const path = join(dir, `old-${randomUUID()}.db`)
    const old = new DatabaseSync(path)
    old.exec('PRAGMA foreign_keys = ON')
    SQLITE_MIGRATIONS.forEach(sql => old.exec(sql))
    old.exec(`PRAGMA user_version = ${SQLITE_MIGRATIONS.length}`)
    const add = (sql: string, ...v: (string | number | null | Uint8Array)[]) => old.prepare(sql).run(...v)
    add('INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)', 'u1', 'Old', 'Old@Example.com', 1_700_000_000_000)
    add('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'u2', 'Pal', 'pal@example.com', 'scrypt$x', 1_700_000_000_001)
    add('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', 'hash1', 'u1', 1, 4_000_000_000_000)
    add('INSERT INTO money_groups (id, name, currency, invite_token, created_at, plan, plan_version) VALUES (?, ?, ?, ?, ?, ?, ?)', 'g1', 'Old trip', 'INR', 'tok-old', 1, '{"phase":"swipe"}', 3)
    add(`INSERT INTO members (id, group_id, user_id, name, role, created_at) VALUES ('m1', 'g1', 'u1', 'Old', 'owner', 1)`)
    add(`INSERT INTO members (id, group_id, user_id, name, created_at) VALUES ('m2', 'g1', 'u2', 'Pal', 2)`)
    add(`INSERT INTO members (id, group_id, email, name, created_at) VALUES ('m3', 'g1', 'Later@Example.com', 'Later', 3)`)
    add(`INSERT INTO expenses (id, group_id, title, amount, currency, fx_rate, base_amount, category, date, payers, split, shares, base_paid, base_owed, created_by, created_at, updated_at)
      VALUES ('e1', 'g1', 'Dinner', 400000, 'INR', 1, 400000, 'food', '2026-10-30', ?, ?, ?, ?, ?, 'm1', 5, 5)`,
      JSON.stringify([{ memberId: 'm1', amount: 400000 }]), JSON.stringify({ method: 'equal', entries: [{ memberId: 'm1', value: 1 }, { memberId: 'm2', value: 1 }] }),
      JSON.stringify({ m1: 200000, m2: 200000 }), JSON.stringify({ m1: 400000 }), JSON.stringify({ m1: 200000, m2: 200000 }))
    add(`INSERT INTO settlements (id, group_id, from_member, to_member, amount, currency, fx_rate, base_amount, date, method, created_by, created_at)
      VALUES ('s1', 'g1', 'm2', 'm1', 50000, 'INR', 1, 50000, '2026-10-31', 'upi', 'm2', 6)`)
    add(`INSERT INTO comments (id, group_id, expense_id, member_id, body, created_at) VALUES ('c1', 'g1', 'e1', 'm2', 'thanks!', 7)`)
    add(`INSERT INTO receipts (id, group_id, expense_id, mime, bytes, created_by, created_at) VALUES ('r1', 'g1', 'e1', 'image/png', ?, 'm1', 8)`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]))
    for (let i = 0; i < 3; i++) add(`INSERT INTO activity (group_id, kind, actor, detail, created_at) VALUES ('g1', 'expense-added', 'm1', '{}', ?)`, 10 + i)
    add(`INSERT INTO fx_cache (base, day, rates, fetched_at) VALUES ('INR', '2026-10-30', '{}', 9)`)
    add(`INSERT INTO votes (group_id, place_id, member_id, vote, updated_at) VALUES ('g1', 'p1', 'm2', 'like', 9)`)
    add(`INSERT INTO trip_notes (id, group_id, member_id, body, created_at) VALUES ('n1', 'g1', 'm1', 'Packing list?', 9)`)
    old.close()
    return path
  }

  it('copies every row, once, and the app carries on from it', async () => {
    const fresh = await Db.local()
    try {
      const path = oldFile()
      await importSqliteOnce(fresh, path)
      const count = async (table: string) => (await fresh.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n
      assert.deepEqual(
        await Promise.all(['users', 'sessions', 'money_groups', 'members', 'expenses', 'settlements', 'comments', 'receipts', 'activity', 'fx_cache', 'votes', 'trip_notes'].map(count)),
        [2, 1, 1, 3, 1, 1, 1, 1, 3, 1, 1, 1],
      )
      // addresses are matched case-blind, as SQLite did
      assert.equal((await fresh.one<{ email: string }>('SELECT email FROM users WHERE id = ?', 'u1'))!.email, 'old@example.com')
      assert.equal((await fresh.one<{ email: string }>('SELECT email FROM members WHERE id = ?', 'm3'))!.email, 'later@example.com')
      const group = (await fresh.one<{ plan: string; plan_version: number; created_at: number }>('SELECT plan, plan_version, created_at FROM money_groups WHERE id = ?', 'g1'))!
      assert.deepEqual({ ...group }, { plan: '{"phase":"swipe"}', plan_version: 3, created_at: 1 })
      const expense = (await fresh.one<{ amount: number; fx_rate: number; shares: string }>('SELECT amount, fx_rate, shares FROM expenses WHERE id = ?', 'e1'))!
      assert.deepEqual({ ...expense, shares: JSON.parse(expense.shares) }, { amount: 400000, fx_rate: 1, shares: { m1: 200000, m2: 200000 } })
      const photo = (await fresh.one<{ bytes: Uint8Array }>('SELECT bytes FROM receipts WHERE id = ?', 'r1'))!
      assert.deepEqual([...photo.bytes], [0x89, 0x50, 0x4e, 0x47, 0, 255])

      // the feed continues after the copied entries rather than colliding with them
      await fresh.run(`INSERT INTO activity (group_id, kind, detail, created_at) VALUES ('g1', 'comment', '{}', 20)`)
      assert.equal((await fresh.one<{ seq: number }>('SELECT MAX(seq) AS seq FROM activity'))!.seq, 4)

      // a second start finds it done, even with the file still there
      await importSqliteOnce(fresh, path)
      assert.equal(await count('users'), 2)
    } finally {
      await fresh.close()
    }
  })

  it('people sign in as before, with their seats, history and balances', async () => {
    const fresh = await Db.local()
    const handle = createMoneyApi(fresh)
    const local = createServer((req, res) => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
    await new Promise<void>(r => local.listen(0, r))
    try {
      await importSqliteOnce(fresh, oldFile())
      const url = `http://localhost:${(local.address() as { port: number }).port}/api/money`
      // a session from before email codes opens nothing until the address is confirmed
      let cookie = ''
      const send = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
        const set = res.headers.get('set-cookie')
        if (set) cookie = set.split(';')[0]
        const text = await res.text()
        return { status: res.status, data: text ? JSON.parse(text) : {} }
      }
      assert.equal((await fetch(`${url}/groups`, { headers: { cookie: 'wf_session=whatever' } })).status, 401)
      const me = await signInVia(send, 'OLD@example.com')
      assert.equal(me.id, 'u1')
      const get = async <T>(path: string) => await (await fetch(`${url}${path}`, { headers: { cookie } })).json() as T
      const [summary] = (await get<{ groups: GroupSummary[] }>('/groups')).groups
      assert.deepEqual({ name: summary.name, role: summary.role, phase: summary.phase, myNet: summary.myNet }, { name: 'Old trip', role: 'owner', phase: 'swipe', myNet: 150000 })
      const state = await get<GroupState>('/groups/g1')
      assert.deepEqual(state.expenses.map(e => [e.title, e.receipts]), [['Dinner', ['r1']]])
      assert.deepEqual(state.comments.map(c => c.body), ['thanks!'])
      // the seat waiting for an address is still waiting, and joins when that address signs up
      assert.equal(state.members.find(m => m.id === 'm3')!.joined, false)
      const mine = cookie
      await signInVia(async (method, path, body) => { const res = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json() } }, 'later@example.com', 'Later')
      cookie = mine
      assert.equal((await get<GroupState>('/groups/g1')).members.find(m => m.id === 'm3')!.joined, true)
    } finally {
      local.closeAllConnections()
      await new Promise(r => local.close(r))
      await fresh.close()
    }
  })

  it('won’t mix the old data into a database that already has people in it', async () => {
    const fresh = await Db.local()
    try {
      await fresh.run(`INSERT INTO users (id, name, email, created_at) VALUES ('x', 'New', 'new@example.com', 1)`)
      await assert.rejects(importSqliteOnce(fresh, oldFile()), /already has accounts/)
      await assert.rejects(importSqliteOnce(fresh, join(dir, 'missing.db')), /no file there/)
      assert.equal((await fresh.one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n, 1)
    } finally {
      await fresh.close()
    }
  })
})

describe('the schema', () => {
  it('is set up once, and starting again changes nothing', async () => {
    const path = join(dir, 'pg')
    const first = await Db.local(path)
    await first.run(`INSERT INTO users (id, name, email, created_at) VALUES ('u', 'Kept', 'kept@example.com', 1)`)
    await first.close()
    const again = await Db.local(path)
    assert.equal((await again.one<{ name: string }>('SELECT name FROM users'))!.name, 'Kept')
    await again.close()
  })

  it('refuses an address with capitals, which would slip past an email lookup', async () => {
    await assert.rejects(db.run(`INSERT INTO users (id, name, email, created_at) VALUES ('caps', 'Caps', 'Caps@example.com', 1)`))
  })
})

describe('the admin runs the trip', () => {
  it('only the admin can publish the plan', async () => {
    const { friend, groupId, publish } = await trip()
    assert.equal((await friend.call('PUT', `/groups/${groupId}/plan`, { plan: plan(), baseVersion: 0 })).status, 403)
    const out = await publish()
    assert.equal(out.status, 200)
    assert.equal(out.data.planVersion, 1)
    const t = await read(friend, groupId)
    assert.equal(t.plan?.phase, 'swipe')
    assert.equal(t.role, 'member')
  })

  it('outsiders and people signed out can’t read it', async () => {
    const { groupId, publish } = await trip()
    await publish()
    assert.equal((await new Person().call('GET', `/groups/${groupId}/trip`)).status, 401)
    assert.equal((await (await person('Out')).call('GET', `/groups/${groupId}/trip`)).status, 404)
  })

  it('someone added by email sees it as soon as they sign up', async () => {
    const { groupId, pending, publish } = await trip()
    await publish()
    const newcomer = new Person()
    await signInVia((m, path, b) => newcomer.call(m, path, b), pending, 'New')
    assert.equal((await read(newcomer, groupId)).plan?.phase, 'swipe')
  })

  it('a stale copy can’t overwrite newer changes', async () => {
    const { groupId, admin, publish } = await trip()
    await publish(plan({ phase: 'review' }))
    const stale = await admin.call<{ planVersion: number }>('PUT', `/groups/${groupId}/plan`, { plan: plan({ phase: 'swipe' }), baseVersion: 0 })
    assert.equal(stale.status, 409)
    assert.equal(stale.data.planVersion, 1)
    assert.equal((await read(admin, groupId)).plan?.phase, 'review')
  })

  it('skips sending the plan when you already have this version', async () => {
    const { friend, groupId, publish } = await trip()
    await publish()
    const unchanged = await read(friend, groupId, 1)
    assert.equal(unchanged.plan, null)
    assert.equal(unchanged.hasPlan, true)
    assert.equal(unchanged.planVersion, 1)
  })

  it('refuses a plan that isn’t the right shape or is far too big', async () => {
    const { admin, groupId } = await trip()
    const put = (p: unknown) => admin.call('PUT', `/groups/${groupId}/plan`, { plan: p, baseVersion: 0 })
    assert.equal((await put({ phase: 'nonsense' })).status, 400)
    assert.equal((await put({ ...plan(), days: 'lots' })).status, 400)
    assert.equal((await put({ ...plan(), messages: Array.from({ length: 500 }, (_, i) => ({ id: String(i), role: 'ai', text: 'x' })) })).status, 400)
    assert.equal((await put({ ...plan(), messages: [{ id: 'x', role: 'ai', text: 'x'.repeat(5 * 1024 * 1024) }] })).status, 413)
  })

  it('a real-sized plan fits', async () => {
    const { groupId, publish, friend } = await trip()
    const candidates = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`place-${i}`, { place: { id: `place-${i}`, blurb: 'x'.repeat(800) }, verdict: 'keep' }]))
    assert.equal((await publish(plan({ candidates: candidates as SharedPlan['candidates'] }))).status, 200)
    assert.equal(Object.keys((await read(friend, groupId)).plan!.candidates).length, 200)
  })

  it('also keeps the money screens’ copy of the trip up to date', async () => {
    const { admin, friend, groupId } = await trip()
    const summary = { name: 'Tokyo · 2 days', city: 'Tokyo', country: 'Japan', startDate: null, days: 2, travelers: 3, localCurrency: 'JPY', plannedUsd: {}, budgetUsd: null, stops: [] }
    await admin.ok('PUT', `/groups/${groupId}/plan`, { plan: plan(), summary, baseVersion: 0 })
    assert.equal((await friend.ok<GroupState>('GET', `/groups/${groupId}`)).group.trip?.city, 'Tokyo')
  })
})

describe('what normal users can’t change', () => {
  it('group settings, people and the link stay with the admin', async () => {
    const { friend, groupId, adminSeat } = await trip()
    const g = `/groups/${groupId}`
    for (const body of [{ name: 'Mine' }, { simplify: false }, { budget: 1 }, { currency: 'INR' }]) {
      assert.equal((await friend.call('PATCH', g, body)).status, 403, JSON.stringify(body))
    }
    assert.equal((await friend.call('POST', `${g}/members`, { email: `${randomUUID()}@example.com` })).status, 403)
    assert.equal((await friend.call('POST', `${g}/members`, { name: 'Sneak' })).status, 403)
    assert.equal((await friend.call('PATCH', `${g}/members/${adminSeat}`, { name: 'Not admin' })).status, 403)
    assert.equal((await friend.call('POST', `${g}/invite`, {})).status, 403)
    assert.equal((await friend.call('DELETE', g)).status, 403)
  })

  it('never see the invite link, in either view', async () => {
    const { admin, friend, groupId } = await trip()
    const token = (await read(admin, groupId)).inviteToken
    assert.ok(token.length > 10)
    assert.equal((await read(friend, groupId)).inviteToken, '')
    const money = await friend.ok<GroupState>('GET', `/groups/${groupId}`)
    assert.equal(money.group.inviteToken, '')
    assert.ok(!JSON.stringify(money).includes(token))
  })

  it('can still rename themselves, set their own budget, and leave', async () => {
    const { friend, groupId, friendSeat } = await trip()
    await friend.ok('PATCH', `/groups/${groupId}/members/${friendSeat}`, { name: 'New name', budget: 500 })
    await friend.ok('DELETE', `/groups/${groupId}/members/${friendSeat}`)
    assert.equal((await friend.call('GET', `/groups/${groupId}/trip`)).status, 404)
  })

  it('can do everything in the money panel: add, edit and delete anyone’s spending', async () => {
    const { admin, friend, groupId, adminSeat, friendSeat } = await trip()
    const expense = { id: randomUUID(), title: 'Dinner', amount: 3000, currency: 'USD', fxRate: 1, category: 'food', date: '2026-11-10', notes: '', private: false, payers: [{ memberId: adminSeat, amount: 3000 }], split: { method: 'equal', entries: [{ memberId: adminSeat, value: 1 }, { memberId: friendSeat, value: 1 }] } }
    await admin.ok('POST', `/groups/${groupId}/expenses`, expense)
    await friend.ok('PUT', `/groups/${groupId}/expenses/${expense.id}`, { ...expense, title: 'Edited by friend', baseRev: 1 })
    let s = await admin.ok<GroupState>('GET', `/groups/${groupId}`)
    assert.equal(s.expenses[0].title, 'Edited by friend')
    assert.equal(s.activity[0].kind, 'expense-edited')
    assert.equal(s.activity[0].actor, friendSeat)
    await friend.ok('DELETE', `/groups/${groupId}/expenses/${expense.id}`)
    s = await admin.ok<GroupState>('GET', `/groups/${groupId}`)
    assert.ok(s.expenses[0].deletedAt)
    await friend.ok('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: friendSeat, to: adminSeat, amount: 100, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
  })
})

describe('voting', () => {
  it('everyone votes on the same tiles, and changing your mind replaces your vote', async () => {
    const { admin, friend, groupId, adminSeat, friendSeat, publish } = await trip()
    await publish()
    await admin.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }, { placeId: 'p2', vote: 'nope' }] })
    await friend.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }] })
    await friend.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'nope' }, { placeId: 'p3', vote: 'like' }] })
    const t = await read(admin, groupId)
    assert.deepEqual(myVotes(t.votes, friendSeat), { p1: 'nope', p3: 'like' })
    assert.deepEqual(myVotes(t.votes, adminSeat), { p1: 'like', p2: 'nope' })
    assert.equal(t.votes.length, 4)
  })

  it('a vote can be taken back', async () => {
    const { friend, groupId, friendSeat, publish } = await trip()
    await publish()
    await friend.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }] })
    await friend.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: null }] })
    assert.deepEqual(myVotes((await read(friend, groupId)).votes, friendSeat), {})
  })

  it('only places in this trip, only by people in the group', async () => {
    const { friend, groupId, friendSeat, publish } = await trip()
    assert.equal((await friend.call('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }] })).status, 409, 'nothing to vote on yet')
    await publish(plan({ candidates: { extra: place('extra') } as unknown as SharedPlan['candidates'] }))
    const mixed = await friend.ok<{ skipped: string[] }>('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'made-up', vote: 'like' }, { placeId: 'p1', vote: 'like' }] })
    assert.deepEqual(mixed.skipped, ['made-up'], 'one out-of-date vote doesn’t hold up the others')
    assert.deepEqual(Object.keys(myVotes((await read(friend, groupId)).votes, friendSeat)), ['p1'])
    await friend.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'extra', vote: 'like' }] })
    const out = await person('Out')
    assert.equal((await out.call('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }] })).status, 404)
  })

  it('someone who leaves no longer counts', async () => {
    const { admin, friend, groupId, friendSeat, publish } = await trip()
    await publish()
    await friend.ok('POST', `/groups/${groupId}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }] })
    await friend.ok('DELETE', `/groups/${groupId}/members/${friendSeat}`)
    assert.equal((await read(admin, groupId)).votes.length, 0)
  })
})

describe('trip chat', () => {
  it('anyone can post, everyone sees it, and retries don’t double up', async () => {
    const { admin, friend, groupId, friendSeat } = await trip()
    const note = { id: randomUUID(), body: 'Can we do Skytree at sunset?' }
    await friend.ok('POST', `/groups/${groupId}/notes`, note)
    await friend.ok('POST', `/groups/${groupId}/notes`, note)
    const t = await read(admin, groupId)
    assert.equal(t.notes.length, 1)
    assert.equal(t.notes[0].memberId, friendSeat)
    assert.equal(t.notes[0].body, note.body)
  })

  it('outsiders can’t post or read, and an id from another group can’t be reused', async () => {
    const { friend, groupId } = await trip()
    const id = randomUUID()
    await friend.ok('POST', `/groups/${groupId}/notes`, { id, body: 'hi' })
    const out = await person('Out')
    assert.equal((await out.call('POST', `/groups/${groupId}/notes`, { id: randomUUID(), body: 'hi' })).status, 404)
    const other = await trip()
    assert.equal((await other.friend.call('POST', `/groups/${other.groupId}/notes`, { id, body: 'taken' })).status, 409)
    assert.equal((await friend.call('POST', `/groups/${groupId}/notes`, { id: randomUUID(), body: '   ' })).status, 400)
  })
})

describe('live updates', () => {
  it('tell friends the plan moved, and a removed person’s stream closes without harm', async () => {
    const { admin, friend, groupId, friendSeat, publish } = await trip()
    const ctrl = new AbortController()
    const res = await fetch(`${base}/groups/${groupId}/live`, { headers: { Cookie: friend.cookie }, signal: ctrl.signal })
    const reader = res.body!.getReader()
    const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace('data: ', '')) as { version: number; planVersion: number }
    assert.equal((await next()).planVersion, 0)
    await publish()
    assert.equal((await next()).planVersion, 1)
    await admin.ok('DELETE', `/groups/${groupId}/members/${friendSeat}`)
    await publish(plan({ phase: 'review' }), 1)
    assert.equal((await read(admin, groupId)).plan?.phase, 'review')
    ctrl.abort()
  })
})

describe('the group list', () => {
  it('says each person’s role and how far the trip has got', async () => {
    const { admin, friend, groupId, publish } = await trip()
    await publish(plan({ phase: 'review' }))
    const row = (g: { groups: GroupSummary[] }) => g.groups.find(x => x.id === groupId)!
    assert.equal(row(await admin.ok('GET', '/groups')).role, 'owner')
    const theirs = row(await friend.ok('GET', '/groups'))
    assert.equal(theirs.role, 'member')
    assert.equal(theirs.phase, 'review')
  })
})

describe('most liked places', () => {
  const deck = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, why: '', match: 1 - i / 10 }))
  const vote = (placeId: string, memberId: string, v: 'like' | 'nope') => ({ placeId, memberId, vote: v })
  const votes = [
    vote('a', '1', 'like'), vote('a', '2', 'like'), vote('a', '3', 'nope'),
    vote('b', '1', 'like'), vote('b', '2', 'like'), vote('b', '3', 'like'),
    vote('c', '1', 'nope'), vote('c', '2', 'nope'), vote('c', '3', 'like'),
    vote('d', '1', 'like'), vote('d', '2', 'nope'),
  ]

  it('ranks by net likes, then total likes, then the deck’s order', () => {
    assert.deepEqual(rankDeck(deck, votes).map(t => t.placeId), ['b', 'a', 'd', 'e', 'c'])
    const tied = [vote('e', '1', 'like'), vote('a', '1', 'like')]
    assert.deepEqual(rankDeck(deck, tied).map(t => t.placeId).slice(0, 2), ['a', 'e'])
  })
  it('picks what at least as many liked as disliked, up to what fits', () => {
    assert.deepEqual(defaultPicks(deck, votes, 10), ['b', 'a', 'd'])
    assert.deepEqual(defaultPicks(deck, votes, 2), ['b', 'a'])
    assert.deepEqual(defaultPicks(deck, [], 5), [], 'nobody liked anything')
  })
  it('won’t pick something nobody liked, even a tie at zero', () => {
    assert.ok(!defaultPicks(deck, votes, 10).includes('e'))
  })
  it('remembers what the group turned down', () => {
    assert.deepEqual(rejectedPlaces(deck, votes), ['c'])
  })
  it('votes on places no longer in the deck don’t count', () => {
    assert.deepEqual(defaultPicks(deck, [vote('gone', '1', 'like')], 5), [])
  })
  it('tracks who’s still voting, leaving out people who haven’t signed in', () => {
    const people = [
      { id: '1', name: 'A', role: 'owner' as const, joined: true, waitingEmail: null },
      { id: '2', name: 'B', role: 'member' as const, joined: true, waitingEmail: null },
      { id: '3', name: 'C', role: 'member' as const, joined: false, waitingEmail: 'c•••@x.com' },
    ]
    const small = deck.slice(0, 2)
    const p = votingProgress(small, [vote('a', '1', 'like'), vote('b', '1', 'nope'), vote('a', '2', 'like')], people)
    assert.deepEqual(p.voters.map(x => x.id), ['1', '2'])
    assert.deepEqual(p.finished.map(x => x.id), ['1'])
    assert.deepEqual(p.waiting.map(x => x.id), ['2'])
    assert.deepEqual(p.started.map(x => x.id), ['1', '2'])
  })
})
