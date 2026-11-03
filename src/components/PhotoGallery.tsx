import { useEffect, useState } from 'react'
import type { LngLat } from '../types'
import { getPhotos, type Photo } from '../services/photos'

interface Props {
  id: string
  name: string
  coord: LngLat
  exactLookup?: boolean      // false for places with no real-world article (e.g. placeholder hotels)
  allowArea?: boolean        // may a whole-district article stand in for this place?
  context?: string           // city name, to sharpen the photo search
  nearbyLabel: string        // what "nearby" photos are near, e.g. "Near Ginza Lantern House"
  lead?: Photo               // hand-picked photo to show first
}

export function PhotoGallery({ id, name, coord, exactLookup, allowArea, context, nearbyLabel, lead }: Props) {
  const [photos, setPhotos] = useState<Photo[] | null>(lead ? [lead] : null)
  const [i, setI] = useState(0)
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setPhotos(lead ? [lead] : null) // the hand-picked photo needn't wait for the lookup
    setI(0)
    getPhotos(id, name, coord, { exactLookup, allowArea, context, lead })
      .then(p => { if (live) setPhotos(p) })
      .catch(() => { if (live) setPhotos(lead ? [lead] : []) })
    return () => { live = false }
  }, [id, attempt])

  // keyboard: ← → to flip through
  useEffect(() => {
    if (!photos?.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI(n => (n + 1) % photos.length)
      if (e.key === 'ArrowLeft') setI(n => (n - 1 + photos.length) % photos.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photos])

  if (photos === null) return <div className="gallery loading"><span>Finding photos…</span></div>
  if (!photos.length) {
    return (
      <div className="gallery empty">
        <span>No photos loaded for this spot.</span>
        <button onClick={() => setAttempt(a => a + 1)}>Try again</button>
      </div>
    )
  }

  const p = photos[Math.min(i, photos.length - 1)] // a broken image may have just been dropped
  return (
    <figure className="gallery">
      <div className="frame">
        {photos.map((ph, n) => (
          <img
            key={ph.full}
            src={ph.url}
            alt={ph.caption ?? name}
            className={`${n === i ? 'on' : ''} ${loaded[ph.full] ? 'ready' : ''}`}
            loading={Math.abs(n - i) <= 1 ? 'eager' : 'lazy'}
            onLoad={() => setLoaded(l => ({ ...l, [ph.full]: true }))}
            onError={() => setPhotos(ps => ps && ps.filter(x => x !== ph))}
          />
        ))}
        <span className={`photo-badge ${p.exact ? 'exact' : ''}`}>{p.exact ? 'This place' : p.related ? 'Related' : nearbyLabel}</span>
        {photos.length > 1 && (
          <>
            <button className="nav prev" aria-label="Previous photo" onClick={() => setI(n => (n - 1 + photos.length) % photos.length)}>‹</button>
            <button className="nav next" aria-label="Next photo" onClick={() => setI(n => (n + 1) % photos.length)}>›</button>
            <div className="dots">{photos.map((_, n) => <i key={n} className={n === i ? 'on' : ''} onClick={() => setI(n)} />)}</div>
          </>
        )}
      </div>
      <figcaption>
        <span className="cap">{p.caption}</span>
        <a href={p.source} target="_blank" rel="noreferrer">{p.license ? `© ${p.credit} · ${p.license}` : `Image via ${p.credit}`} ↗</a>
      </figcaption>
    </figure>
  )
}
