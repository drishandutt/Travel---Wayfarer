import { useState } from 'react'
import { ApiError, api } from '../../money/client'
import { CURRENCIES } from '../../money/currency'
import { netBalances } from '../../money/engine'
import { unsentCount } from '../../money/hooks'
import { copyText } from '../../money/util'
import type { Account } from '../../money/types'
import { Avatar, Field, Modal, useAccountCtx, useCtx } from './parts'

function InviteCard() {
  const { s, g, toast, me } = useCtx()
  const [copied, setCopied] = useState(false)
  const link = `${location.origin}/?join=${s.group.inviteToken}`
  const text = `Join “${s.group.name}” on Wayfarer so we can split costs: ${link}`
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1'

  const copy = async () => {
    if (await copyText(link)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }
  const share = () => navigator.share?.({ title: s.group.name, text }).catch(() => {})
  const reset = async () => {
    if (!confirm('Reset the invite link? The old one stops working, and anyone who hasn’t joined yet will need the new one.')) return
    await g.actions.call('POST', '/invite', {}).catch(err => toast((err as Error).message))
    toast('New link ready')
  }

  return (
    <section className="card span-5">
      <header className="card-head"><h2>Invite link</h2></header>
      <p className="m-note">Anyone with this link can join and see the group’s expenses.</p>
      <div className="m-invite">
        <input readOnly aria-label="Invite link" value={link} onFocus={e => e.target.select()} />
        <button className="cta m-small" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
      <div className="m-invite-more">
        {'share' in navigator && <button className="ghost m-small" onClick={share}>Share…</button>}
        <a className="ghost m-small" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">WhatsApp</a>
        {me.role === 'owner' && <button className="ghost m-small" onClick={reset}>Reset link</button>}
      </div>
      {local && <p className="m-note warn">This link only works on this computer until the app is deployed.</p>}
    </section>
  )
}

function MembersCard() {
  const { s, g, fmt, me, toast } = useCtx()
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'email'; text: string } | null>(null)
  const net = netBalances(s.expenses, s.settlements)
  const active = s.members.filter(m => !m.left)

  const act = (fn: () => Promise<unknown>) => fn().catch(err => toast((err as Error).message))
  // set when the person being removed can see photos shared to this group
  const [photoChoice, setPhotoChoice] = useState<{ id: string; name: string; count: number } | null>(null)
  const remove = (memberId: string, name: string, photos?: 'keep' | 'revoke') =>
    g.actions.call('DELETE', `/members/${memberId}${photos ? `?photos=${photos}` : ''}`).then(() => setPhotoChoice(null)).catch(err => {
      if (err instanceof ApiError && err.data.code === 'photo-choice') setPhotoChoice({ id: memberId, name, count: Number(err.data.count) })
      else { setPhotoChoice(null); toast((err as Error).message) }
    })

  const add = async () => {
    const name = newName.trim()
    const email = newEmail.trim()
    if (!name && !email) return
    try {
      await g.actions.call('POST', '/members', { ...(name ? { name } : {}), ...(email ? { email } : {}) })
      setNewName('')
      setNewEmail('')
      if (email) toast('Added. They’ll see this group as soon as they sign in with that email.')
    } catch (err) {
      toast((err as Error).message)
    }
  }

  const saveEdit = () => {
    if (!editing) return
    const text = editing.text.trim()
    const { id, field } = editing
    setEditing(null)
    if (text) act(() => g.actions.call('PATCH', `/members/${id}`, { [field]: text }))
  }

  return (
    <section className="card span-7">
      <header className="card-head"><h2>People <em>{active.length}</em></h2></header>
      <ul className="m-members">
        {active.map(m => {
          const n = net[m.id] ?? 0
          const mine = editing?.id === m.id ? editing : null
          return (
            <li key={m.id}>
              <Avatar id={m.id} name={m.name} ghost={!m.joined} />
              <div className="m-member-main">
                {mine ? (
                  <form className="m-rename" onSubmit={e => { e.preventDefault(); saveEdit() }}>
                    <input
                      autoFocus
                      type={mine.field === 'email' ? 'email' : 'text'}
                      aria-label={mine.field === 'email' ? `Email for ${m.name}` : `New name for ${m.name}`}
                      placeholder={mine.field === 'email' ? 'Their email' : undefined}
                      value={mine.text}
                      maxLength={mine.field === 'email' ? 200 : 60}
                      onChange={e => setEditing({ ...mine, text: e.target.value })}
                    />
                    <button className="ghost m-small">Save</button>
                    <button type="button" className="ghost m-small" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <b>{m.name}{m.id === s.me && <em> (you)</em>}</b>
                )}
                <small>
                  {m.role === 'owner' ? 'Admin'
                    : m.joined ? 'Joined'
                    : m.waitingEmail ? `Gets access when ${m.waitingEmail} signs in`
                    : 'Hasn’t joined yet. They can pick this name from the invite link.'}
                  {m.payHandle && m.id !== s.me && ` · pays via ${m.payHandle}`}
                </small>
              </div>
              <span className={`m-member-bal ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`}>{n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : 'settled'}</span>
              {!mine && (
                <div className="m-member-tools">
                  {(m.id === s.me || me.role === 'owner') && <button className="m-link" onClick={() => setEditing({ id: m.id, field: 'name', text: m.name })}>Rename</button>}
                  {!m.joined && me.role === 'owner' && <button className="m-link" onClick={() => setEditing({ id: m.id, field: 'email', text: '' })}>{m.waitingEmail ? 'Change email' : 'Add email'}</button>}
                  {me.role === 'owner' && m.joined && m.id !== s.me && (
                    <button className="m-link" title="For a forgotten password, or the wrong person" onClick={() => {
                      if (confirm(`Release ${m.name}’s seat? Their account loses access to this group and their votes stop counting. The group’s invite link changes, so share the new one. The seat can be given to someone else, and their private expenses stay hidden from whoever takes it.`)) act(() => g.actions.call('POST', `/members/${m.id}/unlink`, {}))
                    }}>Release</button>
                  )}
                  {me.role === 'owner' && m.id !== s.me && (
                    <button className="m-link danger-link" onClick={() => {
                      if (confirm(`Remove ${m.name} from the group? The invite link resets too, so they can’t rejoin with the old one. Anyone still to join by link will need the new one.`)) remove(m.id, m.name)
                    }}>Remove</button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {me.role === 'owner' && (
        <>
          <form className="m-add-person" onSubmit={e => { e.preventDefault(); add() }}>
            <input type="email" aria-label="Their email" placeholder="Their email" value={newEmail} maxLength={200} onChange={e => setNewEmail(e.target.value)} autoComplete="off" />
            <input aria-label="Their name (optional)" placeholder="Name (optional)" value={newName} maxLength={60} onChange={e => setNewName(e.target.value)} autoComplete="off" />
            <button className="cta m-small" disabled={!newName.trim() && !newEmail.trim()}>Add</button>
          </form>
          <p className="m-note">With an email, they get access when they sign in.</p>
        </>
      )}
      {photoChoice && (
        <Modal title={`What about ${photoChoice.name}’s photos?`} eyebrow="Removing someone" onClose={() => setPhotoChoice(null)}
          footer={<>
            <button className="ghost" onClick={() => setPhotoChoice(null)}>Cancel</button>
            <span className="m-spacer" />
            <button className="ghost" onClick={() => remove(photoChoice.id, photoChoice.name, 'revoke')}>Take them away</button>
            <button className="cta" onClick={() => remove(photoChoice.id, photoChoice.name, 'keep')}>Let them keep them</button>
          </>}>
          <p className="m-note">
            {photoChoice.name} can see {photoChoice.count} photo{photoChoice.count === 1 ? '' : 's'} that people shared to this group.
            You can take them away now, or let {photoChoice.name} keep what was shared so far. Either way, they won’t see anything shared to the group after this.
          </p>
        </Modal>
      )}
    </section>
  )
}

function SettingsCard({ onLeft }: { onLeft: () => void }) {
  const { s, g, me, toast } = useCtx()
  const [name, setName] = useState(s.group.name)
  const used = s.expenses.length > 0 || s.settlements.length > 0
  const net = netBalances(s.expenses, s.settlements)[s.me] ?? 0

  const leave = async () => {
    if (!confirm(`Leave “${s.group.name}”? Your name stays on past expenses.`)) return
    try {
      await api('DELETE', `/groups/${s.group.id}/members/${s.me}`)
      onLeft()
    } catch (err) {
      toast((err as Error).message)
    }
  }
  const destroy = async () => {
    const typed = prompt(`This permanently deletes “${s.group.name}” and all its expenses for everyone. It can’t be undone. Type the group’s name to confirm.`)
    if (typed === null) return
    if (typed.trim() !== s.group.name) { toast('That didn’t match, so nothing was deleted'); return }
    try {
      await api('DELETE', `/groups/${s.group.id}`)
      onLeft()
    } catch (err) {
      toast((err as Error).message)
    }
  }

  return (
    <section className="card span-6">
      <header className="card-head"><h2>Settings</h2></header>
      {me.role === 'owner' && (
        <form className="m-form-row" onSubmit={e => {
          e.preventDefault()
          if (name.trim() && name.trim() !== s.group.name) g.actions.call('PATCH', '', { name: name.trim() }).then(() => toast('Renamed')).catch(err => toast((err as Error).message))
        }}>
          <Field label="Group name"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
          <button className="ghost m-small" disabled={!name.trim() || name.trim() === s.group.name}>Save</button>
        </form>
      )}
      {me.role === 'owner' ? (
        <Field label="Group currency" hint={used ? 'Balances are kept in this. It’s locked now that there’s money in the group.' : 'Balances are kept in this. You can change it until the first expense.'}>
          <select value={s.group.currency} disabled={used} onChange={e => g.actions.call('PATCH', '', { currency: e.target.value }).catch(err => toast((err as Error).message))}>
            {[...new Set([s.group.currency, ...CURRENCIES])].map(c => <option key={c}>{c}</option>)}
          </select>
        </Field>
      ) : <p className="m-note">Balances are kept in {s.group.currency}. {s.members.find(m => m.role === 'owner')?.name ?? 'The admin'} looks after the group’s settings.</p>}
      <div className="m-danger-zone">
        <button className="danger" onClick={leave} disabled={net !== 0} title={net !== 0 ? 'Settle up first' : undefined}>Leave group</button>
        {me.role === 'owner' && <button className="danger" onClick={destroy}>Delete group</button>}
        {net !== 0 && <small>You can leave once your balance is zero.</small>}
      </div>
    </section>
  )
}

export function AccountCard({ className = 'span-6' }: { className?: string }) {
  const { account, signedIn, signOut } = useAccountCtx()
  const [name, setName] = useState(account.name)
  const [handle, setHandle] = useState(account.payHandle ?? '')
  const [email, setEmail] = useState(account.email)
  const [password, setPassword] = useState('')
  const [current, setCurrent] = useState('')
  const [msg, setMsg] = useState<{ good: boolean; text: string } | null>(null)
  const [showSecure, setShowSecure] = useState(false)
  // a new address is confirmed with a code sent to it before anything changes
  const [code, setCode] = useState('')
  const [codeFor, setCodeFor] = useState<string | null>(null)

  const saveProfile = async () => {
    try {
      const { user } = await api<{ user: Account }>('PATCH', '/auth/me', { name: name.trim(), payHandle: handle.trim() || null })
      signedIn(user)
      setMsg({ good: true, text: 'Saved' })
    } catch (err) {
      setMsg({ good: false, text: (err as Error).message })
    }
  }
  const secure = async () => {
    try {
      const to = email.trim()
      const out = await api<{ user?: Account; next?: 'code'; sent?: boolean }>('POST', '/auth/secure', { email: to, password: password || undefined, current: current || undefined, ...(codeFor === to && code ? { code } : {}) })
      if (out.next === 'code') {
        setCodeFor(to)
        setCode('')
        setMsg({ good: true, text: out.sent === false ? `We sent a code to ${to} a moment ago. Type it in below.` : `We sent a 6-digit code to ${to}. Type it in below to confirm it’s yours.` })
        return
      }
      signedIn(out.user!)
      setPassword('')
      setCurrent('')
      setCode('')
      setCodeFor(null)
      setShowSecure(false)
      setMsg({ good: true, text: 'Saved' })
    } catch (err) {
      setMsg({ good: false, text: err instanceof ApiError ? err.message : 'You’re offline. Try again when you’re connected.' })
    }
  }

  return (
    <section className={`card ${className}`}>
      <header className="card-head"><h2>Account</h2></header>
      <p className="m-note">Signed in as <b>{account.email}</b>.</p>
      {!account.hasPassword && (
        <p className="m-note">
          Signing in takes a code sent to your email. For a second lock, <button className="m-link" onClick={() => setShowSecure(true)}>add a password</button> too.
        </p>
      )}
      <form className="m-stack" onSubmit={e => { e.preventDefault(); saveProfile() }}>
        <Field label="Your name"><input value={name} maxLength={60} onChange={e => setName(e.target.value)} autoComplete="name" /></Field>
        <Field label="How people can pay you" hint="A UPI ID or similar, shown to your groups. With a UPI ID, friends paying in rupees get a button that opens their UPI app."><input value={handle} maxLength={120} onChange={e => setHandle(e.target.value)} placeholder="yourname@upi" autoComplete="off" /></Field>
        <button className="ghost m-small" disabled={!name.trim()}>Save</button>
      </form>
      {!showSecure && <p className="m-note"><button className="m-link" onClick={() => setShowSecure(true)}>{account.hasPassword ? 'Change email or password' : 'Change email'}</button></p>}
      {showSecure && (
        <form className="m-stack m-secure" onSubmit={e => { e.preventDefault(); secure() }}>
          <Field label="Email" hint={email.trim().toLowerCase() !== account.email ? 'We’ll send a code to the new address to confirm it’s yours.' : undefined}><input type="email" required value={email} maxLength={200} onChange={e => { setEmail(e.target.value); setCodeFor(null) }} autoComplete="email" /></Field>
          {codeFor && codeFor === email.trim() && (
            <Field label={`Code sent to ${codeFor}`}><input required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" /></Field>
          )}
          {account.hasPassword && <Field label="Current password"><input type="password" required value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" /></Field>}
          <Field label={account.hasPassword ? 'New password' : 'Password'} hint={`Optional. At least 8 characters. There’s no reset by email, so keep it somewhere safe.`}><input type="password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
          <div className="m-form-actions">
            <button type="button" className="ghost m-small" onClick={() => setShowSecure(false)}>Cancel</button>
            <button className="cta m-small">Save</button>
          </div>
        </form>
      )}
      {msg && <p className={`m-note ${msg.good ? 'good' : 'bad'}`} role="status">{msg.text}</p>}
      <button className="m-link" onClick={() => {
        const unsent = unsentCount()
        if (unsent && !confirm(`You have ${unsent} change${unsent > 1 ? 's' : ''} that ${unsent > 1 ? 'haven’t' : 'hasn’t'} synced yet. Signing out discards ${unsent > 1 ? 'them' : 'it'}. Sign out anyway?`)) return
        signOut()
      }}>Sign out</button>
    </section>
  )
}

export function PeopleTab({ onLeft }: { onLeft: () => void }) {
  const isAdmin = useCtx().me.role === 'owner'
  return (
    <div className="dash-grid">
      <MembersCard />
      {isAdmin && <InviteCard />}
      <SettingsCard onLeft={onLeft} />
      <AccountCard />
    </div>
  )
}
