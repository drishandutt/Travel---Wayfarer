import { z } from 'zod'
import type { DayPlan, PlannerEvent, TripBrief } from '../src/types'
import { cityById } from '../src/data/cities'
import { centroid } from '../src/planner/geo'
import { hotelLegs, scoreHotel, stayHotel } from '../src/planner/core'
import { resolveBudgetTier } from '../src/planner/intake'
import { storyLines } from '../src/planner/story'
import { sleep } from '../src/planner/engine'
import { structured } from './llm'

// Hotel scores are computed (commute, price, vibe are measurable); the model makes the
// judgement call between them and explains it in the traveller's terms. Where they told us
// they're staying, that's the base, and nothing is chosen.

const Choice = z.object({ hotel_id: z.string(), reason: z.string() })

export async function* hotelsWithModel(brief: TripBrief, days: DayPlan[], signal: AbortSignal): AsyncGenerator<PlannerEvent> {
  const city = cityById(brief.destination)
  if (!city) throw new Error(`No map data for "${brief.destination}".`)
  const all = days.flatMap(d => d.stops.map(s => s.place.coord))
  const gravity = centroid(all)
  yield { type: 'thought', text: `Finding the centre of gravity of your ${all.length} stops…` }
  yield { type: 'scan', center: gravity, radiusKm: 3 }
  yield { type: 'camera', center: gravity, zoom: city.zoom + 0.6 }

  const stay = stayHotel(brief)
  if (stay) {
    const score = { ...scoreHotel(stay, brief, days), priceFit: 1 }
    yield { type: 'hotel-candidate', score }
    yield { type: 'thought', text: `You’re staying at ${stay.name}: ~${Math.round(score.avgCommute)} min to each day’s start and end. Wiring it into every day’s route.`, tone: 'decide' }
    yield { type: 'camera', center: stay.coord, zoom: city.zoom + 0.8 }
    yield { type: 'hotel-pick', score, days: hotelLegs(stay, days) }
    return
  }

  const scores = city.hotels.map(h => scoreHotel(h, brief, days))
  const ask = structured({
    kind: 'hotel',
    name: 'hotel_choice',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['hotel_id', 'reason'],
      properties: {
        hotel_id: { type: 'string', enum: city.hotels.map(h => h.id) },
        reason: { type: 'string', description: 'One or two sentences to the traveller on why this is their base.' },
      },
    },
    signal,
    messages: [{
        role: 'user',
        content: `Pick the best hotel base for this ${city.name} trip.

Travellers: ${brief.travelers ?? 2}, ${brief.days ?? 3} nights, ${resolveBudgetTier(brief)} budget${brief.budgetAmount ? ` ($${brief.budgetAmount} total)` : ''}, vibe: ${brief.vibes.join(', ') || 'mixed'}.
${storyLines(brief).join('\n')}

Itinerary:
${days.map(d => `Day ${d.day} (${d.title}): ${d.stops.map(s => s.place.name).join(' → ')}`).join('\n')}

Candidates (avg commute = minutes to each day's first/last stop):
${scores.map(s => `${s.hotel.id} | ${s.hotel.name} | $${s.hotel.nightly}/night | ${s.hotel.tier} | avg commute ${Math.round(s.avgCommute)} min | ${s.hotel.blurb}`).join('\n')}

Weigh short daily commutes heavily, then budget, then atmosphere.`,
    }],
  })
  ask.catch(() => {}) // awaited below; this keeps an early failure from going unhandled while candidates animate

  // Reveal the candidates while the model deliberates.
  for (const s of scores) {
    yield { type: 'hotel-candidate', score: s }
    yield { type: 'thought', text: `${s.hotel.name}: ~${Math.round(s.avgCommute)} min to each day’s start/end, $${s.hotel.nightly}/night.` }
    await sleep(380, signal)
  }

  const choice = Choice.parse(await ask)
  const best = scores.find(s => s.hotel.id === choice.hotel_id) ?? [...scores].sort((a, b) => b.total - a.total)[0]

  yield { type: 'thought', text: choice.reason, tone: 'decide' }
  yield { type: 'camera', center: best.hotel.coord, zoom: city.zoom + 0.8 }
  yield { type: 'hotel-pick', score: best, days: hotelLegs(best.hotel, days) }
}
