import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Db } from '../money/db'
import * as store from '../money/store'
import { HttpError } from '../money/store'
import { publish } from '../money/routes'
import { getRates } from '../money/fx'
import { track } from '../dev/activity'
import { overLimit } from '../money/auth'
import { PlaceError, resolvePlace, placeVideos } from '../places'
import { buildStatus, lookupCity } from '../cities/store'
import { ImportError, importItinerary, importSummary, type Imported } from '../importItinerary'
import { cityById, findCity } from '../../src/data/cities'
import { MockPlanner } from '../../src/planner/mockPlanner'
import { scorePlace } from '../../src/planner/core'
import { estimateCosts, toText, bookAhead } from '../../src/planner/insights'
import { fmtClock, haversineKm } from '../../src/planner/geo'
import { AUDIENCE_LABEL, audiencesOfProfile, profileOf } from '../../src/planner/profile'
import { initialState, reducer, snapshotOf, type TripState } from '../../src/state/tripStore'
import { tripSummaryOf } from '../../src/money/util'
import { CATEGORIES, CATEGORY_IDS, categoryForKind, categoryOf, guessCategory } from '../../src/money/categories'
import { CURRENCIES, currencyDigits, fmtMoney } from '../../src/money/currency'
import { budgetPace, netBalances, plannedVsActual, simplifyDebts, spendByCategory, spendByDate, spendByMember, totalsFor } from '../../src/money/engine'
import type { ExpenseInput, GroupState } from '../../src/money/types'
import type { BudgetTier, City, Place, PlaceKind, Vibe } from '../../src/types'
import { ToolError, change, cityOf, hasItinerary, loadTrip, placeOf, said, stateOf, type Session } from './trip'

// Everything a person can do in Wayfarer, as MCP tools, for Claude or any other MCP client.
// Each tool acts as the signed-in person, through the same store functions and reducer actions
// the app uses, so the same rules hold: only a trip's admin changes its plan, everyone in it can
// post and split costs, and the server decides who sees what. A session is about one trip.

const KINDS = ['sight', 'food', 'cafe', 'bar', 'park', 'museum', 'market', 'viewpoint'] as const
const VIBES = ['food', 'culture', 'nightlife', 'nature', 'art', 'shopping', 'relaxed', 'adventure', 'romantic', 'history'] as const

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): Text => ({ content: [{ type: 'text', text }] })
const fail = (text: string): Text => ({ content: [{ type: 'text', text }], isError: true })

const today = () => new Date().toISOString().slice(0, 10)
const money = (minor: number, code: string) => fmtMoney(minor, code)

function placeLine(p: Place, extra = ''): string {
  const prof = profileOf(p)
  const yes = audiencesOfProfile(prof).yes.slice(0, 3).map(a => AUDIENCE_LABEL[a])
  return `${p.id} | ${p.name} | ${p.kind} | ${p.price ? '$'.repeat(p.price) : 'free'} | ~${p.minutes} min | best ${p.bestAt ?? 'any time'} | ${p.blurb}${yes.length ? ` | good for ${yes.join(', ')}` : ''}${p.found ? ' | added by travellers' : ''}${extra}`
}

function itineraryText(st: TripState, day?: number): string {
  const city = cityOf(st)
  const days = st.days.filter(d => !day || d.day === day)
  if (!days.length) return day ? `There’s no Day ${day}.` : 'No days planned yet.'
  const start = st.brief.startDate
  const dateOf = (n: number) => (start ? new Date(new Date(`${start}T00:00:00Z`).getTime() + (n - 1) * 86_400_000).toISOString().slice(0, 10) : null)
  return days.map(d => [
    `Day ${d.day}${dateOf(d.day) ? ` (${dateOf(d.day)})` : ''}: ${d.title}`,
    ...d.stops.map((s, i) => `  ${i + 1}. ${fmtClock(s.arrive)}–${fmtClock(s.depart)} ${s.place.name} [${s.place.id}] ${s.place.kind}${s.legIn ? ` (${s.legIn.minutes} min ${s.legIn.mode} from the last stop)` : ''}${s.bufferAfter >= 45 ? `, then ${s.bufferAfter} min free` : ''}`),
  ].join('\n')).join('\n') + (st.hotel ? `\nBase: ${st.hotel.hotel.name} [${st.hotel.hotel.id}], $${st.hotel.hotel.nightly}/night in ${city.name}` : '\nNo hotel chosen yet.')
}

