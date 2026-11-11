import { useState, type Dispatch } from 'react'
import { isMember, type Action, type TripState } from '../state/tripStore'
import type { Photo } from '../services/photos'
import { HOTEL_PHOTOS } from '../data/hotelPhotos'

function Cover({ photo }: { photo?: Photo }) {
  const [ready, setReady] = useState(false)
  const [broken, setBroken] = useState(false)
  if (!photo || broken) return null
  return (
    <div className="hotel-photo">
      <img src={photo.url} alt={photo.caption ?? ''} loading="lazy" draggable={false} className={ready ? 'ready' : ''}
        onLoad={() => setReady(true)} onError={() => setBroken(true)} />
      <span>{photo.exact ? 'This hotel' : 'The neighbourhood'} · © {photo.credit} · {photo.license}</span>
    </div>
  )
}

export function HotelPanel({ state, dispatch }: { state: TripState; dispatch: Dispatch<Action> }) {
  const sorted = [...state.hotelScores].sort((a, b) => b.total - a.total)
  return (
    <div className="hotels">
      {sorted.map((s, i) => {
        const chosen = state.hotel?.hotel.id === s.hotel.id
        return (
          <button key={s.hotel.id} className={`hotel-card ${chosen ? 'chosen' : ''}`} style={{ animationDelay: `${i * 70}ms` }} disabled={isMember(state)}
            onClick={() => dispatch({ type: 'choose-hotel', id: s.hotel.id })}>
            <Cover photo={HOTEL_PHOTOS[s.hotel.id]} />
            <div className="hotel-top">
              <div>
                <b>{s.hotel.name}</b>
                <small>{s.hotel.blurb}</small>
              </div>
              <div className="fit">{Math.round(s.total * 100)}<sup>%</sup></div>
            </div>
            <div className="hotel-meta">
              <span>{s.hotel.nightly ? `$${s.hotel.nightly} a night` : 'Where you’re staying'}</span>
              <span>~{Math.round(s.avgCommute)} min to each day</span>
            </div>
            {chosen && <span className="badge">Your base</span>}
          </button>
        )
      })}
    </div>
  )
}
