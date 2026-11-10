import type { Db } from '../money/db'
import { setOpenAIKey } from '../openai'

// Settings the owner changes in the dev tools without a redeploy. Kept in `dev_settings`,
// a table only this server can read (row security on, no grants), like the site sessions.

export const OPENAI_KEY = 'openai_api_key'

let db: Db | null = null

export async function attachSettingsDb(d: Db | null) {
  db = d
  if (!d) return
  // a key saved in the dev tools wins over the environment's
  const key = await getSetting(OPENAI_KEY).catch(() => null)
  if (key) setOpenAIKey(key)
}

export async function getSetting(key: string): Promise<string | null> {
  if (!db) return null
  return (await db.one<{ value: string }>('SELECT value FROM dev_settings WHERE key = ?', key))?.value ?? null
}

export async function setSetting(key: string, value: string | null, by: string | null) {
  if (!db) throw new Error('No database')
  if (value === null) await db.run('DELETE FROM dev_settings WHERE key = ?', key)
  else await db.run(`INSERT INTO dev_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, key, value, Date.now(), by)
}

export async function settingMeta(key: string): Promise<{ updatedAt: number; updatedBy: string | null } | null> {
  if (!db) return null
  const row = await db.one<{ updated_at: number; updated_by: string | null }>('SELECT updated_at, updated_by FROM dev_settings WHERE key = ?', key)
  return row ? { updatedAt: row.updated_at, updatedBy: row.updated_by } : null
}
