import { useCallback, useEffect, useRef, useState } from 'react'
import type { Place } from '../../types'
import { api } from '../../money/client'
import { ago, errorText, fileBase64, plural } from './util'

// New places, for the owner: travellers' finds the system couldn't call (accept or deny in one
// click), adding places in bulk (a whole city, a spreadsheet, a Markdown list or pasted names),
// and everything added to the cities since they were built, with a way to take one out.

interface Verdict { map: 'venue' | 'private' | 'unclear'; category: string | null; model: 'yes' | 'no' | 'unsure' | null; address?: string }
interface Review { id: string; cityId: string; place: Place; status: 'pending' | 'accepted' | 'denied'; reason: string; verdict: Verdict; addedBy: string | null; createdAt: number; decidedAt: number | null; decidedBy: string | null }
interface Added { id: string; cityId: string; place: Place; addedBy: string | null; addedAt: number; hidden: boolean }
interface Row { line: number; name: string; city?: string; country?: string; area?: string; kind?: string; vibes?: string[]; price?: number; notes?: string; lat?: number; lng?: number; link?: string; minutes?: number; bestAt?: string; keywords?: string[] }
interface RowResult { line: number; name: string; city: string | null; status: 'waiting' | 'added' | 'exists' | 'failed' | 'skipped'; message?: string; placeId?: string; cityId?: string }
interface Job { id: string; label: string; status: 'running' | 'done' | 'cancelled'; progress: string; describe: boolean; startedAt: number; finishedAt: number | null; rows: RowResult[]; counts: Record<RowResult['status'], number> }
interface CityRow { id: string; name: string; country: string; places: number; added: number; built: string | null; building: boolean }

const osm = (p: Place) => `https://www.openstreetmap.org/?mlat=${p.coord[1]}&mlon=${p.coord[0]}#map=18/${p.coord[1]}/${p.coord[0]}`
const gmaps = (p: Place, city: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name} ${city}`)}`
const MAP_WORD = { venue: 'somewhere to visit', private: 'a home or workplace', unclear: 'unclear' }
const AI_WORD = { yes: 'open to visitors', no: 'not open to visitors', unsure: 'can’t tell' }

export function Places({ onReviewed }: { onReviewed: (pending: number) => void }) {
  // bumped when an import or a build finishes, so the list of what's been added catches up
  const [changed, setChanged] = useState(0)
  const bump = useCallback(() => setChanged(n => n + 1), [])
  return (
    <div className="dev-places">
      <Reviews onReviewed={onReviewed} onDecided={bump} />
      <Bulk onDone={bump} />
      <AddedList changed={changed} />
    </div>
  )
}

// ── the review queue ─────────────────────────────────────────────────────────

