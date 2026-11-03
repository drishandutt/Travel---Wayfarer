import { useEffect, useState } from 'react'
import type { Place } from '../types'
import { CITIES } from '../data/cities'
import { PLATFORM_NAME, embedUrl, getVideos, moreLinks, posterUrl, watchUrl, type PlaceVideos, type Platform, type Video } from '../services/videos'

// The feed you reach by scrolling down a place's card or swipe tile.
// `active` is false for tiles still waiting in the deck, so they load nothing.
export function SocialVideos({ place, active = true }: { place: Place; active?: boolean }) {
  const [data, setData] = useState<PlaceVideos | null>(null)
  const [only, setOnly] = useState<Platform | null>(null)

  useEffect(() => {
    if (!active) return
    let live = true
    getVideos(place.id).then(d => { if (live) setData(d) })
    return () => { live = false }
  }, [place.id, active])

  const city = CITIES.find(c => c.places.some(x => x.id === place.id))?.name
  const videos = data?.videos ?? []
  const platforms = (Object.keys(PLATFORM_NAME) as Platform[]).filter(p => videos.some(v => v.platform === p))
  const shown = only ? videos.filter(v => v.platform === only) : videos

  return (
    <section className="social">
      <h4><span>Reels &amp; videos</span><i aria-hidden="true">↓</i></h4>
      {!data && <div className="sv-loading" />}
      {data && !videos.length && <p className="sv-none">No clips saved for this spot yet. See what people are posting:</p>}
      {platforms.length > 1 && (
        <div className="sv-chips">
          <button className={only ? '' : 'on'} aria-pressed={!only} onClick={() => setOnly(null)}>All</button>
          {platforms.map(p => (
            <button key={p} className={only === p ? 'on' : ''} aria-pressed={only === p} onClick={() => setOnly(p)}>{PLATFORM_NAME[p]}</button>
          ))}
        </div>
      )}
      {shown.map(v => <VideoItem key={v.platform + v.id} video={v} />)}
      {data && (
        <div className="sv-more">
          <span>More on</span>
          {moreLinks(place.name, city, data.topic).map(l => (
            <a key={l.platform} href={l.url} target="_blank" rel="noreferrer">{PLATFORM_NAME[l.platform]} ↗</a>
          ))}
        </div>
      )}
    </section>
  )
}

function VideoItem({ video }: { video: Video }) {
  const [playing, setPlaying] = useState(false)
  const needsTap = video.platform === 'youtube' && !playing
  const shape = video.platform === 'youtube' ? (video.short ? 'tall' : 'wide') : video.platform
  return (
    <article className="sv">
      <div className={`sv-frame ${shape}`}>
        {needsTap ? (
          <button className="sv-poster" aria-label={`Play ${video.title}`} onClick={() => setPlaying(true)}>
            <img src={posterUrl(video)} alt="" loading="lazy" draggable={false} />
            <span className="sv-play" />
          </button>
        ) : (
          <iframe
            src={embedUrl(video)}
            title={video.title}
            loading="lazy"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin" // YouTube refuses to play without a referrer
            scrolling={video.platform === 'instagram' ? 'no' : undefined} // its page would trap a finger mid-scroll
          />
        )}
      </div>
      <div className="sv-info">
        <div className="sv-by">
          <span className={`sv-badge ${video.platform}`}>{video.platform === 'youtube' && video.short ? 'Short' : PLATFORM_NAME[video.platform]}</span>
          <b>{video.by}</b>
          {video.views && <small>{video.views} views</small>}
          <a href={watchUrl(video)} target="_blank" rel="noreferrer">Open ↗</a>
        </div>
        <p>{video.title}</p>
      </div>
    </article>
  )
}
