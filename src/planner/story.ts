import type { Place, TripBrief, TripStory, Vibe } from '../types'

// The trip as they told it (`TripBrief.story`). With a model connected, the intake fills the
// story; offline, the rules here read the same things from what they typed: dates, where they're
// staying, when they land, who's coming, the occasion, the moments they want and what to avoid.
// `applyStory` then turns the story into the settings the planners already read (sliders,
// vibes), and `storyLines` says it to a model planner in words.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const DAY_NUM = '(\\d{1,2})(?:st|nd|rd|th)?'
const pad = (n: number) => String(n).padStart(2, '0')
const MAX_DAYS = 5

// "24, 25, 26", "24th-26th", "from the 24th to the 26th", "24 to 26 Nov", "Nov 24-26", "on the 3rd".
// Returns the first day as yyyy-mm-dd (the next time that date comes round) and how many days.
export function datesIn(text: string, today = new Date()): { start: string; days: number; first: number } | undefined {
  const t = text.toLowerCase()
  const month = t.match(new RegExp(`\\b${MONTH}\\b`))?.[1]
  const nums = new Set<number>()
  const add = (s: string) => { const n = Number(s); if (n >= 1 && n <= 31) nums.add(n) }
  // a run of two or more day numbers, not a count of days, people or money
  for (const m of t.matchAll(new RegExp(`(?<![$€£\\d.,])\\b${DAY_NUM}(?:\\s*(?:,|-|–|to|till|until|and|&|through)\\s*(?:the\\s+)?${DAY_NUM})+(?![\\d%k])(?!(?:\\s*(?:,|-|–|to|or|and|&)\\s*\\d{1,2})*\\s*(?:days?|nights?|people|persons|adults|of us|pax|friends|hours?|hrs?|mins?|minutes|km|stops?|stars?|am|pm|\\$|usd|eur|k\\b))`, 'g'))) {
    for (const n of m[0].matchAll(/\d{1,2}/g)) add(n[0])
  }
  // ordinals ("the 24th") and numbers beside a month ("24 Nov", "Nov 24")
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)) add(m[1])
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}`, 'g'))) add(m[1])
  for (const m of t.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) add(m[2])
  if (!nums.size) return undefined
  const sorted = [...nums].sort((a, b) => a - b)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (last - first > 13) return undefined
  const y0 = today.getFullYear()
  const m0 = today.getMonth()
  let m = month ? MONTHS.indexOf(month) : (first >= today.getDate() ? m0 : m0 + 1)
  let y = y0
  if (month && (m < m0 || (m === m0 && first < today.getDate()))) y++
  if (m > 11) { m -= 12; y++ }
  return { start: `${y}-${pad(m + 1)}-${pad(first)}`, days: Math.min(MAX_DAYS, last - first + 1), first }
}

// "13:00" from "1 pm", "13.30", "1:30pm"; a bare small hour reads as the afternoon.
function clockOf(h: string, min?: string, ampm?: string): number | undefined {
  let hour = Number(h)
  if (hour > 23) return undefined
  const pm = ampm && /p/i.test(ampm)
  if (pm && hour < 12) hour += 12
  if (ampm && !pm && hour === 12) hour = 0
  if (!ampm && hour >= 1 && hour <= 7) hour += 12
  return hour * 60 + Number(min ?? 0)
}

const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?'

const RELATIONS: [RegExp, string][] = [
  [/\bgirl ?friend\b/, 'girlfriend'], [/\bboy ?friend\b/, 'boyfriend'], [/\bwife\b/, 'wife'], [/\bhusband\b/, 'husband'],
  [/\bfianc[ée]e?\b/, 'fiancé(e)'], [/\bpartner\b/, 'partner'], [/\b(mum|mom|mother)\b/, 'mum'], [/\b(dad|father)\b/, 'dad'],
  [/\bparents\b/, 'parents'], [/\b(kids|children|son|daughter|toddler|baby)\b/, 'kids'], [/\b(grandma|grandpa|grandparents)\b/, 'grandparents'],
  [/\bsister\b/, 'sister'], [/\bbrother\b/, 'brother'], [/\b(colleagues?|coworkers?|team)\b/, 'colleagues'], [/\bfriends\b/, 'friends'],
]
const PARTNERS = new Set(['girlfriend', 'boyfriend', 'wife', 'husband', 'fiancé(e)', 'partner'])

const OCCASIONS: [RegExp, string][] = [
  [/\bhoneymoon\b/, 'honeymoon'], [/\banniversary\b/, 'anniversary'], [/\bbabymoon\b/, 'babymoon'], [/\bpropos(e|al|ing)\b/, 'a proposal'],
  [/\b(birthday|bday)\b/, 'a birthday'], [/\b(bachelor(ette)?|stag|hen) (party|do|trip|weekend)\b/, 'a bachelor party'],
  [/\b(business|work) trip\b|\bconference\b/, 'a work trip'], [/\breunion\b/, 'a reunion'], [/\bgraduation\b/, 'a graduation'],
  [/\bdate night\b/, 'a date night'],
]

const AVOID: [RegExp, string][] = [
  [/touris/, 'touristy'], [/crowd|queue/, 'crowds'], [/club/, 'clubs'], [/early (start|morning)|waking up early/, 'early starts'],
  [/museum/, 'museums'], [/driv|traffic|commut/, 'long drives'], [/shopping|malls?\b/, 'shopping'], [/walk|hik/, 'long walks'],
  [/party|partying/, 'parties'], [/seafood|fish/, 'seafood'], [/spicy/, 'spicy food'], [/fancy|posh|fine dining/, 'fancy places'],
  [/rush|packed|hectic/, 'a rushed pace'], [/chain/, 'chains'],
]
const NEGATION = /\b(?:not|no|nothing|avoid|avoiding|hate|hates|without|skip|never|don'?t (?:want|like|need|fancy)|isn'?t|aren'?t)\s+(?:looking for\s+|really\s+|into\s+|a fan of\s+|big on\s+|too\s+|any\s+|the\s+|so\s+|very\s+|much\s+(?:of\s+)?(?:a\s+)?)*([a-z][a-z' -]{2,60}?)(?=[,.!;)]|\s+but\b|\s+(?:and|or)\s+(?:want|we|i|it|let|make|keep|love|like|prefer|looking)\b|$)/g

const FEEL: [RegExp, string][] = [
  [/\bromantic|romance\b/, 'romantic'], [/\bfun\b/, 'fun'], [/\b(crazy|wild|unforgettable|epic)\b/, 'unforgettable'],
  [/\b(chill|relaxed|relaxing|laid[- ]back|lazy|slow)\b/, 'relaxed'], [/\b(adventur\w*|thrill\w*|adrenaline)\b/, 'adventurous'],
  [/\b(luxur\w*|fancy|classy|bougie|lavish)\b/, 'luxurious'], [/\b(cosy|cozy|intimate)\b/, 'intimate'], [/\b(lively|buzzy|vibrant)\b/, 'lively'],
  [/\b(quiet|peaceful|calm)\b/, 'quiet'], [/\b(local|authentic|hidden gems?|off the beaten)\b/, 'local'], [/\b(artsy|creative)\b/, 'artsy'],
]

const MOMENT = /\b(?:(crazy|big|special|romantic|fun|quiet|fancy|wild|proper|lazy|memorable)\s+)?(date night|night out|dinner|party|celebration|surprise|spa(?: day)?|show|concert|picnic|sunset|proposal|birthday|brunch|lie[- ]in)\b/

// What a message says about the trip, beyond the basics. Only what it actually says: nothing
// here guesses.
export function extractStory(text: string, prev: TripBrief, today = new Date()): TripBrief {
  const t = text.toLowerCase().replace(/[’‘]/g, "'")
  const story: TripStory = { ...prev.story }
  const next: TripBrief = { ...prev }

  const dates = datesIn(text, today)
  if (dates) { next.startDate = dates.start; if (dates.days > 1 || !prev.days) next.days = dates.days }

  // where they're staying: a name with capitals ("Sun N Sands Hotel"), or anything ending "hotel"
  const stay = text.match(/\b(?:staying|stay|booked(?: a room| into)?|checked in|we'?re|i'?m|we are|i am)\s+(?:at|in)\s+(?:the\s+)?((?:[A-Z0-9][\w'’&.-]*)(?:\s+(?:[A-Z0-9][\w'’&.-]*|[nN]|and|&|of|de|la|by|on|the|at)){0,6})/)?.[1]
    ?? text.match(/\b(?:staying|stay|booked)\s+(?:at|in)\s+(?:the\s+)?([\w'’&. -]{3,40}?\s(?:hotel|hostel|resort|inn|suites|airbnb))\b/i)?.[1]
  const stayName = stay?.replace(/\s+(?:and|&|of|de|la|by|on|the|at|n)$/i, '').trim()
  if (stayName && stayName.length >= 3 && !/^(home|a hotel|an airbnb)$/i.test(stayName) && stayName !== story.stay?.name) story.stay = { name: stayName }

  const arrive = t.match(new RegExp(`\\b(?:reach(?:ing)?|arriv(?:e|ing)|land(?:ing)?|get(?:ting)? (?:there|in)|check(?:ing)? in|we'?re there)\\b[^.\\d]{0,25}?\\b${TIME}`))
  if (arrive) { const at = clockOf(arrive[1], arrive[2], arrive[3]); if (at !== undefined) story.arrive = at }
  const leave = t.match(new RegExp(`\\b(?:leav(?:e|ing)|fly(?:ing)? (?:out|back|home)|depart(?:ing)?|flight (?:back|home|out)|check(?:ing)? out|head(?:ing)? home)\\b[^.\\d]{0,25}?\\b${TIME}`))
  if (leave) { const at = clockOf(leave[1], leave[2], leave[3]); if (at !== undefined) story.leave = at }

  const who = new Set((story.people ?? []).map(p => p.who))
  for (const [re, label] of RELATIONS) if (re.test(t) && !who.has(label)) { who.add(label); story.people = [...(story.people ?? []), { who: label }] }
  const partners = (story.people ?? []).filter(p => PARTNERS.has(p.who))
  if (!next.travelers && partners.length === 1 && (story.people ?? []).length === 1) next.travelers = 2

  const occasions = OCCASIONS.filter(([re]) => re.test(t)).map(([, label]) => label)
  if (occasions.length) {
    const main = occasions.find(o => o !== 'a date night') ?? occasions[0]
    story.occasion = /\bsurprise\b/.test(t) ? `${main}, as a surprise` : main
  }

  const avoid = new Set(story.avoid ?? [])
  // in the order they said them
  for (const m of t.matchAll(NEGATION)) {
    const said = AVOID.map(([re, label]) => ({ at: m[1].search(re), label })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at)
    for (const x of said) avoid.add(x.label)
  }
  if (avoid.size) story.avoid = [...avoid]

  const negated = [...t.matchAll(NEGATION)].map(m => m[1]).join(' ')
  const feel = new Set(story.feel ?? [])
  for (const [re, label] of FEEL) if (re.test(t) && !re.test(negated)) feel.add(label)
  if (feel.size) story.feel = [...feel]

  // a moment tied to a day: "24th I want a crazy date night", "day 2: spa", "on the last night, a show"
  const start = dates?.first ?? (prev.startDate ? Number(prev.startDate.slice(8, 10)) : undefined)
  const moments = [...(story.moments ?? [])]
  // clause by clause, commas included: "24, 25, 26 we're in Mumbai, 24th a crazy date night"
  for (const clause of text.split(/[.,;!?\n]+/)) {
    const c = clause.toLowerCase()
    const m = c.match(MOMENT)
    // a clause giving the trip's dates ("a bachelor party in Berlin 12th to 14th") is the whole trip
    if (!m || (datesIn(clause, today)?.days ?? 1) > 1) continue
    let day: number | undefined
    const ord = c.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/)?.[1]
    if (ord && start) day = Number(ord) - start + 1
    const n = c.match(/\bday\s+(\d)\b/)?.[1] ?? (/\b(first|1st) (day|night|evening)\b/.test(c) ? '1' : undefined)
    if (n) day = Number(n)
    if (/\blast (day|night|evening)\b/.test(c) && next.days) day = next.days
    if (day === undefined || day < 1 || day > MAX_DAYS) continue
    const what = [m[1], m[2]].filter(Boolean).join(' ') + (/\bsurprise\b/.test(c) && m[2] !== 'surprise' ? ', a surprise' : '')
    const when = /night|party|show|concert/.test(m[2]) ? 'night' : /dinner|sunset/.test(m[2]) ? 'evening' : /brunch|lie/.test(m[2]) ? 'morning' : undefined
    if (!moments.some(x => x.day === day && x.what === what)) moments.push({ what, day, ...(when ? { when } : {}) })
  }
  if (moments.length) story.moments = moments

  if (Object.keys(story).length) next.story = story
  return next
}

