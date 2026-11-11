import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, TripState } from '../state/tripStore'
import { ChevronIcon, SendIcon } from './Icons'
import { QUICK_REPLIES, nextField } from '../planner/intake'
import { SLIDERS, sliderPatch, sliderValue, stepOf, valueOf, type BriefSlider } from '../planner/sliders'
import { cityById } from '../data/cities'
import type { TripBrief } from '../types'
import type { TripNote, TripPerson } from '../trip/types'
import { Avatar } from './money/parts'

const SUGGESTIONS = [
  '4 days in Tokyo for two, food and nightlife, $4000',
  'Solo 3 days in Lisbon, cheap, history and fado',
]

// React 18's types lack `inert`; it still reaches the DOM and keeps a hidden
// panel out of the tab order.
export const inertIf = (on: boolean) => (on ? ({ inert: '' } as object) : {})

export interface ChatGroup {
  role: 'admin' | 'member'
  name: string
  me: string
  people: TripPerson[]
  notes: TripNote[]
  onManage: () => void
}

interface Props {
  state: TripState
  typing: boolean
  canPlan: boolean
  onSend: (text: string) => void
  onPlan: () => void
  collapsed: boolean
  onCollapse: () => void
  onFocusInput?: () => void   // phones: grow the sheet while typing
  group?: ChatGroup           // set when this trip is shared with a group
  onNote: (text: string) => void
  invitePrompt?: { onYes: () => void; onNo: () => void }
  confirm?: { question: string; yes: string; onYes: () => void; onNo: () => void }   // the assistant asking before a money or people change
  onInvite?: () => void
  onBrief?: (patch: Partial<TripBrief>) => void   // a slider moved, while setting up
  onRetune?: (patch: Partial<TripBrief>) => void  // sliders moved over a plan: plan again with them
}

// Message ids start with the time they were made, which is enough to slot the group's own
// messages in between the planner's.
const timeOf = (m: ChatMessage) => {
  const stamp = m.id.match(/^([0-9a-z]{6,10})-/)?.[1]
  const t = stamp ? parseInt(stamp, 36) : 0
  return t > 1e12 ? t : 0
}

function threadOf(messages: ChatMessage[], notes: TripNote[]): (ChatMessage | TripNote)[] {
  const out: (ChatMessage | TripNote)[] = []
  const queue = [...notes].sort((a, b) => a.createdAt - b.createdAt)
  let i = 0
  for (const m of messages) {
    const at = timeOf(m)
    if (at) while (i < queue.length && queue[i].createdAt < at) out.push(queue[i++])
    out.push(m)
  }
  while (i < queue.length) out.push(queue[i++])
  return out
}

