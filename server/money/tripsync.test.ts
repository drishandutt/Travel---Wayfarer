import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http, { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createElement, useReducer } from 'react'
import { createRoot } from 'react-dom/client'
import { Db } from './db'
import { createMoneyApi } from './routes'
import { readLocal } from '../../src/money/client'
import { unsentCount } from '../../src/money/hooks'
import { initialState, reducer, type Action, type TripState } from '../../src/state/tripStore'
import { useSharedTrip, type SharedHandle } from '../../src/trip/useSharedTrip'
import { myVotes } from '../../src/trip/votes'
import type { SharedPlan, SharedTrip } from '../../src/trip/types'

// The sync between a browser and the group's trip, run for real: the actual hook, reducer and
// React scheduler against the actual server. What goes wrong here goes wrong in the gaps between
// a reload, a switch of trips and an answer still on its way, which only shows when they run.

// Before the browser below exists: the in-process Postgres would take itself for one.
const db = await Db.local()

// ── just enough browser ───────────────────────────────────────────────────────

class Storage {
  [key: string]: unknown
  getItem(k: string) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] as string : null }
  setItem(k: string, v: string) { this[k] = String(v) }
  removeItem(k: string) { delete this[k] }
}

const noop = () => {}
const g = globalThis as unknown as Record<string, unknown>
g.window = { addEventListener: noop, removeEventListener: noop, HTMLIFrameElement: class {} }
g.document = { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' }
g.localStorage = new Storage()

const realFetch = globalThis.fetch
let base = ''
let device = ''                        // the cookie of whoever's using this "browser"
let puts = 0
const slow: { match: RegExp; ms: number }[] = []
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

g.fetch = async (url: string, init: RequestInit = {}) => {
  const hold = slow.find(x => x.match.test(url))
  if (hold) await sleep(hold.ms)
  if (init.method === 'PUT') puts++
  return realFetch(base + url, { ...init, headers: { ...init.headers, Cookie: device } })
}

let streamDelay = 0
class FakeEventSource {
  static OPEN = 1
  readyState = 0
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onerror?: () => void
  private ctrl = new AbortController()
  constructor(url: string) { void this.run(url, device) }
  private async run(url: string, cookie: string) {
    try {
      if (streamDelay) await sleep(streamDelay)
      if (this.readyState === 2) return
      const res = await realFetch(base + url, { headers: { Cookie: cookie }, signal: this.ctrl.signal })
      if (!res.ok || !res.body) { this.readyState = 2; this.onerror?.(); return }
      this.readyState = 1
      this.onopen?.()
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        for (const line of new TextDecoder().decode(value).split('\n')) if (line.startsWith('data: ')) this.onmessage?.({ data: line.slice(6) })
      }
    } catch { /* closed */ }
  }
  close() { this.readyState = 2; this.ctrl.abort() }
}
g.EventSource = FakeEventSource

// ── people and tabs ───────────────────────────────────────────────────────────

let server: Server
let dir: string
let n = 0

