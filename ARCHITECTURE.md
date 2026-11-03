# Wayfarer — architecture

An AI trip planner whose main surface is a map. You describe a trip in chat, and the planner *thinks on the map*: it drops pins, keeps or drops them, threads them into days with travel and buffer time, then finds the hotel that keeps every day close.

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY to plan with Claude
npm run dev            # web on http://localhost:5173, API on :8787
```

Without a key the app runs fully offline on the heuristic planner; the top bar shows which brain is active (**Claude Opus 5.5** or **Offline planner**).

---

## The core idea: the planner is an event stream

The UI never calls "give me an itinerary" and waits. The planner **streams events**, and the UI is a pure reducer over them. That one decision is what makes the map feel alive, and it is also what lets the brain move from local mock to server/LLM without touching the UI.

```
  Chat ──► Intake (brief extraction) ──► TripBrief
                                            │
                                            ▼
                     PlannerEngine.planItinerary(brief)  ──►  PlannerEvent stream
                     PlannerEngine.findHotels(brief, days) ─►  PlannerEvent stream
                                            │
                                            ▼
                         tripStore reducer (state machine)
                                            │
              ┌──────────────┬──────────────┼───────────────┬──────────────┐
              ▼              ▼              ▼               ▼              ▼
          MapCanvas    ThinkingStream  ItineraryPanel   HotelPanel      TopBar
       (pins, arcs,    (live log)      (day timeline)   (scored bases)  (brief chips,
        camera, scan)                                                     phase stepper)
