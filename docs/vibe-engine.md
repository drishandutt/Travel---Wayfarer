# The Vibe Engine: Wayfarer that understands you

_Status: plan · 2026-11-11_

People should come to Wayfarer because it gets them. It should catch the mood in one message,
show them things they'd never have thought of, and feel as easy as being at home. This note
looks at what Gemini did with one real request, where Wayfarer stands today, and how we beat it
with what only Wayfarer has.

---

## 1. The benchmark: what Gemini did

The request (one message):

> 24, 25, 26 I am going to Mumbai with my girlfriend, 24th I wanna plan a crazy date night with
> my girlfriend and surprise her as well, I am staying at Sun N Sands Hotel, tell me fun things
> to do and plan the whole trip, we are not looking for touristy vibes but a romantic trip.

**Why it felt like magic**

1. **It heard everything in one go:** the dates, who's going, the hotel, the date night on the
   24th, the surprise, and "not touristy". It used all of them on its first reply.
2. **It began from where they're staying:** "Sun-n-Sand puts you right on Juhu Beach".
3. **It told a story.** Days had titles ("The Grand Romantic Surprise"), and each stop had a
   mood, what to order and how it would feel.
4. **It got practical when asked:** where charters leave from, who to book with, the cost, and
   even the WhatsApp message to send ("text ONLY me") so the surprise stays secret.
5. **It changed course easily.** "Don't wanna do yacht, something more fun" got a new Day 1
   with a different energy.
6. **It showed real places:** photos, ratings, prices and opening hours from Google Maps.

**Where Gemini let them down (our openings)**

- **The routes don't work.** Day 1 goes Juhu → Gateway of India → back to Juhu for dinner →
  Dadar at 10:15 pm, which is three or four hours in Mumbai traffic on a date night. It has no
  sense of the map.
- **Wrong facts about the dates.** It lists the "Kala Ghoda Art Festival", which runs in
  February. They're going in November.
- **Lazy filler.** Every price is "₹2,000". Olive shows up in both versions of the plan. A
  "quiet afternoon near the turf club" is padding.
- **It never asked about her.** The whole trip is for someone it knows nothing about.
- **It forgets everything.** Each change rewrote the day from scratch. No memory carries over
  to the next trip, nothing is shared with her, and nothing is booked, tracked or kept.
- **It stops at the plan.** It isn't there on the day, can't keep the secret from her, and
  won't make the memories afterwards.

We don't win by writing prettier paragraphs than Gemini. We win by being right about time and
place, by remembering, and by being there before, during and after the trip.

---

## 2. Where Wayfarer is today (honestly)

I sent the same message to the live intake (`converse`, which production uses):

> **Got it: 2 people, romantic. I've got maps for Tokyo, Lisbon, London ready, and can build
> most cities. Which city sounds good?**

It kept "2 people, romantic". It lost Mumbai (the browser's city lookup recovers it later),
the dates, the hotel, the date night, the surprise and "not touristy".

Why:

| Gap | Today |
|---|---|
| **The brain is off** | `/api/health` → `claude: false`. Production runs the offline regex intake and planner. Everything below needs this fixed first. |
| **The brief is a form** | `TripBrief` holds destination, days, travellers, vibes, budget and pace, plus sliders. There is nowhere to put an occasion, a person, a hotel, an arrival time, a moment or a "not this". The questions run in a fixed order: destination, days, who, vibe, budget. |
| **The catalog is a guidebook** | Mumbai has 249 places: 179 sights, 21 food, 7 cafés, 3 bars. None of Gemini's picks (Cecconi's, Subko, AER, Olive, Bastian, Bonobo, Gadda Da Vida, Dome) is in it. Wikivoyage *is* the tourist list, which is exactly what this traveller didn't want. |
| **Places can't be experiences** | There are 8 kinds (sight, food, café, bar, park, museum, market, viewpoint). A boat, a class, a show, a spa or an event has nowhere to go. |
| **Plans are pins, not stories** | Stops have a blurb, but nothing says why they're right *for you*, what to order, when to arrive, or the insider move. |
| **No sense of time** | No real dates or weekdays, no sunset, no opening hours, no rush hour. Travel time is a distance guess. |

## 3. What we have that Gemini can't have

| Wayfarer has | Why it matters |
|---|---|
| **A map that thinks** (`core.ts`: clustering, `orderDay`, `rebalanceDays`) | We can promise *"under 40 minutes in a car all evening"*. Gemini can't. |
| **A catalog that compounds** (`promoteFind`, profiles, `place_signals`) | Every traveller who asks for "romantic, not touristy Mumbai" makes it better for the next. Gemini starts from zero every time. |
| **Groups with roles** | The partner can be on the trip and *still be surprised* (see Surprise mode). |
| **Documents, Money, Photos** | Bookings, costs and memories live in the trip. The plan becomes the actual trip, not a chat transcript. |
| **Reels and videos for every place** | They *see* the vibe in a 10-second clip, not a stock photo. |
| **The swipe deck and learned profiles** | Taste is learned from what people keep, not guessed from adjectives. |
| **Alerts, the iPhone app, the share sheet, MCP** | We're there on the day, in their pocket, and inside Claude too. |

