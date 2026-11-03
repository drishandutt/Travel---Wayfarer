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
import { getRates } from './fx'
import type { Expense, GroupState, GroupSummary, InvitePreview } from '../../src/money/types'
import { netBalances } from '../../src/money/engine'

// The whole API over real HTTP, with several people acting at once. This is where
// "can someone see or change what they shouldn't" gets checked.

let server: Server
let base = ''
let dir = ''
let db: Db

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wayfarer-money-'))
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

// One person's browser: keeps their cookie between requests.
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
  state(groupId: string) { return this.ok<GroupState>('GET', `/groups/${groupId}`) }
}

async function person(name: string): Promise<Person> {
  const p = new Person()
  p.email = `${name.toLowerCase().replace(/\W+/g, '')}-${randomUUID()}@example.com`
  await p.ok('POST', '/auth/email', { email: p.email, name })
  return p
}

const expenseBody = (over: Record<string, unknown>) => ({
  id: randomUUID(), title: 'Dinner', amount: 3000, currency: 'USD', fxRate: 1, category: 'food', date: '2026-11-10', notes: '', private: false, ...over,
})
const equalBetween = (...ids: string[]) => ({ method: 'equal', entries: ids.map(memberId => ({ memberId, value: 1 })) })

// A group with two people who've joined and one name waiting to be claimed.
async function trio() {
  const asha = await person('Asha')
  const ben = await person('Ben')
  const created = await asha.ok<GroupState>('POST', '/groups', { name: 'Tokyo', currency: 'USD', members: ['Cara'] })
  const groupId = created.group.id
  await ben.ok('POST', `/invite/${created.group.inviteToken}/join`, {})
  const s = await asha.state(groupId)
  const idOf = (n: string) => s.members.find(m => m.name === n)!.id
  return { asha, ben, groupId, token: s.group.inviteToken, A: idOf('Asha'), B: idOf('Ben'), C: idOf('Cara') }
}

