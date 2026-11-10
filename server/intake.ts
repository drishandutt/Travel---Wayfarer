import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { TripBrief, Vibe } from '../src/types'
import { CITIES, cityById, findCity } from '../src/data/cities'
import { FALLBACK, MODEL, client, effortFor, textOf } from './claude'
import { lookupCity, type Lookup } from './cities/store'

const VIBES: Vibe[] = ['food', 'culture', 'nightlife', 'nature', 'art', 'shopping', 'relaxed', 'adventure', 'romantic', 'history']

const system = () => `You are Wayfarer, a warm, sharp travel planner. The user is describing a trip in chat; a live map sits beside the conversation.

Your job each turn:
1. Update the trip brief from everything said so far.
2. Reply in 1-3 short sentences. Acknowledge something specific they said, then ask about the single most important missing detail (priority: destination, number of days, who is coming, vibe, budget). Never ask more than one question.

Destinations: set destination to the city they name, as its plain English name ("Paris", "New York City", "Kyoto"), one city per trip. You have detailed maps ready for ${CITIES.map(c => c.name).join(', ')}; any other city is mapped from public guides the moment they name it, which takes a minute, so just acknowledge the city warmly and carry on with the next question. A country or a region isn't a destination: ask which city.
Days: 1-5 (longer trips: plan the first 5 and say so). A weekend is 2.
Budget: convert any currency to an approximate USD total for the whole group. Words like "cheap"/"backpacking" mean shoestring, "comfortable" means comfort, "splurge"/"luxury" mean luxury.
Vibes: only from ${VIBES.join(', ')}. Infer sensibly (a honeymoon implies romantic; "foodies" implies food).
Use 0 or "" for anything not yet known. Never invent details the user did not imply.
Once destination and days are known, tell them they can hit "Pick places" to swipe through suggestions whenever they are ready (they can keep adding details).`

// Structured output: Claude returns the whole updated brief plus its reply.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'brief'],
  properties: {
    reply: { type: 'string' },
    brief: {
      type: 'object',
      additionalProperties: false,
      required: ['destination', 'days', 'travelers', 'vibes', 'budget_tier', 'budget_usd', 'pace'],
      properties: {
        destination: { type: 'string', description: 'The city, in plain English, or "" if not yet known.' },
        days: { type: 'integer' },
        travelers: { type: 'integer' },
        vibes: { type: 'array', items: { type: 'string', enum: VIBES } },
        budget_tier: { type: 'string', enum: ['', 'shoestring', 'comfort', 'luxury'] },
        budget_usd: { type: 'integer' },
        pace: { type: 'string', enum: ['', 'slow', 'balanced', 'packed'] },
      },
    },
  },
} as const

const Output = z.object({
  reply: z.string(),
  brief: z.object({
    destination: z.string(),
    days: z.number().int(),
    travelers: z.number().int(),
    vibes: z.array(z.enum(VIBES as [Vibe, ...Vibe[]])),
    budget_tier: z.enum(['', 'shoestring', 'comfort', 'luxury']),
    budget_usd: z.number().int(),
    pace: z.enum(['', 'slow', 'balanced', 'packed']),
  }),
})

export interface IntakeRequest {
  messages: { role: 'user' | 'ai'; text: string }[]
  brief: TripBrief
}

// `building`: the city they named isn't mapped yet and is being built; the browser waits for
// it and sets the destination once it's ready.
export interface IntakeResult { reply: string; brief: TripBrief; building?: { id: string; name: string; progress: string } }

export async function runIntake(req: IntakeRequest, signal: AbortSignal): Promise<IntakeResult> {
  // The greeting is UI chrome; the API conversation must start with the user.
  const firstUser = req.messages.findIndex(m => m.role === 'user')
  const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.slice(firstUser).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }))

  const response = await client.beta.messages.create(
    {
      ...FALLBACK,
      model: MODEL,
      max_tokens: 16000,
      system: system(),
      output_config: { effort: effortFor('intake'), format: { type: 'json_schema', schema: SCHEMA } },
      messages,
    },
    { signal },
  )
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to continue this conversation.')

  const out = Output.parse(JSON.parse(textOf(response)))
  const b = out.brief
  const city = await destinationOf(b.destination, req.brief.destination, signal)
  const brief: TripBrief = {
    destination: city.id,
    days: b.days > 0 ? Math.min(5, b.days) : undefined,
    travelers: b.travelers > 0 ? b.travelers : undefined,
    vibes: b.vibes,
    budgetTier: b.budget_tier || undefined,
    budgetAmount: b.budget_usd > 0 ? b.budget_usd : undefined,
    pace: b.pace || undefined,
  }
  let reply = out.reply
  if (city.building) reply = `${reply} (I don’t have ${city.building.name} mapped yet, so I’m building it from public guides now. It takes about a minute.)`
  if (city.unknown) reply = `${reply} I couldn’t find a guide for “${city.unknown}”, so I can’t map it. Which city is it nearest? I have ${CITIES.map(c => c.name).join(', ')} ready, and can build most cities.`
  return { reply, brief, ...(city.building ? { building: city.building } : {}) }
}

// The city id for what Claude heard: a city the app knows (by id or name), the one already on
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
