import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { initialState, isMember, reducer, type Action, type SavedTrip, type TripState } from './state/tripStore'
import { trackAction, trackScreen } from './dev/activity'
import { deleteTrip, groupCopyOf, loadCurrent, loadPanels, loadTrips, localCopyOf, saveCurrent, savePanels, saveTrip, setTripScope, snapshot, newId, type PanelPrefs } from './state/persistence'
import { converse, isReady, nextField } from './planner/intake'
import { MockPlanner } from './planner/mockPlanner'
import { FallbackPlanner, RemotePlanner } from './planner/remotePlanner'
import { claudeIntake, detectBrain, findStay, findVibe, plansRemotely, type BrainStatus } from './planner/brain'
import { hasMood, moodOf } from './planner/story'
import { customPlaceRequest, isFind, mapsHost, resolveCustomPlace, type CustomPlaceRequest } from './planner/customPlaces'
import { runAgent } from './agent/run'
import type { Place, PlannerEvent, TripBrief } from './types'
import { MapCanvas } from './components/MapCanvas'
import { ChatPanel, inertIf, type ChatGroup } from './components/ChatPanel'
import { ThinkingStream } from './components/ThinkingStream'
import { ItineraryPanel } from './components/ItineraryPanel'
import { HotelPanel } from './components/HotelPanel'
import { TopBar } from './components/TopBar'
import { PlaceCard } from './components/PlaceCard'
import { PicksPanel, SwipeDeck, type DeckGroup } from './components/SwipeDeck'
import { Dashboard } from './components/Dashboard'
import { Profile } from './components/Profile'
import { importPastedItinerary, looksLikeItinerary } from './planner/itineraryPaste'
import { useAlerts } from './docs/client'
import { onAlertTapped } from './docs/native'
import { AuthScreen, JoinScreen, MoneyApp, useInvite, useMoneyBadge, type MoneyTrip } from './components/money/MoneyApp'
import type { ExpensePrefill } from './components/money/ExpenseForm'
import { Empty } from './components/money/parts'
import { VaultApp } from './components/vault/VaultApp'
import { InviteFriends } from './components/trip/InviteFriends'
import { GroupPicks, GroupRanking } from './components/trip/GroupPicks'
import { tripSummaryOf } from './money/util'
import { categoryForKind } from './money/categories'
import { api, readLocal, writeLocal } from './money/client'
import { homeCurrency } from './money/currency'
import { unsentCount, useAccount, useGroups, type AccountHandle } from './money/hooks'
import type { GroupState, GroupSummary } from './money/types'
import { useSharedTrip } from './trip/useSharedTrip'
import { myVotes } from './trip/votes'
import type { SharedTrip } from './trip/types'
import { addCatalogPlaces, cityById, findCity } from './data/cities'
import { ensureCity, lookupCity, sendSignals, waitForCity } from './data/cityClient'
import { ShareSheet, type Shared, type ShareTarget } from './components/share/ShareSheet'
import { DevTools } from './components/dev/DevTools'
import type { FoundPlace } from './share/types'
import { useTheme } from './state/theme'
import { MobileSheet, sheetHeights, useIsMobile, type Snap } from './components/MobileSheet'
import { BedIcon, ChatIcon, ChevronIcon, RouteIcon } from './components/Icons'
import { Memphis } from './components/Memphis'

// The native shell's App plugin (Capacitor), when running in the iPhone app.
type NativeApp = { Capacitor?: { Plugins?: { App?: {
  getLaunchUrl?: () => Promise<{ url?: string } | undefined>
  addListener?: (event: 'appUrlOpen', fn: (e: { url: string }) => void) => Promise<{ remove: () => void }> | { remove: () => void }
} } } }

// Everyone signs in first. Someone following an invite link then joins that group.
export default function App() {
  const acct = useAccount()
  const [join, setJoin] = useState(() => new URLSearchParams(location.search).get('join'))
  const [guest, setGuest] = useState(false)
  const { invite, error: inviteError } = useInvite(join, acct.account?.id)

  const finishJoin = useCallback((groupId: string | null) => {
    if (groupId) writeLocal('activeTrip', groupId)
    setJoin(null)
    history.replaceState(null, '', location.pathname)
  }, [])

  // before anything below reads trips from this browser
  setTripScope(acct.account?.id ?? null)

  if (acct.status === 'loading' && !acct.account) return <div className="dash m-app"><div className="m-center"><div className="m-skeleton m-auth" /></div></div>

  if (!acct.account && !guest) {
    if (acct.status === 'ready') return <div className="dash m-app"><AuthScreen inviteName={invite?.groupName} onDone={acct.signedIn} /></div>
    // The planner works without a server, so a dead connection needn't be a dead end.
    return (
      <div className="dash m-app">
        <div className="m-center">
          <Empty icon="📡" title={acct.status === 'unavailable' ? 'Accounts aren’t switched on here yet' : 'Can’t reach the server'}>
            You can still plan on this device. Sharing and splitting costs need an account.
            <button className="cta" onClick={acct.retry}>Try again</button>
            <button className="ghost" onClick={() => setGuest(true)}>Continue without signing in</button>
          </Empty>
        </div>
      </div>
    )
  }

  if (acct.account && join) {
    if (inviteError) {
      return (
        <div className="dash m-app">
          <div className="m-center">
            <Empty icon="🔗" title="That invite didn’t work">
              {inviteError}
              <button className="ghost" onClick={() => finishJoin(null)}>Continue to Wayfarer</button>
            </Empty>
          </div>
        </div>
      )
    }
    if (!invite) return <div className="dash m-app"><div className="m-center"><div className="m-skeleton m-auth" /></div></div>
    return <div className="dash m-app"><JoinScreen token={join} invite={invite} account={acct.account} onJoined={finishJoin} onCancel={() => finishJoin(null)} /></div>
  }

  // A different person gets a fresh start, not the last person's trip on screen.
  return <TripApp key={acct.account?.id ?? 'guest'} acct={acct} />
}