function Reviews({ onReviewed, onDecided }: { onReviewed: (pending: number) => void; onDecided: () => void }) {
  const [status, setStatus] = useState<'pending' | 'accepted' | 'denied'>('pending')
  const [list, setList] = useState<Review[] | null>(null)
  const [cities, setCities] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const out = await api<{ reviews: Review[]; cities: Record<string, string> }>('GET', `/dev/places/reviews?status=${status}`)
      setList(out.reviews)
      setCities(out.cities)
      if (status === 'pending') onReviewed(out.reviews.length)
    } catch (err) { setError(errorText(err)) }
  }, [status, onReviewed])
  useEffect(() => { void load() }, [load])

  const decide = async (r: Review, accept: boolean) => {
    setBusy(r.id)
    setError('')
    try {
      await api('POST', `/dev/places/reviews/${r.id}`, { accept })
      if (accept) onDecided()
      setList(l => {
        const next = (l ?? []).filter(x => x.id !== r.id)
        onReviewed(next.length)
        return next
      })
    } catch (err) { setError(errorText(err)) } finally { setBusy(null) }
  }

  return (
    <section className="card dev-reviews">
      <header>
        <h3>To review</h3>
        <span className="dev-faint">Travellers’ finds the system couldn’t call: a hidden gem, or somewhere private? Accept shares it with everyone in that city; deny keeps it the traveller’s own. They keep it either way.</span>
      </header>
      <div className="dev-toolbar">
        {(['pending', 'accepted', 'denied'] as const).map(s => <button key={s} className={`dev-chip ${status === s ? 'on' : ''}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'pending' ? 'Waiting' : s === 'accepted' ? 'Accepted' : 'Denied'}</button>)}
      </div>
      {error && <p className="m-note bad">{error}</p>}
      {list === null ? <div className="m-skeleton" /> : list.length === 0 ? (
        <p className="dev-faint">{status === 'pending' ? 'Nothing waiting. New finds the system can’t call show up here.' : 'None yet.'}</p>
      ) : (
        <ul className="dev-review-list">
          {list.map(r => {
            const city = cities[r.cityId] ?? r.cityId
            return (
              <li key={r.id}>
                <div className="dev-review-main">
                  <b>{r.place.name}</b> <span className="dev-faint">{r.place.kind} in {city}{r.verdict.address ? ` · ${r.verdict.address}` : ''}</span>
                  <p>{r.place.blurb.replace(/^Your find: /, '')}</p>
                  <p className="dev-why">{r.reason.replace(/^./, c => c.toUpperCase())}.</p>
                  <p className="dev-faint">
                    Map: {MAP_WORD[r.verdict.map]}{r.verdict.category ? ` (${r.verdict.category})` : ''} · AI: {r.verdict.model ? AI_WORD[r.verdict.model] : 'not asked'} · added by {r.addedBy ?? 'a guest'} {ago(r.createdAt)}
                    {r.decidedAt ? ` · ${r.status} by ${r.decidedBy ?? 'someone'} ${ago(r.decidedAt)}` : ''}
                  </p>
                  <p className="dev-links">
                    <a href={osm(r.place)} target="_blank" rel="noreferrer">OpenStreetMap ↗</a>
                    <a href={gmaps(r.place, city)} target="_blank" rel="noreferrer">Google Maps ↗</a>
                    {r.place.custom?.url && <a href={r.place.custom.url} target="_blank" rel="noreferrer">The link they shared ↗</a>}
                  </p>
                </div>
                {r.status === 'pending' && (
                  <div className="dev-review-actions">
                    <button className="cta m-small" disabled={busy === r.id} onClick={() => void decide(r, true)}>Accept</button>
                    <button className="ghost m-small danger" disabled={busy === r.id} onClick={() => void decide(r, false)}>Deny</button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── adding in bulk ───────────────────────────────────────────────────────────

type Mode = 'city' | 'sheet' | 'markdown' | 'social'

function Bulk({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('city')
  return (
    <section className="card dev-bulk">
      <header>
        <h3>Add places in bulk</h3>
        <span className="dev-faint">What you add here goes straight into the city’s catalog for every traveller, without review.</span>
      </header>
      <div className="dev-toolbar" role="tablist">
        {([['city', 'A whole city'], ['sheet', 'Spreadsheet'], ['markdown', 'Markdown or a list'], ['social', 'Social (later)']] as const).map(([m, label]) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`dev-chip ${mode === m ? 'on' : ''}`} disabled={m === 'social'} title={m === 'social' ? 'Coming later' : undefined} onClick={() => setMode(m)}>{label}</button>
        ))}
      </div>
      {mode === 'city' && <WholeCity />}
      {mode === 'sheet' && <FileImport onDone={onDone} accept=".xlsx,.csv,.tsv" what="spreadsheet" hint="An .xlsx, .csv or .tsv with a column of place names. Other columns are read when their heading says what they are: City, Country, Area, Type (restaurant, bar, museum…), Vibe (food, history, nightlife…), Price ($$, cheap, 2…), Notes, Lat and Lng (or Coordinates), Link (a maps link), Duration, Best time, Cuisine." />}
      {mode === 'markdown' && <FileImport onDone={onDone} accept=".md,.markdown,.txt" what="list" paste hint="A Markdown file or pasted text: one place per line or list item (“- **Name** — note”, “Name (Area): note”), or a table with a Name column. A heading that’s a city (“# Lisbon”) sets the city for what follows; one like “## Eat” or “## Bars” sets the kind." />}
    </section>
  )
}

function WholeCity() {
  const [text, setText] = useState('')
  const [rebuild, setRebuild] = useState(false)
  const [cities, setCities] = useState<CityRow[] | null>(null)
  const [job, setJob] = useState<{ id: string; name: string; status: string; progress: string; error?: string } | null>(null)
  const [error, setError] = useState('')
  const loadCities = useCallback(() => api<{ cities: CityRow[] }>('GET', '/dev/cities').then(r => setCities(r.cities)).catch(err => setError(errorText(err))), [])
  useEffect(() => { void loadCities() }, [loadCities])
  useEffect(() => {
    if (!job || job.status !== 'building') return
    const t = setInterval(async () => {
      try {
        const s = await api<{ id: string; name: string; status: string; progress: string; error?: string }>('GET', `/dev/places/city/${job.id}`)
        setJob(s)
        if (s.status !== 'building') void loadCities()
      } catch (err) { setError(errorText(err)) }
    }, 2000)
    return () => clearInterval(t)
  }, [job, loadCities])

  const go = async () => {
    setError('')
    try {
      const out = await api<{ status: string; id?: string; name?: string; progress?: string; error?: string }>('POST', '/dev/places/city', { city: text.trim(), rebuild })
      if (out.status === 'unknown') setError(`No travel guide found for “${text.trim()}”. Try its English name, or a nearby city.`)
      else if (out.status === 'known') setJob({ id: out.id!, name: out.name!, status: 'ready', progress: 'Already mapped. Tick “build it again” to pick up places added to its guide since.' })
      else setJob({ id: out.id!, name: out.name!, status: out.status, progress: out.progress ?? '', error: out.error })
    } catch (err) { setError(errorText(err)) }
  }

  return (
    <div>
      <form className="dev-toolbar" onSubmit={e => { e.preventDefault(); void go() }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="City name, e.g. Kyoto" aria-label="City name" maxLength={120} />
        <label className="dev-live"><input type="checkbox" checked={rebuild} onChange={e => setRebuild(e.target.checked)} /> Build it again if it’s already mapped</label>
        <button className="cta m-small" disabled={text.trim().length < 2 || job?.status === 'building'}>Build</button>
      </form>
      <p className="dev-faint">Reads the city’s Wikivoyage guide and its district pages: every sight, museum, park, market, restaurant, bar and stay, ranked by fame. About a minute.</p>
      {error && <p className="m-note bad">{error}</p>}
      {job && (
        <p className={`m-note ${job.status === 'failed' ? 'bad' : ''}`} role="status">
          {job.status === 'building' && <i className="orb live" />} <b>{job.name}</b>: {job.status === 'failed' ? job.error ?? job.progress : job.progress}
        </p>
      )}
      {cities && (
        <div className="dev-scroll">
          <table className="dev-table">
            <thead><tr><th>City</th><th>Places</th><th>Added since</th><th>Source</th></tr></thead>
            <tbody>{cities.map(c => <tr key={c.id}><td><b>{c.name}</b> <small className="dev-faint">{c.country}</small></td><td>{c.places.toLocaleString()}</td><td>{c.added}</td><td>{c.building ? 'building…' : c.built ? `guide, built ${c.built}` : 'by hand'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FileImport({ accept, what, hint, paste, onDone }: { accept: string; what: string; hint: string; paste?: boolean; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [city, setCity] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [describe, setDescribe] = useState(true)
  const [ai, setAi] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<Job | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { api<{ ai: string | null }>('GET', '/dev/status').then(s => setAi(Boolean(s.ai))).catch(() => {}) }, [])
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(async () => {
      try {
        const next = (await api<{ job: Job }>('GET', `/dev/places/imports/${job.id}`)).job
        setJob(next)
        if (next.status !== 'running') onDone()
      } catch (err) { setError(errorText(err)) }
    }, 2000)
    return () => clearInterval(t)
  }, [job])

  const read = async () => {
    setBusy(true)
    setError('')
    setRows(null)
    try {
      const body = file ? { name: file.name, base64: await fileBase64(file) } : { name: 'pasted.md', text }
      const out = await api<{ rows: Row[]; skipped: number }>('POST', '/dev/places/parse', { ...body, ...(city.trim() ? { city: city.trim() } : {}) })
      setRows(out.rows)
      setSkipped(out.skipped)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const start = async () => {
    if (!rows?.length) return
    setBusy(true)
    setError('')
    try {
      const out = await api<{ job: Job }>('POST', '/dev/places/import', { rows, city: city.trim() || undefined, label: file?.name ?? `Pasted ${what}`, describe: describe && ai })
      setJob(out.job)
      setRows(null)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const cancel = async () => { if (job) await api('DELETE', `/dev/places/imports/${job.id}`).catch(err => setError(errorText(err))) }
  const reset = () => { setJob(null); setRows(null); setFile(null); setText(''); if (input.current) input.current.value = '' }
  const missingCity = rows ? rows.filter(r => !r.city).length : 0

  if (job) {
    const done = job.counts.added + job.counts.exists + job.counts.failed + job.counts.skipped
    return (
      <div className="dev-job">
        <p role="status">{job.status === 'running' && <i className="orb live" />} <b>{job.label}</b>: {job.progress}</p>
        <div className="dev-bar" aria-hidden><b style={{ width: `${(done / Math.max(1, job.rows.length)) * 100}%` }} /></div>
        <p className="dev-faint">{job.counts.added} added · {job.counts.exists} already there · {job.counts.failed} not found · {job.counts.waiting} to go{job.describe ? ' · the AI describes each one' : ''}</p>
        <div className="dev-toolbar">
          {job.status === 'running' ? <button className="ghost m-small" onClick={() => void cancel()}>Cancel</button> : <button className="cta m-small" onClick={reset}>Import more</button>}
        </div>
        <div className="dev-scroll">
          <table className="dev-table">
            <thead><tr><th>Line</th><th>Place</th><th>City</th><th>Result</th></tr></thead>
            <tbody>{job.rows.map(r => <tr key={`${r.line}-${r.name}`}><td>{r.line}</td><td>{r.name}</td><td>{r.city ?? '–'}</td><td><span className={`dev-st st-${r.status}`}>{r.status}</span> {r.message && <small className="dev-faint">{r.message}</small>}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div>
      <p className="dev-faint">{hint}</p>
      <div className="dev-toolbar">
        <input ref={input} type="file" accept={accept} onChange={e => { setFile(e.target.files?.[0] ?? null); setRows(null) }} aria-label={`Choose a ${what}`} />
        <input value={city} onChange={e => setCity(e.target.value)} placeholder="City, for rows that don’t say" aria-label="City for rows without one" maxLength={120} />
      </div>
      {paste && !file && (
        <textarea className="dev-paste" rows={6} value={text} onChange={e => { setText(e.target.value); setRows(null) }} placeholder={'# Lisbon\n- **Tasca do Chico** — fado in Bairro Alto\n- Miradouro de Santa Luzia\n## Eat\n- Cervejaria Ramiro (Intendente): garlic prawns'} aria-label="Paste a list of places" />
      )}
      <div className="dev-toolbar">
        <button className="ghost m-small" disabled={busy || (!file && !text.trim())} onClick={() => void read()}>{busy && !rows ? 'Reading…' : 'Read it'}</button>
      </div>
      {error && <p className="m-note bad">{error}</p>}
      {rows && (
        <>
          <p>{plural(rows.length, 'place')} found{skipped ? ` (${skipped} repeats or over the limit left out)` : ''}.{missingCity ? <span className="dev-bad"> {missingCity} without a city: set one above, or they’ll fail.</span> : ''} Remove any you don’t want, then import.</p>
          <div className="dev-scroll">
            <table className="dev-table dev-preview">
              <thead><tr><th>Line</th><th>Name</th><th>City</th><th>Kind</th><th>Vibes</th><th>Price</th><th>Where</th><th>Notes</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.line}-${i}`}>
                    <td>{r.line}</td>
                    <td><b>{r.name}</b></td>
                    <td>{r.city ?? (city.trim() || <span className="dev-bad">none</span>)}</td>
                    <td>{r.kind ?? <span className="dev-faint">from the map</span>}</td>
                    <td>{r.vibes?.join(', ') ?? ''}</td>
                    <td>{r.price === undefined ? '' : r.price ? '$'.repeat(r.price) : 'free'}</td>
                    <td>{r.lat !== undefined ? `${r.lat.toFixed(4)}, ${r.lng!.toFixed(4)}` : r.link ? 'link' : r.area ?? ''}</td>
                    <td><small>{r.notes ?? ''}</small></td>
                    <td><button className="m-link danger-link" aria-label={`Remove ${r.name}`} onClick={() => setRows(rs => rs!.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dev-toolbar">
            <label className="dev-live"><input type="checkbox" checked={describe && ai} disabled={!ai} onChange={e => setDescribe(e.target.checked)} /> {ai ? 'Have the AI describe and profile each place' : 'Connect an AI in Settings to have it describe each place'}</label>
            <span className="m-spacer" />
            <button className="cta m-small" disabled={busy || !rows.length} onClick={() => void start()}>Import {plural(rows.length, 'place')}</button>
          </div>
          <p className="dev-faint">Each one is looked up on OpenStreetMap, about one a second{describe && ai ? ', then described by the AI' : ''}. A city that isn’t mapped yet is built first.</p>
        </>
      )}
    </div>
  )
}

// ── what's been added ────────────────────────────────────────────────────────

function AddedList({ changed }: { changed: number }) {
  const [list, setList] = useState<Added[] | null>(null)
  const [cities, setCities] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const load = useCallback(() => api<{ added: Added[]; cities: Record<string, string> }>('GET', '/dev/places/added').then(r => { setList(r.added); setCities(r.cities) }).catch(err => setError(errorText(err))), [])
  useEffect(() => { void load() }, [load, changed])
  const hide = async (a: Added) => {
    if (!confirm(`Take ${a.place.name} out of ${cities[a.cityId] ?? a.cityId}’s places? Travellers who added it themselves keep it.`)) return
    try { await api('DELETE', `/dev/places/added/${a.cityId}/${a.id}`); void load() } catch (err) { setError(errorText(err)) }
  }
  return (
    <section className="card">
      <header>
        <h3>Added to cities</h3>
        <span className="dev-faint">Travellers’ finds, accepted reviews and imports, newest first.</span>
      </header>
      {error && <p className="m-note bad">{error}</p>}
      {list === null ? <div className="m-skeleton" /> : list.length === 0 ? <p className="dev-faint">Nothing added yet.</p> : (
        <div className="dev-scroll">
          <table className="dev-table">
            <thead><tr><th>Place</th><th>City</th><th>How</th><th>By</th><th>When</th><th /></tr></thead>
            <tbody>
              {list.map(a => (
                <tr key={`${a.cityId}/${a.id}`} className={a.hidden ? 'dev-off' : ''}>
                  <td><b>{a.place.name}</b> <small className="dev-faint">{a.place.kind}</small><br /><small>{a.place.blurb}</small></td>
                  <td>{cities[a.cityId] ?? a.cityId}</td>
                  <td>{({ traveller: 'a traveller’s find', review: 'accepted on review', import: 'imported' } as Record<string, string>)[a.place.found?.via ?? 'traveller'] ?? '–'}</td>
                  <td>{a.addedBy ?? 'a guest'}</td>
                  <td>{ago(a.addedAt)}</td>
                  <td>{a.hidden ? <span className="dev-faint">taken out</span> : <button className="m-link danger-link" onClick={() => void hide(a)}>Take out</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
