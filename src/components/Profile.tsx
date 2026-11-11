import { useMemo } from 'react'
import type { AccountHandle } from '../money/hooks'
import type { GroupSummary } from '../money/types'
import type { SavedTrip } from '../state/tripStore'
import { DAY_STARTS, NIGHT_STARTS, type ThemeMode } from '../state/theme'
import { AccountCtx, Avatar } from './money/parts'
import { AccountCard } from './money/PeopleTab'
import { ClaudeProfileCard } from './ConnectClaude'
import { AlertsCard } from './AlertsCard'
import type { Alerts } from '../docs/client'

// Your profile, from your avatar in the top bar (or the Trips menu): alerts from your documents, who you are and how you sign in, your trips at a glance,
// the details you can change (name, how people pay you, email, password), and Claude: the
// address to add it with, what it can do and the apps connected to this account.

const since = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

export function Profile({ acct, trips, groups, themeMode, onThemeMode, alerts, onReadAlerts, onDocs, onClose }: { acct: AccountHandle; trips: SavedTrip[]; groups: GroupSummary[]; themeMode: ThemeMode; onThemeMode: (m: ThemeMode) => void; alerts: Alerts | null; onReadAlerts: () => void; onDocs: () => void; onClose: () => void }) {
  const { account, signedIn, signOut } = acct
  const ctx = useMemo(() => (account ? { account, signedIn, signOut: async () => { await signOut(); onClose() } } : null), [account, signedIn, signOut, onClose])
  if (!account || !ctx) return null
  // a group you plan for has a local copy too, so count each group once
  const total = trips.filter(t => !t.brief.moneyGroupId || !groups.some(g => g.id === t.brief.moneyGroupId)).length + groups.length
  const facts: [string, string][] = [
    ['Trips', String(total)],
    ['Shared with others', String(groups.filter(g => g.memberCount > 1).length)],
    ['Signs in with', account.hasPassword ? 'Email code + password' : 'Email code'],
    ...(account.createdAt ? [['Member since', since(account.createdAt)] as [string, string]] : []),
  ]
  return (
    <div className="dash m-app p-app" role="dialog" aria-label="Profile">
      <div className="m-top">
        <button className="dash-back" onClick={onClose}>← Back to map</button>
      </div>
      <AccountCtx.Provider value={ctx}>
        <div className="dash-grid">
          <section className="card span-12 p-hero">
            <Avatar id={account.id} name={account.name} size={64} />
            <div className="p-who">
              <h1>{account.name}</h1>
              <p>{account.email}</p>
              {account.payHandle && <p className="p-pay">Pay me: <b>{account.payHandle}</b></p>}
            </div>
            <dl className="p-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            {/* light and dark: Auto follows the time of day */}
            <div className="p-appearance">
              <div className="p-theme" role="group" aria-label="Appearance">
                {(['auto', 'light', 'dark'] as const).map(t => <button key={t} className={themeMode === t ? 'on' : ''} aria-pressed={themeMode === t} onClick={() => onThemeMode(t)}>{t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}</button>)}
              </div>
              <small>{themeMode === 'auto' ? `Light from ${DAY_STARTS}:00, dark from ${NIGHT_STARTS}:00` : `Always ${themeMode}`}</small>
            </div>
          </section>
          <AlertsCard className="span-12" alerts={alerts} onRead={onReadAlerts} onDocs={onDocs} />
          <AccountCard className="span-6" claude={false} />
          <ClaudeProfileCard className="span-6" />
        </div>
      </AccountCtx.Provider>
    </div>
  )
}