// The story, as the settings the planners already read. Only fills what they haven't set.
export function applyStory(b: TripBrief): TripBrief {
  const s = b.story
  if (!s) return b
  const out: TripBrief = { ...b, vibes: [...b.vibes] }
  // a model writes these in its own words ("touristy vibes", "not touristy" as a feel): read them loosely
  const feel = (s.feel ?? []).map(f => f.toLowerCase())
  const avoid = [...(s.avoid ?? []), ...feel.filter(f => /^(not|no|never)\b/.test(f))].map(a => a.toLowerCase())
  const avoids = (re: RegExp) => avoid.some(a => re.test(a))
  const feels = (re: RegExp) => feel.some(f => !/^(not|no|never)\b/.test(f) && re.test(f))
  const vibe = (v: Vibe) => { if (!out.vibes.includes(v)) out.vibes.push(v) }
  if (avoids(/touris/) || feels(/\blocal|hidden|off the beaten/)) out.familiarity ??= 0.75
  if (avoids(/crowd|queue/)) out.crowds ??= 0.75
  if (avoids(/early/)) out.rhythm ??= 0.75
  if (avoids(/walk|hik/)) out.walking ??= 0.25
  if (avoids(/rush|packed|hectic/)) out.paceLevel ??= 0.25
  if (feels(/romanc|romantic/) || /honeymoon|anniversary|date|proposal|babymoon|romantic/i.test(s.occasion ?? '')) vibe('romantic')
  // a night out in anything they said: the feel, the occasion, a moment, or what someone loves
  const said = [...feel, s.occasion ?? '', ...(s.moments ?? []).map(m => m.what), ...(s.people ?? []).map(p => p.notes ?? '')].join(' ').toLowerCase()
  const nightOut = /\b(night ?life|night out|date night|party|partying|club(bing|s)?|danc(e|ing)|cocktails?|drinks?|bars?|pubs?|speakeas(y|ies)|rooftops?|lounges?|dj|live music|gigs?|crazy|wild)\b/.test(said) || (s.moments ?? []).some(m => m.when === 'night')
  if (nightOut && !avoids(/night ?life|club|bar|party|drink/)) { vibe('nightlife'); out.rhythm ??= 0.75 }
  if (feels(/relax|chill|slow|lazy/)) vibe('relaxed')
  if (feels(/adventur|thrill/)) { vibe('adventure'); out.energy ??= 0.75 }
  if (feels(/\b(arts?|artsy|artistic|galler(y|ies))\b/)) vibe('art')
  if ((s.people ?? []).some(p => /kid|child|son|daughter|toddler|baby/i.test(p.who))) out.kids ??= 0.75
  return out
}

