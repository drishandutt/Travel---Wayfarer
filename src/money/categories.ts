import type { CategoryId, PlanKey } from './types'

// `plan` ties a category to the planner's cost estimate, so "planned vs actual" lines up.
// Flights have no line: the estimate doesn't include them.
export const CATEGORIES: { id: CategoryId; label: string; emoji: string; plan: PlanKey | null }[] = [
  { id: 'food', label: 'Food & drink', emoji: '🍜', plan: 'food' },
  { id: 'groceries', label: 'Groceries', emoji: '🧺', plan: 'food' },
  { id: 'stay', label: 'Stay', emoji: '🛏️', plan: 'stay' },
  { id: 'transport', label: 'Getting around', emoji: '🚇', plan: 'transport' },
  { id: 'flights', label: 'Flights', emoji: '✈️', plan: null },
  { id: 'activities', label: 'Tickets & activities', emoji: '🎟️', plan: 'entry' },
  { id: 'shopping', label: 'Shopping', emoji: '🛍️', plan: 'buffer' },
  { id: 'fees', label: 'Fees, SIM & visas', emoji: '🧾', plan: 'buffer' },
  { id: 'other', label: 'Other', emoji: '🏷️', plan: 'buffer' },
]

export const CATEGORY_IDS = CATEGORIES.map(c => c.id) as [CategoryId, ...CategoryId[]]
export const categoryOf = (id: string) => CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1]

const GUESSES: [CategoryId, RegExp][] = [
  ['flights', /\b(flight|airline|airfare|boarding|indigo|emirates|ryanair)\b/],
  ['stay', /\b(hotel|hostel|airbnb|stay|room|ryokan|resort|lodge|booking)\b/],
  ['transport', /\b(taxi|cab|uber|ola|grab|lyft|train|metro|subway|bus|tram|ferry|fuel|petrol|gas|parking|toll|shinkansen|suica|pasmo|scooter|rental|auto|rickshaw|transfer)\b/],
  ['groceries', /\b(grocer(y|ies)|supermarket|konbini|7-?eleven|lawson|familymart|water bottles?)\b/],
  ['food', /\b(lunch|dinner|breakfast|brunch|food|meal|restaurant|cafe|café|coffee|tea|ramen|sushi|tempura|izakaya|bar|beer|beers|drinks?|wine|pastry|pasteis|snacks?|dessert|ice cream|pizza|tapas)\b/],
  ['activities', /\b(tickets?|entry|entrance|museum|temple|shrine|tour|show|gallery|skytree|castle|park|class|workshop|guide|excursion)\b/],
  ['shopping', /\b(shopping|souvenirs?|gifts?|clothes|shoes|mall|market)\b/],
  ['fees', /\b(sim|esim|visa|insurance|atm|fee|fees|tip|tips|laundry|pharmacy)\b/],
]

// The word that comes first decides: "taxi to dinner" is transport, "coffee on the train" is food.
export function guessCategory(title: string): CategoryId | null {
  const t = title.toLowerCase()
  let best: CategoryId | null = null
  let at = Infinity
  for (const [id, re] of GUESSES) {
    const i = t.search(re)
    if (i >= 0 && i < at) { best = id; at = i }
  }
  return best
}

// A stop on the itinerary says what kind of spend it is.
export const categoryForKind = (kind: string): CategoryId =>
  kind === 'food' || kind === 'cafe' || kind === 'bar' ? 'food' : kind === 'market' ? 'shopping' : 'activities'
