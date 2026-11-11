import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import type { UploadTarget } from '../../src/vault/types'

// Where the vault's bytes live. Production uses a private Supabase Storage bucket, and the
// browser uploads to it and reads from it through short-lived signed URLs, so photos never
// pass through this server. Dev and the tests keep files on disk, behind URLs this server
// signs and serves itself, so the two behave the same from the browser's side.

export interface VaultStorage {
  kind: 'disk' | 'supabase'
  // where the browser should PUT one object
  uploadTarget(key: string, mime: string): Promise<UploadTarget>
  // the object's size and first bytes, or null if nothing was uploaded
  probe(key: string): Promise<{ size: number; head: Buffer } | null>
  // signed URLs to read objects, valid for `seconds`
  readUrls(keys: string[], seconds: number): Promise<Map<string, string>>
  remove(keys: string[]): Promise<void>
  // the whole object, for the server to read itself (a document being analysed)
  read(key: string): Promise<Buffer>
}

const HEAD_BYTES = 16

// ── on disk (dev and tests) ───────────────────────────────────────────────────

export interface DiskStorage extends VaultStorage {
  // the /vault/blob route: answers PUTs and GETs carrying a token this signed
  serve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>
}

const BLOB_PATH = '/api/money/vault/blob'

export function diskStorage(root: string, maxBytes: number): DiskStorage {
  const dir = resolve(root)
  // per process: a restart only expires the links, and the library hands out fresh ones
  const secret = randomBytes(32)
  const sign = (text: string) => createHmac('sha256', secret).update(text).digest('base64url')
  const pathOf = (key: string) => {
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(key)) throw new Error(`Bad key ${key}`)
    return join(dir, ...key.split('/'))
  }
  const link = (op: 'put' | 'get', key: string, seconds: number) => {
    const exp = Date.now() + seconds * 1000
    const q = new URLSearchParams({ key, exp: String(exp), sig: sign(`${op}:${key}:${exp}`) })
    return `${BLOB_PATH}?${q}`
  }
  const verify = (op: 'put' | 'get', q: URLSearchParams) => {
    const key = q.get('key') ?? ''
    const exp = Number(q.get('exp'))
    const sig = Buffer.from(q.get('sig') ?? '')
    const want = Buffer.from(sign(`${op}:${key}:${exp}`))
    if (!(exp > Date.now()) || sig.length !== want.length || !timingSafeEqual(sig, want)) return null
    try { return { key, file: pathOf(key) } } catch { return null }
  }
  const fail = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error }))
  }

  return {
    kind: 'disk',
    uploadTarget: async (key, mime) => ({ url: link('put', key, 3600), headers: { 'Content-Type': mime } }),
    async probe(key) {
      let handle
      try {
        handle = await open(pathOf(key), 'r')
        const { size } = await handle.stat()
        const head = Buffer.alloc(Math.min(HEAD_BYTES, size))
        await handle.read(head, 0, head.length, 0)
        return { size, head }
      } catch {
        return null
      } finally {
        await handle?.close()
      }
    },
    readUrls: async (keys, seconds) => new Map(keys.map(k => [k, link('get', k, seconds)])),
    async remove(keys) {
      await Promise.all(keys.map(k => rm(pathOf(k), { force: true })))
    },
    read: key => readFile(pathOf(key)),
    async serve(req, res, url) {
      if (req.method === 'PUT') {
        const ok = verify('put', url.searchParams)
        if (!ok) return fail(res, 403, 'That upload link has expired')
        await mkdir(dirname(ok.file), { recursive: true })
        const temp = `${ok.file}.${randomBytes(4).toString('hex')}.part`
        let size = 0
        let tooBig = false
        await new Promise<void>((done, reject) => {
          const out = createWriteStream(temp)
          req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > maxBytes && !tooBig) { tooBig = true; out.destroy() }
            if (!tooBig) out.write(chunk)
          })
          req.on('end', () => (tooBig ? done() : out.end(done)))
          req.on('error', reject)
          out.on('error', err => (tooBig ? undefined : reject(err)))
        })
        if (tooBig) {
          await rm(temp, { force: true })
          return fail(res, 413, 'That photo is too large')
        }
        await rename(temp, ok.file)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      if (req.method === 'GET') {
        const ok = verify('get', url.searchParams)
        if (!ok) return fail(res, 403, 'That link has expired')
        const info = await stat(ok.file).catch(() => null)
        if (!info) return fail(res, 404, 'That photo is gone')
        const head = (await this.probe(ok.key))?.head ?? Buffer.alloc(0)
        res.writeHead(200, {
          'Content-Type': sniffFile(head) ?? 'application/octet-stream',
          'Content-Length': info.size,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        })
        createReadStream(ok.file).pipe(res)
        return
      }
      fail(res, 405, 'Not allowed')
    },
  }
}

