import type { City, DayPlan, Place, TripBrief } from '../types'

// Real calendar time for a trip with dates: the weekday of each day, the days a place is closed
// (from its opening hours, as OpenStreetMap writes them), and when the sun sets.

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
export const WEEKDAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// The weekday (0 = Sunday) of day `n` of the trip, when it has dates.
export function weekdayOf(brief: Pick<TripBrief, 'startDate'>, n: number): number | undefined {
  if (!brief.startDate) return undefined
  const d = new Date(`${brief.startDate}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return undefined
  d.setUTCDate(d.getUTCDate() + n - 1)
  return d.getUTCDay()
}

export function isoOf(brief: Pick<TripBrief, 'startDate'>, n: number): string | undefined {
  if (!brief.startDate) return undefined
  const d = new Date(`${brief.startDate}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return undefined
  d.setUTCDate(d.getUTCDate() + n - 1)
  return d.toISOString().slice(0, 10)
}

// The weekdays a place is shut, from simple opening hours: "Tu-Su 12:00-23:00", "Mo-Fr 09:00-17:00;
// Sa 10:00-14:00", "Mo off", "24/7". Anything it can't read says nothing (undefined), never a guess.
export function closedDays(hours?: string): number[] | undefined {
  if (!hours) return undefined
  const h = hours.trim()
  if (/^24\/7$/.test(h)) return []
  const open = new Set<number>()
  const shut = new Set<number>()
  let read = false
  for (const raw of h.split(';')) {
    const rule = raw.trim()
    // a public holiday's rule says nothing about the weekdays
    if (!rule || /^PH\b/.test(rule)) continue
    // school holidays, months, weeks and the like: too much to read reliably
    if (/\b(PH|SH|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|week|easter|sunrise|sunset)\b/i.test(rule) || /\[/.test(rule)) return undefined
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s*(.*)$/)
    const days = m ? expand(m[1]) : [0, 1, 2, 3, 4, 5, 6]
    const rest = (m ? m[2] : rule).trim()
    if (!m && !/^\d{1,2}:\d{2}/.test(rest)) return undefined
    if (!days) return undefined
    if (/^(off|closed)$/i.test(rest)) days.forEach(d => shut.add(d))
    else if (/^\d{1,2}:\d{2}/.test(rest) || rest === '') days.forEach(d => open.add(d))
    else return undefined
    read = true
  }
  if (!read) return undefined
  // only "Mo off" said: the other days aren't known to be shut
  if (!open.size) return [...shut].sort()
  return [0, 1, 2, 3, 4, 5, 6].filter(d => shut.has(d) || !open.has(d))
}

function expand(spec: string): number[] | undefined {
  const out = new Set<number>()
  for (const part of spec.split(',').filter(Boolean)) {
    const [a, b] = part.split('-')
    const from = DAYS.indexOf(a)
    const to = b ? DAYS.indexOf(b) : from
    if (from < 0 || to < 0) return undefined
    // OSM weeks start on Monday: "Fr-Mo" wraps over the weekend
    for (let i = 0, d = from; i < 7; i++, d = (d + 1) % 7) { out.add(d); if (d === to) break }
  }
  return [...out]
}

// Is this place shut on day `n` of the trip?
export function closedOnDay(p: Place, brief: Pick<TripBrief, 'startDate'>, n: number): boolean {
  const wd = weekdayOf(brief, n)
  if (wd === undefined) return false
  return closedDays(p.hours)?.includes(wd) ?? false
}

// Stops on a day they're usually closed: "Bastian is usually closed on Mondays".
export function closedStops(day: DayPlan, brief: Pick<TripBrief, 'startDate'>): Place[] {
  return day.stops.map(s => s.place).filter(p => closedOnDay(p, brief, day.day))
}

// ── the sun ─────────────────────────────────────────────────────────────────

const rad = Math.PI / 180

// Sunrise or sunset in minutes after UTC midnight of `date` (yyyy-mm-dd), by the almanac method
// (accurate to a minute or two). Undefined where the sun doesn't rise or set that day.
function sunUtc(lat: number, lng: number, date: string, rising: boolean): number | undefined {
  const d = new Date(`${date}T00:00:00Z`)
  const day = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000)
  const lngHour = lng / 15
  const t = day + ((rising ? 6 : 18) - lngHour) / 24
  const M = 0.9856 * t - 3.289
  const L = (M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634 + 360) % 360
  let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 360) % 360
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15
  const sinDec = 0.39782 * Math.sin(L * rad)
  const cosDec = Math.cos(Math.asin(sinDec))
  const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad))
  if (cosH > 1 || cosH < -1) return undefined
  const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15
  const T = H + RA - 0.06571 * t - 6.622
  const ut = ((T - lngHour) % 24 + 24) % 24
  return ut * 60
}

// Minutes after local midnight, in the city's time zone.
function local(date: string, utcMinutes: number, timeZone: string): number {
  const at = new Date(Date.parse(`${date}T00:00:00Z`) + utcMinutes * 60_000)
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

export function sunset(city: Pick<City, 'center' | 'essentials'>, date: string): number | undefined {
  const utc = sunUtc(city.center[1], city.center[0], date, false)
  if (utc === undefined) return undefined
  try { return local(date, utc, city.essentials.timezone) } catch { return undefined }
}

export function sunrise(city: Pick<City, 'center' | 'essentials'>, date: string): number | undefined {
  const utc = sunUtc(city.center[1], city.center[0], date, true)
  if (utc === undefined) return undefined
  try { return local(date, utc, city.essentials.timezone) } catch { return undefined }
}

// Sunset on day `n` of a trip with dates.
export function sunsetOnDay(city: Pick<City, 'center' | 'essentials'> | undefined, brief: Pick<TripBrief, 'startDate'>, n: number): number | undefined {
  const date = isoOf(brief, n)
  return city && date ? sunset(city, date) : undefined
}

// Minutes spent getting around on a day, to and from the base included.
export const movingMinutes = (day: DayPlan) => day.legs.reduce((s, l) => s + l.minutes, 0)