class Person {
  cookie = ''
  email = ''
  async call<T = Record<string, never>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await realFetch(`${base}/api/money${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    const text = await res.text()
    return { status: res.status, data: text ? JSON.parse(text) as T : {} as T }
  }
  async group(name: string, members: string[] = []) {
    const out = await this.call<{ group: { id: string }; me: string; members: { id: string; joined: boolean }[] }>('POST', '/groups', { name, currency: 'USD', members })
    return out.data
  }
  async read(id: string) { return (await this.call<SharedTrip>('GET', `/groups/${id}/trip?planSince=-1`)).data }
  async setPlan(id: string, plan: SharedPlan, baseVersion: number) { assert.equal((await this.call('PUT', `/groups/${id}/plan`, { plan, baseVersion })).status, 200) }
}

async function person(name: string) {
  const p = new Person()
  p.email = `${name}${++n}@example.com`
  await p.call('POST', '/auth/email', { email: p.email, name })
  return p
}

const planOf = (over: Partial<SharedPlan> = {}): SharedPlan => ({
  phase: 'review',
  brief: { destination: 'tokyo', days: 2, travelers: 3, vibes: [] },
  deck: [{ id: 'p1', why: '', match: 1 }, { id: 'p2', why: '', match: 0.9 }],
  days: [],
  hotelScores: [],
  candidates: {},
  messages: [],
  thoughts: [],
  ...over,
})
const saying = (text: string) => ({ messages: [{ id: 'hello', role: 'ai' as const, text }] })
const saidIn = (messages: { text: string }[]) => messages.map(m => m.text).filter(t => /MARK|EDIT/.test(t))

interface Out { state: TripState; dispatch: (a: Action) => void; shared: SharedHandle; gone: number; news: string[] }

function Probe({ groupId, out }: { groupId: string | null; out: Out }) {
  // what App does at start-up, so a reload here is the same as a reload there
  const [state, dispatch] = useReducer(reducer, initialState, init => {
    const cached = groupId ? readLocal<SharedTrip | null>(`trip:${groupId}`, null) : null
    return cached?.plan ? reducer(init, { type: 'shared-plan', plan: cached.plan, role: cached.role === 'owner' ? 'admin' : 'member', version: cached.planVersion, votes: myVotes(cached.votes, cached.me) }) : init
  })
  out.shared = useSharedTrip(groupId, state, dispatch, { gone() { out.gone++ }, signedOut: noop, news(t) { out.news.push(t) } })
  out.state = state
  out.dispatch = dispatch
  return null
}

function open(groupId: string | null) {
  const out = { gone: 0, news: [] } as unknown as Out
  const container = { nodeType: 1, tagName: 'DIV', addEventListener: noop, removeEventListener: noop, ownerDocument: { addEventListener: noop, removeEventListener: noop, nodeType: 9 } }
  const root = createRoot(container as unknown as Element)
  root.render(createElement(Probe, { groupId, out }))
  return {
    out,
    // moving to another trip: what App does when it opens one
    moveTo(id: string | null) {
      root.render(createElement(Probe, { groupId: id, out }))
      out.dispatch({ type: 'reset' })
    },
    close() { root.unmount() },
  }
}

// a browser of its own, signed in as this person
function browser(p: Person) {
  g.localStorage = new Storage()
  device = p.cookie
  puts = 0
  slow.length = 0
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wf-tripsync-'))
  const handle = createMoneyApi(db)
  server = createServer((req, res) => handle(req, res, new URL(req.url ?? '/', 'http://localhost')))
  await new Promise<void>(r => server.listen(0, r))
  base = `http://localhost:${(server.address() as { port: number }).port}`
})

after(async () => {
  server.closeAllConnections()
  server.close()
  await db.close()
  rmSync(dir, { recursive: true, force: true })
  // React's scheduler and the open tabs' timers would otherwise keep the test process alive
  setTimeout(() => process.exit(0), 50).unref()
})

// ── the plan ──────────────────────────────────────────────────────────────────

