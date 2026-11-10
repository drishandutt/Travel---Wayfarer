import { useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react'
import type { Place } from '../types'
import { lastSwiped, type Action, type TripState } from '../state/tripStore'
import { laneOf, type DeckCard, type Lane } from '../planner/core'
import { cityOfPlace, tripCity } from '../data/cities'
import { getVideos } from '../services/videos'
import { PLACE_COVERS } from '../data/placeCovers'
import { getPhotos, type Photo } from '../services/photos'
import { SocialVideos } from './SocialVideos'
import { GroupChat } from './trip/GroupChat'
import { Modal } from './money/parts'
import { votingProgress } from '../trip/votes'
import { Memphis } from './Memphis'
import type { PlaceVote, TripNote, TripPerson, VoteValue } from '../trip/types'

// Set when the deck belongs to a group: everyone swipes the same tiles, and the votes count.
export interface DeckGroup {
  role: 'admin' | 'member'
  name: string
  me: string
  people: TripPerson[]
  votes: PlaceVote[]
  notes: TripNote[]
  adminName: string
  onVote: (placeId: string, vote: VoteValue | null) => void
  onNote: (text: string) => void
  onClose?: () => void
  onInvite?: () => void   // the admin, while nobody else has joined
  ranking?: ReactNode     // the group's most liked, for phones (desktop shows it beside the deck)
}

const THRESHOLD = 110 // px of drag that counts as a decision
// what a food or drink spot is good for, from when it's best
const MEAL = { morning: 'Breakfast & coffee', midday: 'Lunch', evening: 'Dinner', night: 'Drinks & late' } as const
const LANE_NAME: Record<Lane, string> = { places: 'Places', food: 'Food & drink' }
const AREA_KINDS = ['sight', 'viewpoint', 'park']

// same lookup options as the place card, so both share one cached result
export const photosFor = (p: Place) =>
  getPhotos(p.id, p.name, p.coord, { allowArea: AREA_KINDS.includes(p.kind), context: cityOfPlace(p)?.name, lead: PLACE_COVERS[p.id] })

export function usePhotos(place?: Place) {
  const lead = place && PLACE_COVERS[place.id] // a hand-picked photo needn't wait for the lookup
  const [photos, setPhotos] = useState<Photo[] | null>(lead ? [lead] : null)
  useEffect(() => {
    if (!place) return
    let live = true
    setPhotos(lead ? [lead] : null)
    photosFor(place).then(p => live && setPhotos(p)).catch(() => live && setPhotos([]))
    return () => { live = false }
  }, [place?.id])
  return photos
}

function Card({ place, card, top, leaving, onRelease, likedBy, voting }: {
  place: Place
  card: DeckCard
  top: boolean
  leaving: 'left' | 'right' | null
  onRelease: (dir: 'left' | 'right') => void
  likedBy?: string[]
  voting: boolean
}) {
  const photos = usePhotos(place)
  const [shown, setShown] = useState(0)
  const [ready, setReady] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const onDown = (e: React.PointerEvent) => {
    if (!top || leaving || (e.target as HTMLElement).closest('.social')) return // the feed scrolls and plays, it doesn't swipe
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    start.current = { x: e.clientX, y: e.clientY }
    setDrag({ x: 0, y: 0 })
  }
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return
    setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y })
  }
  const onUp = (e: React.PointerEvent) => {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    start.current = null
    if (Math.abs(dx) > THRESHOLD) return onRelease(dx > 0 ? 'right' : 'left')
    // a tap on the photo flips through pictures, like stories
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && photos && photos.length > 1) {
      const el = (e.currentTarget as HTMLElement).querySelector('.dc-photo')!.getBoundingClientRect()
      if (e.clientY < el.bottom) setShown(n => (e.clientX - el.left > el.width / 2 ? Math.min(photos.length - 1, n + 1) : Math.max(0, n - 1)))
    }
    setDrag(null)
  }

  const dx = leaving ? (leaving === 'right' ? 1 : -1) * 700 : drag?.x ?? 0
  const dy = leaving ? 40 : (drag?.y ?? 0) * 0.25
  const style = top
    ? {
        transform: `translate(${dx}px, ${dy}px) rotate(${dx / 16}deg)`,
        transition: drag && !leaving ? 'none' : 'transform .32s cubic-bezier(.2,.8,.2,1)',
      }
    : undefined
  const keepOpacity = Math.max(0, Math.min(1, dx / THRESHOLD))
  const skipOpacity = Math.max(0, Math.min(1, -dx / THRESHOLD))
  const photo = photos?.[Math.min(shown, photos.length - 1)]
  const food = laneOf(place) === 'food'

  return (
    <article className={`dcard ${top ? 'top' : ''}`} style={style}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { start.current = null; setDrag(null) }}>
      <div className="dc-scroll">
        <div className="dc-first">
          <div className="dc-photo">
            {photos === null && <div className="dc-shimmer" />}
            {photos?.length === 0 && <div className="dc-nophoto">{place.kind}</div>}
            {photos?.map(p => (
              <img key={p.full} src={p.url} alt={p.caption ?? place.name} draggable={false}
                className={`${p === photo ? 'on' : ''} ${ready[p.full] ? 'ready' : ''}`}
                onLoad={() => setReady(r => ({ ...r, [p.full]: true }))} />
            ))}
            {photos && photos.length > 1 && (
              <div className="dc-bars">{photos.map((p, n) => <i key={p.full} className={n <= shown ? 'on' : ''} />)}</div>
            )}
            <span className="dc-match">{Math.round(card.match * 100)}% match</span>
            {photo && <span className={`dc-src ${photo.exact ? 'exact' : ''}`}>{photo.exact ? 'This place' : photo.related ? 'Related' : 'Nearby'} · © {photo.credit}</span>}
            {likedBy && likedBy.length > 0 && <span className="dc-likes">♥ {likedBy.join(', ')}</span>}
            <b className="stamp keep" style={{ opacity: keepOpacity }}>{voting ? 'Like' : 'Keep'}</b>
            <b className="stamp skip" style={{ opacity: skipOpacity }}>Skip</b>
          </div>
          <div className="dc-body">
            <div className="dc-meta">
              {place.custom ? <span className="kind mine">Your find</span> : place.found ? <span className="kind found">Traveller’s find</span> : <span className="kind">{place.kind}</span>}
              {food ? <span>{MEAL[place.bestAt ?? 'midday']}</span> : <span>{place.minutes} min</span>}
              <span>{place.price ? '$'.repeat(place.price) : 'Free'}</span>
            </div>
            <h3>{place.name}</h3>
            <p>{place.blurb}</p>
            {food && place.keywords?.length ? <div className="dc-tastes">{place.keywords.slice(0, 4).map(k => <span key={k}>{k}</span>)}</div> : null}
            <div className="dc-why">{card.why.replace(/^matches/, 'Matches your').replace(/· matches/, '· matches your')}</div>
          </div>
        </div>
        <SocialVideos place={place} active={top} />
      </div>
    </article>
  )
}

