import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z, ZodError } from 'zod'
import { CATEGORY_IDS } from '../../src/money/categories'
import { CURRENCIES, isCurrencyCode } from '../../src/money/currency'
import { MAX_AMOUNT, SplitError } from '../../src/money/engine'
import { checkPassword, clearLimit, clientIp, currentUser, endSession, hashPassword, overLimit, startSession, toAccount, type UserRow } from './auth'
import { openDatabase, type Db } from './db'
import { getRates } from './fx'
import { importSqliteOnce } from './importSqlite'
import type { SharedPlan } from '../../src/trip/types'
import * as store from './store'
import { HttpError, type GroupRow, type MemberRow } from './store'

// The money API: accounts, groups, expenses, settling up, and a live stream per group.
// The server trusts nothing it can work out itself: splits, balances and who may see
// what are all decided here, whatever the browser sends.

// ── validation ────────────────────────────────────────────────────────────────

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Bad id')
const name = z.string().trim().min(1, 'Enter a name').max(60)
const amount = z.number().int().positive().max(MAX_AMOUNT)
const currency = z.string().refine(isCurrencyCode, 'Unknown currency')
const rate = z.number().positive().finite().max(1e7)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bad date').refine(d => !Number.isNaN(Date.parse(d)), 'Bad date')
const budget = z.number().int().nonnegative().max(MAX_AMOUNT).nullable()

const expenseBody = z.object({
  id,
  title: z.string().trim().min(1, 'Give it a name').max(120),
  amount,
  currency,
  fxRate: rate,
  category: z.enum(CATEGORY_IDS),
  date,
  notes: z.string().trim().max(1000).default(''),
  payers: z.array(z.object({ memberId: id, amount })).min(1).max(50),
  split: z.object({
    method: z.enum(['equal', 'exact', 'percent', 'shares', 'adjust', 'itemized']),
    entries: z.array(z.object({ memberId: id, value: z.number().int().min(-MAX_AMOUNT).max(MAX_AMOUNT) })).max(50),
    items: z.array(z.object({ id: z.string().max(64), name: z.string().trim().max(80), amount, memberIds: z.array(id).max(50) })).max(100).optional(),
  }),
  private: z.boolean().default(false),
  placeId: z.string().max(80).nullish(),
  placeName: z.string().max(120).nullish(),
})

const settlementBody = z.object({
  id,
  from: id,
  to: id,
  amount,
  currency,
  fxRate: rate,
  date,
  note: z.string().trim().max(300).default(''),
  method: z.enum(['cash', 'upi', 'card', 'bank', 'other']),
})

const tripBody = z.object({
  name: z.string().max(120),
  city: z.string().max(80),
  country: z.string().max(80),
  startDate: z.string().max(10).nullable(),
  days: z.number().int().min(1).max(60),
  travelers: z.number().int().min(1).max(100),
  localCurrency: currency,
  plannedUsd: z.record(z.string(), z.number().nonnegative()),
  budgetUsd: z.number().nonnegative().nullable(),
  stops: z.array(z.object({ id: z.string().max(80), name: z.string().max(120), day: z.number().int(), kind: z.string().max(20) })).max(300),
}).nullable()

// The admin's browser builds the plan, so this checks its shape and size. Only the admin's
// own group ever renders it.
const planBody = z.object({
  phase: z.enum(['intake', 'swipe', 'planning', 'review', 'hotels', 'final']),
  brief: z.looseObject({ vibes: z.array(z.string()).max(30) }),
  deck: z.array(z.object({ id: z.string().max(80), why: z.string().max(300), match: z.number() })).max(300),
  days: z.array(z.looseObject({ day: z.number().int(), stops: z.array(z.looseObject({})).max(40), legs: z.array(z.looseObject({})).max(60) })).max(30),
  hotel: z.looseObject({}).optional(),
  hotelScores: z.array(z.looseObject({})).max(60),
  candidates: z.record(z.string().max(80), z.looseObject({})),
  messages: z.array(z.object({ id: z.string().max(80), role: z.enum(['user', 'ai']), text: z.string().max(5000) })).max(80),
  thoughts: z.array(z.looseObject({})).max(40),
})

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(200)
const password = z.string().min(8, 'Use at least 8 characters').max(200)

// ── plumbing ──────────────────────────────────────────────────────────────────

interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; user: UserRow | null }
type Handler = (c: Ctx) => unknown

function send(res: ServerResponse, status: number, body: unknown) {
  // the rest of an oversized upload is never read, so this connection can't be reused
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}) })
  res.end(JSON.stringify(body))
}