describe('reloading the page', () => {
  it('doesn’t roll the plan back for everyone', async () => {
    const admin = await person('Admin')
    browser(admin)
    const id = (await admin.group('T')).group.id
    let tab = open(id)
    await sleep(300)
    tab.out.dispatch({ type: 'brief', brief: { destination: 'tokyo', days: 2, travelers: 3, vibes: [] } })
    tab.out.dispatch({ type: 'start-deck' })
    await sleep(1500)
    tab.close()
    tab = open(id)
    await sleep(600)
    tab.out.dispatch({ type: 'chat', role: 'user', text: 'EDIT-A' })
    await sleep(1500)
    tab.out.dispatch({ type: 'chat', role: 'user', text: 'EDIT-B' })
    await sleep(1500)
    const edited = await admin.read(id)
    assert.deepEqual(saidIn(edited.plan!.messages), ['EDIT-A', 'EDIT-B'])
    assert.deepEqual(saidIn(readLocal<SharedTrip>(`trip:${id}`, edited).plan!.messages), ['EDIT-A', 'EDIT-B'], 'the copy kept here matches its version')
    tab.close()

    puts = 0
    tab = open(id)
    await sleep(2000)
    const after = await admin.read(id)
    assert.deepEqual(saidIn(tab.out.state.messages), ['EDIT-A', 'EDIT-B'])
    assert.deepEqual(saidIn(after.plan!.messages), ['EDIT-A', 'EDIT-B'])
    assert.equal(after.planVersion, edited.planVersion, 'no new version, so nobody is told it changed')
    assert.equal(puts, 0)
    tab.close()
  })

  it('takes a newer plan rather than pushing out the old copy in this browser', async () => {
    const admin = await person('Admin')
    browser(admin)
    const id = (await admin.group('T')).group.id
    await admin.setPlan(id, planOf(saying('MARK-old')), 0)
    let tab = open(id)
    await sleep(500)
    tab.close()
    await admin.setPlan(id, planOf(saying('MARK-newer')), 1)
    puts = 0
    streamDelay = 300 // the fetch answers before the stream does
    tab = open(id)
    await sleep(1800)
    streamDelay = 0
    assert.equal(puts, 0)
    assert.deepEqual(saidIn(tab.out.state.messages), ['MARK-newer'])
    assert.deepEqual(saidIn((await admin.read(id)).plan!.messages), ['MARK-newer'])
    tab.close()
  })

  it('an edit made on an old copy is refused and replaced, not published over the top', async () => {
    const admin = await person('Admin')
    browser(admin)
    const id = (await admin.group('T')).group.id
    await admin.setPlan(id, planOf(saying('MARK-one')), 0)
    const tab = open(id)
    await sleep(500)
    await admin.setPlan(id, planOf(saying('MARK-other-device')), 1)
    tab.out.dispatch({ type: 'chat', role: 'user', text: 'EDIT-stale' })
    await sleep(1800)
    assert.deepEqual(saidIn((await admin.read(id)).plan!.messages), ['MARK-other-device'])
    assert.deepEqual(saidIn(tab.out.state.messages), ['MARK-other-device'])
    tab.close()
  })
})

describe('a tab that died partway', () => {
  for (const phase of ['planning', 'hotels'] as const) {
    it(`during ${phase}: the admin can carry on, and the group is moved on too`, async () => {
      const admin = await person('Admin')
      browser(admin)
      const id = (await admin.group('T')).group.id
      const day = { day: 1, stops: [], legs: [] } as unknown as SharedPlan['days'][number]
      await admin.setPlan(id, planOf({ phase, days: [day] }), 0)
      const tab = open(id)
      await sleep(1800)
      assert.equal(tab.out.state.phase, 'review')
      assert.equal((await admin.read(id)).plan!.phase, 'review')
      tab.close()
    })
  }
})

describe('opening a group with no plan', () => {
  it('doesn’t publish an empty one', async () => {
    const admin = await person('Admin')
    browser(admin)
    const id = (await admin.group('T')).group.id
    const tab = open(id)
    await sleep(1800)
    assert.equal(puts, 0)
    assert.equal((await admin.read(id)).hasPlan, false)
    assert.equal(tab.out.state.shared?.role, 'admin')
    tab.out.dispatch({ type: 'brief', brief: { destination: 'tokyo', vibes: [] } })
    await sleep(1500)
    assert.equal((await admin.read(id)).plan?.brief.destination, 'tokyo', 'the first real change goes out')
    tab.close()
  })
})

// ── moving between trips ──────────────────────────────────────────────────────

