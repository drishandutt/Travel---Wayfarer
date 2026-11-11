// Reels and videos of a place, played through each platform's own embed player.
// Known places have a list curated and checked ahead of time (`src/data/videos.ts`); any other
// place, such as one a traveller added, is searched for live (`server/places.ts`). Callers only
// see PlaceVideos.

export type Platform = 'instagram' | 'youtube' | 'tiktok'

export interface Video {
  platform: Platform
  id: string           // reel shortcode or video id
  title: string
  by: string           // creator; empty when the platform doesn't say (YouTube Shorts in search)
  views?: string       // as the platform shows it, e.g. "36K"
  short?: boolean      // a portrait YouTube Short
}

export interface PlaceVideos {
  topic?: string       // Instagram's public reel grid for this place: instagram.com/popular/<topic>
  videos: Video[]
  social?: boolean     // Instagram and TikTok have been looked for (only when someone asks: it costs)
}

export const PLATFORM_NAME: Record<Platform, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' }

let library: Promise<Record<string, PlaceVideos>> | undefined

// Loaded on first use, so the list stays out of the main bundle.
function curated(placeId: string): Promise<PlaceVideos> {
  library ??= import('../data/videos').then(m => m.VIDEOS)
  return library.then(all => all[placeId] ?? { videos: [] }).catch(() => {
    library = undefined // offline or a stale chunk: try again next time
    return { videos: [] }
  })
}

// Places we hold no clips for (London's, and the ones travellers add themselves) are looked up
// on the server, which keeps what it finds. This device keeps a copy for a week too, so a place
// opened before shows its clips at once, even before the server answers.
const live = new Map<string, Promise<PlaceVideos>>()
const KEPT_MS = 7 * 86_400_000
const KEPT_PREFIX = 'wayfarer.videos.'

function kept(key: string): PlaceVideos | undefined {
  try {
    const raw = localStorage.getItem(KEPT_PREFIX + key)
    if (!raw) return undefined
    const { at, value } = JSON.parse(raw) as { at: number; value: PlaceVideos }
    if (Date.now() - at < KEPT_MS && value?.videos?.length) return value
    localStorage.removeItem(KEPT_PREFIX + key)
  } catch { /* storage blocked, full or garbled: just ask the server */ }
  return undefined
}

function keep(key: string, value: PlaceVideos) {
  try {
    localStorage.setItem(KEPT_PREFIX + key, JSON.stringify({ at: Date.now(), value }))
  } catch {
    // full: make room by dropping the clips kept longest, then try once more
    try {
      const old = Object.keys(localStorage).filter(k => k.startsWith(KEPT_PREFIX))
        .map(k => ({ k, at: (JSON.parse(localStorage.getItem(k) ?? '{}') as { at?: number }).at ?? 0 }))
        .sort((a, b) => a.at - b.at).slice(0, 50)
      for (const o of old) localStorage.removeItem(o.k)
      localStorage.setItem(KEPT_PREFIX + key, JSON.stringify({ at: Date.now(), value }))
    } catch { /* storage unavailable */ }
  }
}

// `find`: they asked for this place's reels and TikToks (a web search on the server the first
// time, then kept for good). Without it, only what's kept, or YouTube, which costs nothing.
export async function getVideos(place: { id: string; name: string; custom?: { address?: string } }, city?: string, find = false): Promise<PlaceVideos> {
  const held = await curated(place.id)
  if (held.videos.length || !city) return { ...held, social: true }
  const key = `${place.name}|${city}`.toLowerCase()
  const onDevice = kept(key)
  if (onDevice && (!find || onDevice.social)) return onDevice
  const liveKey = `${key}|${find ? 'find' : 'kept'}`
  let found = live.get(liveKey)
  if (!found) {
    const q = new URLSearchParams({ name: place.name, city, ...(place.custom?.address ? { area: place.custom.address } : {}), ...(find ? { find: '1' } : {}) })
    found = fetch(`/api/places/videos?${q}`).then(r => (r.ok ? r.json() as Promise<PlaceVideos> : { videos: [] }))
    live.set(liveKey, found)
    found.then(v => { if (v.videos.length) keep(key, v); else live.delete(liveKey) }, () => live.delete(liveKey))
  }
  return found.catch(() => ({ videos: [] }))
}

export function embedUrl(v: Video): string {
  if (v.platform === 'instagram') return `https://www.instagram.com/reel/${v.id}/embed/`
  if (v.platform === 'tiktok') return `https://www.tiktok.com/player/v1/${v.id}`
  return `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&playsinline=1&rel=0`
}

export function watchUrl(v: Video): string {
  if (v.platform === 'instagram') return `https://www.instagram.com/reel/${v.id}/`
  if (v.platform === 'tiktok') return `https://www.tiktok.com/@${v.by}/video/${v.id}`
  return v.short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`
}

// YouTube is the only one with a stable poster image, so it can wait for a tap to load its player.
export const posterUrl = (v: Video) => `https://i.ytimg.com/vi/${v.id}/${v.short ? 'frame0' : 'hqdefault'}.jpg`

// Where to see more of a place on each platform, also the fallback when we hold no clips for it.
export function moreLinks(name: string, city: string | undefined, topic?: string): { platform: Platform; url: string }[] {
  const q = encodeURIComponent(city ? `${name} ${city}` : name)
  return [
    { platform: 'instagram', url: topic ? `https://www.instagram.com/popular/${topic}/` : `https://www.instagram.com/explore/search/keyword/?q=${q}` },
    { platform: 'youtube', url: `https://www.youtube.com/results?search_query=${q}` },
    { platform: 'tiktok', url: `https://www.tiktok.com/search?q=${q}` },
  ]
}
