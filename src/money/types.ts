// Money domain model, shared by the browser and the API server.
// Every amount is an integer in a currency's minor unit (paise, cents, whole yen),
// so balances never pick up floating point drift.

export type SplitMethod = 'equal' | 'exact' | 'percent' | 'shares' | 'adjust' | 'itemized'

// What `value` means depends on the method:
//   equal    ignored        exact   minor units     percent  basis points (2550 = 25.5%)
//   shares   1/100 of a share (150 = 1.5 shares)    adjust   minor units, may be negative
export interface SplitEntry { memberId: string; value: number }
export interface SplitItem { id: string; name: string; amount: number; memberIds: string[] }
export interface SplitInput { method: SplitMethod; entries: SplitEntry[]; items?: SplitItem[] }
export interface Payer { memberId: string; amount: number }

export type MoneyMap = Record<string, number> // member id -> minor units

// What the browser sends. The server recomputes everything derived from it.
export interface ExpenseInput {
  id: string
  title: string
  amount: number
  currency: string
  fxRate: number                // 1 unit of `currency` = fxRate units of the group currency
  category: CategoryId
  date: string                  // yyyy-mm-dd
  notes: string
  payers: Payer[]
  split: SplitInput
  private: boolean              // just for me: counts in my spending, never in group balances
  placeId?: string | null
  placeName?: string | null
}

export interface Expense extends Omit<ExpenseInput, 'private'> {
  groupId: string
  rev: number
  baseAmount: number            // minor units of the group currency
  shares: MoneyMap              // who owes what, in the expense's own currency
  basePaid: MoneyMap            // in the group currency, sums to baseAmount
  baseOwed: MoneyMap            // in the group currency, sums to baseAmount
  privateTo: string | null      // member id
  createdBy: string
  createdAt: number
  updatedBy: string | null
  updatedAt: number
  deletedAt: number | null
  deletedBy: string | null
  receipts: string[]
  pending?: boolean             // saved on this device, not on the server yet
}

export type PayMethod = 'cash' | 'upi' | 'card' | 'bank' | 'other'

export interface SettlementInput {
  id: string
  from: string
  to: string
  amount: number
  currency: string
  fxRate: number
  date: string
  note: string
  method: PayMethod
}

export interface Settlement extends SettlementInput {
  groupId: string
  baseAmount: number
  createdBy: string
  createdAt: number
  deletedAt: number | null
  pending?: boolean
}

export interface Comment { id: string; expenseId: string; memberId: string; body: string; createdAt: number; pending?: boolean }

export interface Member {
  id: string
  name: string
  role: 'owner' | 'member'
  joined: boolean               // false = added by someone else, waiting for them to arrive
  waitingEmail: string | null   // the masked address a waiting seat is reserved for
  left: boolean
  payHandle: string | null      // UPI id or similar, shown to the group so they can pay this person
  budget: number | null         // personal budget; only ever sent to that member
}

export type ActivityKind =
  | 'group-created' | 'group-renamed' | 'group-settings' | 'member-joined' | 'member-added' | 'member-removed' | 'member-left' | 'member-unlinked'
  | 'expense-added' | 'expense-edited' | 'expense-deleted' | 'expense-restored'
  | 'settlement-added' | 'settlement-deleted' | 'comment' | 'remind' | 'receipt-added'

export interface ActivityItem {
  seq: number
  kind: ActivityKind
  actor: string | null          // member id
  ref: string | null            // expense or settlement id
  target: string | null         // the member this is about
  detail: { title?: string; amount?: number; currency?: string; baseAmount?: number; changes?: string[]; name?: string; body?: string; commentId?: string; from?: string; to?: string }
  createdAt: number
}

export type PlanKey = 'stay' | 'food' | 'entry' | 'transport' | 'buffer'

// The trip a group is for. Friends who join by link don't have the trip in their
// browser, so the group carries what the money screens need from it.
export interface TripSummary {
  name: string
  city: string
  country: string
  startDate: string | null
  days: number
  travelers: number
  localCurrency: string
  plannedUsd: Partial<Record<PlanKey, number>>
  budgetUsd: number | null
  stops: { id: string; name: string; day: number; kind: string }[]
}

export interface Group {
  id: string
  name: string
  currency: string
  simplify: boolean
  budget: number | null
  inviteToken: string
  trip: TripSummary | null
  version: number
  createdAt: number
}

export interface GroupState {
  group: Group
  me: string
  members: Member[]
  expenses: Expense[]
  settlements: Settlement[]
  comments: Comment[]
  activity: ActivityItem[]
}

export interface GroupSummary {
  id: string
  name: string
  currency: string
  city: string | null
  memberCount: number
  myNet: number
  mySpend: number
  total: number
  updatedAt: number
  settled: boolean
  role: 'owner' | 'member'
  phase: string | null          // where the trip plan has got to, if the group has one
}

export interface Account { id: string; name: string; email: string; hasPassword: boolean; payHandle: string | null }

export interface InvitePreview {
  groupId: string
  groupName: string
  currency: string
  city: string | null
  alreadyMember: boolean
  members: { id: string; name: string; claimable: boolean }[]
}

export interface Debt { from: string; to: string; amount: number }

export type CategoryId = 'food' | 'groceries' | 'stay' | 'transport' | 'flights' | 'activities' | 'shopping' | 'fees' | 'other'