describe('moving to another trip with something still on its way', () => {
  async function twoTrips(person0: Person, others: string[] = []) {
    const A = (await person0.group('A', others)).group.id
    const B = (await person0.group('B', others)).group.id
    await person0.setPlan(A, planOf(saying('MARK-A')), 0)
    await person0.setPlan(B, planOf(saying('MARK-B')), 0)
    return { A, B }
  }

  it('the old trip’s answer doesn’t land on the new one', async () => {
    const admin = await person('Admin')
    const { A, B } = await twoTrips(admin)
    browser(admin)
    slow.push({ match: new RegExp(`/groups/${A}/trip`), ms: 400 })
    const tab = open(A)
    await sleep(60)
    tab.moveTo(B)
    await sleep(900)
    assert.deepEqual(saidIn(tab.out.state.messages), ['MARK-B'])
    assert.equal(tab.out.shared.trip?.name, 'B')
    tab.out.dispatch({ type: 'chat', role: 'user', text: 'EDIT-for-B' })
    await sleep(1500)
    assert.deepEqual(saidIn((await admin.read(B)).plan!.messages), ['MARK-B', 'EDIT-for-B'])
    assert.deepEqual(saidIn((await admin.read(A)).plan!.messages), ['MARK-A'], 'A is untouched')
    tab.close()
  })

  it('nor does it end up in the old trip’s saved copy', async () => {
    const asha = await person('Asha')
    const friend = await person('Friend')
    const { A, B } = await twoTrips(asha, [friend.email])
    browser(friend)
    const tab = open(A)
    await sleep(400)
    tab.moveTo(B)
    await sleep(400)
    slow.push({ match: new RegExp(`/groups/${A}/trip`), ms: 400 })
    tab.moveTo(A)
    await sleep(60)
    tab.moveTo(B)
    await sleep(900)
    assert.deepEqual(saidIn(readLocal<SharedTrip>(`trip:${A}`, null as unknown as SharedTrip).plan!.messages), ['MARK-A'])
    tab.close()
  })

  it('the last second of edits still reaches the trip they were made on', async () => {
    const admin = await person('Admin')
    const { A, B } = await twoTrips(admin)
    browser(admin)
    const tab = open(A)
    await sleep(500)
    tab.out.dispatch({ type: 'chat', role: 'user', text: 'EDIT-last-moment' })
    await sleep(50)
    tab.moveTo(B)
    await sleep(800)
    assert.deepEqual(saidIn((await admin.read(A)).plan!.messages), ['MARK-A', 'EDIT-last-moment'])
    assert.deepEqual(saidIn((await admin.read(B)).plan!.messages), ['MARK-B'])
    tab.close()
  })

  it('a queued message goes to the group it was written for', async () => {
    const admin = await person('Admin')
    const { A, B } = await twoTrips(admin)
    browser(admin)
    localStorage.setItem(`wayfarer:money:notes:${B}`, JSON.stringify([{ id: 'queued-for-B-0001', memberId: 'x', body: 'for group B', createdAt: 1, pending: true }]))
    slow.push({ match: new RegExp(`/groups/${A}/notes`), ms: 200 }, { match: new RegExp(`/groups/${B}/notes`), ms: 800 })
    const tab = open(A)
    await sleep(400)
    tab.out.shared.postNote('hello A')
    await sleep(50)
    tab.moveTo(B)
    await sleep(300)
    tab.moveTo(A)
    await sleep(1600)
    slow.length = 0
    assert.deepEqual((await admin.read(A)).notes.map(x => x.body), ['hello A'])
    tab.moveTo(B)
    await sleep(800)
    assert.deepEqual((await admin.read(B)).notes.map(x => x.body), ['for group B'])
    tab.close()
  })
})

// ── queues ────────────────────────────────────────────────────────────────────

describe('votes and messages on their way', () => {
  it('a vote that isn’t valid yet doesn’t hold up the rest, or get lost', async () => {
    const admin = await person('Admin')
    const friend = await person('Friend')
    const created = await admin.group('T', [friend.email])
    const id = created.group.id
    await admin.setPlan(id, planOf(), 0)
    browser(friend)
    const tab = open(id)
    await sleep(500)
    tab.out.shared.vote('not-dealt-yet', 'like')
    tab.out.shared.vote('p1', 'like')
    await sleep(400)
    const t = await friend.read(id)
    assert.deepEqual(t.votes.map(v => v.placeId), ['p1'])
    assert.deepEqual(readLocal(`votes:${id}`, {}), { 'not-dealt-yet': 'like' }, 'still waiting for the deck it belongs to')
    assert.equal(unsentCount(), 1, 'and signing out warns about it')
    tab.close()
  })

  it('a message survives an expired session', async () => {
    const admin = await person('Admin')
    browser(admin)
    const id = (await admin.group('T')).group.id
    await admin.setPlan(id, planOf(), 0)
    const tab = open(id)
    await sleep(400)
    device = 'wf_session=expired'
    tab.out.shared.postNote('keep me')
    await sleep(300)
    assert.equal(readLocal<{ body: string }[]>(`notes:${id}`, [])[0]?.body, 'keep me')
    assert.equal(unsentCount(), 1)
    tab.close()
  })
})

