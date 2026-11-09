import type { City, DayPlan, PlannerEvent, TripBrief } from '../types'
import { tripCity } from '../data/cities'
import { centroid, fmtClock } from './geo'
import { resolveBudgetTier } from './intake'
import { sleep, type PlannerEngine, type Picks } from './engine'
import { PACE, applyGapFill, buildDay, findGapFill, groupDays, hotelLegs, scoreHotel, scorePlace, shortlist } from './core'

export class MockPlanner implements PlannerEngine {
  constructor(private speed = 1) {}

  private wait(ms: number, signal: AbortSignal) {
    return sleep(ms / this.speed, signal)
  }

  async *planItinerary(brief: TripBrief, signal: AbortSignal, picks?: Picks): AsyncGenerator<PlannerEvent> {
    const city = tripCity(brief) as City
    const days = Math.min(brief.days ?? 3, picks ? Math.max(1, picks.liked.length) : Infinity)
    const pace = PACE[brief.pace ?? 'balanced']
    const tier = resolveBudgetTier(brief)

    yield { type: 'camera', center: city.center, zoom: city.zoom }
    yield { type: 'thought', text: `Opening the map of ${city.name}. ${days} day${days > 1 ? 's' : ''}, ${brief.travelers ?? 2} traveller${(brief.travelers ?? 2) > 1 ? 's' : ''}, ${tier} budget, vibe: ${brief.vibes.join(', ') || 'a bit of everything'}.` }
    await this.wait(700, signal)

    let chosen
    if (picks) {
      // the traveller already chose by swiping: plan exactly their picks
      chosen = city.places.filter(p => picks.liked.includes(p.id))
      yield { type: 'thought', text: `You kept ${chosen.length} place${chosen.length === 1 ? '' : 's'}. Fitting them into ${days} day${days > 1 ? 's' : ''}…` }
      if ((brief.days ?? 3) > days) yield { type: 'thought', text: `Only ${chosen.length} pick${chosen.length === 1 ? '' : 's'}, so planning ${days} day${days > 1 ? 's' : ''} instead of ${brief.days}.`, tone: 'warn' }
      await this.wait(600, signal)
    } else {
      yield { type: 'scan', center: city.center, radiusKm: 9 }
      yield { type: 'thought', text: `Scanning ${city.places.length} places I know in ${city.name}…` }
      await this.wait(700, signal)

      const scored = shortlist(city.places, brief).map(p => ({ p, ...scorePlace(p, brief) })).sort((a, b) => b.score - a.score)
      const pause = Math.min(1, 40 / scored.length) // the sweep takes as long for London as for Lisbon
      const need = Math.min(scored.length, days * pace.perDay)
      const keep = new Set(scored.slice(0, need).map(s => s.p.id))
      // somewhere to eat each day, and a bar each night on a nightlife trip: in a big city the
      // famous sights would otherwise crowd them all out
      const kindOf = new Map(scored.map(s => [s.p.id, s.p.kind]))
      const musts = [['food', 'cafe'], ...(brief.vibes.includes('nightlife') ? [['bar']] : [])]
      for (const kinds of musts) {
        const is = (id: string) => kinds.includes(kindOf.get(id)!)
        const guarded = (id: string) => musts.some(k => k.includes(kindOf.get(id)!))
        for (const s of scored.filter(s => is(s.p.id) && !keep.has(s.p.id))) {
          if ([...keep].filter(is).length >= days) break
          const weakest = [...scored].reverse().find(x => keep.has(x.p.id) && !guarded(x.p.id))
          if (!weakest) break
          keep.delete(weakest.p.id)
          keep.add(s.p.id)
        }
      }

      // reveal candidates in a geographic sweep so pins "rain" across the city
      const sweep = [...scored].sort((a, b) => a.p.coord[0] - b.p.coord[0])
      for (const s of sweep) {
        yield { type: 'candidate', place: s.p, verdict: 'consider' }
        await this.wait(110 * pause, signal)
      }
      await this.wait(500, signal)
      for (const s of scored) {
        const verdict = keep.has(s.p.id) ? 'keep' : 'drop'
        yield { type: 'candidate', place: s.p, verdict, reason: s.why }
        if (verdict === 'keep') yield { type: 'thought', text: `✓ ${s.p.name} — ${s.why}`, tone: 'decide' }
        await this.wait(verdict === 'keep' ? 260 : 90 * pause, signal)
      }
      chosen = scored.filter(s => keep.has(s.p.id)).map(s => s.p)
    }
    // hand-picked places: keep neighbourhoods together, even if days end up uneven
    const clusters = groupDays(chosen, days, pace.perDay, picks ? pace.perDay + 1 : undefined).sort((a, b) => centroid(a.map(p => p.coord))[0] - centroid(b.map(p => p.coord))[0])
    yield { type: 'thought', text: `Grouping ${chosen.length} keepers into ${clusters.length} neighbourhood${clusters.length > 1 ? 's' : ''} so each day stays walkable.` }
    await this.wait(700, signal)

    // never re-suggest something the traveller swiped away
    const used = new Set([...chosen.map(p => p.id), ...(picks?.rejected ?? [])])
    for (let i = 0; i < clusters.length; i++) {
      let plan = buildDay(i + 1, clusters[i], brief)
      // plug long idle stretches with something nearby before drawing the day
      for (let tries = 0; tries < 2; tries++) {
        const fill = findGapFill(plan, shortlist(city.places, brief, 400).filter(p => !used.has(p.id)), brief)
        if (!fill) break
        used.add(fill.place.id)
        plan = applyGapFill(plan, fill, brief)
        yield { type: 'candidate', place: fill.place, verdict: 'keep' }
        yield { type: 'thought', text: `Day ${plan.day} had ${Math.round(fill.gap / 60 * 10) / 10}h idle — suggesting ${fill.place.name} nearby${picks ? ' (you didn’t see this one; remove it if you like)' : ''}.`, tone: 'decide' }
      }
      const c = centroid(plan.stops.map(s => s.place.coord))
      yield { type: 'camera', center: c, zoom: city.zoom + 1.5 }
      yield { type: 'thought', text: `Day ${plan.day}: ${plan.title}. Starting ${fmtClock(plan.stops[0].arrive)}, ${pace.buffer}-min buffers between stops.` }
      await this.wait(800, signal)
      for (const leg of plan.legs) {
        yield { type: 'leg', leg, color: plan.color }
        await this.wait(380, signal)
      }
      const travel = plan.legs.reduce((s, l) => s + l.minutes, 0)
      yield { type: 'day', plan }
      yield { type: 'thought', text: `Day ${plan.day} locked: ${plan.stops.length} stops, ~${travel} min moving, back by ${fmtClock(plan.stops[plan.stops.length - 1].depart)}.`, tone: 'decide' }
      await this.wait(500, signal)
    }

    yield { type: 'camera', center: city.center, zoom: city.zoom + 0.4 }
    yield { type: 'thought', text: `Draft itinerary ready. Approve it and I’ll find a base that keeps every day close.` }
    yield { type: 'plan-ready' }
  }

