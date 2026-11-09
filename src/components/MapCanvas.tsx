import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre v6 finds its worker relative to its own module URL, which Vite's
// pre-bundling moves; bundle the worker ourselves and point MapLibre at it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { DayPlan, Leg, LngLat, Place } from '../types'
import type { Action, TripState } from '../state/tripStore'
import { arc, fmtCost, travelOptions } from '../planner/geo'
import { CITIES, cityById } from '../data/cities'
import { HOTEL_PHOTOS } from '../data/hotelPhotos'
import type { Photo } from '../services/photos'
import type { Theme } from '../state/theme'
import { photosFor } from './SwipeDeck'

// Free, key-less vector basemap. Swap for MapTiler/Mapbox styles in production.
const STYLE: Record<Theme, string> = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
}
// Day colours are bright for dark maps; on a light map routes use deeper versions (>= 3:1).
// Older saved trips keep the earlier palette, so both sets are mapped.
const LIGHT_ROUTE: Record<string, string> = {
  '#ffd23f': '#b58900', '#ff6fae': '#d6246e', '#2ed3c0': '#0b8f80', '#a78bfa': '#7048e8', '#ff8c42': '#d9480f',
  '#ffb547': '#c27a00', '#ff6b4a': '#d9441f', '#7ee0c8': '#0e9479', '#b79cff': '#7a54e6', '#d7f36b': '#6f9400',
}
const COMMUTE = { dark: '#f5f5f7', light: '#3a3a3c' }
const HOVER = { dark: '#ffffff', light: '#1d1d1f' }

