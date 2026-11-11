import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, api } from '../../money/client'
import type { GroupSummary } from '../../money/types'
import { copyText } from '../../money/util'
import { alertsChanged, deleteDoc, docFileUrl, loadDocs, rereadDoc, setDocTrip, uploadDoc } from '../../docs/client'
import { askPhonePermission, onPhone, phonePermission } from '../../docs/native'
import { fmtDate, fmtLocal } from '../../docs/alerts'
import { KIND_LABEL, type DocItem, type DocKind } from '../../docs/types'
import { Empty } from '../money/parts'

// The documents vault: tickets, bookings, passports, visas and insurance. Each is read when it
// arrives; the card shows what was read and the alerts it raises, and can be tied to a trip
// (which is what a passport or insurance is checked against).

const TRAVEL: DocKind[] = ['flight', 'train', 'bus', 'ferry', 'hotel', 'car', 'event']
const PAPERS: DocKind[] = ['passport', 'visa', 'id', 'insurance']
const ICON: Record<DocKind, string> = { flight: '✈︎', train: '🚆', bus: '🚌', ferry: '⛴', hotel: '🛏', car: '🚗', event: '🎟', insurance: '🛡', passport: '🛂', visa: '🛂', id: '🪪', other: '📄' }

const when = (ms: number) => {
  const d = Math.round((ms - Date.now()) / 86_400_000)
  const day = new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return d <= 0 ? day : d === 1 ? `${day} (tomorrow)` : d < 14 ? `${day} (in ${d} days)` : day
}

// The date a document is about, for putting the soonest first
const firstDate = (d: DocItem) => d.data?.segments[0]?.depart.at ?? d.data?.start?.at ?? d.data?.expires ?? null

