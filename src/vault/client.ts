import { ApiError, NetworkError, api } from '../money/client'
import { readExif } from './exif'
import { MAX_ORIGINAL_BYTES, VAULT_MIMES, type ShareTargets, type UploadItem, type UploadTarget, type UploadTicket, type VaultLibrary, type VaultMime } from './types'

// The vault in the browser: reading a photo before it goes, uploading straight to storage,
// and the library calls.

export const loadLibrary = () => api<VaultLibrary>('GET', '/vault')
export const originalUrl = async (id: string) => (await api<{ url: string }>('GET', `/vault/images/${id}/original`)).url
export const setShares = (ids: string[], share: ShareTargets) => api('POST', '/vault/share', { ids, share })
export const setPlace = (ids: string[], place: string | null) => api('POST', '/vault/place', { ids, place })
export const deletePhotos = (ids: string[]) => api('POST', '/vault/delete', { ids })

const THUMB_EDGE = 640
// photos read and sent together; well under the server's MAX_BATCH
const CHUNK = 8

interface Prepared { item: UploadItem; file: File; thumb: Blob }

export interface UploadProgress {
  key: string
  name: string
  state: 'reading' | 'waiting' | 'uploading' | 'done' | 'failed'
  // 0..1 of the original's bytes
  sent: number
  error?: string
}

const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')

// Decoded by the browser, which turns it upright from its EXIF orientation as it does.
function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This browser can’t open that photo')) }
    img.src = url
  })
}

async function thumbnail(img: HTMLImageElement): Promise<Blob> {
  const scale = Math.min(1, THUMB_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.82))
  if (!blob) throw new Error('Couldn’t make a preview of that photo')
  return blob
}

export async function prepare(file: File): Promise<Prepared> {
  const mime = file.type as VaultMime
  if (!VAULT_MIMES.includes(mime)) throw new Error('Only JPEG, PNG and WebP photos for now')
  if (file.size > MAX_ORIGINAL_BYTES) throw new Error('Larger than 30 MB')
  // EXIF sits at the start of the file: no need to read the whole photo for it
  const facts = mime === 'image/jpeg' ? readExif(await file.slice(0, 256 * 1024).arrayBuffer()) : { takenAt: null, lat: null, lng: null }
  const img = await decode(file)
  try {
    const thumb = await thumbnail(img)
    return {
      file,
      thumb,
      item: {
        id: newId(),
        mime,
        bytes: file.size,
        thumbBytes: thumb.size,
        fileName: file.name.slice(0, 200),
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
        ...facts,
      },
    }
  } finally {
    URL.revokeObjectURL(img.src)
  }
}

// XHR rather than fetch, for upload progress.
function put(target: UploadTarget, body: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', target.url)
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v)
    if (onProgress) xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, xhr.status === 413 ? 'Too large' : 'The upload was refused')))
    xhr.onerror = () => reject(new NetworkError())
    xhr.send(body)
  })
}

// Reads every file, asks for upload links in batches, then sends a few at a time.
export async function uploadAll(files: File[], share: ShareTargets, report: (p: UploadProgress[]) => void): Promise<{ done: number; failed: number }> {
  const progress: UploadProgress[] = files.map((f, i) => ({ key: `${i}:${f.name}`, name: f.name, state: 'reading', sent: 0 }))
  const update = (i: number, patch: Partial<UploadProgress>) => {
    progress[i] = { ...progress[i], ...patch }
    report([...progress])
  }
  report([...progress])

  // Small chunks, with the next one read while this one sends: the first photos start
  // going straight away, and hundreds of them never sit decoded in memory at once.
  const prep = async (from: number) => {
    const out: { index: number; prepared: Prepared }[] = []
    for (let i = from; i < Math.min(files.length, from + CHUNK); i++) {
      try {
        out.push({ index: i, prepared: await prepare(files[i]) })
        update(i, { state: 'waiting' })
      } catch (err) {
        update(i, { state: 'failed', error: (err as Error).message })
      }
    }
    return out
  }
  const send = async (batch: { index: number; prepared: Prepared }[]) => {
    if (!batch.length) return
    let tickets: UploadTicket[]
    try {
      tickets = (await api<{ tickets: UploadTicket[] }>('POST', '/vault/uploads', { items: batch.map(b => b.prepared.item), share })).tickets
    } catch (err) {
      for (const b of batch) update(b.index, { state: 'failed', error: (err as Error).message })
      return
    }
    const byId = new Map(tickets.map(t => [t.id, t]))
    let next = 0
    const worker = async () => {
      while (next < batch.length) {
        const { index, prepared } = batch[next++]
        const ticket = byId.get(prepared.item.id)!
        try {
          update(index, { state: 'uploading' })
          await put(ticket.thumb, prepared.thumb)
          await put(ticket.original, prepared.file, f => update(index, { sent: f }))
          await api('POST', `/vault/images/${prepared.item.id}/done`, {})
          update(index, { state: 'done', sent: 1 })
        } catch (err) {
          update(index, { state: 'failed', error: (err as Error).message })
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  let reading = prep(0)
  for (let from = 0; from < files.length; from += CHUNK) {
    const batch = await reading
    if (from + CHUNK < files.length) reading = prep(from + CHUNK)
    await send(batch)
  }
  return { done: progress.filter(p => p.state === 'done').length, failed: progress.filter(p => p.state === 'failed').length }
}