describe('accounts', () => {
  it('starts with just an email and a name, stays signed in, and signs out', async () => {
    const p = new Person()
    const mail = `${randomUUID()}@example.com`
    assert.equal((await p.call('GET', '/groups')).status, 401)
    assert.deepEqual(await p.ok('POST', '/auth/email', { email: mail }), { next: 'name' })
    assert.equal((await p.call('GET', '/groups')).status, 401, 'asking for a name signs nobody in')
    const { user } = await p.ok<{ user: { name: string; email: string; hasPassword: boolean } }>('POST', '/auth/email', { email: mail, name: '  Dev  ' })
    assert.equal(user.name, 'Dev')
    assert.equal(user.email, mail)
    assert.equal(user.hasPassword, false)
    assert.equal((await p.call('GET', '/groups')).status, 200)
    await p.ok('POST', '/auth/logout', {})
    assert.equal((await p.call('GET', '/groups')).status, 401)
  })

  it('the same email reaches the same account from any device, with nothing to confirm', async () => {
    const phone = await person('Dev')
    const g = await phone.ok<GroupState>('POST', '/groups', { name: 'Kept', currency: 'USD' })
    const laptop = new Person()
    await laptop.ok('POST', '/auth/email', { email: phone.email.toUpperCase() })
    const { groups } = await laptop.ok<{ groups: GroupSummary[] }>('GET', '/groups')
    assert.deepEqual(groups.map(x => x.id), [g.group.id])
    assert.equal((await laptop.state(g.group.id)).me, g.me)
  })

  it('refuses what isn’t an email', async () => {
    for (const bad of ['', 'nope', 'a@', '@b.com']) assert.equal((await new Person().call('POST', '/auth/email', { email: bad, name: 'A' })).status, 400, bad)
  })

  it('a password, once added, is required', async () => {
    const phone = await person('Dev')
    await phone.ok('POST', '/auth/secure', { email: phone.email, password: 'long enough pw' })
    const laptop = new Person()
    assert.deepEqual(await laptop.ok('POST', '/auth/email', { email: phone.email }), { next: 'password' })
    assert.equal((await laptop.call('GET', '/groups')).status, 401)
    assert.equal((await laptop.call('POST', '/auth/email', { email: phone.email, password: 'wrong password' })).status, 401)
    assert.equal((await laptop.call('GET', '/groups')).status, 401)
    await laptop.ok('POST', '/auth/email', { email: phone.email, password: 'long enough pw' })
    assert.equal((await laptop.call('GET', '/groups')).status, 200)
  })

  it('never stores a password as written, and refuses a short one or an email that’s taken', async () => {
    const a = await person('A')
    const b = await person('B')
    assert.equal((await a.call('POST', '/auth/secure', { email: a.email, password: 'short' })).status, 400)
    await a.ok('POST', '/auth/secure', { email: a.email, password: 'hunter2hunter2' })
    const row = (await db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?', a.email))!
    assert.ok(row.password_hash.startsWith('scrypt$'))
    assert.ok(!row.password_hash.includes('hunter2'))
    assert.equal((await b.call('POST', '/auth/secure', { email: a.email })).status, 409)
    const sessions = await db.all<{ token_hash: string }>('SELECT token_hash FROM sessions')
    assert.ok(!sessions.some(x => a.cookie.includes(x.token_hash)), 'session tokens are stored hashed')
  })

  it('changing a password needs the current one and signs out other devices', async () => {
    const a = await person('Dev')
    await a.ok('POST', '/auth/secure', { email: a.email, password: 'first password' })
    const b = new Person()
    await b.ok('POST', '/auth/email', { email: a.email, password: 'first password' })
    assert.equal((await a.call('POST', '/auth/secure', { email: a.email, password: 'second password', current: 'nope' })).status, 403)
    await a.ok('POST', '/auth/secure', { email: a.email, password: 'second password', current: 'first password' })
    assert.equal((await b.call('GET', '/groups')).status, 401)
    assert.equal((await a.call('GET', '/groups')).status, 200)
  })

  it('changing your email moves the account, and the old address opens nothing', async () => {
    const a = await person('Dev')
    const g = await a.ok<GroupState>('POST', '/groups', { name: 'Kept', currency: 'USD' })
    const moved = `${randomUUID()}@example.com`
    await a.ok('POST', '/auth/secure', { email: moved })
    const elsewhere = new Person()
    await elsewhere.ok('POST', '/auth/email', { email: moved })
    assert.equal((await elsewhere.state(g.group.id)).me, g.me)
    assert.deepEqual(await new Person().ok('POST', '/auth/email', { email: a.email }), { next: 'name' })
  })

  it('slows down password guessing', async () => {
    const owner = await person('A')
    await owner.ok('POST', '/auth/secure', { email: owner.email, password: 'correct horse' })
    const attacker = new Person()
    const codes: number[] = []
    for (let i = 0; i < 10; i++) codes.push((await attacker.call('POST', '/auth/email', { email: owner.email, password: `guess number ${i}` })).status)
    assert.deepEqual(codes.slice(0, 8), Array(8).fill(401))
    assert.equal(codes[9], 429)
    assert.equal((await attacker.call('POST', '/auth/email', { email: owner.email, password: 'correct horse' })).status, 429, 'even the right one, until it cools down')
  })

  it('limits how many accounts one address can create', async () => {
    const codes: number[] = []
    for (let i = 0; i < 31; i++) codes.push((await new Person().call('POST', '/auth/email', { email: `bot${i}-${randomUUID()}@example.com`, name: `Bot ${i}` })).status)
    assert.equal(codes[29], 200)
    assert.equal(codes[30], 429)
  })
})

describe('access by email', () => {
  it('someone added by email gets the group as soon as they sign in, with no link', async () => {
    const { asha, groupId, A } = await trio()
    const mail = `priya.k-${randomUUID()}@example.com`
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { email: mail })
    const seat = (await asha.state(groupId)).members.find(m => m.id === memberId)!
    assert.equal(seat.joined, false)
    assert.match(seat.name, /^Priya k/)
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 2000, payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A, memberId) }))

    const priya = new Person()
    await priya.ok('POST', '/auth/email', { email: mail, name: 'Priya' })
    const { groups } = await priya.ok<{ groups: GroupSummary[] }>('GET', '/groups')
    assert.deepEqual(groups.map(g => g.id), [groupId])
    const s = await priya.state(groupId)
    assert.equal(s.me, memberId, 'the same seat, with its history')
    assert.equal(s.members.find(m => m.id === memberId)?.name, 'Priya')
    assert.equal(netBalances(s.expenses, s.settlements)[memberId], -1000)
    assert.equal(s.activity[0].kind, 'member-joined')
  })

  it('someone who already has an account is in straight away', async () => {
    const { asha, groupId } = await trio()
    const dev = await person('Dev')
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { email: dev.email })
    assert.equal((await dev.state(groupId)).me, memberId)
    assert.equal((await asha.state(groupId)).members.find(m => m.id === memberId)?.joined, true)
  })

  it('the same address can’t be added twice, whatever the case', async () => {
    const { asha, groupId } = await trio()
    const dev = await person('Dev')
    const waiting = `${randomUUID()}@example.com`
    await asha.ok('POST', `/groups/${groupId}/members`, { email: waiting })
    assert.equal((await asha.call('POST', `/groups/${groupId}/members`, { email: waiting.toUpperCase() })).status, 409)
    await asha.ok('POST', `/groups/${groupId}/members`, { email: dev.email })
    assert.equal((await asha.call('POST', `/groups/${groupId}/members`, { email: dev.email.toUpperCase() })).status, 409)
    assert.equal((await asha.call('POST', `/groups/${groupId}/members`, { email: asha.email })).status, 409, 'yourself either')
  })

  it('a seat reserved for an address can’t be taken through the invite link', async () => {
    const { asha, groupId, token } = await trio()
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { name: 'Priya', email: `${randomUUID()}@example.com` })
    const preview = await new Person().ok<InvitePreview>('GET', `/invite/${token}`)
    assert.equal(preview.members.find(m => m.id === memberId)?.claimable, false)
    const sneak = await person('Sneak')
    assert.equal((await sneak.call('POST', `/invite/${token}/join`, { claim: memberId })).status, 409)
  })

  it('other members never see a full address', async () => {
    const { asha, ben, groupId } = await trio()
    const waiting = `priya-${randomUUID()}@example.com`
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { email: waiting })
    const dev = await person('Dev')
    await asha.ok('POST', `/groups/${groupId}/members`, { email: dev.email })
    for (const viewer of [asha, ben, dev]) {
      const seen = JSON.stringify(await viewer.state(groupId))
      assert.ok(!seen.includes(waiting), 'not a waiting one')
      assert.ok(!seen.includes(dev.email), 'not a joined one')
      assert.ok(!seen.includes(asha.email))
    }
    assert.match((await ben.state(groupId)).members.find(m => m.id === memberId)!.waitingEmail!, /^pr•••@example\.com$/)
    assert.ok(!JSON.stringify(await new Person().ok('GET', `/invite/${(await asha.state(groupId)).group.inviteToken}`)).includes('example.com'), 'nor in the invite preview')
  })

  it('needs a real address, or at least a name, and a seat in the group to add anyone', async () => {
    const { asha, groupId } = await trio()
    assert.equal((await asha.call('POST', `/groups/${groupId}/members`, { email: 'not an email' })).status, 400)
    assert.equal((await asha.call('POST', `/groups/${groupId}/members`, {})).status, 400)
    assert.equal((await (await person('Out')).call('POST', `/groups/${groupId}/members`, { email: `${randomUUID()}@example.com` })).status, 404)
    assert.equal((await new Person().call('POST', `/groups/${groupId}/members`, { email: `${randomUUID()}@example.com` })).status, 401)
  })

  it('a typo in an invite can be fixed, and the wrong address then gets nothing', async () => {
    const { asha, groupId } = await trio()
    const typo = `${randomUUID()}@exmaple.com`
    const right = `${randomUUID()}@example.com`
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { name: 'Priya', email: typo })
    await asha.ok('PATCH', `/groups/${groupId}/members/${memberId}`, { email: right })
    const stranger = new Person()
    await stranger.ok('POST', '/auth/email', { email: typo, name: 'Stranger' })
    assert.equal((await stranger.call('GET', `/groups/${groupId}`)).status, 404)
    const priya = new Person()
    await priya.ok('POST', '/auth/email', { email: right, name: 'Priya' })
    assert.equal((await priya.state(groupId)).me, memberId)
  })

  it('a name-only seat can be given an address, and an address with an account links at once', async () => {
    const { asha, groupId, C } = await trio()
    const cara = await person('Cara')
    await asha.ok('PATCH', `/groups/${groupId}/members/${C}`, { email: cara.email })
    assert.equal((await cara.state(groupId)).me, C)
    assert.equal((await asha.call('PATCH', `/groups/${groupId}/members/${C}`, { email: `${randomUUID()}@example.com` })).status, 409, 'once joined, it’s theirs')
  })

  it('emails listed when creating a group work the same way', async () => {
    const owner = await person('Owner')
    const dev = await person('Dev')
    const waiting = `${randomUUID()}@example.com`
    const g = await owner.ok<GroupState>('POST', '/groups', { name: 'G', currency: 'USD', members: [dev.email, waiting, 'Cara', waiting, owner.email] })
    assert.equal(g.members.length, 4, 'owner, dev, waiting, Cara: no duplicates, and not the owner twice')
    assert.equal((await dev.state(g.group.id)).group.id, g.group.id)
    const newcomer = new Person()
    await newcomer.ok('POST', '/auth/email', { email: waiting, name: 'New' })
    assert.equal((await newcomer.state(g.group.id)).group.id, g.group.id)
    assert.equal((await owner.call('POST', '/groups', { name: 'G', currency: 'USD', members: ['bad@'] })).status, 400)
  })

  it('changing your email to one that’s waiting brings the seat along', async () => {
    const { asha, groupId } = await trio()
    const address = `${randomUUID()}@example.com`
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { email: address })
    const dev = await person('Dev')
    await dev.ok('POST', '/auth/secure', { email: address })
    assert.equal((await dev.state(groupId)).me, memberId)
  })

  it('someone with a seat already doesn’t get a second one when an address catches up', async () => {
    const { asha, ben, groupId, B } = await trio()
    const address = `${randomUUID()}@example.com`
    await asha.ok('POST', `/groups/${groupId}/members`, { name: 'Ben again', email: address })
    await ben.ok('POST', '/auth/secure', { email: address })
    const s = await ben.state(groupId)
    assert.equal(s.me, B)
    assert.equal(s.members.filter(m => m.joined && m.name.startsWith('Ben')).length, 1)
  })

  it('someone removed doesn’t get back in by signing in again, but can be added back with their history', async () => {
    const { asha, ben, groupId, B } = await trio()
    await asha.ok('DELETE', `/groups/${groupId}/members/${B}`)
    const again = new Person()
    await again.ok('POST', '/auth/email', { email: ben.email })
    assert.equal((await again.call('GET', `/groups/${groupId}`)).status, 404)
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { email: ben.email })
    assert.equal(memberId, B)
    assert.equal((await again.state(groupId)).me, B)
  })

  it('removing someone who was waiting cancels the invite', async () => {
    const { asha, groupId } = await trio()
    const address = `${randomUUID()}@example.com`
    const { memberId } = await asha.ok<{ memberId: string }>('POST', `/groups/${groupId}/members`, { email: address })
    await asha.ok('DELETE', `/groups/${groupId}/members/${memberId}`)
    const late = new Person()
    await late.ok('POST', '/auth/email', { email: address, name: 'Late' })
    assert.equal((await late.call('GET', `/groups/${groupId}`)).status, 404)
  })

  it('the invite link still works for people nobody listed', async () => {
    const { asha, groupId, token } = await trio()
    const friend = await person('Friend')
    await friend.ok('POST', `/invite/${token}/join`, {})
    assert.ok((await asha.state(groupId)).members.some(m => m.name === 'Friend' && m.joined))
  })
})

