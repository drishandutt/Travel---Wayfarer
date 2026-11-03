import { randomBytes, randomUUID } from 'node:crypto'
import type { ActivityItem, ActivityKind, Comment, Expense, ExpenseInput, Group, GroupState, GroupSummary, InvitePreview, Member, Settlement, SettlementInput, TripSummary } from '../../src/money/types'
import { MAX_AMOUNT, computeExpense, convert, netBalances, totalsFor } from '../../src/money/engine'
import type { PlaceVote, PublishPlan, SharedPlan, SharedTrip, TripNote, VoteValue } from '../../src/trip/types'
import type { Db } from './db'
import type { UserRow } from './auth'

// Everything that reads or changes a group. Each change runs in one transaction, checks
// included, with its activity entry and a version bump, so what people see can't disagree
// with the log.

export class HttpError extends Error {
  constructor(public status: number, message: string, public data?: unknown) { super(message) }
}

const MAX_MEMBERS = 50
const MAX_EXPENSES = 5000
const MAX_SETTLEMENTS = 5000
const MAX_RECEIPTS_PER_EXPENSE = 5
const MAX_RECEIPTS_PER_GROUP = 300
const ACTIVITY_LIMIT = 300

export interface GroupRow { id: string; name: string; currency: string; simplify: number; budget: number | null; invite_token: string; trip: string | null; version: number; created_at: number; plan: string | null; plan_version: number }
export interface MemberRow { id: string; group_id: string; user_id: string | null; email: string | null; name: string; role: 'owner' | 'member'; budget: number | null; left_at: number | null; created_at: number; pay_handle?: string | null }
interface ExpenseRow {
  id: string; group_id: string; rev: number; last_op: string | null; title: string; amount: number; currency: string; fx_rate: number; base_amount: number
  category: Expense['category']; date: string; notes: string; payers: string; split: string; shares: string; base_paid: string; base_owed: string
  private_to: string | null; private_user: string | null; place_id: string | null; place_name: string | null; created_by: string; created_at: number; updated_by: string | null; updated_at: number; deleted_at: number | null; deleted_by: string | null
}
interface SettlementRow {
  id: string; group_id: string; from_member: string; to_member: string; amount: number; currency: string; fx_rate: number; base_amount: number
  date: string; note: string; method: Settlement['method']; created_by: string; created_at: number; deleted_at: number | null
}

const toExpense = (r: ExpenseRow, receipts: string[] = []): Expense => ({
  id: r.id, groupId: r.group_id, rev: r.rev, title: r.title, amount: r.amount, currency: r.currency, fxRate: r.fx_rate, baseAmount: r.base_amount,
  category: r.category, date: r.date, notes: r.notes, payers: JSON.parse(r.payers), split: JSON.parse(r.split), shares: JSON.parse(r.shares),
  basePaid: JSON.parse(r.base_paid), baseOwed: JSON.parse(r.base_owed), privateTo: r.private_to, placeId: r.place_id, placeName: r.place_name,
  createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at, deletedAt: r.deleted_at, deletedBy: r.deleted_by, receipts,
})

const toSettlement = (r: SettlementRow): Settlement => ({
  id: r.id, groupId: r.group_id, from: r.from_member, to: r.to_member, amount: r.amount, currency: r.currency, fxRate: r.fx_rate, baseAmount: r.base_amount,
  date: r.date, note: r.note, method: r.method, createdBy: r.created_by, createdAt: r.created_at, deletedAt: r.deleted_at,
})

const toGroup = (g: GroupRow, me: MemberRow): Group => ({
  id: g.id, name: g.name, currency: g.currency, simplify: Boolean(g.simplify), budget: g.budget, inviteToken: me.role === 'owner' ? g.invite_token : '',
  trip: g.trip ? JSON.parse(g.trip) : null, version: g.version, createdAt: g.created_at,
})

// A group someone isn't in looks the same as one that doesn't exist.
export async function requireSeat(db: Db, groupId: string, userId: string): Promise<{ group: GroupRow; me: MemberRow }> {
  const [group, me] = await Promise.all([
    db.one<GroupRow>('SELECT * FROM money_groups WHERE id = ?', groupId),
    db.one<MemberRow>('SELECT * FROM members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', groupId, userId),
  ])
  if (!group || !me) throw new HttpError(404, 'Group not found')
  return { group, me }
}