export function SwipeDeck({ state, dispatch, onPlan, onCancel, group: shared }: { state: TripState; dispatch: Dispatch<Action>; onPlan: () => void; onCancel: () => void; group?: DeckGroup }) {
  const city = tripCity(state.brief)
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [notesRead, setNotesRead] = useState(shared?.notes.length ?? 0)
  const byId = (id?: string) => city?.places.find(p => p.id === id)
  const editing = Boolean(state.deckMode) // a mini deck opened from chat over an existing plan
  const done = state.deckIndex >= state.deck.length
  // two runs of cards, places then food and drink, each with its own progress
  const laneAt = (i: number): Lane => { const p = byId(state.deck[i]?.id); return p ? laneOf(p) : 'places' }
  const lanes = (['places', 'food'] as Lane[]).map(lane => {
    const cards = state.deck.filter((_, i) => laneAt(i) === lane)
    return { lane, total: cards.length, decided: cards.filter(c => state.picks[c.id]).length, kept: cards.filter(c => state.picks[c.id] === 'like').length }
  })
  const lane = done ? undefined : laneAt(state.deckIndex)
  const both = lanes.every(l => l.total > 0)
  const decided = lanes.reduce((n, l) => n + l.decided, 0)
  // the places are done and the food hasn't started: a pause between the two decks
  const [foodReady, setFoodReady] = useState(false)
  useEffect(() => setFoodReady(false), [state.deck[0]?.id, state.deckMode?.label])
  const placesRun = lanes[0]
  const foodRun = lanes[1]
  const between = both && lane === 'food' && !foodReady && placesRun.decided === placesRun.total && foodRun.decided === 0
  // a private mini deck doesn't count as voting
  const group = editing ? undefined : shared
  const member = group?.role === 'member'
  const inGroup = Boolean(group && group.people.length > 1)
  // the whole group's deck: this person's may be only what they haven't decided yet
  const progress = group ? votingProgress(state.sharedDeck, group.votes, group.people) : null
  const liked = group ? Object.values(state.picks).filter(v => v === 'like').length : state.deck.filter(c => state.picks[c.id] === 'like').length

  // a ref, not just state: two taps before the next render would otherwise both count against
  // the same card, and the one after it would be skipped without a vote
  const busy = useRef(false)
  const decide = (dir: 'left' | 'right') => {
    if (busy.current || leaving || done || between) return
    busy.current = true
    const card = state.deck[state.deckIndex]
    setLeaving(dir)
    if (group && card) group.onVote(card.id, dir === 'right' ? 'like' : 'nope')
    setTimeout(() => { dispatch({ type: 'swipe', like: dir === 'right' }); setLeaving(null); busy.current = false }, 260)
  }

  const back = lastSwiped(state)
  const undo = () => {
    const prev = back === undefined ? undefined : state.deck[back]
    if (!prev) return
    if (group) group.onVote(prev.id, null)
    dispatch({ type: 'undo-swipe' })
  }

  // ← skip, → keep, Backspace undo (unless typing somewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (chatOpen || (e.target instanceof Element && e.target.closest('input, textarea'))) return
      if (e.key === 'ArrowRight') decide('right')
      if (e.key === 'ArrowLeft') decide('left')
      if (e.key === 'Backspace') undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // warm the photo cache for the next cards so they appear instantly, and start the next card's
  // reels and videos (a first search for a place takes a while; after that they're kept)
  // the cards under the top one: the next undecided ones in the same deck
  const visible = done ? [] : [state.deckIndex, ...state.deck.map((_, i) => i).filter(i => i > state.deckIndex && !state.picks[state.deck[i].id] && laneAt(i) === lane)]
    .slice(0, 3).map(i => state.deck[i])
  useEffect(() => {
    visible.slice(1).forEach(c => { const p = byId(c.id); if (p) photosFor(p).catch(() => {}) })
    const next = byId(visible[1]?.id)
    if (next) getVideos(next, cityOfPlace(next)?.name).catch(() => {})
  }, [state.deckIndex])
  const likedByOthers = (id: string) => group?.votes
    .filter(v => v.placeId === id && v.vote === 'like' && v.memberId !== group.me)
    .map(v => group.people.find(p => p.id === v.memberId)?.name ?? '?')
  const ctaLabel = inGroup ? 'Review the group’s picks' : `Map my ${liked || ''} pick${liked === 1 ? '' : 's'}`
  const canMap = inGroup || liked > 0
  const stillVoting = progress?.waiting.filter(p => p.id !== group?.me) ?? []
  // a group of one: the votes only count once someone else is on the trip
  const alone = Boolean(group && !inGroup && group.onInvite)
  const [votesOpen, setVotesOpen] = useState(false)

  return (
    <section className="deck-zone">
      <header className="deck-head">
        <h2>{done ? 'That’s the whole deck' : editing ? state.deckMode!.label : lane === 'food' ? 'Where to eat & drink?' : group ? 'Like or skip?' : 'Keep or skip?'}</h2>
        <div className="deck-actions">
          {inGroup && group?.ranking && <button className="deck-cancel deck-votes" onClick={() => setVotesOpen(true)}>Votes</button>}
          {inGroup && group && (
            <button className="deck-cancel" onClick={() => setChatOpen(true)}>
              Chat{group.notes.length > notesRead && <i className="dot" aria-label="New messages" />}
            </button>
          )}
          {editing && <button className="deck-cancel" onClick={onCancel}>Cancel</button>}
          {group?.onClose && <button className="deck-cancel" onClick={group.onClose}>Back to the plan</button>}
        </div>
        {both && (
          <div className="deck-lanes" role="tablist" aria-label="Which deck">
            {lanes.map(l => (
              <button key={l.lane} role="tab" aria-selected={lane === l.lane} className={lane === l.lane ? 'on' : ''}
                disabled={l.decided === l.total} onClick={() => { setFoodReady(true); dispatch({ type: 'deck-lane', lane: l.lane }) }}>
                {LANE_NAME[l.lane]} <small>{l.decided}/{l.total}</small>
              </button>
            ))}
          </div>
        )}
        <div className="deck-progress">
          <i style={{ width: `${(decided / Math.max(1, state.deck.length)) * 100}%` }} />
        </div>
        <small>{done ? 'All done' : `${decided + 1} of ${state.deck.length}`} · {liked} {group ? 'liked' : 'kept'}{both ? ` (${lanes[0].kept} to see, ${lanes[1].kept} to eat & drink)` : ''}{inGroup && progress ? ` · ${progress.finished.length}/${progress.voters.length} done` : ''}</small>
      </header>

      <div className="deck">
        {done ? (
          <div className="deck-end">
            <Memphis layout="sprinkle" />
            <p>{group && !state.deck.length ? 'You’ve voted on every place. ' : ''}You {group ? 'liked' : 'kept'} <b>{liked}</b> place{liked === 1 ? '' : 's'}{editing ? '' : ` in ${city?.name}`}.</p>
            {alone && <p className="m-note">No one else has joined yet, so these are only your picks. Friends sent a link count once they open it.</p>}
            {member && <p className="m-note">{stillVoting.length ? `Still voting: ${stillVoting.map(p => p.name).join(', ')}. ` : ''}{group!.adminName} will map the group’s favourites next.</p>}
            {editing
              ? <button className="cta" onClick={onPlan}>{liked ? `Add ${liked} to my trip` : 'Keep my plan as is'}</button>
              : !member && <button className="cta" disabled={!canMap} onClick={onPlan}>{ctaLabel}</button>}
            {alone && <button className="ghost" onClick={group!.onInvite}>Invite friends</button>}
            {group?.onClose && <button className="cta" onClick={group.onClose}>Back to the plan</button>}
            <button className="ghost" onClick={undo}>Undo last</button>
          </div>
        ) : between ? (
          <div className="deck-end deck-between">
            <Memphis layout="sprinkle" />
            <p>That’s the places: you kept <b>{placesRun.kept}</b>.</p>
            <p>Now somewhere to eat and drink? <b>{foodRun.total}</b> spots that fit your trip.</p>
            <button className="cta" onClick={() => setFoodReady(true)}>Swipe food & drink</button>
            {!member && <button className="ghost" disabled={!editing && !canMap} onClick={onPlan}>{editing ? (liked ? `Skip, add ${liked} to my trip` : 'Skip, keep my plan as is') : 'Skip food, map my picks'}</button>}
            <button className="ghost" onClick={undo}>Undo last</button>
          </div>
        ) : (
          visible.map((c, n) => {
            const place = byId(c.id)
            return place ? (
              <div key={c.id} className="dslot" style={{ zIndex: 10 - n, ['--depth' as string]: n }}>
                <Card place={place} card={c} top={n === 0} leaving={n === 0 ? leaving : null} onRelease={decide} likedBy={likedByOthers(c.id)} voting={Boolean(group)} />
              </div>
            ) : null
          })
        )}
      </div>

      {!done && !between && (
        <div className="deck-controls">
          <button className="dbtn undo" title="Undo (Backspace)" disabled={back === undefined} onClick={undo}>↺</button>
          <button className="dbtn skip" title="Skip (←)" onClick={() => decide('left')}>✕</button>
          <button className="dbtn keep" title={group ? 'Like (→)' : 'Keep (→)'} onClick={() => decide('right')}>♥</button>
        </div>
      )}

      {/* phones: the plan panel is hidden while swiping, so the next step lives here */}
      {!done && !member && (
        <div className="deck-mobile-bar">
          <span><b>{liked}</b> {group ? 'liked' : 'kept'}</span>
          {editing
            ? <button className="cta" onClick={onPlan}>{liked ? `Add ${liked} to my trip` : 'Keep my plan as is'}</button>
            : <button className="cta" disabled={!canMap} onClick={onPlan}>{ctaLabel}</button>}
        </div>
      )}
      {!done && member && (
        <div className="deck-mobile-bar">
          <span><b>{liked}</b> liked</span>
          <small className="deck-mobile-note">{progress ? `${progress.finished.length} of ${progress.voters.length} finished` : ''}</small>
        </div>
      )}

      {votesOpen && group?.ranking && (
        <Modal eyebrow={group.name} title="Most liked" onClose={() => setVotesOpen(false)}>{group.ranking}</Modal>
      )}
      {chatOpen && group && (
        <GroupChat name={group.name} me={group.me} people={group.people} notes={group.notes} onNote={group.onNote} onClose={() => { setChatOpen(false); setNotesRead(group.notes.length) }} />
      )}
    </section>
  )
}

