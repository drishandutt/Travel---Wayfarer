import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { initialState, isMember, reducer, type SavedTrip, type TripState } from './state/tripStore'
import { deleteTrip, loadCurrent, loadPanels, loadTrips, localCopyOf, saveCurrent, savePanels, saveTrip, setTripScope, snapshot, type PanelPrefs } from './state/persistence'
import { converse, isReady, nextField } from './planner/intake'
import { MockPlanner } from './planner/mockPlanner'
import { RemotePlanner } from './planner/remotePlanner'
import { claudeIntake, detectBrain, type BrainStatus } from './planner/brain'
import { customPlaceRequest, isFind, resolveCustomPlace, type CustomPlaceRequest } from './planner/customPlaces'
import type { Place, PlannerEvent } from './types'
import { MapCanvas } from './components/MapCanvas'
import { ChatPanel, inertIf, type ChatGroup } from './components/ChatPanel'
import { ThinkingStream } from './components/ThinkingStream'
import { ItineraryPanel } from './components/ItineraryPanel'
import { HotelPanel } from './components/HotelPanel'
import { TopBar } from './components/TopBar'
import { PlaceCard } from './components/PlaceCard'
import { PicksPanel, SwipeDeck, type DeckGroup } from './components/SwipeDeck'
import { Dashboard } from './components/Dashboard'
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
import { cityById } from './data/cities'
import { useTheme } from './state/theme'
import { MobileSheet, sheetHeights, useIsMobile, type Snap } from './components/MobileSheet'
import { BedIcon, ChatIcon, ChevronIcon, RouteIcon } from './components/Icons'
import { Memphis } from './components/Memphis'

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
  const [state, dispatch] = useReducer(reducer, initialState, init => {
    const cached = activeGroup ? readLocal<SharedTrip | null>(`trip:${activeGroup}`, null) : null
    if (cached?.plan) return reducer(init, { type: 'shared-plan', plan: cached.plan, role: cached.role === 'owner' ? 'admin' : 'member', version: cached.planVersion, votes: myVotes(cached.votes, cached.me) })
    const local = activeGroup ? localCopyOf(activeGroup) : loadCurrent()
    return local ? reducer(init, { type: 'restore', trip: local }) : init
  })
  const member = isMember(state)
  const [typing, setTyping] = useState(false)
  const [theme, toggleTheme] = useTheme()
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
  const [brain, setBrain] = useState<BrainStatus | null>(null)
  useEffect(() => { detectBrain().then(setBrain) }, [])
  // Claude on the server when configured; otherwise the offline heuristic planner.
  const engine = useMemo(() => (brain?.claude ? new RemotePlanner() : new MockPlanner(1)), [brain])
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

  const send = async (text: string) => {
    dispatch({ type: 'chat', role: 'user', text })
    const s = latest.current

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
    if (brain?.claude && s.phase === 'intake') {
      try {
        const out = await claudeIntake([...s.messages, { id: 'pending', role: 'user', text }], s.brief)
        dispatch({ type: 'brief', brief: { ...out.brief, moneyGroupId: s.brief.moneyGroupId } })
        dispatch({ type: 'chat', role: 'ai', text: out.reply })
      } catch (e) {
        const { brief, reply } = converse(text, latest.current.brief)
        dispatch({ type: 'brief', brief })
        dispatch({ type: 'chat', role: 'ai', text: `(Claude is unreachable: ${(e as Error).message} Using offline mode.) ${reply}` })
      } finally {
        setTyping(false)
      }
      return
    }
    const { brief, reply } = converse(text, s.brief)
    dispatch({ type: 'brief', brief })
    setTimeout(() => {
      setTyping(false)
      dispatch({ type: 'chat', role: 'ai', text: reply })
    }, 450)
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
  const startDeck = () => {
    if (shouldOffer) { offerFriends(); return } // going with friends: ask before the voting starts
    setInvitePrompt(false)
    dispatch({ type: 'start-deck' })
    dispatch({ type: 'chat', role: 'ai', text: activeGroup ? 'Here’s the group’s deck. Swipe right on what you’d love, left to skip.' : 'Here’s your deck, best matches first. Swipe right on what you’d love, left to skip.' })
  }

  // Plan the chosen places.
  const plan = (liked: string[], rejected: string[], label: string) => {
    dispatch({ type: 'phase', phase: 'planning' })
    dispatch({ type: 'chat', role: 'ai', text: label })
    run(signal => engine.planItinerary(latest.current.brief, signal, { liked, rejected }))
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
  const finishDeck = () => dispatch({ type: 'finish-deck' })
  const cancelDeck = () => dispatch({ type: 'finish-deck', cancel: true })

  const approve = () => {
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

  // Shared expenses, connected to this trip.
  const [moneyOpen, setMoneyOpen] = useState<{ prefill?: ExpensePrefill } | null>(null)
  const [vaultOpen, setVaultOpen] = useState(false)
  const moneyBadge = useMoneyBadge(Boolean(moneyOpen))
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
    setMoneyOpen({ prefill: { title: place.name, category: categoryForKind(place.kind), placeId: place.id, placeName: place.name, date } })
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
      invitePrompt={invitePrompt ? {
        onYes: () => { setInvitePrompt(false); openInvite() },
        onNo: () => { setInvitePrompt(false); dispatch({ type: 'chat', role: 'ai', text: 'No problem. You can invite them later.' }) },
      } : undefined}
      onInvite={account && !member ? openInvite : undefined} />
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
              <div><small>Stay</small><b>${totals.stay.toLocaleString()}</b></div>
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
              {state.deckMode
                ? <button className="ghost" onClick={cancelDeck}>Cancel</button>
                : <button className="ghost" onClick={newTrip}>Start over</button>}
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

      <TopBar state={state} brain={brain} trips={trips} onOpen={openTrip} onDelete={removeTrip} theme={theme} onToggleTheme={toggleTheme} onMoney={() => setMoneyOpen({})} moneyBadge={moneyBadge} onPhotos={() => setVaultOpen(true)}
        groups={groups ?? []} activeGroup={activeGroup} onOpenGroup={openShared} onNewTrip={newTrip} email={account?.email ?? null} onSignOut={signOut} />

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

      {showDash && <Dashboard state={state} onClose={() => setDashOpen(false)} onDates={member ? undefined : setDates} onMoney={() => setMoneyOpen({})} />}

      {moneyOpen && <MoneyApp acct={acct} trip={moneyTrip} prefill={moneyOpen.prefill} onClose={() => setMoneyOpen(null)} />}
      {vaultOpen && <VaultApp acct={acct} onClose={() => setVaultOpen(false)} />}

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