// Not a for-await loop: leaving one early destroys the socket, and the person
// would see a dropped connection instead of being told the photo is too large.
function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size <= limit) { chunks.push(chunk); return }
      req.off('data', onData)
      reject(new HttpError(413, 'That’s too large'))
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readBody<T>(req: IncomingMessage, schema: z.ZodType<T>, limit = 512 * 1024): Promise<T> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse((await readBytes(req, limit)).toString('utf8') || '{}')
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'Bad JSON')
  }
  return schema.parse(parsed)
}

const needUser = (c: Ctx): UserRow => {
  if (!c.user) throw new HttpError(401, 'Sign in first')
  return c.user
}

// ── live updates ──────────────────────────────────────────────────────────────

// Streams carry version numbers only: on any change, clients refetch through the
// normal endpoint, so every read still goes through the same permission checks.
const listeners = new Map<string, Set<{ res: ServerResponse; userId: string }>>()

// Writing to a stream that has ended would raise an unhandled error and stop the whole server.
const writeLive = (res: ServerResponse, text: string) => { if (!res.writableEnded && !res.destroyed) res.write(text) }

async function publish(db: Db, groupId: string) {
  const versions = await store.versionsOf(db, groupId)
  const message = `data: ${JSON.stringify(versions)}\n\n`
  for (const l of listeners.get(groupId) ?? []) writeLive(l.res, message)
  return versions
}

async function publishAll(db: Db, groupIds: string[]) {
  for (const g of groupIds) await publish(db, g)
}

// Ends the streams of one person who lost access, or of everyone if the group is gone.
function closeListeners(groupId: string, userId?: string | null) {
  const set = listeners.get(groupId)
  if (!set) return
  for (const l of set) {
    if (userId !== undefined && l.userId !== userId) continue
    set.delete(l)
    l.res.end()
  }
  if (!set.size) listeners.delete(groupId)
}

// Proxies close idle connections, so keep them busy.
setInterval(() => {
  for (const set of listeners.values()) for (const l of set) writeLive(l.res, ': ping\n\n')
}, 25_000).unref()

async function openStream(db: Db, c: Ctx, groupId: string, userId: string) {
  const { res, req } = c
  const versions = await store.versionsOf(db, groupId)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.write(`data: ${JSON.stringify(versions)}\n\n`)
  const entry = { res, userId }
  const set = listeners.get(groupId) ?? new Set()
  listeners.set(groupId, set.add(entry))
  const forget = () => {
    set.delete(entry)
    if (!set.size && listeners.get(groupId) === set) listeners.delete(groupId)
  }
  req.on('close', forget)
  res.on('error', forget)
}

// ── receipts ──────────────────────────────────────────────────────────────────

const MAX_RECEIPT = 4 * 1024 * 1024

