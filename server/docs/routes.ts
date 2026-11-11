import { z } from 'zod'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserRow } from '../money/auth'
import { overLimit } from '../money/auth'
import type { Db } from '../money/db'
import { HttpError } from '../money/store'
import type { VaultStorage } from '../vault/storage'
import { publicBase } from '../mcp/oauth'
import { DOC_MIMES, MAX_DOC_BYTES } from '../../src/docs/types'
import { seenAt } from './notify'
import * as docs from './store'

// The documents vault's API, under /api/money/docs, and the alerts, under /api/money/alerts.
// Files live in the photo vault's bucket, so the vault being off means this is off too.

interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; user: UserRow | null }

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Bad id')

export function registerDocsRoutes(
  db: Db,
  storage: VaultStorage | null,
  route: (method: string, path: string, handler: (c: Ctx) => unknown) => void,
  readBody: <T>(req: IncomingMessage, schema: z.ZodType<T>) => Promise<T>,
  needUser: (c: Ctx) => UserRow,
) {
  const need = (c: Ctx): VaultStorage => {
    seenAt(publicBase(c.req))
    if (!storage) throw new HttpError(503, 'The documents vault isn’t set up on this server yet.', { code: 'no-vault-storage' })
    return storage
  }

  route('GET', '/docs', async c => { need(c); return { docs: await docs.library(db, needUser(c)) } })

  route('POST', '/docs/uploads', async c => {
    const user = needUser(c)
    const s = need(c)
    const body = await readBody(c.req, z.object({
      id,
      mime: z.enum(DOC_MIMES),
      bytes: z.number().int().positive().max(MAX_DOC_BYTES, 'That file is too large (20 MB at most)'),
      fileName: z.string().trim().min(1).max(200).transform(t => t.replace(/[\u0000-\u001f]/g, '')),
      tzOffset: z.number().int().min(-14 * 60).max(14 * 60),
      tripId: id.nullable(),
    }))
    if (overLimit(`docs-upload:${user.id}`, 60, 3_600_000)) throw new HttpError(429, 'That’s a lot of documents for one hour. Try again later.')
    return { upload: await docs.startUpload(db, s, user, body) }
  })

  route('POST', '/docs/:id/done', async c => {
    await docs.finishUpload(db, need(c), needUser(c), c.params[0])
    return { ok: true }
  })

  route('POST', '/docs/:id/read', async c => {
    const user = needUser(c)
    if (overLimit(`docs-read:${user.id}`, 30, 3_600_000)) throw new HttpError(429, 'That’s a lot of re-reading. Try again later.')
    await docs.reread(db, need(c), user, c.params[0])
    return { ok: true }
  })

  route('GET', '/docs/:id/file', async c => ({ url: await docs.fileUrl(db, need(c), needUser(c), c.params[0]) }))

  route('POST', '/docs/:id/trip', async c => {
    const body = await readBody(c.req, z.object({ tripId: id.nullable() }))
    await docs.setTrip(db, needUser(c), c.params[0], body.tripId)
    return { ok: true }
  })

  route('DELETE', '/docs/:id', async c => {
    await docs.remove(db, need(c), needUser(c), c.params[0])
    return { ok: true }
  })

  route('GET', '/alerts', async c => { seenAt(publicBase(c.req)); return await docs.alertsOf(db, needUser(c)) })

  route('POST', '/alerts/read', async c => {
    const body = await readBody(c.req, z.object({ ids: z.union([z.literal('all'), z.array(z.string().max(64)).max(200)]) }))
    await docs.markRead(db, needUser(c), body.ids)
    return { ok: true }
  })
}
