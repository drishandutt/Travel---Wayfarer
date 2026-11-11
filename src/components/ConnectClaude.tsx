import { useCallback, useEffect, useState } from 'react'
import { api } from '../money/client'
import { copyText } from '../money/util'
import { Modal } from './money/parts'

// How to use Wayfarer from Claude (server/mcp): the address to add as a connector, step by step
// for Claude on the web or desktop, on a phone, and in Claude Code, things to ask, and the apps
// already connected to this account with a way to cut each one off. The same guide opens from
// the Trips menu and from Money → Account, in a browser and in the iPhone app.

interface Connection { id: string; name: string; connectedAt: number; lastUsedAt: number | null }
interface Info { connections: Connection[]; mcpUrl: string }

type Where = 'web' | 'phone' | 'code'

const ASK = [
  'Let’s work on my Lisbon trip. What’s on day 2?',
  'Find three hidden-gem restaurants near my day 1 stops and add the best one.',
  'Find flights from London and a hotel in the best area for my dates.',
  'Who owes whom, and where did most of our money go?',
  'Plan me a 3-day food trip to Kyoto.',
  'Put the itinerary we just made into Wayfarer.',
]

function useConnections() {
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api<Info>('GET', '/auth/connections').then(i => { setInfo(i); setError('') }).catch(err => setError((err as Error).message)), [])
  useEffect(() => { void load() }, [load])
  const disconnect = async (c: Connection) => {
    if (!confirm(`Disconnect ${c.name}? It loses access to your trips straight away.`)) return
    try { await api('DELETE', `/auth/connections/${encodeURIComponent(c.id)}`); void load() } catch (err) { setError((err as Error).message) }
  }
  return { info, error, disconnect }
}

const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

