import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { TripBrief, Vibe } from '../src/types'
import { CITIES } from '../src/data/cities'
import { FALLBACK, MODEL, client, effortFor, textOf } from './claude'

const VIBES: Vibe[] = ['food', 'culture', 'nightlife', 'nature', 'art', 'shopping', 'relaxed', 'adventure', 'romantic', 'history']

const SYSTEM = `You are Wayfarer, a warm, sharp travel planner. The user is describing a trip in chat; a live map sits beside the conversation.

Your job each turn:
1. Update the trip brief from everything said so far.
2. Reply in 1-3 short sentences. Acknowledge something specific they said, then ask about the single most important missing detail (priority: destination, number of days, who is coming, vibe, budget). Never ask more than one question.

Destinations: you have detailed maps only for ${CITIES.map(c => `${c.name} (id "${c.id}")`).join(' and ')}. If they want somewhere else, set unsupported_destination to it, leave destination empty, and kindly offer the supported cities instead.
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
      required: ['destination', 'unsupported_destination', 'days', 'travelers', 'vibes', 'budget_tier', 'budget_usd', 'pace'],
      properties: {
        destination: { type: 'string', enum: ['', ...CITIES.map(c => c.id)] },
        unsupported_destination: { type: 'string' },
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
    unsupported_destination: z.string(),
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

export async function runIntake(req: IntakeRequest, signal: AbortSignal): Promise<{ reply: string; brief: TripBrief }> {
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
      system: SYSTEM,
      output_config: { effort: effortFor('intake'), format: { type: 'json_schema', schema: SCHEMA } },
      messages,
    },
    { signal },
  )
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to continue this conversation.')

  const out = Output.parse(JSON.parse(textOf(response)))
  const b = out.brief
  const brief: TripBrief = {
    destination: b.destination || undefined,
    days: b.days > 0 ? Math.min(5, b.days) : undefined,
    travelers: b.travelers > 0 ? b.travelers : undefined,
    vibes: b.vibes,
    budgetTier: b.budget_tier || undefined,
    budgetAmount: b.budget_usd > 0 ? b.budget_usd : undefined,
    pace: b.pace || undefined,
  }
  return { reply: out.reply, brief }
}
