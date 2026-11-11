# Travel App — Feature Master List

> The consolidated, final list of every feature idea discussed. Organized into three tiers.
> This is the master reference; `UPDATES.md` remains the raw running log.
>
> _Last updated: 2026-11-11_

**Legend:** 🟢 design locked · 🔵 building · ⚪ idea (not yet scoped)

---

## Tier 1 — Core Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **Image Vault** | 🟢🔵 | Design locked (`docs/image-vault.md`). Slice 1 live: multi-upload, share to a group or selected people, sorted by places and dates. Next: people (faces) and themes. |
| 2 | **Documents Vault** | 🔵 | First slice live: PDFs and photos of tickets, bookings, passports, visas, IDs and insurance, read by the model; alerts for check-in, departures, stays, expiry and trip coverage, in the app, by email and as iPhone notifications. Next: OCR auto-sort into trips, an offline pack, sharing a booking with the group. |
| 3 | **Paste Itinerary → Get the Vibe** | 🔵 | Pasting an itinerary into the chat (or giving it to Claude) makes it a trip. Next: reading the trip's feel from it. |
| 8 | **The Vibe Engine** | 🟢🔵 | Plan: `docs/vibe-engine.md`. Release 1 live: the intake, planner and hotel pick run on OpenAI when there's no Claude key; the trip story (occasion, people, where they stay, arrival, moments, feel, what to avoid) read from the first message, shown back as chips to correct, one friend-style question, the hotel on the map as the base, day 1 after landing, rush-hour travel times. Next: Release 2, local places by vibe and plans that read like a story. |
| 4 | **Real-Time Updates** | ⚪ | Location-based, crisis alerts, population count, safety, events, flight & travel-cost updates, and more. |
| 5 | **Truly Hidden** | ⚪ | Collaborate with locals; influencers & agents; download podcasts/user stories and analyze them. |
| 6 | **Suggestion-Based Algorithm** | 🔵 | First slice live: every place carries a profile (strengths, weaknesses, who it suits), from rules, Claude and travellers' swipes; the sliders, deck and planner read it. Next: learn from saved and rejected trips, not just swipes. |
| 7 | **Any city** | 🟢🔵 | Live: a city the app doesn't have is built from Wikivoyage and Wikidata when named, with Claude filling the essentials. Travellers' public finds join each city's catalog for everyone. Next: opening hours and real routing. |

---

## Tier 2 — Secondary (extensions to the core)

### Extending the Vaults (#1, #2)
- **Auto-sorting vault** — drop any photo/doc in and it tags itself by trip, city, date, and type (ticket vs. passport vs. receipt), pulling dates/confirmation numbers via OCR.
- **Offline pack** — one tap bundles docs + maps + key info for a trip into an offline-accessible kit.
- **Expiry & renewal watch** — flags a passport/visa/insurance that expires before or during a trip. _(Live, in the documents vault's alerts.)_

### Extending "Paste → Vibe" (#3)
- **Itinerary health-check** — flags tight connections, over-packed days, long transit gaps, or an empty day.
- **Vibe → build** — reverse of #3: pick a vibe ("slow, coastal, no crowds") and it drafts an itinerary.
- **Budget reality-check** — paste an itinerary, get an honest cost estimate vs. your budget.

### Extending Real-Time (#4)
- **Money layer** — live currency, cards vs. cash acceptance, tipping norms, scam alerts.
- **Health & entry layer** — vaccination/visa requirements, local emergency numbers, nearest hospital/embassy.
- **Weather-triggered re-plan** — rain tomorrow → suggests swapping an outdoor day for an indoor one.

### Extending "Truly Hidden" (#5)
- **Verified locals** — a trust/rating layer; small paid micro-consults with a local.
- **Story map** — podcasts/user stories pinned to real map locations, so you discover by place.
- **Language & etiquette primer** — the 20 phrases and 5 customs that actually matter.

### Extending the Algorithm (#6)
- **Taste graph** — learns from trips you saved/rejected, not just an onboarding quiz. _(Swipes already teach each place who keeps it; saved and rejected trips next.)_
- **"People like you" without the creep** — recs by trip-style similarity, not personal data.
- **Anti-recommendation** — tells you what to skip as confidently as what to do.

### Net-New Themes
- **Group / collaborative planning** — shared trip with voting, split costs, merged availability calendar. _(Voting and split costs are live; the calendar isn't.)_
- **Memory / post-trip** — auto-generates a recap or photobook from your vault + itinerary.
- **Carbon & slow-travel mode** — surfaces lower-impact routes and flags.
- **Flexibility search** — "anywhere warm, under $X, first week of March" instead of a fixed destination.

---

## Tier 3 — Backlog (additional ideas)

### Booking & logistics
- **One-inbox parser** — forward any confirmation email (flight, hotel, car); it auto-fills the itinerary and vault.
- **Price-drop watch** — track a flight/hotel after booking; alert on drops so you can rebook or refund.
- **Rebooking co-pilot** — flight cancelled → surfaces your rights, alternative routes, and what to say to the airline.
- **Visa/transit checker** — "6hr layover in X — do you need a transit visa?"

### On-the-ground experience
- **Live "what's open now"** — filters by what's actually open at your current local time.
- **Neighborhood fit** — before booking a stay, tells you if the area matches your vibe.
- **Day-of pacing nudge** — knows your plan and energy; suggests when to slow down.
- **Queue / crowd timing** — best hour to hit a landmark to avoid lines.

### Social & trust
- **Travel-buddy matching** — find someone with a compatible style for a shared leg or activity.
- **Reputation-weighted reviews** — surface reviews from people whose taste matches yours.
- **Trip journaling, shareable** — lightweight public/private log friends can follow.

### Money
- **Shared wallet** — group expense tracking with auto-split and settle-up. _(Live: Money.)_
- **Spend-vs-budget live** — running tally against the trip budget, by category. _(Live: Money's budgets and planned vs actual.)_

### Safety & accessibility
- **Solo-safety mode** — check-ins, trusted-contact share, safe-route suggestions at night.
- **Accessibility layer** — step-free routes, wheelchair access, dietary/allergy-friendly spots.

### Smart / AI-forward
- **Voice trip-planner** — talk to it like a travel agent; it builds and adjusts the plan live.
- **Photo-to-destination** — upload a photo you love; it finds places that look/feel like it.
- **AR point-and-learn** — point your camera at a building/dish/sign for instant context.
- **Regret-minimizer** — "you're 20 min from X you'd probably love and won't be back for years."
