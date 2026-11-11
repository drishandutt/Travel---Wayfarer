import type { Dispatch } from 'react'
import type { Place } from '../types'
import { isMember, type Action, type TripState } from '../state/tripStore'
import type { SharedTrip } from '../trip/types'
import { PlaceVotes } from './trip/GroupPicks'
import { PhotoGallery } from './PhotoGallery'
import { SocialVideos } from './SocialVideos'
import { cityById } from '../data/cities'
import { HOTEL_PHOTOS } from '../data/hotelPhotos'
import { PLACE_COVERS } from '../data/placeCovers'
import { AUDIENCE_LABEL, audiencesOfProfile, profileOf } from '../planner/profile'

const SOURCE_NAME: Partial<Record<string, string>> = { google: 'Google Maps', apple: 'Apple Maps', osm: 'OpenStreetMap', waze: 'Waze' }

// Floating card for whichever pin was clicked: photos, details, and the edits
// that make sense for it (add / move / remove a place, or pick a hotel as base).
export function PlaceCard({ state, dispatch, onLogExpense, voteOn }: { state: TripState; dispatch: Dispatch<Action>; onLogExpense: (place: Place, day?: number) => void; voteOn?: { trip: SharedTrip; onVote: (placeId: string, vote: 'like' | 'nope' | null) => void } }) {
  const id = state.selectedPlace
  if (!id) return null
  const place = state.candidates[id]?.place
  const hotel = state.hotelScores.find(h => h.hotel.id === id)
  if (!place && !hotel) return null
  const close = () => dispatch({ type: 'select-place', id: null })

  if (hotel) {
    const h = hotel.hotel
    const chosen = state.hotel?.hotel.id === h.id
    return (
      <div className="place-card hotel" key={h.id}>
        <button className="close" aria-label="Close" onClick={close}>×</button>
        {/* demo hotels are placeholders, so only show the real neighbourhood around them */}
        <PhotoGallery id={h.id} name={h.name} coord={h.coord} exactLookup={false} nearbyLabel="The neighbourhood" lead={HOTEL_PHOTOS[h.id]} />
        <div className="pc-meta">
          <span className="kind">Hotel</span>
          <span>{h.nightly ? `$${h.nightly} a night` : 'Where you’re staying'}</span>
          <span>~{Math.round(hotel.avgCommute)} min to each day</span>
        </div>
        <h3>{h.name}</h3>
        <p>{h.blurb}</p>
        <div className="pc-actions">
          {chosen
            ? <div className="pc-status"><i />{isMember(state) ? 'The base for this trip' : 'Your base for this trip'}</div>
            : !isMember(state) && <button className="day-chip base" onClick={() => dispatch({ type: 'choose-hotel', id: h.id })}><i />Make this my base</button>}
        </div>
      </div>
    )
  }

  const p = place!
  // what it's good and bad at, and who it suits: shown in full when someone who knows the place
  // (or travellers' swipes) said so; the rules' guess only names who it's for
  const prof = profileOf(p)
  const informed = prof.by !== 'rules' || Boolean(prof.learned)
  const bestFor = audiencesOfProfile(prof).yes.slice(0, informed ? 4 : 3)
  const day = state.days.find(d => d.stops.some(s => s.place.id === id))
  const idx = day ? day.stops.findIndex(s => s.place.id === id) : -1
  const stop = day?.stops[idx]
  const planned = state.phase === 'review' || state.phase === 'final'
  const editable = planned && !isMember(state)

  return (
    <div className="place-card" key={p.id} style={day ? { ['--c' as string]: day.color } : undefined}>
      <button className="close" aria-label="Close" onClick={close}>×</button>
      <PhotoGallery id={p.id} name={p.name} coord={p.coord} allowArea={['sight', 'viewpoint', 'park'].includes(p.kind)} context={cityById(state.brief.destination)?.name} nearbyLabel="Nearby" lead={PLACE_COVERS[p.id]} />
      <div className="pc-meta">
        {p.custom && <span className="kind mine">Your find</span>}
        {!p.custom && p.found && <span className="kind found">Traveller’s find</span>}
        <span className="kind">{p.kind}</span>
        <span>{p.minutes} min</span>
        <span>{p.price ? '$'.repeat(p.price) : 'Free'}</span>
      </div>
      <h3>{p.name}</h3>
      <p>{p.blurb}</p>
      {p.custom?.url && <a className="pc-source" href={p.custom.url} target="_blank" rel="noreferrer">Open in {SOURCE_NAME[p.custom.from] ?? 'maps'} ↗</a>}
      {(bestFor.length > 0 || (informed && (prof.strengths.length > 0 || prof.weaknesses.length > 0))) && (
        <dl className="pc-profile">
          {bestFor.length > 0 && <><dt>Best for</dt><dd>{bestFor.map(a => AUDIENCE_LABEL[a]).join(', ')}</dd></>}
          {informed && prof.strengths.length > 0 && <><dt>Good</dt><dd>{prof.strengths.join(' · ')}</dd></>}
          {informed && prof.weaknesses.length > 0 && <><dt>Know</dt><dd>{prof.weaknesses.join(' · ')}</dd></>}
          {prof.learned && <><dt>Swipes</dt><dd>{prof.learned.signals} travellers have weighed in</dd></>}
        </dl>
      )}

      {voteOn && planned && <PlaceVotes placeId={p.id} trip={voteOn.trip} onVote={voteOn.onVote} />}
      {planned && !editable && day && stop && (
        <div className="pc-actions">
          <div className="pc-status"><i />Day {day.day} · stop {idx + 1} · {Math.floor(stop.arrive / 60)}:{String(stop.arrive % 60).padStart(2, '0')}</div>
          <button className="pc-log" onClick={() => onLogExpense(p, day.day)}>Log spending</button>
        </div>
      )}
      {editable && (
        <div className="pc-actions">
          {day && stop ? (
            <>
              <div className="pc-status"><i />Day {day.day} · stop {idx + 1} · {Math.floor(stop.arrive / 60)}:{String(stop.arrive % 60).padStart(2, '0')}</div>
              <div className="pc-row">
                <span>Move to</span>
                {state.days.filter(d => d.day !== day.day).map(d => (
                  <button key={d.day} className="day-chip" style={{ ['--c' as string]: d.color }}
                    onClick={() => dispatch({ type: 'move-stop', id: p.id, toDay: d.day })}>
                    <i />Day {d.day}
                  </button>
                ))}
              </div>
              <button className="pc-log" onClick={() => onLogExpense(p, day.day)}>Log spending</button>
              <button className="danger" disabled={day.stops.length <= 1}
                onClick={() => { dispatch({ type: 'remove-stop', id: p.id }); close() }}>
                Remove from trip
              </button>
            </>
          ) : (
            <div className="pc-row">
              <span>Add to</span>
              {state.days.map(d => (
                <button key={d.day} className="day-chip" style={{ ['--c' as string]: d.color }}
                  onClick={() => dispatch({ type: 'add-stop', id: p.id, day: d.day })}>
                  <i />Day {d.day}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <SocialVideos place={p} city={cityById(state.brief.destination)?.name} />
    </div>
  )
}
