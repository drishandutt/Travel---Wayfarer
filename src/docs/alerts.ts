import type { AlertKind, Extracted, LocalTime, Segment } from './types'

// The alerts a document raises, worked out from what was read from it: when online check-in
// opens and when to leave for a flight, the morning of a check-in, a passport running out
// before (or too close to) a trip, insurance that doesn't cover the dates. Pure, so the
// server (which stores and delivers them) and the tests share it.

export interface TripDates { id: string; name: string; start: string; days: number } // start: YYYY-MM-DD
export interface PlannedAlert { key: string; kind: AlertKind; title: string; body: string; dueAt: number }

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// "+01:00" → 60
export function offsetMinutes(offset: string | null | undefined): number | null {
  const m = offset && /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim())
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : null
}

// The moment a printed local time happens. `fallback`: the uploader's own UTC offset, in
// minutes, for a ticket that doesn't say where its times are.
export function instant(t: LocalTime | null | undefined, fallback: number): number | null {
  const m = t && /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(t.at)
  if (!m) return null
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0)
  return utc - (offsetMinutes(t!.offset) ?? fallback) * MIN
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// As printed, in the place's own time: "Thu 3 Dec, 10:30"
export function fmtLocal(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(at)
  if (!m) return at
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return `${WEEK[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1]}${m[4] ? `, ${m[4]}:${m[5]}` : ''}`
}
export const fmtDate = (ymd: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : ymd }
const clockOf = (at: string) => /T(\d{2}:\d{2})/.exec(at)?.[1] ?? null

const ymdMs = (ymd: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null }
const addMonths = (ms: number, n: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime() }
// 09:00 that day where the uploader is
const morningOf = (dayMs: number, fallback: number) => dayMs + 9 * HOUR - fallback * MIN

const leg = (s: Segment) => [s.number, `${short(s.from)} → ${short(s.to)}`].filter(Boolean).join(' ')
// "London Heathrow (LHR)" → "London Heathrow"
const short = (place: string) => place.replace(/\s*\([^)]*\)\s*$/, '').trim() || place
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ')

const LEAD: Partial<Record<Extracted['kind'], number>> = { flight: 3 * HOUR, train: 90 * MIN, bus: 60 * MIN, ferry: 90 * MIN }
const VERB: Partial<Record<Extracted['kind'], string>> = { flight: 'Flight', train: 'Train', bus: 'Coach', ferry: 'Ferry' }

