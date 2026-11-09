import { useMemo, useState } from 'react'
import type { Place } from '../../types'
import type { TripState } from '../../state/tripStore'
import { tripCity } from '../../data/cities'
import { dayShape } from '../../planner/core'
import { defaultPicks, rankDeck, rejectedPlaces, votingProgress, type PlaceTally } from '../../trip/votes'
import type { SharedTrip } from '../../trip/types'
import { Modal } from '../money/parts'
import { usePhotos } from '../SwipeDeck'

const namesOf = (trip: SharedTrip, ids: string[]) => ids.map(id => (id === trip.me ? 'You' : trip.people.find(p => p.id === id)?.name ?? '?')).join(', ')

export const planCapacity = (state: TripState) => (state.brief.days ?? 3) * dayShape(state.brief).perDay

function Row({ place, tally, trip, chosen, onToggle }: { place: Place; tally: PlaceTally; trip: SharedTrip; chosen?: boolean; onToggle?: () => void }) {
  const photos = usePhotos(place)
  const thumb = photos?.[0]?.url
  const who = [tally.likes.length ? `Liked by ${namesOf(trip, tally.likes)}` : '', tally.nopes.length ? `Skipped by ${namesOf(trip, tally.nopes)}` : ''].filter(Boolean).join(' · ')
  const body = (
    <>
      {onToggle && <input type="checkbox" className="m-check" checked={Boolean(chosen)} readOnly tabIndex={-1} aria-hidden />}
      <span className="thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined} />
      <span className="rank-main">
        <b>{place.name}</b>
        <small>{who || `${place.kind} · no votes yet`}</small>
      </span>
      <span className="rank-count" aria-label={`${tally.likes.length} liked, ${tally.nopes.length} skipped`}><b>♥ {tally.likes.length}</b><em>✕ {tally.nopes.length}</em></span>
    </>
  )
  return onToggle
    ? <li><button type="button" className={`rank-row ${chosen ? 'on' : ''}`} aria-pressed={Boolean(chosen)} onClick={onToggle}>{body}</button></li>
    : <li className="rank-row">{body}</li>
}

// Most liked so far, for anyone to look at while the votes come in.
export function GroupRanking({ state, trip }: { state: TripState; trip: SharedTrip }) {
  const city = tripCity(state.brief)
  const deck = state.sharedDeck
  const ranked = useMemo(() => rankDeck(deck, trip.votes).filter(t => t.likes.length || t.nopes.length).slice(0, 15), [deck, trip.votes])
  const progress = votingProgress(deck, trip.votes, trip.people)
  return (
    <div className="ranking">
      <p className="m-note"><b>{progress.finished.length} of {progress.voters.length}</b> finished voting{progress.waiting.length > 0 && progress.waiting.length <= 4 ? `. Still going: ${namesOf(trip, progress.waiting.map(p => p.id))}.` : '.'}</p>
      {!ranked.length && <p className="picks-empty">Places people like land here, with the favourites at the top.</p>}
      <ol className="rank-list">
        {ranked.map(t => {
          const place = city?.places.find(p => p.id === t.placeId)
          return place ? <Row key={t.placeId} place={place} tally={t} trip={trip} /> : null
        })}
      </ol>
    </div>
  )
}

// The admin's last word: most liked places are ticked to start with, and they can change any of them.
export function GroupPicks({ state, trip, onClose, onConfirm }: { state: TripState; trip: SharedTrip; onClose: () => void; onConfirm: (liked: string[], rejected: string[]) => void }) {
  const city = tripCity(state.brief)
  const deck = state.sharedDeck
  const capacity = planCapacity(state)
  const ranked = useMemo(() => rankDeck(deck, trip.votes), [deck, trip.votes])
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(defaultPicks(deck, trip.votes, capacity)))
  const progress = votingProgress(deck, trip.votes, trip.people)
  const notIn = trip.people.filter(p => !p.joined)

  const toggle = (id: string) => setChosen(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const confirm = () => {
    const rejected = rejectedPlaces(deck, trip.votes).filter(id => !chosen.has(id))
    onConfirm(ranked.map(t => t.placeId).filter(id => chosen.has(id)), rejected)
  }

  return (
    <Modal
      eyebrow="The group’s picks"
      title="What goes in the plan?"
      onClose={onClose}
      footer={(
        <>
          <span className={`m-form-status ${chosen.size ? 'good' : 'bad'}`} role="status">
            {!chosen.size ? 'Pick at least one place' : chosen.size > capacity ? `${chosen.size} places is more than the ~${capacity} that fit comfortably` : `${chosen.size} of about ${capacity} that fit`}
          </span>
          <button className="ghost" onClick={onClose}>Keep voting</button>
          <button className="cta" disabled={!chosen.size} onClick={confirm}>Map {chosen.size} place{chosen.size === 1 ? '' : 's'}</button>
        </>
      )}
    >
      <p className="m-note">
        <b>{progress.finished.length} of {progress.voters.length}</b> finished voting.
        {progress.waiting.length > 0 && ` Still going: ${namesOf(trip, progress.waiting.map(p => p.id))}.`}
        {notIn.length > 0 && ` Not signed up yet: ${notIn.map(p => p.name).join(', ')}.`}
        {' '}The most liked places are ticked. It’s your call: change anything.
      </p>
      <ol className="rank-list">
        {ranked.map(t => {
          const place = city?.places.find(p => p.id === t.placeId)
          return place ? <Row key={t.placeId} place={place} tally={t} trip={trip} chosen={chosen.has(t.placeId)} onToggle={() => toggle(t.placeId)} /> : null
        })}
      </ol>
    </Modal>
  )
}

// Like or skip from a place's card, with what everyone else thought.
export function PlaceVotes({ placeId, trip, onVote }: { placeId: string; trip: SharedTrip; onVote: (placeId: string, vote: 'like' | 'nope' | null) => void }) {
  const mine = trip.votes.find(v => v.placeId === placeId && v.memberId === trip.me)?.vote
  const likes = trip.votes.filter(v => v.placeId === placeId && v.vote === 'like').map(v => v.memberId)
  const nopes = trip.votes.filter(v => v.placeId === placeId && v.vote === 'nope').map(v => v.memberId)
  return (
    <div className="pc-votes">
      <div className="pc-vote-buttons" role="group" aria-label="Your vote">
        <button type="button" aria-pressed={mine === 'like'} className={mine === 'like' ? 'on' : ''} onClick={() => onVote(placeId, mine === 'like' ? null : 'like')}>♥ Like</button>
        <button type="button" aria-pressed={mine === 'nope'} className={mine === 'nope' ? 'on' : ''} onClick={() => onVote(placeId, mine === 'nope' ? null : 'nope')}>✕ Skip</button>
      </div>
      <small>
        {likes.length ? `Liked by ${namesOf(trip, likes)}` : 'No likes yet'}
        {nopes.length ? ` · Skipped by ${namesOf(trip, nopes)}` : ''}
      </small>
    </div>
  )
}