// ── who's who ─────────────────────────────────────────────────────────────────

describe('when the admin leaves', () => {
  it('whoever takes over can edit straight away, without reloading', async () => {
    const admin = await person('Admin')
    const friend = await person('Friend')
    const created = await admin.group('T', [friend.email])
    const id = created.group.id
    await admin.setPlan(id, planOf(saying('MARK')), 0)
    browser(friend)
    const tab = open(id)
    await sleep(500)
    assert.equal(tab.out.state.shared?.role, 'member')
    await admin.call('DELETE', `/groups/${id}/members/${created.me}`)
    await sleep(800)
    assert.equal(tab.out.state.shared?.role, 'admin')
    tab.out.dispatch({ type: 'chat', role: 'user', text: 'EDIT-by-heir' })
    await sleep(1500)
    assert.deepEqual(saidIn((await friend.read(id)).plan!.messages), ['MARK', 'EDIT-by-heir'])
    tab.close()
  })
})

// ── the server’s side ─────────────────────────────────────────────────────────

describe('two uploads at the same time', () => {
  it('only one of them wins', async () => {
    const admin = await person('Admin')
    const id = (await admin.group('T')).group.id
    await admin.setPlan(id, planOf(), 0)
    const u = new URL(base)
    const upload = (text: string) => {
      const body = Buffer.from(JSON.stringify({ plan: planOf(saying(text)), baseVersion: 1 }))
      let answer: (v: { status: number; planVersion?: number }) => void = noop
      const result = new Promise<{ status: number; planVersion?: number }>(r => { answer = r })
      const req = http.request({ host: u.hostname, port: u.port, method: 'PUT', path: `/api/money/groups/${id}/plan`, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Cookie: admin.cookie } }, res => {
        let t = ''
        res.on('data', d => { t += d })
        res.on('end', () => answer({ status: res.statusCode ?? 0, planVersion: (JSON.parse(t) as { planVersion?: number }).planVersion }))
      })
      req.write(body.subarray(0, 10)) // both are read as version 1 before either finishes
      return { finish: () => req.end(body.subarray(10)), result }
    }
    const x = upload('MARK-X')
    const y = upload('MARK-Y')
    await sleep(150)
    x.finish()
    const first = await x.result
    y.finish()
    const second = await y.result
    assert.deepEqual(first, { status: 200, planVersion: 2 })
    assert.equal(second.status, 409)
    const t = await admin.read(id)
    assert.equal(t.planVersion, 2)
    assert.deepEqual(saidIn(t.plan!.messages), ['MARK-X'])
  })
})

describe('releasing a seat', () => {
  it('takes away the old link and the votes, so nobody votes twice', async () => {
    const admin = await person('Admin')
    const friend = await person('Friend')
    const created = await admin.group('T', [friend.email])
    const id = created.group.id
    const seat = created.members.find(m => m.joined && m.id !== created.me)!.id
    await admin.setPlan(id, planOf(), 0)
    await friend.call('POST', `/groups/${id}/votes`, { votes: [{ placeId: 'p1', vote: 'like' }] })
    const oldLink = (await admin.read(id)).inviteToken
    assert.equal((await admin.call('POST', `/groups/${id}/members/${seat}/unlink`, {})).status, 200)
    const t = await admin.read(id)
    assert.equal(t.votes.length, 0)
    assert.notEqual(t.inviteToken, oldLink)
    assert.equal((await friend.call('POST', `/invite/${oldLink}/join`, {})).status, 404)
    assert.equal((await friend.call('GET', `/groups/${id}/trip`)).status, 404)
  })
})
