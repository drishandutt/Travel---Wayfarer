import { useCallback, useEffect, useState } from 'react'
import { NetworkError, api } from '../money/client'
import { DOC_MIMES, MAX_DOC_BYTES, type AlertItem, type DocItem, type DocMime, type UploadTarget } from './types'
import { scheduleOnPhone } from './native'

// The documents vault and alerts in the browser: the API calls, an upload straight to
// storage, and a hook that keeps the alerts fresh (and the phone's notifications in step).

export const loadDocs = async () => (await api<{ docs: DocItem[] }>('GET', '/docs')).docs
export const docFileUrl = async (id: string) => (await api<{ url: string }>('GET', `/docs/${id}/file`)).url
export const rereadDoc = (id: string) => api('POST', `/docs/${id}/read`, {})
export const setDocTrip = (id: string, tripId: string | null) => api('POST', `/docs/${id}/trip`, { tripId })
export const deleteDoc = (id: string) => api('DELETE', `/docs/${id}`)

const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')

// A phone's camera roll can hand over a HEIC; everything else goes by its type, or its name
function mimeOf(file: File): DocMime | null {
  if ((DOC_MIMES as readonly string[]).includes(file.type)) return file.type as DocMime
  if (!file.type && /\.pdf$/i.test(file.name)) return 'application/pdf'
  return null
}

export async function uploadDoc(file: File, tripId: string | null): Promise<string> {
  const mime = mimeOf(file)
  if (!mime) throw new Error('Only PDFs and photos (JPEG, PNG, WebP)')
  if (file.size > MAX_DOC_BYTES) throw new Error('Larger than 20 MB')
  const id = newId()
  const { upload } = await api<{ upload: UploadTarget }>('POST', '/docs/uploads', {
    id, mime, bytes: file.size, fileName: file.name || 'document', tzOffset: -new Date().getTimezoneOffset(), tripId,
  })
  const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: file })
  if (!res.ok) throw new Error(`The upload didn’t go through (${res.status})`)
  await api('POST', `/docs/${id}/done`, {})
  return id
}

export interface Alerts { arrived: AlertItem[]; coming: AlertItem[]; unread: number }

// Polled while signed in, and again whenever the app comes back to the front.
export function useAlerts(enabled: boolean) {
  const [alerts, setAlerts] = useState<Alerts | null>(null)
  const refresh = useCallback(async () => {
    try {
      const a = await api<Alerts>('GET', '/alerts')
      setAlerts(a)
      void scheduleOnPhone(a.coming)
    } catch (err) {
      if (!(err instanceof NetworkError)) console.warn('[alerts]', (err as Error).message)
    }
  }, [])
  useEffect(() => {
    if (!enabled) { setAlerts(null); return }
    void refresh()
    const t = setInterval(() => { void refresh() }, 60_000)
    const back = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('wayfarer:alerts', back)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); window.removeEventListener('wayfarer:alerts', back) }
  }, [enabled, refresh])
  const markAllRead = useCallback(async () => {
    setAlerts(a => (a ? { ...a, unread: 0, arrived: a.arrived.map(x => ({ ...x, readAt: x.readAt ?? Date.now() })) } : a))
    await api('POST', '/alerts/read', { ids: 'all' }).catch(() => {})
  }, [])
  return { alerts, refresh, markAllRead }
}

// Anything that changed documents tells the alerts to look again.
export const alertsChanged = () => window.dispatchEvent(new Event('wayfarer:alerts'))
