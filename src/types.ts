// Core domain model. Every planner backend (mock today, LLM + live data later)
// speaks in these types, so the UI never cares where a plan came from.

export type LngLat = [number, number]

export type Vibe =
  | 'food' | 'culture' | 'nightlife' | 'nature' | 'art'
  | 'shopping' | 'relaxed' | 'adventure' | 'romantic' | 'history'

export type BudgetTier = 'shoestring' | 'comfort' | 'luxury'

export interface TripBrief {
  destination?: string          // city id, e.g. "tokyo"
  days?: number
  travelers?: number
  vibes: Vibe[]
  budgetTier?: BudgetTier
  budgetAmount?: number         // total, in USD
  pace?: 'slow' | 'balanced' | 'packed'
  // The chat's sliders (src/planner/sliders.ts), each 0..1. Unset means the middle, or "none"
  // for crowds and kids, and changes nothing.
  familiarity?: number          // first time there … knows it like a local: must-sees vs hidden gems
  paceLevel?: number            // very slow … see it all; keeps `pace` in step
  rhythm?: number               // early bird … night owl
  structure?: number            // every hour planned … loose days to wander
  walking?: number              // keep walks short … happy to walk miles
  foodie?: number               // eat to live … live to eat
  crowds?: number               // don't mind queues … avoid crowds
  splurgeOn?: number            // spend on the stay … spend on food and experiences
  energy?: number               // chill … adventurous
  kids?: number                 // no kids … little ones along
  startDate?: string            // ISO yyyy-mm-dd, set on the trip dashboard
  tastes?: string[]             // remembered preferences, e.g. ['traditional', 'japanese']
  open?: string[]               // questions answered "you choose" (or not caught): don't ask again
  moneyGroupId?: string         // the shared-expenses group this trip is connected to
  customPlaces?: Place[]        // places the travellers found themselves and added from chat
}

export type PlaceKind = 'sight' | 'food' | 'cafe' | 'bar' | 'park' | 'museum' | 'market' | 'viewpoint'

export interface Place {
  id: string
  name: string
  kind: PlaceKind
  coord: LngLat
  tags: Vibe[]
  price: 0 | 1 | 2 | 3          // 0 = free, 3 = splurge
  minutes: number               // typical visit length
  blurb: string
  bestAt?: 'morning' | 'midday' | 'evening' | 'night'
  book?: string                 // set when it should be booked ahead, with the why
  keywords?: string[]           // cuisine & style words people search by ("tempura", "street food")
  custom?: PlaceSource          // set on places the travellers added themselves
  rank?: number                 // 0..1, how well known it is: 1 is on every first-timer's list, 0 only locals know
  profile?: PlaceProfile        // its strengths, weaknesses and who it suits (src/planner/profile.ts)
  found?: { at: number }        // a traveller's find, now in the city's shared catalog for everyone
}

// Who a place suits. The planners read these against the trip (`audiencesOf` in
// src/planner/profile.ts): the sliders, the budget and who's coming.
export type Audience =
  | 'first-timers' | 'locals' | 'families' | 'couples' | 'solo' | 'groups' | 'foodies'
  | 'night-owls' | 'early-birds' | 'budget' | 'splurge' | 'crowd-averse' | 'wanderers' | 'adventurous' | 'chill'

// What a place is good and bad at, so it's suggested to the travellers it suits. Rules give
// every place one from its kind, tags, price and fame; Claude (or OpenAI) gives a better one
// where it knows the place; and travellers' swipes teach the rest (`learned`).
export interface PlaceProfile {
  strengths: string[]           // what it does well, short phrases, up to 4
  weaknesses: string[]          // what to know before going, up to 4
  for: Audience[]               // who gets the most out of it
  notFor: Audience[]            // who should give it a miss
  kids: number                  // 0..1 how well it works with little ones
  busy: number                  // 0..1 how crowded or queued it usually is
  lively: number                // 0..1 chill … lively
  late: number                  // 0..1 a daytime thing … a night thing
  by: 'rules' | 'claude' | 'openai'
  at: number
  // what travellers' swipes have taught, on top of the above
  learned?: { signals: number; for: Audience[]; notFor: Audience[] }
}

// Where a traveller's own place came from: a maps link they shared, or a name they typed.
export interface PlaceSource {
  from: 'google' | 'apple' | 'osm' | 'waze' | 'coords' | 'name'
  url?: string                  // the link they shared, to open it again
  address?: string              // short, e.g. "Yoyogi, Shibuya"
}

export interface Hotel {
  id: string
  name: string
  coord: LngLat
  nightly: number               // USD per room
  tier: BudgetTier
  tags: Vibe[]
  blurb: string
}

export interface City {
  id: string
  name: string
  country: string
  center: LngLat
  zoom: number
  aliases: string[]
  places: Place[]
  hotels: Hotel[]
  transport: Transport
  essentials: Essentials
  credit?: string               // where its places come from, when that needs crediting
  built?: string                // ISO date, when its catalog was built from public guides (not by hand)
}

// Practical, slow-changing facts for the trip dashboard.
export interface Essentials {
  timezone: string              // IANA, e.g. Asia/Tokyo
  currency: { code: string; symbol: string; perUsd: number }   // rough rate, for orientation only
  plugs: string
  tipping: string
  emergency: string
  transitCard: string
  water: string
  etiquette: string[]
  phrases: { en: string; local: string; say?: string }[]
  packing: string[]             // city-specific packing extras
}

// Rough local fares in USD, enough to show "≈ $4 for 2" on a route.
export interface Transport {
  transitName: string           // e.g. "Metro"
  transitFare: number           // per person, per ride
  taxiBase: number              // per vehicle
  taxiPerKm: number
}

export type TravelMode = 'walk' | 'transit'

export interface TravelOption {
  mode: 'walk' | 'transit' | 'taxi'
  label: string
  minutes: number
  cost: number                  // USD for the whole group; 0 = free
  best: boolean
}

export interface Leg {
  id: string
  day: number
  from: LngLat
  to: LngLat
  mode: TravelMode
  minutes: number
  km: number
  kind: 'stop' | 'hotel'        // hotel legs connect the base to the day
}

export interface Stop {
  place: Place
  arrive: number                // minutes since midnight
  depart: number
  bufferAfter: number
  legIn?: Leg
}

export interface DayPlan {
  day: number
  title: string
  color: string
  stops: Stop[]
  legs: Leg[]
}

export interface HotelScore {
  hotel: Hotel
  avgCommute: number            // minutes, base <-> each day's start/end
  priceFit: number              // 0..1
  vibeFit: number               // 0..1
  total: number                 // 0..1
}

// The planner streams these. The UI is a pure reducer over them, which is what
// lets the map "think out loud" and lets us swap in a server/LLM later via SSE.
export type PlannerEvent =
  | { type: 'thought'; text: string; tone?: 'info' | 'decide' | 'warn' }
  | { type: 'camera'; center: LngLat; zoom: number }
  | { type: 'scan'; center: LngLat; radiusKm: number }
  | { type: 'candidate'; place: Place; verdict: 'consider' | 'keep' | 'drop'; reason?: string }
  | { type: 'day'; plan: DayPlan }
  | { type: 'leg'; leg: Leg; color: string }
  | { type: 'plan-ready' }
  | { type: 'hotel-candidate'; score: HotelScore }
  | { type: 'hotel-pick'; score: HotelScore; days: DayPlan[] }
  | { type: 'error'; message: string }
