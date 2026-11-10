import type { Action, TripState } from '../state/tripStore'

// What people do in the app, for the dev tools' activity log and its analyst (server/dev):
// every action on the trip (a short summary, never the whole trip), every button pressed,
// which screens they open, and how long the app is in front of them. Sent in batches every
// few seconds and when the page is hidden. Never what's typed into a field other than the
// trip chat, and never passwords.

interface Event { kind: string; at: number; subject?: string | null; detail?: Record<string, unknown> }

const ENDPOINT = '/api/money/dev/activity'
const EVERY_MS = 5000
const MAX_QUEUE = 500
const MAX_PER_MINUTE = 240

let queue: Event[] = []
let sentThisMinute = 0
let installed = false

// One id per browser (or phone), so a session before sign-in joins up with the person after.
export const deviceId = (() => {
  try {
    let id = localStorage.getItem('wf_device')
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem('wf_device', id)
    }
    return id
  } catch { return 'no-storage' }
})()

export function trackApp(kind: string, detail?: Record<string, unknown>, subject?: string | null) {
  if (queue.length >= MAX_QUEUE) return
  queue.push({ kind: `app.${kind}`, at: Date.now(), subject: subject ?? null, ...(detail ? { detail } : {}) })
}

function send(beacon = false) {
  if (!queue.length) return
  const room = Math.max(0, MAX_PER_MINUTE - sentThisMinute)
  const batch = queue.splice(0, Math.min(60, room))
  if (!batch.length) return
  sentThisMinute += batch.length
  const body = JSON.stringify({ device: deviceId, events: batch })
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' })); return }
  fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {
    if (queue.length + batch.length <= MAX_QUEUE) queue = [...batch, ...queue]
  })
}

// ── trip actions ─────────────────────────────────────────────────────────────

// Streams and syncs that would drown everything else out, and say nothing about the person.
const SKIP = new Set<Action['type']>(['hover-place', 'shared-synced', 'shared-plan', 'city-ready', 'shared-role'])
const PLANNER_KEEP = new Set(['plan-ready', 'error', 'hotel-pick'])

const placeName = (s: TripState, id?: string | null) => (id ? s.candidates[id]?.place.name ?? s.days.flatMap(d => d.stops).find(x => x.place.id === id)?.place.name : undefined)

// A short, flat summary of one action, with what was on screen when it happened.
export function summarise(a: Action, s: TripState): Record<string, unknown> | null {
  if (SKIP.has(a.type)) return null
  const base: Record<string, unknown> = { type: a.type, phase: s.phase, destination: s.brief.destination ?? null }
  switch (a.type) {
    case 'chat': return { ...base, role: a.role, text: a.text.slice(0, a.role === 'user' ? 500 : 240) }
    case 'chat-edit': return { ...base, text: a.text.slice(0, 500) }
    case 'brief': {
      const b = a.brief
      return { ...base, destination: b.destination ?? null, days: b.days ?? null, travelers: b.travelers ?? null, vibes: b.vibes, budgetTier: b.budgetTier ?? null, budgetAmount: b.budgetAmount ?? null, pace: b.pace ?? null, tastes: b.tastes ?? [], sliders: sliders(b) }
    }
    case 'retune': return { ...base, sliders: sliders(a.brief) }
    case 'phase': return { ...base, to: a.phase }
    case 'planner':
      if (!PLANNER_KEEP.has(a.event.type)) return null
      return { ...base, event: a.event.type, ...(a.event.type === 'error' ? { message: a.event.message.slice(0, 300) } : {}), ...(a.event.type === 'hotel-pick' ? { hotel: a.event.score.hotel.name, nightly: a.event.score.hotel.nightly } : {}) }
    case 'swipe': {
      const card = s.deck[s.deckIndex]
      return { ...base, like: a.like, place: card?.id ?? null, name: placeName(s, card?.id) ?? null, match: card ? Math.round(card.match * 100) : null, why: card?.why ?? null, index: s.deckIndex }
    }
    case 'select-place': return { ...base, place: a.id, name: placeName(s, a.id) ?? null }
    case 'remove-stop': case 'move-stop': case 'shift-stop': case 'add-stop':
      return { ...base, place: a.id, name: placeName(s, a.id) ?? null, ...('toDay' in a ? { toDay: a.toDay } : {}), ...('day' in a ? { day: a.day } : {}), ...('dir' in a ? { dir: a.dir } : {}) }
    case 'add-custom-place': return { ...base, place: a.place.id, name: a.place.name, kind: a.place.kind, from: a.place.custom?.from ?? null, day: a.day ?? null }
    case 'choose-hotel': return { ...base, hotel: a.id }
    case 'active-day': return { ...base, day: a.day }
    case 'optimize-day': case 'fill-gap': return { ...base, day: a.day }
    case 'finish-deck': return { ...base, cancel: Boolean(a.cancel), kept: Object.values(s.picks).filter(v => v === 'like').length, skipped: Object.values(s.picks).filter(v => v === 'nope').length }
    case 'deck-lane': return { ...base, lane: a.lane }
    case 'restore': return { ...base, trip: a.trip.id, destination: a.trip.brief.destination ?? null, days: a.trip.days.length }
    case 'saved': return { ...base, trip: a.id, stops: s.days.reduce((n, d) => n + d.stops.length, 0) }
    default: return base
  }
}

