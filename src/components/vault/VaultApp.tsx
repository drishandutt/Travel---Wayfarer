import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, NetworkError } from '../../money/client'
import type { AccountHandle } from '../../money/hooks'
import { deletePhotos, loadLibrary, originalUrl, setPlace, setShares, uploadAll, type UploadProgress } from '../../vault/client'
import type { ShareTargets, VaultImage, VaultLibrary } from '../../vault/types'
import { AuthScreen } from '../money/MoneyApp'
import { Empty, Modal, useEscape } from '../money/parts'

// The photo vault: every photo you can see (yours and what was shared to you), newest
// first, with filters for where it was taken, when, and who it came through. A trip's
// album is the same library narrowed to the photos shared with that trip's group.

type Source = 'all' | 'mine' | 'shared'
interface Filters { source: Source; group: string | null; place: string | null; month: string | null }
const NO_FILTERS: Filters = { source: 'all', group: null, place: null, month: null }
const NO_PLACE = '\u0000none'

const errorText = (err: unknown) => (err instanceof NetworkError ? 'You seem to be offline. Try again when you’re connected.' : (err as Error).message)

// The camera's clock has no time zone, so dates are read as written.
const dayOf = (img: VaultImage) => img.takenAt?.slice(0, 10) ?? new Date(img.createdAt).toLocaleDateString('sv')
const monthLabel = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function counts<T>(items: T[], key: (t: T) => string | null): [string, number][] {
  const m = new Map<string, number>()
  for (const i of items) { const k = key(i); if (k !== null) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m]
}

// ── who it goes to ────────────────────────────────────────────────────────────