  async *findHotels(brief: TripBrief, days: DayPlan[], signal: AbortSignal): AsyncGenerator<PlannerEvent> {
    const city = tripCity(brief) as City
    const all = days.flatMap(d => d.stops.map(s => s.place.coord))
    const gravity = centroid(all)
    yield { type: 'thought', text: `Finding the centre of gravity of your ${all.length} stops…` }
    yield { type: 'scan', center: gravity, radiusKm: 3 }
    yield { type: 'camera', center: gravity, zoom: city.zoom + 0.6 }
    await this.wait(900, signal)

    const scores = city.hotels.map(h => scoreHotel(h, brief, days))
    for (const s of scores) {
      yield { type: 'hotel-candidate', score: s }
      yield { type: 'thought', text: `${s.hotel.name}: ~${Math.round(s.avgCommute)} min to each day’s start/end, $${s.hotel.nightly}/night, fit ${Math.round(s.total * 100)}%.` }
      await this.wait(420, signal)
    }
    const best = [...scores].sort((a, b) => b.total - a.total)[0]
    await this.wait(400, signal)
    yield { type: 'thought', text: `Base camp: ${best.hotel.name}. Wiring it into every day’s route.`, tone: 'decide' }
    yield { type: 'camera', center: best.hotel.coord, zoom: city.zoom + 0.8 }
    yield { type: 'hotel-pick', score: best, days: hotelLegs(best.hotel, days) }
  }
}
