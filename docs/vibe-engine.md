# The Vibe Engine: updates that make Wayfarer understand people

_Status: Release 1 live · 2026-11-11_

These are general updates to the tool. They aren't for one city or one kind of trip. Each one
makes every trip feel understood, surprising and easy. They're grouped into what the planner
hears, what it knows, what it plans, what it shows, and what it remembers.

**Where this came from.** Given one rich message, Gemini used every detail it was told, wrote
the plan as a story, got practical when asked, and showed real places with photos. It also had
no sense of the map (long drives back and forth), got facts wrong for the dates, asked nothing
about the people going, and forgot everything between messages. Wayfarer, given the same
message today, kept only "2 people, romantic". These updates close that gap and then go past
it, using what only Wayfarer has: the map, the shared catalog, groups, the vaults, reels and
swipes.

---

## A. Hearing: understand the person, not fill a form

**A1 · Switch Claude on in production.** `/api/health` says `claude: false`, so every visitor
gets the rule-based intake and planner. Add per-visitor and daily spend caps to `/api/intake`,
`/api/plan`, `/api/hotels` and `/api/agent`, then set the key. Everything below depends on it.

**A2 · Add a trip story to the brief.** `TripBrief` today holds destination, days, travellers,
vibes, budget, pace and sliders. Add `story`, filled by the intake's structured output:

| Field | Holds | Examples |
|---|---|---|
| `occasion` | why the trip is happening | honeymoon, birthday, reunion, work trip with a free weekend, first trip abroad |
| `people` | each traveller's relation and what's known about them | "mum: bad knee", "kids 4 and 7", "partner: vegetarian, loves jazz" |
| `anchors` | fixed points, with times | the hotel, landing at 1 pm, a wedding on Saturday, a booked concert |
| `moments` | what they want to happen | "a big night out on day 2", "one proper lazy morning" |
| `register` | the feel, as numbers | romance, energy, intimacy, local vs famous, dressy vs casual |
| `avoid` | what not to plan | touristy, clubs, long drives, early starts |
| `dates` | real dates | from which days, weekdays and the season follow |

The planner, the assistant and the deck all read the story, as they read the brief today.

**A3 · Read back what we heard.** After the first message, show a card with editable chips
(`ReadBack.tsx`) covering every fact we caught. Tapping a chip corrects it. This is the moment
people feel heard, and it catches mistakes before planning.

**A4 · Ask what a friend would ask.** Replace the fixed order of questions (destination, days,
who, vibe, budget) with at most one question per turn, chosen by how much the answer would
change the plan. Questions about the people come before the budget. Infer what can be inferred
(the budget from the hotel, the pace from kids or an older parent), and never ask for something
the story already says. Give tap-to-answer chips specific to this trip.

**A5 · Better offline reading.** When there's no model, the rules should still pull out dates
("24–26", "next weekend"), "staying at X", who's coming ("with my wife and kids"), and avoid
phrases ("not touristy", "no clubs"), rather than dropping them.

**A6 · Put anchors on the map straight away.** Resolve the hotel and other fixed places with
`resolvePlace` (as pasted itineraries do), drop them before any planning, and treat them as
fixed points.

## B. Knowing: places a local would pick, and facts that hold

**B1 · Search by vibe, and let the catalog grow.** Built cities come from Wikivoyage, which
skews to sights (Mumbai: 179 of 249 places are sights, 3 are bars). Add a vibe search
(`server/cities/vibeSearch.ts`): from the city, the story and the areas within reach, a web
search finds 20–40 places for *this* mood. Each is resolved on OpenStreetMap, described and
profiled with the existing code, and joins the city's catalog (`promoteFind`,
`found.via = 'vibe'`). Results are cached per city and mood. Every trip makes the catalog
better for the next traveller, which a chat assistant can't do.

**B2 · New kinds of place.** Today there are 8 kinds (sight, food, café, bar, park, museum,
market, viewpoint). Add `experience` (classes, boat trips, spas, shows, tours, workshops) and
`event` (dated, with start and end).

**B3 · What's on during their dates.** A dated search for gigs, exhibitions, festivals,
markets, matches and seasonal events in the city during their trip. Each event has a source and
dates, and is checked against the nights they're there.

**B4 · Richer facts on every place.**
- Opening hours (OpenStreetMap's `opening_hours` where it's present)
- Price in local money, instead of a 0–3 band
- `order`: what to get
- `sit`: where to sit
- `arrive`: when to get there
- `move`: the insider tip
- `heads_up`: what to know before going

**B5 · Vibe numbers on the profile.** Profiles already say who a place suits (15 audiences) and
how busy, lively, late and child-friendly it is. Add `romance`, `intimacy`, `view`, `dressy`,
`local` and `quiet`, so places can be matched to a mood and not only to a category.

**B6 · Never invent.** Any dated claim (an event, a festival, opening hours) needs a source, or
it isn't shown.

## C. Planning: real time and real place

**C1 · Real calendar time.** Dates become weekdays, and the planner respects closures, the
season and arrival and departure times. ("We land at 1 pm" means nothing before 2:30.)

**C2 · Sunset and daylight.** Compute sunrise and sunset from the coordinates and the date (no
API needed), and offer them as moments for viewpoints, rooftops, beaches and boats.

**C3 · Rush hour.** Give each city a traffic factor by hour, until there's a routing API, so
evening hops cost what they really cost.

**C4 · Time in transit as a number we protect.** Each day shows "time getting around: 35
min". The planner keeps it low, especially for evenings and slow-paced trips.