export function registerTools(server: McpServer, db: Db, s: Session) {
  // every tool: rate limited per person, recorded in the activity log, errors as plain words
  const tool = <A extends z.ZodRawShape>(name: string, config: { title: string; description: string; input: A; read?: boolean; destructive?: boolean; needsTrip?: boolean }, run: (args: z.infer<z.ZodObject<A>>) => Promise<string>) => {
    server.registerTool(name, {
      title: config.title,
      description: config.description,
      inputSchema: config.input,
      annotations: { readOnlyHint: Boolean(config.read), destructiveHint: Boolean(config.destructive), openWorldHint: false },
    }, (async (args: z.infer<z.ZodObject<A>>) => {
      const started = Date.now()
      if (overLimit(`mcp:${s.user.id}`, 900, 3_600_000)) return fail('That’s a lot of requests this hour. Try again in a bit.')
      try {
        if (config.needsTrip !== false && !s.tripId) throw new ToolError('No trip chosen yet. Call list_trips, ask the person which trip they mean, then call choose_trip.')
        const text = await run(args)
        track('mcp.tool', { userId: s.user.id, subject: name, detail: { trip: s.tripId ?? null, ok: true, ms: Date.now() - started, client: s.clientName } })
        return ok(text)
      } catch (err) {
        const known = err instanceof ToolError || err instanceof HttpError || err instanceof PlaceError
        if (!known) console.error('[mcp]', name, err)
        track('mcp.tool', { userId: s.user.id, subject: name, detail: { trip: s.tripId ?? null, ok: false, error: (err as Error).message.slice(0, 200), client: s.clientName } })
        return fail(known ? (err as Error).message : 'Something went wrong on Wayfarer’s side. Try again.')
      }
    }) as never)
  }

  const trip = async () => {
    const t = await loadTrip(db, s)
    return { t, st: stateOf(s, t) }
  }
  const groupState = async (): Promise<GroupState> => {
    const t = await loadTrip(db, s)
    return store.readState(db, t.group, t.me)
  }
  const nameIn = (g: GroupState) => (id: string) => g.members.find(m => m.id === id)?.name ?? 'someone'

  // ── trips ──────────────────────────────────────────────────────────────────

  tool('list_trips', {
    title: 'List my trips',
    description: 'The person’s trips in Wayfarer (every trip they plan or were invited to). Call this first in a session, show the list, and ask which trip they mean before doing anything else.',
    input: {}, read: true, needsTrip: false,
  }, async () => {
    const groups = await store.listGroups(db, s.user.id)
    if (!groups.length) return 'No trips yet. A trip appears here once its itinerary is approved in the app, or make one now with create_trip.'
    const rows = await Promise.all(groups.map(async g => {
      const row = await db.one<{ trip: string | null; plan_version: number }>('SELECT trip, plan_version FROM money_groups WHERE id = ?', g.id)
      const t = row?.trip ? JSON.parse(row.trip) as { city?: string; days?: number; startDate?: string | null } : null
      return `${g.id} | ${g.name} | ${t?.city ?? g.city ?? 'no city yet'}${t?.days ? `, ${t.days} days` : ''}${t?.startDate ? ` from ${t.startDate}` : ''} | ${g.role === 'owner' ? 'you run it' : 'you were invited'} | ${g.memberCount} ${g.memberCount === 1 ? 'person' : 'people'} | plan: ${g.phase ?? 'none yet'}`
    }))
    return `${rows.join('\n')}${s.tripId ? `\n\nCurrently chosen: ${s.tripId}` : '\n\nAsk which one they mean, then call choose_trip.'}`
  })

  tool('choose_trip', {
    title: 'Choose the trip',
    description: 'Make one trip the subject of this session, by its id from list_trips. Everything after this acts on it. Call again to switch.',
    input: { trip_id: z.string().min(8).max(64) }, read: true, needsTrip: false,
  }, async ({ trip_id }) => {
    s.tripId = trip_id
    s.state = undefined
    const t = await loadTrip(db, s)
    track('mcp.trip_chosen', { userId: s.user.id, subject: t.group.id, detail: { client: s.clientName } })
    return `Now working on “${t.group.name}”. You are ${t.me.role === 'owner' ? 'its admin, so you can change the plan' : 'a member: you can look at everything, post in its chat and split costs, but only the admin changes the plan'}.\n\n${t.plan ? overview(stateOf(s, t), t.group.name) : 'It has no plan yet.'}`
  })

  const overview = (st: TripState, name: string) => {
    const city = cityOf(st)
    const b = st.brief
    const costs = st.days.length ? estimateCosts(b, st.days, city, st.hotel) : null
    return [
      `Trip: ${name}, ${city.name}, ${city.country}`,
      `Stage: ${st.phase}${b.startDate ? ` · starts ${b.startDate}` : ' · no dates set'} · ${b.days ?? st.days.length} days · ${b.travelers ?? 2} travellers · vibe ${b.vibes.join(', ') || 'a bit of everything'} · budget ${b.budgetAmount ? `$${b.budgetAmount}` : b.budgetTier ?? 'not set'}`,
      st.days.length ? `Days: ${st.days.map(d => `Day ${d.day} ${d.title} (${d.stops.length} stops)`).join('; ')}` : 'No itinerary yet.',
      st.hotel ? `Base: ${st.hotel.hotel.name}, $${st.hotel.hotel.nightly}/night` : 'No base hotel chosen.',
      costs ? `Estimated cost for the group: ~$${Math.round(costs.total)} (excluding flights)` : '',
      `Money: ${city.essentials.currency.code}, time zone ${city.essentials.timezone}`,
    ].filter(Boolean).join('\n')
  }

  tool('trip_overview', {
    title: 'Trip overview',
    description: 'The chosen trip at a glance: city, dates, travellers, budget, the days, the hotel and the estimated cost.',
    input: {}, read: true,
  }, async () => {
    const { t, st } = await trip()
    return overview(st, t.group.name)
  })

  tool('get_itinerary', {
    title: 'Get the itinerary',
    description: 'The plan day by day: every stop with its time, place id, kind and how you get there, plus free time and the base hotel. Optionally one day.',
    input: { day: z.number().int().min(1).max(14).optional() }, read: true,
  }, async ({ day }) => {
    const { st } = await trip()
    if (!hasItinerary(st)) return `No itinerary yet (the trip is at “${st.phase}”).`
    const ahead = bookAhead(st.days, st.hotel)
    return `${itineraryText(st, day)}${!day && ahead.length ? `\n\nBook ahead: ${ahead.map(b => `${b.title}${b.day ? ` (Day ${b.day})` : ''}: ${b.why}`).join('; ')}` : ''}`
  })

  tool('travel_needs', {
    title: 'What to book',
    description: 'Everything needed to look for flights and hotels for this trip: the destination city and country, the dates (or that they aren’t set), nights, travellers, budget, where the days are (the area to stay in), the chosen base, and local money and time zone. Use it, then search the web for flights and hotels, and record what they book with save_booking.',
    input: {}, read: true,
  }, async () => {
    const { st } = await trip()
    const city = cityOf(st)
    const b = st.brief
    const nights = Math.max(1, (b.days ?? st.days.length ?? 1))
    const stops = st.days.flatMap(d => d.stops.map(x => x.place))
    const mid = stops.length ? [stops.reduce((n, p) => n + p.coord[0], 0) / stops.length, stops.reduce((n, p) => n + p.coord[1], 0) / stops.length] as [number, number] : city.center
    const nearest = [...stops].sort((a, b2) => haversineKm(a.coord, mid) - haversineKm(b2.coord, mid))[0]
    const end = b.startDate ? new Date(new Date(`${b.startDate}T00:00:00Z`).getTime() + nights * 86_400_000).toISOString().slice(0, 10) : null
    return [
      `Destination: ${city.name}, ${city.country} (map centre ${city.center[1].toFixed(4)}, ${city.center[0].toFixed(4)})`,
      b.startDate ? `Dates: arrive ${b.startDate}, leave ${end} (${nights} nights)` : `Dates: not set yet (${nights} nights). Ask the person, and set them with update_trip.`,
      `Travellers: ${b.travelers ?? 2}`,
      `Budget: ${b.budgetAmount ? `$${b.budgetAmount} total for the group` : b.budgetTier ?? 'not set'}`,
      `Best area to stay: around ${mid[1].toFixed(4)}, ${mid[0].toFixed(4)}${nearest ? `, near ${nearest.name}` : ''} (the middle of the planned days)`,
      st.hotel ? `Chosen base in the app: ${st.hotel.hotel.name} (~$${st.hotel.hotel.nightly}/night)` : 'No base chosen in the app yet.',
      `Local money: ${city.essentials.currency.code}; time zone ${city.essentials.timezone}`,
      `The person’s home isn’t known: ask where they’re flying from.`,
    ].join('\n')
  })

  tool('update_trip', {
    title: 'Update trip details',
    description: 'Change the trip’s start date, number of travellers or budget (admin only). For the number of days or the plan itself, use change_trip.',
    input: {
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      travelers: z.number().int().min(1).max(30).optional(),
      budget_usd: z.number().int().min(0).max(10_000_000).optional(),
      budget_tier: z.enum(['shoestring', 'comfort', 'luxury']).optional(),
    },
  }, async a => {
    if (a.start_date && Number.isNaN(Date.parse(a.start_date))) throw new ToolError('That isn’t a real date.')
    const { st } = await trip()
    const brief = { ...st.brief, ...(a.start_date ? { startDate: a.start_date } : {}), ...(a.travelers ? { travelers: a.travelers } : {}), ...(a.budget_usd !== undefined ? { budgetAmount: a.budget_usd || undefined } : {}), ...(a.budget_tier ? { budgetTier: a.budget_tier as BudgetTier } : {}) }
    return change(db, s, [{ type: 'brief', brief }], () => `Updated: ${Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ')}.`, { needItinerary: false })
  })

  // ── places ─────────────────────────────────────────────────────────────────

  tool('search_places', {
    title: 'Search places',
    description: 'Search every place Wayfarer knows in the trip’s city (thousands in big cities, including ones travellers added): by words (name, cuisine, style), by kind, near a place, or a mix. Up to 20, best match first.',
    input: { query: z.string().max(80).optional(), kind: z.enum(KINDS).optional(), near_place_id: z.string().max(80).optional(), within_km: z.number().min(0.2).max(30).optional() }, read: true,
  }, async ({ query, kind, near_place_id, within_km }) => {
    const { st } = await trip()
    const city = cityOf(st)
    if (!query && !kind && !near_place_id) throw new ToolError('Give words, a kind or a place to search near.')
    const near = near_place_id ? placeOf(st, near_place_id) : undefined
    if (near_place_id && !near) throw new ToolError(`No place with id ${near_place_id}.`)
    const words = String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2)
    const planned = new Set(st.days.flatMap(d => d.stops.map(x => x.place.id)))
    const radius = within_km ?? 2.5
    const hits = city.places
      .filter(p => !kind || p.kind === kind)
      .map(p => {
        const text = `${p.name} ${p.keywords?.join(' ') ?? ''} ${p.tags.join(' ')} ${p.blurb}`.toLowerCase()
        const matched = words.filter(w => text.includes(w)).length + words.filter(w => p.name.toLowerCase().includes(w)).length
        return { p, matched, km: near ? haversineKm(near.coord, p.coord) : 0, score: scorePlace(p, st.brief).score }
      })
      .filter(x => (!words.length || x.matched > 0) && (!near || (x.p.id !== near.id && x.km <= radius)))
      .sort((a, b) => b.matched - a.matched || (near ? a.km - b.km : 0) || b.score - a.score)
      .slice(0, 20)
    if (!hits.length) return `Nothing like that in Wayfarer’s ${city.name} places. If you found a real place on the web, add it with add_places.`
    return hits.map(({ p, km }) => placeLine(p, `${planned.has(p.id) ? ' | in the plan' : ''}${near ? ` | ${km.toFixed(1)} km away` : ''}`)).join('\n')
  })

  tool('suggest_places', {
    title: 'Suggest places',
    description: 'Places not yet in the plan that best fit this trip (its vibe, budget, sliders and who’s going), with why. Optionally of one kind.',
    input: { kind: z.enum(KINDS).optional(), count: z.number().int().min(1).max(30).optional() }, read: true,
  }, async ({ kind, count }) => {
    const { st } = await trip()
    const city = cityOf(st)
    const planned = new Set(st.days.flatMap(d => d.stops.map(x => x.place.id)))
    const best = city.places.filter(p => !planned.has(p.id) && (!kind || p.kind === kind))
      .map(p => ({ p, ...scorePlace(p, st.brief) })).sort((a, b) => b.score - a.score).slice(0, count ?? 12)
    return best.map(x => placeLine(x.p, ` | why: ${x.why}`)).join('\n') || 'Nothing left to suggest.'
  })

  tool('place_details', {
    title: 'Place details',
    description: 'Everything Wayfarer knows about one place: what it is, price, visit length, best time, what it’s good and bad at, who it suits, where it is, and whether it’s in the plan.',
    input: { place_id: z.string().max(80) }, read: true,
  }, async ({ place_id }) => {
    const { st } = await trip()
    const p = placeOf(st, place_id)
    if (!p) throw new ToolError(`No place with id ${place_id}.`)
    const prof = profileOf(p)
    const { yes, no } = audiencesOfProfile(prof)
    const day = st.days.find(d => d.stops.some(x => x.place.id === p.id))
    return [
      `${p.name} (${p.kind}) [${p.id}]`, p.blurb,
      `Price ${p.price ? '$'.repeat(p.price) : 'free'} · about ${p.minutes} min · best ${p.bestAt ?? 'any time'}${p.book ? ` · book ahead: ${p.book}` : ''}`,
      `Where: ${p.coord[1].toFixed(5)}, ${p.coord[0].toFixed(5)}${p.custom?.address ? ` (${p.custom.address})` : ''}`,
      p.keywords?.length ? `Known for: ${p.keywords.join(', ')}` : '',
      prof.strengths.length ? `Good: ${prof.strengths.join('; ')}` : '',
      prof.weaknesses.length ? `Know before going: ${prof.weaknesses.join('; ')}` : '',
      yes.length ? `Suits: ${yes.map(a => AUDIENCE_LABEL[a]).join(', ')}` : '', no.length ? `Not for: ${no.map(a => AUDIENCE_LABEL[a]).join(', ')}` : '',
      day ? `In the plan on Day ${day.day}` : 'Not in the plan',
    ].filter(Boolean).join('\n')
  })

  tool('place_videos', {
    title: 'Reels and videos of a place',
    description: 'Instagram reels, TikToks and YouTube videos that name the place, with links.',
    input: { place_id: z.string().max(80) }, read: true,
  }, async ({ place_id }) => {
    const { st } = await trip()
    const p = placeOf(st, place_id)
    if (!p) throw new ToolError(`No place with id ${place_id}.`)
    const { videos } = await placeVideos({ name: p.name, city: cityOf(st).name, area: p.custom?.address })
    if (!videos.length) return `No videos found that name ${p.name}.`
    return videos.map(v => `${v.platform}${v.short ? ' short' : ''}: “${v.title}”${v.by ? ` by ${v.by}` : ''} ${v.platform === 'youtube' ? `https://www.youtube.com/watch?v=${v.id}` : v.platform === 'tiktok' ? `https://www.tiktok.com/@${v.by}/video/${v.id}` : `https://www.instagram.com/reel/${v.id}/`}`).join('\n')
  })

  // ── changing the plan (the admin) ──────────────────────────────────────────

  const dayOf = (st: TripState, id: string) => st.days.find(d => d.stops.some(x => x.place.id === id))

  tool('add_stop', {
    title: 'Add a place to a day',
    description: 'Put a place Wayfarer knows (by id) into a day. It goes where it adds the least travel.',
    input: { place_id: z.string().max(80), day: z.number().int().min(1).max(14) },
  }, async ({ place_id, day }) => {
    const { st } = await trip()
    const p = placeOf(st, place_id)
    if (!p) throw new ToolError(`No place with id ${place_id}. For somewhere new, use add_places.`)
    if (dayOf(st, place_id)) return `${p.name} is already on Day ${dayOf(st, place_id)!.day}.`
    if (!st.days.some(d => d.day === day)) throw new ToolError(`There’s no Day ${day}.`)
    return change(db, s, [{ type: 'add-stop', id: place_id, day }], (_, after) => {
      const x = after.days.find(d => d.day === day)?.stops.find(y => y.place.id === place_id)
      return x ? `Added ${p.name} to Day ${day}, ${fmtClock(x.arrive)}–${fmtClock(x.depart)}.` : `Couldn’t add ${p.name}.`
    })
  })

  tool('remove_stop', {
    title: 'Remove a stop',
    description: 'Take a stop out of the plan. A day keeps at least one stop.',
    input: { place_id: z.string().max(80) }, destructive: true,
  }, async ({ place_id }) => {
    const { st } = await trip()
    const d = dayOf(st, place_id)
    if (!d) throw new ToolError(`${place_id} isn’t in the plan.`)
    const name = d.stops.find(x => x.place.id === place_id)!.place.name
    return change(db, s, [{ type: 'remove-stop', id: place_id }], (_, after) => (dayOf(after, place_id) ? `Couldn’t remove ${name}: it’s the only stop on Day ${d.day}.` : `Removed ${name} from Day ${d.day}.`))
  })

  tool('move_stop', {
    title: 'Move a stop to another day',
    description: 'Move a planned stop to another day.',
    input: { place_id: z.string().max(80), to_day: z.number().int().min(1).max(14) },
  }, async ({ place_id, to_day }) => {
    const { st } = await trip()
    const d = dayOf(st, place_id)
    if (!d) throw new ToolError(`${place_id} isn’t in the plan.`)
    if (!st.days.some(x => x.day === to_day)) throw new ToolError(`There’s no Day ${to_day}.`)
    return change(db, s, [{ type: 'move-stop', id: place_id, toDay: to_day }], (_, after) => (dayOf(after, place_id)?.day === to_day ? `Moved it to Day ${to_day}.` : `Couldn’t move it: Day ${d.day} needs at least one stop.`))
  })

  tool('reorder_stop', {
    title: 'Reorder a stop',
    description: 'Move a stop one place earlier or later within its day.',
    input: { place_id: z.string().max(80), direction: z.enum(['earlier', 'later']) },
  }, async ({ place_id, direction }) => {
    const { st } = await trip()
    if (!dayOf(st, place_id)) throw new ToolError(`${place_id} isn’t in the plan.`)
    return change(db, s, [{ type: 'shift-stop', id: place_id, dir: direction === 'earlier' ? -1 : 1 }], (_, after) => {
      const d = dayOf(after, place_id)!
      return `Day ${d.day} is now: ${d.stops.map(x => x.place.name).join(' → ')}.`
    })
  })

  tool('tidy_day', {
    title: 'Tidy a day',
    description: 'Re-order a day by time of day and travel, the way the app’s Tidy button does.',
    input: { day: z.number().int().min(1).max(14) },
  }, async ({ day }) => change(db, s, [{ type: 'optimize-day', day }], (_, after) => {
    const d = after.days.find(x => x.day === day)
    return d ? `Day ${day} is now: ${d.stops.map(x => x.place.name).join(' → ')}.` : `There’s no Day ${day}.`
  }))

  tool('fill_gap', {
    title: 'Fill a free stretch',
    description: 'Fill the longest free stretch in a day with something nearby that fits.',
    input: { day: z.number().int().min(1).max(14) },
  }, async ({ day }) => change(db, s, [{ type: 'fill-gap', day }], (before, after) => after.thoughts.slice(before.thoughts.length).map(t => t.text).join(' ') || `Nothing changed on Day ${day}.`))

  tool('choose_hotel', {
    title: 'Choose the base hotel',
    description: 'Make one of the trip’s scored hotels the base (ids from trip_overview’s hotels list via list_hotels).',
    input: { hotel_id: z.string().max(80) },
  }, async ({ hotel_id }) => {
    const { st } = await trip()
    const h = st.hotelScores.find(x => x.hotel.id === hotel_id)
    if (!h) throw new ToolError(`${hotel_id} isn’t one of the scored hotels. Call list_hotels.`)
    return change(db, s, [{ type: 'choose-hotel', id: hotel_id }], () => `${h.hotel.name} is now the base ($${h.hotel.nightly}/night, ~${Math.round(h.avgCommute)} min to each day).`)
  })

  tool('list_hotels', {
    title: 'Hotels scored for this trip',
    description: 'The hotels Wayfarer scored for the itinerary: price, budget tier, commute to each day, and which is the base. For real availability and prices, search the web with travel_needs.',
    input: {}, read: true,
  }, async () => {
    const { st } = await trip()
    if (!st.hotelScores.length) return 'No hotels scored yet: the itinerary needs approving in the app first.'
    return [...st.hotelScores].sort((a, b) => b.total - a.total).map(h => `${h.hotel.id} | ${h.hotel.name} | $${h.hotel.nightly}/night | ${h.hotel.tier} | ~${Math.round(h.avgCommute)} min to each day | fit ${Math.round(h.total * 100)}%${st.hotel?.hotel.id === h.hotel.id ? ' | the base' : ''} | ${h.hotel.blurb}`).join('\n')
  })

  tool('change_trip', {
    title: 'Change the trip in words',
    description: 'Any other change, in plain words, for Wayfarer’s edit engine, the same one as typing in the app’s chat: “add a day”, “make it 2 days”, “start day 2 at 10am”, “more relaxed”, “cheaper hotel”, “swap Skytree for something cheaper”, “more food on day 3”. One change per call.',
    input: { instruction: z.string().min(2).max(200) },
  }, async ({ instruction }) => change(db, s, [{ type: 'chat-edit', text: instruction }], (before, after) => said(before, after) || 'Nothing changed: try saying it another way.'))

  tool('undo', {
    title: 'Undo',
    description: 'Undo the last change made in this session.',
    input: {},
  }, async () => change(db, s, [{ type: 'undo' }], (before, after) => said(before, after) || 'Nothing to undo in this session.'))

  // Research: places found on the web, added by name or maps link. Each is found on the map
  // and described; a real attraction, restaurant or bar also joins the city for everyone
  // (unclear ones go to the owner's review first), exactly as when added in the app.
  tool('add_places', {
    title: 'Add places you found',
    description: 'Add real places that aren’t in Wayfarer yet, found by research: by the name they’re known by locally, or a Google Maps / Apple Maps / OpenStreetMap link, or both. Give kind (“ramen”, “jazz bar”, “viewpoint”) to tell it apart from others with the same name. With a day, it goes into that day of the plan; without, it’s saved to the trip (and dealt into the swipe deck). Up to 15 at a time; each is looked up on the map, so expect a second or two per place.',
    input: {
      places: z.array(z.object({
        name: z.string().max(120).optional(),
        link: z.string().max(2000).optional(),
        kind: z.string().max(40).optional(),
        day: z.number().int().min(1).max(14).optional(),
      })).min(1).max(15),
    },
  }, async ({ places }) => {
    const lines: string[] = []
    for (const want of places) {
      if (!want.name && !want.link) { lines.push('Skipped one with neither a name nor a link.'); continue }
      const label = want.name ?? want.link!
      try {
        const { st } = await trip()
        const found = await resolvePlace({ name: want.name, link: want.link, kind: want.kind, city: st.brief.destination }, undefined, s.user.id)
        const msg = await change(db, s, [{ type: 'add-custom-place', place: found.place, day: want.day, note: found.note }], (before, after) => said(before, after), { needItinerary: false })
        lines.push(`${found.place.name} [${found.place.id}]: ${msg || 'added.'}${found.shared ? ' It’s now in the city’s places for other travellers too.' : ''}`)
      } catch (err) {
        if (err instanceof ToolError && /admin/.test(err.message)) throw err
        lines.push(`${label}: ${(err as Error).message}`)
      }
    }
    return lines.join('\n')
  })

  // ── people and the trip chat ───────────────────────────────────────────────

  tool('list_people', {
    title: 'People on the trip',
    description: 'Everyone in the trip: names, member ids, who runs it, who has joined and who’s still invited.',
    input: {}, read: true,
  }, async () => {
    const g = await groupState()
    return g.members.filter(m => !m.left).map(m => `${m.id} | ${m.name}${m.id === g.me ? ' (you)' : ''}${m.role === 'owner' ? ' | admin' : ''}${m.joined ? '' : ` | invited${m.waitingEmail ? ` (${m.waitingEmail})` : ''}, not joined yet`}`).join('\n')
  })

  tool('invite_person', {
    title: 'Invite someone',
    description: 'Add someone to the trip by email, so they can see the plan, vote and split costs. They get it as soon as they sign in with that address.',
    input: { email: z.string().email().max(200) },
  }, async ({ email }) => {
    const t = await loadTrip(db, s)
    await store.addMember(db, t.group, t.me, { email: email.trim().toLowerCase() })
    await publish(db, t.group.id)
    return `Added ${email}. If they have a Wayfarer account they can see the trip now; otherwise it’s theirs once they sign up with that address.`
  })

  tool('read_chat', {
    title: 'Read the trip chat',
    description: 'The trip group’s chat: what people said, newest last.',
    input: {}, read: true,
  }, async () => {
    const t = await loadTrip(db, s)
    const shared = await store.readTrip(db, t.group, t.me, t.group.plan_version)
    const name = (id: string) => shared.people.find(p => p.id === id)?.name ?? 'someone'
    return shared.notes.map(n => `${new Date(n.createdAt).toISOString().slice(0, 16).replace('T', ' ')} ${name(n.memberId)}: ${n.body}`).join('\n') || 'No messages yet.'
  })

  tool('post_note', {
    title: 'Post in the trip chat',
    description: 'Post a message in the trip group’s chat, as the person. Only post what they asked you to.',
    input: { text: z.string().min(1).max(1000) },
  }, async ({ text }) => {
    const t = await loadTrip(db, s)
    await store.addNote(db, t.group, t.me, randomUUID(), text.trim())
    await publish(db, t.group.id)
    return 'Posted.'
  })

  tool('save_booking', {
    title: 'Save a booking',
    description: 'Record something booked for the trip (a flight, hotel, train, tour, ticket) in the trip chat so everyone sees it, and, with a cost, as a shared expense split equally. Use after the person confirms what they booked.',
    input: {
      kind: z.enum(['flight', 'hotel', 'train', 'tour', 'ticket', 'other']),
      title: z.string().min(2).max(120),
      details: z.string().max(600).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      link: z.string().url().max(500).optional(),
      cost: z.number().positive().max(10_000_000).optional(),
      currency: z.string().length(3).optional(),
    },
  }, async a => {
    const t = await loadTrip(db, s)
    const icon = { flight: '✈️', hotel: '🏨', train: '🚆', tour: '🧭', ticket: '🎟️', other: '📌' }[a.kind]
    const note = `${icon} Booked: ${a.title}${a.date ? ` (${a.date})` : ''}${a.details ? `. ${a.details}` : ''}${a.link ? ` ${a.link}` : ''}`
    await store.addNote(db, t.group, t.me, randomUUID(), note.slice(0, 1000))
    let spent = ''
    if (a.cost) {
      const category = a.kind === 'flight' || a.kind === 'train' ? 'transport' : a.kind === 'hotel' ? 'stay' : a.kind === 'tour' || a.kind === 'ticket' ? 'activities' : null
      spent = ' ' + await addExpense({ title: a.title, amount: a.cost, currency: a.currency, category: category ?? undefined, date: a.date })
    }
    await publish(db, t.group.id)
    return `Saved to the trip chat.${spent}`
  })

  // ── money ──────────────────────────────────────────────────────────────────

  async function rateTo(groupCurrency: string, from: string): Promise<number> {
    if (from === groupCurrency) return 1
    const r = await getRates(db, from)
    const rate = r?.rates[groupCurrency]
    if (!rate) throw new ToolError(`No exchange rate from ${from} to ${groupCurrency} right now. Log it in ${groupCurrency}.`)
    return rate
  }

  async function addExpense(a: { title: string; amount: number; currency?: string; category?: string; date?: string; paid_by?: string; split_between?: string[]; place_id?: string; notes?: string; just_for_me?: boolean }): Promise<string> {
    const t = await loadTrip(db, s)
    const g = await store.readState(db, t.group, t.me)
    const currency = (a.currency ?? g.group.currency).toUpperCase()
    if (!CURRENCIES.includes(currency) && currency !== g.group.currency) throw new ToolError(`Wayfarer doesn’t take ${currency}. Use one of: ${CURRENCIES.join(', ')}.`)
    const active = g.members.filter(m => !m.left)
    const payer = a.paid_by ?? g.me
    if (!active.some(m => m.id === payer)) throw new ToolError(`No member ${payer}. Call list_people.`)
    const between = a.just_for_me ? [g.me] : a.split_between?.length ? a.split_between : active.map(m => m.id)
    const unknown = between.filter(id => !active.some(m => m.id === id))
    if (unknown.length) throw new ToolError(`Not members of this trip: ${unknown.join(', ')}. Call list_people.`)
    const minor = Math.round(a.amount * 10 ** currencyDigits(currency))
    const st = t.plan ? stateOf(s, t) : undefined
    const place = a.place_id && st ? placeOf(st, a.place_id) : undefined
    const category = (a.category && (CATEGORY_IDS as readonly string[]).includes(a.category) ? a.category : place ? categoryForKind(place.kind) : guessCategory(a.title) ?? 'other') as ExpenseInput['category']
    const input: ExpenseInput = {
      id: randomUUID(), title: a.title.slice(0, 120), amount: minor, currency, fxRate: await rateTo(g.group.currency, currency),
      category, date: a.date ?? today(), notes: (a.notes ?? '').slice(0, 1000),
      payers: [{ memberId: payer, amount: minor }],
      split: { method: 'equal', entries: between.map(memberId => ({ memberId, value: 1 })) },
      private: Boolean(a.just_for_me), placeId: place?.id ?? null, placeName: place?.name ?? null,
    }
    await store.createExpense(db, t.group, t.me, input)
    await publish(db, t.group.id)
    return `Logged “${input.title}”, ${money(minor, currency)}${currency !== g.group.currency ? ` (≈ ${money(Math.round(minor * input.fxRate * 10 ** (currencyDigits(g.group.currency) - currencyDigits(currency))), g.group.currency)})` : ''}, paid by ${nameIn(g)(payer)}, ${a.just_for_me ? 'just for them' : `split between ${between.length}`} [${input.id}].`
  }

  tool('money_summary', {
    title: 'Money summary',
    description: 'The trip’s shared money: total spent, budget and how fast it’s going, who owes whom (simplified), spending by category, by day and by person, and the planner’s estimate against what was actually spent.',
    input: {}, read: true,
  }, async () => {
    const g = await groupState()
    const c = g.group.currency
    const name = nameIn(g)
    const live = g.expenses.filter(e => !e.deletedAt)
    const totals = totalsFor(g)
    const net = netBalances(g.expenses, g.settlements)
    const debts = simplifyDebts(net)
    const pace = g.group.budget ? budgetPace(g.group.budget, totals.groupTotal, g.group.trip, today()) : null
    const planned = g.group.trip ? plannedVsActual(g.expenses, Object.fromEntries(Object.entries(g.group.trip.plannedUsd).map(([k, usd]) => [k, Math.round((usd ?? 0) * 10 ** currencyDigits(c))]))) : []
    return [
      `Currency ${c}. ${live.length} expenses. Group total ${money(totals.groupTotal, c)}; your share ${money(totals.myShare, c)}, you paid ${money(totals.myPaid, c)}, just-for-you ${money(totals.myPrivate, c)}.`,
      pace ? `Budget ${money(pace.budget, c)}: ${Math.round(pace.used * 100)}% used, ${money(pace.left, c)} left${pace.perDayLeft !== null ? `, about ${money(pace.perDayLeft, c)} a day for the ${pace.daysLeft} days left` : ''}.` : 'No group budget set.',
      `Who owes whom: ${debts.length ? debts.map(d => `${name(d.from)} → ${name(d.to)} ${money(d.amount, c)}`).join('; ') : 'everyone is settled'}.`,
      `By category: ${spendByCategory(g.expenses, 'group', g.me).map(x => `${categoryOf(x.category).label} ${money(x.amount, c)}`).join(', ') || 'nothing yet'}.`,
      `By day: ${spendByDate(g.expenses, 'group', g.me).map(x => `${x.date} ${money(x.amount, c)}`).join(', ') || 'nothing yet'}.`,
      `By person (paid / share): ${spendByMember(g.expenses, g.members.filter(m => !m.left).map(m => m.id)).map(x => `${name(x.memberId)} ${money(x.paid, c)} / ${money(x.share, c)}`).join(', ')}.`,
      planned.length ? `Planned (the app’s estimate, roughly, in ${c}) vs actual: ${planned.map(p => `${p.key} ${money(p.planned, c)} vs ${money(p.actual, c)}`).join(', ')}.` : '',
    ].filter(Boolean).join('\n')
  })

  tool('list_expenses', {
    title: 'List expenses',
    description: 'Every expense on the trip as rows, for analysis: id, date, title, category, amount in its own currency and the group’s, who paid, who shares it, notes and the place. Filter by dates, category, person or words.',
    input: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      category: z.enum(CATEGORY_IDS).optional(),
      member_id: z.string().max(80).optional(),
      query: z.string().max(80).optional(),
      include_deleted: z.boolean().optional(),
    }, read: true,
  }, async f => {
    const g = await groupState()
    const c = g.group.currency
    const name = nameIn(g)
    const rows = g.expenses
      .filter(e => (f.include_deleted || !e.deletedAt) && (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to) && (!f.category || e.category === f.category))
      .filter(e => !f.member_id || e.payers.some(p => p.memberId === f.member_id) || (e.baseOwed[f.member_id] ?? 0) > 0)
      .filter(e => !f.query || `${e.title} ${e.notes} ${e.placeName ?? ''}`.toLowerCase().includes(f.query.toLowerCase()))
      .sort((a, b) => a.date.localeCompare(b.date))
    if (!rows.length) return 'No expenses match.'
    return ['id | date | title | category | amount | in ' + c + ' | paid by | shared by | place | notes',
      ...rows.map(e => `${e.id} | ${e.date} | ${e.title} | ${categoryOf(e.category).label} | ${money(e.amount, e.currency)} | ${money(e.baseAmount, c)} | ${e.payers.map(p => name(p.memberId)).join(' + ')} | ${e.privateTo ? 'just them' : Object.keys(e.baseOwed).filter(k => e.baseOwed[k]).map(name).join(', ')} | ${e.placeName ?? ''} | ${e.notes.replace(/\s+/g, ' ').slice(0, 120)}${e.deletedAt ? ' | DELETED' : ''}`)].join('\n')
  })

  tool('add_expense', {
    title: 'Add an expense',
    description: `Log an expense, as the person. Amount in normal units (12.50 for €12.50, 3000 for ¥3,000), in the group’s currency unless currency says otherwise (converted at today’s rate). Paid by the person unless paid_by names a member id; split equally between everyone unless split_between lists member ids; just_for_me keeps it private to them. Categories: ${CATEGORIES.map(x => x.id).join(', ')}.`,
    input: {
      title: z.string().min(1).max(120),
      amount: z.number().positive().max(10_000_000),
      currency: z.string().length(3).optional(),
      category: z.enum(CATEGORY_IDS).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      paid_by: z.string().max(80).optional(),
      split_between: z.array(z.string().max(80)).min(1).max(50).optional(),
      place_id: z.string().max(80).optional(),
      notes: z.string().max(1000).optional(),
      just_for_me: z.boolean().optional(),
    },
  }, async a => addExpense(a))

  tool('delete_expense', {
    title: 'Delete an expense',
    description: 'Delete an expense by id (it can be restored in the app). Only what the person asked for.',
    input: { expense_id: z.string().max(80) }, destructive: true,
  }, async ({ expense_id }) => {
    const t = await loadTrip(db, s)
    await store.setExpenseDeleted(db, t.group, t.me, expense_id, true)
    await publish(db, t.group.id)
    return 'Deleted. It can be restored from the expense in the app.'
  })

  tool('record_payment', {
    title: 'Record a payment',
    description: 'Record that one person paid another back (settling up), in the group’s currency unless currency says otherwise. Member ids from list_people.',
    input: { from: z.string().max(80), to: z.string().max(80), amount: z.number().positive().max(10_000_000), currency: z.string().length(3).optional(), method: z.enum(['cash', 'upi', 'card', 'bank', 'other']).optional(), note: z.string().max(300).optional() },
  }, async a => {
    const t = await loadTrip(db, s)
    const g = await store.readState(db, t.group, t.me)
    const currency = (a.currency ?? g.group.currency).toUpperCase()
    const minor = Math.round(a.amount * 10 ** currencyDigits(currency))
    await store.createSettlement(db, t.group, t.me, { id: randomUUID(), from: a.from, to: a.to, amount: minor, currency, fxRate: await rateTo(g.group.currency, currency), date: today(), note: a.note ?? '', method: a.method ?? 'other' })
    await publish(db, t.group.id)
    return `Recorded: ${nameIn(g)(a.from)} paid ${nameIn(g)(a.to)} ${money(minor, currency)}.`
  })

  // ── a new trip ─────────────────────────────────────────────────────────────

  tool('create_trip', {
    title: 'Create a trip',
    description: 'Make a new trip and plan it with Wayfarer’s planner: a city (any city with a travel guide; one Wayfarer hasn’t mapped yet is built first, which takes about a minute: call again if it says so), days (1-5), and optionally travellers, vibes, budget and start date. It picks the places, routes the days and chooses a base, and becomes the session’s trip. The person can refine it in the app.',
    input: {
      city: z.string().min(2).max(80),
      days: z.number().int().min(1).max(5),
      travelers: z.number().int().min(1).max(30).optional(),
      vibes: z.array(z.enum(VIBES)).max(4).optional(),
      budget_tier: z.enum(['shoestring', 'comfort', 'luxury']).optional(),
      budget_usd: z.number().int().min(0).max(10_000_000).optional(),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      currency: z.string().length(3).optional(),
    }, needsTrip: false,
  }, async a => {
    let city = findCity(a.city) ?? cityById(a.city.toLowerCase())
    if (!city) {
      const look = await lookupCity(a.city, undefined, s.user.id)
      if (look.status === 'unknown') throw new ToolError(`No travel guide found for “${a.city}”. Try its English name or the nearest city.`)
      if (look.status === 'failed') throw new ToolError(look.error)
      if (look.status === 'building') {
        for (let i = 0; i < 40 && buildStatus(look.id)?.status === 'building'; i++) await new Promise(r => setTimeout(r, 1500))
        if (buildStatus(look.id)?.status === 'failed') throw new ToolError(buildStatus(look.id)?.error ?? `Couldn’t map ${look.name}.`)
      }
      city = cityById(look.id)
      if (!city) throw new ToolError(`Still mapping ${look.name}. Call create_trip again in a minute.`)
    }
    const brief = { destination: city.id, days: a.days, travelers: a.travelers ?? 2, vibes: (a.vibes ?? []) as Vibe[], ...(a.budget_tier ? { budgetTier: a.budget_tier as BudgetTier } : {}), ...(a.budget_usd ? { budgetAmount: a.budget_usd } : {}), ...(a.start_date ? { startDate: a.start_date } : {}) }
    let st: TripState = reducer(initialState, { type: 'brief', brief })
    st = reducer(st, { type: 'phase', phase: 'planning' })
    const planner = new MockPlanner(1000)
    const signal = AbortSignal.timeout(60_000)
    for await (const e of planner.planItinerary(brief, signal)) st = reducer(st, { type: 'planner', event: e })
    st = reducer(st, { type: 'phase', phase: 'hotels' })
    for await (const e of planner.findHotels(st.brief, st.days, signal)) st = reducer(st, { type: 'planner', event: e })
    const group = await saveNew(st, city, a.currency)
    track('mcp.trip_created', { userId: s.user.id, subject: group.id, detail: { city: city.id, days: a.days, client: s.clientName } })
    const t = await loadTrip(db, s)
    return `Made “${group.name}” [${group.id}] and planned it. It’s now this session’s trip, and in their Wayfarer app.\n\n${itineraryText(stateOf(s, t))}`
  })

  // A plan made as a new trip of the person's: a group they run, with the plan published as its
  // first version, and the session's trip from now on.
  async function saveNew(st: TripState, city: City, want?: string) {
    const currency = (want ?? (CURRENCIES.includes(city.essentials.currency.code) ? city.essentials.currency.code : 'USD')).toUpperCase()
    const { group, me } = await store.createGroup(db, s.user, { name: `${city.name} trip`, currency, trip: tripSummaryOf(st) })
    st = reducer(st, { type: 'brief', brief: { ...st.brief, moneyGroupId: group.id } })
    await store.publishPlan(db, group, me, { plan: snapshotOf(st), summary: tripSummaryOf(st), baseVersion: 0 })
    s.tripId = group.id
    s.state = undefined
    s.stateVersion = undefined
    return group
  }

  // An itinerary the person already has, as a trip: their days, their order, their places.
  tool('import_itinerary', {
    title: 'Import an itinerary',
    description: 'Turn an itinerary the person already has into a Wayfarer trip: one they pasted into this chat, one from a doc or another app, or one you just wrote together. Pass the text as it is (the city, each day’s places in order, times, the hotel); Wayfarer reads it, matches the places it knows, finds the rest on the map, keeps their order and times, and picks a base if no hotel is named. Up to 14 days. Places it can’t find are listed: add them with add_places and a maps link. Use this rather than create_trip when the person already knows what they want to do. It becomes the session’s trip and appears in their app.',
    input: { text: z.string().min(20).max(30_000), currency: z.string().length(3).optional() }, needsTrip: false,
  }, async a => {
    let r: Imported
    try {
      r = await importItinerary(a.text, { userId: s.user.id })
    } catch (err) {
      if (err instanceof ImportError) throw new ToolError(err.message)
      throw err
    }
    let st: TripState = reducer(initialState, { type: 'brief', brief: r.brief })
    st = reducer(st, { type: 'phase', phase: 'planning' })
    for (const place of r.places) st = reducer(st, { type: 'planner', event: { type: 'candidate', place, verdict: 'keep' } })
    for (const plan of r.days) st = reducer(st, { type: 'planner', event: { type: 'day', plan } })
    st = reducer(st, { type: 'planner', event: { type: 'plan-ready' } })
    for (const score of r.hotelScores) st = reducer(st, { type: 'planner', event: { type: 'hotel-candidate', score } })
    if (r.hotel) st = reducer(st, { type: 'planner', event: { type: 'hotel-pick', score: r.hotel, days: r.days } })
    const group = await saveNew(st, r.city, a.currency)
    track('trip.imported', { userId: s.user.id, subject: group.id, detail: { city: r.city.id, days: r.days.length, places: r.places.length, custom: r.custom.length, missed: r.missed.length, from: 'mcp', client: s.clientName } })
    const t = await loadTrip(db, s)
    return `${importSummary(r)} It’s “${group.name}” [${group.id}], now this session’s trip and in their Wayfarer app.\n\n${itineraryText(stateOf(s, t))}`
  })

  // ── an export ──────────────────────────────────────────────────────────────

  tool('itinerary_text', {
    title: 'Itinerary as text',
    description: 'The whole itinerary as plain text, the same as the app’s export, for sharing or saving.',
    input: {}, read: true,
  }, async () => {
    const { st } = await trip()
    if (!hasItinerary(st)) return 'No itinerary yet.'
    return toText(cityOf(st), st.days, st.hotel, st.brief.startDate)
  })
}

// Helpers a test can reach.
export const _forTests = { placeLine, itineraryText, KINDS: KINDS as readonly PlaceKind[] }