// ── Supabase Storage (production) ─────────────────────────────────────────────

export function supabaseStorage(projectUrl: string, serviceKey: string, bucket: string): VaultStorage {
  const base = `${projectUrl.replace(/\/$/, '')}/storage/v1`
  const auth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
  const path = (key: string) => key.split('/').map(encodeURIComponent).join('/')
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, {
      method,
      headers: { ...auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return res
  }
  return {
    kind: 'supabase',
    async uploadTarget(key, mime) {
      const res = await call('POST', `${base}/object/upload/sign/${bucket}/${path(key)}`, {})
      if (!res.ok) throw new Error(`Storage refused an upload link: ${res.status} ${await res.text()}`)
      const { url } = await res.json() as { url: string }
      return { url: `${base}${url}`, headers: { 'Content-Type': mime } }
    },
    async probe(key) {
      const res = await call('GET', `${base}/object/authenticated/${bucket}/${path(key)}`, undefined, { Range: `bytes=0-${HEAD_BYTES - 1}` })
      if (res.status === 400 || res.status === 404) return null
      if (!res.ok) throw new Error(`Storage couldn’t check an upload: ${res.status}`)
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, HEAD_BYTES)
      const total = res.headers.get('content-range')?.split('/')[1]
      const size = total && total !== '*' ? Number(total) : Number(res.headers.get('content-length') ?? head.length)
      return { size, head }
    },
    async readUrls(keys, seconds) {
      const out = new Map<string, string>()
      if (!keys.length) return out
      // the batch endpoint takes a list; keep each request a sensible size
      for (let i = 0; i < keys.length; i += 500) {
        const res = await call('POST', `${base}/object/sign/${bucket}`, { expiresIn: seconds, paths: keys.slice(i, i + 500) })
        if (!res.ok) throw new Error(`Storage refused read links: ${res.status}`)
        for (const r of await res.json() as { path: string; signedURL: string | null }[]) {
          if (r.signedURL) out.set(r.path, `${base}${r.signedURL}`)
        }
      }
      return out
    },
    async read(key) {
      const res = await call('GET', `${base}/object/authenticated/${bucket}/${path(key)}`)
      if (!res.ok) throw new Error(`Storage couldn’t read a file: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    },
    async remove(keys) {
      if (!keys.length) return
      const res = await call('DELETE', `${base}/object/${bucket}`, { prefixes: keys })
      if (!res.ok) throw new Error(`Storage couldn’t delete: ${res.status}`)
    },
  }
}

// ── which one ─────────────────────────────────────────────────────────────────

// Production with no bucket configured gets no vault, rather than photos on a disk that a
// redeploy wipes.
export function vaultStorageFromEnv(maxBytes: number): VaultStorage | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && key) return supabaseStorage(url, key, process.env.VAULT_BUCKET ?? 'vault')
  if (process.env.NODE_ENV === 'production') return null
  return diskStorage(process.env.VAULT_DISK_DIR ?? 'data/vault', maxBytes)
}

// Goes by the bytes, not what the browser said: these get shown to other people.
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// Photos, and the PDFs the documents vault keeps
export function sniffFile(b: Buffer): string | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  return sniffImage(b)
}
