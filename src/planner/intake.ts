import type { BudgetTier, TripBrief, Vibe } from '../types'
import { CITIES, cityById, findCity } from '../data/cities'

// Conversational intake: turns free text into a structured TripBrief.
// This rule-based extractor is the offline stand-in for an LLM call with a
// `update_trip_brief` tool — same input (chat history) and output (brief patch).

const VIBE_WORDS: Record<Vibe, string[]> = {
  food: ['food', 'eat', 'foodies?', 'restaurant', 'street food', 'ramen', 'sushi', 'cuisine'],
  culture: ['culture', 'temple', 'local', 'traditional'],
  nightlife: ['nightlife', 'party', 'bars', 'drinks', 'clubbing', 'night out'],
  nature: ['nature', 'park', 'garden', 'green', 'outdoors', 'hike'],
  art: ['art', 'museum', 'gallery', 'design'],
  shopping: ['shopping', 'shop', 'fashion', 'vintage', 'market'],
  relaxed: ['relaxed', 'chill', 'slow', 'calm', 'easy', 'laid back', 'laid-back'],
  adventure: ['adventure', 'thrill', 'explore', 'adrenaline'],
  romantic: ['romantic', 'honeymoon', 'anniversary', 'partner', 'date'],
  history: ['history', 'historic', 'old town', 'heritage', 'castle'],
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1,
}

function num(s: string): number | undefined {
  const n = Number(s)
  return Number.isFinite(n) ? n : NUMBER_WORDS[s.toLowerCase()]
}

