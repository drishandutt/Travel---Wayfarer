// Talking to the money API. Two kinds of failure matter to the UI: NetworkError means
// "couldn't reach the server" (keep the change and retry); ApiError means the server
// answered and said no (retrying won't help).

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message) }
}

export class NetworkError extends Error {
  constructor() { super('You seem to be offline') }
}

const BASE = '/api/money'

export async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
  } catch {
    console.warn(`[api] couldn’t reach ${method} ${BASE}${path}`)
    throw new NetworkError()
  }
  // the dev proxy answers 500/502 with no JSON when the API server isn't running
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try { data = text ? JSON.parse(text) : {} } catch {
    if (!res.ok) throw new NetworkError()
  }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? 'Something went wrong'), data)
  return data as T
}

export const receiptUrl = (groupId: string, id: string) => `${BASE}/groups/${groupId}/receipts/${id}`
export const liveUrl = (groupId: string) => `${BASE}/groups/${groupId}/live`

const PREFIX = 'wayfarer:money:'

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // storage full or blocked: everything still works online, it just won't survive a reload offline
  }
}

// The stored keys starting with a prefix, without the app's own prefix.
export function localKeys(prefix: string): string[] {
  try {
    return Object.keys(localStorage).filter(k => k.startsWith(PREFIX + prefix)).map(k => k.slice(PREFIX.length))
  } catch {
    return []
  }
}

// Balances and private expenses shouldn't outlive the session on a shared device.
export function clearLocal() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key)
  } catch {
    // nothing to clear if storage is blocked
  }
}
