import { useEffect, useMemo, useState } from 'react'
import type { City, DayPlan, LngLat } from '../types'
import type { TripState } from '../state/tripStore'
import { cityById } from '../data/cities'
import { fmtClock } from '../planner/geo'
import { bookAhead, estimateCosts, packingList, toICS, toText, tripStats, type PackItem } from '../planner/insights'
import { describe, getWeather, isWet, type TripWeather } from '../services/weather'
import { getPhotos } from '../services/photos'
import { loadChecks, saveChecks } from '../state/persistence'
import { Memphis } from './Memphis'
import { PhotoIcon } from './Icons'
import { fmtMoney } from '../money/currency'

// The trip, at a glance: dates & countdown, weather, what it costs, the days,
// what to book and pack, and the local know-how. Everything is derived from the
// live plan, so it always matches the map.

// Cost categories: validated categorical slots (dark surface), fixed order.
const COST_COLORS: Record<string, string> = { stay: 'var(--cost-stay)', food: 'var(--cost-food)', entry: 'var(--cost-entry)', transport: 'var(--cost-transport)', buffer: 'var(--cost-buffer)' }

const DAY = 86_400_000
const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const isoToday = () => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10)
const niceDate = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' })

interface Props {
  state: TripState
  onClose: () => void
  onDates?: (start: string) => void   // only the trip's admin sets the dates
  // this trip's own Money and Photos
  onMoney: () => void
  onPhotos: () => void
  balance: { myNet: number; currency: string; memberCount: number } | null
}

export function Dashboard(props: Props) {
  const city = cityById(props.state.brief.destination)
  if (!city || !props.state.days.length) return null
  return <DashboardBody {...props} city={city} />
}

