import { z } from 'zod'
import type { TripBrief, TripStory, Vibe } from '../src/types'
import { CITIES, cityById, findCity } from '../src/data/cities'
import { applyStory } from '../src/planner/story'
import { structured } from './llm'
import { lookupCity, type Lookup } from './cities/store'

const VIBES: Vibe[] = ['food', 'culture', 'nightlife', 'nature', 'art', 'shopping', 'relaxed', 'adventure', 'romantic', 'history']
const WHEN = ['', 'morning', 'afternoon', 'evening', 'night'] as const

const system = (today: string) => `You are Wayfarer, a warm, sharp travel planner, like a friend who knows the city. The user is describing a trip in chat; a live map sits beside the conversation. Today is ${today}.

Your job each turn:
1. Update the trip brief and the story from everything said so far. Catch everything they said, in one go: dates, who's coming and anything about them, where they're staying, when they arrive and leave, the occasion, moments they want ("a big date night on the 24th"), the feel, and what they don't want.
2. Reply in 1-3 short sentences. Show you heard the specific things that matter to them (the occasion, the person, the moment), not a list of fields. Then ask the single question whose answer would change the plan most, the way a friend would. Questions about the people (what they love, what they'd never do) beat questions about budget. Never ask for something already said or that can be sensibly inferred (a hotel says enough about budget; a honeymoon says romantic). Never ask more than one question.
3. Offer 2-4 short tap-to-answer chips for that question (each under 4 words), or none if it needs words.

Destinations: set destination to the city they name, as its plain English name ("Paris", "New York City", "Kyoto"), one city per trip. You have detailed maps ready for ${CITIES.map(c => c.name).join(', ')}; any other city is mapped from public guides the moment they name it, which takes a minute, so just acknowledge the city warmly and carry on. A country or a region isn't a destination: ask which city.
Dates: start_date as YYYY-MM-DD when they give dates (the next time that date comes round), else "". Days: from the dates, or as said, 1-5 (longer trips: plan the first 5 and say so). A weekend is 2.
Budget: convert any currency to an approximate USD total for the whole group. Words like "cheap"/"backpacking" mean shoestring, "comfortable" means comfort, "splurge"/"luxury" mean luxury.
Vibes: only from ${VIBES.join(', ')}. Infer sensibly (a honeymoon implies romantic; "foodies" implies food).
Story: occasion in a few words ("surprise date night", "mum's 60th"), "" if none. people: everyone besides the person planning, with notes in their words ("loves jazz, no seafood"). stay: the hotel or area they're staying at, as they name it, "" if not said. arrive/leave: HH:MM 24h when they say when they're free on day 1 or must be done on the last day, else "". moments: what they want to happen, with the trip day number (1 = first day) when they tie it to a date or day, else 0. feel: the mood in a few of their words. avoid: what not to plan, in short words ("touristy", "clubs", "long drives").
Use 0, "" or [] for anything not yet known. Never invent details the user did not imply.
Once destination and days are known, they can hit "Pick places" to swipe through suggestions whenever they are ready (they can keep adding details); mention it once, when it first becomes true.`

const str = { type: 'string' } as const
// Structured output: the model returns the whole updated brief and story, its reply and the chips.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'chips', 'brief', 'story'],
  properties: {
    reply: str,
    chips: { type: 'array', items: str },
    brief: {
      type: 'object',
      additionalProperties: false,
      required: ['destination', 'start_date', 'days', 'travelers', 'vibes', 'budget_tier', 'budget_usd', 'pace'],
      properties: {
        destination: { type: 'string', description: 'The city, in plain English, or "" if not yet known.' },
        start_date: str,
        days: { type: 'integer' },
        travelers: { type: 'integer' },
        vibes: { type: 'array', items: { type: 'string', enum: VIBES } },
        budget_tier: { type: 'string', enum: ['', 'shoestring', 'comfort', 'luxury'] },
        budget_usd: { type: 'integer' },
        pace: { type: 'string', enum: ['', 'slow', 'balanced', 'packed'] },
      },
    },
    story: {
      type: 'object',
      additionalProperties: false,
      required: ['occasion', 'people', 'stay', 'arrive', 'leave', 'moments', 'feel', 'avoid'],
      properties: {
        occasion: str,
        people: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who', 'notes'], properties: { who: str, notes: str } } },
        stay: str,
        arrive: str,
        leave: str,
        moments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['what', 'day', 'when'], properties: { what: str, day: { type: 'integer' }, when: { type: 'string', enum: [...WHEN] } } } },
        feel: { type: 'array', items: str },
        avoid: { type: 'array', items: str },
      },
    },
  },
} as const

const Output = z.object({
  reply: z.string(),
  chips: z.array(z.string()),
  brief: z.object({
    destination: z.string(),
    start_date: z.string(),
    days: z.number().int(),
    travelers: z.number().int(),
    vibes: z.array(z.enum(VIBES as [Vibe, ...Vibe[]])),
    budget_tier: z.enum(['', 'shoestring', 'comfort', 'luxury']),
    budget_usd: z.number().int(),
    pace: z.enum(['', 'slow', 'balanced', 'packed']),
  }),
  story: z.object({
    occasion: z.string(),
    people: z.array(z.object({ who: z.string(), notes: z.string() })),
    stay: z.string(),
    arrive: z.string(),
    leave: z.string(),
    moments: z.array(z.object({ what: z.string(), day: z.number().int(), when: z.enum(WHEN) })),
    feel: z.array(z.string()),
    avoid: z.array(z.string()),
  }),
})