// Goes by the bytes, not the header: these get served back to other members.
function imageType(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// ── routes ────────────────────────────────────────────────────────────────────

export function createMoneyApi(db: Db) {
  const routes: { method: string; re: RegExp; handler: Handler }[] = []
  const route = (method: string, path: string, handler: Handler) => {
    routes.push({ method, re: new RegExp(`^/api/money${path.replace(/:\w+/g, '([^/]+)')}$`), handler })
  }
  // Group routes: the signed-in person must hold a seat in the group in the path.
  const groupRoute = (method: string, path: string, handler: (c: Ctx, group: GroupRow, me: MemberRow) => unknown) => {
    route(method, `/groups/:gid${path}`, async c => {
      const { group, me } = await store.requireSeat(db, c.params[0], needUser(c).id)
      return handler(c, group, me)
    })
  }
  const done = async (groupId: string) => ({ ok: true, version: (await publish(db, groupId)).version })

  // ── accounts ──
  route('GET', '/auth/me', async c => ({ user: c.user ? toAccount(c.user) : null }))

  // The only way in. Your email is your account: a new one asks for a name, one with a
  // password asks for that, and otherwise you're signed in.
  route('POST', '/auth/email', async c => {
    const ip = clientIp(c.req)
    if (overLimit(`login-ip:${ip}`, 40, 900_000)) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.')
    const body = await readBody(c.req, z.object({ email, name: name.optional(), password: z.string().max(200).optional() }))
    let found = await db.one<UserRow>('SELECT * FROM users WHERE email = ?', body.email)
    if (!found) {
      if (!body.name) return { next: 'name' }
      if (overLimit(`signup:${ip}`, 30, 3_600_000)) throw new HttpError(429, 'Too many new accounts from here. Try again later.')
      // two taps of the button arriving together make one account
      await db.run('INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING', randomUUID(), body.name, body.email, Date.now())
      found = (await db.one<UserRow>('SELECT * FROM users WHERE email = ?', body.email))!
      await publishAll(db, await store.linkWaitingSeats(db, found))
    } else if (found.password_hash) {
      if (!body.password) return { next: 'password' }
      const key = `login:${body.email}`
      if (overLimit(key, 8, 900_000)) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.')
      if (!await checkPassword(body.password, found.password_hash)) throw new HttpError(401, 'That password isn’t right')
      clearLimit(key)
    }
    await endSession(db, c.req, c.res)
    await startSession(db, c.req, c.res, found.id)
    return { user: toAccount(found) }
  })

  // Changes your address, and adds or changes the optional password.
  route('POST', '/auth/secure', async c => {
    const user = needUser(c)
    if (overLimit(`secure:${user.id}`, 8, 900_000)) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.')
    const body = await readBody(c.req, z.object({ email, password: password.optional(), current: z.string().max(200).optional() }))
    if (user.password_hash && !(body.current && await checkPassword(body.current, user.password_hash))) throw new HttpError(403, 'Your current password isn’t right')
    if (await db.one('SELECT 1 FROM users WHERE email = ? AND id != ?', body.email, user.id)) throw new HttpError(409, 'That email already has an account')
    const hash = body.password ? await hashPassword(body.password) : user.password_hash
    // checked again inside: the address could have been taken while the password was hashing
    const updated = await db.tx(async () => {
      if (await db.one('SELECT 1 FROM users WHERE email = ? AND id != ?', body.email, user.id)) throw new HttpError(409, 'That email already has an account')
      await db.run('UPDATE users SET email = ?, password_hash = ? WHERE id = ?', body.email, hash, user.id)
      if (body.password) {
        // signs out everywhere else, in case the old password was the problem
        await db.run('DELETE FROM sessions WHERE user_id = ?', user.id)
        await startSession(db, c.req, c.res, user.id)
      }
      return (await db.one<UserRow>('SELECT * FROM users WHERE id = ?', user.id))!
    })
    await publishAll(db, await store.linkWaitingSeats(db, updated))
    return { user: toAccount(updated) }
  })

  route('POST', '/auth/logout', async c => {
    await endSession(db, c.req, c.res)
    return { ok: true }
  })

  route('PATCH', '/auth/me', async c => {
    const user = needUser(c)
    const body = await readBody(c.req, z.object({ name: name.optional(), payHandle: z.string().trim().max(120).nullable().optional() }))
    const groups = await store.updateAccount(db, user, { name: body.name, payHandle: body.payHandle === '' ? null : body.payHandle })
    await publishAll(db, groups)
    return { user: toAccount((await db.one<UserRow>('SELECT * FROM users WHERE id = ?', user.id))!) }
  })

  // ── rates ──
  route('GET', '/fx', async c => {
    needUser(c)
    const base = c.url.searchParams.get('base') ?? ''
    if (!isCurrencyCode(base) || !CURRENCIES.includes(base)) throw new HttpError(400, 'Unknown currency')
    const rates = await getRates(db, base)
    if (!rates) throw new HttpError(503, 'Exchange rates aren’t available right now')
    return rates
  })

  // ── invites ──
  route('GET', '/invite/:token', async c => {
    if (overLimit(`invite:${clientIp(c.req)}`, 60, 600_000)) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.')
    return await store.invitePreview(db, c.params[0], c.user?.id ?? null)
  })

  route('POST', '/invite/:token/join', async c => {
    const user = needUser(c)
    if (overLimit(`invite:${clientIp(c.req)}`, 60, 600_000)) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.')
    const body = await readBody(c.req, z.object({ claim: id.nullish() }))
    const groupId = await store.joinGroup(db, c.params[0], user, body.claim)
    await publish(db, groupId)
    return { groupId }
  })

  // ── groups ──
  route('GET', '/groups', async c => ({ groups: await store.listGroups(db, needUser(c).id) }))

  route('POST', '/groups', async c => {
    const user = needUser(c)
    if (overLimit(`new-group:${user.id}`, 30, 3_600_000)) throw new HttpError(429, 'That’s a lot of new groups. Try again later.')
    const body = await readBody(c.req, z.object({
      name: z.string().trim().min(1, 'Name the group').max(80),
      currency,
      budget: budget.optional(),
      trip: tripBody.optional(),
      members: z.array(z.string().trim().min(1).max(200)).max(49).optional(),
    }))
    // each entry is a name or an email
    const members = (body.members ?? []).map(entry => (entry.includes('@') ? { email: email.parse(entry) } : { name: name.parse(entry) }))
    const { group, me } = await store.createGroup(db, user, { ...body, members })
    return await store.readState(db, group, me)
  })

  groupRoute('GET', '', async (c, group, me) => {
    if (Number(c.url.searchParams.get('since')) === group.version) return { unchanged: true, version: group.version }
    return await store.readState(db, group, me)
  })

  groupRoute('GET', '/live', async (c, group, me) => { await openStream(db, c, group.id, me.user_id!) })

  groupRoute('PATCH', '', async (c, group, me) => {
    const body = await readBody(c.req, z.object({
      name: z.string().trim().min(1).max(80).optional(),
      simplify: z.boolean().optional(),
      budget: budget.optional(),
      currency: currency.optional(),
      trip: tripBody.optional(),
    }))
    await store.updateGroup(db, group, me, body)
    return await done(group.id)
  })

  groupRoute('DELETE', '', async (_c, group, me) => {
    await store.deleteGroup(db, group, me)
    closeListeners(group.id)
    return { ok: true }
  })

  groupRoute('POST', '/invite', async (_c, group, me) => {
    await store.regenerateInvite(db, group, me)
    return await done(group.id)
  })

  // ── people ──
  groupRoute('POST', '/members', async (c, group, me) => {
    if (overLimit(`add-member:${me.id}`, 100, 3_600_000)) throw new HttpError(429, 'That’s a lot of people. Try again later.')
    const body = await readBody(c.req, z.object({ name: name.optional(), email: email.optional() }).refine(b => b.name || b.email, 'Enter a name or an email'))
    const memberId = await store.addMember(db, group, me, body)
    return { ...await done(group.id), memberId }
  })

  groupRoute('PATCH', '/members/:mid', async (c, group, me) => {
    const body = await readBody(c.req, z.object({ name: name.optional(), budget: budget.optional(), email: email.optional() }))
    if (body.email) await store.setMemberEmail(db, group, me, c.params[1], body.email)
    if (body.name !== undefined || body.budget !== undefined) await store.updateMember(db, group, me, c.params[1], body)
    return await done(group.id)
  })

  groupRoute('DELETE', '/members/:mid', async (c, group, me) => {
    const gone = await store.removeMember(db, group, me, c.params[1])
    if (gone) closeListeners(group.id, gone)
    return await done(group.id)
  })

  groupRoute('POST', '/members/:mid/unlink', async (c, group, me) => {
    const gone = await store.unlinkMember(db, group, me, c.params[1])
    if (gone) closeListeners(group.id, gone)
    return await done(group.id)
  })

  // ── expenses ──
  groupRoute('POST', '/expenses', async (c, group, me) => {
    const body = await readBody(c.req, expenseBody.extend({ opId: z.string().max(64).optional() }))
    await store.createExpense(db, group, me, body, body.opId)
    return await done(group.id)
  })

  groupRoute('PUT', '/expenses/:eid', async (c, group, me) => {
    const body = await readBody(c.req, expenseBody.extend({ baseRev: z.number().int(), opId: z.string().max(64).optional() }))
    if (body.id !== c.params[1]) throw new HttpError(400, 'Mismatched id')
    await store.updateExpense(db, group, me, body, body.baseRev, body.opId)
    return await done(group.id)
  })

  groupRoute('DELETE', '/expenses/:eid', async (c, group, me) => {
    await store.setExpenseDeleted(db, group, me, c.params[1], true)
    return await done(group.id)
  })

  groupRoute('POST', '/expenses/:eid/restore', async (c, group, me) => {
    await store.setExpenseDeleted(db, group, me, c.params[1], false)
    return await done(group.id)
  })

  groupRoute('POST', '/expenses/:eid/comments', async (c, group, me) => {
    const body = await readBody(c.req, z.object({ id, body: z.string().trim().min(1, 'Write something first').max(1000) }))
    await store.addComment(db, group, me, c.params[1], body.id, body.body)
    return await done(group.id)
  })

  groupRoute('DELETE', '/comments/:cid', async (c, group, me) => {
    await store.deleteComment(db, group, me, c.params[1])
    return await done(group.id)
  })

  groupRoute('POST', '/expenses/:eid/receipts', async (c, group, me) => {
    if (overLimit(`receipt:${me.id}`, 40, 3_600_000)) throw new HttpError(429, 'That’s a lot of photos. Try again later.')
    const bytes = await readBytes(c.req, MAX_RECEIPT)
    const mime = imageType(bytes)
    if (!mime) throw new HttpError(415, 'That doesn’t look like a photo')
    const receiptId = await store.addReceipt(db, group, me, c.params[1], mime, bytes)
    return { ...await done(group.id), receiptId }
  })

  groupRoute('GET', '/receipts/:rid', async (c, group, me) => {
    const { mime, bytes } = await store.readReceipt(db, group, me, c.params[1])
    c.res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.byteLength, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
    c.res.end(bytes)
  })

  groupRoute('DELETE', '/receipts/:rid', async (c, group, me) => {
    await store.deleteReceipt(db, group, me, c.params[1])
    return await done(group.id)
  })

  // ── settling up ──
  groupRoute('POST', '/settlements', async (c, group, me) => {
    await store.createSettlement(db, group, me, await readBody(c.req, settlementBody))
    return await done(group.id)
  })

  groupRoute('DELETE', '/settlements/:sid', async (c, group, me) => {
    await store.deleteSettlement(db, group, me, c.params[1])
    return await done(group.id)
  })

  // ── the shared trip ──
  groupRoute('GET', '/trip', async (c, group, me) => await store.readTrip(db, group, me, Number(c.url.searchParams.get('planSince') ?? -1)))

  groupRoute('PUT', '/plan', async (c, group, me) => {
    if (me.role !== 'owner') throw new HttpError(403, 'Only the trip’s admin can change the plan')
    const body = await readBody(c.req, z.object({ plan: planBody, summary: tripBody.optional(), baseVersion: z.number().int() }), 4 * 1024 * 1024)
    const planVersion = await store.publishPlan(db, group, me, { plan: body.plan as unknown as SharedPlan, summary: body.summary ?? null, baseVersion: body.baseVersion })
    await publish(db, group.id)
    return { planVersion }
  })

  groupRoute('POST', '/votes', async (c, group, me) => {
    const body = await readBody(c.req, z.object({ votes: z.array(z.object({ placeId: z.string().max(80), vote: z.enum(['like', 'nope']).nullable() })).min(1).max(300) }))
    const skipped = await store.castVotes(db, group, me, body.votes)
    return { ...await done(group.id), skipped }
  })

  groupRoute('POST', '/notes', async (c, group, me) => {
    if (overLimit(`note:${me.id}`, 120, 3_600_000)) throw new HttpError(429, 'That’s a lot of messages. Try again later.')
    const body = await readBody(c.req, z.object({ id, body: z.string().trim().min(1, 'Write something first').max(1000) }))
    await store.addNote(db, group, me, body.id, body.body)
    return await done(group.id)
  })

  groupRoute('POST', '/remind', async (c, group, me) => {
    const body = await readBody(c.req, z.object({ to: id, amount }))
    await store.remind(db, group, me, body.to, body.amount)
    return await done(group.id)
  })

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue
        const m = url.pathname.match(r.re)
        if (!m) continue
        const out = await r.handler({ req, res, url, params: m.slice(1).map(decodeURIComponent), user: await currentUser(db, req) })
        if (!res.headersSent) send(res, 200, out ?? { ok: true })
        return
      }
      send(res, 404, { error: 'Not found' })
    } catch (err) {
      if (res.headersSent) { res.end(); return }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.data ?? {}) as object })
      if (err instanceof ZodError) return send(res, 400, { error: err.issues[0]?.message ?? 'Check what you entered' })
      if (err instanceof SplitError) return send(res, 422, { error: err.message, code: err.code, delta: err.delta })
      if (err instanceof URIError) return send(res, 400, { error: 'Bad address' })
      console.error('[money]', err)
      send(res, 500, { error: 'Something went wrong on our side' })
    }
  }
}

export type MoneyApi = ReturnType<typeof createMoneyApi>

// Connects once, at the first request or health check. With nowhere safe to keep data
// (production with no DATABASE_URL), every money request gets a clear 503 and the rest of
// the app carries on. A connection that fails is tried again on the next request.
let api: Promise<MoneyApi | null> | undefined
let openDb: Db | null = null

export function moneyApi(): Promise<MoneyApi | null> {
  api ??= (async () => {
    const db = await openDatabase()
    if (!db) {
      console.warn('[money] DATABASE_URL is unset: the money API is off, so balances can’t end up somewhere a redeploy would wipe.')
      return null
    }
    await importSqliteOnce(db)
    openDb = db
    return createMoneyApi(db)
  })().catch(err => {
    console.error('[money] Can’t open the database:', err)
    api = undefined
    return null
  })
  return api
}

export async function closeMoneyDb() {
  const db = openDb
  openDb = null
  api = undefined
  await db?.close()
}