---

## 4. The target: the first reply

Here's what Wayfarer should say to that exact message, in one reply. The details are
illustrative.

> **Mumbai, Tue 24 – Thu 26 Nov, the two of you, based at Sun-n-Sand on Juhu Beach.** The 24th
> is the big one: a surprise date night she won't see coming. No tourist circuit.
>
> `📍 Mumbai` `🗓 24–26 Nov` `💑 You + her` `🏨 Sun-n-Sand, Juhu` `✨ 24th: surprise night` `🚫 touristy` `❤️ romantic · fun`
>
> One thing to know: South Mumbai is 75–100 minutes from Juhu in evening traffic, so I'll keep
> the 24th in Juhu, Bandra and Worli and put the time into the night, not the car. Sunset's
> around 6, so the big moment goes there.
>
> **One question that changes everything: what's she into?** `Food & cocktails` `Art & music`
> `Adventure` `Slow & cosy`, or tell me about her.

Meanwhile, on the map, the hotel pin drops on Juhu, a shaded ring shows what's within 40
minutes at 7 pm, and three teaser pins pulse inside it.

After the answer, the plan arrives as **chapters** ("Day 1 · The Surprise") with a sunset
moment, under 40 minutes of driving all evening, a **"You'd never think of this"** card, and a
**Surprise mode** switch.

---

## 5. The plan: seven pillars

### P0 · Turn the brain on
- Put `ANTHROPIC_API_KEY` on Railway, *after* per-visitor and per-day spend caps on
  `/api/intake`, `/api/plan`, `/api/hotels` and `/api/agent` (as ARCHITECTURE.md already says).
- Keep the offline planner as the fallback, but stop the offline intake from throwing things
  away: pull out dates ("24, 25, 26", "24th–26th Nov"), "staying at X", "with my
  girlfriend/wife/parents", and "not touristy" with rules.
- **Done when:** the Mumbai message gives a read-back that captures all seven things it said.

### P1 · The Read: understand the person, not fill a form
- **A trip story on the brief** (`TripBrief.story`), filled by the intake's structured output:
  - `occasion`: date, anniversary, birthday, honeymoon, proposal, reunion, work + play…
  - `people`: each traveller's relation and what's known ("her: loves coffee, not seafood")
  - `anchors`: stay, arrival, departure, fixed bookings, with times
  - `moments`: things they want to happen ("24th night: surprise, crazy, fun")
  - `register`: the feel, as words and numbers (romance, energy, intimacy, local vs famous,
    dressy vs casual)
  - `avoid`: "touristy", "clubs", "long drives"
  - `dates`: real dates, from which days, weekdays and the season follow
- **A read-back card** in the chat (`ReadBack.tsx`): editable chips of what we heard. Tapping
  one corrects it. This is the moment people feel understood.
- **Ask what a friend would ask:** at most one question a turn, picked by how much the answer
  would change the plan. Ask about *her* before the budget. Infer the budget from the hotel.
  Never re-ask what the story already says.
- **Anchors on the map at once:** resolve the hotel with `resolvePlace` (the same path pasted
  itineraries use) and make it the base before any planning.
- **Files:** `server/intake.ts` (schema and prompt), `src/types.ts`, `src/planner/intake.ts`
  (offline extraction), `ChatPanel.tsx`, `planAgent.ts` (the story goes in the prompt).
- **Done when:** on 20 test messages, every stated fact lands in the story and no question
  asks for something already said.

### P2 · The long tail: find the places a local would
- **Vibe search** (`server/cities/vibeSearch.ts`): given the city, the story and the areas
  within reach, Claude's web search (as reels already use it) finds 20–40 candidates for
  *this* mood: "romantic, not touristy, rooftop at sunset, Juhu/Bandra/Worli". Each is
  resolved on OpenStreetMap (`resolvePlace`), described and profiled (existing), and joins the
  city's catalog (`promoteFind`, `found.via = 'vibe'`). Results are cached per city and mood.
  **The catalog grows with every trip.**
