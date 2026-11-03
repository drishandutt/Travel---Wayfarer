import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Db, Param } from './db'

// Brings over what was kept in SQLite before the move to Postgres, once and all together.
// It runs only where WAYFARER_IMPORT_SQLITE names the old file: production's volume, or a
// dev copy on purpose. It refuses rather than merge into a database that already has people
// in it, and it never writes to the old file, which stays as a backup.

// parents before children, for the foreign keys
const TABLES = ['users', 'sessions', 'money_groups', 'members', 'expenses', 'settlements', 'comments', 'receipts', 'activity', 'fx_cache', 'votes', 'trip_notes']
// the last SQLite migration, so nothing newer or older gets misread
const SQLITE_VERSION = 2
const MARKER = 'sqlite_import'

export async function importSqliteOnce(db: Db, path = process.env.WAYFARER_IMPORT_SQLITE) {
  if (!path) return
  if (await db.one('SELECT 1 FROM wayfarer_meta WHERE key = ?', MARKER)) return
  // starting empty here would bury the real data under new sign-ups, so stop instead
  if (!existsSync(path)) throw new Error(`WAYFARER_IMPORT_SQLITE is ${path}, but there's no file there`)
  if (await db.one('SELECT 1 FROM users LIMIT 1')) throw new Error('Postgres already has accounts in it, so the SQLite data wasn’t copied in. Empty it first, or unset WAYFARER_IMPORT_SQLITE.')

  const old = new DatabaseSync(path)
  try {
    const version = (old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== SQLITE_VERSION) throw new Error(`The SQLite file is at schema ${version}; this import reads ${SQLITE_VERSION}`)

    const counts: Record<string, number> = {}
    await db.tx(async () => {
      for (const table of TABLES) {
        const rows = old.prepare(`SELECT * FROM ${table}`).all() as Record<string, Param>[]
        counts[table] = rows.length
        if (!rows.length) continue
        // SQLite compared addresses case-blind; Postgres keeps them lower case
        if (table === 'users' || table === 'members') for (const r of rows) if (typeof r.email === 'string') r.email = r.email.toLowerCase()
        const columns = Object.keys(rows[0])
        // receipts carry photos of up to 4 MB, so a few at a time
        const size = table === 'receipts' ? 4 : Math.floor(1000 / columns.length)
        for (let i = 0; i < rows.length; i += size) {
          const batch = rows.slice(i, i + size)
          const values = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
          await db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values}`, ...batch.flatMap(r => columns.map(c => r[c])))
        }
      }
      // new activity continues after the copied entries
      await db.run(`SELECT setval(pg_get_serial_sequence('activity', 'seq'), COALESCE((SELECT MAX(seq) FROM activity), 0) + 1, false)`)

      for (const table of TABLES) {
        const { n } = (await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!
        if (n !== counts[table]) throw new Error(`${table}: copied ${n} rows of ${counts[table]}`)
      }
      await db.run('INSERT INTO wayfarer_meta (key, value) VALUES (?, ?)', MARKER, JSON.stringify({ at: new Date().toISOString(), from: path, counts }))
    })
    console.log('[money] Copied the SQLite data into Postgres:', counts)
  } finally {
    old.close()
  }
}
