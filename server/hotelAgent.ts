import { z } from 'zod'
import type { DayPlan, PlannerEvent, TripBrief } from '../src/types'
import { cityById } from '../src/data/cities'
import { centroid } from '../src/planner/geo'
import { hotelLegs, scoreHotel } from '../src/planner/core'
import { resolveBudgetTier } from '../src/planner/intake'
import { sleep } from '../src/planner/engine'
import { FALLBACK, MODEL, client, effortFor, textOf } from './claude'

// Hotel scores are computed (commute, price, vibe are measurable); Claude makes
// the judgement call between them and explains it in the traveller's terms.

const Choice = z.object({ hotel_id: z.string(), reason: z.string() })

export async function* hotelsWithClaude(brief: TripBrief, days: DayPlan[], signal: AbortSignal): AsyncGenerator<PlannerEvent> {
  const city = cityById(brief.destination)
  if (!city) throw new Error(`No map data for "${brief.destination}".`)
  const all = days.flatMap(d => d.stops.map(s => s.place.coord))
  const gravity = centroid(all)
  yield { type: 'thought', text: `Finding the centre of gravity of your ${all.length} stops…` }
  yield { type: 'scan', center: gravity, radiusKm: 3 }
  yield { type: 'camera', center: gravity, zoom: city.zoom + 0.6 }

  const scores = city.hotels.map(h => scoreHotel(h, brief, days))
  const ask = client.beta.messages.create(
    {
      ...FALLBACK,
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: effortFor('hotel'),
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['hotel_id', 'reason'],
            properties: {
              hotel_id: { type: 'string', enum: city.hotels.map(h => h.id) },
              reason: { type: 'string', description: 'One or two sentences to the traveller on why this is their base.' },
            },
          },
        },
      },
      messages: [{
        role: 'user',
        content: `Pick the best hotel base for this ${city.name} trip.

Travellers: ${brief.travelers ?? 2}, ${brief.days ?? 3} nights, ${resolveBudgetTier(brief)} budget${brief.budgetAmount ? ` ($${brief.budgetAmount} total)` : ''}, vibe: ${brief.vibes.join(', ') || 'mixed'}.

Itinerary:
${days.map(d => `Day ${d.day} (${d.title}): ${d.stops.map(s => s.place.name).join(' → ')}`).join('\n')}

Candidates (avg commute = minutes to each day's first/last stop):
${scores.map(s => `${s.hotel.id} | ${s.hotel.name} | $${s.hotel.nightly}/night | ${s.hotel.tier} | avg commute ${Math.round(s.avgCommute)} min | ${s.hotel.blurb}`).join('\n')}

Weigh short daily commutes heavily, then budget, then atmosphere.`,
      }],
    },
    { signal },
  )

  // Reveal the candidates while Claude deliberates.
  for (const s of scores) {
    yield { type: 'hotel-candidate', score: s }
    yield { type: 'thought', text: `${s.hotel.name}: ~${Math.round(s.avgCommute)} min to each day’s start/end, $${s.hotel.nightly}/night.` }
    await sleep(380, signal)
  }

  const response = await ask
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to choose a hotel.')
  const choice = Choice.parse(JSON.parse(textOf(response)))
  const best = scores.find(s => s.hotel.id === choice.hotel_id) ?? [...scores].sort((a, b) => b.total - a.total)[0]

  yield { type: 'thought', text: choice.reason, tone: 'decide' }
  yield { type: 'camera', center: best.hotel.coord, zoom: city.zoom + 0.8 }
  yield { type: 'hotel-pick', score: best, days: hotelLegs(best.hotel, days) }
}
