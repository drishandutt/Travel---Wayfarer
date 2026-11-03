import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

// One SQLite file: no setup for `npm run dev`, and a good fit for one Node server.
// This module and store.ts are the only places that know it's SQLite.

// In production, data must outlive a deploy, so with no volume this returns null and the
// money API refuses to run rather than quietly losing people's balances on the next deploy.
export function resolveDbPath(): string | null {
  if (process.env.WAYFARER_DB_PATH) return process.env.WAYFARER_DB_PATH
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'wayfarer.db')
  return process.env.NODE_ENV === 'production' ? null : resolve('data/wayfarer.db')
}

// Numbered and append-only: production has real data, so a change is always a new entry.
export const MIGRATIONS = [`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    pay_handle TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE money_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    simplify INTEGER NOT NULL DEFAULT 1,
    budget INTEGER,
    invite_token TEXT NOT NULL UNIQUE,
    trip TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    email TEXT COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    budget INTEGER,
    left_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX members_group ON members(group_id);
  CREATE UNIQUE INDEX members_one_seat ON members(group_id, user_id) WHERE user_id IS NOT NULL AND left_at IS NULL;
  CREATE UNIQUE INDEX members_one_invite ON members(group_id, email) WHERE email IS NOT NULL AND left_at IS NULL;
  CREATE INDEX members_email ON members(email) WHERE email IS NOT NULL;

  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL DEFAULT 1,
    last_op TEXT,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    fx_rate REAL NOT NULL,
    base_amount INTEGER NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    payers TEXT NOT NULL,
    split TEXT NOT NULL,
    shares TEXT NOT NULL,
    base_paid TEXT NOT NULL,
    base_owed TEXT NOT NULL,
    private_to TEXT REFERENCES members(id),
    private_user TEXT,
    place_id TEXT,
    place_name TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by TEXT
  );
  CREATE INDEX expenses_group ON expenses(group_id, date);

  CREATE TABLE settlements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    from_member TEXT NOT NULL REFERENCES members(id),
    to_member TEXT NOT NULL REFERENCES members(id),
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    fx_rate REAL NOT NULL,
    base_amount INTEGER NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX settlements_group ON settlements(group_id);

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_group ON comments(group_id);

  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX receipts_expense ON receipts(expense_id);

  CREATE TABLE activity (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor TEXT,
    ref TEXT,
    target TEXT,
    private_to TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activity_group ON activity(group_id, seq);

  CREATE TABLE fx_cache (
    base TEXT NOT NULL,
    day TEXT NOT NULL,
    rates TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (base, day)
  );
`, `
  ALTER TABLE money_groups ADD COLUMN plan TEXT;
  ALTER TABLE money_groups ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE votes (
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    vote TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, place_id, member_id)
  );

  CREATE TABLE trip_notes (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX trip_notes_group ON trip_notes(group_id, created_at);
`]

export class Db {
  private raw: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version
    MIGRATIONS.slice(version).forEach((sql, i) => {
      this.tx(() => {
        this.raw.exec(sql)
        this.raw.exec(`PRAGMA user_version = ${version + i + 1}`)
      })
    })
  }

  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[]
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params)
  }

  // Node is single-threaded and this API is synchronous, so a transaction can't
  // interleave with another request as long as `fn` doesn't await.
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (err) {
      this.raw.exec('ROLLBACK')
      throw err
    }
  }

  close() { this.raw.close() }
}