function SharePicker({ lib, value, onChange }: { lib: VaultLibrary; value: ShareTargets; onChange: (v: ShareTargets) => void }) {
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])
  const nobody = !value.groups.length && !value.users.length
  return (
    <div className="v-share">
      {lib.groups.length > 0 && (
        <fieldset>
          <legend>Everyone in a group</legend>
          {lib.groups.map(g => (
            <label key={g.id} className={`v-chip ${value.groups.includes(g.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={value.groups.includes(g.id)} onChange={() => onChange({ ...value, groups: toggle(value.groups, g.id) })} />
              {g.name}
            </label>
          ))}
        </fieldset>
      )}
      {lib.people.length > 0 && (
        <fieldset>
          <legend>Or chosen people</legend>
          {lib.people.map(p => (
            <label key={p.id} className={`v-chip ${value.users.includes(p.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={value.users.includes(p.id)} onChange={() => onChange({ ...value, users: toggle(value.users, p.id) })} />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}
      <p className="m-note">
        {nobody ? 'Only you will see these.'
          : 'Only the people you tick will see them. Anyone who joins a ticked group later will see them too.'}
        {!lib.groups.length && ' Join or start a trip group to share photos with people.'}
      </p>
    </div>
  )
}

// ── uploading ─────────────────────────────────────────────────────────────────

function UploadSheet({ lib, files, album, onClose, onDone }: { lib: VaultLibrary; files: File[]; album: string | null; onClose: () => void; onDone: () => void }) {
  // added to a trip's album, they go to that trip
  const [share, setShare] = useState<ShareTargets>({ groups: album ? [album] : lib.groups.length === 1 ? [lib.groups[0].id] : [], users: [] })
  const [progress, setProgress] = useState<UploadProgress[] | null>(null)
  const [result, setResult] = useState<{ done: number; failed: number } | null>(null)
  const busy = progress !== null && !result
  const close = () => { if (!busy) onClose() }

  const start = async () => {
    setProgress([])
    const out = await uploadAll(files, share, setProgress)
    setResult(out)
    if (out.done) onDone()
  }
  const total = files.reduce((n, f) => n + f.size, 0)
  const sent = progress ? progress.filter(p => p.state === 'done').length : 0

  return (
    <Modal title={result ? (result.failed ? `${result.done} of ${files.length} uploaded` : `${result.done} photo${result.done === 1 ? '' : 's'} added`) : `Add ${files.length} photo${files.length === 1 ? '' : 's'}`}
      eyebrow="Photo vault" onClose={close}
      footer={result
        ? <button className="cta" onClick={onClose}>Done</button>
        : <>
            <span className="m-note">{busy ? `${sent} of ${files.length} sent` : fmtBytes(total)}</span>
            <span className="m-spacer" />
            <button className="ghost" onClick={close} disabled={busy}>Cancel</button>
            <button className="cta" onClick={start} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
          </>}>
      {!progress && <SharePicker lib={lib} value={share} onChange={setShare} />}
      {progress && (
        <ul className="v-progress">
          {progress.map(p => (
            <li key={p.key} className={p.state}>
              <span className="v-progress-name">{p.name}</span>
              <span className="v-progress-state">
                {p.state === 'failed' ? p.error : p.state === 'done' ? '✓' : p.state === 'uploading' ? `${Math.round(p.sent * 100)}%` : p.state === 'reading' ? 'Reading…' : 'Waiting'}
              </span>
              <i style={{ width: `${(p.state === 'done' ? 1 : p.sent) * 100}%` }} />
            </li>
          ))}
        </ul>
      )}
      {result && result.failed > 0 && <p className="m-note bad">Some photos didn’t go. Add them again to retry.</p>}
    </Modal>
  )
}

// ── one photo ─────────────────────────────────────────────────────────────────

function Viewer({ lib, list, index, onIndex, onClose, onChanged }: { lib: VaultLibrary; list: VaultImage[]; index: number; onIndex: (i: number) => void; onClose: () => void; onChanged: () => void }) {
  const img = list[index]
  const [src, setSrc] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'share' | 'place'>('view')
  const [share, setShare] = useState<ShareTargets>(img.sharedWith ?? { groups: [], users: [] })
  const [place, setPlaceText] = useState(img.place ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEscape(() => (mode === 'view' ? onClose() : setMode('view')))
  useEffect(() => {
    setSrc(null)
    setMode('view')
    setError('')
    setShare(img.sharedWith ?? { groups: [], users: [] })
    setPlaceText(img.place ?? '')
    let live = true
    originalUrl(img.id).then(u => { if (live) setSrc(u) }).catch(err => { if (live) setError(errorText(err)) })
    return () => { live = false }
  }, [img.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (mode !== 'view' || (e.target as HTMLElement).closest('input, textarea')) return
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      if (e.key === 'ArrowRight' && index < list.length - 1) onIndex(index + 1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [index, list.length, mode, onIndex])

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError('')
    try { await fn(); onChanged(); after?.() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const groupName = (id: string) => lib.groups.find(g => g.id === id)?.name ?? 'A group you’ve left'
  const personName = (id: string) => lib.names[id] ?? 'Someone'
  const sharedLine = img.sharedWith
    ? [...img.sharedWith.groups.map(groupName), ...img.sharedWith.users.map(personName)].join(', ') || 'Only you'
    : null

  return (
    <div className="v-viewer" role="dialog" aria-modal="true" aria-label="Photo">
      <div className="v-viewer-stage">
        {src ? <img src={src} alt={img.place ?? 'Photo'} /> : <img src={img.thumbUrl} alt="" className="v-blur" />}
        {index > 0 && <button className="v-nav prev" aria-label="Previous photo" onClick={() => onIndex(index - 1)}>‹</button>}
        {index < list.length - 1 && <button className="v-nav next" aria-label="Next photo" onClick={() => onIndex(index + 1)}>›</button>}
        <button className="v-viewer-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <aside className="v-viewer-info">
        <h2>{img.takenAt ? dayLabel(img.takenAt.slice(0, 10)) : `Added ${dayLabel(dayOf(img))}`}</h2>
        <dl>
          {img.takenAt && <><dt>Taken</dt><dd>{img.takenAt.slice(11, 16)}</dd></>}
          <dt>Place</dt><dd>{img.place ?? 'Not known'}</dd>
          <dt>From</dt><dd>{img.mine ? 'You' : img.ownerName}</dd>
          {!img.mine && <><dt>Shared</dt><dd>{[...img.viaGroups.map(groupName), ...(img.direct ? ['with you'] : [])].join(', ')}</dd></>}
          {sharedLine && <><dt>Shared with</dt><dd>{sharedLine}</dd></>}
          {img.width && img.height && <><dt>Size</dt><dd>{img.width} × {img.height}</dd></>}
          {img.fileName && <><dt>File</dt><dd className="v-file">{img.fileName}</dd></>}
        </dl>
        {src && <a className="ghost m-small" href={src} target="_blank" rel="noreferrer">Open full size</a>}

        {img.mine && mode === 'view' && (
          <div className="v-owner-tools">
            <button className="ghost m-small" onClick={() => setMode('share')}>Change who sees it</button>
            <button className="ghost m-small" onClick={() => setMode('place')}>{img.place ? 'Rename place' : 'Add place'}</button>
            <button className="m-link danger-link" disabled={busy} onClick={() => {
              if (confirm('Delete this photo? It’s removed for everyone it was shared with.')) run(() => deletePhotos([img.id]), onClose)
            }}>Delete</button>
          </div>
        )}
        {mode === 'share' && (
          <form className="v-edit" onSubmit={e => { e.preventDefault(); run(() => setShares([img.id], share), () => setMode('view')) }}>
            <SharePicker lib={lib} value={share} onChange={setShare} />
            <div className="v-edit-row">
              <button type="button" className="ghost m-small" onClick={() => setMode('view')}>Cancel</button>
              <button className="cta m-small" disabled={busy}>Save</button>
            </div>
          </form>
        )}
        {mode === 'place' && (
          <form className="v-edit" onSubmit={e => { e.preventDefault(); run(() => setPlace([img.id], place.trim() || null), () => setMode('view')) }}>
            <input autoFocus value={place} maxLength={120} placeholder="e.g. Lisbon, Portugal" aria-label="Place" onChange={e => setPlaceText(e.target.value)} />
            <div className="v-edit-row">
              <button type="button" className="ghost m-small" onClick={() => setMode('view')}>Cancel</button>
              <button className="cta m-small" disabled={busy}>Save</button>
            </div>
          </form>
        )}
        {error && <p className="m-note bad" role="alert">{error}</p>}
      </aside>
    </div>
  )
}

// ── the filters ───────────────────────────────────────────────────────────────

function FilterPanel({ lib, images, f, setF, album }: { lib: VaultLibrary; images: VaultImage[]; f: Filters; setF: (f: Filters) => void; album: string | null }) {
  const places = counts(images, i => i.place ?? NO_PLACE).sort((a, b) => (a[0] === NO_PLACE ? 1 : b[0] === NO_PLACE ? -1 : b[1] - a[1]))
  const months = counts(images, i => dayOf(i).slice(0, 7)).sort((a, b) => b[0].localeCompare(a[0]))
  const groups = album ? [] : lib.groups.map(g => [g, images.filter(inGroup(g.id)).length] as const).filter(([, n]) => n > 0)
  const pick = <K extends keyof Filters>(k: K, v: Filters[K]) => setF({ ...f, [k]: f[k] === v ? NO_FILTERS[k] : v })
  const any = f.source !== 'all' || f.group || f.place || f.month
  return (
    <aside className="v-filters" aria-label="Filters">
      <section>
        <h3>Photos</h3>
        {([['all', 'All'], ['mine', 'Yours'], ['shared', 'Shared with you']] as const).map(([k, label]) => (
          <button key={k} className={f.source === k ? 'on' : ''} aria-pressed={f.source === k} onClick={() => setF({ ...f, source: k })}>{label}</button>
        ))}
      </section>
      {places.length > 0 && (
        <section>
          <h3>Places</h3>
          {places.map(([p, n]) => (
            <button key={p} className={f.place === p ? 'on' : ''} aria-pressed={f.place === p} onClick={() => pick('place', p)}>
              <span>{p === NO_PLACE ? 'No location' : p}</span><small>{n}</small>
            </button>
          ))}
        </section>
      )}
      {months.length > 1 && (
        <section>
          <h3>When</h3>
          {months.map(([m, n]) => (
            <button key={m} className={f.month === m ? 'on' : ''} aria-pressed={f.month === m} onClick={() => pick('month', m)}>
              <span>{monthLabel(m)}</span><small>{n}</small>
            </button>
          ))}
        </section>
      )}
      {groups.length > 0 && (
        <section>
          <h3>Trips</h3>
          {groups.map(([g, n]) => (
            <button key={g.id} className={f.group === g.id ? 'on' : ''} aria-pressed={f.group === g.id} onClick={() => pick('group', g.id)}>
              <span>{g.name}</span><small>{n}</small>
            </button>
          ))}
        </section>
      )}
      {any && <button className="m-link v-clear" onClick={() => setF(NO_FILTERS)}>Clear filters</button>}
    </aside>
  )
}

const inGroup = (id: string) => (i: VaultImage) => i.viaGroups.includes(id) || Boolean(i.sharedWith?.groups.includes(id))

// ── the library ───────────────────────────────────────────────────────────────

function Library({ album, scoped, onAlbum, onClose }: { album: string | null; scoped: boolean; onAlbum: (id: string | null) => void; onClose: () => void }) {
  const [lib, setLib] = useState<VaultLibrary | null>(null)
  const [error, setError] = useState<{ text: string; off?: boolean } | null>(null)
  const [f, setF] = useState<Filters>(NO_FILTERS)
  const [files, setFiles] = useState<File[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      setLib(await loadLibrary())
      setError(null)
    } catch (err) {
      setError({ text: errorText(err), off: err instanceof ApiError && err.data.code === 'no-vault-storage' })
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { setF(NO_FILTERS); setOpen(null) }, [album])
  // thumbnail links expire after a few hours: fetch fresh ones when the tab comes back
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [refresh])

  const images = useMemo(() => (album ? (lib?.images ?? []).filter(inGroup(album)) : lib?.images ?? []), [lib, album])
  const shown = useMemo(() => images.filter(i =>
    (f.source === 'all' || (f.source === 'mine') === i.mine)
    && (!f.group || inGroup(f.group)(i))
    && (!f.place || (f.place === NO_PLACE ? !i.place : i.place === f.place))
    && (!f.month || dayOf(i).startsWith(f.month))), [images, f])
  const days = useMemo(() => {
    const out: { day: string; items: { img: VaultImage; index: number }[] }[] = []
    shown.forEach((img, index) => {
      const day = dayOf(img)
      if (out.at(-1)?.day !== day) out.push({ day, items: [] })
      out.at(-1)!.items.push({ img, index })
    })
    return out
  }, [shown])
  // a photo deleted while open, or filtered away, closes the viewer
  useEffect(() => { if (open !== null && open >= shown.length) setOpen(null) }, [open, shown.length])

  const choose = (list: FileList | null) => {
    if (list?.length) setFiles([...list])
    if (input.current) input.current.value = ''
  }

  if (error && !lib) {
    return (
      <div className="m-center">
        <Empty icon={error.off ? '🗄️' : '📡'} title={error.off ? 'The photo vault isn’t switched on here yet' : 'Can’t load your photos'}>
          {error.off ? 'This server has nowhere safe to keep photos yet, so the vault is off rather than risk losing them.' : error.text}
          {!error.off && <button className="ghost" onClick={refresh}>Try again</button>}
        </Empty>
      </div>
    )
  }
  if (!lib) return <div className="v-loading"><div className="m-skeleton" /></div>

  const filtered = f !== NO_FILTERS && shown.length !== images.length
  const albumName = album ? lib.groups.find(g => g.id === album)?.name ?? 'This trip' : null
  // every trip with photos in it, for the all-photos view to step into
  const albums = album ? [] : lib.groups.map(g => ({ g, list: lib.images.filter(inGroup(g.id)) })).filter(a => a.list.length > 0)
  return (
    <>
      <div className="v-bar">
        {scoped ? <button className="dash-back" onClick={onClose}>← Trip</button>
          : album ? <button className="dash-back" onClick={() => onAlbum(null)}>← All photos</button>
          : <button className="dash-back" onClick={onClose}>← Map</button>}
        <h1>{albumName ?? 'Photos'}</h1>
        <span className="v-count">{filtered ? `${shown.length} of ${images.length}` : `${images.length} photo${images.length === 1 ? '' : 's'}`}</span>
        <span className="m-spacer" />
        {images.length > 0 && <button className="ghost m-small v-filter-toggle" aria-expanded={showFilters} onClick={() => setShowFilters(s => !s)}>Filters{filtered ? ' •' : ''}</button>}
        <button className="cta m-small" onClick={() => input.current?.click()}><span aria-hidden>+</span> Add photos</button>
        <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp" hidden onChange={e => choose(e.target.files)} />
      </div>

      {images.length === 0 ? (
        <div className="m-center">
          {album
            ? <Empty icon="🖼️" title={`No photos from ${albumName} yet`}>
                Photos added here are shared with everyone on the trip.
                <button className="cta" onClick={() => input.current?.click()}>Add photos</button>
              </Empty>
            : <Empty icon="🖼️" title="Your trip photos, in one place">
                Add photos to keep them here, and share them with a trip group or with the people you choose. They’re sorted by place and date as they arrive.
                <button className="cta" onClick={() => input.current?.click()}>Add photos</button>
              </Empty>}
        </div>
      ) : (
        <div className={`v-layout ${showFilters ? 'filters-open' : ''}`}>
          <FilterPanel lib={lib} images={images} f={f} setF={setF} album={album} />
          <main className="v-main">
            {albums.length > 0 && f.source === 'all' && !f.group && !f.place && !f.month && (
              <section className="v-albums" aria-label="Trips">
                <h2>Trips</h2>
                <div className="v-album-row">
                  {albums.map(({ g, list }) => (
                    <button key={g.id} className="v-album" onClick={() => onAlbum(g.id)}>
                      <img src={list[0].thumbUrl} alt="" loading="lazy" decoding="async" />
                      <span><b>{g.name}</b><small>{list.length} photo{list.length === 1 ? '' : 's'}</small></span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {days.length === 0 && <Empty icon="🔍" title="Nothing matches">Try clearing a filter.</Empty>}
            {days.map(d => (
              <section key={d.day} className="v-day">
                <h2>{dayLabel(d.day)}{d.items[0].img.place && <small> · {[...new Set(d.items.map(x => x.img.place).filter(Boolean))].slice(0, 2).join(', ')}</small>}</h2>
                <div className="v-grid">
                  {d.items.map(({ img, index }) => (
                    <button key={img.id} className="v-tile" onClick={() => setOpen(index)} aria-label={`Photo${img.place ? ` in ${img.place}` : ''}${img.mine ? '' : ` from ${img.ownerName}`}`}>
                      <img src={img.thumbUrl} alt="" loading="lazy" decoding="async" />
                      {!img.mine && <span className="v-from">{img.ownerName}</span>}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            <p className="m-note v-usage">You’ve stored {lib.usage.count} of {lib.usage.maxCount} photos ({fmtBytes(lib.usage.bytes)} of {fmtBytes(lib.usage.maxBytes)}).</p>
          </main>
        </div>
      )}

      {files && <UploadSheet lib={lib} files={files} album={album} onClose={() => setFiles(null)} onDone={refresh} />}
      {open !== null && shown[open] && <Viewer lib={lib} list={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onChanged={refresh} />}
    </>
  )
}

// With a scope it's that one trip's album; without, every photo, with each trip's album to step into.
export function VaultApp({ acct, scope, onClose }: { acct: AccountHandle; scope?: string; onClose: () => void }) {
  const { account, status, signedIn, retry } = acct
  const [album, setAlbum] = useState<string | null>(scope ?? null)
  useEscape(onClose)
  let body
  if (status === 'loading' && !account) body = <div className="v-loading"><div className="m-skeleton" /></div>
  else if (!account && status === 'offline') {
    body = (
      <div className="m-center">
        <Empty icon="📡" title="Can’t reach the server">
          Your photos need a connection.
          <button className="ghost" onClick={retry}>Try again</button>
        </Empty>
      </div>
    )
  } else if (!account) body = <AuthScreen onDone={signedIn} />
  else body = <Library key={account.id} album={album} scoped={Boolean(scope)} onAlbum={setAlbum} onClose={onClose} />
  return (
    <div className="dash m-app v-app" role="dialog" aria-label="Photo vault">
      {!account && <div className="m-top"><button className="dash-back" onClick={onClose}>← Back to map</button></div>}
      {body}
    </div>
  )
}