describe('joining a group', () => {
  it('previews the invite, then lets a new person claim a waiting name', async () => {
    const { asha, token, C, groupId } = await trio()
    const stranger = new Person()
    const preview = await stranger.ok<InvitePreview>('GET', `/invite/${token}`)
    assert.equal(preview.groupName, 'Tokyo')
    assert.deepEqual(preview.members.filter(m => m.claimable).map(m => m.name), ['Cara'])

    const cara = await person('Cara Lopez')
    await cara.ok('POST', `/invite/${token}/join`, { claim: C })
    const s = await cara.state(groupId)
    assert.equal(s.me, C)
    assert.equal(s.members.find(m => m.id === C)?.joined, true)
    assert.equal((await asha.state(groupId)).members.length, 3, 'no extra seat')
  })

  it('a seat can only be claimed once, and only an unclaimed one', async () => {
    const { token, B, C } = await trio()
    const x = await person('X')
    assert.equal((await x.call('POST', `/invite/${token}/join`, { claim: B })).status, 409, 'Ben already has this seat')
    await x.ok('POST', `/invite/${token}/join`, { claim: C })
    const y = await person('Y')
    assert.equal((await y.call('POST', `/invite/${token}/join`, { claim: C })).status, 409)
  })

  it('needs a valid link and an account', async () => {
    const { token } = await trio()
    assert.equal((await new Person().call('POST', `/invite/${token}/join`, {})).status, 401)
    assert.equal((await (await person('Z')).call('POST', '/invite/not-a-real-token/join', {})).status, 404)
  })

  it('joining twice doesn’t make a second seat, and a repeated name gets told apart', async () => {
    const { asha, ben, token, groupId } = await trio()
    await ben.ok('POST', `/invite/${token}/join`, {})
    assert.equal((await asha.state(groupId)).members.filter(m => m.name === 'Ben').length, 1)
    const other = await person('Ben')
    await other.ok('POST', `/invite/${token}/join`, {})
    assert.ok((await asha.state(groupId)).members.some(m => m.name === 'Ben 2'))
  })

  it('resetting the link kills the old one; only the owner can', async () => {
    const { asha, ben, groupId, token } = await trio()
    assert.equal((await ben.call('POST', `/groups/${groupId}/invite`, {})).status, 403)
    await asha.ok('POST', `/groups/${groupId}/invite`, {})
    assert.equal((await new Person().call('GET', `/invite/${token}`)).status, 404)
  })
})

