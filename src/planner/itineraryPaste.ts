import type { DayPlan, HotelScore, Place, TripBrief } from '../types'

// An itinerary pasted into the trip chat (from Claude, ChatGPT, a doc, a friend): spotted here,
// read on the server (server/importItinerary.ts) and opened as a new trip.

const DAY = /(^|\n)\s*(?:[#*>\-•\d.)\s]*)\**\s*(?:day\s*\d+|d\d+\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/gi
const TIME = /(^|\n)\s*(?:[*\-•]\s*)?\**\s*(?:\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|morning|afternoon|evening|lunch|dinner|breakfast)\b/gi

// Long enough and shaped like days or a timetable: a pasted plan, not a request about the plan
// ("move the castle to day 2" is one line, so it never counts).
export function looksLikeItinerary(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim()).length
  if (text.length < 160 || lines < 4) return false
  const days = text.match(DAY)?.length ?? 0
  const times = text.match(TIME)?.length ?? 0
  return days >= 2 || (days >= 1 && times >= 2) || times >= 4
}

export interface ImportedTrip {
  brief: TripBrief
  days: DayPlan[]
  hotel?: HotelScore
  hotelScores: HotelScore[]
  places: Place[]
  cityName: string
  summary: string
}

export async function importPastedItinerary(text: string, base: Partial<TripBrief>, signal?: AbortSignal): Promise<ImportedTrip> {
  const res = await fetch('/api/import-itinerary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, brief: base }), signal })
  const body = await res.json().catch(() => ({})) as ImportedTrip & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `The server said ${res.status}.`)
  return body
}
