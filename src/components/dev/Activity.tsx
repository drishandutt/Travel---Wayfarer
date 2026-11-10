import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../money/client'
import { errorText, when } from './util'

// Every activity, newest first: requests, sign-ins, refusals, city builds, what the system
// decided about new places, and what people do in the app. Filter by family, person, address
// or device, and open a row for everything it carries.

interface Event { id: number; at: number; kind: string; source: 'server' | 'app'; user: string | null; device: string | null; ip: string | null; agent: string | null; subject: string | null; detail: Record<string, unknown> }
interface Who { email: string; name: string; alias: string }

const FAMILIES = ['app', 'http', 'auth', 'security', 'place', 'city', 'system', 'analyst', 'dev'] as const

// One line saying what happened, from the kind and its detail.
export function describe(e: Event): string {
  const d = e.detail
  const s = (k: string) => (d[k] === undefined || d[k] === null ? '' : String(d[k]))
  switch (e.kind) {
    case 'http.request': return `${s('method')} ${e.subject} → ${s('status')} in ${s('ms')} ms`
    case 'app.action': {
      const t = s('type')
      if (t === 'chat') return `${s('role') === 'user' ? 'Said' : 'Was told'}: “${s('text')}”`
      if (t === 'chat-edit') return `Asked for a change: “${s('text')}”`
      if (t === 'swipe') return `${d.like ? 'Kept' : 'Skipped'} ${s('name') || s('place')}${d.match !== null && d.match !== undefined ? ` (${s('match')}% match)` : ''}`
      if (t === 'brief') return `Brief: ${[s('destination'), d.days ? `${s('days')} days` : '', d.travelers ? `${s('travelers')} people` : '', Array.isArray(d.vibes) ? (d.vibes as string[]).join(', ') : ''].filter(Boolean).join(' · ')}`
      if (t === 'select-place') return `Opened ${s('name') || s('place')}`
      if (t === 'add-custom-place') return `Added their own place: ${s('name')}`
      if (t === 'planner') return `Planner: ${s('event')}${d.message ? ` – ${s('message')}` : ''}${d.hotel ? ` – ${s('hotel')}` : ''}`
      if (t === 'phase') return `Moved to ${s('to')}`
      return `${t}${d.name ? `: ${s('name')}` : ''}${d.day ? ` (day ${s('day')})` : ''}`
    }
    case 'app.click': return `Pressed “${s('label')}”${d.area ? ` in ${s('area')}` : ''}`
    case 'app.screen': return `${d.open ? 'Opened' : 'Closed'} ${s('screen')}`
    case 'app.open': return `Opened the app (${s('platform')}, ${s('width')}×${s('height')}, ${s('timezone')})`
    case 'app.visible': return `Was in the app for ${s('seconds')} s`
    case 'auth.signin': return `Signed in${d.password ? ' with a password' : ''}`
    case 'auth.signup': return 'Made an account'
    case 'security.rate_limit': return `Rate limit tripped: ${s('key')}`
    case 'security.bad_password': return `Wrong password${d.while ? ` (${s('while')})` : ''}`
    case 'security.forbidden': return `Refused: ${s('method')} ${e.subject}`
    case 'security.unauthorized': return `Not let into the dev tools: ${s('method')} ${e.subject}`
    case 'system.error': return `Server error: ${s('method')} ${e.subject} → ${s('status')}`
    case 'city.lookup': return `Looked for a city: “${s('text')}” → ${s('status')}${d.error ? ` (${s('error')})` : ''}`
    case 'city.build.start': return `Started building ${s('name')}${d.rebuild ? ' again' : ''}`
    case 'city.build.done': return `Built ${s('name')}: ${s('places')} places, ${s('hotels')} stays`
    case 'city.build.failed': return `Couldn’t build ${s('name')}: ${s('error')}`
    case 'place.resolve': return `Found “${s('asked') || s('link')}” → ${s('found')} (${s('kind')}; map: ${s('map')}${d.model ? `, AI: ${s('model')}` : ''})`
    case 'place.resolve.failed': return `Couldn’t find “${s('asked') || s('link')}”: ${s('error')}`
    case 'place.decision': return `${s('name')}: ${({ share: 'shared with everyone', review: 'sent for review', private: 'kept private' } as Record<string, string>)[s('decision')] ?? s('decision')} – ${s('reason')}`
    case 'place.promoted': return `${s('name')} joined ${s('city')} (${s('via')})`
    case 'place.review.queued': return `${s('name')} waits for review: ${s('reason')}`
    case 'place.review.accepted': return `Accepted ${s('name')}`
    case 'place.review.denied': return `Denied ${s('name')}`
    case 'place.signals': return `Swipes in ${e.subject}: ${s('kept')} kept, ${s('skipped')} skipped`
    case 'place.import.row': return `Import line ${s('line')}: ${s('name')} → ${s('status')}${d.message ? ` (${s('message')})` : ''}`
    default: return Object.keys(d).length ? Object.entries(d).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : (e.subject ?? '')
  }
}