const fmt = (min: number) => `${Math.floor(min / 60) % 24}:${pad(min % 60)}`
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Tue 24 Nov" for day `n` of the trip.
export function dayDate(brief: TripBrief, n: number): string | undefined {
  if (!brief.startDate) return undefined
  const d = new Date(`${brief.startDate}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return undefined
  d.setUTCDate(d.getUTCDate() + n - 1)
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAME[d.getUTCMonth()]}`
}

// The story in words, for a model planner.
export function storyLines(brief: TripBrief, sunsets?: (number | undefined)[]): string[] {
  const s = brief.story
  const out: string[] = []
  if (brief.startDate && brief.days) out.push(`Dates: ${Array.from({ length: brief.days }, (_, i) => `day ${i + 1} is ${dayDate(brief, i + 1)}`).join(', ')}. Respect each place's opening days`)
  if (sunsets?.some(x => x !== undefined)) out.push(`Sunset: ${sunsets.map((m, i) => (m === undefined ? '' : `day ${i + 1} ${fmt(m)}`)).filter(Boolean).join(', ')}. Put views, rooftops and waterfronts there then`)
  if (!s) return out
  if (s.occasion) out.push(`Occasion: ${s.occasion}`)
  if (s.people?.length) out.push(`Going with: ${s.people.map(p => (p.notes ? `${p.who} (${p.notes})` : p.who)).join('; ')}`)
  if (s.stay) out.push(`Staying at: ${s.stay.name} (each day starts and ends there)`)
  if (s.arrive !== undefined) out.push(`Arriving: free from ${fmt(s.arrive)} on day 1, so nothing before then`)
  if (s.leave !== undefined) out.push(`Leaving: must be done by ${fmt(s.leave)} on the last day`)
  if (s.moments?.length) out.push(`Moments to build days around: ${s.moments.map(m => `${m.day ? `day ${m.day}` : 'any day'}${m.when ? ` ${m.when}` : ''}: ${m.what}`).join('; ')}`)
  if (s.feel?.length) out.push(`The feel they want: ${s.feel.join(', ')}`)
  if (s.avoid?.length) out.push(`Avoid: ${s.avoid.join(', ')}. Don't plan these, even if they're famous.`)
  return out
}

// The earliest a day can start, given when they arrive.
export function arrivalFloor(brief: TripBrief, day: number): number | undefined {
  const at = brief.story?.arrive
  if (day !== 1 || at === undefined) return undefined
  // time to get from the airport or station and drop the bags, rounded to the quarter hour
  return Math.ceil((at + 75) / 15) * 15
}

// For the read-back card: each thing we heard, and how to take it back out.
export interface ReadChip { key: string; icon: string; label: string; drop?: Partial<TripBrief> }

export function readBack(brief: TripBrief, cityName?: string): ReadChip[] {
  const s = brief.story ?? {}
  const story = (patch: Partial<TripStory>): Partial<TripBrief> => ({ story: { ...s, ...patch } })
  const chips: ReadChip[] = []
  if (cityName) chips.push({ key: 'city', icon: '📍', label: cityName })
  if (brief.startDate && brief.days) chips.push({ key: 'dates', icon: '🗓', label: brief.days > 1 ? `${dayDate(brief, 1)} – ${dayDate(brief, brief.days)}` : `${dayDate(brief, 1)}`, drop: { startDate: undefined } })
  else if (brief.days) chips.push({ key: 'days', icon: '🗓', label: `${brief.days} day${brief.days > 1 ? 's' : ''}` })
  if (s.people?.length) chips.push({ key: 'people', icon: '👥', label: `You + ${s.people.map(p => (p.notes ? `${p.who} (${p.notes})` : p.who)).join(', ')}`, drop: story({ people: undefined }) })
  else if (brief.travelers) chips.push({ key: 'travelers', icon: '👥', label: brief.travelers === 1 ? 'Just you' : `${brief.travelers} of you` })
  if (s.stay) chips.push({ key: 'stay', icon: '🏨', label: s.stay.name, drop: story({ stay: undefined }) })
  if (s.arrive !== undefined) chips.push({ key: 'arrive', icon: '🛬', label: `Free from ${fmt(s.arrive)}`, drop: story({ arrive: undefined }) })
  if (s.leave !== undefined) chips.push({ key: 'leave', icon: '🛫', label: `Done by ${fmt(s.leave)}`, drop: story({ leave: undefined }) })
  if (s.occasion) chips.push({ key: 'occasion', icon: '✨', label: s.occasion, drop: story({ occasion: undefined }) })
  s.moments?.forEach((m, i) => chips.push({ key: `moment-${i}`, icon: '⭐', label: `${m.day ? `Day ${m.day}${m.when ? ` ${m.when}` : ''}: ` : ''}${m.what}`, drop: story({ moments: s.moments!.filter((_, j) => j !== i) }) }))
  if (s.feel?.length) chips.push({ key: 'feel', icon: '❤️', label: s.feel.join(' · '), drop: story({ feel: undefined }) })
  s.avoid?.forEach((a, i) => chips.push({ key: `avoid-${i}`, icon: '🚫', label: a, drop: story({ avoid: s.avoid!.filter((_, j) => j !== i) }) }))
  if (brief.budgetAmount) chips.push({ key: 'budget', icon: '💰', label: `$${brief.budgetAmount.toLocaleString()}` })
  else if (brief.budgetTier) chips.push({ key: 'budget', icon: '💰', label: brief.budgetTier })
  return chips
}

// ── matching places to the story ─────────────────────────────────────────────

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'her', 'his', 'their', 'my', 'our', 'your', 'she', 'he', 'they', 'loves', 'love', 'likes', 'like', 'into', 'really', 'very', 'some', 'any', 'not', 'no', 'trip', 'day', 'night', 'vibe', 'vibes', 'stuff', 'things', 'thing', 'place', 'places', 'experience', 'experiences', 'as', 'surprise', 'is', 'it', 'be', 'we', 'i'])
const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})(es|s)$/, '')
export const moodWords = (text: string): string[] => [...new Set(text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !STOP.has(w)).map(stem))]