- **New kinds:** `experience` (classes, boats, spas, shows, workshops) and `event` (dated, from
  a search for what's on during their dates).
- **Richer facts on each place:** opening hours (OpenStreetMap's `opening_hours` where present),
  price in local money, `order` (what to get), `sit` (where), `arrive` (when), and `move` (the
  insider tip).
- **Vibe numbers on the profile** besides audiences: `romance`, `intimacy`, `view`, `dressy`,
  `local` (and the existing `lively` and `late`), so we match moods, not just categories.
- **Done when:** "romantic, not touristy" Mumbai plans use at most 1 must-see sight, and the
  Gemini set (or better) is in the catalog.

### P3 · The story plan: a plan that reads like a friend wrote it, and runs like a timetable
- **Chapters:** `commit_day` takes a `title` and a one-line arc. Each stop gets `why` (tied to
  something they said: "you said not touristy: locals queue here, tourists don't know it"),
  `move`, and `heads_up`.
- **Time is real:**
  - Dates become weekdays, and closures are respected.
  - **Sunset** is computed from the coordinates and the date (no API) and offered as a moment.
  - **Rush hour:** each city gets a traffic factor by hour (Mumbai evenings around ×1.8) until
    there's a routing API.
  - Arrival times hold ("we land at 1 pm" → nothing before 2:30).
- **The anti-Gemini number:** each day shows *"time in a car: 35 min"*, and the planner keeps it
  low for a date night.
- **Two easy swaps on every stop** ("more fun", "quieter", "cheaper") using the existing deck,
  and **Compare** (two places side by side, with reels) for moments like "AER or Bastian?".
- **Done when:** no Mumbai date-night plan has more than 60 minutes of driving in an evening,
  and nothing is planned when it's closed.

### P4 · Surprise mode (only Wayfarer can do this)
- Any stop or day can be **secret**. The partner joins the trip and sees **teasers**: "4:30 pm
  · Surprise · Wear comfy shoes, bring a light jacket, eat light at lunch". They also get a
  countdown, then the reveal at the moment (or when the planner taps *Reveal*).
- **Enforced on the server:** the plan endpoint strips secret stops for anyone who isn't in on
  it. Expenses on a secret stop are hidden from them in Money, and bookings for it are private
  in the vault.
- **The concierge drafts and the traveller sends:** the message to the venue ("this is a
  surprise, contact only me"), the cake or flowers request, the playlist. These are drafts
  they send themselves, never sent by us.
- **Alerts:** "Leave by 4:40 to catch sunset" goes only to the planner.
- **Done when:** the partner's device can't get a secret stop from any endpoint (with a test).

### P5 · "You'd never think of this": the delight layer
- Each trip gets **5–8 cards beyond the request**, from the story: something for two (a class, a
  workshop), a dawn ritual locals love, a seasonal thing true *on their dates*, a small touch
  (a note waiting at dinner, a print of the night's photo). Each card has a reel, so they *see*
  it before they say yes.
- **Events on their dates:** gigs, comedy, gallery openings and markets, from a dated search,
  checked against their nights.
- They come as a deck: swipe to add. What they keep teaches the profile (`place_signals`).
- **Never invented:** every card is a real place or a dated, sourced event, or it doesn't show.
- **Done when:** in testing, people keep at least 2 delight cards per trip.

### P6 · Home: comfort, memory and being there
- **Wayfarer remembers you** (the Profile becomes "You"): tastes stated, swiped and kept across
  trips, the people you travel with and what they love, and what you always remove ("no
  clubs"). The next trip starts already knowing you: "Last time you loved the rooftops. Same
  energy?"
- **The home screen shows what's next:** "13 days to Mumbai · sunset on the 24th at 5:59 ·
  Olive takes bookings now. Hold a table?"
- **On the day:** "Leave now: 22 minutes to AER, sunset in 35". Running late re-times the day
  (the engine already does this), and rain swaps in something indoors.
- **After the trip:** a recap from the photo vault and the plan ("Our Mumbai"), private to the
  two of them, or shared.
- **Done when:** a second trip's first reply uses something learned on the first.

---

## 6. How we'll know we're winning

A **vibe eval set** (`server/evals/vibe/`): 20 real first messages across cities, occasions and
groups, with this Mumbai message first. Each runs through the intake and the planner, and each
plan is scored on:

| Measure | How |
|---|---|
| **Understood** | Each stated fact captured (checked against a hand-written answer) |
| **Fit** | Model judge: does the plan match the mood and avoid what they said to avoid? |
| **Surprise** | Delight cards a judge rates both fitting and non-obvious |
| **Feasible** | *Computed:* minutes in a car per evening, stops at closed places, sunset lined up |
| **Actionable** | Bookings flagged, with how and when |
| **True** | Dated claims (events, festivals, hours) have a source |

Paste Gemini's answer for the same message alongside and score both. Nothing ships that loses
to it on *Understood* or *Feasible*.

**North star:** the moment people go "wow" comes in one message, not three.

---

## 7. Order of work

| Release | Pillars | What people notice |
|---|---|---|
| **1 · The first reply** | P0, P1, and the map-truth line from P3 | "It got everything I said, and it knows Mumbai traffic." |
| **2 · The plan** | P2, P3 | Local places, chapters, sunset moments, short drives. |
| **3 · The moment** | P4, P5 | The surprise works, and things they'd never have found. |
| **4 · Home** | P6 | It remembers them, it's there on the day, and the recap afterwards. |

Each release goes through the eval set first.

## 8. Decisions needed

1. **Claude in production:** a monthly spend cap and per-visitor limits, then the key goes on.
   Without it, none of this works.
2. **Place data:** Claude web search plus OpenStreetMap (cheap, compounds, patchy hours), or add
   Google Places (hours, ratings, photos and price levels, but paid, with limits on how long its
   data may be cached). Recommendation: start without it, and add it for hours if the evals show
   closures hurting.
3. **Surprise mode's reach:** whether teasers can be turned off, and whether a secret stop's
   cost is hidden from everyone or only from the person being surprised.
4. **The 5-day cap:** keep it for now, or lift it alongside real dates.