describe('who can see and change what', () => {
  it('outsiders can’t reach any part of a group', async () => {
    const { asha, groupId, A } = await trio()
    const e = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, e)
    const outsider = await person('Outsider')
    const attempts: [string, string, unknown?][] = [
      ['GET', `/groups/${groupId}`],
      ['GET', `/groups/${groupId}/live`],
      ['PATCH', `/groups/${groupId}`, { name: 'Mine now' }],
      ['DELETE', `/groups/${groupId}`],
      ['POST', `/groups/${groupId}/expenses`, expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })],
      ['DELETE', `/groups/${groupId}/expenses/${e.id}`],
      ['POST', `/groups/${groupId}/members`, { name: 'Sneak' }],
      ['POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: A, to: A, amount: 1, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' }],
    ]
    for (const [method, path, body] of attempts) assert.equal((await outsider.call(method, path, body)).status, 404, `${method} ${path}`)
    for (const [method, path, body] of attempts) assert.equal((await new Person().call(method, path, body)).status, 401, `signed out: ${method} ${path}`)
    const { groups } = await outsider.ok<{ groups: GroupSummary[] }>('GET', '/groups')
    assert.equal(groups.length, 0)
  })

  it('expense ids from another group can’t be used to reach or overwrite it', async () => {
    const one = await trio()
    const two = await trio()
    const e = expenseBody({ payers: [{ memberId: one.A, amount: 3000 }], split: equalBetween(one.A) })
    await one.asha.ok('POST', `/groups/${one.groupId}/expenses`, e)
    const hijack = expenseBody({ id: e.id, payers: [{ memberId: two.A, amount: 1 }], split: equalBetween(two.A), amount: 1 })
    assert.equal((await two.asha.call('POST', `/groups/${two.groupId}/expenses`, hijack)).status, 409)
    assert.equal((await two.asha.call('DELETE', `/groups/${two.groupId}/expenses/${e.id}`)).status, 404)
    assert.equal((await two.asha.call('PUT', `/groups/${two.groupId}/expenses/${e.id}`, { ...hijack, baseRev: 1 })).status, 404)
    assert.equal((await two.asha.call('POST', `/groups/${two.groupId}/expenses/${e.id}/comments`, { id: randomUUID(), body: 'hi' })).status, 404)
    assert.equal((await one.asha.state(one.groupId)).expenses[0].amount, 3000)
  })

  it('can’t put someone from another group on an expense', async () => {
    const one = await trio()
    const two = await trio()
    const bad = expenseBody({ payers: [{ memberId: two.A, amount: 3000 }], split: equalBetween(one.A) })
    assert.equal((await one.asha.call('POST', `/groups/${one.groupId}/expenses`, bad)).status, 400)
    const bad2 = expenseBody({ payers: [{ memberId: one.A, amount: 3000 }], split: equalBetween(one.A, two.B) })
    assert.equal((await one.asha.call('POST', `/groups/${one.groupId}/expenses`, bad2)).status, 400)
  })

  it('just-for-me expenses are invisible to everyone else, everywhere', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    const secret = expenseBody({ title: 'Secret gift', private: true, payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, secret)
    await asha.ok('POST', `/groups/${groupId}/expenses/${secret.id}/comments`, { id: randomUUID(), body: 'do not tell Ben' })

    const mine = await asha.state(groupId)
    assert.ok(mine.expenses.some(e => e.id === secret.id))

    const his = await ben.state(groupId)
    const leaked = JSON.stringify(his)
    assert.ok(!leaked.includes('Secret gift'), 'not in the state or the activity feed')
    assert.ok(!leaked.includes('do not tell Ben'), 'comments neither')
    assert.equal((await ben.call('DELETE', `/groups/${groupId}/expenses/${secret.id}`)).status, 404)
    assert.equal((await ben.call('PUT', `/groups/${groupId}/expenses/${secret.id}`, { ...secret, baseRev: 1 })).status, 404)
    assert.equal((await ben.call('POST', `/groups/${groupId}/expenses/${secret.id}/comments`, { id: randomUUID(), body: 'peek' })).status, 404)
    assert.deepEqual(netBalances(mine.expenses, mine.settlements), {}, 'no effect on balances')
    void B
  })

  it('a private expense can’t be used to charge someone else', async () => {
    const { asha, groupId, A, B } = await trio()
    const sneaky = expenseBody({ private: true, payers: [{ memberId: B, amount: 3000 }], split: equalBetween(B) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, sneaky)
    const e = (await asha.state(groupId)).expenses.find(x => x.id === sneaky.id)!
    assert.deepEqual(e.basePaid, { [A]: 3000 })
    assert.deepEqual(e.baseOwed, { [A]: 3000 })
  })

  it('a personal budget is only visible to its owner', async () => {
    const { asha, ben, groupId, A } = await trio()
    await asha.ok('PATCH', `/groups/${groupId}/members/${A}`, { budget: 50000 })
    assert.equal((await asha.state(groupId)).members.find(m => m.id === A)?.budget, 50000)
    assert.equal((await ben.state(groupId)).members.find(m => m.id === A)?.budget, null)
    assert.equal((await ben.call('PATCH', `/groups/${groupId}/members/${A}`, { budget: 1 })).status, 403)
  })

  it('email addresses never reach other members', async () => {
    const owner = await person('Owner')
    const g = await owner.ok<GroupState>('POST', '/groups', { name: 'G', currency: 'USD' })
    const other = await person('Other')
    await other.ok('POST', `/invite/${g.group.inviteToken}/join`, {})
    assert.ok(!JSON.stringify(await other.state(g.group.id)).includes(owner.email))
  })

  it('only the owner deletes the group, and deleting removes everything', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    const e = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, B) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, e)
    await asha.ok('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: B, to: A, amount: 100, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
    assert.equal((await ben.call('DELETE', `/groups/${groupId}`)).status, 403)
    await asha.ok('DELETE', `/groups/${groupId}`)
    assert.equal((await asha.call('GET', `/groups/${groupId}`)).status, 404)
    assert.equal((await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM expenses WHERE group_id = ?', groupId))!.n, 0)
  })
})

