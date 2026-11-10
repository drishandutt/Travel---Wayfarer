import { useCallback, useEffect, useState } from 'react'
import { api } from '../../money/client'
import { ago, errorText, plural, when } from './util'

// The analyst over the activity log (server/dev/analyst.ts). The rules' digest is always on:
// security signals, each person's journey, the new-places pipeline and product friction. With
// an AI connected, the agent digs into the same events and writes a report: on a schedule,
// on demand, or to answer a question.

interface Finding { severity: 'high' | 'medium' | 'low'; title: string; detail: string; evidence?: string }
interface UserSummary {
  user: string; id: string; email?: string; name?: string; joinedAt?: number; firstSeen: number; lastSeen: number; events: number; activeDays: number
  devices: number; ips: number; platforms: string[]; cities: string[]; stage: string; features: Record<string, number>; messages: number; said: string[]
  kept: number; skipped: number; finds: number; errors: number
}
interface Digest {
  hours: number; events: number; byFamily: Record<string, number>; security: Finding[]; users: UserSummary[]
  places: { decisions: Record<string, number>; pendingReviews: number; promoted: { city: string; name: string; via: string }[]; lookups: { text: string; status: string; n: number }[]; builds: { city: string; status: string; detail: string }[]; imports: { label: string; status: string; added: number; failed: number }[]; mostKept: { place: string; n: number }[]; mostSkipped: { place: string; n: number }[] }
  product: { errors: number; slow: { path: string; p95: number; n: number }[]; failing: { path: string; status: number; n: number }[]; actions: Record<string, number>; funnel: Record<string, number> }
}
interface Item { title: string; detail: string; action: string }
interface Report {
  headline: string
  security: (Item & { severity: 'high' | 'medium' | 'low' })[]
  users: { user: string; summary: string; stage: string; interests: string; friction: string; beta_notes: string }[]
  places: Item[]
  product: Item[]
  actions: string[]
}
interface Stored { id: string; at: number; kind: 'scheduled' | 'ask' | 'manual'; question: string | null; hours: number; model: string | null; report: Report; steps: number }
type Aliases = Record<string, { email: string; name: string; id: string }>

const WINDOWS = [[6, '6 hours'], [24, '24 hours'], [168, '7 days'], [720, '30 days']] as const
const STAGE_ORDER = ['saved a trip', 'chose a hotel', 'got a plan', 'swiped', 'briefed', 'opened the app', 'only browsed']

