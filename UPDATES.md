# Updates — running log

Raw notes on feature ideas as they come up. The organised master list is [FEATURES.md](FEATURES.md).

## 2026-11-10

- **Any city.** Name a city the app doesn’t have and it builds one from public guides in about a minute: every sight, museum, park, market, restaurant, bar and stay in its Wikivoyage article and district pages, each with its own map position, ranked by how well known it is on Wikidata, with the country’s money worked out and the dashboard’s essentials (plugs, tipping, the transit card, a few phrases) filled in by Claude. Tokyo, Lisbon and London stay as they were. Built cities are kept in the database, so the next traveller gets them at once. The chat says it’s mapping the city and carries on when it’s done.
- **Finds go to everyone.** A place a traveller adds themselves that’s somewhere others could visit too (an attraction, a restaurant, a bar, a park, a shop, never a home or an address: the map’s own category decides, and Claude’s read on it) joins that city’s places for every other traveller, marked **Traveller’s find**. The finder keeps **Your find** and the link they shared.
- **Every place has a profile:** what it does well, what to know before going, how busy, lively, late and child-friendly it is, and who it suits (first-timers, locals, families, couples, solo, groups, foodies, night owls, early birds, a tight budget, a splurge, avoiding crowds, wanderers, the adventurous, a slow day). Rules give every place one from the catalog; Claude profiles each city’s best-known places and every new find; and swipes teach the rest: what each kind of traveller kept or skipped makes a place *for* or *not for* them. The sliders, the swipe deck, the planner and the assistant all read it, and the pin card shows it.

## 2026-11-09

- **Admins can delete shared trips** from My trips (the ✕ on a trip you run). It goes for everyone: the plan, votes, chat and shared expenses. With anyone else in it, or money spent, you type the trip's name first.
- **Tune the trip after it's planned.** Over a drawn plan, *Tune the trip* in the chat opens the same sliders. *Show me options* doesn't choose for you: the days keep their places and re-time to the new pace, start and walking, and a deck of places and food that fit the new settings opens to swipe. Only what you keep is added. “Undo” brings the old settings back.
- **Two decks: places, then food and drink.** The swipe deck deals places first, then food and drink, with a tab for each showing its progress, so you can switch between them. Between the two there's a pause to swipe food or skip it. Food cards show which meal they suit and their cuisine.
- **Nine more sliders** under *More ways to tune*: pace, early bird ↔ night owl, plan ↔ wander, walking, food focus, crowds, where the money goes (stay vs days), chill ↔ adventurous, and kids. Each changes the plan: stops per day, start time, breaks, how far it walks before a ride, visit length, which places score up, and which hotel fits. Untouched, they change nothing. The Claude planner and the assistant are told which ones were moved, in words.
- **How well do you know the city?** A slider in the chat, after the trip questions, from *First time here* (all the must-sees) to *Basically a local* (hidden gems, none of the obvious). Every place now has a fame score (London's from Wikidata, Tokyo's and Lisbon's set by hand), and the planner, swipe deck and assistant aim at the band that fits. Sliders are defined in `src/planner/sliders.ts`, so more can follow.
- **Reels and videos load once per place.** The first search for a place's clips is kept in the database (shared by every traveller, surviving restarts and deploys) and on the device for a week, so opening it again is instant. Clips over a week old still show at once and are refreshed in the background. The swipe deck also starts the next card's search early.
- **London**, the first city built from public data rather than by hand: about 1,600 sights, museums, parks, markets, restaurants and bars from Wikivoyage's London guides, ranked by how well known they are on Wikidata, plus 30 hotels across three budgets. `npx tsx scripts/build-london.mts` rebuilds it. With that many places, the planner, swipe deck and assistant each weigh a shortlist of the best matches for the trip, and the assistant can search the rest.
- The assistant picks a real place itself when asked for a kind the app doesn't list (a nightclub, say), and chooses the day when you leave it open.
- **Share to Wayfarer.** Instagram reels, YouTube videos, X and LinkedIn posts, web searches, pages and map links can be shared to Wayfarer from the iPhone's share sheet, or pasted into chat. The server opens the link in a headless browser (signed in where the site needs it), the AI picks out the places, and you choose which of your trips they go into. They're added automatically.
- **Dev tools** (owner only, from My trips): every log line and error from the server, browsers and the iPhone app; the signed-in sessions the link reader uses; a link-reader tester; and tokens for a new **cookie-sync Chrome extension** (`tools/cookie-sync`) that keeps those sessions fresh by itself.
- **Start over** is in the top bar now, not at the bottom of the itinerary. It asks first, and the plan so far stays in My trips.
- Every trip gets its own **Money** and **Photos**, created the first time its itinerary is approved. The trip's dashboard opens them directly, scoped to that trip only. Money and Photos in the top bar show everything together: what you owe and are owed across all trips, and every photo with its filters. Each trip is listed there as a link into its own space.
- With an LLM connected (Claude, or OpenAI), the trip chat becomes an assistant that acts on the trip through an allowlist of tools: plan edits, adding your own places, videos, the money summary, logging expenses and inviting or removing people. Money and people changes ask for a tap first. Without an LLM the chat works as before.

## 2026-11-06

- Travellers can add their own places from chat: type a name, or paste a link from Google Maps, Apple Maps, OpenStreetMap or Waze. They land wherever the trip is (saved for the deck, next card, or straight into a day) and carry a **Your find** label. Each one gets reels and videos found live: YouTube from search, Instagram reels and TikToks through Claude's web search.

## 2026-11-04

- Captured the core feature list: Image Vault, Documents Vault, Paste itinerary to get the vibe, Real-time updates, Truly Hidden, the suggestion-based algorithm, and an open slot.
- Added the secondary (Tier 2) and backlog (Tier 3) upgrades to [FEATURES.md](FEATURES.md) as future work.
- Image Vault's design is settled in [docs/image-vault.md](docs/image-vault.md), including groups and roles and the choice an admin makes when removing a member. The first slice (upload, sharing, library with place and date filters, and the removal choice) went live the same day.
