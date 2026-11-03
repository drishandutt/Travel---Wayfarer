import { useEffect, useRef, useState } from 'react'
import type { TripNote, TripPerson } from '../../trip/types'
import { SendIcon } from '../Icons'
import { Modal } from '../money/parts'

// Voting takes over the whole screen, so the group's chat opens on top of it.
export function GroupChat({ name, me, people, notes, onNote, onClose }: { name: string; me: string; people: TripPerson[]; notes: TripNote[]; onNote: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [notes.length])

  const submit = () => {
    if (!text.trim()) return
    onNote(text.trim())
    setText('')
  }

  return (
    <Modal eyebrow={name} title="Trip chat" onClose={onClose}>
      <div className="trip-chat">
        <div className="messages" ref={scroller}>
          {!notes.length && <p className="m-note">Nothing here yet. Say what you’re hoping for, or argue the case for a place.</p>}
          {notes.map(n => {
            const mine = n.memberId === me
            return (
              <div key={n.id} className={`msg ${mine ? 'user' : 'friend'} ${n.pending ? 'pending' : ''}`}>
                {!mine && <small className="msg-from">{people.find(p => p.id === n.memberId)?.name ?? 'Someone'}</small>}
                {n.body}
              </div>
            )
          })}
        </div>
        <form className="composer" onSubmit={e => { e.preventDefault(); submit() }}>
          <input value={text} onChange={e => setText(e.target.value)} enterKeyHint="send" maxLength={1000} placeholder="Message the group…" aria-label="Message the group" />
          <button type="submit" aria-label="Send" disabled={!text.trim()}><SendIcon /></button>
        </form>
      </div>
    </Modal>
  )
}
