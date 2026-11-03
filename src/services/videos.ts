// Reels and videos of a place, played through each platform's own embed player.
// The list is curated and checked ahead of time (`src/data/videos.ts`), because
// Instagram has no open search to ask live. Swap for the Instagram Graph API and
// YouTube Data API later; callers only see PlaceVideos.

export type Platform = 'instagram' | 'youtube' | 'tiktok'

export interface Video {
  platform: Platform
  id: string           // reel shortcode or video id
  title: string
  by: string           // creator
  views?: string       // as the platform shows it, e.g. "36K"
  short?: boolean      // a portrait YouTube Short
}

export interface PlaceVideos {
  topic?: string       // Instagram's public reel grid for this place: instagram.com/popular/<topic>
  videos: Video[]
}

export const PLATFORM_NAME: Record<Platform, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' }

let library: Promise<Record<string, PlaceVideos>> | undefined

// Loaded on first use, so the list stays out of the main bundle.
export function getVideos(placeId: string): Promise<PlaceVideos> {
  library ??= import('../data/videos').then(m => m.VIDEOS)
  return library.then(all => all[placeId] ?? { videos: [] }).catch(() => {
    library = undefined // offline or a stale chunk: try again next time
    return { videos: [] }
  })
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
