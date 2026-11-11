# Wayfarer — architecture

An AI trip planner whose main surface is a map. You describe a trip in chat, and the planner *thinks on the map*: it drops pins, keeps or drops them, threads them into days with travel and buffer time, then finds the hotel that keeps every day close.

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY to plan with Claude
npm run dev            # web on http://localhost:5173, API on :8787
```

Without a model key the app runs fully offline on the heuristic planner. With `ANTHROPIC_API_KEY` it plans with Claude, and with only `OPENAI_API_KEY` it plans with OpenAI. The top bar shows which brain is active (for example **Claude Opus 5.5**, **GPT 6 Astra** or **Offline planner**).

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

**Your own places.** Travellers can add places they researched themselves, from chat, at any stage (`src/planner/customPlaces.ts`, `server/places.ts`):

- **How to add one:** type it (“add Fuunji ramen”, “add Cafe Kitsune to day 2”, “I want to go to Tasca do Chico”), or paste a link shared from Google Maps (full or `maps.app.goo.gl`), Apple Maps (`maps.apple.com` or `maps.apple/p/…`), OpenStreetMap or Waze, with or without words around it. Bare coordinates work too.
- **What counts:** a name we already know is a normal edit (“add golden gai”), and a kind of food or place (“add ramen”, “I want to try street food”) opens a deck as before. A loose phrasing (“I want to go to …”) needs a name with a capital letter, so ordinary chat isn’t mistaken for a place.
- **Finding it:** the server follows short links (only to maps hosts, hop by hop), reads the pin from the link, and looks it up on OpenStreetMap’s Nominatim (free, one request a second): near the pin for a link, around the city for a name, ranked by how well the name matches before how famous a place is. Anything more than 120 km from the trip’s city is refused. The kind (restaurant, bar, museum, park…) comes from its OpenStreetMap category; with Claude on (or OpenAI, see below), it also writes the blurb, tags, price, visit length and best time.
- **Where it goes:** the place is stored on the trip (`brief.customPlaces`), so it syncs to the group, survives reloads and saved trips, and every edit, deck and planner sees it through `tripCity(brief)`. While briefing, it’s saved and leads the deck. While swiping, it’s the next card (and goes to the group’s vote). With a plan, it goes straight into the day asked for, or the nearest one, and is undoable. While a plan is still drawing, it waits until the draft is ready. The same spot sent twice is only added once.
- **On the map:** its pin card and tile say **Your find**, with a link back to the maps app it came from.
- **Shared with everyone:** a find that's somewhere other travellers could visit joins the city's catalog for every traveller (`promoteFind` in `server/cities/store.ts`, table `city_places`), shown as **Traveller's find**. What the map calls it decides (`isVenue`: an attraction, restaurant, café, bar, park, market, shop or historic site; never a house, an office, a school or a hotel), and with a model on, its own view too (`public` in the description it writes). The catalog's copy loses the "Your find" marker and the link; the finder's own copy keeps both, and `tripCity` shows the catalog's copy once it's there. The same spot already listed is never promoted twice. Who added it is recorded when they're signed in, and a find can be hidden again in the database.
- **Reels & videos:** places without a curated feed are searched live (`GET /api/places/videos`, cached a day per place). YouTube comes from its search page (or the Data API when `YOUTUBE_API_KEY` is set). Instagram reels and TikToks come from Claude’s web search, limited to those two sites, using only links found in the search results, never ones the model writes; TikTok’s oEmbed supplies the real caption. Without an Anthropic key, OpenAI does both jobs when `OPENAI_API_KEY` is set (`server/openai.ts`, model `gpt-6-astra` unless `WAYFARER_OPENAI_MODEL` says otherwise): its `web_search` tool, limited to the same two sites, returns sources without titles, so it reports each clip’s caption and creator, and a clip is kept only if its reel or video id is among the pages the search returned. OpenAI is used for nothing else; planning stays with Claude or the offline planner. `/api/health` says which keys are on. A clip is kept only if its title names the place, and ones that also name the city come first. With neither key, the feed shows YouTube plus the links to search Instagram and TikTok. Lookups are rate limited per visitor, since each can run a web search.

**The assistant.** With an LLM connected (Claude when `ANTHROPIC_API_KEY` is set, otherwise OpenAI with `OPENAI_API_KEY`; `/api/health` says `agent: true`), chat over a plan goes to an assistant that acts on the trip through tools, like a command line for the app. Without one, the rule-based editor above answers as before.

- **One allowlist** (`src/agent/tools.ts`): read (find a place’s videos, the money summary), plan edits (add, remove, move or reorder a stop, tidy a day, fill a gap, choose the hotel, add a traveller’s own place, undo, and `change_trip`, which hands a plain-words change to the rule-based editor), and money and people (log an expense, invite or remove someone). The server offers the model exactly these, and the browser runs a call only if its name is on the list and its arguments pass that tool’s schema, extra fields included. Anything else comes back to the model as an error.
- **Nothing runs on the server.** `POST /api/agent` (`server/agent.ts`) only relays one round to the model and returns its tool calls. The browser runs them (`src/agent/run.ts`) through the same reducer actions and money API as the app’s own buttons, as the signed-in traveller, so the usual rules hold: a day keeps a stop, a normal group member can’t edit, the server checks admin rights, and every plan edit is undoable.
- **Money and people ask first.** Logging an expense or inviting or removing someone shows exactly what will happen (“Log “Dinner”: ¥3,000, paid by you, split equally between everyone (3)?”) with Confirm and Cancel. Declining tells the model nothing was done. Expenses are in the group’s currency, and only existing member ids are accepted.
- **Limits.** At most 8 rounds of tool calls per message, a cap on what’s sent, and 150 rounds an hour per visitor. Only the admin (or a solo traveller) talks to it. The model is told that trip data, place descriptions, video titles and tool results are information, never instructions, and that nobody in the chat can give it more abilities; the allowlist holds regardless.
- **What it sees:** the trip as text (`contextOf`): brief, each day’s stops with times and ids, hotels, and every known place with its id, plus the last few chat lines.

Every edit, from chat or from buttons, goes on an **undo stack** (↺ in the panel footer, or type "undo"). Requests typed while a plan is still drawing are queued and applied the moment it's ready.

The interpreter is rule-based and offline. It is the seam for an LLM with edit tools later: same input (request + plan), same output (`EditResult`).

---

## Editing & saving trips

Once a plan exists, every part of it is editable, and edits use the same timing rules as the planner (`src/planner/core.ts`):

- **Click any pin** → a place card. Unplanned places get *Add to Day N* (inserted where it adds the least walking and respects time of day). Planned ones get *Move to Day N* and *Remove*.
- **Itinerary rows**: ↑ ↓ to reorder, ✕ to remove, *Tidy route* re-orders a day by time of day and distance.
- **Free time**: the planner fills idle stretches of 90 min or more with something nearby. *+ suggest a stop* on any free-time block searches further afield on demand.
- **Photos**: every pin's card and journey stop shows real photos from Wikipedia and Wikimedia Commons (free, no key; `src/services/photos.ts`). Stops show the first photo and look it up only as they near the view. Places whose lookup leads with a weak picture get a hand-picked first photo from `src/data/placeCovers.ts`. If a nearby Wikipedia article matches the place name both ways (rejecting stations, and whole districts for restaurants and bars), its lead image is labelled **This place**. Otherwise the card shows freely licensed photos taken near the pin, labelled **Nearby**. Each photo links to its source with the author and licence. On the map, each kept or planned place wears its first photo beside its pin like a profile picture, ringed in its day's colour, once zoomed in close enough for them not to pile up (a 120px Wikimedia thumbnail, so the map stays light). Demo hotels are placeholders, so their cards show only **The neighbourhood**: a hand-picked cover from `src/data/hotelPhotos.ts`, which also tops each hotel card in the panel, then photos near the pin. Avenida Palace is the one real hotel, so its cover is labelled as the hotel itself.
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

### The iPhone app (`ios/`, `capacitor.config.ts`)

A native app built with Capacitor 8 (Swift Package Manager, so no CocoaPods). It's a shell around the **live site**, not a bundled copy: sign-in is an emailed code, then an `HttpOnly` cookie on `/api`, and trips and money stay live over `EventSource`, which both need the page and the API on one origin. Loading production keeps them first-party, so nothing in the web app changed for it, and **every push to `main` updates the app too**. Only native changes (icon, permissions, plugins, the shell itself) need a new build.

- **Launch:** the splash (the icon on `#1d1d1f`) stays up until the page has painted. `src/main.tsx` hides it through the Capacitor bridge, which the shell injects into the remote page too; `launchShowDuration` caps it at 6s.
- **Offline:** `public/offline.html` is bundled in the app (`server.errorPath`) and shown when the site can't be reached, with a *Try again* button.
- **Notch:** `viewport-fit=cover` in `index.html` lets the existing `env(safe-area-inset-*)` CSS do the work (`ios.contentInset: 'never'`).
- **Permissions** (`ios/App/App/Info.plist`): photo library and camera, for the vault and receipts.
- **Icon and splash:** drawn by `scripts/make-ios-art.py` in the Memphis palette. Rerun it to change them.
- **App ID:** `com.drishandutt.wayfarer`.
- **Share sheet:** the `ShareExtension` target (`ios/App/ShareExtension`, `com.drishandutt.wayfarer.share`) puts Wayfarer in the share sheet of Instagram, YouTube, X, LinkedIn, Safari, Maps and the rest. It takes the link (or the first link in shared text), opens the app at `wayfarer://share?url=…&text=…` and closes. The app picks that up through `@capacitor/app` (`appUrlOpen`, or `getLaunchUrl` on a cold start). If iOS won't let it open the app, it copies the link instead and says to paste it into chat. Being a native target, a change to it needs a new build; the rest of sharing is web code and ships with every push.

