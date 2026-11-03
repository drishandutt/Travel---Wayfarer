import type { DayPlan, HotelScore, TripBrief } from '../types'
import type { DeckCard } from '../planner/core'
import type { Candidate, ChatMessage, Phase, Thought } from '../state/tripStore'
import type { TripSummary } from '../money/types'

// A trip shared with a group. The admin's browser runs the planner and publishes each
// version of the plan here; everyone else in the group sees it live and can't change it.

export type VoteValue = 'like' | 'nope'

export interface SharedPlan {
  phase: Phase
  brief: TripBrief
  deck: DeckCard[]              // the same tiles, in the same order, for everyone
  days: DayPlan[]
  hotel?: HotelScore
  hotelScores: HotelScore[]
  candidates: Record<string, Candidate>
  messages: ChatMessage[]       // the admin's conversation with the planner
  thoughts: Thought[]
}

export interface PlaceVote { placeId: string; memberId: string; vote: VoteValue }

export interface TripNote { id: string; memberId: string; body: string; createdAt: number; pending?: boolean }

export interface TripPerson { id: string; name: string; role: 'owner' | 'member'; joined: boolean; waitingEmail: string | null }

export interface SharedTrip {
  groupId: string
  name: string
  version: number
  planVersion: number
  plan: SharedPlan | null       // null when the caller already has this version, or there's no plan yet
  hasPlan: boolean
  me: string
  role: 'owner' | 'member'
  inviteToken: string           // only ever sent to the admin
  people: TripPerson[]
  votes: PlaceVote[]
  notes: TripNote[]
}

export interface PublishPlan { plan: SharedPlan; summary: TripSummary | null; baseVersion: number }