async function logActivity(db: Db, groupId: string, kind: ActivityKind, actor: string | null, a: { ref?: string; target?: string; privateTo?: string | null; detail?: ActivityItem['detail'] } = {}) {
  await db.run('INSERT INTO activity (group_id, kind, actor, ref, target, private_to, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    groupId, kind, actor, a.ref ?? null, a.target ?? null, a.privateTo ?? null, JSON.stringify(a.detail ?? {}), Date.now())
}

function mutate<T>(db: Db, groupId: string, fn: () => Promise<T>): Promise<T> {
  return db.tx(async () => {
    const out = await fn()
    await db.run('UPDATE money_groups SET version = version + 1 WHERE id = ?', groupId)
    return out
  })
}

export const versionsOf = async (db: Db, groupId: string) =>
  await db.one<{ version: number; planVersion: number }>('SELECT version, plan_version AS "planVersion" FROM money_groups WHERE id = ?', groupId) ?? { version: 0, planVersion: 0 }

// ── reading ───────────────────────────────────────────────────────────────────

function allMembers(db: Db, groupId: string): Promise<MemberRow[]> {
  return db.all<MemberRow>('SELECT m.*, u.pay_handle FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.created_at, m.id', groupId)
}

// A private expense belongs to the person, not just the seat: if the seat is released and
// someone else claims it, they see the seat's shared history but nothing private.
const PRIVATE_OK = '(private_to IS NULL OR (private_to = ? AND private_user = ?))'

const visibleExpenses = (db: Db, groupId: string, memberId: string, userId: string | null) =>
  db.all<ExpenseRow>(`SELECT * FROM expenses WHERE group_id = ? AND ${PRIVATE_OK} ORDER BY date DESC, created_at DESC`, groupId, memberId, userId)

// The reads go out together: the database is a network hop away. If a change lands between
// them, the version this answer carries is already behind and the next update refetches.
export async function readState(db: Db, group: GroupRow, me: MemberRow): Promise<GroupState> {
  const [receiptRows, memberRows, commentRows, activityRows, expenseRows, settlementRows] = await Promise.all([
    db.all<{ id: string; expense_id: string }>('SELECT id, expense_id FROM receipts WHERE group_id = ? ORDER BY created_at', group.id),
    allMembers(db, group.id),
    db.all<{ id: string; expense_id: string; member_id: string; body: string; created_at: number }>(
      `SELECT c.* FROM comments c JOIN expenses e ON e.id = c.expense_id
       WHERE c.group_id = ? AND (e.private_to IS NULL OR (e.private_to = ? AND e.private_user = ?)) ORDER BY c.created_at`, group.id, me.id, me.user_id),
    db.all<{ seq: number; kind: ActivityKind; actor: string | null; ref: string | null; target: string | null; detail: string; created_at: number }>(
      `SELECT seq, kind, actor, ref, target, detail, created_at FROM activity
       WHERE group_id = ? AND (private_to IS NULL OR private_to = ?) AND (kind != 'remind' OR actor = ? OR target = ?)
       ORDER BY seq DESC LIMIT ?`, group.id, me.user_id, me.id, me.id, ACTIVITY_LIMIT),
    visibleExpenses(db, group.id, me.id, me.user_id),
    db.all<SettlementRow>('SELECT * FROM settlements WHERE group_id = ? ORDER BY date DESC, created_at DESC', group.id),
  ])
  const receipts = new Map<string, string[]>()
  for (const r of receiptRows) receipts.set(r.expense_id, [...(receipts.get(r.expense_id) ?? []), r.id])
  const members: Member[] = memberRows.map(m => ({
    id: m.id, name: m.name, role: m.role, joined: Boolean(m.user_id), left: Boolean(m.left_at), payHandle: m.pay_handle ?? null,
    waitingEmail: !m.user_id && m.email ? maskEmail(m.email) : null,
    budget: m.id === me.id ? m.budget : null,
  }))
  return {
    group: toGroup(group, me),
    me: me.id,
    members,
    expenses: expenseRows.map(e => toExpense(e, receipts.get(e.id))),
    settlements: settlementRows.map(toSettlement),
    comments: commentRows.map<Comment>(c => ({ id: c.id, expenseId: c.expense_id, memberId: c.member_id, body: c.body, createdAt: c.created_at })),
    activity: activityRows.map<ActivityItem>(a => ({ seq: a.seq, kind: a.kind, actor: a.actor, ref: a.ref, target: a.target, detail: JSON.parse(a.detail), createdAt: a.created_at })),
  }
}

export async function listGroups(db: Db, userId: string): Promise<GroupSummary[]> {
  const seats = await db.all<GroupRow & { member_id: string; member_role: 'owner' | 'member'; plan_phase: string | null; member_count: number; updated_at: number | null }>(
    `SELECT g.*, m.id AS member_id, m.role AS member_role, g.plan::json->>'phase' AS plan_phase,
       (SELECT COUNT(*) FROM members x WHERE x.group_id = g.id AND x.left_at IS NULL) AS member_count,
       (SELECT MAX(created_at) FROM activity a WHERE a.group_id = g.id) AS updated_at
     FROM members m JOIN money_groups g ON g.id = m.group_id
     WHERE m.user_id = ? AND m.left_at IS NULL`, userId,
  )
  const summaries = await Promise.all(seats.map(async g => {
    const [expenseRows, settlementRows] = await Promise.all([
      visibleExpenses(db, g.id, g.member_id, userId),
      db.all<SettlementRow>('SELECT * FROM settlements WHERE group_id = ?', g.id),
    ])
    const expenses = expenseRows.map(e => toExpense(e))
    const settlements = settlementRows.map(toSettlement)
    const t = totalsFor({ me: g.member_id, expenses, settlements })
    const net = netBalances(expenses, settlements)
    return {
      id: g.id, name: g.name, currency: g.currency, city: g.trip ? (JSON.parse(g.trip) as TripSummary).city : null,
      memberCount: g.member_count, myNet: t.net, mySpend: t.mySpend, total: t.groupTotal, updatedAt: g.updated_at ?? g.created_at,
      settled: Object.values(net).every(n => n === 0),
      role: g.member_role, phase: g.plan_phase,
    }
  }))
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ── groups & people ───────────────────────────────────────────────────────────

const newInvite = () => randomBytes(18).toString('base64url')

function assertAdmin(me: MemberRow, what: string) {
  if (me.role !== 'owner') throw new HttpError(403, `Only the trip’s admin can ${what}`)
}

// Addresses stay hidden from the rest of the group: typing one is all it takes to sign in as
// that person. The masked form is enough to spot a typo in an invite.
const maskEmail = (email: string) => {
  const [local, domain] = email.split('@')
  return `${local.slice(0, 2)}•••@${domain}`
}

const nameFromEmail = (email: string) => {
  const words = email.split('@')[0].replace(/[._+-]+/g, ' ').trim()
  return (words[0] ?? 'F').toUpperCase() + (words.slice(1) || 'riend')
}

export interface NewPerson { name?: string; email?: string }

// Gives someone a seat, or says who already has it. With an email that has an account they're
// in straight away. With an email that doesn't, the seat waits for them to sign in with it.
// With only a name, the seat can be claimed through the invite link.
async function seatFor(db: Db, groupId: string, person: NewPerson, at = Date.now()): Promise<{ id: string } | { taken: string }> {
  const id = randomUUID()
  if (!person.email) {
    const name = person.name ?? 'Friend'
    if (await nameTaken(db, groupId, name)) return { taken: name }
    await db.run('INSERT INTO members (id, group_id, name, created_at) VALUES (?, ?, ?, ?)', id, groupId, name, at)
    return { id }
  }
  const user = await db.one<UserRow>('SELECT * FROM users WHERE email = ?', person.email)
  if (user) {
    const seat = await db.one<MemberRow>('SELECT * FROM members WHERE group_id = ? AND user_id = ? ORDER BY left_at IS NULL DESC LIMIT 1', groupId, user.id)
    if (seat && !seat.left_at) return { taken: seat.name }
    const name = await uniqueName(db, groupId, user.name, seat?.id)
    if (seat) {
      // coming back: same seat, same history
      await db.run('UPDATE members SET left_at = NULL, name = ? WHERE id = ?', name, seat.id)
      return { id: seat.id }
    }
    await db.run('INSERT INTO members (id, group_id, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)', id, groupId, user.id, name, at)
    return { id }
  }
  const waiting = await db.one<{ name: string }>('SELECT name FROM members WHERE group_id = ? AND email = ? AND left_at IS NULL', groupId, person.email)
  if (waiting) return { taken: waiting.name }
  await db.run('INSERT INTO members (id, group_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)', id, groupId, person.email, await uniqueName(db, groupId, person.name ?? nameFromEmail(person.email)), at)
  return { id }
}

export async function createGroup(db: Db, user: UserRow, input: { name: string; currency: string; budget?: number | null; trip?: TripSummary | null; members?: NewPerson[] }): Promise<{ group: GroupRow; me: MemberRow }> {
  const id = randomUUID()
  const memberId = randomUUID()
  const now = Date.now()
  await db.tx(async () => {
    await db.run('INSERT INTO money_groups (id, name, currency, budget, invite_token, trip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, input.name, input.currency, input.budget ?? null, newInvite(), input.trip ? JSON.stringify(input.trip) : null, now)
    await db.run(`INSERT INTO members (id, group_id, user_id, name, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)`, memberId, id, user.id, user.name, now)
    // a tick apart, so the group keeps the order they were typed in; anyone listed twice is skipped
    for (const [i, person] of (input.members ?? []).entries()) await seatFor(db, id, person, now + i + 1)
    await logActivity(db, id, 'group-created', memberId, { detail: { name: input.name } })
  })
  return requireSeat(db, id, user.id)
}

export const updateGroup = (db: Db, group: GroupRow, me: MemberRow, patch: { name?: string; simplify?: boolean; budget?: number | null; currency?: string; trip?: TripSummary | null }) => db.tx(async () => {
  assertAdmin(me, 'change the group’s settings')
  if (patch.currency && patch.currency !== group.currency) {
    const used = await db.one('SELECT 1 FROM expenses WHERE group_id = ? UNION SELECT 1 FROM settlements WHERE group_id = ? LIMIT 1', group.id, group.id)
    if (used) throw new HttpError(409, 'The group currency can’t change once there are expenses in it')
  }
  await mutate(db, group.id, async () => {
    if (patch.name !== undefined && patch.name !== group.name) {
      await db.run('UPDATE money_groups SET name = ? WHERE id = ?', patch.name, group.id)
      await logActivity(db, group.id, 'group-renamed', me.id, { detail: { name: patch.name } })
    }
    if (patch.simplify !== undefined && patch.simplify !== Boolean(group.simplify)) {
      await db.run('UPDATE money_groups SET simplify = ? WHERE id = ?', patch.simplify ? 1 : 0, group.id)
      await logActivity(db, group.id, 'group-settings', me.id, { detail: { changes: [patch.simplify ? 'turned on simplify debts' : 'turned off simplify debts'] } })
    }
    if (patch.budget !== undefined && patch.budget !== group.budget) {
      await db.run('UPDATE money_groups SET budget = ? WHERE id = ?', patch.budget, group.id)
      await logActivity(db, group.id, 'group-settings', me.id, { detail: { changes: [patch.budget === null ? 'removed the group budget' : 'set the group budget'], amount: patch.budget ?? undefined, currency: group.currency } })
    }
    if (patch.currency) await db.run('UPDATE money_groups SET currency = ? WHERE id = ?', patch.currency, group.id)
    if (patch.trip !== undefined) await db.run('UPDATE money_groups SET trip = ? WHERE id = ?', patch.trip ? JSON.stringify(patch.trip) : null, group.id)
  })
})

export async function deleteGroup(db: Db, group: GroupRow, me: MemberRow) {
  assertAdmin(me, 'delete the group')
  await db.run('DELETE FROM money_groups WHERE id = ?', group.id)
}

export async function regenerateInvite(db: Db, group: GroupRow, me: MemberRow) {
  assertAdmin(me, 'reset the link')
  await mutate(db, group.id, async () => { await db.run('UPDATE money_groups SET invite_token = ? WHERE id = ?', newInvite(), group.id) })
}

// Case-blind, as names were under SQLite's NOCASE.
async function nameTaken(db: Db, groupId: string, name: string, except?: string) {
  return Boolean(await db.one('SELECT 1 FROM members WHERE group_id = ? AND left_at IS NULL AND lower(name) = lower(?) AND id != ?', groupId, name, except ?? ''))
}

async function uniqueName(db: Db, groupId: string, base: string, except?: string) {
  let name = base
  for (let i = 2; await nameTaken(db, groupId, name, except); i++) name = `${base} ${i}`
  return name
}

async function assertRoom(db: Db, groupId: string) {
  const { n } = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND left_at IS NULL', groupId))!
  if (n >= MAX_MEMBERS) throw new HttpError(409, `A group can have up to ${MAX_MEMBERS} people`)
}

// Someone can be in splits from now on, whether or not they've signed in yet.
export const addMember = (db: Db, group: GroupRow, me: MemberRow, person: NewPerson): Promise<string> => db.tx(async () => {
  assertAdmin(me, 'add people')
  await assertRoom(db, group.id)
  return mutate(db, group.id, async () => {
    const out = await seatFor(db, group.id, person)
    if ('taken' in out) throw new HttpError(409, `${out.taken} is already in this group`)
    const { name } = (await db.one<{ name: string }>('SELECT name FROM members WHERE id = ?', out.id))!
    await logActivity(db, group.id, 'member-added', me.id, { target: out.id, detail: { name } })
    return out.id
  })
})

// Fixes a typo in an invite, or gives a name-only seat an address to wait for.
export const setMemberEmail = (db: Db, group: GroupRow, me: MemberRow, memberId: string, email: string) => db.tx(async () => {
  assertAdmin(me, 'change someone’s email')
  const target = await db.one<MemberRow>('SELECT * FROM members WHERE id = ? AND group_id = ? AND left_at IS NULL', memberId, group.id)
  if (!target) throw new HttpError(404, 'That person isn’t in this group')
  if (target.user_id) throw new HttpError(409, `${target.name} has already joined`)
  const user = await db.one<UserRow>('SELECT * FROM users WHERE email = ?', email)
  const holder = user
    ? await db.one<{ name: string }>('SELECT name FROM members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', group.id, user.id)
    : await db.one<{ name: string }>('SELECT name FROM members WHERE group_id = ? AND email = ? AND left_at IS NULL AND id != ?', group.id, email, target.id)
  if (holder) throw new HttpError(409, `${holder.name} is already in this group`)
  await mutate(db, group.id, async () => {
    if (!user) {
      await db.run('UPDATE members SET email = ? WHERE id = ?', email, target.id)
      return
    }
    const name = await uniqueName(db, group.id, user.name, target.id)
    await db.run('UPDATE members SET user_id = ?, email = NULL, name = ? WHERE id = ?', user.id, name, target.id)
    await logActivity(db, group.id, 'member-joined', target.id, { target: target.id, detail: { name } })
  })
})

// Called when an address becomes an account: every seat waiting for it is theirs now.
export const linkWaitingSeats = (db: Db, user: UserRow): Promise<string[]> => db.tx(async () => {
  const seats = await db.all<{ id: string; group_id: string }>('SELECT id, group_id FROM members WHERE email = ? AND user_id IS NULL AND left_at IS NULL', user.email)
  for (const seat of seats) {
    await mutate(db, seat.group_id, async () => {
      // already in that group another way: one person, one seat
      if (await db.one('SELECT 1 FROM members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', seat.group_id, user.id)) {
        await db.run('UPDATE members SET email = NULL WHERE id = ?', seat.id)
        return
      }
      const name = await uniqueName(db, seat.group_id, user.name, seat.id)
      await db.run('UPDATE members SET user_id = ?, email = NULL, name = ? WHERE id = ?', user.id, name, seat.id)
      await logActivity(db, seat.group_id, 'member-joined', seat.id, { target: seat.id, detail: { name } })
    })
  }
  return seats.map(s => s.group_id)
})

export const updateMember = (db: Db, group: GroupRow, me: MemberRow, memberId: string, patch: { name?: string; budget?: number | null }) => db.tx(async () => {
  const target = await db.one<MemberRow>('SELECT * FROM members WHERE id = ? AND group_id = ?', memberId, group.id)
  if (!target) throw new HttpError(404, 'That person isn’t in this group')
  if (patch.budget !== undefined && target.id !== me.id) throw new HttpError(403, 'A personal budget can only be set by that person')
  if (patch.name !== undefined) {
    if (target.id !== me.id && me.role !== 'owner') throw new HttpError(403, 'Only the trip’s admin can rename other people')
    if (await nameTaken(db, group.id, patch.name, target.id)) throw new HttpError(409, `${patch.name} is already in this group`)
  }
  await mutate(db, group.id, async () => {
    if (patch.name !== undefined) await db.run('UPDATE members SET name = ? WHERE id = ?', patch.name, target.id)
    if (patch.budget !== undefined) await db.run('UPDATE members SET budget = ? WHERE id = ?', patch.budget, target.id)
  })
})

async function balanceOf(db: Db, groupId: string, memberId: string) {
  const [expenseRows, settlementRows] = await Promise.all([
    db.all<ExpenseRow>('SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL AND private_to IS NULL', groupId),
    db.all<SettlementRow>('SELECT * FROM settlements WHERE group_id = ? AND deleted_at IS NULL', groupId),
  ])
  return netBalances(expenseRows.map(e => toExpense(e)), settlementRows.map(toSettlement))[memberId] ?? 0
}

// Leaving or being removed needs a zero balance, or everyone else's numbers stop adding up.
// Being removed also resets the invite link: they may have kept it from when they were
// invited, so otherwise they could walk straight back in.
export const removeMember = (db: Db, group: GroupRow, me: MemberRow, memberId: string): Promise<string | null> => db.tx(async () => {
  const target = await db.one<MemberRow>('SELECT * FROM members WHERE id = ? AND group_id = ? AND left_at IS NULL', memberId, group.id)
  if (!target) throw new HttpError(404, 'That person isn’t in this group')
  const self = target.id === me.id
  if (!self) assertAdmin(me, 'remove people')
  if (await balanceOf(db, group.id, target.id) !== 0) {
    throw new HttpError(409, self ? 'Settle up first: you can leave once your balance is zero' : `${target.name} needs to settle up first`)
  }
  const heir = target.role === 'owner'
    ? await db.one<{ id: string }>('SELECT id FROM members WHERE group_id = ? AND left_at IS NULL AND user_id IS NOT NULL AND id != ? ORDER BY created_at LIMIT 1', group.id, target.id)
    : undefined
  if (target.role === 'owner' && !heir) throw new HttpError(409, 'Nobody else here has an account to take the group over. Delete the group instead.')
  await mutate(db, group.id, async () => {
    await db.run(`UPDATE members SET left_at = ?, role = 'member', email = NULL WHERE id = ?`, Date.now(), target.id)
    if (heir) await db.run(`UPDATE members SET role = 'owner' WHERE id = ?`, heir.id)
    if (!self) await db.run('UPDATE money_groups SET invite_token = ? WHERE id = ?', newInvite(), group.id)
    await logActivity(db, group.id, self ? 'member-left' : 'member-removed', me.id, { target: target.id, detail: { name: target.name } })
  })
  return target.user_id
})

// Recovery for a forgotten password or a wrong person: the seat goes back to unclaimed, with
// its spending intact, and can be taken through the new invite link or given a new address.
// The link changes so the person released can't walk straight back in on another seat, and
// their votes go because those were their opinions, not the seat's.
export const unlinkMember = (db: Db, group: GroupRow, me: MemberRow, memberId: string): Promise<string | null> => db.tx(async () => {
  assertAdmin(me, 'release a seat')
  const target = await db.one<MemberRow>('SELECT * FROM members WHERE id = ? AND group_id = ? AND left_at IS NULL', memberId, group.id)
  if (!target?.user_id) throw new HttpError(404, 'That seat has no account linked')
  if (target.id === me.id) throw new HttpError(409, 'You can’t unlink yourself')
  await mutate(db, group.id, async () => {
    await db.run('UPDATE members SET user_id = NULL, email = NULL, budget = NULL WHERE id = ?', target.id)
    await db.run('UPDATE money_groups SET invite_token = ? WHERE id = ?', newInvite(), group.id)
    await db.run('DELETE FROM votes WHERE group_id = ? AND member_id = ?', group.id, target.id)
    await logActivity(db, group.id, 'member-unlinked', me.id, { target: target.id, detail: { name: target.name } })
  })
  return target.user_id
})

export async function invitePreview(db: Db, token: string, userId: string | null): Promise<InvitePreview> {
  const group = await db.one<GroupRow>('SELECT * FROM money_groups WHERE invite_token = ?', token)
  if (!group) throw new HttpError(404, 'This invite link isn’t valid any more. Ask for a new one.')
  const members = (await allMembers(db, group.id)).filter(m => !m.left_at)
  return {
    groupId: group.id, groupName: group.name, currency: group.currency, city: group.trip ? (JSON.parse(group.trip) as TripSummary).city : null,
    alreadyMember: Boolean(userId && members.some(m => m.user_id === userId)),
    // a seat reserved for an address isn't up for grabs through the link
    members: members.map(m => ({ id: m.id, name: m.name, claimable: !m.user_id && !m.email })),
  }
}

export const joinGroup = (db: Db, token: string, user: UserRow, claim?: string | null): Promise<string> => db.tx(async () => {
  const group = await db.one<GroupRow>('SELECT * FROM money_groups WHERE invite_token = ?', token)
  if (!group) throw new HttpError(404, 'This invite link isn’t valid any more. Ask for a new one.')
  if (await db.one('SELECT 1 FROM members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', group.id, user.id)) return group.id

  if (claim) {
    const seat = await db.one<MemberRow>('SELECT * FROM members WHERE id = ? AND group_id = ?', claim, group.id)
    if (!seat || seat.user_id || seat.left_at || seat.email) throw new HttpError(409, 'That seat isn’t available')
    await mutate(db, group.id, async () => {
      await db.run('UPDATE members SET user_id = ? WHERE id = ?', user.id, seat.id)
      await logActivity(db, group.id, 'member-joined', seat.id, { target: seat.id, detail: { name: seat.name } })
    })
    return group.id
  }

  const old = await db.one<MemberRow>('SELECT * FROM members WHERE group_id = ? AND user_id = ? AND left_at IS NOT NULL', group.id, user.id)
  await assertRoom(db, group.id)
  const name = await uniqueName(db, group.id, user.name, old?.id)
  await mutate(db, group.id, async () => {
    const id = old?.id ?? randomUUID()
    if (old) await db.run('UPDATE members SET left_at = NULL, name = ? WHERE id = ?', name, old.id)
    else await db.run('INSERT INTO members (id, group_id, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)', id, group.id, user.id, name, Date.now())
    await logActivity(db, group.id, 'member-joined', id, { target: id, detail: { name } })
  })
  return group.id
})

// ── expenses ──────────────────────────────────────────────────────────────────

function memberIdsIn(input: Pick<ExpenseInput, 'payers' | 'split'>): string[] {
  return [
    ...input.payers.map(p => p.memberId),
    ...input.split.entries.map(e => e.memberId),
    ...(input.split.items ?? []).flatMap(i => i.memberIds),
  ]
}

async function assertMembers(db: Db, groupId: string, ids: string[], alreadyOnExpense: Set<string> = new Set()) {
  const active = new Set((await db.all<{ id: string }>('SELECT id FROM members WHERE group_id = ? AND left_at IS NULL', groupId)).map(m => m.id))
  for (const id of ids) {
    if (!active.has(id) && !alreadyOnExpense.has(id)) throw new HttpError(400, 'Someone on this expense isn’t in the group')
  }
}

// A just-for-me expense has one person on it, whatever the request said.
function normalize(input: ExpenseInput, group: GroupRow, privateTo: string | null): ExpenseInput {
  const fxRate = input.currency === group.currency ? 1 : input.fxRate
  if (!privateTo) return { ...input, fxRate }
  return {
    ...input,
    fxRate,
    payers: [{ memberId: privateTo, amount: input.amount }],
    split: { method: 'equal', entries: [{ memberId: privateTo, value: 1 }] },
  }
}

async function findExpense(db: Db, group: GroupRow, me: MemberRow, id: string): Promise<ExpenseRow> {
  const row = await db.one<ExpenseRow>(`SELECT * FROM expenses WHERE id = ? AND group_id = ? AND ${PRIVATE_OK}`, id, group.id, me.id, me.user_id)
  if (!row) throw new HttpError(404, 'That expense is gone')
  return row
}

export const createExpense = (db: Db, group: GroupRow, me: MemberRow, raw: ExpenseInput, opId?: string) => db.tx(async () => {
  const existing = await db.one<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', raw.id)
  if (existing) {
    // a retry of something that already got through, e.g. the reply was lost on bad signal
    if (existing.group_id === group.id && existing.created_by === me.id) return
    throw new HttpError(409, 'That id is already in use')
  }
  const { n } = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM expenses WHERE group_id = ?', group.id))!
  if (n >= MAX_EXPENSES) throw new HttpError(409, 'This group has reached its limit of expenses')

  const privateTo = raw.private ? me.id : null
  const input = normalize(raw, group, privateTo)
  await assertMembers(db, group.id, memberIdsIn(input))
  const c = computeExpense(input, group.currency)
  const now = Date.now()
  await mutate(db, group.id, async () => {
    await db.run(`INSERT INTO expenses (id, group_id, last_op, title, amount, currency, fx_rate, base_amount, category, date, notes, payers, split, shares, base_paid, base_owed, private_to, private_user, place_id, place_name, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, group.id, opId ?? null, input.title, input.amount, input.currency, input.fxRate, c.baseAmount, input.category, input.date, input.notes,
      JSON.stringify(input.payers), JSON.stringify(input.split), JSON.stringify(c.shares), JSON.stringify(c.basePaid), JSON.stringify(c.baseOwed),
      privateTo, privateTo ? me.user_id : null, input.placeId ?? null, input.placeName ?? null, me.id, now, now)
    await logActivity(db, group.id, 'expense-added', me.id, { ref: input.id, privateTo: privateTo ? me.user_id : null, detail: { title: input.title, amount: input.amount, currency: input.currency, baseAmount: c.baseAmount } })
  })
})

function whatChanged(old: ExpenseRow, input: ExpenseInput, c: { baseAmount: number }): string[] {
  const out: string[] = []
  if (old.title !== input.title) out.push('the name')
  if (old.amount !== input.amount || old.currency !== input.currency || old.base_amount !== c.baseAmount) out.push('the amount')
  if (old.date !== input.date) out.push('the date')
  if (old.category !== input.category) out.push('the category')
  // the same one person paying a new total is just the amount changing
  const oldPayers: { memberId: string }[] = JSON.parse(old.payers)
  const samePayer = oldPayers.length === 1 && input.payers.length === 1 && oldPayers[0].memberId === input.payers[0].memberId
  if (!samePayer && old.payers !== JSON.stringify(input.payers)) out.push('who paid')
  if (old.split !== JSON.stringify(input.split)) out.push('the split')
  if (old.notes !== input.notes) out.push('the notes')
  if ((old.place_id ?? null) !== (input.placeId ?? null)) out.push('the place')
  return out
}

export const updateExpense = (db: Db, group: GroupRow, me: MemberRow, raw: ExpenseInput, baseRev: number, opId?: string) => db.tx(async () => {
  const old = await findExpense(db, group, me, raw.id)
  if (opId && old.last_op === opId) return // a retry that already went through
  if (old.deleted_at) throw new HttpError(409, 'Someone deleted this expense', { current: toExpense(old) })
  if (old.rev !== baseRev) throw new HttpError(409, 'Someone changed this expense while you were editing', { current: toExpense(old) })

  const input = normalize(raw, group, old.private_to)
  const before = new Set(memberIdsIn({ payers: JSON.parse(old.payers), split: JSON.parse(old.split) }))
  await assertMembers(db, group.id, memberIdsIn(input), before)
  const c = computeExpense(input, group.currency)
  const changes = whatChanged(old, input, c)
  await mutate(db, group.id, async () => {
    await db.run(`UPDATE expenses SET rev = rev + 1, last_op = ?, title = ?, amount = ?, currency = ?, fx_rate = ?, base_amount = ?, category = ?, date = ?, notes = ?,
      payers = ?, split = ?, shares = ?, base_paid = ?, base_owed = ?, place_id = ?, place_name = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      opId ?? null, input.title, input.amount, input.currency, input.fxRate, c.baseAmount, input.category, input.date, input.notes,
      JSON.stringify(input.payers), JSON.stringify(input.split), JSON.stringify(c.shares), JSON.stringify(c.basePaid), JSON.stringify(c.baseOwed),
      input.placeId ?? null, input.placeName ?? null, me.id, Date.now(), input.id)
    if (changes.length) await logActivity(db, group.id, 'expense-edited', me.id, { ref: input.id, privateTo: old.private_user, detail: { title: input.title, amount: input.amount, currency: input.currency, baseAmount: c.baseAmount, changes } })
  })
})

export const setExpenseDeleted = (db: Db, group: GroupRow, me: MemberRow, id: string, deleted: boolean) => db.tx(async () => {
  const old = await findExpense(db, group, me, id)
  if (Boolean(old.deleted_at) === deleted) return
  await mutate(db, group.id, async () => {
    await db.run('UPDATE expenses SET deleted_at = ?, deleted_by = ?, rev = rev + 1, updated_at = ? WHERE id = ?', deleted ? Date.now() : null, deleted ? me.id : null, Date.now(), id)
    await logActivity(db, group.id, deleted ? 'expense-deleted' : 'expense-restored', me.id, { ref: id, privateTo: old.private_user, detail: { title: old.title, amount: old.amount, currency: old.currency, baseAmount: old.base_amount } })
  })
})

// ── settling up ───────────────────────────────────────────────────────────────

// Someone who left can owe again if an old expense gets corrected. That has to stay
// settleable, or the people on the other side of it could never reach zero and leave.
async function assertCanSettle(db: Db, groupId: string, ids: string[]) {
  const seats = await db.all<{ id: string; left_at: number | null }>('SELECT id, left_at FROM members WHERE group_id = ?', groupId)
  for (const id of ids) {
    const seat = seats.find(m => m.id === id)
    if (!seat || (seat.left_at && await balanceOf(db, groupId, id) === 0)) throw new HttpError(400, 'That person isn’t in the group')
  }
}

export const createSettlement = (db: Db, group: GroupRow, me: MemberRow, input: SettlementInput) => db.tx(async () => {
  const existing = await db.one<SettlementRow>('SELECT * FROM settlements WHERE id = ?', input.id)
  if (existing) {
    if (existing.group_id === group.id && existing.created_by === me.id) return
    throw new HttpError(409, 'That id is already in use')
  }
  if (input.from === input.to) throw new HttpError(400, 'Pick two different people')
  await assertCanSettle(db, group.id, [input.from, input.to])
  const { n } = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM settlements WHERE group_id = ?', group.id))!
  if (n >= MAX_SETTLEMENTS) throw new HttpError(409, 'This group has reached its limit of payments')
  const fxRate = input.currency === group.currency ? 1 : input.fxRate
  const baseAmount = convert(input.amount, input.currency, fxRate, group.currency)
  if (baseAmount <= 0) throw new HttpError(400, 'That amount is too small to record')
  if (!Number.isSafeInteger(baseAmount) || baseAmount > MAX_AMOUNT) throw new HttpError(400, 'That amount is too large')
  await mutate(db, group.id, async () => {
    await db.run(`INSERT INTO settlements (id, group_id, from_member, to_member, amount, currency, fx_rate, base_amount, date, note, method, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, group.id, input.from, input.to, input.amount, input.currency, fxRate, baseAmount, input.date, input.note, input.method, me.id, Date.now())
    await logActivity(db, group.id, 'settlement-added', me.id, { ref: input.id, detail: { amount: input.amount, currency: input.currency, baseAmount, from: input.from, to: input.to } })
  })
})

export const deleteSettlement = (db: Db, group: GroupRow, me: MemberRow, id: string) => db.tx(async () => {
  const old = await db.one<SettlementRow>('SELECT * FROM settlements WHERE id = ? AND group_id = ?', id, group.id)
  if (!old) throw new HttpError(404, 'That payment is gone')
  if (old.deleted_at) return
  await mutate(db, group.id, async () => {
    await db.run('UPDATE settlements SET deleted_at = ? WHERE id = ?', Date.now(), id)
    await logActivity(db, group.id, 'settlement-deleted', me.id, { ref: id, detail: { amount: old.amount, currency: old.currency, baseAmount: old.base_amount, from: old.from_member, to: old.to_member } })
  })
})

// ── comments, receipts, reminders ─────────────────────────────────────────────

export const addComment = (db: Db, group: GroupRow, me: MemberRow, expenseId: string, id: string, body: string) => db.tx(async () => {
  const expense = await findExpense(db, group, me, expenseId)
  const existing = await db.one<{ group_id: string; member_id: string }>('SELECT group_id, member_id FROM comments WHERE id = ?', id)
  if (existing) {
    if (existing.group_id === group.id && existing.member_id === me.id) return
    throw new HttpError(409, 'That id is already in use')
  }
  await mutate(db, group.id, async () => {
    await db.run('INSERT INTO comments (id, group_id, expense_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, group.id, expenseId, me.id, body, Date.now())
    await logActivity(db, group.id, 'comment', me.id, { ref: expenseId, privateTo: expense.private_user, detail: { title: expense.title, body: body.slice(0, 140), commentId: id } })
  })
})

export const deleteComment = (db: Db, group: GroupRow, me: MemberRow, id: string) => db.tx(async () => {
  const c = await db.one<{ member_id: string }>('SELECT member_id FROM comments WHERE id = ? AND group_id = ?', id, group.id)
  if (!c) return
  if (c.member_id !== me.id) throw new HttpError(403, 'You can only delete your own comments')
  await mutate(db, group.id, async () => {
    await db.run('DELETE FROM comments WHERE id = ?', id)
    // the feed quotes the comment, so it has to go too
    await db.run(`DELETE FROM activity WHERE group_id = ? AND kind = 'comment' AND detail::json->>'commentId' = ?`, group.id, id)
  })
})

export const addReceipt = (db: Db, group: GroupRow, me: MemberRow, expenseId: string, mime: string, bytes: Buffer): Promise<string> => db.tx(async () => {
  const expense = await findExpense(db, group, me, expenseId)
  const perExpense = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM receipts WHERE expense_id = ?', expenseId))!.n
  if (perExpense >= MAX_RECEIPTS_PER_EXPENSE) throw new HttpError(409, `An expense can have up to ${MAX_RECEIPTS_PER_EXPENSE} photos`)
  const perGroup = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM receipts WHERE group_id = ?', group.id))!.n
  if (perGroup >= MAX_RECEIPTS_PER_GROUP) throw new HttpError(409, 'This group has reached its limit of receipt photos')
  const id = randomUUID()
  await mutate(db, group.id, async () => {
    await db.run('INSERT INTO receipts (id, group_id, expense_id, mime, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, group.id, expenseId, mime, bytes, me.id, Date.now())
    await logActivity(db, group.id, 'receipt-added', me.id, { ref: expenseId, privateTo: expense.private_user, detail: { title: expense.title } })
  })
  return id
})

const canSeeReceipt = (row: { private_to: string | null; private_user: string | null }, me: MemberRow) =>
  !row.private_to || (row.private_to === me.id && row.private_user === me.user_id)

export async function readReceipt(db: Db, group: GroupRow, me: MemberRow, id: string): Promise<{ mime: string; bytes: Uint8Array }> {
  const row = await db.one<{ mime: string; bytes: Uint8Array; private_to: string | null; private_user: string | null }>(
    'SELECT r.mime, r.bytes, e.private_to, e.private_user FROM receipts r JOIN expenses e ON e.id = r.expense_id WHERE r.id = ? AND r.group_id = ?', id, group.id)
  if (!row || !canSeeReceipt(row, me)) throw new HttpError(404, 'That photo is gone')
  return row
}

export const deleteReceipt = (db: Db, group: GroupRow, me: MemberRow, id: string) => db.tx(async () => {
  const row = await db.one<{ expense_id: string; private_to: string | null; private_user: string | null }>(
    'SELECT r.expense_id, e.private_to, e.private_user FROM receipts r JOIN expenses e ON e.id = r.expense_id WHERE r.id = ? AND r.group_id = ?', id, group.id)
  if (!row || !canSeeReceipt(row, me)) throw new HttpError(404, 'That photo is gone')
  await mutate(db, group.id, async () => { await db.run('DELETE FROM receipts WHERE id = ?', id) })
})

const REMIND_GAP_MS = 12 * 3_600_000

export const remind = (db: Db, group: GroupRow, me: MemberRow, to: string, amount: number) => db.tx(async () => {
  await assertMembers(db, group.id, [to])
  if (to === me.id) throw new HttpError(400, 'That’s you')
  const recent = await db.one('SELECT 1 FROM activity WHERE group_id = ? AND kind = ? AND actor = ? AND target = ? AND created_at > ?', group.id, 'remind', me.id, to, Date.now() - REMIND_GAP_MS)
  if (recent) throw new HttpError(429, 'You already reminded them today')
  await mutate(db, group.id, async () => {
    await logActivity(db, group.id, 'remind', me.id, { target: to, detail: { amount, currency: group.currency } })
  })
})

// ── the shared trip ───────────────────────────────────────────────────────────

const NOTE_LIMIT = 200

export async function readTrip(db: Db, group: GroupRow, me: MemberRow, planSince: number): Promise<SharedTrip> {
  const [memberRows, voteRows, noteRows] = await Promise.all([
    allMembers(db, group.id),
    db.all<{ place_id: string; member_id: string; vote: VoteValue }>(
      `SELECT v.place_id, v.member_id, v.vote FROM votes v JOIN members m ON m.id = v.member_id WHERE v.group_id = ? AND m.left_at IS NULL`, group.id),
    db.all<{ id: string; member_id: string; body: string; created_at: number }>(
      'SELECT * FROM (SELECT * FROM trip_notes WHERE group_id = ? ORDER BY created_at DESC LIMIT ?) latest ORDER BY created_at', group.id, NOTE_LIMIT),
  ])
  const people = memberRows.filter(m => !m.left_at).map(m => ({
    id: m.id, name: m.name, role: m.role, joined: Boolean(m.user_id), waitingEmail: !m.user_id && m.email ? maskEmail(m.email) : null,
  }))
  return {
    groupId: group.id, name: group.name, version: group.version, planVersion: group.plan_version,
    plan: group.plan && planSince !== group.plan_version ? JSON.parse(group.plan) as SharedPlan : null,
    hasPlan: Boolean(group.plan),
    me: me.id, role: me.role, inviteToken: me.role === 'owner' ? group.invite_token : '',
    people,
    votes: voteRows.map<PlaceVote>(v => ({ placeId: v.place_id, memberId: v.member_id, vote: v.vote })),
    notes: noteRows.map<TripNote>(n => ({ id: n.id, memberId: n.member_id, body: n.body, createdAt: n.created_at })),
  }
}

// Only the admin writes the plan. Carrying the version they started from means a second
// device with an out-of-date copy gets told, rather than undoing newer changes.
export function publishPlan(db: Db, group: GroupRow, me: MemberRow, input: PublishPlan): Promise<number> {
  assertAdmin(me, 'change the plan')
  return mutate(db, group.id, async () => {
    // looked up here rather than taken from `group`, which was read before a big plan finished uploading
    const current = (await db.one<{ plan_version: number }>('SELECT plan_version FROM money_groups WHERE id = ?', group.id))!.plan_version
    if (input.baseVersion !== current) throw new HttpError(409, 'The plan changed somewhere else', { planVersion: current })
    await db.run('UPDATE money_groups SET plan = ?, plan_version = ?, trip = COALESCE(?, trip) WHERE id = ?', JSON.stringify(input.plan), current + 1, input.summary ? JSON.stringify(input.summary) : null, group.id)
    return current + 1
  })
}

// Anyone in the group can vote, on a place that's actually up for a vote in this trip. The rest
// are reported back rather than refused, so one out-of-date vote doesn't hold up the others.
export async function castVotes(db: Db, group: GroupRow, me: MemberRow, votes: { placeId: string; vote: VoteValue | null }[]): Promise<string[]> {
  const plan = group.plan ? JSON.parse(group.plan) as SharedPlan : null
  if (!plan) throw new HttpError(409, 'There’s nothing to vote on yet')
  const known = new Set([...plan.deck.map(c => c.id), ...Object.keys(plan.candidates)])
  const usable = votes.filter(v => known.has(v.placeId))
  if (usable.length) await mutate(db, group.id, async () => {
    for (const v of usable) {
      if (v.vote === null) await db.run('DELETE FROM votes WHERE group_id = ? AND place_id = ? AND member_id = ?', group.id, v.placeId, me.id)
      else {
        await db.run(`INSERT INTO votes (group_id, place_id, member_id, vote, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (group_id, place_id, member_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`, group.id, v.placeId, me.id, v.vote, Date.now())
      }
    }
  })
  return votes.filter(v => !known.has(v.placeId)).map(v => v.placeId)
}

export const addNote = (db: Db, group: GroupRow, me: MemberRow, id: string, body: string) => db.tx(async () => {
  const existing = await db.one<{ group_id: string; member_id: string }>('SELECT group_id, member_id FROM trip_notes WHERE id = ?', id)
  if (existing) {
    if (existing.group_id === group.id && existing.member_id === me.id) return
    throw new HttpError(409, 'That id is already in use')
  }
  await mutate(db, group.id, async () => {
    await db.run('INSERT INTO trip_notes (id, group_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?)', id, group.id, me.id, body, Date.now())
  })
})

export const updateAccount = (db: Db, user: UserRow, patch: { name?: string; payHandle?: string | null }): Promise<string[]> => db.tx(async () => {
  const seats = await db.all<{ id: string; group_id: string }>('SELECT id, group_id FROM members WHERE user_id = ? AND left_at IS NULL', user.id)
  if (patch.name !== undefined) {
    await db.run('UPDATE users SET name = ? WHERE id = ?', patch.name, user.id)
    // a group where someone already goes by this name keeps the old one, so people stay told apart
    for (const seat of seats) {
      if (!await nameTaken(db, seat.group_id, patch.name, seat.id)) await db.run('UPDATE members SET name = ? WHERE id = ?', patch.name, seat.id)
    }
  }
  if (patch.payHandle !== undefined) await db.run('UPDATE users SET pay_handle = ? WHERE id = ?', patch.payHandle, user.id)
  await db.run('UPDATE money_groups SET version = version + 1 WHERE id IN (SELECT group_id FROM members WHERE user_id = ? AND left_at IS NULL)', user.id)
  return seats.map(s => s.group_id)
})