// What they want, in words: the feel, the occasion, the moments and what they said about the people.
export function wantedWords(brief: TripBrief): string[] {
  const s = brief.story ?? {}
  const text = [...(s.feel ?? []).filter(f => !/^(not|no|never)\b/i.test(f)), s.occasion ?? '', ...(s.moments ?? []).map(m => m.what), ...(s.people ?? []).map(p => p.notes ?? ''), ...(brief.tastes ?? [])].join(' ')
  return moodWords(text)
}
export function avoidWords(brief: TripBrief): string[] {
  const s = brief.story ?? {}
  return moodWords([...(s.avoid ?? []), ...(s.feel ?? []).filter(f => /^(not|no|never)\b/i.test(f))].join(' ')).filter(w => !/^touristy?$/.test(w))
}

// How well a place answers the story: its mood words and cuisine against what they want, and
// against what they said to avoid.
export function moodFit(p: Pick<Place, 'moods' | 'keywords' | 'name'>, brief: TripBrief): { score: number; match?: string } {
  if (!brief.story && !brief.tastes?.length) return { score: 0 }
  const has = new Set(moodWords([...(p.moods ?? []), ...(p.keywords ?? [])].join(' ')))
  if (!has.size) return { score: 0 }
  const hits = wantedWords(brief).filter(w => has.has(w))
  const bad = avoidWords(brief).filter(w => has.has(w))
  const score = Math.min(3, hits.length) * 1.5 - bad.length * 4
  return { score, ...(hits.length ? { match: hits.slice(0, 2).join(' + ') } : {}) }
}

// The mood, as a stable key: the same words in any order are the same search for places.
export function moodOf(brief: TripBrief): string {
  const s = brief.story ?? {}
  const words = moodWords([
    ...(s.feel ?? []), s.occasion ?? '', ...(s.moments ?? []).map(m => m.what), ...(s.people ?? []).map(p => p.notes ?? ''),
    ...(s.avoid ?? []).map(a => `no-${a}`), ...brief.vibes, ...(brief.tastes ?? []), brief.budgetTier ?? '',
  ].join(' '))
  return words.sort().slice(0, 24).join(' ')
}

// Worth searching for places by mood: there's something to search for beyond "a city".
export const hasMood = (brief: TripBrief) => Boolean(brief.story?.feel?.length || brief.story?.occasion || brief.story?.moments?.length || brief.story?.avoid?.length || brief.story?.people?.some(p => p.notes) || brief.tastes?.length)