export function PicksPanel({ state }: { state: TripState }) {
  const city = tripCity(state.brief)
  const liked = state.deck.filter(c => state.picks[c.id] === 'like').map(c => city?.places.find(p => p.id === c.id)).filter(Boolean) as Place[]
  const editing = Boolean(state.deckMode)
  const target = editing ? state.deck.length : (state.brief.days ?? 3) * (state.brief.pace === 'slow' ? 4 : state.brief.pace === 'packed' ? 6 : 5)
  return (
    <div className="picks">
      <div className="picks-goal">
        <div><b>{liked.length}</b><span>{editing ? ` of ${target} kept` : ` of ~${target}`}</span></div>
        <i><b style={{ width: `${Math.min(100, (liked.length / target) * 100)}%` }} /></i>
      </div>
      {!liked.length && <p className="picks-empty">Places you keep appear here.</p>}
      <ol>
        {liked.map(p => <PickRow key={p.id} place={p} />)}
      </ol>
    </div>
  )
}

function PickRow({ place }: { place: Place }) {
  const photos = usePhotos(place)
  const thumb = photos?.[0]?.url
  return (
    <li className="pick">
      <span className="thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined} />
      <div><b>{place.name}</b><small>{place.kind} · {place.minutes} min</small></div>
    </li>
  )
}