describe('expenses and balances', () => {
  it('two people see the same balances, however the expense was split', async () => {
    const { asha, ben, groupId, A, B, C } = await trio()
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 9000, payers: [{ memberId: A, amount: 9000 }], split: equalBetween(A, B, C) }))
    await ben.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ title: 'Taxi', amount: 1000, payers: [{ memberId: B, amount: 1000 }], split: { method: 'exact', entries: [{ memberId: A, value: 700 }, { memberId: B, value: 300 }] } }))
    await ben.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ title: 'Museum', amount: 2000, payers: [{ memberId: A, amount: 500 }, { memberId: C, amount: 1500 }], split: { method: 'percent', entries: [{ memberId: A, value: 5000 }, { memberId: C, value: 5000 }] } }))
    const a = await asha.state(groupId)
    const b = await ben.state(groupId)
    assert.deepEqual(netBalances(a.expenses, a.settlements), netBalances(b.expenses, b.settlements))
    assert.deepEqual(netBalances(a.expenses, a.settlements), { [A]: 9000 - 3000 - 700 + 500 - 1000, [B]: -3000 + 1000 - 300, [C]: -3000 + 1500 - 1000 })
  })

  it('recomputes splits itself, ignoring anything derived the browser sends', async () => {
    const { asha, groupId, A, B } = await trio()
    const body = { ...expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, B) }), baseAmount: 1, shares: { [B]: 3000 }, basePaid: { [B]: 3000 }, baseOwed: { [A]: 3000 }, privateTo: B, createdBy: B }
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    const e = (await asha.state(groupId)).expenses[0]
    assert.equal(e.baseAmount, 3000)
    assert.deepEqual(e.baseOwed, { [A]: 1500, [B]: 1500 })
    assert.equal(e.createdBy, A)
    assert.equal(e.privateTo, null)
  })

  it('refuses entries that don’t add up, and says by how much', async () => {
    const { asha, groupId, A, B } = await trio()
    const bad = await asha.call<{ error: string; delta: number }>('POST', `/groups/${groupId}/expenses`, expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: { method: 'exact', entries: [{ memberId: A, value: 1000 }, { memberId: B, value: 1000 }] } }))
    assert.equal(bad.status, 422)
    assert.equal(bad.data.delta, 1000)
    const payers = await asha.call('POST', `/groups/${groupId}/expenses`, expenseBody({ payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A) }))
    assert.equal(payers.status, 422)
    for (const amount of [0, -5, 1.5, 1e20]) {
      const r = await asha.call('POST', `/groups/${groupId}/expenses`, expenseBody({ amount, payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) }))
      assert.equal(r.status, 400, `amount ${amount}`)
    }
    assert.equal((await asha.state(groupId)).expenses.length, 0)
  })

  it('converts foreign currency at the locked rate, and forces 1 for the group’s own', async () => {
    const { asha, groupId, A, B } = await trio()
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 3000, currency: 'JPY', fxRate: 0.0066, payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, B) }))
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 1000, currency: 'USD', fxRate: 999, payers: [{ memberId: A, amount: 1000 }], split: equalBetween(A, B) }))
    const [own, foreign] = (await asha.state(groupId)).expenses.sort((x, y) => x.amount - y.amount)
    assert.equal(foreign.baseAmount, 1980) // ¥3,000 at 0.0066 = $19.80
    assert.equal(own.fxRate, 1)
    assert.equal(own.baseAmount, 1000)
  })

  it('a retry after lost signal doesn’t add it twice', async () => {
    const { asha, groupId, A } = await trio()
    const body = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    assert.equal((await asha.state(groupId)).expenses.length, 1)

    const pay = { id: randomUUID(), from: A, to: (await asha.state(groupId)).members[1].id, amount: 100, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' }
    await asha.ok('POST', `/groups/${groupId}/settlements`, pay)
    await asha.ok('POST', `/groups/${groupId}/settlements`, pay)
    assert.equal((await asha.state(groupId)).settlements.length, 1)
  })

  it('catches two people editing at once instead of losing a change', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    const body = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, B) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    await asha.ok('PUT', `/groups/${groupId}/expenses/${body.id}`, { ...body, title: 'Asha’s edit', baseRev: 1 })
    const stale = await ben.call<{ current: Expense }>('PUT', `/groups/${groupId}/expenses/${body.id}`, { ...body, title: 'Ben’s edit', baseRev: 1 })
    assert.equal(stale.status, 409)
    assert.equal(stale.data.current.title, 'Asha’s edit')
    await ben.ok('PUT', `/groups/${groupId}/expenses/${body.id}`, { ...body, title: 'Ben’s edit', baseRev: 2 })
    const e = (await asha.state(groupId)).expenses[0]
    assert.equal(e.title, 'Ben’s edit')
    assert.equal(e.rev, 3)
  })

  it('a replayed edit whose reply was lost isn’t treated as a conflict', async () => {
    const { asha, groupId, A } = await trio()
    const body = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    const edit = { ...body, title: 'Edited', baseRev: 1, opId: randomUUID() }
    await asha.ok('PUT', `/groups/${groupId}/expenses/${body.id}`, edit)
    await asha.ok('PUT', `/groups/${groupId}/expenses/${body.id}`, edit)
    assert.equal((await asha.state(groupId)).expenses[0].rev, 2)
  })

  it('delete and restore both move the balances and leave a trail', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    const body = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, B) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    await ben.ok('DELETE', `/groups/${groupId}/expenses/${body.id}`)
    let s = await asha.state(groupId)
    assert.deepEqual(netBalances(s.expenses, s.settlements), {})
    assert.ok(s.expenses[0].deletedAt)
    assert.equal(s.activity[0].kind, 'expense-deleted')
    assert.equal(s.activity[0].actor, B)
    await asha.ok('POST', `/groups/${groupId}/expenses/${body.id}/restore`, {})
    s = await asha.state(groupId)
    assert.deepEqual(netBalances(s.expenses, s.settlements), { [A]: 1500, [B]: -1500 })
    assert.equal(s.activity[0].kind, 'expense-restored')
  })

  it('editing records what changed', async () => {
    const { asha, groupId, A, B } = await trio()
    const body = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, B) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    await asha.ok('PUT', `/groups/${groupId}/expenses/${body.id}`, { ...body, amount: 4000, payers: [{ memberId: A, amount: 4000 }], date: '2026-11-11', baseRev: 1 })
    const s = await asha.state(groupId)
    assert.deepEqual(s.activity[0].detail.changes, ['the amount', 'the date'])
  })
})