function DashboardBody({ state, city, onClose, onDates, onMoney, onPhotos, balance }: Props & { city: City }) {
  const { brief, days, hotel } = state
  const start = brief.startDate
  const people = brief.travelers ?? 2
  const costs = useMemo(() => estimateCosts(brief, days, city, hotel), [brief, days, city, hotel])
  const stats = useMemo(() => tripStats(days), [days])
  const bookings = useMemo(() => bookAhead(days, hotel), [days, hotel])

  // weather for the chosen dates (or a provisional month out until they pick)
  const weatherStart = start ?? addDays(isoToday(), 30)
  const [weather, setWeather] = useState<TripWeather | null | 'error'>(null)
  useEffect(() => {
    let live = true
    setWeather(null)
    getWeather(city.center, weatherStart, days.length).then(w => live && setWeather(w)).catch(() => live && setWeather('error'))
    return () => { live = false }
  }, [city.id, weatherStart, days.length])
  const wx = weather && weather !== 'error' ? weather : undefined
  const packing = useMemo(() => packingList(days, city, wx), [days, city, wx])

  // ticked items (packing + bookings), remembered per trip
  const checkKey = state.tripId ?? `${city.id}-${days.length}`
  const [checks, setChecks] = useState<Record<string, boolean>>(() => loadChecks(checkKey))
  const toggle = (id: string) => setChecks(c => { const next = { ...c, [id]: !c[id] }; saveChecks(checkKey, next); return next })

  const [cover, setCover] = useState<string>()
  useEffect(() => {
    getPhotos(`city-${city.id}`, city.name, city.center, { allowArea: true, context: city.country }).then(p => setCover(p[0]?.url)).catch(() => {})
  }, [city.id])

  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const text = toText(city, days, hotel, start)
    let ok = false
    try { await navigator.clipboard.writeText(text); ok = true } catch {
      // no Clipboard API on plain-http origins (e.g. a phone on the LAN): use a hidden textarea
      const ta = Object.assign(document.createElement('textarea'), { value: text })
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600) }
  }
  const downloadICS = () => {
    if (!start) return
    const blob = new Blob([toICS(city, days, start, hotel?.hotel.name)], { type: 'text/calendar' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${city.name.toLowerCase()}-trip.ics` })
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const countdown = start ? Math.round((new Date(`${start}T00:00:00Z`).getTime() - new Date(`${isoToday()}T00:00:00Z`).getTime()) / DAY) : undefined
  const endDate = start ? addDays(start, days.length - 1) : undefined
  const packed = packing.filter(p => checks[`pack-${p.id}`]).length
  const booked = bookings.filter(b => checks[`book-${b.id}`]).length

  return (
    <div className="dash" role="dialog" aria-label={`${city.name} trip dashboard`}>
      <div className="dash-bar">
        <button className="dash-back" onClick={onClose}>← Map</button>
        <div className="dash-actions">
          <button onClick={downloadICS} disabled={!start} title={start ? 'Download every stop as calendar events' : 'Pick your dates first'}>Add to Calendar</button>
          <button onClick={() => window.print()}>Print</button>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>

      <div className="dash-grid">
        {/* ── hero ── */}
        <section className="card hero-card span-8" style={cover ? { ['--cover' as string]: `url("${cover}")` } : undefined}>
          <Memphis layout="corner" />
          <div className="hero-copy">
            <span className="eyebrow">{city.country} · {days.length} day{days.length > 1 ? 's' : ''} · {people === 1 ? 'Solo' : `${people} people`}</span>
            <h1>{city.name}</h1>
          </div>
        </section>

        <section className="card dates-card span-4">
          <h2>When</h2>
          {start ? (
            <>
              <div className="countdown">
                {countdown! > 1 ? <><b>{countdown}</b><span>days to go</span></>
                  : countdown === 1 ? <><b>1</b><span>day to go</span></>
                  : countdown === 0 ? <><b>Today</b></>
                  : countdown! > -days.length ? <><b>Day {1 - countdown!}</b><span>of {days.length}</span></>
                  : <><b>Done</b><span>Welcome home</span></>}
              </div>
              <p className="date-range">{niceDate(start)} → {niceDate(endDate!)}</p>
            </>
          ) : <p className="date-hint">{onDates ? 'Pick a start date for the forecast and countdown.' : 'Dates aren’t set yet.'}</p>}
          {onDates && (
            <label className="date-pick">
              <span>Start date</span>
              <input type="date" value={start ?? ''} min={isoToday()} onChange={e => e.target.value && onDates(e.target.value)} />
            </label>
          )}
          <LocalClock city={city} />
        </section>

        {/* ── weather ── */}
        <section className="card span-12 weather-card">
          <header className="card-head">
            <h2>{weatherHeadline(wx)}</h2>
            <small>{!start ? 'Provisional, until you pick dates' : wx?.mode === 'typical' ? 'Same dates last year' : wx ? 'Forecast' : ''}</small>
          </header>
          {weather === null && <div className="wx-row">{days.map(d => <div key={d.day} className="wx-day skeleton" />)}</div>}
          {weather === 'error' && <p className="muted">Weather isn’t available right now.</p>}
          {wx && (
            <div className="wx-row">
              {wx.days.map((w, i) => {
                const k = describe(w.code)
                return (
                  <div key={w.date} className={`wx-day ${isWet(w, wx.mode) ? 'wet' : ''}`} style={{ ['--c' as string]: days[i]?.color }}>
                    <span className="wx-label">{niceDate(w.date, { weekday: 'short', day: 'numeric' })}</span>
                    <span className="wx-icon" aria-hidden>{k.icon}</span>
                    <b>{Math.round(w.hi)}° <em>{Math.round(w.lo)}°</em></b>
                    <span className="wx-desc">{k.label}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── money ── */}
        <section className="card span-7 cost-card">
          <header className="card-head">
            <h2>{money(costs.total)} <em>estimated</em></h2>
            {people > 1 && <div className="cost-sub"><b>{money(costs.perPerson)}</b> each</div>}
          </header>
          <CostBar costs={costs} />
          <ul className="cost-lines">
            {costs.lines.map(l => (
              <li key={l.key}>
                <i style={{ background: COST_COLORS[l.key] }} />
                <b>{l.label}</b>
                <span>{money(l.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="fine">≈ {city.essentials.currency.symbol}{Math.round(costs.total * city.essentials.currency.perUsd).toLocaleString()} {city.essentials.currency.code} · Excludes flights</p>
        </section>

        <section className="card span-5 stats-card">
          <h2>In numbers</h2>
          <div className="tiles">
            <Tile n={String(stats.stops)} label="Places" />
            <Tile n={stats.walkKm.toFixed(1)} unit="km" label="On foot" />
            <Tile n={(stats.transitMin / 60).toFixed(1)} unit="h" label={`On the ${city.transport.transitName.toLowerCase()}`} />
            <Tile n={stats.freeHours.toFixed(1)} unit="h" label="Free time" />
          </div>
        </section>

        {/* ── this trip's money and photos ── */}
        <section className="span-12 trip-space">
          <button className="card trip-space-btn" onClick={onMoney}>
            <span className="eyebrow">Trip money</span>
            <b className={balance ? (balance.myNet > 0 ? 'pos' : balance.myNet < 0 ? 'neg' : '') : ''}>
              {!balance ? 'Split costs' : balance.myNet > 0 ? `You’re owed ${fmtMoney(balance.myNet, balance.currency)}`
                : balance.myNet < 0 ? `You owe ${fmtMoney(-balance.myNet, balance.currency)}` : 'All settled'}
            </b>
            <small>{balance ? `Expenses and balances for ${balance.memberCount} ${balance.memberCount === 1 ? 'person' : 'people'}` : 'Log what you spend and who owes whom'}</small>
          </button>
          <button className="card trip-space-btn" onClick={onPhotos}>
            <span className="eyebrow">Trip photos <PhotoIcon /></span>
            <b>{city.name} album</b>
            <small>Photos shared with everyone on this trip</small>
          </button>
        </section>

        {/* ── days ── */}
        <section className="span-12 days-strip">
          <header className="card-head bare"><h2>Day by day</h2></header>
          <div className="day-cards">
            {days.map(d => <DayCard key={d.day} day={d} date={start ? addDays(start, d.day - 1) : undefined} hotel={hotel?.hotel.coord} />)}
          </div>
        </section>

        {/* ── to-dos ── */}
        <section className="card span-4 check-card book-card">
          <header className="card-head"><h2>Book ahead</h2><small>{booked} of {bookings.length}</small></header>
          {bookings.length ? (
            <ul className="checks">
              {bookings.map(b => (
                <li key={b.id} className={checks[`book-${b.id}`] ? 'done' : ''}>
                  <label>
                    <input type="checkbox" checked={Boolean(checks[`book-${b.id}`])} onChange={() => toggle(`book-${b.id}`)} />
                    <span title={b.why}><b>{b.title}</b>{b.day && <em>Day {b.day}</em>}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing needs booking ahead.</p>}
        </section>

        <section className="card span-4 check-card pack-card">
          <header className="card-head"><h2>Packing</h2><small>{packed} of {packing.length}</small></header>
          <div className="pack-bar"><i style={{ width: `${(packed / Math.max(1, packing.length)) * 100}%` }} /></div>
          {(['weather', 'plans', 'local', 'essentials'] as PackItem['group'][]).map(g => {
            const items = packing.filter(p => p.group === g)
            if (!items.length) return null
            return (
              <div key={g} className="pack-group">
                <h4>{{ weather: 'Weather', plans: 'Plans', local: city.name, essentials: 'Essentials' }[g]}</h4>
                <ul className="checks">
                  {items.map(p => (
                    <li key={p.id} className={checks[`pack-${p.id}`] ? 'done' : ''}>
                      <label>
                        <input type="checkbox" checked={Boolean(checks[`pack-${p.id}`])} onChange={() => toggle(`pack-${p.id}`)} />
                        <span title={p.why}><b>{p.label}</b></span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </section>

        <section className="card span-4 local-card">
          <header className="card-head"><h2>Local basics</h2></header>
          <dl>
            <dt>Money</dt><dd>{city.essentials.currency.code} · $1 ≈ {city.essentials.currency.symbol}{city.essentials.currency.perUsd}</dd>
            <dt>Plugs</dt><dd>{city.essentials.plugs}</dd>
            <dt>Tipping</dt><dd>{city.essentials.tipping}</dd>
            <dt>Transit</dt><dd>{city.essentials.transitCard}</dd>
            <dt>Emergency</dt><dd>{city.essentials.emergency}</dd>
          </dl>
          <h4>Good to know</h4>
          <ul className="tips">{city.essentials.etiquette.slice(0, 3).map(t => <li key={t}>{t}</li>)}</ul>
          <h4>Phrases</h4>
          <div className="phrases">
            {city.essentials.phrases.map(p => (
              <div key={p.en} title={p.say}><small>{p.en}</small><b>{p.local}</b></div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function weatherHeadline(wx?: TripWeather): string {
  if (!wx?.days.length) return 'Checking the skies…'
  const hi = wx.days.map(d => d.hi)
  const lo = Math.round(Math.min(...wx.days.map(d => d.lo)))
  const wet = wx.days.filter(d => isWet(d, wx.mode)).length
  const avg = hi.reduce((s, h) => s + h, 0) / hi.length
  const feel = avg >= 28 ? 'Hot' : avg >= 22 ? 'Warm' : avg >= 15 ? 'Mild' : avg >= 8 ? 'Cool' : 'Cold'
  const sky = wet === 0 ? 'dry' : wet === wx.days.length ? 'wet' : `${wet} wet day${wet > 1 ? 's' : ''}`
  return `${feel}, ${sky} · ${lo}–${Math.round(Math.max(...hi))}°`
}

function Tile({ n, unit, label }: { n: string; unit?: string; label: string }) {
  return (
    <div className="tile">
      <b>{n}{unit && <em>{unit}</em>}</b>
      <small>{label}</small>
    </div>
  )
}

// Part-to-whole bar with a budget marker; hover a segment for its share.
function CostBar({ costs }: { costs: ReturnType<typeof estimateCosts> }) {
  const scale = Math.max(costs.total, costs.budget ?? 0)
  const [hover, setHover] = useState<string | null>(null)
  const over = costs.budget !== undefined && costs.total > costs.budget
  return (
    <div className="costbar-wrap">
      <div className="costbar" style={{ width: `${(costs.total / scale) * 100}%` }} onMouseLeave={() => setHover(null)}>
        {costs.lines.filter(l => l.amount > 0).map(l => (
          <div key={l.key} className={`seg ${hover && hover !== l.key ? 'dim' : ''}`} style={{ flexGrow: l.amount, background: COST_COLORS[l.key] }}
            onMouseEnter={() => setHover(l.key)} aria-label={`${l.label} ${money(l.amount)}`}>
            {hover === l.key && <span className="seg-tip"><b>{l.label}</b> {money(l.amount)} · {Math.round((l.amount / costs.total) * 100)}%</span>}
          </div>
        ))}
      </div>
      {costs.budget !== undefined && (
        <>
          {/* near the right edge the label hangs left of the marker so it never clips */}
          <div className={`budget-mark ${costs.budget / scale > 0.8 ? 'end' : ''}`} style={{ left: `${(costs.budget / scale) * 100}%` }}><span>Budget {money(costs.budget)}</span></div>
          <p className={`budget-status ${over ? 'over' : 'under'}`}>
            {over ? `About ${money(costs.total - costs.budget)} over budget` : `About ${money(costs.budget - costs.total)} under budget`}
          </p>
        </>
      )}
    </div>
  )
}

// A tiny hand-drawn-feeling route sketch: stops projected into a small box.
function DayCard({ day, date, hotel }: { day: DayPlan; date?: string; hotel?: LngLat }) {
  // Fit the day's own stops so they never collapse into a blob; a far-away base
  // is pinned to the sketch edge, in its real direction.
  const pts = day.stops.map(s => s.place.coord)
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const kx = Math.cos((lat0 * Math.PI) / 180)
  const xs = pts.map(p => p[0] * kx)
  const ys = pts.map(p => -p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const W = 260, H = 120, P = 18
  const s = Math.min((W - 2 * P) / Math.max(maxX - minX, 0.004), (H - 2 * P) / Math.max(maxY - minY, 0.004))
  const proj = (p: LngLat): [number, number] => [
    P + (p[0] * kx - minX) * s + (W - 2 * P - (maxX - minX) * s) / 2,
    P + (-p[1] - minY) * s + (H - 2 * P - (maxY - minY) * s) / 2,
  ]
  const path = pts.map(proj)
  // nudge near-identical stops apart so every number stays readable
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < path.length; i++) for (let j = i + 1; j < path.length; j++) {
      const dx = path[j][0] - path[i][0], dy = path[j][1] - path[i][1]
      const dist = Math.hypot(dx, dy)
      if (dist >= 18) continue
      const push = (18 - dist) / 2, ux = dist ? dx / dist : 1, uy = dist ? dy / dist : 0
      path[i] = [path[i][0] - ux * push, path[i][1] - uy * push]
      path[j] = [path[j][0] + ux * push, path[j][1] + uy * push]
    }
  }
  let h = hotel ? proj(hotel) : undefined
  if (h) {
    // pull an off-canvas base back along its bearing from the route's middle
    const c: [number, number] = [W / 2, H / 2]
    const dx = h[0] - c[0], dy = h[1] - c[1]
    const k = Math.min(1, (W / 2 - 8) / Math.max(Math.abs(dx), 1e-6), (H / 2 - 8) / Math.max(Math.abs(dy), 1e-6))
    h = [c[0] + dx * k, c[1] + dy * k]
  }
  return (
    <article className="day-card" style={{ ['--c' as string]: day.color }}>
      <header>
        <span className="day-pill">Day {day.day}</span>
        {date && <small>{niceDate(date)}</small>}
      </header>
      <h3>{day.title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="sketch" role="img" aria-label={`Route for day ${day.day}`}>
        {h && path.length > 0 && <path d={`M${h[0]},${h[1]} L${path[0][0]},${path[0][1]} M${path[path.length - 1][0]},${path[path.length - 1][1]} L${h[0]},${h[1]}`} className="sk-hotel" />}
        <path d={path.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ')} className="sk-route" />
        {h && <rect x={h[0] - 5} y={h[1] - 5} width={10} height={10} rx={2} className="sk-base" transform={`rotate(45 ${h[0]} ${h[1]})`} />}
        {path.map((p, i) => (
          <g key={i}><circle cx={p[0]} cy={p[1]} r={8} className="sk-dot" /><text x={p[0]} y={p[1] + 3.5}>{i + 1}</text></g>
        ))}
      </svg>
      <ol className="day-stops">
        {day.stops.map(st => <li key={st.place.id}><time>{fmtClock(st.arrive)}</time><span>{st.place.name}</span>{st.place.book && <i title={st.place.book}>Book</i>}</li>)}
      </ol>
    </article>
  )
}

// "Now in Tokyo 14:05 · 13h ahead of you"
function LocalClock({ city }: { city: City }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])
  const there = new Date(now.toLocaleString('en-US', { timeZone: city.essentials.timezone }))
  const here = new Date(now.toLocaleString('en-US'))
  const diff = Math.round(((there.getTime() - here.getTime()) / 3_600_000) * 2) / 2
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: city.essentials.timezone })
  return (
    <p className="local-clock">
      {city.name} <b>{time}</b>
      <span>{diff === 0 ? 'Same time' : `${Math.abs(diff)}h ${diff > 0 ? 'ahead' : 'behind'}`}</span>
    </p>
  )
}