export function Analyst({ onSettings, onPlaces }: { onSettings: () => void; onPlaces: () => void }) {
  const [hours, setHours] = useState(24)
  const [d, setD] = useState<Digest | null>(null)
  const [ai, setAi] = useState(false)
  const [reports, setReports] = useState<Stored[]>([])
  const [aliases, setAliases] = useState<Aliases>({})
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [person, setPerson] = useState<UserSummary | null>(null)
  const [shown, setShown] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [dg, rp] = await Promise.all([
        api<{ digest: Digest; ai: boolean }>('GET', `/dev/analyst/digest?hours=${hours}`),
        api<{ reports: Stored[]; users: Aliases }>('GET', '/dev/analyst/reports'),
      ])
      setD(dg.digest)
      setAi(dg.ai)
      setReports(rp.reports)
      setAliases(rp.users)
      setError('')
    } catch (err) { setError(errorText(err)) }
  }, [hours])
  useEffect(() => { void load() }, [load])

  const run = async (ask?: string) => {
    setBusy(true)
    setError('')
    try {
      const out = await api<{ report: Stored; users: Aliases }>('POST', '/dev/analyst/run', { hours, ...(ask ? { question: ask } : {}) })
      setReports(r => [out.report, ...r])
      setAliases(out.users)
      setShown(out.report.id)
      setQuestion('')
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  // the analyst writes people as u:xxxxxxxx: show who that is
  const named = (text: string) => text.replace(/\bu:[0-9a-f]{8}\b/g, m => (aliases[m] ? `${aliases[m].name || aliases[m].email} (${aliases[m].email})` : m))
  const latest = reports.find(r => r.id === shown) ?? reports[0]

  return (
    <div className="dev-analyst">
      <div className="dev-toolbar">
        {WINDOWS.map(([h, label]) => <button key={h} className={`dev-chip ${hours === h ? 'on' : ''}`} aria-pressed={hours === h} onClick={() => setHours(h)}>{label}</button>)}
        <span className="m-spacer" />
        <button className="ghost m-small" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <p className="m-note bad">{error}</p>}

      <section className="card dev-ai">
        <header>
          <h3>The analyst</h3>
          <span className="dev-faint">{ai ? 'Reviews the activity every 6 hours when there’s been some, or now, or answers a question.' : 'Connect an AI to have it read the activity and write reports.'}</span>
        </header>
        {ai ? (
          <form className="dev-toolbar" onSubmit={e => { e.preventDefault(); void run(question.trim() || undefined) }}>
            <input type="search" placeholder="Ask about the activity: “Who got furthest?”, “Anything suspicious from new accounts?”" value={question} onChange={e => setQuestion(e.target.value)} maxLength={1000} aria-label="Question for the analyst" />
            <button className="cta m-small" disabled={busy}>{busy ? 'Reading the activity…' : question.trim() ? 'Ask' : `Review the last ${WINDOWS.find(w => w[0] === hours)?.[1]}`}</button>
          </form>
        ) : <p><button className="cta m-small" onClick={onSettings}>Add an OpenAI key in Settings</button></p>}
        {busy && <p className="dev-faint">It digs through the events with its own tools first. This takes a minute or two.</p>}
        {reports.length > 1 && (
          <div className="dev-toolbar">
            <select value={latest?.id ?? ''} onChange={e => setShown(e.target.value)} aria-label="Report">
              {reports.map(r => <option key={r.id} value={r.id}>{when(r.at)} · {r.kind === 'ask' ? `“${(r.question ?? '').slice(0, 50)}”` : r.kind === 'scheduled' ? 'scheduled' : 'on demand'} · {r.hours}h</option>)}
            </select>
          </div>
        )}
        {latest && <ReportView r={latest} named={named} />}
      </section>

      {d && (
        <>
          <p className="dev-faint">From the rules, no AI: {plural(d.events, 'event')} in the last {WINDOWS.find(w => w[0] === hours)?.[1]} ({Object.entries(d.byFamily).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ') || 'none'}).</p>

          <section className="card">
            <h3>Security</h3>
            {d.security.length ? (
              <ul className="dev-findings">{d.security.map((f, i) => <li key={i} className={`sev-${f.severity}`}><span className={`dev-sev sev-${f.severity}`}>{f.severity}</span><b>{f.title}</b> {named(f.detail)}</li>)}</ul>
            ) : <p className="dev-faint">Nothing stands out.</p>}
          </section>

          <section className="card">
            <h3>People ({d.users.length})</h3>
            {d.users.length ? (
              <div className="dev-scroll">
                <table className="dev-table">
                  <thead><tr><th>Who</th><th>Got as far as</th><th>Cities</th><th>On</th><th>Said</th><th>Kept / skipped</th><th>Finds</th><th>Errors</th><th>Last seen</th></tr></thead>
                  <tbody>
                    {[...d.users].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)).map(u => (
                      <tr key={u.id} className="dev-click" onClick={() => setPerson(u)}>
                        <td><b>{u.name || u.email || u.user}</b><br /><small className="dev-faint">{u.email} · {u.user}</small></td>
                        <td>{u.stage}</td>
                        <td>{u.cities.join(', ') || '–'}</td>
                        <td>{u.platforms.join(', ') || '–'}</td>
                        <td>{u.messages}</td>
                        <td>{u.kept} / {u.skipped}</td>
                        <td>{u.finds}</td>
                        <td>{u.errors ? <span className="dev-bad">{u.errors}</span> : 0}</td>
                        <td>{ago(u.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="dev-faint">No one signed in did anything in this window.</p>}
            {person && <Person u={person} onClose={() => setPerson(null)} />}
            {Object.keys(d.product.funnel).length > 0 && (
              <p className="dev-faint">How far people got: {STAGE_ORDER.filter(s => d.product.funnel[s]).map(s => `${s} ${d.product.funnel[s]}`).join(' → ')}</p>
            )}
          </section>

          <section className="card">
            <h3>New places</h3>
            <dl className="dev-kv">
              <dt>Finds decided</dt><dd>{Object.entries(d.places.decisions).map(([k, n]) => `${({ share: 'shared', review: 'sent for review', private: 'kept private' } as Record<string, string>)[k] ?? k} ${n}`).join(', ') || 'none'}</dd>
              <dt>Waiting for review</dt><dd>{d.places.pendingReviews ? <button className="m-link" onClick={onPlaces}>{plural(d.places.pendingReviews, 'place')} to accept or deny</button> : 'none'}</dd>
              <dt>Joined a city</dt><dd>{d.places.promoted.length ? d.places.promoted.slice(0, 12).map(p => `${p.name} (${p.city}, ${p.via})`).join(', ') : 'none'}</dd>
              <dt>Cities asked for</dt><dd>{d.places.lookups.length ? d.places.lookups.map(l => `${l.text} → ${l.status}${l.n > 1 ? ` ×${l.n}` : ''}`).join(', ') : 'none'}</dd>
              <dt>Builds</dt><dd>{d.places.builds.length ? d.places.builds.map(b => `${b.city}: ${b.status}${b.detail ? ` (${b.detail})` : ''}`).join(', ') : 'none'}</dd>
              <dt>Imports</dt><dd>{d.places.imports.length ? d.places.imports.map(i => `${i.label}: ${i.added} added, ${i.failed} not found`).join(', ') : 'none'}</dd>
              <dt>Most kept</dt><dd>{d.places.mostKept.map(p => `${p.place} ×${p.n}`).join(', ') || '–'}</dd>
              <dt>Most skipped</dt><dd>{d.places.mostSkipped.map(p => `${p.place} ×${p.n}`).join(', ') || '–'}</dd>
            </dl>
          </section>

          <section className="card">
            <h3>Product</h3>
            <dl className="dev-kv">
              <dt>Errors logged</dt><dd>{d.product.errors}</dd>
              <dt>Failing</dt><dd>{d.product.failing.length ? d.product.failing.map(f => `${f.path} → ${f.status} ×${f.n}`).join(', ') : 'none'}</dd>
              <dt>Slowest (p95)</dt><dd>{d.product.slow.length ? d.product.slow.map(s => `${s.path} ${(s.p95 / 1000).toFixed(1)} s (${s.n})`).join(', ') : '–'}</dd>
              <dt>What people do</dt><dd>{Object.entries(d.product.actions).map(([k, n]) => `${k} ${n}`).join(', ') || '–'}</dd>
            </dl>
          </section>
        </>
      )}
    </div>
  )
}

function ReportView({ r, named }: { r: Stored; named: (s: string) => string }) {
  const rep = r.report
  return (
    <div className="dev-report">
      <p className="dev-faint">{when(r.at)} · last {r.hours} hours · {r.model ?? 'AI'} · {r.steps} steps{r.question ? ` · asked: “${r.question}”` : ''}</p>
      <p className="dev-headline">{named(rep.headline)}</p>
      {rep.actions.length > 0 && <><h4>To do</h4><ol>{rep.actions.map((a, i) => <li key={i}>{named(a)}</li>)}</ol></>}
      {rep.security.length > 0 && <><h4>Security</h4><ul className="dev-findings">{rep.security.map((f, i) => <li key={i} className={`sev-${f.severity}`}><span className={`dev-sev sev-${f.severity}`}>{f.severity}</span><b>{named(f.title)}</b> {named(f.detail)}{f.action && f.action !== 'none' && <em> → {named(f.action)}</em>}</li>)}</ul></>}
      {rep.users.length > 0 && <><h4>People</h4><ul className="dev-people">{rep.users.map((u, i) => <li key={i}><b>{named(u.user)}</b> <span className="dev-faint">{u.stage}</span><p>{named(u.summary)}</p><p><span className="dev-faint">Into:</span> {named(u.interests)} · <span className="dev-faint">Stuck on:</span> {named(u.friction)}</p><p><span className="dev-faint">Ask them:</span> {named(u.beta_notes)}</p></li>)}</ul></>}
      {rep.places.length > 0 && <><h4>New places</h4><ul>{rep.places.map((p, i) => <li key={i}><b>{named(p.title)}</b> {named(p.detail)}{p.action && p.action !== 'none' && <em> → {named(p.action)}</em>}</li>)}</ul></>}
      {rep.product.length > 0 && <><h4>Product</h4><ul>{rep.product.map((p, i) => <li key={i}><b>{named(p.title)}</b> {named(p.detail)}{p.action && p.action !== 'none' && <em> → {named(p.action)}</em>}</li>)}</ul></>}
    </div>
  )
}

function Person({ u, onClose }: { u: UserSummary; onClose: () => void }) {
  return (
    <div className="dev-person">
      <header><h4>{u.name || u.email}</h4><button className="m-link" onClick={onClose}>Close</button></header>
      <dl className="dev-kv">
        <dt>Account</dt><dd>{u.email} · {u.user}{u.joinedAt ? ` · joined ${new Date(u.joinedAt).toLocaleDateString()}` : ''}</dd>
        <dt>In this window</dt><dd>{plural(u.events, 'event')} over {plural(u.activeDays, 'day')}, first {when(u.firstSeen)}, last {when(u.lastSeen)}</dd>
        <dt>Devices</dt><dd>{plural(u.devices, 'device')}, {plural(u.ips, 'address', 'addresses')} · {u.platforms.join(', ') || '–'}</dd>
        <dt>Used</dt><dd>{Object.entries(u.features).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '–'}</dd>
        <dt>Swipes</dt><dd>{u.kept} kept, {u.skipped} skipped · {plural(u.finds, 'own find')}</dd>
      </dl>
      {u.said.length > 0 && <><h4>What they said</h4><ul className="dev-said">{u.said.map((s, i) => <li key={i}>“{s}”</li>)}</ul></>}
    </div>
  )
}