describe('settling up', () => {
  it('a full payment clears the debt; a partial one reduces it', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 2000, payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A, B) }))
    const partial = { id: randomUUID(), from: B, to: A, amount: 400, currency: 'USD', fxRate: 1, date: '2026-11-10', note: 'cash', method: 'cash' }
    await ben.ok('POST', `/groups/${groupId}/settlements`, partial)
    let s = await asha.state(groupId)
    assert.deepEqual(netBalances(s.expenses, s.settlements), { [A]: 600, [B]: -600 })
    await ben.ok('POST', `/groups/${groupId}/settlements`, { ...partial, id: randomUUID(), amount: 600 })
    s = await asha.state(groupId)
    assert.deepEqual(Object.values(netBalances(s.expenses, s.settlements)), [0, 0])
    await asha.ok('DELETE', `/groups/${groupId}/settlements/${partial.id}`)
    s = await ben.state(groupId)
    assert.deepEqual(netBalances(s.expenses, s.settlements), { [A]: 400, [B]: -400 })
  })

  it('refuses paying yourself', async () => {
    const { asha, groupId, A } = await trio()
    const r = await asha.call('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: A, to: A, amount: 100, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
    assert.equal(r.status, 400)
  })

  it('reminders reach only the person, and not more than once a day', async () => {
    const { asha, ben, groupId, B, C } = await trio()
    await asha.ok('POST', `/groups/${groupId}/remind`, { to: B, amount: 500 })
    assert.equal((await asha.call('POST', `/groups/${groupId}/remind`, { to: B, amount: 500 })).status, 429)
    assert.equal((await ben.state(groupId)).activity[0].kind, 'remind')
    const cara = await person('Cara')
    const s = await asha.state(groupId)
    await cara.ok('POST', `/invite/${s.group.inviteToken}/join`, { claim: C })
    assert.ok(!(await cara.state(groupId)).activity.some(a => a.kind === 'remind'))
  })
})

describe('people coming and going', () => {
  it('nobody leaves or gets removed with money outstanding', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 2000, payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A, B) }))
    assert.equal((await ben.call('DELETE', `/groups/${groupId}/members/${B}`)).status, 409)
    assert.equal((await asha.call('DELETE', `/groups/${groupId}/members/${B}`)).status, 409)
    await ben.ok('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: B, to: A, amount: 1000, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
    await ben.ok('DELETE', `/groups/${groupId}/members/${B}`)
    assert.equal((await ben.call('GET', `/groups/${groupId}`)).status, 404, 'gone once they leave')
    const s = await asha.state(groupId)
    assert.equal(s.members.find(m => m.id === B)?.left, true, 'still named in the history')
  })

  it('only the owner removes other people', async () => {
    const { asha, ben, groupId, C } = await trio()
    assert.equal((await ben.call('DELETE', `/groups/${groupId}/members/${C}`)).status, 403)
    await asha.ok('DELETE', `/groups/${groupId}/members/${C}`)
  })

  it('someone who left can’t be added to new expenses, but old ones can still be edited', async () => {
    const { asha, groupId, A, C } = await trio()
    const old = expenseBody({ amount: 2000, payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A, C) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, old)
    await asha.ok('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: C, to: A, amount: 1000, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
    await asha.ok('DELETE', `/groups/${groupId}/members/${C}`)
    assert.equal((await asha.call('POST', `/groups/${groupId}/expenses`, expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A, C) }))).status, 400)
    await asha.ok('PUT', `/groups/${groupId}/expenses/${old.id}`, { ...old, title: 'Renamed', baseRev: 1 })
  })

  it('when the owner leaves, someone else takes over; if nobody can, they’re told', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    await asha.ok('DELETE', `/groups/${groupId}/members/${A}`)
    assert.equal((await ben.state(groupId)).members.find(m => m.id === B)?.role, 'owner')
    const solo = await person('Solo')
    const g = await solo.ok<GroupState>('POST', '/groups', { name: 'Just me', currency: 'USD' })
    assert.equal((await solo.call('DELETE', `/groups/${g.group.id}/members/${g.me}`)).status, 409)
  })

  it('a lost account can be unlinked and the seat reclaimed, history intact', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 2000, payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A, B) }))
    assert.equal((await ben.call('POST', `/groups/${groupId}/members/${A}/unlink`, {})).status, 403)
    await asha.ok('POST', `/groups/${groupId}/members/${B}/unlink`, {})
    assert.equal((await ben.call('GET', `/groups/${groupId}`)).status, 404)
    const newPhone = await person('Ben again')
    await newPhone.ok('POST', `/invite/${(await asha.state(groupId)).group.inviteToken}/join`, { claim: B })
    const s = await newPhone.state(groupId)
    assert.equal(s.me, B)
    assert.equal(netBalances(s.expenses, s.settlements)[B], -1000)
  })

  it('the currency locks once there’s money in the group', async () => {
    const { asha, ben, groupId, A } = await trio()
    assert.equal((await ben.call('PATCH', `/groups/${groupId}`, { currency: 'INR' })).status, 403)
    await asha.ok('PATCH', `/groups/${groupId}`, { currency: 'INR' })
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ currency: 'INR', payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) }))
    assert.equal((await asha.call('PATCH', `/groups/${groupId}`, { currency: 'EUR' })).status, 409)
  })
})