`npm run ios` builds, syncs and opens the Xcode project. Run on a simulator or phone from there; a real phone or TestFlight needs a signing team (App → Signing & Capabilities). `capacitor.config.json` in `ios/` is generated, so run `npx cap sync ios` after a fresh clone. To try local changes in the app, run `npm run phone` and sync with `CAP_SERVER_URL=http://<mac-ip>:5173 npx cap sync ios`, then sync again without it before shipping.

**TestFlight:** the App Store Connect app is *Wayfarer* (bundle `com.drishandutt.wayfarer`, team `DSR7239GNZ`). To ship a new build, archive and upload from `ios/App`; `ExportOptions.plist` bumps the build number on each upload:

```bash
xcodebuild -project App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath build/Wayfarer.xcarchive -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/Wayfarer.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export -allowProvisioningUpdates
```

Check `ios/App/App/capacitor.config.json` points at production before archiving: a `CAP_SERVER_URL` sync leaves it on your Mac.

For the App Store, Apple can reject an app that's only a website (guideline 4.2), so a submission would want native extras such as push notifications, the share sheet or offline trips first.

---

## Planning together

Everyone signs in first, with an email and a code sent to it (see [Accounts](#money-shared-expenses)). A trip can then be shared with a group, which has one **admin** and any number of normal users.

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

**Accounts.** Your email is your account, and it has to be proven. Every sign-up and sign-in is two steps: `POST /api/money/auth/email` (the address, and a name for a new account) sends a six-digit code to that address, and `POST /api/money/auth/verify` (the code, and the password on an account that has one) signs in. A new account is created only when its code is right, already verified (`users.email_verified_at`). Codes (`email_codes`, stored hashed) work once, for 10 minutes; only the newest for an address works; five wrong tries spend it; asking again within 30 seconds keeps the same one; and an address gets at most 8 codes in 15 minutes. A session counts only for a verified account (`currentUser`), so sessions from before verification became mandatory open nothing until their owner confirms the address once. Changing your address (`/auth/secure`) sends a code to the new one, and nothing moves until it's typed in. The optional password is a second lock on top of the code; changing it needs the current one and signs out other devices. There's still no password reset: the code gets you in, and the group owner can *Release* a seat, which puts it back to unclaimed for another account to take through the group's new invite link. Private expenses follow the account, not the seat: whoever takes a released seat gets its shared history and nothing private. Passwords use scrypt, session tokens are stored hashed, the session cookie covers the whole API (`Path=/api`), and sign-ins, codes and new accounts are rate limited.

**Sending the codes** (`server/mail.ts`), the first that's configured:
- **Resend**, when `RESEND_API_KEY` is set, from `WAYFARER_MAIL_FROM` (an address on a domain verified with Resend; without it, Resend's test sender, which only delivers to the Resend account's own address).
- **Gmail's API**, when `GMAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` are set: over HTTPS (`gmail.googleapis.com`), which is what production uses, because **Railway blocks outgoing mail ports (SMTP) on its free and Hobby plans**. The client is a Google Cloud OAuth client of type *Desktop app* in a project with the Gmail API enabled; its consent screen must be **In production** (an app left in *Testing* has its refresh tokens expire after 7 days). `npx tsx scripts/gmail-token.mts`, run on your own computer, asks for the client ID and secret, opens Google's consent page (sign in as `GMAIL_USER`; the "unverified app" warning is expected for your own app: Advanced → Go to …) and prints the refresh token. It asks only for `gmail.send`: the token can send as you, not read anything. Revoke it at myaccount.google.com/permissions.
- **Gmail's SMTP server**, when `GMAIL_USER` and `GMAIL_APP_PASSWORD` are both set (nodemailer, pinned): needs outgoing mail ports, so Railway Pro or another host. The password is a Google *app password* (Google account → Security → 2-Step Verification on → App passwords); spaces in it are ignored.
- Either Gmail route sends from that address with the name "Wayfarer", about 500 messages a day from a personal account, and codes from a personal address are likelier to land in spam, so this is for the beta; move to Resend with a domain for a launch.
- In development with neither, the email is printed to the server console. In production with neither, sign-in is refused with a clear message rather than letting anyone in unverified. Dev tools' status shows which one is in use.

Everything cached in the browser belongs to one account (`claimLocal`): if a different person signs in on the same device, it's wiped first.

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

## Photo vault

**Photos** in the top bar opens a library of every photo you can see: the ones you uploaded and the ones shared with you, newest first and grouped by day (`src/components/vault/VaultApp.tsx`). The design and its decisions are in [docs/image-vault.md](docs/image-vault.md). It uses the same accounts and groups as Money.

**Sharing.** When you upload, you choose who gets the photos: everyone in a trip group, chosen people from your groups, or only you. The server works out "everyone in the group" each time someone looks, so a person who joins later sees what was already shared, and someone who leaves stops seeing it. You can't share to a group you aren't in, or with someone you don't share a group with. Only the uploader can change who sees a photo, rename its place or delete it. Recipients never see the file name or who else got the photo. The server enforces all of this (`server/vault/store.ts`), the same way Money does.

**Removing someone.** If the person can see photos through the group, the admin is asked first (`DELETE /members/:mid` answers 409 `photo-choice` until `?photos=keep|revoke` is given). *Take them away* just removes them from the group. *Let them keep them* first shares everything the group has had so far with that person directly. Either way they get nothing shared to the group after that. Leaving on your own, or having your seat released, takes the photos away with no question. Deleting a group drops its shares, and each uploader keeps their own photos.

**Uploading.** The browser reads each JPEG's EXIF for the date taken and GPS position (`src/vault/exif.ts`) and makes a 640px JPEG thumbnail. It then uploads the original and the thumbnail straight to storage through signed links, three at a time, reading the next few photos while those send (`src/vault/client.ts`). Then it tells the server the upload is done. The server checks that both files arrived, are within the size limits, and are really images (checked by their first bytes), and only then makes the photo visible. An upload that never finishes is cleared after a day. JPEG, PNG and WebP are accepted, up to 30 MB each, with 2,000 photos and 3 GB per person (`VAULT_MAX_PHOTOS`, `VAULT_MAX_BYTES`).

**Places and dates.** Dates are the camera's own clock, shown as written, since EXIF has no time zone. Photos without one are filed under the day they were added. The server turns GPS positions into a town and country with OpenStreetMap's Nominatim, at most one request a second. Positions are rounded to about 100 m before they're sent, and each rounded position is looked up only once (`vault_places`). The uploader can type a place for any photo. Phones sometimes strip GPS from photos picked in a browser, so expect some photos with *No location*.

**Storage.** In production the files go in a private Supabase Storage bucket, `vault` (`VAULT_BUCKET`), which needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set on the server. Without those, production turns the vault off and the screen says so, rather than keeping photos on a disk that a redeploy would wipe. In dev and tests the files are kept in `./data/vault`, behind links this server signs and serves itself (`server/vault/storage.ts`). Thumbnails are made in the browser because Supabase's image transformations are a paid-plan feature. The tables (`vault_images`, `vault_shares`, `vault_places`) are migration 2 in `server/money/db.ts`.

Not built yet: grouping by faces and themes, selecting many photos at once, and HEIC files. Full-size files keep their EXIF, GPS included, so anyone who opens one gets the exact location.

Tests: `server/money/vault.test.ts` covers who sees what, the upload checks, the removal choice, place names and the EXIF reader.

---

## Sharing links into Wayfarer

A reel, video, post, web search, page or map shared to Wayfarer is read for the places it's about, and the traveller picks which trip they go in. It arrives from the iPhone's share sheet (above), from a `?share=<url>&text=` link, or pasted into chat (any link that isn't a maps link).

- **Reading** (`server/share/read.ts`, `POST /api/money/share/read`): maps links are one place, read as before (`server/places.ts`). Anything else opens in a headless Chromium (`server/share/browser.ts`, Playwright) with that site's saved session, so Instagram, X and LinkedIn show the post rather than a login page. The page's title, description (YouTube's full description too) and visible text go to Claude, or OpenAI without a Claude key, which names the places in it with their city and why the post likes them. Web searches aren't opened (search engines answer servers with a robot check), so the query itself is answered. Without a browser it falls back to the page's HTML; without an AI key it can read the link but not pick out places, and says so.
- **Safety:** a link can't make the server open a private or internal address. Every host is resolved first, every request the page makes is checked, and the browser runs one context per link that's thrown away afterwards.
- **Adding** (`src/components/share/ShareSheet.tsx`, `App.tsx`): the sheet lists the places, ticked, and the trips they can go in: the one on screen, the group trips you run, and your saved trips. The one with most of the places' city comes first, and places from another city can't be ticked. Choosing a trip that isn't open opens it, waits for its plan, then adds each place the way a place typed into chat is added (`resolvePlace`), so it lands in the deck or a day as usual.
- **Logins** come from the dev tools (below).

## Wayfarer in Claude (MCP)

Wayfarer is also a remote **MCP server**, so people can use it from Claude (or any MCP client) as a custom connector: research and add places, change the plan, look for flights and hotels against the itinerary, analyse spending, split costs, chat with the group, even make a whole new trip, all by talking. The address is `https://<site>/api/mcp`; the account screen (Money → Account → *Use Wayfarer from Claude*) shows it, with steps, and lists connected apps with **Disconnect**.

**Signing in** (`server/mcp/oauth.ts`): OAuth 2.1, the way MCP clients expect. A client finds the server through `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server`, registers itself (`/api/oauth/register`, dynamic client registration; redirects must be https, or http back to the same computer), and sends the person to `/api/oauth/authorize`. That page signs them in with an emailed code if they aren't already (the same `/api/money/auth` endpoints and cookie as the app), then asks *Allow Claude?* with what it can do. PKCE (S256) is required. Codes last 5 minutes and work once; a code used twice revokes what it made. Access tokens last an hour; refresh tokens 60 days and are replaced on each use, and an old one coming back cuts the app off entirely. Everything is stored as hashes (`oauth_clients`, `oauth_codes`, `oauth_tokens`, migration 9). The page can't be framed and only posts back to itself. `WAYFARER_PUBLIC_URL` overrides the address the server reports for itself.

**Sessions** (`server/mcp/index.ts`, Streamable HTTP via the official SDK, pinned): each MCP session belongs to the person whose token started it and is about one trip. The server's instructions tell the model to call `list_trips` first, show them, ask which one, and call `choose_trip`; every other tool refuses until then. Sessions are kept in memory and dropped after 3 hours idle.

**Tools** (`server/mcp/tools.ts`), each acting as the person, through the same store functions and reducer actions as the app, so the same rules hold (only the admin changes the plan; the server checks seats and roles):
- *Trips:* `list_trips`, `choose_trip`, `trip_overview`, `get_itinerary`, `itinerary_text`, `update_trip` (dates, travellers, budget), `create_trip` (a city, built first if Wayfarer hasn't mapped it, planned by the offline planner, given a group and published, so it's in their app), `import_itinerary` (an itinerary the person already has, as text: see *Pasted itineraries* below).
- *Places and research:* `search_places`, `suggest_places` (scored for the trip), `place_details` (with its profile), `place_videos`, and `add_places`: up to 15 real places Claude found on the web, by local name or maps link, resolved on OpenStreetMap and decided exactly like a find in the app (shared with the city, kept private, or sent to the owner's review queue).
- *The plan:* `add_stop`, `remove_stop`, `move_stop`, `reorder_stop`, `tidy_day`, `fill_gap`, `list_hotels`, `choose_hotel`, `change_trip` (the chat's edit engine: "add a day", "more relaxed"), `undo`.
- *Flights and hotels:* `travel_needs` gives the city, dates, nights, travellers, budget and the best area to stay (the middle of the planned days); Claude searches the web itself; `save_booking` records what was booked in the trip chat, and as a shared expense with a cost.
- *Money:* `money_summary` (totals, budget pace, who owes whom, by category, day and person, planned vs actual), `list_expenses` (rows for analysis, filterable), `add_expense` (any currency, converted at today's rate), `record_payment`, `delete_expense` (restorable).
- *People and chat:* `list_people`, `invite_person`, `read_chat`, `post_note`.

Plan changes (`server/mcp/trip.ts`) build the app's state from the shared plan, run the reducer actions, and publish the result as the next plan version with the version they started from, then notify the trip's live streams, so the admin's screen and everyone else's update at once. Someone publishing in between makes it start again from their version (once). The session keeps its own copy, so `undo` works within it. Only trips on the server are reachable: every trip is once its itinerary is approved; a draft still only in a browser isn't.

Three prompts come with it: *Research places for my trip*, *Find flights and hotels*, *Analyse our spending*. Every tool call is in the activity log (`mcp.tool`, with the client's name), as are sessions, trips chosen and made, and every OAuth step (`oauth.*`, and `security.oauth_*` for reused codes and refresh tokens); 900 tool calls an hour per person.

Not yet: the documents vault (when it exists, it gets tools here), and photos.

## Documents vault and alerts

Tickets, boarding passes, bookings, passports, visas, IDs and insurance, as PDFs or photos, on the vault's **Documents** tab (top bar → **Tools** → *Documents*; `src/components/vault/DocsTab.tsx`). Each is private to its owner.
- **Files** go straight from the browser to the vault's bucket under `<user>/doc-<id>` (the same signed-upload path as photos, `server/vault/storage.ts`, which now also reads a file back and recognises PDFs). On *done* the server checks the bytes really are the PDF or image claimed (`sniffFile`), then reads it in the background. Up to 300 per person, 20 MB each.
- **Reading** (`server/docs/read.ts`): one model call (Claude, else OpenAI; a PDF as a document/file input, a photo as an image) with a strict schema: the kind (flight, train, bus, ferry, hotel, car, event, insurance, passport, visa, id, other), a title and summary, the booking reference, travellers, every leg with times as printed plus the UTC offset of where they happen, the stay/event/pick-up/cover/validity dates, a check-in link, the holder, issuing country and expiry. A document number is cut to its last 4 characters whatever the model returns. Times without an offset use the uploader's own (sent with the upload).
- **Alerts** (`src/docs/alerts.ts`, pure and shared): flights get *check in* 24 h before and *leaves at* 3 h before (trains 90 min, coaches 1 h, ferries 90 min); stays the morning of check-in and check-out; car hire 2 h before pick-up; events 3 h before; passports 6, 3 and 1 months before expiry, IDs 3 and 1; visas 2 weeks before; insurance a week before cover ends. Against the person's trips with dates (from their groups; a visa or insurance linked to a trip is checked against that trip only): a passport or ID that runs out before a trip ends, a passport with under 6 months left, a visa that starts late, insurance that doesn't cover the trip, each due at once. Stored in `alerts` with a stable key per document (migration 10), so reading again, linking a trip, or (hourly) trips changing replaces the ones not yet sent.
- **Delivery** (`server/docs/notify.ts`): once a minute, due alerts are claimed (one UPDATE each, so never twice), shown in the app, and emailed unless the person turned that off (`users.alert_email`, the Profile's switch); one more than a day late goes to the app only. The **iPhone app** schedules the next 60 coming alerts on the phone with `@capacitor/local-notifications` (`src/docs/native.ts`) every time it refreshes them, so they arrive on the lock screen even offline; tapping one opens the documents. The app polls `/api/money/alerts` every minute: unread ones badge the avatar, and the Profile's **Alerts** card lists what arrived and what's coming. `/?docs` (the link in every alert email) opens the documents.
- Routes: `/api/money/docs` (list, `uploads`, `:id/done`, `:id/read` again, `:id/file` for a 10-minute link, `:id/trip`, `DELETE :id`) and `/api/money/alerts` (+ `/read`). Logged: `docs.read`, `docs.read_failed`, `alert.delivered`.

## Pasted itineraries

An itinerary someone already made (in Claude, ChatGPT, a doc, a friend's notes) becomes a trip in one step, from the trip chat or from Claude (`server/importItinerary.ts`):
- **Reading it:** one model call (Claude, else OpenAI) with a strict JSON schema pulls out the city, start date, travellers, hotel, and each day's stops in order: real places only (no "breakfast" or "check in"), each with a kind, a start time if given, a length if given, and a short note.
- **Places:** a stop Wayfarer already has for that city is matched by name (a close match only, `findPlaces` at 0.99); the rest are looked up on OpenStreetMap through `resolvePlace` (and if what the map finds is a place Wayfarer has under another name, the same spot or close by sharing a distinctive word, `catalogTwin`, it's that place) without the model describing them (the note becomes the blurb) and without joining the city's shared catalog: they stay on this trip (`brief.customPlaces`). Three at a time; Nominatim keeps its own one-a-second queue. Stops it can't find are listed back so they can be added with a maps link.
- **Days:** `buildDay` with `keepOrder` and `times`: their order, the first stop's time as the day's start, any later time held, and nothing pushed back to the time of day a place is usually best at. A day with no places (a rest day) stays a day. Up to 14 days.
- **Base:** their hotel if Wayfarer knows it, one placed from the map if not, else the best fit for those days (`scoreHotel`), and every day routed from it.
- **The chat** (`src/planner/itineraryPaste.ts`): a message of 160+ characters over 4+ lines with days or a timetable in it (`looksLikeItinerary`; a one-line edit never counts) goes to `POST /api/import-itinerary` (20 an hour per visitor) instead of the intake or the assistant, checked before links since itineraries often carry them. The open trip stays in My trips, as with New trip, and the new one opens on its finished plan with a summary in the chat. The chat box is a growing text area so a paste keeps its lines (Enter sends, Shift+Enter is a new line).
- **Claude:** `import_itinerary` takes the text as it is and saves the trip as a new group with its plan published, like `create_trip`. Both log `trip.imported`.

## Dev tools

For the app's owner only, one account, by its id (`server/dev/owner.ts`): `WAYFARER_OWNER_ID` when set, otherwise the first account to confirm the owner's address (`WAYFARER_OWNER_EMAIL`, or the built-in one) with an emailed code, kept in `dev_settings` from then on. Changing that account's address keeps the dev tools with it, and whoever later takes the old address gets nothing. Nobody else gets in, in development either. They open from **My trips → Dev tools**, or at `/?dev`, in a browser or in the iPhone app (which loads the live site, so the dev tools come with every push). Finds waiting for review show as a dot on *My trips* and a count beside *Dev tools* and on the *Places* tab; on a phone the tabs sit in a four-column grid so they're all in view. New tools go in as new tabs (`src/components/dev/DevTools.tsx`, one file per big tab in that folder).

- **Activity:** every activity, in `activity_events` (migration 6) for 90 days, written in batches like the logs (`server/dev/activity.ts`, `track(kind, …)`). Kinds are dotted, family first:
  - `http.request`: every API request and page load once answered (method, path, status, time), with who (`user_id`), from where (`ip`, browser) and which device (`x-wayfarer-device`, a random id per browser that `src/dev/activity.ts` adds to the app's own API calls, so what someone did before signing in joins up with them after). Built files, the log and activity uploads, the dev tools' own reads and a build's progress polls are left out.
  - `auth.*` (sign-up, sign-in, sign-out, account changes), `security.*` (`rate_limit` the moment a limit trips, `bad_password`, `forbidden`, `unauthorized` on the dev tools), `system.error` for 5xx.
  - `city.*` (lookups with what was typed and the answer, builds started, done, failed, profiled), `place.*` (each find resolved and **what the system decided about it and why**, promotions, the review queue, imports row by row, swipe signals, what was learned), `analyst.report`, `dev.*`.
  - `app.*` from the app itself (`src/dev/activity.ts`, `POST /api/money/dev/activity`, only `app.*` kinds accepted, rate-limited, details clipped and kept one level deep): `app.action` for every trip action, summarised against what was on screen (what they said in the chat, the brief, each swipe with the place and its match, places opened, stops moved, plans and hotels; never the whole trip, and not the noisy sync and hover ones), `app.click` for every button, link and tab pressed (its label and the screen it's on; never what's typed into a field), `app.screen` for money, photos, the dashboard, dev tools and the share sheet opening and closing, `app.open` (platform, screen size, language, time zone) and `app.visible` (seconds in front of them).
  The session cookie covers the whole API (`Path=/api`), so places, cities and the assistant know who's asking too; sessions from before are moved over on their next money request (`widenSession`). Filter by family, person (email or pseudonym), address or device; open a row for everything it carries.
- **Analyst** (`server/dev/analyst.ts`): two layers over the activity.
  - The **digest**, rules only, always on: security findings (rate limits, wrong passwords per account and per address, many accounts from one address, repeated refusals, the dev tools probed, vulnerability scanners by path, floods of missing pages, one account from many addresses, input carrying script, SQL, path or prompt-injection text, server errors); each person's journey (how far they got, from opening the app to saving a trip; cities; platforms; features used; what they said; swipes; finds; errors; devices and addresses); the new-places pipeline (decisions, the review queue, what joined which city, cities asked for including ones with no guide, builds, imports, most kept and skipped places); and product signals (errors, failing and slowest endpoints, what people do, the funnel).
  - The **agent**: Claude, or OpenAI, with read-only tools (`get_digest`, `query_events`, `count_events`, `user_profile`, `pending_reviews`) and a `submit_report` tool. It writes a report: a headline, security findings with severity and what to do, each person as a beta tester (who they seem to be, how far they got, what they liked, where they got stuck, what to ask them), new places with a recommendation on each waiting review, product problems, and a to-do list. People reach the model only as pseudonyms (`u:` and the first eight characters of their id) and the dev tools put the emails back; everything users typed is data to it, never instructions. It runs on demand, answers a typed question, and runs every `WAYFARER_ANALYST_HOURS` hours (6 unless set; `off` to stop) when at least 20 things have happened. Reports are kept in `dev_reports`.
- **Places:**
  - **To review:** a traveller's find goes to everyone, stays theirs, or waits here (`decideFind` in `server/places.ts`). What the map calls it (`mapSays`: somewhere to visit, a home or workplace, or unclear, like a street, a bare building or no category) and what the model says (`public`: yes, no or unsure) decide: both say it's a venue, or the map does and no model was asked, and it's shared; the map says private and the model doesn't disagree, or the name reads like an address, and it stays the traveller's; anything else (they disagree, neither can tell, the map is unclear) waits in `place_reviews` with the reason, both verdicts, the address, who added it and links to OpenStreetMap, Google Maps and the link they shared. **Accept** puts it in the city's catalog for everyone (`found.via = 'review'`); **Deny** keeps it the traveller's, and the same spot (`sameSpot`: close by and called the same) is never queued again. The traveller keeps their find either way.
  - **Add in bulk** (straight into the catalog, no review): **a whole city** by name (built from its guide, or a built one built again to pick up places added since; `buildFromDevTools`), a **spreadsheet** (.xlsx read without a dependency by `server/dev/sheets.ts`, or .csv and .tsv) or **Markdown or pasted text** (list items, bold names with notes, “Name (Area): note”, tables, and headings that name a city or a kind of place). Columns are recognised by their headings: name, city, country, area, type, vibe, price, notes, lat and lng or coordinates, a maps link, duration, best time, cuisine. A preview shows every row before anything is added. The import (`server/cities/importer.ts`) builds any city it doesn't have, finds each place on OpenStreetMap (at a link's or the sheet's coordinates when given), has the model describe and profile it if asked, applies what the sheet says over the map's guess, and reports each row as added, already there or not found. Social extraction is a placeholder for later.
  - **Added to cities:** every place that joined a city after it was built, newest first, with how (a traveller's find, accepted on review, imported) and by whom, and a way to take one out again.
- **Settings:** the **OpenAI key**, pasted by the owner, checked with OpenAI before it's kept, saved in `dev_settings` (readable only by the server, never sent back: the tab shows where the key came from and its last four characters) and in use at once without a redeploy (`setOpenAIKey` in `server/openai.ts`; `openai` is a live binding every module sees). A key saved here wins over `OPENAI_API_KEY`; removing it falls back to that.

- **Logs:** every server console line (`server/dev/log.ts` wraps `console.*`, and uncaught errors and rejections), every refused or failed API call, and from every browser and the iPhone app: uncaught errors, failed promises, console output and unreachable API calls (`src/dev/logger.ts`, sent in batches to `POST /api/money/dev/log`, rate-limited per visitor). They're kept in `dev_logs` for 30 days, up to 200,000 lines. Filter by level, source and text; tap a line for its stack, page, user and device.
- **Sessions:** the signed-in cookies the link reader uses, one set per site (`dev_cookies`, migration 3). Paste a cookie export (JSON), a cookies.txt or a `Cookie:` header, or let the extension keep them fresh. The values never come back out of the API; the tab shows which sites are signed in and when the login expires.
- **Link reader:** reads a link fresh and shows the places and exactly what the AI was given.
- **Extension:** tokens for the **cookie-sync** Chrome extension (`tools/cookie-sync`, load unpacked). It sends a site's cookies to `PUT /api/money/dev/cookies` with its token whenever they change, when Chrome starts and every half hour, and only for sites that Chrome is signed in to. A token can set sessions and nothing else; only its hash is stored.

## How days get their routes

Stops are grouped by area first (`kmeans` in `geo.ts`), then two passes in `src/planner/core.ts` judge the routes that come out. `groupDays` runs all of this from four different starting stops and keeps the most comfortable trip, because trading stops afterwards can't always undo a poor start:

- **`orderDay` untangles one day.** It tries several opening stops, then reverses stretches and moves single stops while travel time drops. Evening and night stops always keep their order after the daytime ones. Morning versus midday is only a preference, so a morning spot can slide later when that saves real travel.
- **`rebalanceDays` works across days.** It moves or swaps stops when that lowers total travel, evens out day sizes and avoids stacking evening stops. Hops over 18 minutes count extra, since one haul across town feels worse than several short hops and reads on the map as a stop on the wrong day. So it can accept a little more travel to fill a nearly empty day or end an overloaded one earlier. Asking in chat to tidy the whole trip runs this again; a single day's *Tidy route* only re-orders that day.

**Calendar time** (`src/planner/when.ts`). With dates, each day knows its weekday:
- `closedDays` reads simple OpenStreetMap opening hours ("Tu-Su 12:00-23:00", "Fr-Mo 18:00-02:00", "Mo off"). Anything it can't read says nothing, never a guess.
- `sunset` works out sunset from the city's centre and the date, in the city's time zone, by the almanac method (within a minute or two).

How the plan uses them:
- **The model planner** is told each day's weekday and sunset, and each place's hours and mood words. A day it commits with a place on its closed day comes back with a heads-up to fix later days.
- **Each stop's "why".** The planner's reason for keeping a place (tied to what they said) shows on its stop in amber, and the offline planner gives one where the mood matches. Reasons are kept on the trip (`brief.why`), so they survive edits.
- **The itinerary** shows each day's date, time spent getting around, and sunset. It warns when a stop is usually closed that day, and shows a stop's insider tip.
- **A place's card** shows the tips, its hours and where it was found.

**Rush hour.** A hop that isn't a walk takes longer in the morning (8:00–10:30) and evening (17:00–20:30) peaks, by a factor for each city (`trafficOf` in `geo.ts`: Mumbai 1.8, London 1.2, Tokyo 1.05, 1.3 for cities not listed), with half of that in the half hour either side. `buildDay` passes each hop's departure time, so an evening across town costs what it really does. Hops to and from the hotel aren't timed yet.

Route lines on the map are only slightly curved, because street routes aren't known yet and a big bow makes a hop look longer than it is.

---

## Light and dark

The sun/moon button in the top bar switches themes. First-time visitors follow their device setting, and an explicit choice is remembered (`wayfarer:theme`, `src/state/theme.ts`). A small inline script in `index.html` sets the theme before first paint, so it never flashes.

- **Colours are tokens.** The stylesheets only use custom properties, and `src/theme.css` redefines them for light mode. Accents split into text (deepened to at least 4.5:1) and fills (bright, with `--on-accent` text on top).
- **Photos stay dark.** Anything over an image keeps a dark scrim and light text in both themes, through a scoped override in `theme.css`.
- **The basemap swaps too** (CARTO dark-matter / positron). Route layers live inside the map style, so `addRouteLayers` in `MapCanvas.tsx` re-adds them on every `style.load`, and `styleGen` makes the data effects run again without replaying the route animation. On a light map, routes use deeper versions of the day colours.

---

## Any city: catalogs built on request

Tokyo and Lisbon are hand-made and London was built once from Wikivoyage; every other city is built the same way the moment a traveller names it (`server/cities/`). The catalog is a registry, not a constant: `src/data/cities.ts` keeps `CITIES` as one array that `registerCity` adds to and `addCatalogPlaces` grows, so every planner, deck and card reads a built city exactly like a hand-made one. The server registers everything it has built at start; the browser fetches a trip's city when the trip opens (`src/data/cityClient.ts`, `GET /api/cities/:id`) and redraws with it (`city-ready`), which is also how a hand-made city picks up travellers' promoted finds and what its places have learned.

**Naming a city.** With Claude, the intake's `destination` is free text; the server resolves it (`destinationOf` in `server/intake.ts`): a city it knows, by id or alias, or a lookup. Offline, `converse` returns `lookup` when the destination question went unanswered and the message has a word in it; the browser asks `POST /api/cities/lookup` and reads the message again with the city set once it's known. The lookup (`lookupCity` in `server/cities/store.ts`) tries the message's capitalised runs and then the message without its filler against Wikivoyage's search, keeps a title only if it's what they said and its article is a city or district guide (its status template says), and answers `known`, `building`, `failed` or `unknown`. A country or a region can't be built; the chat asks which city.

**Building** (`buildCity` in `server/cities/build.ts`, reading with `server/cities/wikivoyage.ts`): the article and the district pages its Districts section links to (a borough's own districts too, up to 60 pages) give every `see`, `do`, `eat`, `drink`, `buy` and `sleep` listing with coordinates. The same reading as London's: one entry per Wikidata item or name within 150 m; events and chains out; kind from the name and section; tags from the words; price band from the section or any amount in the listing, in any money (`amountsUsd`); fame from how many Wikipedias have an article; hotels from `sleep` listings with a price, the most central ten per budget, or placeholder stays named for the busiest areas when a guide prices none. The city's centre comes from the guide's `{{geo}}`, its country from OpenStreetMap, its money from the country (`moneyFor`, with live rates when the database has them), its time zone and the dashboard's essentials (plugs, tipping, emergency number, transit card, water, etiquette, phrases, packing, transit fares, aliases) from Claude or OpenAI, checked (a zone the clock can't use falls back to one from the longitude) and plain when neither is on. A build takes about a minute; the job's progress is polled (`GET /api/cities/:id/status`) and shown in the chat, which then carries on with the questions. Built cities are kept in the `cities` table and loaded at start. `npx tsx scripts/build-london.mts` still rebuilds London's shipped file with the same code.

**Places by mood** (`server/cities/vibeSearch.ts`, `POST /api/cities/:id/vibe`). A guide-built catalog leans to the famous sights. Once a trip has a mood (a feel, an occasion, moments, notes about the people, or things to avoid), the browser starts a search in the background while they chat (`findLocal` in `App.tsx`), and the deck waits for it, up to 90 seconds.

How a search runs:
- **The searches.** One broad search spreads itself thin (a date-night trip got breakfasts and parks), so the model runs focused searches side by side (`focusesOf`), using OpenAI's `web_search` or Claude's. Places should be near where they're staying.
  - **Nights out** (bars, speakeasies, rooftops, live music, dancing, late food, night experiences; 14) when the trip has nightlife, a late rhythm or an evening moment.
  - **Eats** (8–12).
  - **Days** (experiences together, a sunset view, a neighbourhood, surprises; 8–12).
  - Each place counts only if its own search returned its page.
- **What comes back for each place:** the know-how a local would give (`tips`: order, arrive, move, heads-up), mood words (`moods`), a price, the best time, the length of a visit, and the page it was found on.
- **Nothing invented.** A place is kept only if its page is one the search really returned (or on the same site), and OpenStreetMap finds it near the city.
- **Joining the city.** Each kept place joins the city's catalog for everyone, marked as a *Local pick* (`found.via = 'vibe'`, rank 0.3: known to people who care, not to the coach tours). Its opening hours come from OpenStreetMap.
- **No repeats.** The same mood in the same city (`moodOf`: its words in any order) isn't searched again for 30 days. The search is remembered in `vibe_searches` (migration 9) and in memory, and a search already under way is shared.
- **Limits.** 10 searches an hour per visitor, counted in the daily model cap. The search finishes even if the visitor leaves, since what it finds helps everyone.

**What a vibe is made of** (`kindFit` in `core.ts`). Tags say what a place touches on; `kindFit` says what kinds of place a vibe mostly is:
- Nightlife is bars first, then night spots, with parks, museums, markets and plain sights below them.
- Food is restaurants, then cafés and food markets.
- Nature is parks, art is museums, adventure is experiences.

The trip's vibes share the say, and with little ones along (`kids` ≥ 0.5) nightlife has none.

The story adds vibes too: a date night, a party, cocktails, dancing, rooftops, live music, or a night-time moment adds nightlife (unless they said no to bars or clubs) and a late rhythm.

The deck is two runs, and the one the trip is about leads with the bigger share (`leadsWithFood`). A nightlife or food trip opens on food and drink, which nightlife trips call *Drinks & food*. Other trips open on places.

**Matching the story.** `moodFit` (`src/planner/story.ts`) compares a place's mood words and cuisine with what they want: the feel, the occasion, the moments, and what they said about the people. It adds up to +4.5 to `scorePlace` and takes 4 off for each thing they said to avoid. The deck says why: "fits your jazz + cocktail".

**What a place is for.** Every place has a `profile` (`src/planner/profile.ts`): strengths, weaknesses, how busy, lively, late and child-friendly it is, and who it's *for* and *not for* among fifteen audiences (first-timers, locals, families, couples, solo, groups, foodies, night-owls, early-birds, budget, splurge, crowd-averse, wanderers, adventurous, chill). `ruleProfile` gives every place one from its kind, tags, price, fame and best time, so the browser and the server agree without a model. The server asks Claude (or OpenAI) for a better one (`server/cities/profile.ts`): a city's 150 best-known places in batches of twenty, once, in the background the first time the city is served; and every traveller's find, in the same call that describes it. A model that doesn't recognise a place says so and the rules stand. Profiles live in `place_profiles`. The trip's own audiences come from the brief (`audiencesOf`: the sliders, the budget and who's coming), and `scorePlace` adds `profileFit` (for: up, not for: down, more so when someone knew the place) and reads the profile's numbers in place of its old guesses (a bar is late and lively, a park is calm and good with kids). The planner's catalog lines say who a profiled place suits; the pin card shows **Best for**, **Good** and **Know**.

**What swipes teach.** Mapping a deck sends what was kept and skipped with the trip's audiences, never who the traveller is (`POST /api/cities/:id/signals`, table `place_signals`). A minute later the city learns (`learnFrom`): a place with at least six swipes is *for* an audience that kept it clearly more than most did (four or more of them, 65%+, a tenth above the overall rate) and *not for* one that skipped it. What's learned sits on the profile as `learned` and outranks what the catalog or the model guessed, so a place travellers keep proving wrong gets corrected.

---

## The intake conversation

**The trip story** (`TripBrief.story`, `src/planner/story.ts`) holds what people tell us beyond the basics:
- why they're going (`occasion`)
- who's coming, with anything known about each person (`people`)
- where they're staying (`stay`, placed on the map once found)
- when they're free on day 1 and when they must be done on the last day (`arrive`, `leave`)
- what they want to happen and on which day (`moments`)
- the mood (`feel`)
- what not to plan (`avoid`)

With a model, the intake fills it. Offline, `extractStory` reads the same things from the text: dates in the usual forms ("24, 25, 26", "Dec 3-6", "the 12th to the 14th"; never a count or an amount), "staying at …", "landing at 1 pm", relations ("my girlfriend", "the kids"), occasions, moments tied to a day ("24th: a crazy date night"), and avoid-lists after "not", "no", "hate" and "don't want".

What the story means for the plan:
- `applyStory` turns it into the settings the planners already read, without overriding a slider someone moved. For example, "touristy" moves *Knows the city* to mostly local favourites, "crowds" sets the crowds slider, kids set the kids slider, and "romantic" adds the vibe.
- `storyLines` says it to the model planner and the hotel pick in words.
- Day 1 starts 75 minutes after they arrive (`arrivalFloor`, read by `buildDay`).
- Once their hotel is on the map, it is the base: `stayHotel` gives it to both planners' hotel step, and no other hotel is chosen. Its price isn't known, so the summary says *Booked* and the cost estimate uses the budget's usual rate.

The hotel is found with `POST /api/places/stay`. It looks the name up on OpenStreetMap (`resolvePlace`, nothing described), keeps it on the trip only, and never adds it to the city's catalog. It is pinned on the map as *Where you're staying* from the first message.

**What I heard.** Once three or more things are known, the chat shows them as chips. Tapping a chip starts a correction in the message box ("Not quite: … should be "), and × takes that piece out.

**One question, like a friend.** Offline, the order is destination, days, who's coming, **the person** ("What's your girlfriend into?", when someone's coming and nothing is known about them; the answer is kept in their words in `people[].notes`), vibe, then budget. Budget isn't asked when they've said where they're staying, and vibe isn't asked when the story has a feel. With a model, the model picks the one question whose answer would change the plan most, and sends its own tap-to-answer chips with it (`chips` on the chat message).

`converse` in `src/planner/intake.ts` reads each message against the question on screen, says back what it heard, and always moves on. A bare answer ("5", "low") belongs to the question asked. Optional questions are never repeated: "mix and match" or an unclear reply settles that field and adds it to `brief.open`. Only destination and days are required. Tap-to-answer chips come from `QUICK_REPLIES`. Trips are capped at `MAX_DAYS` (5), and the reply says so when someone asks for more. A city the app doesn't know is looked up and built (see *Any city*).

---

## Hosting

Live at **https://wayfarer-production-3acc.up.railway.app**, in the personal Railway workspace ("drishandutt's Projects", project `wayfarer`). In production one Node server (`server/index.ts`) serves the built site from `dist/` and the API, on Railway's `PORT`.

The build, start, health check and restart settings live in the `wayfarer` service's own settings on Railway, not in the repo: build `npm run build`, start `NODE_ENV=production node --import tsx server/index.ts`, health check `/api/health` with a 60s timeout, and restart on failure up to 5 times. Railway's old config file, `railway.json`, is deprecated and stops being read on 2026-12-01, so the repo no longer has one. Its replacement, Infrastructure as Code (`.railway/railway.ts`), isn't applied on push, so it would need its own apply step. Change these settings in the dashboard (service → Settings). Railway CLI 4.35's `railway environment edit` answered "No changes to apply" and saved nothing.

`railpack.json` adds Debian's Chromium to the image for the link reader (`/usr/bin/chromium`; `CHROMIUM_PATH` overrides). `/api/health` reports `linkReader: "browser"` when it's found, `"fetch"` when not.

Every push to `main` on GitHub (`drishandutt/Travel---Wayfarer`) deploys. A deploy that fails its health check never takes traffic, and the previous one stays live. To deploy the local folder without pushing, use the Railway CLI, which is signed in to the personal account:

```bash
railway up --service wayfarer
```

The directory is linked to the project. The Railway connector available to Claude is a different, work account, so it isn't used for this app. There is no `ANTHROPIC_API_KEY` on the service, so the intake, the planner and the hotel pick run on OpenAI. Its key comes from `OPENAI_API_KEY` or the dev tools' *Settings*. Those three routes are limited per visitor: intake 120, plans 20 and hotels 30 an hour. Across everyone, `WAYFARER_DAILY_MODEL_CALLS` (3000 a day unless set) caps them, after which the app falls back to the offline planner until the next day. Money's email sign-in wouldn't protect these routes, since anyone can type an address. Shared expenses need `DATABASE_URL` on the service: see [Money](#money-shared-expenses).

---

## The model brain (`server/`)

The browser never holds an API key. A small Node server (`server/index.ts`) talks to the model and streams `PlannerEvent`s back as Server-Sent Events. `RemotePlanner` reads that stream; it implements the same `PlannerEngine` interface as `MockPlanner`, so no component changed.

The model is Claude when `ANTHROPIC_API_KEY` is set, otherwise OpenAI (`server/llm.ts`). `structured` makes one JSON-schema call. `toolLoop` runs a tool loop:
- **Claude:** the assistant turn goes back verbatim each round.
- **OpenAI:** the Responses API, with `previous_response_id` and `function_call_output` items.

Tools are strict on both. `/api/health` says which model plans (`planner`, `model`).

| Step | Endpoint | How the model is used |
|---|---|---|
| Intake | `POST /api/intake` → `{reply, chips, brief, building?}` | One call with **structured output** (JSON schema). The model returns the whole updated `TripBrief` and its story, a reply that asks the one question that would change the plan most, and tap-to-answer chips. Effort `low`. The destination is free text; the server resolves it, building the city if need be. |
| Planning | `POST /api/plan` → SSE | **Tool-using agent loop** (`server/planAgent.ts`). The model gets the brief, its story and the place catalog, then calls `shortlist_places` → `commit_day` (once per day) → `finish_plan`. Every tool carries a `narration` sentence that becomes the live thinking log. Effort `medium`. |
| Hotels | `POST /api/hotels` → SSE | Where they're staying, if they said and it's on the map, is the base, with no model call. Otherwise commute, price and vibe scores are computed, and the model makes the final pick and explains it (structured output, effort `low`). Candidates animate in while it deliberates. |

Design choices:
- **The model decides, code computes.** The model chooses places, groupings, order and start times. Timings, travel legs and hotel metrics come from the deterministic primitives in `src/planner/core.ts`, which the offline planner shares, so numbers are never hallucinated.
- **Tool results feed back reality.** `shortlist_places` returns each kept place's nearest neighbours with travel minutes, and `commit_day` returns the computed timeline (including idle gaps), so the model can correct course on later days.
- **Strict tools + server-side validation.** Tool schemas use `strict: true`, and every input is re-checked (unknown or reused ids are returned as tool errors for the model to fix).
- **Resilience.** Claude requests opt into server-side refusal fallback (`fallbacks: "default"`). Closing the tab or pressing *Start over* aborts the in-flight model call. Any failure becomes an `error` event, and the UI falls back to the last stable phase.
- **Config** (`.env`): `WAYFARER_MODEL` (default `claude-opus-5-5`), `WAYFARER_OPENAI_MODEL` (default `gpt-6-astra`), `WAYFARER_EFFORT_PLAN|INTAKE|HOTEL`, `WAYFARER_BRAIN=mock` to force offline planning, `WAYFARER_DAILY_MODEL_CALLS`, `WAYFARER_API_PORT`.

---

## Folder map

```
server/
  index.ts                 HTTP API: /api/health, /api/intake, /api/plan (SSE), /api/hotels (SSE)
  claude.ts                SDK client, model, effort, refusal fallback, error messages
  intake.ts                Chat → TripBrief via structured output
  planAgent.ts             Claude tool loop → PlannerEvents
  hotelAgent.ts            Hotel scoring + Claude's pick
  places.ts                Travellers' own places: maps links, OpenStreetMap lookup, live reels & videos, promotion to the catalog
  openai.ts                OpenAI client, for those lookups when there's no Anthropic key
  cities/
    wikivoyage.ts          Reading a guide's wikitext into places and hotels, in any money (London's script uses it too)
    build.ts               Finding a city's article, walking its districts, money, time zone, essentials from a model
    profile.ts             A model's read on what places are good and bad at, and who they suit
    store.ts               Built cities, promoted finds, profiles and swipe signals in the database; the registry; build jobs; the review queue
    importer.ts            The owner's bulk imports: rows found on the map, shaped by the sheet, added to their city
  mail.ts                  Sending email (sign-in codes) through Resend or Gmail, or to the console in development
  mcp/
    http.ts                OAuth discovery, sign-in, tokens and the MCP endpoint, mounted by index.ts
    oauth.ts               OAuth 2.1 for MCP clients: registration, the consent page, tokens, connected apps
    index.ts               MCP sessions (one trip each), the instructions and prompts
    tools.ts               Every tool: trips, places and research, the plan, flights and hotels, money, people
    trip.ts                A session's trip: loading it, and changing the plan through the app's reducer
  dev/
    owner.ts               Who owns the app (one account id), and so the dev tools
    routes.ts              The dev tools' API: logs, activity, the analyst, places, sessions, the link reader, tokens, settings
    log.ts                 Every log line, server and app, into dev_logs
    activity.ts            Every activity, server and app, into activity_events; reading it back
    analyst.ts             The digest (rules) and the analyst agent (Claude or OpenAI) over the activity; scheduled reviews
    sheets.ts              Reading .xlsx, .csv, Markdown and pasted lists of places into rows
    settings.ts            Settings changed without a redeploy (the OpenAI key)
    cookies.ts             Site sessions for the link reader
  agent.ts                 The trip assistant's relay to Claude or OpenAI (runs no tools itself)
  money/
    routes.ts              Money API: validation, permissions, live streams
    store.ts               Groups, people, expenses, payments (each change one transaction)
    auth.ts                Accounts, sessions, email codes, password hashing, rate limits
    db.ts                  Postgres (Supabase, or in-process for dev and tests), migrations
    importSqlite.ts        the one-time copy from the old SQLite file
    fx.ts                  Exchange rates with daily cache and fallback
    *.test.ts              Maths and full API tests (npm test)
  vault/
    routes.ts              Photo vault API under /api/money/vault: uploads, library, sharing
    store.ts               Who can see which photo, upload checks, removal choice, place names
    storage.ts             Supabase Storage bucket (production) or disk with signed links (dev)
src/
  types.ts                 Domain model + PlannerEvent union (the contract)
  data/cities.ts           The city registry: Tokyo and Lisbon by hand, London from london.json, any other registered as built
  data/cityClient.ts       Fetching a trip's city, looking one up, waiting for a build, sending swipe signals
  dev/logger.ts            The app's log lines and errors, sent to the dev tools
  dev/activity.ts          What people do in the app (actions, presses, screens, time), sent to the activity log
  data/london.json         ~1,600 London places + 30 hotels, built by scripts/build-london.mts from Wikivoyage, ranked by Wikidata
  data/videos.ts           Checked reels + videos per place, loaded on first use
  data/hotelPhotos.ts      Hand-picked cover photo per hotel
  data/placeCovers.ts      Hand-picked first photo for places the lookup serves poorly
  agent/
    tools.ts               The assistant's allowlist: every tool, its arguments, and which ask first
    run.ts                 Runs the assistant's tool calls through the app's own actions; what it sees of the trip
  planner/
    engine.ts              PlannerEngine interface: the swap point
    core.ts                Shared scheduling + hotel scoring (used by server agent and offline planner)
    edits.ts               Live plan editing from chat (clauses → operations → re-timed plan)
    customPlaces.ts        Reading a find from chat and maps links (shared with the server)
    insights.ts            Costs, stats, book-ahead, packing, .ics / text export
    mockPlanner.ts         Offline heuristic planner (no key needed)
    remotePlanner.ts       SSE client for the Claude planner
    brain.ts               Detects whether Claude is configured; Claude intake call
    intake.ts              Chat → TripBrief extraction + next question
    profile.ts             What a place is for: rules profile, the trip's audiences, the fit
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
  vault/
    types.ts               Photo vault model (shared with the server)
    exif.ts                Date taken and GPS position from a JPEG
    client.ts              Thumbnails, uploading straight to storage, library calls
  trip/
    types.ts               A trip shared with a group: the plan, votes, chat (shared with the server)
    votes.ts               Ranking places and who's still voting
    useSharedTrip.ts       Publishing the plan, receiving it live, queued votes and messages
  state/tripStore.ts       Reducer / phase state machine + itinerary edits
  state/persistence.ts     Autosave + My trips (localStorage)
  services/photos.ts       Wikipedia / Commons photo lookup
  services/weather.ts      Open-Meteo forecast / same-dates-last-year
  services/videos.ts       Video types, curated or live lookup, embed and watch URLs, "more on" links
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
    vault/                 VaultApp: the photo grid, filters, upload sheet and viewer
    trip/                  InviteFriends, GroupPicks (ranking, the admin's picks, voting from a card), GroupChat, GroupChat
```

---

## What's real, what's still mocked

| Concern | Today | Production swap |
|---|---|---|
| Understanding the user | ✅ Claude or OpenAI (structured output, with the trip story); rule-based reading offline | — |
| Planning brain | ✅ Claude or OpenAI agent loop over SSE; `MockPlanner` offline | — |
| Places | ✅ Tokyo and Lisbon by hand; London and any other city from Wikivoyage + Wikidata on request; travellers' finds promoted; local picks found by mood on the web | Opening hours and a places API for the long tail |
| Travel time | Distance heuristic (walk ≤ 1.4 km, else transit), slowed at rush hour by a factor per city | Routing API (Google Routes / Mapbox / OSRM) via `estimateTravel` |
| Route geometry | Bezier arcs | Real polylines from the routing API |
| Photos | ✅ Wikipedia / Commons (free) | Google Places / Foursquare photos for restaurants and hotels |
| Reels & videos | Curated snapshot in `data/videos.ts`. Instagram has no open search, so reels come from its public `instagram.com/popular/<topic>` grids; YouTube and TikTok come from search. Each was kept only if its title or caption names the place and it loads: YouTube's oEmbed confirms embedding is allowed, Instagram's embed page reports dead reels, but TikTok's oEmbed accepts any id, so check TikToks in the player itself. Clips get deleted over time, so re-check it now and then, and curate new cities when you add them. Places with no curated clips (travellers’ own) are searched live: see *Your own places* | Instagram Graph API + YouTube Data API behind `getVideos` |
| Travellers’ own places | ✅ OpenStreetMap Nominatim, from a maps link or a name; Claude describes them | Google Places for richer details and opening hours |
| Hotels | Seed list | Booking / Amadeus / Hotelbeds availability + price for the trip dates |
| Basemap | CARTO Dark Matter (no key) | MapTiler / Mapbox style with 3D buildings |

## Suggested next milestones

1. **Real data**: opening hours for the built catalogs, and a routing API (real polylines, departure-time-aware transit).
2. **Richer editing**: drag-and-drop between days, must-see pins before planning, "swap this for something cheaper", per-day start times.
3. **Sync**: group trips live on the server already; do the same for trips kept in the browser, so they follow you between devices.
4. **Trip-time mode**: live "you are here → next stop in 12 min" guidance and re-planning when you run late.