// Route layers live inside the basemap style, so they're re-added whenever it changes.
function addRouteLayers(map: maplibregl.Map, theme: Theme) {
  map.addSource('legs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({ id: 'legs-glow', type: 'line', source: 'legs', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 12, 'line-blur': 8, 'line-opacity': 0.35 } })
  map.addLayer({ id: 'legs-line', type: 'line', source: 'legs', filter: ['==', ['get', 'kind'], 'stop'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 3 } })
  map.addLayer({ id: 'legs-hotel', type: 'line', source: 'legs', filter: ['==', ['get', 'kind'], 'hotel'], layout: { 'line-cap': 'round' },
    paint: { 'line-color': COMMUTE[theme], 'line-width': 2, 'line-dasharray': [1, 2.2] } })
  // hovered route: a strong overlay, plus a fat invisible line that is easy to hit
  map.addLayer({ id: 'legs-hover', type: 'line', source: 'legs', filter: ['==', ['get', 'id'], ''], layout: { 'line-cap': 'round' },
    paint: { 'line-color': HOVER[theme], 'line-width': 5, 'line-blur': 1 } })
  map.addLayer({ id: 'legs-hit', type: 'line', source: 'legs', paint: { 'line-color': '#000', 'line-width': 18, 'line-opacity': 0 } })
}

const DRAW_MS = 650
maplibregl.setWorkerUrl(workerUrl)

type MarkerRec = { marker: maplibregl.Marker; el: HTMLDivElement }

// insets: px covered by the side panels, so camera moves frame the visible map
type Insets = { left: number; right: number; top?: number; bottom?: number } // bottom: a phone's bottom sheet

// Shift that puts a point in the middle of the *visible* map (between the panels).
// An offset is per-move; MapLibre's `padding` option would stick to the map and
// silently shrink every later fitBounds.
const visibleOffset = (i: Insets): [number, number] => [(i.left - i.right) / 2, ((i.top ?? 0) - (i.bottom ?? 0)) / 2]

// Fit padding that frames the gap between the panels, but never squeezes the
// target into less than ~240px (tiny windows): better a little overlap than a dot.
function fitPadding(map: maplibregl.Map, i: Insets) {
  const { clientWidth: w, clientHeight: h } = map.getContainer()
  let left = i.left + 20
  let right = i.right + 20
  const minGap = Math.min(240, w * 0.5)
  if (w - left - right < minGap) { const k = (w - minGap) / (left + right); left *= k; right *= k }
  // vertically: clear the top bar / bottom sheet, but always keep ~35% of the height to fit into
  let top = Math.max(Math.min(140, h * 0.2), (i.top ?? 0) + 20)
  let bottom = Math.max(Math.min(120, h * 0.18), (i.bottom ?? 0) + 20)
  if (top + bottom > h * 0.65) { const k = (h * 0.65) / (top + bottom); top *= k; bottom *= k }
  return { left, right, top, bottom }
}

export function MapCanvas({ state, dispatch, insets, theme }: { state: TripState; dispatch: Dispatch<Action>; insets: Insets; theme: Theme }) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const pins = useRef(new Map<string, MarkerRec>())
  const hotels = useRef(new Map<string, MarkerRec>())
  const progress = useRef(new Map<string, number>())
  const arcs = useRef(new Map<string, LngLat[]>())
  const raf = useRef(0)

  const cameraRef = useRef(state.camera)
  cameraRef.current = state.camera
  const stateRef = useRef(state) // for map event handlers registered once
  stateRef.current = state
  const themeRef = useRef(theme)
  themeRef.current = theme
  const appliedTheme = useRef(theme)
  const [styleGen, setStyleGen] = useState(0) // bumped each time the route layers are rebuilt

  // the card currently on top of the swipe deck
  const focusId = state.phase === 'swipe' ? state.deck[state.deckIndex]?.id : undefined

  // place id -> its slot in the itinerary (day colour + order number)
  const slots = useMemo(() => {
    const m = new Map<string, { day: number; n: number; color: string }>()
    state.days.forEach(d => d.stops.forEach((s, i) => m.set(s.place.id, { day: d.day, n: i + 1, color: d.color })))
    return m
  }, [state.days])

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE[theme],
      center: [20, 25],
      zoom: 1.6,
      pitch: 0,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    if (import.meta.env.DEV) (window as unknown as { __wayfarerMap: maplibregl.Map }).__wayfarerMap = map // debugging hook
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    // pin photos only once the map is close enough for them not to pile up
    const near = () => container.current?.classList.toggle('map-near', map.getZoom() >= 12)
    map.on('zoomend', near)
    map.on('load', near)
    map.on('style.load', () => {
      addRouteLayers(map, themeRef.current)
      setStyleGen(g => g + 1)
    })
    map.on('load', () => {
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'leg-pop', offset: 14, maxWidth: '300px' })
      let shownLeg: string | undefined
      const showLeg = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined
        if (!id) return
        popup.setLngLat(e.lngLat)
        if (id === shownLeg && popup.isOpen()) return // just follow the mouse: redrawing would make the photos flicker
        const tip = legTooltip(stateRef.current, id)
        if (!tip) return
        shownLeg = id
        map.getCanvas().style.cursor = 'pointer'
        map.setFilter('legs-hover', ['==', ['get', 'id'], id])
        popup.setHTML(tip.html).addTo(map)
        fillLegPhotos(popup, tip.ends)
      }
      map.on('mousemove', 'legs-hit', showLeg)
      // touch screens have no hover: tap a route to see it, tap elsewhere to close
      map.on('click', 'legs-hit', showLeg)
      map.on('click', e => {
        if (map.getLayer('legs-hit') && !map.queryRenderedFeatures(e.point, { layers: ['legs-hit'] }).length) { popup.remove(); map.setFilter('legs-hover', ['==', ['get', 'id'], '']) }
      })
      map.on('mouseleave', 'legs-hit', () => {
        map.getCanvas().style.cursor = ''
        map.setFilter('legs-hover', ['==', ['get', 'id'], ''])
        popup.remove()
      })
      setReady(true)
      // Gentle "arrival" on a fresh start; a restored trip has already set the camera.
      if (cameraRef.current) map.jumpTo({ center: cameraRef.current.center, zoom: cameraRef.current.zoom, pitch: 48, bearing: -12 })
      else map.flyTo({ center: CITIES[0].center, zoom: 2.4, speed: 0.4 })
    })
    return () => {
      cancelAnimationFrame(raf.current)
      setReady(false)
      pins.current.clear()
      hotels.current.clear()
      progress.current.clear()
      map.remove()
    }
  }, [])

  // follow the theme: swap the basemap (route layers come back via style.load)
  useEffect(() => {
    if (appliedTheme.current === theme) return
    appliedTheme.current = theme
    mapRef.current?.setStyle(STYLE[theme], { diff: false })
  }, [theme])

  // camera directives from the planner
  useEffect(() => {
    const map = mapRef.current
    if (!map || !state.camera) return
    map.flyTo({ center: state.camera.center, zoom: state.camera.zoom, pitch: 48, bearing: -12, speed: 0.9, curve: 1.5, offset: visibleOffset(insets), essential: true })
  }, [state.camera?.key])

  // while swiping, glide to each card's spot (padded so the deck doesn't cover it)
  useEffect(() => {
    const map = mapRef.current
    const place = focusId ? state.candidates[focusId]?.place : undefined
    const city = cityById(state.brief.destination)
    if (!map || !place || !city) return
    map.easeTo({ center: place.coord, zoom: Math.max(city.zoom + 1.2, Math.min(map.getZoom(), 15)), pitch: 40, duration: 900, offset: visibleOffset(insets) })
  }, [focusId])

  // radar pulse while "thinking"
  useEffect(() => {
    const map = mapRef.current
    if (!map || !state.scan) return
    const el = document.createElement('div')
    el.className = 'scan'
    el.innerHTML = '<i></i><i></i><i></i>'
    const m = new maplibregl.Marker({ element: el }).setLngLat(state.scan.center).addTo(map)
    const t = setTimeout(() => m.remove(), 3200)
    return () => { clearTimeout(t); m.remove() }
  }, [state.scan?.key])

  // place pins
  useEffect(() => {
    const map = mapRef.current
    if (!map) return // markers are DOM, they don't need the style to be loaded
    for (const [id, rec] of pins.current) if (!state.candidates[id]) { rec.marker.remove(); pins.current.delete(id) }
    for (const c of Object.values(state.candidates)) {
      let rec = pins.current.get(c.place.id)
      if (!rec) {
        const el = document.createElement('div')
        el.className = 'marker'
        el.innerHTML = `<div class="pin"><span class="pin-photo"></span><span class="pin-core"></span><span class="pin-label"><b></b><small></small></span></div>`
        el.querySelector('b')!.textContent = c.place.name
        el.querySelector('small')!.textContent = c.place.blurb
        el.addEventListener('mouseenter', () => dispatch({ type: 'hover-place', id: c.place.id }))
        el.addEventListener('mouseleave', () => dispatch({ type: 'hover-place', id: null }))
        el.addEventListener('click', () => dispatch({ type: 'select-place', id: c.place.id }))
        rec = { el, marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(c.place.coord).addTo(map) }
        pins.current.set(c.place.id, rec)
      }
      const slot = slots.get(c.place.id)
      const pin = rec.el.firstElementChild as HTMLDivElement
      pin.dataset.verdict = c.verdict
      pin.dataset.kind = c.place.kind
      pin.dataset.final = state.phase === 'final' ? '1' : ''
      pin.style.setProperty('--c', slot?.color ?? '#f5f5f7')
      ;(pin.querySelector('.pin-core') as HTMLElement).textContent = slot ? String(slot.n) : ''
      pin.classList.toggle('placed', Boolean(slot))
      pin.classList.toggle('dim', state.activeDay !== null && slot?.day !== state.activeDay)
      const hot = state.hoverPlace === c.place.id || state.selectedPlace === c.place.id || focusId === c.place.id
      pin.classList.toggle('hot', hot)
      rec.el.style.zIndex = hot ? '20' : slot ? '5' : '1'
      // a planned or kept place wears its photo beside the pin, like a profile picture
      if ((slot || c.verdict !== 'drop') && !pin.dataset.photo) {
        pin.dataset.photo = 'loading'
        const face = pin.querySelector('.pin-photo') as HTMLElement
        photosFor(c.place).then(p => {
          if (!p[0]) { pin.dataset.photo = 'none'; return }
          face.style.backgroundImage = `url("${smallPhoto(p[0].url).replace(/"/g, '%22')}")`
          pin.dataset.photo = 'ready'
        }).catch(() => { pin.dataset.photo = 'none' })
      }
    }
  }, [state.candidates, slots, state.activeDay, state.hoverPlace, state.selectedPlace, state.phase, focusId, ready])

  // hotel pins
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const live = new Set(state.hotelScores.map(h => h.hotel.id))
    for (const [id, rec] of hotels.current) if (!live.has(id)) { rec.marker.remove(); hotels.current.delete(id) }
    for (const s of state.hotelScores) {
      let rec = hotels.current.get(s.hotel.id)
      if (!rec) {
        const el = document.createElement('div')
        el.className = 'marker'
        el.innerHTML = `<div class="hotel-pin"><span class="hotel-core"><span>⌂</span></span><span class="pin-label"><b></b><small></small></span></div>`
        el.querySelector('b')!.textContent = s.hotel.name
        el.querySelector('small')!.textContent = `$${s.hotel.nightly}/night · ${Math.round(s.avgCommute)} min avg commute`
        el.addEventListener('click', () => dispatch({ type: 'select-place', id: s.hotel.id }))
        rec = { el, marker: new maplibregl.Marker({ element: el }).setLngLat(s.hotel.coord).addTo(map) }
        hotels.current.set(s.hotel.id, rec)
      }
      const chosen = state.hotel?.hotel.id === s.hotel.id
      rec.el.firstElementChild!.classList.toggle('chosen', chosen)
      rec.el.firstElementChild!.classList.toggle('faded', Boolean(state.hotel) && !chosen)
      rec.el.firstElementChild!.classList.toggle('selected', state.selectedPlace === s.hotel.id)
      rec.el.style.zIndex = chosen ? '30' : '2'
    }
  }, [state.hotelScores, state.hotel, state.selectedPlace, ready])

  // animated route drawing
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const ids = new Set(state.legs.map(l => l.leg.id))
    for (const id of [...progress.current.keys()]) if (!ids.has(id)) progress.current.delete(id)
    for (const { leg } of state.legs) {
      const key = `${leg.id}:${leg.from}:${leg.to}`
      if (!arcs.current.has(key)) { arcs.current.set(key, arc(leg.from, leg.to)); progress.current.set(leg.id, 0) }
      if (!progress.current.has(leg.id)) progress.current.set(leg.id, 0)
    }
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      let animating = false
      const features = state.legs.map(({ leg, color }) => {
        const p = Math.min(1, (progress.current.get(leg.id) ?? 1) + dt / DRAW_MS)
        progress.current.set(leg.id, p)
        if (p < 1) animating = true
        const pts = arcs.current.get(`${leg.id}:${leg.from}:${leg.to}`)!
        const n = Math.max(2, Math.ceil(pts.length * p))
        return { type: 'Feature' as const, properties: { id: leg.id, color: theme === 'light' ? LIGHT_ROUTE[color] ?? color : color, kind: leg.kind, day: leg.day },
          geometry: { type: 'LineString' as const, coordinates: pts.slice(0, n) } }
      })
      const src = map.getSource('legs') as maplibregl.GeoJSONSource | undefined
      if (!src) return
      src.setData({ type: 'FeatureCollection', features })
      if (animating) raf.current = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(tick)
  }, [state.legs, ready, styleGen])

  // focus a single day
  useEffect(() => {
    const map = mapRef.current
    // getLayer guards hot-reload, where `ready` can be stale for a fresh map
    if (!map || !ready || !map.getLayer('legs-line')) return
    const op = (on: number, off: number): maplibregl.DataDrivenPropertyValueSpecification<number> =>
      state.activeDay === null ? on : ['case', ['==', ['get', 'day'], state.activeDay], on, off]
    map.setPaintProperty('legs-line', 'line-opacity', op(1, 0.12))
    map.setPaintProperty('legs-glow', 'line-opacity', op(0.35, 0.03))
    map.setPaintProperty('legs-hotel', 'line-opacity', op(0.9, 0.1))
    if (state.activeDay !== null) {
      const d = state.days.find(x => x.day === state.activeDay)
      if (d?.stops.length) {
        const b = new maplibregl.LngLatBounds()
        d.stops.forEach(s => b.extend(s.place.coord))
        if (state.hotel) b.extend(state.hotel.hotel.coord)
        map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }) // clear any padding left on the map by older builds
        // Fit flat, then tilt: fitting with pitch lets the near edge spill past the padding.
        const cam = map.cameraForBounds(b, { padding: fitPadding(map, insets), maxZoom: 15 })
        if (cam) map.easeTo({ ...cam, zoom: (cam.zoom ?? map.getZoom()) - 0.4, pitch: 40, duration: 1200 })
      }
    }
  }, [state.activeDay, ready, styleGen, insets.left, insets.right, insets.bottom]) // re-frame when a panel opens, closes or resizes

  return <div ref={container} className="map" />
}