function Address({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="m-copyrow">
      <code>{url}</code>
      <button className="cta m-small" onClick={async () => { await copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1600) }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

function Connected({ list, onDisconnect }: { list: Connection[]; onDisconnect: (c: Connection) => void }) {
  if (!list.length) return <p className="m-note">Nothing connected yet.</p>
  return (
    <ul className="m-connections">
      {list.map(c => (
        <li key={c.id}>
          <span><b>{c.name}</b><small>connected {when(c.connectedAt)}{c.lastUsedAt ? ` · last used ${when(c.lastUsedAt)}` : ''}</small></span>
          <button className="m-link danger-link" onClick={() => onDisconnect(c)}>Disconnect</button>
        </li>
      ))}
    </ul>
  )
}

// The full guide, in a dialog.
export function ConnectClaudeGuide({ onClose }: { onClose: () => void }) {
  const { info, error, disconnect } = useConnections()
  const [where, setWhere] = useState<Where>('web')
  const url = info?.mcpUrl ?? `${location.origin}/api/mcp`
  return (
    <Modal eyebrow="Wayfarer in Claude" title="Use Wayfarer from Claude" onClose={onClose} wide>
      <div className="m-claude-guide">
        <p className="m-lede">Talk to Claude to research places, change your plan, find flights and hotels for your dates, and sort out who owes whom. It works on the trip you choose, as you, and everything it changes shows up here live.</p>

        <h4>Your Wayfarer address</h4>
        <Address url={url} />

        <div className="m-claude-tabs" role="tablist" aria-label="Where you use Claude">
          {([['web', 'Claude on the web or desktop'], ['phone', 'Claude on your phone'], ['code', 'Claude Code']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={where === id} className={where === id ? 'on' : ''} onClick={() => setWhere(id)}>{label}</button>
          ))}
        </div>

        {where === 'web' && (
          <ol className="m-steps">
            <li>Open Claude’s connectors: <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">claude.ai → Settings → Connectors ↗</a> (in the desktop app: Settings → Connectors).</li>
            <li>Choose <b>Add custom connector</b>. Name it <b>Wayfarer</b> and paste the address above.</li>
            <li>Click <b>Connect</b>. A Wayfarer page opens: sign in with your email and the code we send, then choose <b>Allow</b>.</li>
            <li>In a new chat, make sure Wayfarer is switched on in the tools menu, and say something like “Let’s work on my trip”. Claude will list your trips and ask which one.</li>
          </ol>
        )}
        {where === 'phone' && (
          <ol className="m-steps">
            <li>Add Wayfarer once from Claude on the web or desktop (the first tab). Custom connectors are added there, not in the phone app.</li>
            <li>Open the Claude app on your phone, signed in to the same Claude account. Wayfarer is already there.</li>
            <li>In a chat, switch Wayfarer on in the tools menu and ask away. If it asks you to sign in again, use your email and the code we send.</li>
          </ol>
        )}
        {where === 'code' && (
          <ol className="m-steps">
            <li>In a terminal, run:<pre className="m-cmd">{`claude mcp add --transport http wayfarer ${url}`}</pre></li>
            <li>Start Claude Code, type <b>/mcp</b>, choose <b>wayfarer</b> and <b>Authenticate</b>. Sign in with your email and code, then <b>Allow</b>.</li>
          </ol>
        )}

        <h4>Things to ask</h4>
        <ul className="m-asks">{ASK.map(a => <li key={a}>“{a}”</li>)}</ul>

        <h4>Connected apps</h4>
        {error ? <p className="m-note bad">{error}</p> : info ? <Connected list={info.connections} onDisconnect={c => void disconnect(c)} /> : <div className="m-skeleton" />}
        <p className="m-note">Claude can only do what you could in the app: only a trip’s admin changes its plan. It asks before spending, inviting or posting for you. Disconnect any time, here.</p>
      </div>
    </Modal>
  )
}

// The short version, inside the account card, with a way into the full guide.
export function ConnectClaudeCard() {
  const { info, error, disconnect } = useConnections()
  const [open, setOpen] = useState(false)
  return (
    <div className="m-claude">
      <h3>Use Wayfarer from Claude</h3>
      <p className="m-note">Plan, research places, look for flights and hotels and sort out money by talking to Claude. Add this address in Claude as a custom connector, then sign in with your email.</p>
      {info && <Address url={info.mcpUrl} />}
      <button className="m-link" onClick={() => setOpen(true)}>How to connect, step by step</button>
      {info && info.connections.length > 0 && <Connected list={info.connections} onDisconnect={c => void disconnect(c)} />}
      {error && <p className="m-note bad">{error}</p>}
      {open && <ConnectClaudeGuide onClose={() => setOpen(false)} />}
    </div>
  )
}

// What Claude can do once connected, grouped the way the tools are (server/mcp/tools.ts).
const CAN = [
  ['Your trips', 'List and switch between them, read the plan day by day, start a new trip, or turn an itinerary you already have into one.'],
  ['Places', 'Search the web for places, suggest ones that fit, show details and videos, and add them.'],
  ['The plan', 'Add, move and remove stops, tidy a day, fill gaps, choose the hotel, and undo.'],
  ['Getting there', 'Find flights and hotels for your dates and the area you’re staying in, and record what you book.'],
  ['Money', 'Who owes whom, where the money went, add expenses and record payments.'],
  ['People', 'See who’s on the trip, invite someone, read and post in the trip chat.'],
] as const

// The Claude section of the profile: whether it's connected, the address, what it can do, and
// the connected apps, with the full guide a tap away.
export function ClaudeProfileCard({ className = '' }: { className?: string }) {
  const { info, error, disconnect } = useConnections()
  const [open, setOpen] = useState(false)
  const list = info?.connections ?? []
  const last = list.reduce<number | null>((m, c) => c.lastUsedAt && (!m || c.lastUsedAt > m) ? c.lastUsedAt : m, null)
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h2>Claude</h2>
        {info && <span className={`p-status ${list.length ? 'on' : ''}`}><i />{list.length ? `Connected${list.length > 1 ? ` · ${list.length} apps` : ''}` : 'Not connected'}</span>}
      </header>
      <p className="m-note">Wayfarer works as a connector (an MCP server) in Claude. Claude acts on the trip you choose, as you, and what it changes shows up here live.{last ? ` Last used ${when(last)}.` : ''}</p>
      <h4 className="p-sub">Your Wayfarer address</h4>
      {info ? <Address url={info.mcpUrl} /> : !error && <div className="m-skeleton p-line" />}
      <button className="cta m-small p-guide" onClick={() => setOpen(true)}>{list.length ? 'Connect another app' : 'Connect Claude, step by step'}</button>
      <h4 className="p-sub">Connected apps</h4>
      {error ? <p className="m-note bad">{error}</p> : info ? <Connected list={list} onDisconnect={c => void disconnect(c)} /> : <div className="m-skeleton p-line" />}
      <h4 className="p-sub">What Claude can do</h4>
      <dl className="p-can">{CAN.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="m-note">It can only do what you could in the app: only a trip’s admin changes its plan, and it asks before spending, inviting or posting for you.</p>
      {open && <ConnectClaudeGuide onClose={() => setOpen(false)} />}
    </section>
  )
}
