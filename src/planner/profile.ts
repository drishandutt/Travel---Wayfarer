import type { Audience, Place, PlaceProfile, TripBrief } from '../types'
import { resolveBudgetTier } from './intake'

// What a place is good and bad at, and who it suits. Every place has a profile: the rules
// here give one from what the catalog already says (kind, tags, price, fame, best time), the
// server asks Claude or OpenAI for a better one where it knows the place, and travellers'
// swipes teach the rest (`learned`). The planners read it against the trip through
// `profileFit`, so a place is suggested to the people it's right for and not to the rest.

export const AUDIENCES: Audience[] = [
  'first-timers', 'locals', 'families', 'couples', 'solo', 'groups', 'foodies',
  'night-owls', 'early-birds', 'budget', 'splurge', 'crowd-averse', 'wanderers', 'adventurous', 'chill',
]

export const AUDIENCE_LABEL: Record<Audience, string> = {
  'first-timers': 'first-timers', locals: 'people who know the city', families: 'families', couples: 'couples', solo: 'solo travellers',
  groups: 'groups', foodies: 'foodies', 'night-owls': 'night owls', 'early-birds': 'early birds', budget: 'a tight budget',
  splurge: 'a splurge', 'crowd-averse': 'avoiding crowds', wanderers: 'wandering', adventurous: 'the adventurous', chill: 'a slow day',
}

const clamp = (n: number) => Math.max(0, Math.min(1, n))

// A profile from what the catalog already says. Deterministic, so the browser and the server agree.
export function ruleProfile(p: Place): PlaceProfile {
  const has = (...t: string[]) => t.some(x => p.tags.includes(x as Place['tags'][number]))
  const eats = p.kind === 'food' || p.kind === 'cafe' || (p.kind === 'market' && has('food'))
  const rank = p.rank

  let kids = { park: 0.9, museum: 0.7, market: 0.6, sight: 0.6, viewpoint: 0.6, cafe: 0.5, food: p.price >= 3 ? 0.2 : 0.4, bar: 0.05, experience: 0.5 }[p.kind]
  if (p.bestAt === 'night' || has('nightlife')) kids = Math.min(kids, 0.15)
  if (has('adventure') && p.kind !== 'bar') kids += 0.1

  let busy = rank === undefined ? 0.4 : rank >= 0.8 ? 0.85 : rank >= 0.6 ? 0.65 : rank >= 0.4 ? 0.45 : 0.3
  if (p.kind === 'market') busy += 0.1
  if (p.kind === 'park' && (rank ?? 0) < 0.8) busy -= 0.1

  let lively = { bar: 0.85, market: 0.65, sight: 0.5, food: 0.5, viewpoint: 0.45, museum: 0.35, cafe: 0.3, park: 0.25, experience: 0.6 }[p.kind]
  if (has('nightlife', 'adventure')) lively = Math.max(lively, 0.8)
  if (has('relaxed')) lively -= 0.15
  if (has('romantic')) lively -= 0.1

  let late = { night: 1, evening: 0.65, midday: 0.3, morning: 0.1 }[p.bestAt ?? 'midday']
  if (p.kind === 'bar') late = Math.max(late, 0.8)

  const out: PlaceProfile = { strengths: [], weaknesses: [], for: [], notFor: [], kids: clamp(kids), busy: clamp(busy), lively: clamp(lively), late: clamp(late), by: 'rules', at: 0 }
  const f = (a: Audience) => { if (!out.for.includes(a)) out.for.push(a) }
  const n = (a: Audience) => { if (!out.notFor.includes(a)) out.notFor.push(a) }

  if (rank !== undefined && rank >= 0.8) { f('first-timers'); out.strengths.push('a must-see') }
  if (rank !== undefined && rank >= 0.9) n('locals')
  if (rank !== undefined && rank <= 0.4) { f('locals'); if (rank <= 0.3) out.strengths.push('off the beaten track') }
  if (out.kids >= 0.7) f('families')
  if (p.kind === 'bar' || p.bestAt === 'night') n('families')
  if (has('romantic')) f('couples')
  if (p.price === 0) { f('budget'); out.strengths.push('free to visit') }
  if (eats && p.price <= 1) f('budget')
  if (p.price >= 3) { f('splurge'); n('budget'); out.weaknesses.push('pricey') }
  if (eats && p.keywords?.length) { f('foodies'); out.strengths.push(p.keywords.slice(0, 2).join(' and ')) }
  if (out.late >= 0.65) f('night-owls')
  if (p.bestAt === 'morning') f('early-birds')
  if (p.kind === 'park' || p.kind === 'market') f('wanderers')
  if (has('adventure')) f('adventurous')
  if (has('relaxed') || p.kind === 'park' || p.kind === 'cafe') f('chill')
  if (out.busy <= 0.45) f('crowd-averse')
  if (out.busy >= 0.8) { n('crowd-averse'); out.weaknesses.push('queues at peak times') }
  if (p.bestAt === 'night') out.weaknesses.push('a late one')
  if (p.book) out.weaknesses.push('needs booking ahead')
  for (const t of p.tags) if (out.strengths.length < 3 && !out.strengths.some(s => s.includes(t))) out.strengths.push(`good for ${t}`)
  out.strengths = out.strengths.slice(0, 4)
  out.weaknesses = out.weaknesses.slice(0, 4)
  return out
}