export function ChatPanel({ state, typing, canPlan, onSend, onPlan, collapsed, onCollapse, onFocusInput, group, onNote, invitePrompt, confirm, onInvite, onBrief, onRetune }: Props) {
  const [tuneOpen, setTuneOpen] = useState(false)
  const [text, setText] = useState('')
  const [toGroup, setToGroup] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const member = group?.role === 'member'
  const others = group ? group.people.length > 1 : false
  const noteCount = group?.notes.length ?? 0
  const adminName = group?.people.find(p => p.role === 'owner')?.name ?? 'The admin'

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [state.messages.length, noteCount, typing, Boolean(invitePrompt), Boolean(confirm)])

  const asNote = member || (toGroup && others)
  // the box grows with what's in it, up to a few lines, then scrolls
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])
  const submit = (t: string) => {
    if (!t.trim()) return
    if (asNote) onNote(t.trim())
    else onSend(t.trim())
    setText('')
  }

  const locked = state.phase !== 'intake'
  // tap-to-answer chips for the question on screen (not over the opening examples)
  const field = !member && !locked && !typing && state.messages.length > 1 ? nextField(state.brief) : undefined
  const replies = field && QUICK_REPLIES[field]
  // once the basic questions are answered, the sliders tune the rest
  const cityName = cityById(state.brief.destination)?.name
  const tuning = !member && !locked && !typing && !field && cityName && onBrief && state.messages.length > 1
  // over a plan, the same sliders re-plan the trip
  const planned = state.phase === 'review' || state.phase === 'final'
  const retuning = planned && !member && !typing && cityName && onRetune
  const thread = useMemo(() => threadOf(state.messages, group?.notes ?? []), [state.messages, group?.notes])
  const canApply = !member && (state.phase === 'review' || state.phase === 'final')
  const joined = group?.people.filter(p => p.joined).length ?? 0

  const waitingLine = !member ? null
    : state.phase === 'intake' ? `${adminName} is setting up the trip. Places to vote on appear here soon.`
    : state.phase === 'planning' ? `${adminName} is mapping the group’s favourites.`
    : null

  return (
    <section className={`panel chat ${collapsed ? 'collapsed' : ''}`} aria-hidden={collapsed} {...inertIf(collapsed)}>
      <header className="panel-head">
        <h2>{group ? group.name : 'Where to?'}</h2>
        <button className="collapse" title="Hide chat" aria-label="Hide chat" onClick={onCollapse}><ChevronIcon dir="left" /></button>
      </header>

      {group ? (
        <button className="trip-bar" onClick={group.onManage}>
          <span className="trip-bar-faces" aria-hidden>
            {group.people.slice(0, 4).map(p => <Avatar key={p.id} id={p.id} name={p.name} size={24} ghost={!p.joined} />)}
          </span>
          <span className="trip-bar-text">
            <b>{joined} of {group.people.length} {group.people.length === 1 ? 'person' : 'people'} in</b>
          </span>
          <em>{group.role === 'admin' ? 'Invite' : 'See who'}</em>
        </button>
      ) : onInvite && state.messages.length > 1 && !invitePrompt && (
        <button className="trip-bar solo" onClick={onInvite}>Invite friends</button>
      )}

      <div className="messages" ref={scroller}>
        {thread.map((m, i) => {
          if ('role' in m) {
            // the admin's messages to the planner read as theirs to everyone else
            const theirs = member && m.role === 'user'
            return (
              <div key={m.id} className={`msg ${theirs ? 'friend' : m.role} ${m.text.length > 400 && m.role === 'user' ? 'long' : ''}`} style={{ animationDelay: `${Math.min(i, 2) * 60}ms` }}>
                {theirs && <small className="msg-from">{adminName}</small>}
                {m.role === 'ai' ? withBold(m.text) : m.text}
              </div>
            )
          }
          const mine = m.memberId === group?.me
          return (
            <div key={m.id} className={`msg ${mine ? 'user' : 'friend'} ${m.pending ? 'pending' : ''}`}>
              {!mine && <small className="msg-from">{group?.people.find(p => p.id === m.memberId)?.name ?? 'Someone'}</small>}
              {m.body}
              {!mine && canApply && <button className="msg-apply" onClick={() => onSend(m.body)}>Try this on the plan</button>}
            </div>
          )
        })}
        {waitingLine && <div className="msg ai">{waitingLine}</div>}
        {typing && <div className="msg ai typing"><i /><i /><i /></div>}
        {confirm && (
          <>
            <div className="msg ai">{confirm.question}</div>
            <div className="quick-replies">
              <button onClick={confirm.onYes}>{confirm.yes}</button>
              <button onClick={confirm.onNo}>Cancel</button>
            </div>
          </>
        )}
        {tuning && !confirm && <TuneCard brief={state.brief} city={cityName} onBrief={onBrief} />}
        {retuning && !confirm && (tuneOpen
          ? <TuneCard brief={state.brief} city={cityName} draft onBrief={patch => { setTuneOpen(false); onRetune(patch) }} onClose={() => setTuneOpen(false)} />
          : <div className="quick-replies"><button onClick={() => setTuneOpen(true)}>Tune the trip</button></div>)}
        {invitePrompt && (
          <div className="quick-replies">
            <button onClick={invitePrompt.onYes}>Yes, add my friends</button>
            <button onClick={invitePrompt.onNo}>Not now</button>
          </div>
        )}
        {!invitePrompt && !confirm && replies && (
          <div className="quick-replies">
            {replies.map(r => <button key={r} onClick={() => submit(r)}>{r}</button>)}
          </div>
        )}
        {!member && state.messages.length === 1 && (
          <div className="suggestions">
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => submit(s)}>{s}</button>
            ))}
          </div>
        )}
      </div>

      {canPlan && state.phase === 'intake' && (
        <button className="cta" onClick={onPlan}>
          Pick places
        </button>
      )}

      {!member && others && (
        <div className="chat-to" role="tablist" aria-label="Who this message goes to">
          <button role="tab" aria-selected={!toGroup} className={toGroup ? '' : 'on'} onClick={() => setToGroup(false)}>Planner</button>
          <button role="tab" aria-selected={toGroup} className={toGroup ? 'on' : ''} onClick={() => setToGroup(true)}>Group</button>
        </div>
      )}

      <form className="composer" onSubmit={e => { e.preventDefault(); submit(text) }}>
        {/* a text area, so a pasted itinerary keeps its lines: Enter sends, Shift+Enter is a new line */}
        <textarea
          ref={box}
          rows={1}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(text) } }}
          onFocus={onFocusInput}
          enterKeyHint="send"
          maxLength={asNote ? 1000 : undefined}
          placeholder={
            asNote ? 'Message the group…'
              : state.phase === 'review' || state.phase === 'final' ? 'Ask for a change'
              : locked ? 'Changes apply once mapping ends'
              : 'Where, who, what vibe?'
          }
        />
        <button type="submit" aria-label="Send" disabled={!text.trim()}><SendIcon /></button>
      </form>
    </section>
  )
}