export function Activity() {
  const [rows, setRows] = useState<Event[]>([])
  const [users, setUsers] = useState<Record<string, Who>>({})
  const [more, setMore] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [kind, setKind] = useState('')
  const [source, setSource] = useState('')
  const [who, setWho] = useState('')
  const [ip, setIp] = useState('')
  const [device, setDevice] = useState('')
  const [q, setQ] = useState('')
  const [live, setLive] = useState(true)
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState('')
  const filters = useRef({ kind, source, who, ip, device, q })
  filters.current = { kind, source, who, ip, device, q }

  const load = useCallback(async (before?: number) => {
    const f = filters.current
    const params = new URLSearchParams({ limit: '200' })
    if (f.kind) params.set('kind', f.kind)
    if (f.source) params.set('source', f.source)
    if (f.who) params.set('user', f.who)
    if (f.ip) params.set('ip', f.ip)
    if (f.device) params.set('device', f.device)
    if (f.q) params.set('q', f.q)
    if (before) params.set('before', String(before))
    try {
      const out = await api<{ events: Event[]; more: boolean; users: Record<string, Who>; last24h: Record<string, number> }>('GET', `/dev/activity?${params}`)
      setRows(r => (before ? [...r, ...out.events] : out.events))
      setUsers(u => ({ ...u, ...out.users }))
      setMore(out.more)
      setCounts(out.last24h)
      setError('')
    } catch (err) { setError(errorText(err)) }
  }, [])
  useEffect(() => { void load() }, [kind, source, ip, device, load])
  useEffect(() => { const t = setTimeout(() => void load(), 350); return () => clearTimeout(t) }, [q, who, load])
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 5000)
    return () => clearInterval(t)
  }, [live, load])

  const person = (id: string | null) => (id ? users[id]?.email ?? id.slice(0, 8) : null)
  const filtered = Boolean(kind || source || who || ip || device || q)
  const clear = () => { setKind(''); setSource(''); setWho(''); setIp(''); setDevice(''); setQ('') }

  return (
    <div className="dev-logs dev-activity">
      <div className="dev-toolbar">
        {FAMILIES.map(f => (
          <button key={f} className={`dev-chip fam-${f} ${kind === f ? 'on' : ''}`} aria-pressed={kind === f} onClick={() => setKind(k => (k === f ? '' : f))}>
            {f}<small>{counts[f] ?? 0}</small>
          </button>
        ))}
      </div>
      <div className="dev-toolbar">
        <select value={source} onChange={e => setSource(e.target.value)} aria-label="Source">
          <option value="">Server and app</option>
          <option value="server">Server</option>
          <option value="app">App (browsers, iPhone)</option>
        </select>
        <input type="search" placeholder="Person: email or u:1a2b3c4d" value={who} onChange={e => setWho(e.target.value)} aria-label="Person" />
        <input type="search" placeholder="Search kinds, pages, what was said" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
        <label className="dev-live"><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Live</label>
        {filtered && <button className="m-link" onClick={clear}>Clear filters</button>}
      </div>
      {(ip || device) && <p className="dev-faint">Only {ip ? `address ${ip}` : ''}{ip && device ? ' and ' : ''}{device ? `device ${device.slice(0, 8)}` : ''}.</p>}
      <p className="dev-faint">Counts are for the last 24 hours. Events are kept for 90 days.</p>
      {error && <p className="m-note bad">{error}</p>}
      <ol className="dev-rows">
        {rows.map(r => (
          <li key={r.id} className={`fam-${r.kind.split('.')[0]} ${r.kind.startsWith('security') || r.kind === 'system.error' ? 'lv-error' : ''} ${open === r.id ? 'open' : ''}`}>
            <button onClick={() => setOpen(o => (o === r.id ? null : r.id))}>
              <time>{when(r.at)}</time>
              <span className="dev-kind">{r.kind}</span>
              <span className="dev-src">{person(r.user) ?? (r.ip ? r.ip : '–')}</span>
              <span className="dev-msg">{describe(r)}</span>
            </button>
            {open === r.id && (
              <div className="dev-detail">
                <dl>
                  {r.user && <><dt>Person</dt><dd>{person(r.user)} {users[r.user] && <small className="dev-faint">{users[r.user].alias}</small>} <button className="m-link" onClick={() => setWho(users[r.user!]?.email ?? r.user!)}>Only them</button></dd></>}
                  {r.ip && <><dt>Address</dt><dd>{r.ip} <button className="m-link" onClick={() => setIp(r.ip!)}>Only this address</button></dd></>}
                  {r.device && <><dt>Device</dt><dd>{r.device.slice(0, 12)} <button className="m-link" onClick={() => setDevice(r.device!)}>Only this device</button></dd></>}
                  {r.agent && <><dt>Browser</dt><dd>{r.agent}</dd></>}
                  {r.subject && <><dt>Subject</dt><dd>{r.subject}</dd></>}
                  <dt>From</dt><dd>{r.source}</dd>
                </dl>
                <pre>{JSON.stringify(r.detail, null, 2)}</pre>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!rows.length && !error && <p className="dev-faint">Nothing recorded{filtered ? ' that matches' : ' yet'}.</p>}
      {more && <button className="ghost" onClick={() => void load(rows.at(-1)?.id)}>Older</button>}
    </div>
  )
}