const ICON: Record<string, string> = {
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 3 3M11 15l-1-5"/></svg>',
  transit: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l2-4M16 21l-2-4"/></svg>',
  taxi: '<svg viewBox="0 0 24 24"><path d="M5 16V11l2-5h10l2 5v5M3 16h18M7 19v-3M17 19v-3"/><circle cx="8" cy="13" r=".8"/><circle cx="16" cy="13" r=".8"/></svg>',
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// Endpoints of a leg: stops come from the day, hotel legs from the base.
type LegEnd = { name: string; place?: Place; hotelId?: string }

function legEnds(s: TripState, day: DayPlan, leg: Leg): [LegEnd, LegEnd] {
  const base: LegEnd = { name: s.hotel?.hotel.name ?? 'Hotel', hotelId: s.hotel?.hotel.id }
  const stop = (place?: Place): LegEnd => ({ name: place?.name ?? '', place })
  if (leg.id.endsWith('-out')) return [base, stop(day.stops[0].place)]
  if (leg.id.endsWith('-back')) return [stop(day.stops[day.stops.length - 1].place), base]
  const i = day.stops.findIndex(st => st.legIn?.id === leg.id)
  return [stop(day.stops[i - 1]?.place), stop(day.stops[i]?.place)]
}

function legTooltip(s: TripState, id: string): { html: string; ends: LegEnd[] } | null {
  const city = cityById(s.brief.destination)
  const day = s.days.find(d => d.legs.some(l => l.id === id))
  const leg = day?.legs.find(l => l.id === id)
  if (!city || !day || !leg) return null
  const ends = legEnds(s, day, leg)
  const travelers = s.brief.travelers ?? 2
  const rows = travelOptions(leg.from, leg.to, city.transport, travelers)
    .map(o => `<div class="lp-row ${o.best ? 'best' : ''}"><span class="ic">${ICON[o.mode]}</span><span class="lbl">${esc(o.label)}</span><b>${o.minutes} min</b><em>${fmtCost(o.cost)}</em>${o.best ? '<i>best</i>' : ''}</div>`)
    .join('')
  return { ends, html: `<div class="lp" style="--c:${day.color}">
    <div class="lp-photos"><div class="lp-photo"></div><div class="lp-photo"></div></div>
    <div class="lp-head"><span>${esc(ends[0].name)}</span><span class="arrow">→</span><span>${esc(ends[1].name)}</span></div>
    <div class="lp-dist">Day ${day.day} · ${leg.km.toFixed(1)} km${travelers > 1 ? ` · costs for ${travelers}` : ''}</div>
    ${rows}
  </div>` }
}

const endPhoto = (end: LegEnd): Promise<Photo | undefined> =>
  end.place ? photosFor(end.place).then(p => p[0]) : Promise.resolve(end.hotelId ? HOTEL_PHOTOS[end.hotelId] : undefined)

// The popup opens at once and its photos follow. Most are already cached from the deck.
function fillLegPhotos(popup: maplibregl.Popup, ends: LegEnd[]) {
  const slots = popup.getElement()?.querySelectorAll<HTMLElement>('.lp-photo')
  ends.forEach((end, i) => {
    const slot = slots?.[i]
    if (!slot) return
    endPhoto(end).catch(() => undefined).then(photo => {
      if (!photo) { slot.classList.add('none'); return }
      const img = new Image()
      img.alt = end.name
      img.onload = () => slot.classList.add('ready')
      img.onerror = () => slot.classList.add('none')
      img.src = photo.url
      const credit = document.createElement('span')
      credit.textContent = `© ${photo.credit}`
      slot.append(img, credit)
    })
  })
}

// Wikimedia serves a thumbnail at any of its standard widths; a pin photo needs a small one.
const smallPhoto = (url: string) => (/\/thumb\//.test(url) ? url.replace(/\/\d+px-([^/]+)$/, '/120px-$1') : url)
