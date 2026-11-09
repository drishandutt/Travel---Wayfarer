import type { TripBrief } from '../types'

// Sliders in the chat that tune the trip beyond the basic questions. Each one sets a 0..1
// number on the brief, in five steps; the planners read them (dayShape and scorePlace in
// ./core, and the brief the Claude planner and the assistant are shown). Unset, a slider sits
// at `start` and changes nothing.

type NumericField = { [K in keyof TripBrief]-?: NonNullable<TripBrief[K]> extends number ? K : never }[keyof TripBrief]

export interface BriefSlider {
  key: NumericField
  name: string                                  // for the planners: "Pace", "Knows the city"
  question: (city: string) => string
  ends: [string, string]
  start: number                                 // where it sits before they touch it (0..1)
  // one per step, low to high: what it's called, and what it does to the plan
  stops: { label: string; effect: string }[]
  also?: (value: number) => Partial<TripBrief>  // anything else that moves with it
}

export const SLIDERS: BriefSlider[] = [
  {
    key: 'familiarity',
    name: 'Knows the city',
    question: city => `How well do you know ${city}?`,
    ends: ['First time', 'Like a local'],
    start: 0,
    stops: [
      { label: 'First time here', effect: 'All the must-sees' },
      { label: 'Been once before', effect: 'The big names you missed, plus some local favourites' },
      { label: 'Know the basics', effect: 'Half famous, half local' },
      { label: 'Know it well', effect: 'Mostly local favourites' },
      { label: 'Basically a local', effect: 'Hidden gems only, none of the obvious' },
    ],
  },
  {
    key: 'paceLevel',
    name: 'Pace',
    question: () => 'How full should each day be?',
    ends: ['Slow mornings', 'See it all'],
    start: 0.5,
    stops: [
      { label: 'Very slow', effect: 'Three stops a day, long breaks, out from 10' },
      { label: 'Relaxed', effect: 'Four stops a day with time to linger' },
      { label: 'Balanced', effect: 'Five stops a day' },
      { label: 'Busy', effect: 'Six stops a day, out by 8:30' },
      { label: 'See it all', effect: 'Seven stops a day, short breaks, out by 8' },
    ],
    also: v => ({ pace: v < 0.375 ? 'slow' : v > 0.625 ? 'packed' : 'balanced' }),
  },
  {
    key: 'rhythm',
    name: 'Day rhythm',
    question: () => 'Early bird or night owl?',
    ends: ['Early bird', 'Night owl'],
    start: 0.5,
    stops: [
      { label: 'Up with the sun', effect: 'Out by 7:30, mornings first, nothing late' },
      { label: 'Early riser', effect: 'An early start and quieter evenings' },
      { label: 'Either way', effect: 'A normal day' },
      { label: 'Late starter', effect: 'A later start and more evening plans' },
      { label: 'Night owl', effect: 'Out from 10:30, bars and late spots each night' },
    ],
  },
  {
    key: 'structure',
    name: 'Planning style',
    question: () => 'Every hour planned, or room to wander?',
    ends: ['Plan it all', 'Wander'],
    start: 0.5,
    stops: [
      { label: 'Plan every hour', effect: 'Tight breaks between stops' },
      { label: 'Mostly planned', effect: 'Short breaks' },
      { label: 'A bit of both', effect: 'Some free time each day' },
      { label: 'Loose', effect: 'Longer free stretches, more places to roam' },
      { label: 'Just wander', effect: 'A stop fewer, long free stretches, markets and parks to roam' },
    ],
  },
  {
    key: 'walking',
    name: 'Walking',
    question: () => 'How much walking?',
    ends: ['Keep it short', 'Walk miles'],
    start: 0.5,
    stops: [
      { label: 'As little as possible', effect: 'A ride for anything past 600 m' },
      { label: 'Short walks', effect: 'A ride past about 1 km' },
      { label: 'Some walking', effect: 'Walk up to about 1.4 km' },
      { label: 'Happy to walk', effect: 'Walk up to about 2 km' },
      { label: 'Walk everywhere', effect: 'Walk up to 3 km between stops' },
    ],
  },
  {
    key: 'foodie',
    name: 'Food focus',
    question: () => 'How big a part is the food?',
    ends: ['Eat to live', 'Live to eat'],
    start: 0.5,
    stops: [
      { label: 'Eat to live', effect: 'Meals fit around the sights' },
      { label: 'Food matters a bit', effect: 'A good meal each day' },
      { label: 'Food matters', effect: 'Proper meals each day' },
      { label: 'Big on food', effect: 'More food stops, markets and cafés' },
      { label: 'Live to eat', effect: 'Two food stops a day, the trip built around them' },
    ],
  },
  {
    key: 'crowds',
    name: 'Crowds',
    question: () => 'How do you feel about crowds?',
    ends: ['Don’t mind', 'Avoid them'],
    start: 0,
    stops: [
      { label: 'Don’t mind', effect: 'Crowds don’t change the plan' },
      { label: 'A little', effect: 'Fewer of the very busiest sights' },
      { label: 'Rather not', effect: 'The busiest sights only if they’re worth it' },
      { label: 'Avoid them', effect: 'Quieter places over the famous queues' },
      { label: 'Hate queues', effect: 'Skip the busiest sights altogether' },
    ],
  },
  {
    key: 'splurgeOn',
    name: 'Where the money goes',
    question: () => 'Spend more on the stay, or on the days?',
    ends: ['The stay', 'Food & things to do'],
    start: 0.5,
    stops: [
      { label: 'The stay', effect: 'A nicer hotel, simpler days' },
      { label: 'Lean to the stay', effect: 'A bit more for the hotel' },
      { label: 'Even', effect: 'Spread evenly' },
      { label: 'Lean to the days', effect: 'A bit more for food and things to do' },
      { label: 'Food & things to do', effect: 'A simple hotel, better meals and experiences' },
    ],
  },
  {
    key: 'energy',
    name: 'Energy',
    question: () => 'Chill or adventurous?',
    ends: ['Chill', 'Adventurous'],
    start: 0.5,
    stops: [
      { label: 'Very chill', effect: 'Parks, cafés and slow views' },
      { label: 'Laid back', effect: 'Mostly easy-going' },
      { label: 'A mix', effect: 'Some of each' },
      { label: 'Up for it', effect: 'More active and lively spots' },
      { label: 'Adventurous', effect: 'Climbs, boats, nights out, the lively stuff' },
    ],
  },
  {
    key: 'kids',
    name: 'Kids',
    question: () => 'Any little ones coming?',
    ends: ['No kids', 'Little ones'],
    start: 0,
    stops: [
      { label: 'No kids', effect: 'Plan for adults' },
      { label: 'Older kids', effect: 'Nothing too late' },
      { label: 'Kids along', effect: 'A stop fewer, more parks and museums, no bars' },
      { label: 'Young kids', effect: 'Shorter visits, longer breaks, early finishes' },
      { label: 'Little ones', effect: 'Short visits, lots of breaks, parks and museums, nothing late' },
    ],
  },
]

export const stepOf = (value: number, steps: number) => Math.round(value * (steps - 1))
export const valueOf = (step: number, steps: number) => step / (steps - 1)

export const sliderValue = (s: BriefSlider, brief: TripBrief) => brief[s.key] ?? s.start

// What setting a slider changes on the brief.
export const sliderPatch = (s: BriefSlider, value: number): Partial<TripBrief> => ({ [s.key]: value, ...s.also?.(value) })

// The sliders they've moved, in words, for the planners: "Pace: Busy (Six stops a day, out by 8:30)".
export function tuningLines(brief: TripBrief): string[] {
  return SLIDERS.filter(s => brief[s.key] !== undefined).map(s => {
    const stop = s.stops[stepOf(brief[s.key]!, s.stops.length)]
    return `${s.name}: ${stop.label} (${stop.effect})`
  })
}