export const profileOf = (p: Place): PlaceProfile => p.profile ?? ruleProfile(p)

// Who this trip is, read from the brief: the sliders they moved, the budget, and who's coming.
export function audiencesOf(brief: TripBrief): Audience[] {
  const out: Audience[] = []
  const fam = brief.familiarity ?? 0
  if (fam <= 0.25) out.push('first-timers')
  if (fam >= 0.6) out.push('locals')
  if ((brief.kids ?? 0) >= 0.5) out.push('families')
  const n = brief.travelers ?? 0
  if (n === 1) out.push('solo')
  if (n === 2 && !out.includes('families')) out.push('couples')
  if (n >= 4) out.push('groups')
  if ((brief.foodie ?? 0.5) >= 0.75 || (brief.vibes.includes('food') && (brief.foodie ?? 0.5) > 0.5)) out.push('foodies')
  if ((brief.rhythm ?? 0.5) >= 0.75) out.push('night-owls')
  if ((brief.rhythm ?? 0.5) <= 0.25) out.push('early-birds')
  const tier = resolveBudgetTier(brief)
  if (tier === 'shoestring') out.push('budget')
  if (tier === 'luxury') out.push('splurge')
  if ((brief.crowds ?? 0) >= 0.5) out.push('crowd-averse')
  if ((brief.structure ?? 0.5) >= 0.75) out.push('wanderers')
  if ((brief.energy ?? 0.5) >= 0.75) out.push('adventurous')
  if ((brief.energy ?? 0.5) <= 0.25) out.push('chill')
  return out
}

// The audience-only part of the fit. The numbers (kids, busy, lively, late) are read by the
// slider tuning in ./core, which replaces its own guesses with them.
export function profileFit(p: Place, brief: TripBrief, who = audiencesOf(brief)): { score: number; why?: string } {
  const prof = profileOf(p)
  const { yes, no } = audiencesOfProfile(prof)
  const forUs = who.filter(a => yes.includes(a))
  const notUs = who.filter(a => no.includes(a))
  // rules say little the other columns don't; a profile from someone who knows the place, or
  // from what travellers kept, says more
  const weight = prof.by === 'rules' && !prof.learned ? 0.6 : 1
  const score = weight * (forUs.length * 1.5 - notUs.length * 2.5)
  const lead = forUs.find(a => !notUs.includes(a))
  const why = lead && (prof.by !== 'rules' || prof.learned) ? WHY[lead] : undefined
  return { score, why }
}

const WHY: Record<Audience, string> = {
  'first-timers': 'a first-visit classic', locals: 'a local favourite', families: 'good with little ones', couples: 'one for the two of you',
  solo: 'easy on your own', groups: 'works for a group', foodies: 'one for the foodie', 'night-owls': 'for a night owl', 'early-birds': 'for an early start',
  budget: 'easy on the budget', splurge: 'worth the splurge', 'crowd-averse': 'away from the crowds', wanderers: 'a place to wander',
  adventurous: 'for the adventurous', chill: 'a slow one',
}

// Who a place is for and not for, all told: what people like these actually kept outranks
// what the catalog or the model guessed.
export function audiencesOfProfile(prof: PlaceProfile): { yes: Audience[]; no: Audience[] } {
  const lf = prof.learned?.for ?? []
  const ln = prof.learned?.notFor ?? []
  const yes = [...new Set([...lf, ...prof.for.filter(a => !ln.includes(a))])]
  const no = [...new Set([...ln, ...prof.notFor.filter(a => !lf.includes(a))])].filter(a => !yes.includes(a))
  return { yes, no }
}

// "for families, foodies; not budget", for the planner's catalog and the cards.
export function profileLine(p: Place): string | undefined {
  const prof = profileOf(p)
  if (prof.by === 'rules' && !prof.learned) return undefined
  const { yes, no } = audiencesOfProfile(prof)
  const parts = [yes.length ? `for ${yes.slice(0, 4).join(', ')}` : '', no.length ? `not ${no.slice(0, 3).join(', ')}` : '']
  return parts.filter(Boolean).join('; ') || undefined
}