function sliders(b: TripState['brief']): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of ['familiarity', 'paceLevel', 'rhythm', 'structure', 'walking', 'foodie', 'crowds', 'splurgeOn', 'energy', 'kids'] as const) if (b[k] !== undefined) out[k] = b[k]!
  return out
}

export function trackAction(a: Action, s: TripState) {
  try {
    const d = summarise(a, s)
    if (d) trackApp('action', d, typeof d.place === 'string' ? d.place : null)
  } catch { /* never get in the way of the app */ }
}

// A screen opened or closed: money, photos, the dashboard, dev tools…
export const trackScreen = (screen: string, open = true) => trackApp('screen', { screen, open })

// ── presses and time ─────────────────────────────────────────────────────────

const AREAS = ['.dev-app', '.m-app', '.dash', '.place-card', '.dcard', '.swipe', '.panel.chat', '.panel', '.top-bar', '.topbar', '[role=dialog]', 'header', 'nav']

function labelOf(el: HTMLElement): string {
  const own = el.getAttribute('aria-label') || el.getAttribute('title') || ''
  const text = (own || el.textContent || '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 80) || el.tagName.toLowerCase()
}

export function installActivity() {
  if (installed) return
  installed = true
  // the app's own API calls carry the device id, so what someone did before signing in joins
  // up with them after (server/dev/activity.ts reads x-wayfarer-device)
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : ''
    if (url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`)) {
      const headers = new Headers(init?.headers)
      if (!headers.has('x-wayfarer-device')) headers.set('x-wayfarer-device', deviceId)
      return nativeFetch(input, { ...init, headers })
    }
    return nativeFetch(input, init)
  }
  trackApp('open', {
    platform: (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() ? 'iPhone app' : 'browser',
    width: window.innerWidth,
    height: window.innerHeight,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    path: location.pathname,
    referrer: document.referrer ? new URL(document.referrer).hostname : null,
  })
  document.addEventListener('click', e => {
    try {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('button, a, [role=button], [role=tab], summary, label, select, input[type=checkbox], input[type=radio]')
      if (!el) return
      // fields people type into are left alone: only what they pressed
      if (el.tagName === 'INPUT' && !['checkbox', 'radio'].includes((el as HTMLInputElement).type)) return
      const area = AREAS.find(sel => el.closest(sel))
      trackApp('click', { label: labelOf(el), area: area?.replace(/^[.[]|\]$/g, '') ?? null, ...(el.tagName === 'A' ? { href: (el as HTMLAnchorElement).href.slice(0, 200) } : {}), ...(el.tagName === 'INPUT' ? { checked: (el as HTMLInputElement).checked } : {}) })
    } catch { /* never get in the way */ }
  }, true)
  let shownAt = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      trackApp('visible', { seconds: Math.round((Date.now() - shownAt) / 1000) })
      send(true)
    } else shownAt = Date.now()
  })
  window.addEventListener('pagehide', () => send(true))
  setInterval(() => send(), EVERY_MS)
  setInterval(() => { sentThisMinute = 0 }, 60_000)
}