describe('live updates', () => {
  it('tells everyone connected the moment something changes', async () => {
    const { asha, ben, groupId, A } = await trio()
    const ctrl = new AbortController()
    const res = await fetch(`${base}/groups/${groupId}/live`, { headers: { Cookie: ben.cookie }, signal: ctrl.signal })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /event-stream/)
    const reader = res.body!.getReader()
    const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace('data: ', '')) as { version: number }
    const start = await next()
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) }))
    const bumped = await next()
    assert.equal(bumped.version, start.version + 1)
    assert.equal((await ben.state(groupId)).expenses.length, 1)
    ctrl.abort()
  })

  it('skips the download when nothing has changed', async () => {
    const { asha, groupId } = await trio()
    const { group } = await asha.state(groupId)
    assert.deepEqual(await asha.ok('GET', `/groups/${groupId}?since=${group.version}`), { unchanged: true, version: group.version })
  })
})

describe('receipts', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4])

  async function upload(p: Person, groupId: string, expenseId: string, bytes: Buffer) {
    return fetch(`${base}/groups/${groupId}/expenses/${expenseId}/receipts`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: p.cookie }, body: bytes })
  }

  it('stores a photo for the group; outsiders can’t get it', async () => {
    const { asha, ben, groupId, A } = await trio()
    const e = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, e)
    const res = await upload(asha, groupId, e.id, jpeg)
    assert.equal(res.status, 200)
    const { receiptId } = await res.json() as { receiptId: string }
    const got = await fetch(`${base}/groups/${groupId}/receipts/${receiptId}`, { headers: { Cookie: ben.cookie } })
    assert.equal(got.headers.get('content-type'), 'image/jpeg')
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), jpeg)
    const outsider = await person('Out')
    assert.equal((await fetch(`${base}/groups/${groupId}/receipts/${receiptId}`, { headers: { Cookie: outsider.cookie } })).status, 404)
  })

  it('refuses anything that isn’t a picture, whatever it claims to be', async () => {
    const { asha, groupId, A } = await trio()
    const e = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, e)
    assert.equal((await upload(asha, groupId, e.id, Buffer.from('<script>alert(1)</script>'))).status, 415)
    assert.equal((await upload(asha, groupId, e.id, Buffer.alloc(5 * 1024 * 1024, 0xff))).status, 413)
  })

  it('a photo on a private expense stays private', async () => {
    const { asha, ben, groupId, A } = await trio()
    const e = expenseBody({ private: true, payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, e)
    const { receiptId } = await (await upload(asha, groupId, e.id, jpeg)).json() as { receiptId: string }
    assert.equal((await fetch(`${base}/groups/${groupId}/receipts/${receiptId}`, { headers: { Cookie: ben.cookie } })).status, 404)
    assert.equal((await upload(ben, groupId, e.id, jpeg)).status, 404)
  })
})

describe('exchange rates', () => {
  it('needs an account, and caches per day', async () => {
    assert.equal((await new Person().call('GET', '/fx?base=INR')).status, 401)
    let calls = 0
    const fetcher = async (base: string) => { calls++; return { base, date: '2026-11-01', rates: { JPY: 1.66, [base]: 1 }, source: 'test' } }
    const first = await getRates(db, 'SEK', [fetcher])
    const second = await getRates(db, 'SEK', [fetcher])
    assert.equal(calls, 1)
    assert.equal(first?.rates.JPY, 1.66)
    assert.equal(second?.stale, false)
  })

  it('falls back to the last known rates, marked stale, if every source is down', async () => {
    const down = async () => { throw new Error('down') }
    await db.run(`INSERT INTO fx_cache (base, day, rates, fetched_at) VALUES ('NOK', '2020-01-01', ?, 0)`, JSON.stringify({ base: 'NOK', date: '2020-01-01', rates: { USD: 0.1 }, source: 'test' }))
    const rates = await getRates(db, 'NOK', [down])
    assert.equal(rates?.stale, true)
    assert.equal(rates?.rates.USD, 0.1)
    assert.equal(await getRates(db, 'CHF', [down]), null)
  })
})