function Facts({ d }: { d: DocItem }) {
  const x = d.data!
  const [copied, setCopied] = useState(false)
  const rows: [string, ReactNode][] = []
  for (const s of x.segments) rows.push([s.number ?? KIND_LABEL[x.kind], <>{s.from} → {s.to}<small>{fmtLocal(s.depart.at)}{s.arrive ? ` – ${fmtLocal(s.arrive.at).replace(/^.*, /, '')}` : ''}{s.terminal ? ` · Terminal ${s.terminal}` : ''}{s.seat ? ` · Seat ${s.seat}` : ''}</small></>])
  if (x.place) rows.push([x.kind === 'hotel' ? 'Stay' : 'Where', <>{x.place.name}{x.place.address && <small>{x.place.address}</small>}</>])
  if (x.start || x.end) rows.push([x.kind === 'hotel' ? 'Dates' : x.kind === 'insurance' || x.kind === 'visa' ? 'Valid' : 'When', `${x.start ? fmtLocal(x.start.at) : '…'}${x.end ? ` → ${fmtLocal(x.end.at)}` : ''}`])
  if (x.holder) rows.push(['Holder', x.holder])
  if (x.expires) rows.push(['Expires', fmtDate(x.expires)])
  if (x.country) rows.push(['Country', x.country])
  if (x.numberTail) rows.push(['Number', `•••• ${x.numberTail}`])
  if (x.people.length && !x.holder) rows.push(['Travellers', x.people.join(', ')])
  return (
    <>
      {x.reference && (
        <button className="d-ref" onClick={async () => { await copyText(x.reference!); setCopied(true); setTimeout(() => setCopied(false), 1400) }} title="Copy">
          <small>Booking</small><b>{x.reference}</b><span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      )}
      {rows.length > 0 && <dl className="d-facts">{rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      {x.notes.length > 0 && <ul className="d-notes">{x.notes.map(n => <li key={n}>{n}</li>)}</ul>}
      {x.checkinUrl && <a className="d-link" href={x.checkinUrl} target="_blank" rel="noreferrer">Check in or manage booking ↗</a>}
    </>
  )
}

function Card({ d, trips, onChanged }: { d: DocItem; trips: GroupSummary[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await f(); onChanged(); alertsChanged() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const open = async () => {
    // opened first, then pointed at the file, so a phone's pop-up blocker lets it through
    const w = window.open('', '_blank')
    try { const url = await docFileUrl(d.id); if (w) w.location.href = url; else location.href = url } catch (err) { w?.close(); setError((err as Error).message) }
  }
  const coming = d.alerts.filter(a => a.deliveredAt === null)
  const kind = d.kind ?? 'other'
  return (
    <article className={`d-card ${d.status}`}>
      <header>
        <span className="d-icon" aria-hidden>{ICON[kind]}</span>
        <div className="d-head">
          <small>{d.status === 'ready' ? KIND_LABEL[kind] : d.status === 'reading' ? 'Reading…' : d.status === 'failed' ? 'Couldn’t read' : 'Uploading…'}</small>
          <h3>{d.data?.title ?? d.fileName}</h3>
          {d.data?.summary && <p>{d.data.summary}</p>}
        </div>
      </header>
      {d.status === 'reading' && <div className="m-skeleton d-reading" />}
      {d.status === 'failed' && <p className="m-note bad">{d.error}</p>}
      {d.status === 'ready' && d.data && <Facts d={d} />}
      {coming.length > 0 && (
        <div className="d-alerts">
          <h4>Alerts</h4>
          <ul>{coming.slice(0, 4).map(a => <li key={a.id}><b>{a.title}</b><small>{when(a.dueAt)}</small></li>)}</ul>
        </div>
      )}
      <footer>
        <button className="ghost m-small" onClick={() => void open()}>Open file</button>
        {(d.status === 'ready' || d.status === 'failed') && <button className="ghost m-small" disabled={busy} onClick={() => void run(() => rereadDoc(d.id))}>Read again</button>}
        <label className="d-trip">
          <span>Trip</span>
          <select value={d.tripId ?? ''} disabled={busy} onChange={e => void run(() => setDocTrip(d.id, e.target.value || null))}>
            <option value="">None</option>
            {trips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <span className="m-spacer" />
        <button className="m-link danger-link" disabled={busy} onClick={() => { if (confirm(`Delete “${d.data?.title ?? d.fileName}”? Its alerts go too.`)) void run(() => deleteDoc(d.id)) }}>Delete</button>
      </footer>
      {error && <p className="m-note bad">{error}</p>}
      <small className="d-file">{d.fileName}</small>
    </article>
  )
}

export function DocsLibrary({ tabs, onClose }: { tabs: ReactNode; onClose: () => void }) {
  const [docs, setDocs] = useState<DocItem[] | null>(null)
  const [trips, setTrips] = useState<GroupSummary[]>([])
  const [error, setError] = useState<{ text: string; off?: boolean } | null>(null)
  const [sending, setSending] = useState<{ name: string; error?: string }[]>([])
  const [phone, setPhone] = useState<'granted' | 'denied' | 'prompt' | 'none'>('none')
  const input = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try { setDocs(await loadDocs()); setError(null) } catch (err) { setError({ text: (err as Error).message, off: err instanceof ApiError && err.data.code === 'no-vault-storage' }) }
  }, [])
  useEffect(() => { void refresh(); api<{ groups: GroupSummary[] }>('GET', '/groups').then(g => setTrips(g.groups)).catch(() => {}); void phonePermission().then(setPhone) }, [refresh])
  // while any is being read, look again every couple of seconds
  const reading = docs?.some(d => d.status === 'reading' || d.status === 'uploading')
  useEffect(() => {
    if (!reading) return
    const t = setInterval(() => { void refresh() }, 2500)
    return () => { clearInterval(t); alertsChanged() }
  }, [reading, refresh])

  const add = async (files: File[]) => {
    if (input.current) input.current.value = ''
    if (!files.length) return
    setSending(files.map(f => ({ name: f.name })))
    await Promise.all(files.map(async (f, i) => {
      try { await uploadDoc(f, null); setSending(s => s.map((x, j) => (j === i ? { ...x, error: '' } : x))) } catch (err) { setSending(s => s.map((x, j) => (j === i ? { ...x, error: (err as Error).message } : x))) }
    }))
    setSending(s => s.filter(x => x.error))
    await refresh()
    // the first documents: ask the phone for notifications, now that there's a reason to
    if (onPhone() && (await phonePermission()) === 'prompt') setPhone((await askPhonePermission()) ? 'granted' : 'denied')
  }

  const groups = useMemo(() => {
    const list = [...(docs ?? [])].sort((a, b) => (firstDate(a) ?? '9999').localeCompare(firstDate(b) ?? '9999'))
    const of = (kinds: DocKind[] | null) => list.filter(d => (kinds ? kinds.includes(d.kind ?? 'other') : !TRAVEL.includes(d.kind ?? 'other') && !PAPERS.includes(d.kind ?? 'other')))
    return [
      { title: 'Tickets & bookings', list: of(TRAVEL) },
      { title: 'Passports, visas & cover', list: of(PAPERS) },
      { title: 'Other', list: of(null) },
    ].filter(g => g.list.length)
  }, [docs])

  const bar = (
    <div className="v-bar">
      <button className="dash-back" onClick={onClose}>← Map</button>
      {tabs}
      {docs && <span className="v-count">{docs.length} document{docs.length === 1 ? '' : 's'}</span>}
      <span className="m-spacer" />
      <button className="cta m-small" onClick={() => input.current?.click()}><span aria-hidden>+</span> Add documents</button>
      <input ref={input} type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={e => void add([...(e.target.files ?? [])])} />
    </div>
  )

  if (error && !docs) {
    return (
      <>
        {bar}
        <div className="m-center">
          <Empty icon={error.off ? '🗄️' : '📡'} title={error.off ? 'The vault isn’t switched on here yet' : 'Can’t load your documents'}>
            {error.off ? 'This server has nowhere safe to keep files yet.' : error.text}
            {!error.off && <button className="ghost" onClick={() => void refresh()}>Try again</button>}
          </Empty>
        </div>
      </>
    )
  }
  return (
    <>
      {bar}
      {sending.length > 0 && (
        <ul className="v-progress d-sending">
          {sending.map((s, i) => <li key={i} className={s.error ? 'failed' : ''}><span className="v-progress-name">{s.name}</span><span className="v-progress-state">{s.error ?? 'Uploading…'}</span></li>)}
        </ul>
      )}
      {!docs ? <div className="v-loading"><div className="m-skeleton" /></div>
        : docs.length === 0 ? (
          <div className="m-center">
            <Empty icon="🧳" title="Your travel documents, in one place">
              Add tickets, boarding passes, hotel bookings, passports, visas and insurance as PDFs or photos. Each one is read for you, and you’ll get alerts when they matter: check-in opening, time to leave for the airport, a passport running out before a trip.
              <button className="cta" onClick={() => input.current?.click()}>Add documents</button>
            </Empty>
          </div>
        ) : (
          <div className="d-page">
            {onPhone() && phone !== 'granted' && (
              <p className="m-banner d-phone">
                {phone === 'denied' ? 'Notifications are off for Wayfarer. Turn them on in Settings → Wayfarer → Notifications to get alerts on this phone.' : <>Get these alerts on your lock screen. <button className="m-link" onClick={async () => setPhone((await askPhonePermission()) ? 'granted' : 'denied')}>Turn on notifications</button></>}
              </p>
            )}
            {groups.map(g => (
              <section key={g.title}>
                <h2 className="d-group">{g.title}</h2>
                <div className="d-grid">{g.list.map(d => <Card key={d.id} d={d} trips={trips} onChanged={() => void refresh()} />)}</div>
              </section>
            ))}
            <p className="m-note d-privacy">Documents are kept privately in your account; only you can see them. Each is read once by an AI model to find dates and details. Document numbers are kept to their last 4 characters.</p>
          </div>
        )}
    </>
  )
}
