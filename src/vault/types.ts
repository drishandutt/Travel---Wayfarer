// The photo vault's shape, shared by the browser and the server.

export const VAULT_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type VaultMime = typeof VAULT_MIMES[number]

export const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024
export const MAX_THUMB_BYTES = 1024 * 1024
export const MAX_BATCH = 50

// Who a photo goes to. Nothing ticked means only you can see it.
export interface ShareTargets {
  groups: string[]
  users: string[]
}

// What the browser reads from a file before uploading it.
export interface UploadItem {
  id: string
  mime: VaultMime
  bytes: number
  thumbBytes: number
  fileName: string
  width: number | null
  height: number | null
  // the camera's own clock, as written: no time zone, so it's shown as is
  takenAt: string | null
  lat: number | null
  lng: number | null
}

export interface UploadTarget {
  url: string
  headers: Record<string, string>
}

export interface UploadTicket {
  id: string
  original: UploadTarget
  thumb: UploadTarget
}

export interface VaultImage {
  id: string
  ownerId: string
  ownerName: string
  mine: boolean
  takenAt: string | null
  createdAt: number
  width: number | null
  height: number | null
  place: string | null
  fileName: string | null
  thumbUrl: string
  // the groups you're in that it was shared to, and whether it was shared to you directly
  viaGroups: string[]
  direct: boolean
  // only on your own photos
  sharedWith?: ShareTargets
}

export interface VaultPerson { id: string; name: string }
export interface VaultGroup { id: string; name: string; admin: boolean }

export interface VaultLibrary {
  images: VaultImage[]
  groups: VaultGroup[]
  // people you share a group with, who you can send photos to
  people: VaultPerson[]
  // id → name for everyone your photos are shared with
  names: Record<string, string>
  usage: { count: number; bytes: number; maxCount: number; maxBytes: number }
}
