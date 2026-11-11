import { useEffect, useState } from 'react'
import { api } from '../money/client'
import type { Account } from '../money/types'
import type { Alerts } from '../docs/client'
import { askPhonePermission, onPhone, phonePermission } from '../docs/native'
import { useAccountCtx } from './money/parts'

// Alerts from your documents, in the Profile: what's arrived (unread first to the eye), what's
// coming up, and how they reach you: email, and notifications on this phone.

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const at = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function AlertsCard({ alerts, onRead, onDocs, className = '' }: { alerts: Alerts | null; onRead: () => void; onDocs: () => void; className?: string }) {
  const { account, signedIn } = useAccountCtx()
  const [phone, setPhone] = useState<'granted' | 'denied' | 'prompt' | 'none'>('none')
  const [error, setError] = useState('')
  useEffect(() => { void phonePermission().then(setPhone) }, [])
  // seen once the card's been open a moment
  useEffect(() => {
    if (!alerts?.unread) return
    const t = setTimeout(onRead, 2500)
    return () => clearTimeout(t)
  }, [alerts?.unread, onRead])
  const email = account.alertEmail !== false
  const setEmail = async (on: boolean) => {
    try { signedIn((await api<{ user: Account }>('PATCH', '/auth/me', { alertEmail: on })).user) } catch (err) { setError((err as Error).message) }
  }
  const arrived = alerts?.arrived.slice(0, 8) ?? []
  const coming = alerts?.coming.slice(0, 5) ?? []
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h2>Alerts</h2>
        <button className="m-link" onClick={onDocs}>Your documents →</button>
      </header>
      {!alerts ? <div className="m-skeleton p-line" />
        : !arrived.length && !coming.length ? (
          <p className="m-note">No alerts yet. Add tickets, bookings, passports and insurance to your documents and you’ll be told when check-in opens, when to leave, and when something runs out before a trip.</p>
        ) : (
          <>
            {arrived.length > 0 && (
              <ul className="a-list">
                {arrived.map(a => <li key={a.id} className={a.readAt ? '' : 'unread'}><b>{a.title}</b><span>{a.body.split(' · ').join(' · ')}</span><small>{ago(a.deliveredAt!)}</small></li>)}
              </ul>
            )}
            {coming.length > 0 && (
              <>
                <h4 className="p-sub">Coming up</h4>
                <ul className="a-list soon">{coming.map(a => <li key={a.id}><b>{a.title}</b><small>{at(a.dueAt)}</small></li>)}</ul>
              </>
            )}
          </>
        )}
      <h4 className="p-sub">How they reach you</h4>
      <label className="a-switch"><input type="checkbox" checked={email} onChange={e => void setEmail(e.target.checked)} /> Email them to {account.email}</label>
      {onPhone() && (
        phone === 'granted' ? <p className="m-note good">Notifications are on for this phone.</p>
          : phone === 'denied' ? <p className="m-note">Notifications are off for Wayfarer on this phone. Turn them on in Settings → Wayfarer → Notifications.</p>
          : <button className="ghost m-small" onClick={async () => setPhone((await askPhonePermission()) ? 'granted' : 'denied')}>Turn on notifications on this phone</button>
      )}
      {error && <p className="m-note bad">{error}</p>}
    </section>
  )
}