function TripApp({ acct }: { acct: AccountHandle }) {
  const account = acct.account
  // The group trip on screen, if any. Without one, this is a trip kept in this browser.
  const [activeGroup, setActiveGroupState] = useState<string | null>(() => (account ? readLocal<string | null>('activeTrip', null) ?? loadCurrent()?.brief.moneyGroupId ?? null : null))
  const setActiveGroup = useCallback((id: string | null) => {
    writeLocal('activeTrip', id)
    setActiveGroupState(id)
  }, [])

  // Reopen what was on screen after a refresh: the group's trip, or the one in progress here.
  const [state, rawDispatch] = useReducer(reducer, initialState, init => {
    const cached = activeGroup ? readLocal<SharedTrip | null>(`trip:${activeGroup}`, null) : null
    if (cached?.plan) return reducer(init, { type: 'shared-plan', plan: cached.plan, role: cached.role === 'owner' ? 'admin' : 'member', version: cached.planVersion, votes: myVotes(cached.votes, cached.me) })
    const local = activeGroup ? localCopyOf(activeGroup) : loadCurrent()
    return local ? reducer(init, { type: 'restore', trip: local }) : init
  })
  // every action goes to the activity log too (src/dev/activity.ts), summarised against what was on screen
  const dispatch = useCallback((a: Action) => { trackAction(a, latest.current); rawDispatch(a) }, [])
  const member = isMember(state)
  const [typing, setTyping] = useState(false)
  const { theme, mode: themeMode, setMode: setThemeMode } = useTheme()
  const [trips, setTrips] = useState<SavedTrip[]>(loadTrips)
  const [justSaved, setJustSaved] = useState(false)

  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  const toastSeq = useRef(0)
  const toast = useCallback((text: string) => {
    const id = ++toastSeq.current
    setToasts(t => [...t.slice(-2), { id, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500)
  }, [])

  // Collapsible side panels (remembered per browser). Messages that arrive while
  // the chat is tucked away light a dot on its tab.
  const [panels, setPanels] = useState<PanelPrefs>(loadPanels)
  // While the routes draw, the map gets the whole window. The edge tabs still open
  // either panel, and reopening one counts as wanting it, so it stays open afterwards.
  const [reopened, setReopened] = useState<Partial<PanelPrefs>>({})
  const drawing = state.phase === 'planning'
  useEffect(() => { if (!drawing) setReopened({}) }, [drawing])
  const tucked: PanelPrefs = drawing ? { chat: !reopened.chat, journal: !reopened.journal } : panels
  const toggle = (k: keyof PanelPrefs) => {
    const opening = tucked[k]
    if (drawing) setReopened(r => ({ ...r, [k]: opening }))
    if (!drawing || opening) setPanels(p => { const next = { ...p, [k]: !opening }; savePanels(next); return next })
  }

  // Phones get one bottom sheet with Chat / Plan tabs instead of two side panels.
  const isMobile = useIsMobile()
  const [sheetTab, setSheetTab] = useState<'chat' | 'plan'>('chat')
  const [snap, setSnap] = useState<Snap>('half')
  const chatHidden = isMobile ? sheetTab !== 'chat' : tucked.chat // desktop collapse prefs don't apply to the sheet

  const [chatSeen, setChatSeen] = useState(state.messages.length)
  useEffect(() => { if (!chatHidden) setChatSeen(state.messages.length) }, [chatHidden, state.messages.length])
  const unread = chatHidden && state.messages.length > chatSeen

  // Focusing a day in a narrow window: tuck the chat away so the day is actually visible
  // (only for this view; the saved preference is left alone).
  useEffect(() => {
    const gap = window.innerWidth - 460 - (panels.journal ? 60 : 480)
    if (!isMobile && state.activeDay !== null && !panels.chat && gap < 360) setPanels(p => ({ ...p, chat: true }))
    if (isMobile && state.activeDay !== null) setSnap('half') // leave the top half for the day's map
  }, [state.activeDay])

  // The sheet follows the journey: chat while briefing, the live plan once mapping starts.
  useEffect(() => {
    if (!isMobile) return
    if (state.phase === 'intake') { setSheetTab('chat'); setSnap('half') }
    if (state.phase === 'planning') { setSheetTab('plan'); setSnap('peek') } // out of the way while the routes draw
    if (state.phase === 'hotels') { setSheetTab('plan'); setSnap('half') }
    if (state.phase === 'review') setSnap('half')
  }, [state.phase, isMobile])
  // Tapping a pin opens its card; drop the sheet out of the way.
  useEffect(() => { if (isMobile && state.selectedPlace) setSnap('peek') }, [state.selectedPlace])
  // ── links shared to Wayfarer: the iPhone's share sheet, a ?share= link, or one pasted into chat ──
  const [incoming, setIncoming] = useState<Shared | null>(() => {
    const q = new URLSearchParams(location.search)
    return q.get('share') ? { url: q.get('share')!, text: q.get('text') ?? undefined } : null
  })
  useEffect(() => {
    if (new URLSearchParams(location.search).has('share')) history.replaceState(null, '', location.pathname)
    // the share extension opens the app at wayfarer://share?url=…&text=…
    const fromAppUrl = (raw: string | undefined) => {
      if (!raw?.startsWith('wayfarer://share')) return
      const q = new URL(raw.replace('wayfarer://share', 'https://x/share')).searchParams
      if (q.get('url')) setIncoming({ url: q.get('url')!, text: q.get('text') ?? undefined })
    }
    const app = (window as NativeApp).Capacitor?.Plugins?.App
    if (!app) return
    app.getLaunchUrl?.().then(r => fromAppUrl(r?.url)).catch(() => {})
    const sub = app.addListener?.('appUrlOpen', e => fromAppUrl(e.url))
    return () => { void Promise.resolve(sub).then(h => h?.remove()).catch(() => {}) }
  }, [])

  // the dev tools, for the app's owner only
  const [devAdmin, setDevAdmin] = useState(false)
  const [devOpen, setDevOpen] = useState(() => new URLSearchParams(location.search).has('dev'))
  useEffect(() => {
    if (!account) return
    api<{ admin: boolean }>('GET', '/dev/me').then(r => setDevAdmin(r.admin)).catch(() => {})
  }, [account])
  // finds waiting for the owner's review, so the Trips menu can say so on the go
  const [devReviews, setDevReviews] = useState(0)
  useEffect(() => {
    if (!devAdmin) { setDevReviews(0); return }
    const load = () => { if (document.visibilityState === 'visible') api<{ reviews: unknown[] }>('GET', '/dev/places/reviews').then(r => setDevReviews(r.reviews.length)).catch(() => {}) }
    load()
    const t = setInterval(load, 60_000)
    document.addEventListener('visibilitychange', load)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', load) }
  }, [devAdmin, devOpen])

  const [brain, setBrain] = useState<BrainStatus | null>(null)
  useEffect(() => { detectBrain().then(setBrain) }, [])
  // A model on the server (Claude, or OpenAI) when configured; otherwise the offline heuristic planner.
  const engine = useMemo(() => (plansRemotely(brain) ? new FallbackPlanner(new RemotePlanner(), new MockPlanner(1)) : new MockPlanner(1)), [brain])
  const abort = useRef<AbortController | null>(null)
  const latest = useRef<TripState>(state)
  latest.current = state

  // ── the group this trip belongs to ──

  const { groups, refresh: refreshGroups } = useGroups(Boolean(account))

  const leaveShared = useCallback((goneId?: string) => {
    abort.current?.abort()
    setActiveGroup(null)
    const current = loadCurrent()
    if (current) {
      // the group has gone, but the plan this browser kept is still yours
      const trip = current.brief.moneyGroupId === goneId ? { ...current, brief: { ...current.brief, moneyGroupId: undefined } } : current
      saveCurrent(trip)
      dispatch({ type: 'restore', trip })
    } else dispatch({ type: 'reset' })
    refreshGroups().catch(() => {})
  }, [setActiveGroup, refreshGroups])

  const shared = useSharedTrip(activeGroup, state, dispatch, {
    gone: () => { toast('You’re no longer in that group'); leaveShared(activeGroup ?? undefined) },
    signedOut: () => { acct.retry() },
    news: toast,
  })
  const trip = shared.trip

  const openShared = useCallback((id: string) => {
    setDashOpen(false)
    if (id === activeGroup) return // already here, and there's nothing to bring back
    abort.current?.abort()
    setActiveGroup(id)
    // A group from before plans were shared has its trip only in this browser, so that's where
    // it picks up from. The server's copy replaces this if it has one.
    const copy = groups?.find(g => g.id === id)?.role === 'owner' ? localCopyOf(id) : null
    dispatch(copy ? { type: 'restore', trip: copy } : { type: 'reset' })
  }, [activeGroup, groups, setActiveGroup])

  // Being added to a group: straight there if there's nothing else on screen, or a nudge if there is.
  const [newGroup, setNewGroup] = useState<GroupSummary | null>(null)
  const firstList = useRef(true)
  useEffect(() => {
    if (!account || !groups) return
    const seen = new Set(readLocal<string[]>('seenGroups', []))
    const unseen = groups.filter(g => !seen.has(g.id) && g.id !== activeGroup)
    writeLocal('seenGroups', groups.map(g => g.id))
    const idle = !activeGroup && state.phase === 'intake' && state.messages.length <= 1
    if (firstList.current && idle && groups.length) {
      firstList.current = false
      openShared((unseen[0] ?? groups[0]).id)
      return
    }
    firstList.current = false
    if (unseen.length) setNewGroup(unseen[0])
  }, [groups])
  useEffect(() => {
    const wake = () => { if (document.visibilityState === 'visible' && account) refreshGroups().catch(() => {}) }
    document.addEventListener('visibilitychange', wake)
    return () => document.removeEventListener('visibilitychange', wake)
  }, [account, refreshGroups])

  // The iPhone app resumes the page it already had, so a deploy only shows up after a cold start.
  // On coming back, look for a new build and reload into it, but only when nothing unsaved would
  // be lost; otherwise wait for the next moment that's safe.
  const updateReady = useRef(false)
  const safeToReload = () => {
    const s = latest.current
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
    return !typing && ((s.phase === 'intake' && s.messages.length <= 1) || s.phase === 'review' || s.phase === 'final')
  }
  useEffect(() => {
    const entry = (html: string) => html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    const mine = entry(document.documentElement.outerHTML)
    if (!mine) return // the dev server
    const check = () => {
      if (document.visibilityState !== 'visible') return
      if (updateReady.current) { if (safeToReload()) location.reload(); return }
      fetch('/', { cache: 'no-store' }).then(r => r.text()).then(html => {
        const live = entry(html)
        if (!live || live === mine) return
        updateReady.current = true
        if (safeToReload()) location.reload()
      }).catch(() => {})
    }
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])
  useEffect(() => { if (updateReady.current && safeToReload()) location.reload() }, [state.phase])

  // Makes the group the first time it's needed.
  const ensureGroup = useCallback(async (): Promise<string> => {
    if (activeGroup) return activeGroup
    const s = latest.current
    const city = cityById(s.brief.destination)
    const g = await api<GroupState>('POST', '/groups', { name: city ? `${city.name} trip` : 'Our trip', currency: homeCurrency(), trip: tripSummaryOf(s) })
    dispatch({ type: 'brief', brief: { ...s.brief, moneyGroupId: g.group.id } })
    setActiveGroup(g.group.id)
    refreshGroups().catch(() => {})
    return g.group.id
  }, [activeGroup, setActiveGroup, refreshGroups])

  const [inviteOpen, setInviteOpen] = useState(false)
  const openInvite = useCallback(async () => {
    try {
      await ensureGroup()
      setInviteOpen(true)
    } catch (err) {
      toast((err as Error).message)
    }
  }, [ensureGroup, toast])

  // Once we know friends are coming and the questions are done, offer to bring them in. Once.
  const [friendsAsked, setFriendsAsked] = useState(false)
  const [invitePrompt, setInvitePrompt] = useState(false)
  const shouldOffer = Boolean(account) && !member && !activeGroup && !friendsAsked && state.phase === 'intake' && (state.brief.travelers ?? 1) > 1 && isReady(state.brief)
  const offerFriends = useCallback(() => {
    setFriendsAsked(true)
    setInvitePrompt(true)
    const n = latest.current.brief.travelers ?? 2
    dispatch({ type: 'chat', role: 'ai', text: `There are ${n} of you. Invite them to vote on places and split costs?` })
  }, [])
  useEffect(() => {
    if (shouldOffer && !typing && !nextField(state.brief)) offerFriends()
  }, [shouldOffer, typing, state.brief, offerFriends])

  // The trip's city, fetched from the server when the trip opens: a city built from public
  // guides lives only there, and a hand-made one picks up travellers' promoted finds and what
  // the places have learned. Everything that reads the catalog redraws once it's in.
  useEffect(() => {
    const id = state.brief.destination
    if (!id) return
    let gone = false
    ensureCity(id).then(c => { if (c && !gone) dispatch({ type: 'city-ready', id }) })
    return () => { gone = true }
  }, [state.brief.destination])

  // A city the app hadn't mapped: wait for the build, then set it as the destination and carry
  // on with the questions as if they'd named one the app knew. `text` is their message, for the
  // offline intake to read again with the city known.
  const buildCtrl = useRef<AbortController | null>(null)
  const awaitCity = async (job: { id: string; name: string }, text?: string) => {
    buildCtrl.current?.abort()
    const ctrl = new AbortController()
    buildCtrl.current = ctrl
    setTyping(true)
    let lastSaid = Date.now()
    try {
      const city = await waitForCity(job.id, progress => {
        if (Date.now() - lastSaid > 25_000) { lastSaid = Date.now(); dispatch({ type: 'chat', role: 'ai', text: `Still mapping ${job.name}: ${progress.replace(/^./, c => c.toLowerCase())}…` }) }
      }, ctrl.signal)
      if (ctrl.signal.aborted) return
      const s = latest.current
      const mapped = `${city.name} is mapped: ${city.places.length} places from public guides.`
      if (text !== undefined) {
        const { brief, reply } = converse(text, s.brief, city.id)
        dispatch({ type: 'brief', brief })
        dispatch({ type: 'chat', role: 'ai', text: `${mapped} ${reply}` })
        void placeStay(brief)
      } else {
        const brief = { ...s.brief, destination: city.id }
        dispatch({ type: 'brief', brief })
        void placeStay(brief)
        dispatch({ type: 'chat', role: 'ai', text: `${mapped}${nextField(brief) ? '' : ' Hit “Pick places” whenever you’re ready.'}` })
      }
      dispatch({ type: 'city-ready', id: city.id })
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      dispatch({ type: 'chat', role: 'ai', text: `${(e as Error).message} Which other city should we try?` })
    } finally {
      if (buildCtrl.current === ctrl) { buildCtrl.current = null; setTyping(false) }
    }
  }

  const run = useCallback(async (stream: (signal: AbortSignal) => AsyncGenerator<PlannerEvent>) => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    try {
      for await (const event of stream(ctrl.signal)) dispatch({ type: 'planner', event })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') throw e
    }
  }, [])

  // A place they found themselves, typed by name or shared from a maps app: look it up, then
  // add it to wherever the trip has got to. Still drawing: it waits for the draft, like edits do.
  const pendingFinds = useRef<CustomPlaceRequest[]>([])
  const addFind = async (req: CustomPlaceRequest): Promise<boolean> => {
    setTyping(true)
    try {
      const { place, note } = await resolveCustomPlace(req, latest.current.brief)
      dispatch({ type: 'add-custom-place', place, day: req.day, note })
    } catch (e) {
      // no server to ask: carry on as if it were any other message
      if (e instanceof TypeError) return false
      dispatch({ type: 'chat', role: 'ai', text: (e as Error).message })
    } finally {
      setTyping(false)
    }
    return true
  }

  // The assistant: with an LLM connected, chat over a plan goes to it, and it acts through the
  // allowlisted tools (src/agent). Money and people changes wait for a tap on Confirm.
  const [ask, setAsk] = useState<{ question: string; yes: string; answer: (ok: boolean) => void } | null>(null)
  const tripRef = useRef(trip)
  tripRef.current = trip
  const askAgent = async (text: string, before: TripState['messages']): Promise<boolean> => {
    setTyping(true)
    try {
      const reply = await runAgent(text, before, {
        state: () => latest.current,
        dispatch,
        trip: () => tripRef.current ?? null,
        ensureGroup,
        confirm: (question, yes) => new Promise(resolve => {
          setTyping(false)
          setAsk({ question, yes, answer: ok => { setAsk(null); setTyping(true); resolve(ok) } })
        }),
      })
      dispatch({ type: 'chat', role: 'ai', text: reply })
      return true
    } catch (e) {
      // no assistant to reach: the rule-based editor still understands most changes
      if (e instanceof TypeError) return false
      // the model itself can't answer (no credits, too busy): the rule-based editor takes it
      if (/credit|quota|rate.?limit|429|busy|overloaded|unavailable|50[23]/i.test((e as Error).message)) {
        console.warn('[assistant] the model failed, using the rule-based editor:', (e as Error).message)
        return false
      }
      dispatch({ type: 'chat', role: 'ai', text: `The assistant hit a problem: ${(e as Error).message}` })
      return true
    } finally {
      setAsk(null)
      setTyping(false)
    }
  }

  // An itinerary pasted into the chat becomes a new trip: their days, order and places. The
  // trip that was open stays in My trips, as with New trip.
  const importPasted = async (text: string) => {
    const s = latest.current
    dispatch({ type: 'chat', role: 'ai', text: 'That looks like an itinerary. I’m making it into a trip: places Wayfarer doesn’t know yet are looked up on the map, so this can take a minute.' })
    setTyping(true)
    try {
      const { vibes, budgetTier, budgetAmount, pace } = s.brief
      const out = await importPastedItinerary(text, { vibes, budgetTier, budgetAmount, pace })
      if (out.brief.destination) await ensureCity(out.brief.destination)
      abort.current?.abort()
      const now = latest.current
      if (!isMember(now) && now.days.length && !(now.tripId && trips.some(t => t.id === now.tripId))) setTrips(saveTrip(snapshot(now)))
      setActiveGroup(null)
      setDashOpen(false)
      const trip: SavedTrip = {
        id: newId(), name: `${out.cityName} trip`, savedAt: Date.now(),
        brief: out.brief, days: out.days, hotel: out.hotel, hotelScores: out.hotelScores,
        candidates: Object.fromEntries(out.places.map(place => [place.id, { place, verdict: 'keep' as const }])),
        messages: [{ id: newId(), role: 'user', text }],
      }
      dispatch({ type: 'restore', trip, note: `${out.summary} Change anything by asking here, on the map or in the itinerary.` })
    } catch (e) {
      dispatch({ type: 'chat', role: 'ai', text: e instanceof TypeError ? 'I couldn’t reach the server to read that itinerary. Try again when you’re connected.' : `I couldn’t make that into a trip: ${(e as Error).message}` })
    } finally {
      setTyping(false)
    }
  }

  const send = async (text: string) => {
    const s = latest.current
    dispatch({ type: 'chat', role: 'user', text })

    // a whole itinerary, pasted: before the link check, as itineraries often carry links
    if (brain?.agent && !member && looksLikeItinerary(text)) { await importPasted(text); return }

    // a reel, video, post or page: read it for places, then ask which trip they go in
    const link = text.match(/\bhttps?:\/\/[^\s<>"']+/i)?.[0]
    if (link && account && !member && !mapsHost(link)) {
      dispatch({ type: 'chat', role: 'ai', text: 'Let me look at that link for places.' })
      setIncoming({ url: link, text: text.replace(link, ' ').trim() || undefined })
      return
    }

    if (brain?.agent && !member && (s.phase === 'review' || s.phase === 'final') && await askAgent(text, s.messages)) return

    const find = customPlaceRequest(text)
    if (find && isFind(find, s.brief)) {
      if (!s.brief.destination) {
        if (find.link) { dispatch({ type: 'chat', role: 'ai', text: 'Nice find! Which city is the trip in? Tell me, then send the link again and I’ll add it.' }); return }
      } else if (s.phase === 'planning' || s.phase === 'hotels') {
        pendingFinds.current.push(find)
        dispatch({ type: 'chat', role: 'ai', text: 'Got it — I’ll add that place as soon as this draft finishes drawing.' })
        return
      } else if (await addFind(find)) return
    }

    // Once there is a plan, every message is a live edit to it — never a restart.
    if (s.phase === 'review' || s.phase === 'final') {
      setTyping(true)
      setTimeout(() => { setTyping(false); dispatch({ type: 'chat-edit', text }) }, 450)
      return
    }
    // Still drawing: hold the request and apply it the moment the draft is ready.
    if (s.phase === 'planning' || s.phase === 'hotels') {
      pendingEdits.current.push(text)
      dispatch({ type: 'chat', role: 'ai', text: 'Got it — I’ll apply that as soon as this draft finishes drawing.' })
      return
    }

    setTyping(true)
    if (plansRemotely(brain) && s.phase === 'intake') {
      try {
        const out = await claudeIntake([...s.messages, { id: 'pending', role: 'user', text }], s.brief)
        dispatch({ type: 'brief', brief: { ...out.brief, moneyGroupId: s.brief.moneyGroupId } })
        dispatch({ type: 'chat', role: 'ai', text: out.reply, chips: out.chips })
        void placeStay(out.brief)
        // a city being mapped: the destination is set once it's ready
        if (out.building) void awaitCity(out.building)
        else setTyping(false)
        return
      } catch (e) {
        // the model can't answer (no credits, too busy, offline): carry on without it, quietly,
        // through the offline reading below
        console.warn('[intake] the model intake failed, answering offline:', (e as Error).message)
      }
    }
    const heard = converse(text, s.brief)
    let { brief, reply } = heard
    // they named somewhere the app doesn't know: the server may know it, or can build it
    if (heard.lookup) {
      try {
        const look = await lookupCity(heard.lookup)
        if (look.status === 'known') {
          await ensureCity(look.id)
          ;({ brief, reply } = converse(text, s.brief, look.id))
        } else if (look.status === 'building') {
          // what else they said (days, who, vibe) is kept even if the build fails
          dispatch({ type: 'brief', brief })
          dispatch({ type: 'chat', role: 'ai', text: `I don’t have ${look.name} mapped yet, so I’m building it from public guides now. It takes about a minute.` })
          void awaitCity(look, text)
          return
        } else if (look.status === 'failed') {
          reply = `${look.error} ${reply}`
        }
      } catch (e) {
        // no server to ask (or it refused): the offline reply stands
        if (!(e instanceof TypeError)) reply = `${(e as Error).message} ${reply}`
      }
    }
    dispatch({ type: 'brief', brief })
    void placeStay(brief)
    setTimeout(() => {
      setTyping(false)
      dispatch({ type: 'chat', role: 'ai', text: reply })
    }, 450)
  }

  // Where they said they're staying goes on the map as soon as there's a city to look in, and
  // becomes the trip's base when it's time to choose one.
  const stayAsked = useRef('')
  // Places that fit what they told us, searched for in the background while they talk, and at the
  // top of the deck once found. One search per city and mood; the deck waits for one under way.
  const vibeKey = useRef('')
  const vibeJob = useRef<Promise<void> | null>(null)
  const findLocal = (b: TripBrief) => {
    if (!plansRemotely(brain) || !b.destination || !hasMood(b)) return
    const key = `${b.destination}|${moodOf(b)}`
    if (vibeKey.current === key) return
    vibeKey.current = key
    const city = b.destination
    const job = findVibe(city, b).then(out => {
      if (!out.places.length) return
      addCatalogPlaces(city, out.places)
      dispatch({ type: 'city-ready', id: city })
      if (latest.current.brief.destination !== city || latest.current.phase !== 'intake' || out.cached) return
      const names = out.places.slice(0, 3).map(p => p.name)
      dispatch({ type: 'chat', role: 'ai', text: `I found ${out.places.length} places locals love that fit what you told me, like ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' and ' : ''}${names[names.length - 1]}. They’ll be at the top of your deck.` })
    }).catch(() => {
      // no matter: the deck has the city's own places
    }).finally(() => { if (vibeJob.current === job) vibeJob.current = null })
    vibeJob.current = job
  }

  const placeStay = async (just?: TripBrief) => {
    findLocal(just ?? latest.current.brief)
    const b = just ?? latest.current.brief
    const stay = b.story?.stay
    if (!stay || stay.coord || !b.destination) return
    const key = `${b.destination}|${stay.name.toLowerCase()}`
    if (stayAsked.current === key) return
    stayAsked.current = key
    try {
      const found = await findStay(stay.name, b.destination)
      const now = latest.current.brief
      if (now.story?.stay?.name !== stay.name || now.destination !== b.destination) return
      dispatch({ type: 'brief', brief: { ...now, story: { ...now.story, stay: { name: stay.name, coord: found.coord } } } })
      dispatch({ type: 'planner', event: { type: 'camera', center: found.coord, zoom: 13 } })
    } catch {
      // not found, or no server: it stays a name, and the planner picks a base as usual
    }
  }

  // Edits typed while the planner was still drawing.
  const pendingEdits = useRef<string[]>([])
  useEffect(() => {
    if ((state.phase === 'review' || state.phase === 'final') && pendingFinds.current.length) {
      const finds = pendingFinds.current
      pendingFinds.current = []
      ;(async () => { for (const f of finds) await addFind(f) })()
    }
    if ((state.phase === 'review' || state.phase === 'final') && pendingEdits.current.length) {
      const text = pendingEdits.current.join(', ')
      pendingEdits.current = []
      dispatch({ type: 'chat-edit', text })
    }
  }, [state.phase])

  // Brief done → deal the swipe deck of places, best matches first.
  const startDeck = async () => {
    if (shouldOffer) { offerFriends(); return } // going with friends: ask before the voting starts
    setInvitePrompt(false)
    // places that fit their mood are still being found: worth the wait, up to a point
    if (vibeJob.current) {
      dispatch({ type: 'chat', role: 'ai', text: 'Finding the places that fit what you told me, one moment…' })
      setTyping(true)
      await Promise.race([vibeJob.current, new Promise(r => setTimeout(r, 90_000))])
      setTyping(false)
      if (latest.current.phase !== 'intake') return
    }
    dispatch({ type: 'start-deck' })
    dispatch({ type: 'chat', role: 'ai', text: activeGroup ? 'Here’s the group’s deck. Swipe right on what you’d love, left to skip.' : 'Here’s your deck, best matches first. Swipe right on what you’d love, left to skip.' })
  }

  // Plan the chosen places.
  const plan = (liked: string[], rejected: string[], label: string) => {
    const brief = latest.current.brief
    // what they kept and skipped teaches the places who they suit
    if (brief.destination) sendSignals(brief.destination, liked, rejected, brief)
    dispatch({ type: 'phase', phase: 'planning' })
    dispatch({ type: 'chat', role: 'ai', text: label })
    run(signal => engine.planItinerary(brief, signal, { liked, rejected }))
  }
  // The sliders moved over a finished plan: the days re-time, and options that fit the new settings
  // open as a deck to swipe. Nothing is added unless they keep it.
  const retune = (patch: Partial<TripBrief>) => {
    dispatch({ type: 'retune', brief: { ...latest.current.brief, ...patch } })
  }
  const [picksOpen, setPicksOpen] = useState(false)
  const requestPlan = () => {
    if (trip && trip.people.length > 1) { setPicksOpen(true); return }
    const picks = latest.current.picks
    const liked = Object.keys(picks).filter(id => picks[id] === 'like')
    plan(liked, Object.keys(picks).filter(id => picks[id] === 'nope'), `Mapping your ${liked.length} picks.`)
  }
  const likedCount = state.deck.filter(c => state.picks[c.id] === 'like').length
  const inGroup = Boolean(trip && trip.people.length > 1)
  // a deck opened from chat over an existing plan finishes back into that plan
  const finishDeck = () => {
    const s = latest.current
    if (s.brief.destination) sendSignals(s.brief.destination, s.deck.filter(c => s.picks[c.id] === 'like').map(c => c.id), s.deck.filter(c => s.picks[c.id] === 'nope').map(c => c.id), s.brief)
    dispatch({ type: 'finish-deck' })
  }
  const cancelDeck = () => dispatch({ type: 'finish-deck', cancel: true })

  const approve = () => {
    // Accepting the itinerary makes the trip's own Money and Photos (its group), once.
    if (account && !activeGroup) ensureGroup().catch(() => {}) // offline: the dashboard makes it later
    dispatch({ type: 'phase', phase: 'hotels' })
    dispatch({ type: 'active-day', day: null })
    dispatch({ type: 'chat', role: 'ai', text: 'Approved. Now hunting for a base that keeps every day close.' })
    run(signal => engine.findHotels(latest.current.brief, latest.current.days, signal))
  }

  // Autosave whenever there is a plan on the table. Only an explicit Start over
  // clears it, never a passing render state. Someone else's trip isn't saved over your own.
  useEffect(() => {
    if (!member && (state.phase === 'review' || state.phase === 'final')) saveCurrent(snapshot(state))
  }, [state.days, state.hotel, state.phase, state.brief, member])

  // The trip dashboard: opens on save, from the itinerary panel, or from My trips.
  const [dashOpen, setDashOpen] = useState(false)
  const showDash = dashOpen && (state.phase === 'review' || state.phase === 'final') && state.days.length > 0

  // Money and Photos. From the top bar: every trip together. From the trip (its dashboard, a
  // place on its map): that trip's own, made on the spot if accepting the plan didn't get to.
  const [moneyOpen, setMoneyOpen] = useState<{ scope?: string; prefill?: ExpensePrefill } | null>(null)
  // ?docs (from an alert email) opens the documents
  const [vaultOpen, setVaultOpen] = useState<{ scope?: string; section?: 'photos' | 'docs' } | null>(() => (new URLSearchParams(location.search).has('docs') ? { section: 'docs' } : null))
  const openDocs = useCallback(() => { setProfileOpen(false); setVaultOpen({ section: 'docs' }) }, [])
  const { alerts, markAllRead } = useAlerts(Boolean(account))
  // a tapped alert on the phone opens the documents
  useEffect(() => onAlertTapped(openDocs), [openDocs])
  const [profileOpen, setProfileOpen] = useState(false)
  // which screens people open, for the activity log
  const screens = { dashboard: dashOpen, money: Boolean(moneyOpen), photos: Boolean(vaultOpen), 'dev tools': devOpen, 'share sheet': Boolean(incoming) }
  const lastScreens = useRef<Record<string, boolean>>({})
  useEffect(() => {
    for (const [name, open] of Object.entries(screens)) {
      if (Boolean(lastScreens.current[name]) !== open) trackScreen(name, open)
      lastScreens.current[name] = open
    }
  })
  const tripSpace = async (): Promise<string | undefined> => {
    if (activeGroup) return activeGroup
    if (!account || member) return undefined
    try {
      return await ensureGroup()
    } catch (err) {
      toast((err as Error).message)
      return undefined
    }
  }
  const openTripMoney = async (prefill?: ExpensePrefill) => setMoneyOpen({ scope: await tripSpace(), prefill })
  const openTripPhotos = async () => setVaultOpen({ scope: await tripSpace() })
  const tripBalance = groups?.find(g => g.id === activeGroup) ?? null
  useMoneyBadge(Boolean(moneyOpen)) // keeps local groups claimed and synced; the balance itself isn't shown
  const hasPlan = (state.phase === 'review' || state.phase === 'final') && state.days.length > 0
  const moneyTrip = useMemo<MoneyTrip>(() => ({
    summary: hasPlan && !member ? tripSummaryOf(state) : null,
    linkedGroupId: activeGroup ?? state.brief.moneyGroupId,
    link: moneyGroupId => {
      if (!moneyGroupId) {
        if (isMember(latest.current)) { leaveShared(activeGroup ?? undefined); return }
        dispatch({ type: 'shared-role', role: null })
      }
      if (!isMember(latest.current)) {
        const brief = { ...latest.current.brief, moneyGroupId }
        dispatch({ type: 'brief', brief })
        const id = latest.current.tripId
        if (id && loadTrips().some(t => t.id === id)) setTrips(saveTrip(snapshot({ ...latest.current, brief })))
      }
      setActiveGroup(moneyGroupId ?? null)
    },
  }), [hasPlan, member, activeGroup, state.brief, state.days, state.hotel, setActiveGroup, leaveShared])

  const logExpense = (place: Place, day?: number) => {
    const start = state.brief.startDate
    const date = start && day ? new Date(new Date(`${start}T00:00:00Z`).getTime() + (day - 1) * 86_400_000).toISOString().slice(0, 10) : undefined
    dispatch({ type: 'select-place', id: null })
    openTripMoney({ title: place.name, category: categoryForKind(place.kind), placeId: place.id, placeName: place.name, date })
  }

  const save = () => {
    const saved = snapshot(latest.current)
    setTrips(saveTrip(saved))
    dispatch({ type: 'saved', id: saved.id })
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1800)
    setDashOpen(true)
  }

  // Dates are set on the dashboard; keep the saved copy in step.
  const setDates = (startDate: string) => {
    const brief = { ...latest.current.brief, startDate }
    dispatch({ type: 'brief', brief })
    const id = latest.current.tripId
    if (id && trips.some(t => t.id === id)) setTrips(saveTrip(snapshot({ ...latest.current, brief })))
  }

  const openTrip = (saved: SavedTrip) => {
    abort.current?.abort()
    // Listed on its own means it isn't the trip of a group you run, so it opens as yours alone.
    // Only before the groups have loaded is there no telling.
    const keepLink = Boolean(account && !groups && saved.brief.moneyGroupId)
    setActiveGroup(keepLink ? saved.brief.moneyGroupId! : null)
    dispatch({ type: 'restore', trip: keepLink ? saved : { ...saved, brief: { ...saved.brief, moneyGroupId: undefined } } })
    setDashOpen(Boolean(saved.hotel)) // a finished trip opens on its dashboard
  }

  const removeTrip = (id: string) => setTrips(deleteTrip(id))

  // An admin deleting a shared trip: it goes for everyone (plan, votes, chat and shared
  // expenses), and so do this browser's copies of it. With anyone else in it, or money spent,
  // they type its name first, as deleting the group from Money asks.
  const deleteShared = async (g: GroupSummary) => {
    const others = g.memberCount > 1 || g.total > 0
    if (others) {
      const typed = prompt(`This deletes “${g.name}” for all ${g.memberCount} ${g.memberCount === 1 ? 'person' : 'people'}: the plan, votes, chat${g.total > 0 ? ' and every shared expense' : ''}. It can’t be undone. Type the trip’s name to confirm.`)
      if (typed === null) return
      if (typed.trim() !== g.name) { toast('That didn’t match, so nothing was deleted'); return }
    } else if (!confirm(`Delete “${g.name}”? It can’t be undone.`)) return
    try {
      await api('DELETE', `/groups/${g.id}`)
    } catch (err) {
      toast((err as Error).message)
      return
    }
    let left = trips
    for (const t of trips.filter(t => t.brief.moneyGroupId === g.id)) left = deleteTrip(t.id)
    setTrips(left)
    if (activeGroup === g.id) {
      abort.current?.abort()
      setActiveGroup(null)
      saveCurrent(null)
      dispatch({ type: 'reset' })
    } else if (latest.current.brief.moneyGroupId === g.id) {
      dispatch({ type: 'brief', brief: { ...latest.current.brief, moneyGroupId: undefined } })
    }
    refreshGroups().catch(() => {})
    toast(`Deleted “${g.name}” for everyone`)
  }

  // A clean slate (New trip, Start over). Your plan so far stays in My trips rather than disappearing.
  const newTrip = () => {
    abort.current?.abort()
    const s = latest.current
    if (!isMember(s) && s.days.length && !(s.tripId && trips.some(t => t.id === s.tripId))) setTrips(saveTrip(snapshot(s)))
    saveCurrent(null)
    setFriendsAsked(false)
    setInvitePrompt(false)
    setDashOpen(false)
    setActiveGroup(null)
    dispatch({ type: 'reset' })
  }

  // From the top bar, so it's never more than a tap away. Nothing is lost (the plan stays in
  // My trips), but a stray tap shouldn't wipe the screen, so it asks.
  const startOver = () => {
    if (confirm('Start a new trip? This one stays in My trips.')) newTrip()
  }
  const canStartOver = !member && !state.deckMode && (state.phase !== 'intake' || state.messages.some(m => m.role === 'user'))

  // Where shared places can go: the trip on screen, the group trips you run, and your saved trips.
  const shareTargets = useMemo<ShareTarget[]>(() => {
    const out: ShareTarget[] = []
    const cityName = (id?: string) => cityById(id)?.name
    const onScreen = !member && state.brief.destination
    if (onScreen) {
      const g = groups?.find(x => x.id === activeGroup)
      out.push({ key: 'current', name: g?.name ?? `${cityName(state.brief.destination)} trip`, cityId: state.brief.destination, detail: state.days.length ? `${state.days.length} day${state.days.length === 1 ? '' : 's'} planned` : 'Still planning', current: true })
    }
    for (const g of groups ?? []) {
      if (g.role !== 'owner' || (onScreen && g.id === activeGroup)) continue
      const copy = groupCopyOf(trips, g.id)
      out.push({ key: `group:${g.id}`, name: g.name, cityId: copy?.brief.destination ?? (g.city ? findCity(g.city)?.id : undefined), detail: `Shared · ${g.memberCount} ${g.memberCount === 1 ? 'person' : 'people'}`, current: false })
    }
    for (const t of trips) {
      if (onScreen && t.id === state.tripId) continue
      const g = groups?.find(x => x.id === t.brief.moneyGroupId)
      if (g?.role === 'owner' && groupCopyOf(trips, g.id)?.id === t.id) continue // listed as its group
      out.push({ key: `trip:${t.id}`, name: t.name, cityId: t.brief.destination, detail: `Saved ${new Date(t.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${t.days.reduce((n, d) => n + d.stops.length, 0)} stops`, current: false })
    }
    return out
  }, [member, state.brief.destination, state.days.length, state.tripId, activeGroup, groups, trips])

  // Opens the chosen trip if it isn't on screen, then adds each place once it has loaded.
  const [shareQueue, setShareQueue] = useState<{ key: string; reqs: CustomPlaceRequest[] } | null>(null)
  const addShared = (target: ShareTarget, places: FoundPlace[]) => {
    setIncoming(null)
    const reqs = places.map(p => (p.link ? { link: p.link } : { name: p.name }))
    if (target.key.startsWith('trip:')) {
      const saved = trips.find(t => t.id === target.key.slice(5))
      if (saved) openTrip(saved)
      setShareQueue({ key: target.key, reqs })
    } else if (target.key.startsWith('group:')) {
      openShared(target.key.slice(6))
      setShareQueue({ key: target.key, reqs })
    } else setShareQueue({ key: 'current', reqs })
    if (isMobile) { setSheetTab('chat'); setSnap('half') }
  }
  useEffect(() => {
    if (!shareQueue) return
    const k = shareQueue.key
    const here = k === 'current' || (k.startsWith('trip:') && state.tripId === k.slice(5)) || (k.startsWith('group:') && activeGroup === k.slice(6) && state.shared?.role === 'admin')
    // a group's plan arrives from the server, and a draft still drawing gets finished first
    if (!here || !state.brief.destination || state.phase === 'planning' || state.phase === 'hotels') return
    const { reqs } = shareQueue
    setShareQueue(null)
    dispatch({ type: 'chat', role: 'ai', text: `Adding ${reqs.length} place${reqs.length === 1 ? '' : 's'} from the link you shared.` })
    ;(async () => {
      for (const r of reqs) {
        if (!(await addFind(r))) dispatch({ type: 'chat', role: 'ai', text: `I couldn’t reach the server to add ${r.name ?? 'that place'}.` })
      }
    })()
  }, [shareQueue, state.tripId, state.brief.destination, state.phase, state.shared?.role, activeGroup])

  const closeProfile = useCallback(() => setProfileOpen(false), [])
  const signOut = async () => {
    const unsent = unsentCount()
    if (unsent && !confirm(`You have ${unsent} change${unsent > 1 ? 's' : ''} that ${unsent > 1 ? 'haven’t' : 'hasn’t'} synced yet. Signing out discards ${unsent > 1 ? 'them' : 'it'}. Sign out anyway?`)) return
    await acct.signOut().catch(err => toast((err as Error).message))
  }

  const live = state.phase === 'planning' || state.phase === 'hotels'
  const totals = useMemo(() => {
    const stops = state.days.reduce((n, d) => n + d.stops.length, 0)
    const rooms = Math.ceil((state.brief.travelers ?? 2) / 2)
    const stay = state.hotel ? state.hotel.hotel.nightly * (state.brief.days ?? 1) * rooms : 0
    return { stops, stay }
  }, [state.days, state.hotel, state.brief])

  const adminName = trip?.people.find(p => p.role === 'owner')?.name ?? 'The admin'
  const chatGroup: ChatGroup | undefined = trip ? {
    role: trip.role === 'owner' ? 'admin' : 'member',
    name: trip.name,
    me: trip.me,
    people: trip.people,
    notes: trip.notes,
    onManage: () => setInviteOpen(true),
  } : undefined
  const deckGroup: DeckGroup | undefined = trip ? {
    role: trip.role === 'owner' ? 'admin' : 'member',
    name: trip.name,
    me: trip.me,
    people: trip.people,
    votes: trip.votes,
    notes: trip.notes,
    adminName,
    onVote: shared.vote,
    onNote: shared.postNote,
    // the deck someone opened over a plan closes back to it; one the admin opened waits for them
    onClose: member && state.shared?.phase !== 'swipe' ? () => shared.setVoting(false) : undefined,
    onInvite: trip.role === 'owner' ? () => setInviteOpen(true) : undefined,
    ranking: isMobile && !state.deckMode ? <GroupRanking state={state} trip={trip} /> : undefined,
  } : undefined
  const voteOn = trip ? { trip, onVote: shared.vote } : undefined

  // Panels are built once and placed either side-by-side (desktop) or in the sheet (phone).
  const journalCollapsed = !isMobile && tucked.journal
  const chatEl = (
    <ChatPanel state={state} typing={typing} canPlan={!member && isReady(state.brief)} onSend={send} onPlan={startDeck}
      collapsed={!isMobile && tucked.chat} onCollapse={() => toggle('chat')} onFocusInput={isMobile ? () => setSnap('full') : undefined}
      group={chatGroup} onNote={shared.postNote}
      confirm={ask ? { question: ask.question, yes: ask.yes, onYes: () => ask.answer(true), onNo: () => ask.answer(false) } : undefined}
      invitePrompt={invitePrompt ? {
        onYes: () => { setInvitePrompt(false); openInvite() },
        onNo: () => { setInvitePrompt(false); dispatch({ type: 'chat', role: 'ai', text: 'No problem. You can invite them later.' }) },
      } : undefined}
      onInvite={account && !member ? openInvite : undefined}
      onBrief={patch => dispatch({ type: 'brief', brief: { ...latest.current.brief, ...patch } })}
      modelIntake={plansRemotely(brain)}
      onRetune={!member ? retune : undefined} />
  )
  const journalEl = state.phase === 'intake' ? null : (
        <aside className={`panel journal ${journalCollapsed ? 'collapsed' : ''}`} aria-hidden={journalCollapsed} {...inertIf(journalCollapsed)}>
          <header className="panel-head">
            <button className="collapse" title="Hide panel" aria-label="Hide panel" onClick={() => toggle('journal')}><ChevronIcon dir="right" /></button>
            {state.phase === 'final' && <button className="dash-open-btn" onClick={() => setDashOpen(true)}>Overview</button>}
            <h2>{state.phase === 'swipe' ? (trip && !state.deckMode ? 'Most liked' : 'Your picks') : state.phase === 'planning' ? 'Mapping' : state.phase === 'hotels' ? 'Finding a base' : 'Itinerary'}</h2>
          </header>

          {state.phase === 'final' && state.hotel && (
            <div className="summary">
              <div><small>Base</small><b>{state.hotel.hotel.name}</b></div>
              <div><small>Stops</small><b>{totals.stops}</b></div>
              <div><small>Stay</small><b>{state.hotel && !state.hotel.hotel.nightly ? 'Booked' : `$${totals.stay.toLocaleString()}`}</b></div>
            </div>
          )}

          <div className="journal-body">
            {state.phase === 'swipe' && (trip && !state.deckMode ? <GroupRanking state={state} trip={trip} /> : <PicksPanel state={state} />)}
            {state.phase === 'planning' && <ThinkingStream thoughts={state.thoughts} live />}
            {(state.phase === 'review' || state.phase === 'final') && <ItineraryPanel state={state} dispatch={dispatch} />}
            {state.phase === 'hotels' && <HotelPanel state={state} dispatch={dispatch} />}
            {state.phase === 'final' && (
              <details className="alt-hotels">
                <summary><BedIcon /> Compare other bases</summary>
                <HotelPanel state={state} dispatch={dispatch} />
              </details>
            )}
          </div>

          {/* the log talks to whoever's planning ("approve it and…"), which isn't a normal user */}
          {!member && state.phase === 'hotels' && <ThinkingStream thoughts={state.thoughts} live={live} compact />}

          {member ? (
            <footer className="actions">
              {state.phase !== 'swipe' && state.sharedDeck.length > 0 && <button className="cta" onClick={() => shared.setVoting(true)}>Vote on places</button>}
              {state.phase === 'swipe' && <p className="m-note">{adminName} builds the plan from everyone’s votes.</p>}
            </footer>
          ) : (
            <footer className="actions">
              {state.deckMode && <button className="ghost" onClick={cancelDeck}>Cancel</button>}
              {state.history.length > 0 && (state.phase === 'review' || state.phase === 'final') && (
                <button className="ghost undo" title={`Undo: ${state.history[state.history.length - 1].label}`} aria-label="Undo last change" onClick={() => dispatch({ type: 'undo' })}>↺</button>
              )}
              {state.phase === 'swipe' && (state.deckMode
                ? <button className="cta" onClick={finishDeck}>{likedCount ? `Add ${likedCount} to my trip` : 'Keep my plan as is'}</button>
                : <button className="cta" disabled={!likedCount && !inGroup} onClick={requestPlan}>{inGroup ? 'Review the group’s picks' : `Map my ${likedCount || ''} pick${likedCount === 1 ? '' : 's'}`}</button>)}
              {state.phase === 'review' && (
                <button className="cta" onClick={approve}>Approve &amp; find hotels</button>
              )}
              {state.phase === 'final' && (
                <button className="cta" onClick={save}>
                  {justSaved ? 'Saved' : state.tripId && trips.some(t => t.id === state.tripId) ? 'Update saved trip' : 'Save trip'}
                </button>
              )}
            </footer>
          )}
        </aside>
  )

  return (
    <div className={`app phase-${state.phase} ${isMobile ? 'is-mobile' : `${tucked.chat && state.phase !== 'swipe' ? 'chat-collapsed' : ''} ${tucked.journal || state.phase === 'intake' ? 'journal-collapsed' : ''}`}`}>
      <MapCanvas state={state} dispatch={dispatch} theme={theme} insets={isMobile
        ? { left: 0, right: 0, top: 56, bottom: state.phase === 'swipe' ? 0 : sheetHeights()[snap] }
        : { left: tucked.chat && state.phase !== 'swipe' ? 60 : 440, right: tucked.journal || state.phase === 'intake' ? 60 : 460 }} />
      <div className="vignette" />

      <TopBar state={state} brain={brain} trips={trips}  onOpen={openTrip} onDelete={removeTrip} onDeleteGroup={account ? deleteShared : undefined} onMoney={() => setMoneyOpen({})} onPhotos={() => setVaultOpen({ section: 'photos' })} onDocs={openDocs}
        groups={groups ?? []} activeGroup={activeGroup} onOpenGroup={openShared} onNewTrip={newTrip} onStartOver={canStartOver ? startOver : undefined} onDevTools={devAdmin ? () => setDevOpen(true) : undefined} devReviews={devReviews} email={account?.email ?? null} onSignOut={signOut} onProfile={account ? () => setProfileOpen(true) : undefined} me={account} alertsUnread={alerts?.unread ?? 0} />

      {newGroup && (
        <div className="trip-nudge" role="status">
          <span>You’ve been added to <b>{newGroup.name}</b></span>
          <button className="cta m-small" onClick={() => { openShared(newGroup.id); setNewGroup(null) }}>Open</button>
          <button className="m-x small" aria-label="Dismiss" onClick={() => setNewGroup(null)}>×</button>
        </div>
      )}

      {state.phase === 'swipe'
        ? <SwipeDeck state={state} dispatch={dispatch} onPlan={state.deckMode ? finishDeck : requestPlan} onCancel={cancelDeck} group={deckGroup} />
        : !isMobile && chatEl}
      {!isMobile && state.phase !== 'swipe' && tucked.chat && (
        <button className="panel-tab left" onClick={() => toggle('chat')} title="Show chat">
          <ChatIcon /><span>Chat</span>{unread && <i className="dot" />}<ChevronIcon dir="right" />
        </button>
      )}

      {state.phase === 'intake' && !member && (
        <div className="hero">
          <Memphis layout="hero" />
          <h1>Describe a trip.<br /><em>Watch it draw itself.</em></h1>
          <p>Wayfarer maps the days and finds the base that keeps them close.</p>
        </div>
      )}
      {state.phase === 'intake' && member && (
        <div className="hero">
          <Memphis layout="hero" />
          <h1>{adminName} is<br /><em>setting things up.</em></h1>
          <p>You’re in. You’ll vote on places as soon as they’re ready.</p>
        </div>
      )}

      {!isMobile && journalEl}

      {!isMobile && state.phase !== 'intake' && tucked.journal && (
        <button className="panel-tab right" onClick={() => toggle('journal')} title="Show panel">
          <ChevronIcon dir="left" />
          {live ? <i className="orb live" /> : <RouteIcon />}
          <span>{state.phase === 'swipe' ? 'Picks' : state.phase === 'planning' ? 'Mapping' : 'Itinerary'}</span>
          <b>{state.phase === 'swipe' ? likedCount : totals.stops || ''}</b>
        </button>
      )}

      {isMobile && state.phase !== 'swipe' && (
        <MobileSheet
          snap={snap}
          onSnap={setSnap}
          active={state.phase === 'intake' ? 'chat' : sheetTab}
          onTab={id => setSheetTab(id as 'chat' | 'plan')}
          tabs={[
            { id: 'chat', label: 'Chat', icon: <ChatIcon />, dot: unread, content: chatEl },
            ...(state.phase === 'intake' ? [] : [{
              id: 'plan',
              label: state.phase === 'planning' ? 'Mapping' : state.phase === 'hotels' ? 'Hotels' : 'Itinerary',
              icon: <RouteIcon />,
              live,
              badge: totals.stops || undefined,
              content: journalEl,
            }]),
          ]}
        />
      )}

      <PlaceCard state={state} dispatch={dispatch} onLogExpense={logExpense} voteOn={voteOn} />

      {showDash && <Dashboard state={state} onClose={() => setDashOpen(false)} onDates={member ? undefined : setDates}
        onMoney={() => openTripMoney()} onPhotos={openTripPhotos} balance={tripBalance} />}

      {moneyOpen && <MoneyApp acct={acct} trip={moneyTrip} scope={moneyOpen.scope} prefill={moneyOpen.prefill} onClose={() => { setMoneyOpen(null); refreshGroups().catch(() => {}) }} />}
      {profileOpen && account && <Profile acct={acct} trips={trips} groups={groups ?? []} themeMode={themeMode} onThemeMode={setThemeMode} alerts={alerts} onReadAlerts={markAllRead} onDocs={openDocs} onClose={closeProfile} />}
      {vaultOpen && <VaultApp acct={acct} scope={vaultOpen.scope} section={vaultOpen.section} onClose={() => { setVaultOpen(null); if (new URLSearchParams(location.search).has('docs')) history.replaceState(null, '', location.pathname) }} />}

      {incoming && <ShareSheet shared={incoming} targets={shareTargets} signedIn={Boolean(account)} onAdd={addShared} onClose={() => setIncoming(null)} onDevTools={devAdmin ? () => { setIncoming(null); setDevOpen(true) } : undefined} />}
      {devOpen && devAdmin && <DevTools onClose={() => { setDevOpen(false); if (new URLSearchParams(location.search).has('dev')) history.replaceState(null, '', location.pathname) }} />}

      {inviteOpen && trip && <InviteFriends trip={trip} tripSize={state.brief.travelers ?? 2} onClose={() => setInviteOpen(false)} onChanged={() => { shared.refresh(); refreshGroups().catch(() => {}) }} />}

      {picksOpen && trip && (
        <GroupPicks state={state} trip={trip} onClose={() => setPicksOpen(false)} onConfirm={(liked, rejected) => {
          setPicksOpen(false)
          plan(liked, rejected, `Mapping the group’s ${liked.length} favourites.`)
        }} />
      )}

      <div className="m-toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className="m-toast">{t.text}</div>)}
      </div>

      <div className="legend">
        <span><i className="l-pin" /> Considering</span>
        <span><i className="l-keep" /> In your plan</span>
        <span><i className="l-hotel" /> Hotel</span>
      </div>
    </div>
  )
}