export interface IntakeRequest {
  messages: { role: 'user' | 'ai'; text: string }[]
  brief: TripBrief
}

// `building`: the city they named isn't mapped yet and is being built; the browser waits for
// it and sets the destination once it's ready. `chips`: tap-to-answer replies to its question.
export interface IntakeResult { reply: string; chips: string[]; brief: TripBrief; building?: { id: string; name: string; progress: string } }

const clock = (s: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  return m && Number(m[1]) < 24 ? Number(m[1]) * 60 + Number(m[2]) : undefined
}
const words = (xs: string[]) => [...new Set(xs.map(x => x.trim().slice(0, 60)).filter(Boolean))].slice(0, 8)

// The story as the model told it, keeping a stay already placed on the map.
function storyOf(s: z.infer<typeof Output>['story'], prev: TripStory | undefined, days: number | undefined): TripStory | undefined {
  const out: TripStory = {}
  if (s.occasion.trim()) out.occasion = s.occasion.trim().slice(0, 80)
  const people = s.people.filter(p => p.who.trim()).slice(0, 8).map(p => ({ who: p.who.trim().slice(0, 40), ...(p.notes.trim() ? { notes: p.notes.trim().slice(0, 160) } : {}) }))
  if (people.length) out.people = people
  const stay = s.stay.trim().slice(0, 100)
  if (stay) out.stay = prev?.stay && prev.stay.name.toLowerCase() === stay.toLowerCase() ? prev.stay : { name: stay }
  const arrive = clock(s.arrive)
  if (arrive !== undefined) out.arrive = arrive
  const leave = clock(s.leave)
  if (leave !== undefined) out.leave = leave
  const moments = s.moments.filter(m => m.what.trim()).slice(0, 8).map(m => ({
    what: m.what.trim().slice(0, 80),
    ...(m.day >= 1 && m.day <= (days ?? 5) ? { day: m.day } : {}),
    ...(m.when ? { when: m.when as 'morning' | 'afternoon' | 'evening' | 'night' } : {}),
  }))
  if (moments.length) out.moments = moments
  if (words(s.feel).length) out.feel = words(s.feel)
  if (words(s.avoid).length) out.avoid = words(s.avoid)
  return Object.keys(out).length ? out : undefined
}

export async function runIntake(req: IntakeRequest, signal: AbortSignal): Promise<IntakeResult> {
  // The greeting is UI chrome; the conversation must start with the user.
  const firstUser = req.messages.findIndex(m => m.role === 'user')
  const messages = req.messages.slice(firstUser).map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.text }))
  const today = new Date().toISOString().slice(0, 10)

  const out = Output.parse(await structured({ kind: 'intake', name: 'trip_brief', system: system(today), messages, schema: SCHEMA, signal }))
  const b = out.brief
  const city = await destinationOf(b.destination, req.brief.destination, signal)
  const days = b.days > 0 ? Math.min(5, b.days) : undefined
  const brief: TripBrief = applyStory({
    // what the chat's sliders and the trip already hold stays; the model owns the rest
    ...req.brief,
    destination: city.id,
    days,
    travelers: b.travelers > 0 ? b.travelers : undefined,
    vibes: b.vibes,
    budgetTier: b.budget_tier || undefined,
    budgetAmount: b.budget_usd > 0 ? b.budget_usd : undefined,
    pace: b.pace || undefined,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(b.start_date) ? b.start_date : req.brief.startDate,
    story: storyOf(out.story, req.brief.story, days),
  })
  let reply = out.reply
  if (city.building) reply = `${reply} (I don’t have ${city.building.name} mapped yet, so I’m building it from public guides now. It takes about a minute.)`
  if (city.unknown) reply = `${reply} I couldn’t find a guide for “${city.unknown}”, so I can’t map it. Which city is it nearest? I have ${CITIES.map(c => c.name).join(', ')} ready, and can build most cities.`
  const chips = out.chips.map(c => c.trim().slice(0, 30)).filter(Boolean).slice(0, 4)
  return { reply, chips, brief, ...(city.building ? { building: city.building } : {}) }
}

// The city id for what the model heard: a city the app knows (by id or name), the one already on
// the brief, or one to build now.
async function destinationOf(named: string, previous: string | undefined, signal: AbortSignal): Promise<{ id?: string; building?: IntakeResult['building']; unknown?: string }> {
  const text = named.trim()
  if (!text) return { id: previous }
  const known = cityById(text.toLowerCase()) ?? findCity(text) ?? (previous && cityById(previous)?.name.toLowerCase() === text.toLowerCase() ? cityById(previous) : undefined)
  if (known) return { id: known.id }
  let look: Lookup
  try {
    look = await lookupCity(text, signal)
  } catch (err) {
    console.warn('[intake] looking up', text, (err as Error).message)
    return { id: previous, unknown: text }
  }
  if (look.status === 'known') return { id: look.id }
  if (look.status === 'building') return { id: previous, building: { id: look.id, name: look.name, progress: look.progress } }
  if (look.status === 'failed') return { id: previous, unknown: look.name }
  return { id: previous, unknown: text }
}
