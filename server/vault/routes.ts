import { z } from 'zod'
import type { IncomingMessage } from 'node:http'
import type { UserRow } from '../money/auth'
import { overLimit } from '../money/auth'
import type { Db } from '../money/db'
import { HttpError } from '../money/store'
import { MAX_BATCH, MAX_ORIGINAL_BYTES, MAX_THUMB_BYTES, VAULT_MIMES } from '../../src/vault/types'
import type { DiskStorage, VaultStorage } from './storage'
import * as vault from './store'

// The photo vault's API, under /api/money/vault: it shares accounts and groups with Money.

interface Ctx { req: IncomingMessage; res: import('node:http').ServerResponse; url: URL; params: string[]; user: UserRow | null }

export interface VaultOptions {
  storage: VaultStorage | null
  geocode: vault.Geocoder | null
  limits: vault.VaultLimits
}

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Bad id')
const ids = z.array(id).min(1).max(500)
const share = z.object({ groups: z.array(id).max(50), users: z.array(id).max(200) })

const uploadItem = z.object({
  id,
  mime: z.enum(VAULT_MIMES),
  bytes: z.number().int().positive().max(MAX_ORIGINAL_BYTES, 'That photo is too large'),
  thumbBytes: z.number().int().positive().max(MAX_THUMB_BYTES),
  fileName: z.string().trim().max(200).transform(s => s.replace(/[\u0000-\u001f]/g, '')),
  width: z.number().int().positive().max(100_000).nullable(),
  height: z.number().int().positive().max(100_000).nullable(),
  takenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
})

export const vaultLimitsFromEnv = (): vault.VaultLimits => ({
  maxCount: Number(process.env.VAULT_MAX_PHOTOS ?? 2000),
  maxBytes: Number(process.env.VAULT_MAX_BYTES ?? 3 * 1024 ** 3),
})

export function registerVaultRoutes(
  db: Db,
  opts: VaultOptions,
  route: (method: string, path: string, handler: (c: Ctx) => unknown) => void,
  readBody: <T>(req: IncomingMessage, schema: z.ZodType<T>) => Promise<T>,
  needUser: (c: Ctx) => UserRow,
) {
  const { storage, geocode, limits } = opts
  const need = (): VaultStorage => {
    if (!storage) throw new HttpError(503, 'The photo vault isn’t set up on this server yet.', { code: 'no-vault-storage' })
    return storage
  }

  // dev and tests: the disk store answers its own signed links
  if (storage?.kind === 'disk') {
    const disk = storage as DiskStorage
    route('PUT', '/vault/blob', c => disk.serve(c.req, c.res, c.url))
    route('GET', '/vault/blob', c => disk.serve(c.req, c.res, c.url))
  }

  route('GET', '/vault', async c => await vault.library(db, need(), limits, needUser(c)))

  route('POST', '/vault/uploads', async c => {
    const user = needUser(c)
    const s = need()
    const body = await readBody(c.req, z.object({ items: z.array(uploadItem).min(1).max(MAX_BATCH), share }))
    if (overLimit(`vault-upload:${user.id}`, 1000, 3_600_000)) throw new HttpError(429, 'That’s a lot of photos for one hour. Try again later.')
    return { tickets: await vault.startUploads(db, s, limits, user, body.items, body.share) }
  })

  route('POST', '/vault/images/:id/done', async c => {
    const user = needUser(c)
    const row = await vault.finishUpload(db, need(), user, c.params[0])
    if (geocode && row.gps_lat != null) void vault.labelPlace(db, geocode, row.id).catch(err => console.warn('[vault] naming a place:', (err as Error).message))
    return { ok: true }
  })

  route('GET', '/vault/images/:id/original', async c => ({ url: await vault.originalUrl(db, need(), needUser(c), c.params[0]) }))

  route('POST', '/vault/share', async c => {
    const body = await readBody(c.req, z.object({ ids, share }))
    await vault.setShares(db, needUser(c), body.ids, body.share)
    return { ok: true }
  })

  route('POST', '/vault/place', async c => {
    const body = await readBody(c.req, z.object({ ids, place: z.string().trim().max(120).nullable() }))
    await vault.setPlace(db, needUser(c), body.ids, body.place || null)
    return { ok: true }
  })

  route('POST', '/vault/delete', async c => {
    const body = await readBody(c.req, z.object({ ids }))
    await vault.deleteImages(db, need(), needUser(c), body.ids)
    return { ok: true }
  })
}
