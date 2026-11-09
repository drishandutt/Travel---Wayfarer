import type { TripBrief } from '../types'

// Sliders in the chat that tune the trip beyond the basic questions. Each one sets a 0..1
// number on the brief, in five steps; the planners read it (see scorePlace in ./core).

type NumericField = { [K in keyof TripBrief]-?: NonNullable<TripBrief[K]> extends number ? K : never }[keyof TripBrief]

export interface BriefSlider {
  key: NumericField
  question: (city: string) => string
  ends: [string, string]
  // one per step, low to high: what it's called, and what it does to the plan
  stops: { label: string; effect: string }[]
}

export const SLIDERS: BriefSlider[] = [
  {
    key: 'familiarity',
    question: city => `How well do you know ${city}?`,
    ends: ['First time', 'Like a local'],
    stops: [
      { label: 'First time here', effect: 'All the must-sees' },
      { label: 'Been once before', effect: 'The big names you missed, plus some local favourites' },
      { label: 'Know the basics', effect: 'Half famous, half local' },
      { label: 'Know it well', effect: 'Mostly local favourites' },
      { label: 'Basically a local', effect: 'Hidden gems only, none of the obvious' },
    ],
  },
]

export const stepOf = (value: number | undefined, steps: number) => Math.round((value ?? 0) * (steps - 1))
export const valueOf = (step: number, steps: number) => step / (steps - 1)
