import type { TripState } from '../state/tripStore'
import { cityById } from '../data/cities'
import { estimateCosts } from '../planner/insights'
import { categoryOf } from './categories'
import { amountToInput, fmtMoney } from './currency'
import type { ActivityItem, Expense, GroupState, Member, PlanKey, TripSummary } from './types'

// What the money screens need to know about the trip on the map.
export function tripSummaryOf(state: TripState): TripSummary | null {
  const city = cityById(state.brief.destination)
  if (!city || !state.days.length) return null
  const costs = estimateCosts(state.brief, state.days, city, state.hotel)
  return {
    name: `${city.name} · ${state.days.length} day${state.days.length > 1 ? 's' : ''}`,
    city: city.name,
    country: city.country,
    startDate: state.brief.startDate ?? null,
    days: state.days.length,
    travelers: state.brief.travelers ?? 2,
    localCurrency: city.essentials.currency.code,
    plannedUsd: Object.fromEntries(costs.lines.map(l => [l.key, Math.round(l.amount)])) as Partial<Record<PlanKey, number>>,
    budgetUsd: state.brief.budgetAmount ?? null,
    stops: state.days.flatMap(d => d.stops.map(s => ({ id: s.place.id, name: s.place.name, day: d.day, kind: s.place.kind }))),
  }
}

// Whoever's reading: "You" for yourself, otherwise their name.
export const nameOf = (members: Member[], id: string | null | undefined, me?: string) => {
  if (id && id === me) return 'You'
  return members.find(m => m.id === id)?.name ?? 'Someone'
}

export const initialOf = (name: string) => (name.trim()[0] ?? '?').toUpperCase()

// Each person keeps one avatar tint across every screen.
export const hueOf = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export const niceDate = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' })

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// One line of the activity feed.
export function describeActivity(a: ActivityItem, s: Pick<GroupState, 'members' | 'me' | 'group'>): { icon: string; text: string } {
  const who = nameOf(s.members, a.actor, s.me)
  const money = a.detail.amount !== undefined && a.detail.currency ? fmtMoney(a.detail.amount, a.detail.currency) : ''
  const title = a.detail.title ? `“${a.detail.title}”` : ''
  const target = nameOf(s.members, a.target, s.me)
  switch (a.kind) {
    case 'group-created': return { icon: '🧭', text: `${who} started this group` }
    case 'group-renamed': return { icon: '✏️', text: `${who} renamed the group to “${a.detail.name}”` }
    case 'group-settings': return { icon: '⚙️', text: `${who} ${a.detail.changes?.join(', ') ?? 'changed the settings'}${money ? ` (${money})` : ''}` }
    case 'member-joined': return { icon: '👋', text: `${a.detail.name} joined` }
    case 'member-added': return { icon: '➕', text: `${who} added ${a.detail.name}` }
    case 'member-removed': return { icon: '👤', text: `${who} removed ${a.detail.name}` }
    case 'member-left': return { icon: '🚪', text: `${a.detail.name} left` }
    case 'member-unlinked': return { icon: '🔓', text: `${who} released ${a.detail.name}’s seat so it can be claimed again` }
    case 'expense-added': return { icon: '🧾', text: `${who} added ${title} · ${money}` }
    case 'expense-edited': return { icon: '✏️', text: `${who} changed ${a.detail.changes?.join(', ') ?? 'details'} on ${title}` }
    case 'expense-deleted': return { icon: '🗑️', text: `${who} deleted ${title} · ${money}` }
    case 'expense-restored': return { icon: '↩️', text: `${who} restored ${title} · ${money}` }
    case 'settlement-added': return { icon: '🤝', text: `${nameOf(s.members, a.detail.from, s.me)} paid ${nameOf(s.members, a.detail.to, s.me)} ${money}${a.actor !== a.detail.from ? ` (recorded by ${who})` : ''}` }
    case 'settlement-deleted': return { icon: '🗑️', text: `${who} removed a ${money} payment from ${nameOf(s.members, a.detail.from, s.me)} to ${nameOf(s.members, a.detail.to, s.me)}` }
    case 'comment': return { icon: '💬', text: `${who} on ${title}: ${a.detail.body ?? ''}` }
    case 'receipt-added': return { icon: '📷', text: `${who} added a photo to ${title}` }
    case 'remind': return { icon: '🔔', text: a.target === s.me ? `${who} reminded you about ${money}` : `You reminded ${target} about ${money}` }
  }
}

// Clipboard API needs https; a phone on the LAN gets the hidden-textarea route.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text })
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

// Spreadsheets run cells that start with these, so a title like "=HYPERLINK(...)"
// from someone in the group shouldn't be able to run on another person's machine.
const csvCell = (v: string | number) => {
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(s: GroupState): string {
  const people = s.members.filter(m => s.expenses.some(e => !e.privateTo && (m.id in e.baseOwed || m.id in e.basePaid)) || !m.left)
  const c = s.group.currency
  const head = ['Date', 'Type', 'Description', 'Category', 'Amount', 'Currency', 'Rate', `Amount (${c})`, 'Paid by', ...people.map(p => `${p.name} owes (${c})`), 'Notes']
  const major = (n: number) => amountToInput(n, c)
  const rows: { date: string; cells: (string | number)[] }[] = s.expenses.filter(e => !e.deletedAt && !e.privateTo).map(e => ({
    date: e.date,
    cells: [e.date, 'Expense', e.title, categoryOf(e.category).label, amountToInput(e.amount, e.currency), e.currency, e.fxRate, major(e.baseAmount),
      Object.keys(e.basePaid).map(id => nameOf(s.members, id)).join(' + '), ...people.map(p => major(e.baseOwed[p.id] ?? 0)), e.notes],
  }))
  for (const p of s.settlements.filter(x => !x.deletedAt)) {
    rows.push({
      date: p.date,
      cells: [p.date, 'Payment', `${nameOf(s.members, p.from)} paid ${nameOf(s.members, p.to)}`, '', amountToInput(p.amount, p.currency), p.currency, p.fxRate, major(p.baseAmount), nameOf(s.members, p.from), ...people.map(() => ''), p.note],
    })
  }
  rows.sort((a, b) => a.date.localeCompare(b.date))
  return [head, ...rows.map(r => r.cells)].map(r => r.map(csvCell).join(',')).join('\r\n')
}

export function download(name: string, text: string, type: string) {
  // the byte-order mark tells Excel it's UTF-8, so ₹ and ¥ survive
  const blob = new Blob(['﻿', text], { type })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// Phone photos are several megabytes; a receipt only needs to stay readable.
export function shrinkImage(file: File, maxSide = 1600, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const k = Math.min(1, maxSide / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * k)
      canvas.height = Math.round(img.height * k)
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Couldn’t read that photo'))), 'image/jpeg', quality)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Couldn’t read that photo. Try a JPEG or PNG.'))
    }
    img.src = url
  })
}

// Opens the person's UPI app with the payment filled in. Only for what looks like a real
// UPI id in rupees: a handle is free text set by another member, so it's checked before use.
export function upiLink(handle: string | null, payeeName: string, minor: number, currency: string, note: string): string | null {
  if (!handle || currency !== 'INR' || !/^[\w.-]{2,64}@[\w.-]{2,32}$/.test(handle)) return null
  const q = new URLSearchParams({ pa: handle, pn: payeeName, am: (minor / 100).toFixed(2), cu: 'INR', tn: note.slice(0, 60) })
  return `upi://pay?${q.toString()}`
}

export const expenseIsMine = (e: Expense, me: string) => me in e.baseOwed || me in e.basePaid
