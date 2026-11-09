# Updates — running log

Raw notes on feature ideas as they come up. The organised master list is [FEATURES.md](FEATURES.md).

## 2026-11-09

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
