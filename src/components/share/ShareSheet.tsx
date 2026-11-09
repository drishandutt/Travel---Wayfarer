import { useEffect, useMemo, useState } from 'react'
import { api, ApiError, NetworkError } from '../../money/client'
import type { FoundPlace, ShareRead } from '../../share/types'
import { cityById } from '../../data/cities'
import { Empty, Modal } from '../money/parts'

// A link shared to Wayfarer: read it on the server, show the places it's about, and ask
// which trip they go in. Adding them is the app's job (App.tsx), through the same path as a
// place typed into chat.

export interface ShareTarget {
  key: string
  name: string
  cityId: string | undefined
  detail: string
  current: boolean
}

export interface Shared { url: string; text?: string }

const SITE_NAMES: Record<string, string> = {
  'instagram.com': 'Instagram', 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'x.com': 'X', 'twitter.com': 'X', 'linkedin.com': 'LinkedIn',
  'tiktok.com': 'TikTok', 'facebook.com': 'Facebook', 'threads.net': 'Threads', 'threads.com': 'Threads', 'reddit.com': 'Reddit', 'google.com': 'Google',
}
export const siteName = (site: string) => SITE_NAMES[site] ?? site

const errorText = (err: unknown) => (err instanceof NetworkError ? 'You seem to be offline. Share it again when you’re connected.' : (err as Error).message)

export function ShareSheet({ shared, targets, signedIn, onAdd, onClose, onDevTools }: {
  shared: Shared
  targets: ShareTarget[]
  signedIn: boolean
  onAdd: (target: ShareTarget, places: FoundPlace[]) => void
  onClose: () => void
  // only for the app's owner: where a site's login is set
  onDevTools?: () => void
}) {
  const [read, setRead] = useState<ShareRead | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!signedIn) return
    let live = true
    setRead(null)
    setError('')
    api<ShareRead>('POST', '/share/read', { url: shared.url, text: shared.text })
      .then(r => { if (live) setRead(r) })
      .catch(err => { if (live) setError(err instanceof ApiError && err.status === 401 ? 'Sign in to add places from links.' : errorText(err)) })
    return () => { live = false }
  }, [shared.url, shared.text, signedIn])

  // the trip most of the places are in, or the one on screen
  const best = useMemo(() => {
    if (!read || !targets.length) return null
    const score = (t: ShareTarget) => read.places.filter(p => p.cityId && p.cityId === t.cityId).length
    return [...targets].sort((a, b) => score(b) - score(a) || Number(b.current) - Number(a.current))[0]
  }, [read, targets])
  useEffect(() => { if (best && !target) setTarget(best.key) }, [best, target])

  const chosen = targets.find(t => t.key === target)
  const fits = (p: FoundPlace) => Boolean(p.link) || !p.cityId || !chosen?.cityId || p.cityId === chosen.cityId
  // switching trips ticks what's in its city
  useEffect(() => {
    if (!read) return
    setPicked(new Set(read.places.map((p, i) => (fits(p) ? i : -1)).filter(i => i >= 0)))
  }, [read, target]) // eslint-disable-line react-hooks/exhaustive-deps

  const places = read?.places ?? []
  const count = places.filter((p, i) => picked.has(i) && fits(p)).length
  const toggle = (i: number) => setPicked(s => { const next = new Set(s); if (next.has(i)) next.delete(i); else next.add(i); return next })
  const add = () => { if (chosen) onAdd(chosen, places.filter((p, i) => picked.has(i) && fits(p))) }
  const cityName = (id?: string | null) => cityById(id ?? undefined)?.name

  let host = ''
  try { host = new URL(shared.url).hostname.replace(/^www\./, '') } catch { /* shown as is */ }

  return (
    <Modal eyebrow={read ? `Shared from ${siteName(read.site)}` : 'Shared link'} title={read ? read.note && !read.places.length ? 'Can’t look for places here' : (read.places.length ? `${read.places.length} place${read.places.length === 1 ? '' : 's'} in this ${read.kind === 'video' ? 'video' : read.kind === 'search' ? 'search' : read.kind === 'maps' ? 'link' : 'post'}` : 'No places found') : error ? 'Couldn’t read that link' : 'Reading the link…'}
      onClose={onClose}
      footer={read && read.places.length > 0 && targets.length > 0 ? <>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <span className="m-spacer" />
        <button className="cta" disabled={!count || !chosen} onClick={add}>{count ? `Add ${count} to ${chosen?.name ?? 'trip'}` : 'Pick a place'}</button>
      </> : <button className="ghost" onClick={onClose}>Close</button>}>
      <div className="sh-source">
        {read?.image && <img src={read.image} alt="" referrerPolicy="no-referrer" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
        <div>
          <b>{read?.title || host || shared.url}</b>
          <small>{read?.summary || shared.url}</small>
        </div>
      </div>

      {!signedIn && <p className="m-note">Sign in first, then share the link again.</p>}
      {signedIn && !read && !error && (
        <div className="sh-reading" role="status">
          <i className="orb live" />
          <span>Opening it and looking for places. Videos and posts take a few seconds.</span>
        </div>
      )}
      {error && <p className="m-note bad" role="alert">{error}</p>}

      {read?.needsLogin && (
        <p className="m-banner">
          {siteName(read.site)} only showed its login page, so {read.places.length ? 'some of the post may be missing' : 'the post couldn’t be read'}.
          {onDevTools ? <> <button className="m-link" onClick={onDevTools}>Set its session in Dev tools</button></> : ' Try a link from another app, or type the place into chat.'}
        </p>
      )}
      {read?.note && <p className="m-note">{read.note}</p>}
      {read && !read.places.length && !read.needsLogin && !read.note && (
        <Empty icon="🔎" title="Nothing to add from this one">It doesn’t name a place to go. Type one into chat instead, or share a maps link.</Empty>
      )}

      {places.length > 0 && (
        <>
          <ul className="sh-places">
            {places.map((p, i) => {
              const ok = fits(p)
              const where = [p.area, cityName(p.cityId) ?? p.city].filter(Boolean).join(', ')
              return (
                <li key={i} className={ok ? '' : 'off'}>
                  <label>
                    <input type="checkbox" checked={ok && picked.has(i)} disabled={!ok} onChange={() => toggle(i)} />
                    <span>
                      <b>{p.name}</b>
                      {where && <small>{where}</small>}
                      {!ok ? <em>Not in {cityName(chosen?.cityId)}</em> : p.why && <em>{p.why}</em>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>

          <h4 className="sh-to">Add to</h4>
          {targets.length === 0 ? (
            <p className="m-note">You don’t have a trip to add these to yet. Plan one{places[0]?.city ? ` in ${places[0].city}` : ''}, then share the link again.</p>
          ) : (
            <div className="sh-trips" role="radiogroup" aria-label="Trip">
              {targets.map(t => (
                <label key={t.key} className={`sh-trip ${t.key === target ? 'on' : ''}`}>
                  <input type="radio" name="sh-trip" checked={t.key === target} onChange={() => setTarget(t.key)} />
                  <span><b>{t.name}</b><small>{t.detail}{t.current ? ' · On screen' : ''}</small></span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
