import { z } from 'zod'
import type { Audience, City, Place, PlaceProfile } from '../../src/types'
import { AUDIENCES, ruleProfile } from '../../src/planner/profile'
import { FALLBACK, MODEL, brainEnabled, client, textOf } from '../claude'
import { OPENAI_MODEL, openai } from '../openai'

// What a place is good and bad at, and who it suits, from a model that knows it. Every place
// gets a rules profile for free (src/planner/profile.ts); this is the better one, asked for in
// batches for a city's best-known places and one at a time for a traveller's find. Only what
// the model is sure of: a place it doesn't recognise gets its rules profile back.

export const PROFILE_PROPS = {
  strengths: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short phrases: what it does well for a traveller.' },
  weaknesses: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short phrases: what to know before going (queues, closed days, pricey, far out, touristy).' },
  for: { type: 'array', items: { type: 'string', enum: AUDIENCES }, description: 'Who gets the most out of it.' },
  not_for: { type: 'array', items: { type: 'string', enum: AUDIENCES }, description: 'Who should give it a miss.' },
  kids: { type: 'number', description: '0-1, how well it works with little ones.' },
  busy: { type: 'number', description: '0-1, how crowded or queued it usually is.' },
  lively: { type: 'number', description: '0-1, chill to lively.' },
  late: { type: 'number', description: '0-1, a daytime thing to a night thing.' },
  known: { type: 'boolean', description: 'true only if you actually know this place, not just its kind.' },
} as const

export const PROFILE_REQUIRED = ['strengths', 'weaknesses', 'for', 'not_for', 'kids', 'busy', 'lively', 'late', 'known'] as const

export const ProfileOut = z.object({
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  for: z.array(z.enum(AUDIENCES as [Audience, ...Audience[]])),
  not_for: z.array(z.enum(AUDIENCES as [Audience, ...Audience[]])),
  kids: z.number(),
  busy: z.number(),
  lively: z.number(),
  late: z.number(),
  known: z.boolean(),
})
export type ProfileRaw = z.infer<typeof ProfileOut>

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.5))
const phrase = (s: string) => s.trim().replace(/[.!]+$/, '').slice(0, 60)

// A model's answer, tidied into a profile. The rules' numbers fill anything it left out.
export function profileFrom(raw: ProfileRaw, p: Place, by: 'claude' | 'openai', at = Date.now()): PlaceProfile | undefined {
  if (!raw.known) return undefined
  const base = ruleProfile(p)
  const yes = [...new Set(raw.for)]
  return {
    strengths: raw.strengths.map(phrase).filter(Boolean).slice(0, 4),
    weaknesses: raw.weaknesses.map(phrase).filter(Boolean).slice(0, 4),
    for: yes.slice(0, 6),
    notFor: [...new Set(raw.not_for)].filter(a => !yes.includes(a)).slice(0, 4),
    kids: clamp(raw.kids ?? base.kids),
    busy: clamp(raw.busy ?? base.busy),
    lively: clamp(raw.lively ?? base.lively),
    late: clamp(raw.late ?? base.late),
    by,
    at,
  }
}

const BATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['places'],
  properties: {
    places: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', ...PROFILE_REQUIRED], properties: { id: { type: 'string' }, ...PROFILE_PROPS } },
    },
  },
} as const

const BatchOut = z.object({ places: z.array(ProfileOut.extend({ id: z.string() })) })

const batchBrief = (city: City) => `You profile places in ${city.name} for a trip planner that matches places to travellers. For each place, say honestly what it does well and what to know before going, and who it suits and who it doesn't, from what you know of the place itself. Audiences: first-timers (the classics), locals (people who know the city and want the less obvious), families (with young children), couples, solo, groups, foodies, night-owls, early-birds, budget (a tight budget), splurge, crowd-averse, wanderers (like to roam without a plan), adventurous, chill. Numbers are 0-1. Mark known=false for any place you don't actually recognise, and leave its lists empty. Never invent awards, dishes or history.`

const placeLine = (p: Place) => `${p.id} | ${p.name} | ${p.kind} | ${p.tags.join(',')} | price ${p.price}/3 | ${p.blurb}${p.keywords?.length ? ` | ${p.keywords.join(', ')}` : ''}`

export const profilingEnabled = () => brainEnabled || Boolean(openai)

// Profiles for a batch of places (up to about 20 at a time). Places the model doesn't know are left out.
export async function profileBatch(city: City, places: Place[], signal?: AbortSignal): Promise<Map<string, PlaceProfile>> {
  const out = new Map<string, PlaceProfile>()
  if (!places.length) return out
  const ask = `Places:\n${places.map(placeLine).join('\n')}`
  let json: string
  let by: 'claude' | 'openai'
  if (brainEnabled) {
    const response = await client.beta.messages.create({
      ...FALLBACK,
      model: MODEL,
      max_tokens: 12000,
      system: batchBrief(city),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: BATCH_SCHEMA } },
      messages: [{ role: 'user', content: ask }],
    }, { signal: signal ?? AbortSignal.timeout(120_000) })
    if (response.stop_reason !== 'end_turn') return out
    json = textOf(response)
    by = 'claude'
  } else if (openai) {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: 'low' },
      instructions: batchBrief(city),
      input: ask,
      text: { format: { type: 'json_schema', name: 'profiles', strict: true, schema: BATCH_SCHEMA as unknown as Record<string, unknown> } },
    }, { signal: signal ?? AbortSignal.timeout(120_000) })
    if (response.status !== 'completed') return out
    json = response.output_text
    by = 'openai'
  } else return out
  const byId = new Map(places.map(p => [p.id, p]))
  for (const raw of BatchOut.parse(JSON.parse(json)).places) {
    const p = byId.get(raw.id)
    const prof = p && profileFrom(raw, p, by)
    if (prof) out.set(p!.id, prof)
  }
  return out
}
