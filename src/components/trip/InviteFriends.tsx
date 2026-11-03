import { useState } from 'react'
import { ApiError, api } from '../../money/client'
import { copyText } from '../../money/util'
import type { SharedTrip } from '../../trip/types'
import { Avatar, Modal } from '../money/parts'

// Who's on the trip. The admin brings people in here, by email or with a link; everyone else
// just sees who's going. Adding an email gives that person access straight away, and the
// admin's own email app sends the note, since the app has no email service of its own.
export function InviteFriends({ trip, tripSize, onClose, onChanged }: { trip: SharedTrip; tripSize: number; onClose: () => void; onChanged: () => void }) {
  const isAdmin = trip.role === 'owner'
  const stillToAdd = Math.max(1, tripSize - trip.people.length)
  const [emails, setEmails] = useState<string[]>(() => Array(stillToAdd).fill(''))
  const [added, setAdded] = useState<string[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const link = `${location.origin}/?join=${trip.inviteToken}`
  const message = `Join our ${trip.name} on Wayfarer. You can vote on the places we go, see the plan as it comes together, and split costs: ${link}`
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  const typed = emails.map(e => e.trim()).filter(Boolean)

  const add = async () => {
    setBusy(true)
    setProblems([])
    const done: string[] = []
    const failed: string[] = []
    const left: string[] = []
    for (const email of typed) {
      try {
        await api('POST', `/groups/${trip.groupId}/members`, { email })
        done.push(email)
      } catch (err) {
        failed.push(`${email}: ${err instanceof ApiError ? err.message : 'you seem to be offline'}`)
        left.push(email)
      }
    }
    setAdded(a => [...a, ...done])
    setProblems(failed)
    setEmails(left.length ? left : [''])
    setBusy(false)
    onChanged()
  }

  const copy = async () => {
    if (await copyText(link)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  const mailto = `mailto:${added.join(',')}?subject=${encodeURIComponent(`Join our ${trip.name} on Wayfarer`)}&body=${encodeURIComponent(message)}`

  return (
    <Modal eyebrow={trip.name} title={isAdmin ? 'Bring your friends in' : 'Who’s going'} onClose={onClose}>
      <ul className="trip-people">
        {trip.people.map(p => (
          <li key={p.id}>
            <Avatar id={p.id} name={p.name} ghost={!p.joined} />
            <span className="m-row-name">{p.name}{p.id === trip.me && <em> (you)</em>}</span>
            <small>{p.role === 'owner' ? 'Admin' : p.joined ? 'Joined' : p.waitingEmail ? `Asked to sign up: ${p.waitingEmail}` : 'Hasn’t joined yet'}</small>
          </li>
        ))}
      </ul>

      {isAdmin && (
        <>
          <form className="m-group" onSubmit={e => { e.preventDefault(); add() }}>
            <legend>Add by email</legend>
            <p className="m-note">Anyone already on Wayfarer sees the trip right away. Everyone else gets asked to sign up first, then they’re straight in.</p>
            {emails.map((email, i) => (
              <input key={i} className="trip-input" type="email" aria-label={`Friend ${i + 1}’s email`} placeholder="friend@example.com" value={email} maxLength={200} autoComplete="off"
                onChange={e => setEmails(list => list.map((x, j) => (j === i ? e.target.value : x)))} />
            ))}
            <div className="trip-row">
              <button type="button" className="m-link" onClick={() => setEmails(list => [...list, ''])}>+ Another</button>
              <button className="cta m-small" disabled={!typed.length || busy}>{busy ? 'Adding…' : `Add ${typed.length > 1 ? `${typed.length} friends` : 'friend'}`}</button>
            </div>
            {problems.map(p => <p key={p} className="m-note bad" role="alert">{p}</p>)}
          </form>

          {added.length > 0 && (
            <div className="trip-sent">
              <p className="m-note good" role="status">Added {added.length}. Let them know:</p>
              <a className="cta m-small" href={mailto}>Open email to send the invite</a>
            </div>
          )}

          <div className="m-group">
            <legend>Or share a link</legend>
            <p className="m-note">Anyone with this link can join, so send it only to people on the trip.</p>
            <div className="m-invite">
              <input readOnly aria-label="Invite link" value={link} onFocus={e => e.target.select()} />
              <button type="button" className="cta m-small" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            <div className="m-invite-more">
              <a className="ghost m-small" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">WhatsApp</a>
            </div>
            {local && <p className="m-note warn">This link points at your own computer, so it only works here. It works for friends on the live site.</p>}
          </div>
        </>
      )}
      {!isAdmin && <p className="m-note">{trip.people.find(p => p.role === 'owner')?.name ?? 'The admin'} is the admin and decides the plan. You can vote on places, chat, and add spending.</p>}
    </Modal>
  )
}