export function extractBrief(text: string, prev: TripBrief): TripBrief {
  const t = text.toLowerCase()
  const next: TripBrief = { ...prev, vibes: [...prev.vibes] }

  const city = findCity(t)
  if (city) next.destination = city.id

  const days = t.match(/(\d+|one|two|three|four|five|six|seven|a)\s*(day|night)s?/)
  if (days) next.days = Math.min(5, Math.max(1, num(days[1]) ?? 3))
  if (/\bweekend\b/.test(t)) next.days = 2
  if (/\ba week\b/.test(t)) next.days = 5

  const people = t.match(/(\d+|two|three|four|five|six|seven|eight|nine|ten)\s*(people|persons|friends|adults|of us|travell?ers|pax)/)
    ?? t.match(/(?:family of|group of|party of|we are|we're)\s*(\d+|two|three|four|five|six|seven|eight|nine|ten)/)
  if (people) next.travelers = num(people[1])
  else if (/\b(solo|alone|myself|just me|only me)\b/.test(t)) next.travelers = 1
  else if (/\b(couple|my (wife|husband|partner|girlfriend|boyfriend)|honeymoon)\b/.test(t)) next.travelers = 2
  else if (/\bfamily\b/.test(t) && !prev.travelers) next.travelers = 4

  const money = t.match(/(?:\$|usd\s?|€|eur\s?)\s?(\d[\d,]*)(k)?|(\d[\d,]*)(k)?\s?(?:\$|usd|dollars|euros|€)/)
  if (money) {
    const raw = (money[1] ?? money[3]).replace(/,/g, '')
    const k = money[2] ?? money[4]
    next.budgetAmount = Number(raw) * (k ? 1000 : 1)
  }
  if (!money && /\b(cheap|budget|backpack|shoestring|broke)\b/.test(t)) next.budgetTier = 'shoestring'
  if (/\b(luxury|splurge|fancy|5[- ]star|bougie)\b/.test(t)) next.budgetTier = 'luxury'
  if (/\b(mid|moderate|comfortable|reasonable)\b/.test(t)) next.budgetTier = 'comfort'

  if (/\b(slow|relaxed|chill|easy)\b/.test(t)) next.pace = 'slow'
  if (/\b(packed|see everything|maximi[sz]e|busy)\b/.test(t)) next.pace = 'packed'

  for (const [vibe, words] of Object.entries(VIBE_WORDS) as [Vibe, string[]][]) {
    if (words.some(w => new RegExp(`\\b${w}\\b`).test(t)) && !next.vibes.includes(vibe)) next.vibes.push(vibe)
  }

  // cuisine & style words the destination's places are known by ("tempura", "traditional")
  const vocab = [...new Set(cityById(next.destination)?.places.flatMap(p => p.keywords ?? []) ?? [])]
  const heard = vocab.filter(k => new RegExp(`\\b(?:${k}|${k.replace(/y$/, 'ie')})(?:e?s)?\\b`).test(t))
  if (heard.length) next.tastes = [...new Set([...(next.tastes ?? []), ...heard])]

  return next
}

export function resolveBudgetTier(b: TripBrief): BudgetTier {
  if (b.budgetTier) return b.budgetTier
  if (b.budgetAmount && b.days && b.travelers) {
    const perPersonDay = b.budgetAmount / b.days / b.travelers
    if (perPersonDay < 110) return 'shoestring'
    if (perPersonDay > 380) return 'luxury'
  }
  return 'comfort'
}

export function isReady(b: TripBrief): boolean {
  return Boolean(b.destination && b.days)
}

// ── The conversation ─────────────────────────────────────────────────────────

export type BriefField = 'destination' | 'days' | 'travelers' | 'vibes' | 'budget'

// What we still want to know, in order. Fields left open are never asked again.
export function nextField(b: TripBrief): BriefField | undefined {
  if (!b.destination) return 'destination'
  if (!b.days) return 'days'
  const open = b.open ?? []
  if (!b.travelers && !open.includes('travelers')) return 'travelers'
  if (!b.vibes.length && !open.includes('vibes')) return 'vibes'
  if (!b.budgetTier && !b.budgetAmount && !open.includes('budget')) return 'budget'
  return undefined
}

// Tap-to-answer chips for the question on screen.
export const QUICK_REPLIES: Record<BriefField, string[]> = {
  destination: CITIES.map(c => c.name),
  days: ['2 days', '3 days', '5 days'],
  travelers: ['Just me', 'A couple', 'Family of 4', 'Group of 6'],
  vibes: ['Food', 'Culture', 'Nightlife', 'Slow & romantic', 'Mix of everything'],
  budget: ['Cheap', 'Comfortable', 'Splurge', 'Not sure'],
}

export function nextQuestion(b: TripBrief): string {
  switch (nextField(b)) {
    case 'destination':
      return `Where are we heading? I’ve got deep local maps for ${CITIES.map(c => c.name).join(' and ')} right now, with more cities coming.`
    case 'days':
      return `How many days do you have there? I can map up to ${MAX_DAYS}.`
    case 'travelers':
      return 'Who’s coming along? Solo, a couple, a group of friends?'
    case 'vibes':
      return 'What’s the vibe? Food crawl, culture, nightlife, slow and romantic… or a mix of everything.'
    case 'budget':
      return 'Last one: rough budget? A number works, or just “cheap”, “comfortable” or “splurge”.'
    default:
      return 'That’s everything. Hit “Pick places” when you’re ready.'
  }
}

const MAX_DAYS = 5
// "mix and match", "surprise me", "not sure": a real answer that means "you choose".
const NO_PREFERENCE = /\b(mix|match|anything|everything|all of (it|them|the above)|whatever|surprise|not sure|unsure|don'?t know|dunno|idk|no idea|no preference|up to you|you (choose|decide|pick)|doesn'?t matter|any|skip|flexible|open|either|both|all)\b/

const OPEN_NOTE: Record<string, string> = {
  travelers: 'I’ll plan for two for now, and you can change that anytime.',
  vibes: 'A bit of everything it is.',
  budget: 'I’ll aim for comfortable, and you can change that anytime.',
}
const MISSED_NOTE: Record<string, string> = {
  travelers: 'I didn’t catch how many of you there are, so I’ll plan for two for now.',
  vibes: 'I didn’t catch a vibe in that, so I’ll keep it to a bit of everything.',
  budget: 'I didn’t catch a budget in that, so I’ll aim for comfortable.',
}

// Read one message in light of the question on screen, and reply. Always moves
// the conversation on: it says what it heard, and never repeats itself.
export function converse(text: string, prev: TripBrief): { brief: TripBrief; reply: string } {
  const t = text.toLowerCase().replace(/[’‘]/g, "'")
  const asked = nextField(prev)
  let brief = extractBrief(text, prev)

  // A bare answer belongs to the question that was asked ("5", "two", "low").
  const bare = t.match(/\b(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)\b/)?.[1]?.replace(/,/g, '')
  if (asked === 'days' && !brief.days && bare) brief = { ...brief, days: Math.min(MAX_DAYS, Math.max(1, num(bare) ?? 3)) }
  if (asked === 'travelers' && !brief.travelers && bare) brief = { ...brief, travelers: num(bare) }
  if (asked === 'budget' && !brief.budgetAmount && !brief.budgetTier) {
    if (bare && Number(bare) >= 10) brief = { ...brief, budgetAmount: Number(bare) }
    else if (/\b(low|tight|small)\b/.test(t)) brief = { ...brief, budgetTier: 'shoestring' }
    else if (/\b(high|big|no limit|unlimited)\b/.test(t)) brief = { ...brief, budgetTier: 'luxury' }
    else if (/\b(medium|average|normal)\b/.test(t)) brief = { ...brief, budgetTier: 'comfort' }
  }

  // What we just learned, said back so they know they were heard.
  const heard: string[] = []
  const city = cityById(brief.destination)
  if (city && brief.destination !== prev.destination) heard.push(city.name)
  if (brief.days && brief.days !== prev.days) heard.push(`${brief.days} day${brief.days > 1 ? 's' : ''}`)
  if (brief.travelers && brief.travelers !== prev.travelers) heard.push(brief.travelers === 1 ? 'just you' : `${brief.travelers} people`)
  const newVibes = brief.vibes.filter(v => !prev.vibes.includes(v))
  if (newVibes.length) heard.push(newVibes.join(' + '))
  if (brief.budgetAmount && brief.budgetAmount !== prev.budgetAmount) heard.push(`$${brief.budgetAmount.toLocaleString()} budget`)
  else if (brief.budgetTier && brief.budgetTier !== prev.budgetTier) heard.push(`${brief.budgetTier} budget`)

  const notes: string[] = []
  const wantedDays = t.match(/(\d+)\s*(?:day|night)/)?.[1] ?? (asked === 'days' ? bare : undefined)
  if (/\b(a|one) week\b/.test(t) || Number(wantedDays) > MAX_DAYS || num(wantedDays ?? '') as number > MAX_DAYS) {
    notes.push(`I can map up to ${MAX_DAYS} days right now, so I’ll plan your first ${MAX_DAYS}.`)
  }

  // The question they were asked went unanswered: settle it and move on rather than loop.
  const answered = !asked || nextField(brief) !== asked
  if (!answered && asked) {
    if (asked === 'destination') {
      notes.push(`I’ve got maps for ${CITIES.map(c => c.name).join(' and ')} so far. Which one sounds good?`)
      return { brief, reply: [...acknowledge(heard), ...notes].join(' ') }
    }
    if (asked === 'days') {
      notes.push('Just a number works, like “3”.')
      return { brief, reply: [...acknowledge(heard), ...notes].join(' ') }
    }
    notes.push(NO_PREFERENCE.test(t) ? OPEN_NOTE[asked] : MISSED_NOTE[asked])
    brief = { ...brief, open: [...(brief.open ?? []), asked] }
  }

  return { brief, reply: [...acknowledge(heard), ...notes, nextQuestion(brief)].join(' ') }
}

const acknowledge = (heard: string[]) => (heard.length ? [`Got it: ${heard.join(', ')}.`] : [])
