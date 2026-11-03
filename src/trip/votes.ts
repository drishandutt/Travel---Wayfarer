import type { DeckCard } from '../planner/core'
import type { PlaceVote, TripPerson, VoteValue } from './types'

// What the group thinks of each place. Pure, so the same answer shows on every screen.

export interface PlaceTally { placeId: string; likes: string[]; nopes: string[]; net: number }

export function tally(votes: PlaceVote[]): Map<string, PlaceTally> {
  const out = new Map<string, PlaceTally>()
  for (const v of votes) {
    const t = out.get(v.placeId) ?? { placeId: v.placeId, likes: [], nopes: [], net: 0 }
    if (v.vote === 'like') { t.likes.push(v.memberId); t.net++ } else { t.nopes.push(v.memberId); t.net-- }
    out.set(v.placeId, t)
  }
  return out
}

// Most liked first: by likes minus dislikes, then total likes, then the deck's own order
// (best match first), so ties always come out the same.
export function rankDeck(deck: DeckCard[], votes: PlaceVote[]): PlaceTally[] {
  const counts = tally(votes)
  const order = new Map(deck.map((c, i) => [c.id, i]))
  return deck
    .map(c => counts.get(c.id) ?? { placeId: c.id, likes: [], nopes: [], net: 0 })
    .sort((a, b) => b.net - a.net || b.likes.length - a.likes.length || order.get(a.placeId)! - order.get(b.placeId)!)
}

// What goes in the plan unless the admin says otherwise: whatever at least as many people
// liked as disliked, best first, up to what fits in the trip.
export function defaultPicks(deck: DeckCard[], votes: PlaceVote[], capacity: number): string[] {
  return rankDeck(deck, votes)
    .filter(t => t.likes.length > 0 && t.net >= 0)
    .slice(0, Math.max(1, capacity))
    .map(t => t.placeId)
}

// Places more people disliked than liked: the planner won't suggest these to fill a gap.
export function rejectedPlaces(deck: DeckCard[], votes: PlaceVote[]): string[] {
  return rankDeck(deck, votes).filter(t => t.net < 0).map(t => t.placeId)
}

export function myVotes(votes: PlaceVote[], me: string): Record<string, VoteValue> {
  const out: Record<string, VoteValue> = {}
  for (const v of votes) if (v.memberId === me) out[v.placeId] = v.vote
  return out
}

export interface VotingProgress {
  voters: TripPerson[]          // everyone who has signed in: the people a vote can come from
  started: TripPerson[]
  finished: TripPerson[]
  waiting: TripPerson[]         // haven't finished the deck yet
}

export function votingProgress(deck: DeckCard[], votes: PlaceVote[], people: TripPerson[]): VotingProgress {
  const voters = people.filter(p => p.joined)
  const ids = new Set(deck.map(c => c.id))
  const cast = new Map<string, number>()
  for (const v of votes) if (ids.has(v.placeId)) cast.set(v.memberId, (cast.get(v.memberId) ?? 0) + 1)
  const finished = voters.filter(p => deck.length > 0 && (cast.get(p.id) ?? 0) >= deck.length)
  return {
    voters,
    started: voters.filter(p => cast.has(p.id)),
    finished,
    waiting: voters.filter(p => !finished.includes(p)),
  }
}
