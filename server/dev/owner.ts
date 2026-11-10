import type { UserRow } from '../money/auth'
import type { Db } from '../money/db'
import { track } from './activity'

// Who owns the app, and so gets the dev tools: one account, by its id. Nobody else, in
// production or in development.
//
// The id is WAYFARER_OWNER_ID when set. Otherwise it's claimed once, by the first account to
// confirm the owner's address (WAYFARER_OWNER_EMAIL, or the built-in one) with an emailed code,
// and kept in `dev_settings`. From then on only that id gets in, whatever addresses later change.

const BUILT_IN_OWNER = 'drishandutt9@gmail.com'
const KEY = 'owner_user_id'

export const ownerEmail = () => (process.env.WAYFARER_OWNER_EMAIL ?? BUILT_IN_OWNER).trim().toLowerCase()

let claimed: string | null = null

export const ownerId = () => process.env.WAYFARER_OWNER_ID?.trim() || claimed

export async function loadOwner(db: Db) {
  claimed = (await db.one<{ value: string }>('SELECT value FROM dev_settings WHERE key = ?', KEY).catch(() => undefined))?.value ?? null
}

// After a verified sign-in: the owner's address, confirmed, with no owner yet, becomes the owner.
export async function claimOwner(db: Db, user: UserRow) {
  if (ownerId() || !user.email_verified_at || user.email !== ownerEmail()) return
  await db.run(`INSERT INTO dev_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`, KEY, user.id, Date.now(), user.email)
  await loadOwner(db)
  if (claimed === user.id) {
    console.info(`[dev] the dev tools now belong to account ${user.id}`)
    track('dev.owner.claimed', { userId: user.id, subject: user.id })
  }
}

export const isDevAdmin = (u: UserRow | null): boolean => {
  const id = ownerId()
  return Boolean(u && id && u.id === id && u.email_verified_at)
}