export function alertsFor(docId: string, d: Extracted, opts: { fallbackOffset: number; trips: TripDates[]; now: number }): PlannedAlert[] {
  const { fallbackOffset: fb, now } = opts
  const out: PlannedAlert[] = []
  const add = (key: string, kind: AlertKind, title: string, body: string, dueAt: number) => out.push({ key: `${docId}:${key}`, kind, title, body, dueAt })
  const ref = d.reference ? `Booking ${d.reference}` : null

  // journeys: check-in for flights, and a nudge to leave for every leg
  d.segments.forEach((s, i) => {
    const leaves = instant(s.depart, fb)
    if (leaves === null || leaves <= now) return
    const what = VERB[d.kind] ?? 'Trip'
    if (d.kind === 'flight') {
      const opens = leaves - 24 * HOUR
      add(`checkin:${i}`, 'checkin', `Check in for ${leg(s)}`,
        join(`Online check-in is usually open from now for ${fmtLocal(s.depart.at)}`, d.checkinUrl, ref), Math.max(opens, now))
    }
    const lead = LEAD[d.kind] ?? 2 * HOUR
    add(`depart:${i}`, 'depart', `${what} ${s.number ?? ''} leaves at ${clockOf(s.depart.at) ?? fmtLocal(s.depart.at)}`.replace(/\s+/g, ' ').trim(),
      join(`${short(s.from)} → ${short(s.to)}`, s.terminal && `Terminal ${s.terminal}`, s.seat && `Seat ${s.seat}`, ref), Math.max(leaves - lead, now))
  })

  // stays, car hire and events: the morning of, or a few hours before
  const begins = instant(d.start, fb)
  const ends = instant(d.end, fb)
  const where = d.place ? join(d.place.name, d.place.address) : null
  if (d.kind === 'hotel') {
    if (begins !== null && begins > now) {
      const day = ymdMs(d.start!.at)!
      add('stay-in', 'stay-in', `Check in at ${d.place?.name ?? 'your stay'} today`, join(clockOf(d.start!.at) && `From ${clockOf(d.start!.at)}`, where, ref), Math.max(Math.min(morningOf(day, offsetMinutes(d.start!.offset) ?? fb), begins - 3 * HOUR), now))
    }
    if (ends !== null && ends > now) {
      const day = ymdMs(d.end!.at)!
      add('stay-out', 'stay-out', `Check out of ${d.place?.name ?? 'your stay'} today`, join(clockOf(d.end!.at) && `By ${clockOf(d.end!.at)}`, ref), Math.max(Math.min(morningOf(day, offsetMinutes(d.end!.offset) ?? fb) - 1 * HOUR, ends - 2 * HOUR), now))
    }
  }
  if (d.kind === 'car' && begins !== null && begins > now) add('pickup', 'pickup', `Pick up your hire car at ${clockOf(d.start!.at) ?? fmtLocal(d.start!.at)}`, join(where, ref, 'Bring your licence and the card you booked with'), Math.max(begins - 2 * HOUR, now))
  if (d.kind === 'event' && begins !== null && begins > now) add('event', 'event', `${d.title} at ${clockOf(d.start!.at) ?? fmtLocal(d.start!.at)}`, join(fmtLocal(d.start!.at), where, ref), Math.max(begins - 3 * HOUR, now))

  // passports, IDs and visas: running out, and not lasting the trip
  const upcoming = opts.trips.filter(t => { const s = ymdMs(t.start); return s !== null && s + t.days * DAY >= now })
  const name = d.kind === 'passport' ? 'passport' : d.kind === 'id' ? 'ID' : 'visa'
  const whose = d.holder ? `${d.holder.split(/\s+/)[0]}’s ${name}` : `Your ${name}`
  if ((d.kind === 'passport' || d.kind === 'id' || d.kind === 'visa') && d.expires && ymdMs(d.expires) !== null) {
    const expiry = ymdMs(d.expires)!
    const marks = d.kind === 'passport' ? [6, 3, 1] : d.kind === 'id' ? [3, 1] : []
    for (const months of marks) {
      const due = morningOf(addMonths(expiry, -months), fb)
      if (due > now) add(`expires:${months}`, 'expires', `${whose} expires in ${months} month${months > 1 ? 's' : ''}`, `It runs out on ${fmtDate(d.expires)}.${d.kind === 'passport' ? ' Many countries want 6 months left on arrival, and renewing can take weeks.' : ''}`, due)
    }
    if (d.kind === 'visa' && morningOf(expiry - 14 * DAY, fb) > now) add('expires:visa', 'expires', `${whose} ends in 2 weeks`, `It’s valid until ${fmtDate(d.expires)}.`, morningOf(expiry - 14 * DAY, fb))
    for (const t of upcoming) {
      const start = ymdMs(t.start)!
      const end = start + Math.max(1, t.days) * DAY
      if (expiry < end) add(`trip:${t.id}`, 'invalid-for-trip', `${whose} runs out before ${t.name} ends`, `It expires on ${fmtDate(d.expires)}; the trip starts ${fmtDate(t.start)}. Renew it before you go.`, now)
      else if (d.kind === 'passport' && expiry < addMonths(end, 6)) add(`trip:${t.id}`, 'invalid-for-trip', `${whose} has under 6 months left on ${t.name}`, `It expires on ${fmtDate(d.expires)}. Many countries ask for 6 months beyond your stay (Schengen: 3 months after you leave), so check the entry rules for ${t.name}.`, now)
    }
  }
  if (d.kind === 'visa' && begins !== null) {
    for (const t of upcoming) {
      const start = ymdMs(t.start)!
      if (start < begins - DAY) add(`early:${t.id}`, 'invalid-for-trip', `${whose} starts after ${t.name} begins`, `It’s valid from ${fmtLocal(d.start!.at)}; the trip starts ${fmtDate(t.start)}.`, now)
    }
  }

  // insurance: cover running out, and trips it doesn't reach
  if (d.kind === 'insurance' && ends !== null) {
    const day = ymdMs(d.end!.at)!
    const warn = morningOf(day - 7 * DAY, fb)
    if (warn > now) add('cover-ends', 'cover-ends', 'Your travel insurance ends in a week', join(`Cover runs to ${fmtLocal(d.end!.at)}`, ref), warn)
    for (const t of upcoming) {
      const start = ymdMs(t.start)!
      const end = start + Math.max(1, t.days) * DAY
      if ((begins !== null && start < begins - DAY) || end > ends + DAY) add(`trip:${t.id}`, 'trip-uncovered', `Your insurance doesn’t cover all of ${t.name}`, join(`Cover: ${d.start ? fmtLocal(d.start.at) : '?'} to ${fmtLocal(d.end!.at)}`, `Trip: ${fmtDate(t.start)}, ${t.days} day${t.days > 1 ? 's' : ''}`), now)
    }
  }
  return out
}