describe('hardening', () => {
  it('removing someone with their live stream open doesn’t take the server down', async () => {
    const { asha, ben, groupId, A, B } = await trio()
    const ctrl = new AbortController()
    const res = await fetch(`${base}/groups/${groupId}/live`, { headers: { Cookie: ben.cookie }, signal: ctrl.signal })
    assert.equal(res.status, 200)
    await asha.ok('DELETE', `/groups/${groupId}/members/${B}`)
    await asha.ok('POST', `/groups/${groupId}/expenses`, expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) }))
    assert.equal((await asha.state(groupId)).expenses.length, 1)
    ctrl.abort()
  })

  it('releasing a seat doesn’t hand its private data to whoever claims it next', async () => {
    const { ben, asha, groupId, token, B } = await trio()
    const secret = expenseBody({ title: 'Ben’s secret', private: true, payers: [{ memberId: B, amount: 3000 }], split: equalBetween(B) })
    await ben.ok('POST', `/groups/${groupId}/expenses`, secret)
    await ben.ok('POST', `/groups/${groupId}/expenses/${secret.id}/comments`, { id: randomUUID(), body: 'secret note' })
    await ben.ok('PATCH', `/groups/${groupId}/members/${B}`, { budget: 12345 })
    await asha.ok('POST', `/groups/${groupId}/members/${B}/unlink`, {})

    const stranger = await person('Not Ben')
    assert.equal((await stranger.call('POST', `/invite/${token}/join`, { claim: B })).status, 404, 'the link changes when a seat is released')
    await stranger.ok('POST', `/invite/${(await asha.state(groupId)).group.inviteToken}/join`, { claim: B })
    const seen = await stranger.state(groupId)
    assert.equal(seen.me, B)
    assert.ok(!JSON.stringify(seen).includes('Ben’s secret'), 'not in the expenses or the activity feed')
    assert.ok(!JSON.stringify(seen).includes('secret note'))
    assert.equal(seen.members.find(m => m.id === B)?.budget, null)
    assert.equal((await stranger.call('DELETE', `/groups/${groupId}/expenses/${secret.id}`)).status, 404)
  })

  it('the person themselves gets their private data back if they retake the seat', async () => {
    const { ben, asha, groupId, B } = await trio()
    const secret = expenseBody({ title: 'Ben’s secret', private: true, payers: [{ memberId: B, amount: 3000 }], split: equalBetween(B) })
    await ben.ok('POST', `/groups/${groupId}/expenses`, secret)
    await asha.ok('POST', `/groups/${groupId}/members/${B}/unlink`, {})
    await ben.ok('POST', `/invite/${(await asha.state(groupId)).group.inviteToken}/join`, { claim: B })
    assert.ok((await ben.state(groupId)).expenses.some(e => e.id === secret.id))
  })

  it('someone removed can’t walk back in with the old link', async () => {
    const { asha, ben, groupId, token, B } = await trio()
    await asha.ok('DELETE', `/groups/${groupId}/members/${B}`)
    assert.equal((await ben.call('POST', `/invite/${token}/join`, {})).status, 404)
    assert.equal((await ben.call('GET', `/groups/${groupId}`)).status, 404)
    const fresh = (await asha.state(groupId)).group.inviteToken
    assert.notEqual(fresh, token)
  })

  it('someone leaving on their own doesn’t break the link for everyone else', async () => {
    const { ben, groupId, token, B } = await trio()
    await ben.ok('DELETE', `/groups/${groupId}/members/${B}`)
    assert.equal((await new Person().call('GET', `/invite/${token}`)).status, 200)
  })

  it('a balance that reappears after someone left can still be settled', async () => {
    const { asha, ben, groupId, A, B, C } = await trio()
    const old = expenseBody({ amount: 2000, payers: [{ memberId: A, amount: 2000 }], split: equalBetween(A, C) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, old)
    await asha.ok('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: C, to: A, amount: 1000, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
    await asha.ok('DELETE', `/groups/${groupId}/members/${C}`)
    // the old expense gets corrected, so Cara owes again
    await asha.ok('PUT', `/groups/${groupId}/expenses/${old.id}`, { ...old, amount: 4000, payers: [{ memberId: A, amount: 4000 }], baseRev: 1 })
    let s = await asha.state(groupId)
    assert.equal(netBalances(s.expenses, s.settlements)[C], -1000)
    await ben.ok('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: C, to: A, amount: 1000, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })
    s = await asha.state(groupId)
    assert.equal(netBalances(s.expenses, s.settlements)[C], 0)
    await ben.ok('DELETE', `/groups/${groupId}/members/${B}`)
  })

  it('but someone who left, with nothing outstanding, can’t be used in a payment', async () => {
    const { asha, groupId, A, C } = await trio()
    await asha.ok('DELETE', `/groups/${groupId}/members/${C}`)
    assert.equal((await asha.call('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: C, to: A, amount: 1000, currency: 'USD', fxRate: 1, date: '2026-11-10', method: 'cash' })).status, 400)
  })

  it('refuses amounts big enough to break the arithmetic', async () => {
    const { asha, groupId, A, B } = await trio()
    const huge = await asha.call('POST', `/groups/${groupId}/expenses`, expenseBody({ amount: 1e12, currency: 'JPY', fxRate: 1e4, payers: [{ memberId: A, amount: 1e12 }], split: equalBetween(A, B) }))
    assert.ok(huge.status === 400 || huge.status === 422, `got ${huge.status}`)
    const pay = await asha.call('POST', `/groups/${groupId}/settlements`, { id: randomUUID(), from: A, to: B, amount: 1e11, currency: 'JPY', fxRate: 1e6, date: '2026-11-10', method: 'cash' })
    assert.equal(pay.status, 400)
    assert.equal((await asha.state(groupId)).expenses.length, 0)
  })

  it('deleting a comment takes its text out of the activity feed too', async () => {
    const { asha, ben, groupId, A } = await trio()
    const e = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, e)
    const commentId = randomUUID()
    await asha.ok('POST', `/groups/${groupId}/expenses/${e.id}/comments`, { id: commentId, body: 'oops wrong group' })
    assert.ok(JSON.stringify(await ben.state(groupId)).includes('oops wrong group'))
    await asha.ok('DELETE', `/groups/${groupId}/comments/${commentId}`)
    assert.ok(!JSON.stringify(await ben.state(groupId)).includes('oops wrong group'))
  })

  it('renaming an account doesn’t make two people in a group share a name', async () => {
    const { ben, asha, groupId } = await trio()
    await ben.ok('PATCH', '/auth/me', { name: 'Asha' })
    const names = (await asha.state(groupId)).members.filter(m => !m.left).map(m => m.name.toLowerCase())
    assert.equal(new Set(names).size, names.length)
  })

  it('a retried create followed by an edit ends up with the edit', async () => {
    const { asha, groupId, A } = await trio()
    const body = expenseBody({ payers: [{ memberId: A, amount: 3000 }], split: equalBetween(A) })
    await asha.ok('POST', `/groups/${groupId}/expenses`, body)
    await asha.ok('POST', `/groups/${groupId}/expenses`, body) // the retry
    await asha.ok('PUT', `/groups/${groupId}/expenses/${body.id}`, { ...body, title: 'Edited after', baseRev: 1, opId: randomUUID() })
    assert.equal((await asha.state(groupId)).expenses[0].title, 'Edited after')
  })
})
