import { useEffect, useRef, useState, type Dispatch } from 'react'
import type { DayPlan, Leg, Place } from '../types'
import { isMember, type Action, type TripState } from '../state/tripStore'
import { fmtClock, fmtCost, travelOptions } from '../planner/geo'
import { cityById } from '../data/cities'
import { BedIcon, PauseIcon, SparkIcon, TransitIcon, WalkIcon } from './Icons'
import { usePhotos } from './SwipeDeck'

type Fare = (leg: Leg) => { label: string; cost: string }

function LegChip({ leg, fare }: { leg: Leg; fare: Fare }) {
  const f = fare(leg)
  return (
    <div className={`leg ${leg.mode}`}>
      {leg.mode === 'walk' ? <WalkIcon /> : <TransitIcon />}
      <span>{f.label}</span>
      <b>{leg.minutes} min</b>
      {f.cost && <em>{f.cost}</em>}
    </div>
  )
}

function Buffer({ minutes, onFill }: { minutes: number; onFill?: () => void }) {
  if (minutes < 5) return null
  const free = minutes >= 45
  const h = Math.floor(minutes / 60)
  const label = h ? `${h}h ${minutes % 60 ? `${minutes % 60}m` : ''}` : `${minutes} min`
  return (
    <div className={`buffer ${free ? 'free' : ''}`}>
      <PauseIcon /> {free ? `${label} free` : `${label} buffer`}
      {free && onFill && <button className="fill" onClick={onFill}>Suggest a stop</button>}
    </div>
  )
}

// The first photo the swipe tile shows. A long trip looks these up only as they near the view,
// so opening a saved one doesn't fire dozens of requests at once.
function StopPhoto({ place }: { place: Place }) {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [skip, setSkip] = useState(0) // a broken image moves on to the next photo
  const [ready, setReady] = useState<string | null>(null)
  const photos = usePhotos(near ? place : undefined)

  useEffect(() => {
    if (!box.current) return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setNear(true); io.disconnect() }
    }, { root: box.current.closest('.journal-body'), rootMargin: '400px' })
    io.observe(box.current)
    return () => io.disconnect()
  }, [])

  const photo = photos?.[skip]
  if (photos && !photo) return null
  return (
    <div ref={box} className={`stop-photo ${photo && ready === photo.full ? 'ready' : ''}`}>
      {photo && (
        <>
          <img key={photo.full} src={photo.url} alt={photo.caption ?? place.name} draggable={false}
            onLoad={() => setReady(photo.full)} onError={() => setSkip(n => n + 1)} />
          <span>{photo.exact ? 'This place' : photo.related ? 'Related' : 'Nearby'} · © {photo.credit}</span>
        </>
      )}
    </div>
  )
}

function Day({ day, hotelName, dispatch, hover, editable, fare, flash }: { day: DayPlan; hotelName?: string; dispatch: Dispatch<Action>; hover: string | null; editable: boolean; fare: Fare; flash: boolean }) {
  const out = day.legs.find(l => l.id.endsWith('-out'))
  const back = day.legs.find(l => l.id.endsWith('-back'))
  return (
    <article className={`day ${flash ? 'flash' : ''}`} style={{ ['--c' as string]: day.color }}>
      <header>
        <span className="day-n">Day {day.day}</span>
        <h3>{day.title}</h3>
        <span className="day-span">{fmtClock(out ? day.stops[0].arrive - out.minutes : day.stops[0].arrive)} – {fmtClock(day.stops[day.stops.length - 1].depart + (back?.minutes ?? 0))}</span>
        {editable && (
          <button className="tidy" title="Re-order stops by time of day and distance" onClick={() => dispatch({ type: 'optimize-day', day: day.day })}>
            <SparkIcon /> Tidy
          </button>
        )}
      </header>
      <ol className="timeline">
        {out && hotelName && (
          <li className="hotel-row"><BedIcon /> Leave {hotelName} <LegChip leg={out} fare={fare} /></li>
        )}
        {day.stops.map((s, i) => (
          <li key={s.place.id}>
            {i > 0 && s.legIn && <LegChip leg={s.legIn} fare={fare} />}
            <div
              className={`stop ${hover === s.place.id ? 'hot' : ''}`}
              onMouseEnter={() => dispatch({ type: 'hover-place', id: s.place.id })}
              onMouseLeave={() => dispatch({ type: 'hover-place', id: null })}
              onClick={() => dispatch({ type: 'select-place', id: s.place.id })}
            >
              <span className="stop-n">{i + 1}</span>
              <div className="stop-body">
                <StopPhoto place={s.place} />
                <div className="stop-top">
                  <b>{s.place.name}</b>
                  <time>{fmtClock(s.arrive)}–{fmtClock(s.depart)}</time>
                </div>
                <p>{s.place.blurb}</p>
                <div className="tags">
                  <span className="kind">{s.place.kind}</span>
                  <span className="price">{s.place.price ? '$'.repeat(s.place.price) : 'free'}</span>
                </div>
              </div>
              {editable && (
                <div className="stop-tools" onClick={e => e.stopPropagation()}>
                  <button title="Earlier" disabled={i === 0} onClick={() => dispatch({ type: 'shift-stop', id: s.place.id, dir: -1 })}>↑</button>
                  <button title="Later" disabled={i === day.stops.length - 1} onClick={() => dispatch({ type: 'shift-stop', id: s.place.id, dir: 1 })}>↓</button>
                  <button title="Remove" disabled={day.stops.length <= 1} onClick={() => dispatch({ type: 'remove-stop', id: s.place.id })}>✕</button>
                </div>
              )}
            </div>
            {i < day.stops.length - 1 && <Buffer minutes={s.bufferAfter} onFill={editable ? () => dispatch({ type: 'fill-gap', day: day.day }) : undefined} />}
          </li>
        ))}
        {back && hotelName && (
          <li className="hotel-row"><BedIcon /> Back to {hotelName} <LegChip leg={back} fare={fare} /></li>
        )}
      </ol>
    </article>
  )
}

export function ItineraryPanel({ state, dispatch }: { state: TripState; dispatch: Dispatch<Action> }) {
  const city = cityById(state.brief.destination)
  // the chip shows the recommended way to travel and what it costs the group
  const fare: Fare = leg => {
    const best = city && travelOptions(leg.from, leg.to, city.transport, state.brief.travelers ?? 2).find(o => o.best)
    return best ? { label: best.label, cost: fmtCost(best.cost) } : { label: leg.mode === 'walk' ? 'Walk' : 'Transit', cost: '' }
  }
  const days = state.activeDay === null ? state.days : state.days.filter(d => d.day === state.activeDay)
  return (
    <div className="itinerary">
      <nav className="day-tabs">
        <button className={state.activeDay === null ? 'on' : ''} onClick={() => dispatch({ type: 'active-day', day: null })}>All</button>
        {state.days.map(d => (
          <button key={d.day} className={state.activeDay === d.day ? 'on' : ''} style={{ ['--c' as string]: d.color }}
            onClick={() => dispatch({ type: 'active-day', day: d.day })}>
            <i /> Day {d.day}
          </button>
        ))}
      </nav>
      <div className="days">
        {days.map(d => {
          const flash = Boolean(state.flash?.days.includes(d.day))
          // re-keying a just-changed day replays its highlight animation
          return <Day key={flash ? `${d.day}-${state.flash!.key}` : d.day} day={d} hotelName={state.hotel?.hotel.name} dispatch={dispatch} hover={state.hoverPlace} editable={!isMember(state) && (state.phase === 'review' || state.phase === 'final')} fare={fare} flash={flash} />
        })}
      </div>
    </div>
  )
}