**C5 · Moments as goals.** The planner builds days around `moments` from the story ("a big
night out on day 2"), not only around the places that score best.

**C6 · Stories, not lists.** Each day gets a title and a one-line arc (`commit_day` gains
`title`). Each stop gets a `why` that ties back to something they said: "you said not
touristy, and locals queue here".

## D. Showing: delight they didn't ask for

**D1 · "You'd never think of this."** Each trip gets 5–8 cards beyond the request, drawn from
the story and the dates:
- something to do together
- a local ritual
- something seasonal that's true on their dates
- a small touch that makes a moment

They come as a swipe deck. What's kept goes into the plan and teaches the profiles
(`place_signals`).

**D2 · Reels on every suggestion.** Every card and stop shows a short clip, so people see the
vibe before they decide. The video feed already exists, so this is about putting it front and
centre.

**D3 · Easy swaps and comparing.** Every stop offers two one-tap swaps ("livelier", "quieter",
"cheaper") using the existing deck. *Compare* puts two places side by side, with reels and
facts.

**D4 · Surprise mode.** Any stop or day can be secret from chosen people in the group. They see
teasers instead ("4:30 pm · Surprise · comfy shoes, bring a jacket"), then a countdown, then the
reveal. The server strips secret stops from their copy of the plan, and hides the costs and
bookings that go with them. This works for birthdays, proposals and anniversaries, or a group
surprising one friend.

**D5 · A concierge that drafts, and the traveller sends.** For bookings and special requests,
it drafts the message to the venue, the note for the table or the request to the hotel. The
traveller sends it; Wayfarer never sends anything itself.

## E. Remembering: feel like home

**E1 · You, across trips.** The Profile becomes a memory:
- tastes they've stated, swiped and kept
- what they always remove
- the people they travel with, and what those people like

The next trip starts already knowing them: "Last time you loved the rooftops. Same energy?"

**E2 · A home screen about what's next.** Open the app to a countdown, the weather, and the one
thing worth doing today ("this place takes bookings two weeks out: book now?").

**E3 · There on the day.**
- "Leave now: 22 minutes there, sunset in 35."
- Running late re-times the rest of the day (the engine already does this).
- Rain swaps in something indoors.

These are sent as alerts, which already exist for documents.

**E4 · After the trip.** A recap made from the photo vault and the plan, kept private to the
group or shared.

---

## How we'll know it's working

A **vibe eval set** (`server/evals/vibe/`): 20 real first messages across occasions, groups,
budgets and cities. Each runs through the intake and the planner and is scored on:

| Measure | How |
|---|---|
| **Understood** | Every stated fact is in the story (checked against a hand-written answer). |
| **Fit** | A model judge checks the plan matches the mood and avoids what they said to avoid. |
| **Surprise** | Delight cards a judge rates as both fitting and non-obvious. |
| **Feasible** | *Computed:* time in transit per day, stops at closed places, sunset lined up. |
| **Actionable** | What needs booking is flagged, with how and when. |
| **True** | Dated claims have a source. |

Score Gemini's or ChatGPT's answers to the same messages alongside. Nothing ships that loses on
*Understood* or *Feasible*.

**North star:** the moment people feel understood comes in the first reply.

## Order of work

| Release | Updates | What people notice |
|---|---|---|
| **1 · Heard** ✅ | A1–A6, C3 | It catches everything they said and asks one good question. |
| **2 · Knows** | B1–B6, C1–C2, C4–C6 | Local places, real times, short hops, plans that read like a story. |
| **3 · Delights** | D1–D5 | Things they'd never have found, and surprises that stay secret. |
| **4 · Home** | E1–E4 | It remembers them, helps on the day, and makes the recap. |

### Release 1: what shipped

- **A1 · The brain works on OpenAI.** The intake, the planner (its tool loop) and the hotel pick run through `server/llm.ts`: Claude when there's an Anthropic key, OpenAI otherwise. The routes are limited per visitor (intake 120, plans 20, hotels 30 an hour) and to 3,000 calls a day in all (`WAYFARER_DAILY_MODEL_CALLS`).
- **A2 · The trip story** is `TripBrief.story`, in `src/planner/story.ts`.
- **A3 · "What I heard"** chips show in the chat. Tap a chip to correct it, or × to remove it.
- **A4 · One question.**
  - Offline, it asks about the person ("What's your girlfriend into?") before the budget, and skips the budget when the hotel is known.
  - A model picks its own question and sends chips with it.
- **A5 · Offline reading** covers dates, where they're staying, arrival and leaving times, who's coming, the occasion, moments and avoid-lists.
- **A6 · The hotel** is pinned from the first message and becomes the base.
- **C3 · Rush hour** slows hops at peak times, by city. Day 1 also starts after they arrive.
- **Not yet:**
  - the read-back's "map truth" line (how far things are from the hotel at rush hour)
  - honouring the leaving time on the last day, except where the model planner is told it

## Decisions needed

1. **Which model:** settled. OpenAI runs everything when there's no Anthropic key, with
   per-visitor limits and a daily cap.
2. **Place data:** either web search plus OpenStreetMap (cheap and it builds up, but patchy on
   opening hours), or add Google Places as well (better hours, ratings and photos, but paid,
   with limits on caching). Recommendation: start without Google Places, and add it if the
   evals show closures hurting.
3. **Surprise mode rules:** whether teasers can be turned off, and who a secret stop's cost is
   hidden from.
4. **The 5-day cap:** keep it, or lift it along with real dates.