```

### Event vocabulary (`src/types.ts → PlannerEvent`)

| Event | What the UI does |
|---|---|
| `thought` | Appends a line to the live "thinking" log |
| `camera` | `flyTo` the map (the planner directs the camera) |
| `scan` | Radar pulse at a point ("looking around here") |
| `candidate` | Pin appears (`consider`), then turns amber (`keep`) or fades (`drop`) |
| `leg` | A route arc animates between two stops |
| `day` | A finished day is added to the itinerary |
| `plan-ready` | Phase → `review`; the approve button appears |
| `hotel-candidate` | A hotel pin and scored card appear |
| `hotel-pick` | The chosen base gets dashed commute legs into every day |
| `error` | Warning in the log; the UI falls back to the last stable phase |

### Trip lifecycle (`src/state/tripStore.ts`)

`intake → swipe → planning → review → hotels → final`

- **intake**: chat fills a `TripBrief` (where, days, who, vibe, budget, pace). The brief chips in the top bar light up as fields are understood.
- **swipe**: a deck of photo cards (best vibe match first). Swipe right to keep, left to skip (drag, buttons, or ← →; Backspace undoes). The map glides to each card's spot, and kept places light up amber. `src/components/SwipeDeck.tsx`.
- **planning**: `planItinerary(brief, signal, picks)` streams. Both side panels tuck away so the routes get the whole map, and their edge tabs bring them back. With picks it plans exactly the kept places, keeps neighbourhoods together even if days end up uneven, and only suggests unseen places (never skipped ones) to fill long idle gaps. Places are scored, the keepers are clustered into one neighbourhood per day, then each day is ordered by time-of-day and walking distance.
- **review**: the user inspects days (clicking a day tab focuses the map on it) and approves.
- **hotels**: `findHotels` scores each hotel on commute to every day's first and last stop (50%), budget fit (30%) and vibe (20%).
- **final**: the chosen hotel is wired in as the start and end of each day. Other hotels stay clickable to compare.

---

## Live editing: change anything, any time

Once a plan exists, nothing ever needs a restart. Every chat message becomes a live edit (`src/planner/edits.ts`):

1. The message is split into clauses ("swap Skytree for something cheaper **and** add a day, **then** start later").
2. Each clause is matched to an operation on a draft of the plan, place-specific operations first: change days, start times, pace, tidy, swap, move, first/last, hotel, travellers, budget, more or less of a category, remove, add.
3. The draft is re-timed into a new itinerary in one pass with the same rules the planner uses. The hotel is kept or re-picked, and pins, routes and costs update. Only the routes that changed redraw on the map.
4. The reply lists exactly what changed, plus anything that couldn't be done and why. Changed days glow in the itinerary, and the map flies to them.

Big changes are handled the same way. "Add a day" regroups by neighbourhood and fills the new day. "Make it 2 days" says what it left out. "Actually, let's do Lisbon" moves the whole trip, keeping days, vibe and budget. Removed places are remembered, so later edits never bring them back unless you ask.

**Not sure? Browse instead of deciding.** Requests that signal uncertainty or a wish to try things ("not sure", "show me options", "what else is near Golden Gai", "I wanna try something else near my Day 2 places") open a mini swipe deck instead of changing the plan (`planDeckRequest`). The deck follows the request: near a day or place, a category, cheaper. It shows only places not already planned and never ones you rejected. Routes stay on the map while you swipe. On finish (`applyDeckPicks`), the first keep replaces the place you wanted gone in its own day, and other keeps go to the day they're closest to, or to a day you named. Cancel, or keeping nothing, leaves the plan untouched. Decisive phrasings ("remove X and get something near day 2", "swap X for something near Golden Gai") swap directly, and a swap never empties a day.

**Questions & tastes.** Places carry cuisine/style `keywords` (tempura, sushi, izakaya, street food, pastry, traditional…). Questions and preferences ("some good places to eat? I like traditional Japanese food", "craving ramen", "any good sushi near day 2?", "where should we eat tonight?") open a matching deck: places with those keywords first, near a day or place if one is named, evening spots for "tonight". The reply names matching places already on the plan. Stated tastes are remembered on the trip (`brief.tastes`) and lift matching places in every later suggestion; the first chat picks them up too. A message that isn't an edit but names a food, style or kind of place is tried as a deck before falling back to the help text. Direct instructions ("I want to add a day", "add more food") are still applied as edits.

Every edit, from chat or from buttons, goes on an **undo stack** (↺ in the panel footer, or type "undo"). Requests typed while a plan is still drawing are queued and applied the moment it's ready.

The interpreter is rule-based and offline. It is the seam for an LLM with edit tools later: same input (request + plan), same output (`EditResult`).

---

## Editing & saving trips

Once a plan exists, every part of it is editable, and edits use the same timing rules as the planner (`src/planner/core.ts`):

- **Click any pin** → a place card. Unplanned places get *Add to Day N* (inserted where it adds the least walking and respects time of day). Planned ones get *Move to Day N* and *Remove*.
- **Itinerary rows**: ↑ ↓ to reorder, ✕ to remove, *Tidy route* re-orders a day by time of day and distance.
- **Free time**: the planner fills idle stretches of 90 min or more with something nearby. *+ suggest a stop* on any free-time block searches further afield on demand.
- **Photos**: every pin's card and journey stop shows real photos from Wikipedia and Wikimedia Commons (free, no key; `src/services/photos.ts`). Stops show the first photo and look it up only as they near the view. Places whose lookup leads with a weak picture get a hand-picked first photo from `src/data/placeCovers.ts`. If a nearby Wikipedia article matches the place name both ways (rejecting stations, and whole districts for restaurants and bars), its lead image is labelled **This place**. Otherwise the card shows freely licensed photos taken near the pin, labelled **Nearby**. Each photo links to its source with the author and licence. Demo hotels are placeholders, so their cards show only **The neighbourhood**: a hand-picked cover from `src/data/hotelPhotos.ts`, which also tops each hotel card in the panel, then photos near the pin. Avenida Palace is the one real hotel, so its cover is labelled as the hotel itself.
- **Reels & videos**: scroll down any place's pin card or swipe tile for Instagram reels, YouTube videos and Shorts, and TikToks of that place, filterable by platform, each with a link out to its source (`src/components/SocialVideos.tsx`). They play in each platform's own embed player. YouTube shows a poster and loads its player on tap; reels and TikToks load as they scroll into view. On a tile, sideways stays a swipe and up and down scrolls, and tiles waiting in the deck load nothing. Demo hotels are placeholders, so their cards have no feed.
- **Route hover**: hovering any line on the map shows photos of both ends, from → to, distance, and every sensible way to make the hop (walk / transit / taxi) with time and an estimated group cost, best option marked. Fares come from a rough per-city model (`City.transport`). The itinerary chips show the same best option and cost.
- **Saving**: the trip in progress autosaves to the browser and reopens after a refresh. *Save trip* adds it to **My trips** (top bar), where saved trips can be reopened or deleted. Storage is `localStorage` via `src/state/persistence.ts`, a small load/save/delete seam to swap for a real backend later.

---

## Trip dashboard

**Save trip** opens a dashboard of the trip (`src/components/Dashboard.tsx`). It can also be opened from 📊 in the itinerary panel, and a finished trip opened from My trips lands on it. Everything is derived from the live plan by pure functions in `src/planner/insights.ts`, so it always matches the map:

- **Hero & dates:** city cover photo, travellers and vibe, an editable start date with a countdown, and a live clock showing local time and the time difference.
- **Weather** (`src/services/weather.ts`, Open-Meteo, free): the live forecast when the trip is within 16 days, otherwise the same dates last year, labelled as such.
- **Estimated cost:** stay, food & drink, tickets, getting around, and an ~8% buffer, compared against the budget, per person and per day, with a local-currency figure. The categories use a validated colour palette, every amount is also shown as text, and hovering a segment shows its share.
- **Trip in numbers:** places, km on foot, hours in transit, free time, food stops, and the day's span.
- **Day by day:** a route sketch per day (stops fitted, a distant base pinned to the edge in its real direction), times, and booking badges.
- **Book ahead** and a **packing list** generated from the weather, the plan and the city. Ticks are remembered per trip.
- **Local know-how** (`City.essentials`): money, plugs, tipping, transit card, water, emergency numbers, etiquette and phrases.
- **Export:** calendar (.ics, one event per stop in the city's time zone), print/PDF (print stylesheet), and copy as text.

Saved trips refresh their places from current city data when reopened, so details added later, such as booking notes, show up on old trips.

---

## Phones

At 760px and below (`useIsMobile`) the layout switches to mobile-first (`src/components/MobileSheet.tsx`, `src/mobile.css`):

- **Full-screen map + one bottom sheet** with **Chat** and **Plan** tabs (Live / Itinerary / Base camp). Drag the handle or flick between peek, half and full; tap a tab to switch or grow it. The sheet follows the journey: chat at half while briefing, peek while the routes draw, the plan at half once it's ready, full while typing, and peek when a pin's card opens.
- **The swipe deck takes the screen**, with thumb-sized buttons and a sticky "Map my picks" / "Add N to my trip" bar.
- **Touch-first details.** Tap a route for its time and cost popup, and tap the map to close it. Stop tools sit on their own row, since there's no hover. Pin cards open as a full-width sheet. Inputs use a 16px font so iOS doesn't zoom. Tap targets are about 40–48px, and the notch and home-bar safe areas are respected.
- **The map frames things above the sheet.** Insets include the sheet's height, so day focus and edits land in the visible area.
- **Compact top bar:** brand, My trips, and "4/6 Review" instead of the full stepper.
- **Dashboard:** cards stack, while weather and day cards swipe sideways.

Tested at 375×812 and 320×568, with no sideways scrolling.

---

## Planning together

Everyone signs in first, with just an email (see [Accounts](#money-shared-expenses)). A trip can then be shared with a group, which has one **admin** and any number of normal users.

**Bringing people in.** Once the planner knows friends are coming and has its answers, the chat offers to bring them in. The admin adds emails or shares a link (`InviteFriends.tsx`). Anyone already signed up sees the trip right away; anyone else is asked to sign up, then they're straight in. Adding an email gives access immediately and opens the admin's own email app with the invite written, since the app has no email service of its own. Someone added while doing something else gets a nudge, or goes straight to the trip if they've nothing else on screen.

**One plan, one writer.** The admin's browser runs the planner, as it always has, and publishes each version of the plan to the server about once a second (`src/trip/useSharedTrip.ts`, `PUT /groups/:id/plan`). Everyone else receives it live: the same SSE stream as Money says the version moved, and the client fetches through a permission-checked endpoint. Each open trip gets its own connection in that hook, so nothing still on its way from the last trip can land on the next one. Nothing is published until the server has answered, and only a change someone actually made goes out: the reducer records what the server holds (`shared.synced`), so a reload or a switch of trips publishes nothing. A publish carries the version its copy was built on, and the server checks it inside the write, so a device with an old copy is told instead of undoing newer work. Because the planner runs in the admin's tab, friends see "mapping" until it finishes. A tab closed while mapping or looking for hotels carries on from what was finished when it's reopened, and the group is moved on with it. A group from before plans were shared picks up from the copy in the admin's browser, and a group with nothing in it yet publishes nothing.

**Voting.** Everyone gets the same tiles (`sharedDeck`) and swipes like or skip; votes are stored per person and queue offline. Reopening the deck shows only what you haven't decided, so a vote only changes when you mean it to. Votes can also be cast from any place's card, at any time. The admin sees places ranked by likes minus dislikes (`src/trip/votes.ts`), with what at least as many liked as disliked ticked, up to what fits the trip. They can change any of them before mapping: the group advises, the admin decides. Places the group turned down are never suggested to fill a gap.

**What each person can do.**

| | Admin | Normal user |
|---|---|---|
| See the map, itinerary, hotels, dashboard | ✓ | ✓ |
| Vote on places, post in the trip chat | ✓ | ✓ |
| Add, edit and delete spending, settle up (Money) | ✓ | ✓ |
| Change their own name, personal budget, leave | ✓ | ✓ |
| Change the plan, hotel or dates; chat to the planner | ✓ | |
| Add or remove people, see the invite link | ✓ | |
| Group name, currency, budget, simplify debts, delete | ✓ | |

The server enforces this (`assertAdmin` in `server/money/store.ts`). On screen, the reducer ignores plan edits from a normal user (`ADMIN_ONLY` in `tripStore.ts`) and the controls are hidden. If the admin leaves, the next person with an account takes over.

**Trip chat.** Normal users' messages go to the group, not the planner. The admin chooses *To the planner* or *To the group*, and can try a friend's suggestion on the plan with one tap. Voting takes over the whole screen, so the chat opens over the deck from its header (`GroupChat.tsx`). Votes and messages wait in a queue until they're delivered: a place that isn't up for a vote yet is retried for a while without holding up the others, and signing out warns about anything still waiting.

**Releasing a seat.** Releasing someone's seat also changes the invite link and clears their votes, so they can't come back on another seat and vote twice. The new link is what claims the released seat.

**Trips and people on one device.** Trips kept in the browser are stored per account (`setTripScope`), and anything saved before accounts existed goes to the first person to sign in. Viewing someone else's trip never overwrites your own trip in progress: it's there when you go back. *My trips* lists both.

---

## Money: shared expenses

**Money** in the top bar opens a Splitwise-style tracker for the trip: who spent what, who owes whom, and how much is left. It's the one part of the app that is shared between people, so unlike everything else it has a server-side source of truth (`server/money/`).

**Groups and people.** A group has one currency that balances are kept in. Access is per person, by email. Add someone's email and they can be in splits straight away: if the address has an account they're in at once, and otherwise the seat waits and becomes theirs the moment they sign in with it, history intact and no link needed. A waiting seat can only go to that address, and can be corrected if it was mistyped. There are two looser ways in too: you can add someone by name only, and an invite link (`/?join=<token>`, resettable by the owner) lets anyone join or claim a name-only seat. Full addresses are never shown to other members, because typing one is all it takes to sign in as that person: waiting seats show a masked form (`be•••@gmail.com`). Nobody can leave or be removed with a non-zero balance. Removing someone also resets the invite link, since every member can see it and they could otherwise walk straight back in. If the owner leaves, the next person with an account takes over. If correcting an old expense puts someone who left back in the red, that balance can still be settled, so the people on the other side of it can still reach zero.

**Rate limits and IP addresses.** Limits per visitor read Railway's `X-Real-IP`, and sending a fake one doesn't get around them. Forum reports say that header has at times held a CDN address, which would make visitors share a limit; that hasn't been checked with real separate visitors. The limit on guessing a password goes by email address, so it doesn't depend on this.

**Accounts.** Your email is your account: type it on any device and you're in, staying signed in with a year-long `HttpOnly` cookie. By design nothing is verified, so joining a trip takes seconds and no email provider is needed. The trade-off is real: an address isn't proof of who someone is, so anyone who knows it can sign in as that person, see their private expenses, and even set a password that locks them out. The account screen says so and offers an optional password, which then becomes required for that address. There's no email sending, so a forgotten password can't be reset; the group owner can *Release* the seat, which puts it back to unclaimed for another account to take through the group's new invite link. Private expenses follow the account, not the seat: whoever takes a released seat gets its shared history and nothing private. Passwords use scrypt, session tokens are stored hashed, and sign-ins and new accounts are rate limited. Everything cached in the browser belongs to one account (`claimLocal`): if a different person signs in on the same device, it's wiped first.

**Splitting.** `src/money/engine.ts` is pure, integer-only and shared by the browser and the server, so a live preview can't disagree with what gets stored. Amounts are integers in the currency's minor unit, so there's no float drift. Two rules always hold: an expense's shares add up to exactly its amount, and a group's balances add up to exactly zero.

| Method | How it works |
|---|---|
| Equally | Everyone ticked pays the same |
| Exact | Enter what each person owes; must add up to the total |
| Percent | Must add up to 100%, to two decimals |
| Shares | Weighted, including fractions: a couple on 2, a solo traveller on 1 |
| Adjust | Equal split of what's left after the adjustments, each adjustment on top |
| Items | Each line split between whoever had it; the rest (tax, tip, or a discount) is shared in proportion |

A leftover cent goes by largest remainder, with ties broken by a hash of the expense and person: stable for one expense, different between expenses, so it doesn't always land on the same person. Several people can pay for one expense.

**Who owes whom.** *Simplify debts* (per group, on by default) gives the fewest possible payments: it finds people whose balances cancel out among themselves, then settles each cluster greedily. That search is exponential, so past 14 unsettled people it falls back to one greedy pass. Off, `pairwiseDebts` keeps who actually owes whom. Both reproduce the net balances to the cent, which a randomized test checks.

**Foreign currency.** Each expense can be in any currency, at a rate locked when it's saved and editable to match a card statement. The group-currency amounts are allocated rather than converted person by person, so they still add up after rounding. Rates come from ExchangeRate-API, then the ECB through Frankfurter, cached per day (`server/money/fx.ts`). With neither reachable it serves the last known rates, marked stale, and the form accepts a typed rate.

**Live updates.** Each group has an SSE stream (`/groups/:id/live`) that carries only version numbers. On any change, clients refetch through the normal endpoint, so every read passes the same permission checks. While the stream is down the client polls, and it checks in again whenever the app returns to the foreground. Other people's changes show as toasts.

**Offline.** Signal on a trip is patchy, so changes go into a queue in `localStorage` first (`src/money/outbox.ts`), and the same engine works out their effect, so balances are right immediately. Ops carry client-made ids, so retrying after a lost reply can't double-apply. A later change folds into an earlier one only if that one has never been sent: once a request has gone out it may be on the server even with no reply, so folding would lose the change, and it queues behind instead. A confirmed op stays on screen until a fresh copy of the group arrives, so nothing vanishes if that fetch fails. Queues for groups that aren't open get sent too (`drainClosedGroups`). Edits carry the revision they started from, fixed when the form opens: if someone else changed the expense first, an open form says so and blocks saving, and a queued edit gets a 409 and the person is told it didn't go through, rather than either edit silently vanishing. Sign-in, group settings and receipts need a connection.

**What people get beyond splitting.** Budgets (personal, visible only to you; and group) with an amount left per remaining trip day. *Just for me* expenses, which count in your spending and are invisible to everyone else. Spending by category, day and person. Planned vs actual against the planner's estimate, once a group is connected to a trip. Comments, receipt photos (shrunk in the browser, type-checked by their bytes on the server), per-expense history, an activity feed, delete with restore, search, reminders, and spreadsheet export (with formula injection neutralized). On any stop in the plan, *Log what you spent here* opens the form filled in.

**Settling up records payments, it doesn't make them.** Wayfarer keeps the books. When the recipient has added a UPI ID and the amount is in rupees, a button opens the payer's UPI app with it filled in; otherwise the handle is shown to copy.

**Storage.** Postgres. Production uses the Supabase project `Wayfarer` (`nqzmjhupkbbeasngchqt`, eu-west-1) through `DATABASE_URL`. With no URL, `npm run dev` and the tests run a real Postgres inside the process (PGlite): dev keeps its files in `./data/pg`, and each test file gets a fresh one in memory. `server/money/db.ts` runs numbered migrations at startup and tracks them in `wayfarer_meta`. Queries are written with `?`, and `db.ts` numbers them. Every write in `store.ts` runs as one transaction, its checks included, and transactions run one at a time in the process, as they did under SQLite. Independent reads go out in parallel, because each one is a network hop. The tables are in Supabase's `public` schema with row security on and no policies, and Supabase's API roles have no grants on them, so only this server can read them. The stream hub and rate limits are in memory, so this design is for one server: running several would need a shared pub/sub, and the in-process transaction queue would have to become row locks.

**Moving from SQLite.** Until 2026-11, the data was in one SQLite file on a Railway volume. `server/money/importSqlite.ts` copies it across once, when `WAYFARER_IMPORT_SQLITE` names the file. It runs only into a database with no accounts yet, checks that every table's row count matches, and records that it ran in `wayfarer_meta`, so later starts skip it. The old file isn't changed, so it stays as a backup.

**Production needs `DATABASE_URL`.** Without it, the money API refuses to run (503, and the screen says so) rather than keep balances somewhere a redeploy would wipe. If the database can't be reached, the rest of the site stays up and the connection is tried again on the next request. The money API is routed before the Claude key check in `server/index.ts`, since it has nothing to do with Claude and the live service has no key. Use Supabase's session pooler string: the direct host is IPv6 only. The old volume, `wayfarer-volume` at `/data`, still holds the SQLite file the data was copied from.

Not built yet: push and email notifications (reminders and changes only show when someone opens the app), and repeating expenses, which matter little on a trip of up to 5 days.

Tests: `npm test`. `server/money/engine.test.ts` covers the maths, `outbox.test.ts` the offline queue, and `api.test.ts` runs the whole API over HTTP as several people at once, including what each can and can't see.

---

## How days get their routes

Stops are grouped by area first (`kmeans` in `geo.ts`), then two passes in `src/planner/core.ts` judge the routes that come out. `groupDays` runs all of this from four different starting stops and keeps the most comfortable trip, because trading stops afterwards can't always undo a poor start:

- **`orderDay` untangles one day.** It tries several opening stops, then reverses stretches and moves single stops while travel time drops. Evening and night stops always keep their order after the daytime ones. Morning versus midday is only a preference, so a morning spot can slide later when that saves real travel.
- **`rebalanceDays` works across days.** It moves or swaps stops when that lowers total travel, evens out day sizes and avoids stacking evening stops. Hops over 18 minutes count extra, since one haul across town feels worse than several short hops and reads on the map as a stop on the wrong day. So it can accept a little more travel to fill a nearly empty day or end an overloaded one earlier. Asking in chat to tidy the whole trip runs this again; a single day's *Tidy route* only re-orders that day.

Route lines on the map are only slightly curved, because street routes aren't known yet and a big bow makes a hop look longer than it is.

---

## Light and dark

The sun/moon button in the top bar switches themes. First-time visitors follow their device setting, and an explicit choice is remembered (`wayfarer:theme`, `src/state/theme.ts`). A small inline script in `index.html` sets the theme before first paint, so it never flashes.

- **Colours are tokens.** The stylesheets only use custom properties, and `src/theme.css` redefines them for light mode. Accents split into text (deepened to at least 4.5:1) and fills (bright, with `--on-accent` text on top).
- **Photos stay dark.** Anything over an image keeps a dark scrim and light text in both themes, through a scoped override in `theme.css`.
- **The basemap swaps too** (CARTO dark-matter / positron). Route layers live inside the map style, so `addRouteLayers` in `MapCanvas.tsx` re-adds them on every `style.load`, and `styleGen` makes the data effects run again without replaying the route animation. On a light map, routes use deeper versions of the day colours.

---

## The intake conversation

`converse` in `src/planner/intake.ts` reads each message against the question on screen, says back what it heard, and always moves on. A bare answer ("5", "low") belongs to the question asked. Optional questions are never repeated: "mix and match" or an unclear reply settles that field and adds it to `brief.open`. Only destination and days are required. Tap-to-answer chips come from `QUICK_REPLIES`. Trips are capped at `MAX_DAYS` (5), and the reply says so when someone asks for more.

---

## Hosting

Live at **https://wayfarer-production-3acc.up.railway.app**, in the personal Railway workspace ("drishandutt's Projects", project `wayfarer`). In production one Node server (`server/index.ts`) serves the built site from `dist/` and the API, on Railway's `PORT`.

The build, start, health check and restart settings live in the `wayfarer` service's own settings on Railway, not in the repo: build `npm run build`, start `NODE_ENV=production node --import tsx server/index.ts`, health check `/api/health` with a 60s timeout, and restart on failure up to 5 times. Railway's old config file, `railway.json`, is deprecated and stops being read on 2026-12-01, so the repo no longer has one. Its replacement, Infrastructure as Code (`.railway/railway.ts`), isn't applied on push, so it would need its own apply step. Change these settings in the dashboard (service → Settings). Railway CLI 4.35's `railway environment edit` answered "No changes to apply" and saved nothing.

Every push to `main` on GitHub (`drishandutt/Travel---Wayfarer`) deploys. A deploy that fails its health check never takes traffic, and the previous one stays live. To deploy the local folder without pushing, use the Railway CLI, which is signed in to the personal account:

```bash
railway up --service wayfarer
```

The directory is linked to the project. The Railway connector available to Claude is a different, work account, so it isn't used for this app. There is no `ANTHROPIC_API_KEY` on the service, so it runs the offline planner. Adding a key would switch on the Claude endpoints for anyone with the URL, so add rate limits first. Money's email sign-in wouldn't protect them, since anyone can type an address. Shared expenses need `DATABASE_URL` on the service: see [Money](#money-shared-expenses).

---

## The Claude brain (`server/`)

The browser never holds the API key. A small Node server (`server/index.ts`) talks to Claude and streams `PlannerEvent`s back as Server-Sent Events. `RemotePlanner` reads that stream; it implements the same `PlannerEngine` interface as `MockPlanner`, so no component changed.

| Step | Endpoint | How Claude is used |
|---|---|---|
| Intake | `POST /api/intake` → `{reply, brief}` | One call with **structured output** (JSON schema): Claude returns the whole updated `TripBrief` plus a one-question reply. Effort `low`. |
| Planning | `POST /api/plan` → SSE | **Tool-using agent loop** (`server/planAgent.ts`). Claude gets the brief and the place catalog, then calls `shortlist_places` → `commit_day` (once per day) → `finish_plan`. Every tool carries a `narration` sentence that becomes the live thinking log. Effort `medium`. |
| Hotels | `POST /api/hotels` → SSE | Commute, price and vibe scores are computed; Claude makes the final pick and explains it (structured output, effort `low`). Candidates animate in while it deliberates. |

Design choices:
- **Claude decides, code computes.** Claude chooses places, groupings, order and start times. Timings, travel legs and hotel metrics come from the deterministic primitives in `src/planner/core.ts`, which the offline planner shares, so numbers are never hallucinated.
- **Tool results feed back reality.** `shortlist_places` returns each kept place's nearest neighbours with travel minutes, and `commit_day` returns the computed timeline (including idle gaps), so Claude can correct course on later days.
- **Strict tools + server-side validation.** Tool schemas use `strict: true`, and every input is re-checked (unknown or reused ids are returned as tool errors for Claude to fix).
- **Resilience.** Requests opt into server-side refusal fallback (`fallbacks: "default"`). Closing the tab or pressing *Start over* aborts the in-flight Claude call. Any failure becomes an `error` event, and the UI falls back to the last stable phase.
- **Config** (`.env`): `WAYFARER_MODEL` (default `claude-opus-5-5`), `WAYFARER_EFFORT_PLAN|INTAKE|HOTEL`, `WAYFARER_BRAIN=mock` to force offline, `WAYFARER_API_PORT`.

---

## Folder map

```
server/
  index.ts                 HTTP API: /api/health, /api/intake, /api/plan (SSE), /api/hotels (SSE)
  claude.ts                SDK client, model, effort, refusal fallback, error messages
  intake.ts                Chat → TripBrief via structured output
  planAgent.ts             Claude tool loop → PlannerEvents
  hotelAgent.ts            Hotel scoring + Claude's pick
  money/
    routes.ts              Money API: validation, permissions, live streams
    store.ts               Groups, people, expenses, payments (each change one transaction)
    auth.ts                Accounts, sessions, password hashing, rate limits
    db.ts                  Postgres (Supabase, or in-process for dev and tests), migrations
    importSqlite.ts        the one-time copy from the old SQLite file
    fx.ts                  Exchange rates with daily cache and fallback
    *.test.ts              Maths and full API tests (npm test)
