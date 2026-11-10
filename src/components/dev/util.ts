import { NetworkError } from '../../money/client'

// Small helpers the dev tools' tabs share.

export const errorText = (err: unknown) => (err instanceof NetworkError ? 'Can’t reach the server.' : (err as Error).message)

export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000)
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

// Reads a file the owner chose as base64, for uploading in a JSON body.
export function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(new Error('Couldn’t read that file'))
    r.readAsDataURL(file)
  })
}