// The sliders: the first on show, the rest a tap away, so the chat isn't a wall of them.
// While setting up, each move applies at once. Over a plan (`draft`), moves are held until
// "Re-plan with these", since each one would otherwise mean drawing the whole trip again.
function TuneCard({ brief, city, onBrief, draft, onClose }: { brief: TripBrief; city: string; onBrief: (patch: Partial<TripBrief>) => void; draft?: boolean; onClose?: () => void }) {
  const [more, setMore] = useState(() => draft || SLIDERS.slice(1).some(s => brief[s.key] !== undefined))
  const [held, setHeld] = useState<Partial<TripBrief>>({})
  const now = { ...brief, ...held }
  const shown = more ? SLIDERS : SLIDERS.slice(0, 1)
  const moved = SLIDERS.slice(1).filter(s => brief[s.key] !== undefined).length
  const changed = SLIDERS.some(s => sliderValue(s, now) !== sliderValue(s, brief))
  const move = (patch: Partial<TripBrief>) => (draft ? setHeld(h => ({ ...h, ...patch })) : onBrief(patch))
  return (
    <div className="trip-tune">
      {shown.map(s => (
        <TripSlider key={s.key} slider={s} city={city} value={sliderValue(s, now)} onChange={v => move(sliderPatch(s, v))} />
      ))}
      {draft ? (
        <div className="quick-replies trip-tune-actions">
          <button className="trip-tune-go" disabled={!changed} onClick={() => onBrief(held)}>Show me options</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      ) : (
        <button className="trip-tune-more" aria-expanded={more} onClick={() => setMore(m => !m)}>
          {more ? 'Fewer options' : `More ways to tune (${SLIDERS.length - 1})${moved ? ` · ${moved} set` : ''}`}
        </button>
      )}
    </div>
  )
}

// One question answered by dragging: five steps, each saying what it does to the plan.
function TripSlider({ slider, city, value, onChange }: { slider: BriefSlider; city: string; value: number; onChange: (v: number) => void }) {
  const n = slider.stops.length
  const step = stepOf(value, n)
  const stop = slider.stops[step]
  return (
    <div className="trip-slider" style={{ '--fill': `${(step / (n - 1)) * 100}%` } as React.CSSProperties}>
      <label htmlFor={`slider-${slider.key}`}>{slider.question(city)}</label>
      <input
        id={`slider-${slider.key}`}
        type="range" min={0} max={n - 1} step={1} value={step}
        aria-valuetext={`${stop.label}: ${stop.effect}`}
        onChange={e => onChange(valueOf(Number(e.target.value), n))}
      />
      <div className="trip-slider-ends" aria-hidden><span>{slider.ends[0]}</span><span>{slider.ends[1]}</span></div>
      <p className="trip-slider-now"><b>{stop.label}.</b> {stop.effect}.</p>
    </div>
  )
}

// The assistant may mark a few words **bold**; nothing else is read as formatting.
function withBold(text: string) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return parts.length === 1 ? text : parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p))
}