src/
  types.ts                 Domain model + PlannerEvent union (the contract)
  data/cities.ts           Seed places + hotels (Tokyo, Lisbon)
  data/videos.ts           Checked reels + videos per place, loaded on first use
  data/hotelPhotos.ts      Hand-picked cover photo per hotel
  data/placeCovers.ts      Hand-picked first photo for places the lookup serves poorly
  planner/
    engine.ts              PlannerEngine interface: the swap point
    core.ts                Shared scheduling + hotel scoring (used by server agent and offline planner)
    edits.ts               Live plan editing from chat (clauses → operations → re-timed plan)
    insights.ts            Costs, stats, book-ahead, packing, .ics / text export
    mockPlanner.ts         Offline heuristic planner (no key needed)
    remotePlanner.ts       SSE client for the Claude planner
    brain.ts               Detects whether Claude is configured; Claude intake call
    intake.ts              Chat → TripBrief extraction + next question
    geo.ts                 Haversine, travel-time model, arcs, balanced k-means
  money/
    engine.ts              Splits, balances, debts, spending (shared with the server)
    types.ts               Money domain model (shared with the server)
    currency.ts            Minor units, parsing and formatting amounts
    categories.ts          Spending categories and guessing one from a description
    outbox.ts              Offline queue and its optimistic effect on the state
    hooks.ts               Account, live group, exchange rates
    client.ts              Fetch wrapper, offline vs refused errors, local cache
    util.ts                Trip summary, activity text, CSV, photo shrinking, UPI links
  trip/
    types.ts               A trip shared with a group: the plan, votes, chat (shared with the server)
    votes.ts               Ranking places and who's still voting
    useSharedTrip.ts       Publishing the plan, receiving it live, queued votes and messages
  state/tripStore.ts       Reducer / phase state machine + itinerary edits
  state/persistence.ts     Autosave + My trips (localStorage)
  services/photos.ts       Wikipedia / Commons photo lookup
  services/weather.ts      Open-Meteo forecast / same-dates-last-year
  services/videos.ts       Video types, embed and watch URLs, "more on" links
  components/
    MapCanvas.tsx          MapLibre map: HTML markers, animated GeoJSON arcs, camera
    ChatPanel.tsx          Conversation + "Map my trip"
    ThinkingStream.tsx     Live reasoning log
    ItineraryPanel.tsx     Day tabs + timeline (stops, travel chips, buffers, free time)
    HotelPanel.tsx         Hotel scorecards
    SwipeDeck.tsx          Swipe deck + picks list
    PlaceCard.tsx          Pin details + photos + add / move / remove (places) or set as base (hotels)
    PhotoGallery.tsx       Photo carousel with credits
    SocialVideos.tsx       Reels + videos feed under a place's details
    Dashboard.tsx          Trip dashboard (weather, costs, days, checklists, export)
    MobileSheet.tsx        Phone bottom sheet (tabs, drag-to-snap) + useIsMobile
    TopBar.tsx             Brand, phase stepper, brief chips
    money/                 The money screens: MoneyApp (sign-in, groups, group shell), tabs,
                           SpendingTab, PeopleTab, ExpenseForm, ExpenseDetail, SettleForm
    trip/                  InviteFriends, GroupPicks (ranking, the admin's picks, voting from a card), GroupChat, GroupChat
```

---

## What's real, what's still mocked

| Concern | Today | Production swap |
|---|---|---|
| Understanding the user | ✅ Claude (structured output); regex extractor offline | — |
| Planning brain | ✅ Claude agent loop over SSE; `MockPlanner` offline | — |
| Places | Hand-curated `cities.ts` | Google Places / Foursquare / OSM Overpass behind a `searchPlaces` tool |
| Travel time | Distance heuristic (walk ≤ 1.4 km, else transit) | Routing API (Google Routes / Mapbox / OSRM) via `estimateTravel` |
| Route geometry | Bezier arcs | Real polylines from the routing API |
| Photos | ✅ Wikipedia / Commons (free) | Google Places / Foursquare photos for restaurants and hotels |
| Reels & videos | Curated snapshot in `data/videos.ts`. Instagram has no open search, so reels come from its public `instagram.com/popular/<topic>` grids; YouTube and TikTok come from search. Each was kept only if its title or caption names the place and it loads: YouTube's oEmbed confirms embedding is allowed, Instagram's embed page reports dead reels, but TikTok's oEmbed accepts any id, so check TikToks in the player itself. Clips get deleted over time, so re-check it now and then, and curate new cities when you add them | Instagram Graph API + YouTube Data API behind `getVideos` |
| Hotels | Seed list | Booking / Amadeus / Hotelbeds availability + price for the trip dates |
| Basemap | CARTO Dark Matter (no key) | MapTiler / Mapbox style with 3D buildings |

## Suggested next milestones

1. **Real data**: places API + routing API (real polylines, opening hours, departure-time-aware transit).
2. **Richer editing**: drag-and-drop between days, must-see pins before planning, "swap this for something cheaper", per-day start times.
3. **Sync**: group trips live on the server already; do the same for trips kept in the browser, so they follow you between devices.
4. **Trip-time mode**: live "you are here → next stop in 12 min" guidance and re-planning when you run late.
