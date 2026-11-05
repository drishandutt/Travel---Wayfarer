import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite, types } from '@electric-sql/pglite'
import pg from 'pg'

// Postgres. In production that's Supabase, reached through DATABASE_URL. Without one,
// `npm run dev` and the tests run a real Postgres in-process (PGlite), so they need no setup.
// This module and store.ts are the only places that know it's SQL.

export type Param = string | number | null | Uint8Array

interface Conn {
  query(sql: string, params?: Param[]): Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }>
  // several statements, no parameters
  script(sql: string): Promise<unknown>
}

interface Driver extends Conn {
  // PGlite is one connection: a transaction on it would take in every other query too
  readonly exclusive: boolean
  // release(true) throws the connection away instead of reusing it
  session(): Promise<Conn & { release(discard?: boolean): void }>
  close(): Promise<void>
}

// Timestamps are milliseconds and amounts are minor units: both bigint, both well inside a JS number.
const INT8 = 20

function pgDriver(url: string): Driver {
  const parsed = new URL(url)
  // TLS is set below; a ?sslmode in the string would override it
  parsed.searchParams.delete('sslmode')
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    max: 5,
    // Transactions queue behind each other, so one that hangs would hold up every write:
    // give up on a connection or a query that takes far too long, and notice a dead link.
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    keepAlive: true,
    // Supabase signs with its own CA. With DATABASE_CA (from the dashboard) the server is
    // verified; without it the link is still encrypted.
    ssl: local ? false : process.env.DATABASE_CA ? { ca: process.env.DATABASE_CA } : { rejectUnauthorized: false },
    types: { getTypeParser: ((oid: number, format?: 'text' | 'binary') => (oid === INT8 ? Number : pg.types.getTypeParser(oid, format))) as typeof pg.types.getTypeParser },
  })
  // a dropped idle connection must not take the server down with it
  pool.on('error', err => console.warn('[db]', err.message))
  return {
    exclusive: false,
    query: (sql, params) => pool.query(sql, params),
    script: sql => pool.query(sql),
    session: async () => {
      const client = await pool.connect()
      return { query: (sql, params) => client.query(sql, params), script: sql => client.query(sql), release: (discard?: boolean) => client.release(discard) }
    },
    close: () => pool.end(),
  }
}

async function pgliteDriver(dataDir?: string): Promise<Driver> {
  if (dataDir) mkdirSync(dataDir, { recursive: true }) // PGlite makes only the last folder, and ./data is gitignored
  const db = await PGlite.create(dataDir, { parsers: { [types.INT8]: Number } })
  const conn: Conn = { query: (sql, params) => db.query(sql, params), script: sql => db.exec(sql) }
  return { ...conn, exclusive: true, session: async () => ({ ...conn, release() {} }), close: () => db.close() }
}

// Numbered and append-only: production has real data, so a change is always a new entry.
// The first one is the SQLite schema as it stood when the app moved to Postgres.
export const MIGRATIONS = [`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash TEXT,
    pay_handle TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE money_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    simplify INTEGER NOT NULL DEFAULT 1,
    budget BIGINT,
    invite_token TEXT NOT NULL UNIQUE,
    trip TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    plan TEXT,
    plan_version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    email TEXT CHECK (email = lower(email)),
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    budget BIGINT,
    left_at BIGINT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX members_group ON members(group_id);
  CREATE UNIQUE INDEX members_one_seat ON members(group_id, user_id) WHERE user_id IS NOT NULL AND left_at IS NULL;
  CREATE UNIQUE INDEX members_one_invite ON members(group_id, email) WHERE email IS NOT NULL AND left_at IS NULL;
  CREATE INDEX members_email ON members(email) WHERE email IS NOT NULL;
  CREATE INDEX members_user ON members(user_id) WHERE user_id IS NOT NULL;

  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL DEFAULT 1,
    last_op TEXT,
    title TEXT NOT NULL,
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    fx_rate DOUBLE PRECISION NOT NULL,
    base_amount BIGINT NOT NULL,
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
    created_at BIGINT NOT NULL,
    updated_by TEXT,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT,
    deleted_by TEXT
  );
  CREATE INDEX expenses_group ON expenses(group_id, date);

  CREATE TABLE settlements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    from_member TEXT NOT NULL REFERENCES members(id),
    to_member TEXT NOT NULL REFERENCES members(id),
    amount BIGINT NOT NULL,
    currency TEXT NOT NULL,
    fx_rate DOUBLE PRECISION NOT NULL,
    base_amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    deleted_at BIGINT
  );
  CREATE INDEX settlements_group ON settlements(group_id);

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX comments_group ON comments(group_id);

  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    bytes BYTEA NOT NULL,
    created_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX receipts_expense ON receipts(expense_id);
  CREATE INDEX receipts_group ON receipts(group_id);

  CREATE TABLE activity (
    seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor TEXT,
    ref TEXT,
    target TEXT,
    private_to TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL
  );
  CREATE INDEX activity_group ON activity(group_id, seq);

  CREATE TABLE fx_cache (
    base TEXT NOT NULL,
    day TEXT NOT NULL,
    rates TEXT NOT NULL,
    fetched_at BIGINT NOT NULL,
    PRIMARY KEY (base, day)
  );

  CREATE TABLE votes (
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    vote TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (group_id, place_id, member_id)
  );

  CREATE TABLE trip_notes (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES money_groups(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id),
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX trip_notes_group ON trip_notes(group_id, created_at);

  -- Supabase serves the public schema over its Data API. Only this server may read these
  -- tables: row security with no policies shuts that door, and the API roles get no grants.
  DO $$
  DECLARE t text;
  BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon, authenticated', current_schema());
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM anon, authenticated', current_schema());
    END IF;
  END $$;
`, `
  -- The photo vault. The bytes are in a storage bucket; these rows are the index.
  CREATE TABLE vault_images (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_key TEXT NOT NULL,
    thumb_key TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    file_name TEXT,
    width INTEGER,
    height INTEGER,
    taken_at TEXT,
    gps_lat DOUBLE PRECISION,
    gps_lng DOUBLE PRECISION,
    place_label TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    created_at BIGINT NOT NULL
  );
  CREATE INDEX vault_images_owner ON vault_images(owner_id, created_at);

  -- Who an image is shared with: every current member of a group, or one person.
  CREATE TABLE vault_shares (
    image_id TEXT NOT NULL REFERENCES vault_images(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('group', 'user')),
    target_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (image_id, target_type, target_id)
  );
  CREATE INDEX vault_shares_target ON vault_shares(target_type, target_id);

  -- Reverse-geocoded place names, by coordinates rounded to about a kilometre.
  CREATE TABLE vault_places (
    key TEXT PRIMARY KEY,
    label TEXT,
    created_at BIGINT NOT NULL
  );

  ALTER TABLE vault_images ENABLE ROW LEVEL SECURITY;
  ALTER TABLE vault_shares ENABLE ROW LEVEL SECURITY;
  ALTER TABLE vault_places ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON vault_images, vault_shares, vault_places FROM anon, authenticated;
    END IF;
  END $$;
`]

// A transaction is one connection, and one connection runs one query at a time: reads that
// store.ts sends out together inside a transaction go one after another here.
function inOrder(conn: Conn): Conn {
  let last: Promise<unknown> = Promise.resolve()
  const next = <T>(run: () => Promise<T>): Promise<T> => {
    const out = last.then(run, run)
    last = out.catch(() => {})
    return out
  }
  return { query: (sql, params) => next(() => conn.query(sql, params)), script: sql => next(() => conn.script(sql)) }
}

// Queries are written with ? placeholders; Postgres wants $1, $2, …
const converted = new Map<string, string>()
function numbered(sql: string): string {
  let out = converted.get(sql)
  if (out === undefined) {
    let n = 0
    out = sql.replace(/\?/g, () => `$${++n}`)
    converted.set(sql, out)
  }
  return out
}

export class Db {
  // the connection of the transaction this code is running in, if any
  private current = new AsyncLocalStorage<Conn>()
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(private driver: Driver) {}

  static async connect(url: string) { return Db.ready(pgDriver(url)) }

  // In-process Postgres: in memory with no directory, kept on disk with one.
  static async local(dataDir?: string) { return Db.ready(await pgliteDriver(dataDir)) }

  private static async ready(driver: Driver) {
    const db = new Db(driver)
    await db.migrate()
    return db
  }

  // One transaction at a time, as it was with SQLite: every check-then-write in store.ts
  // relies on nothing changing in between, and one server runs this app.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private exec(sql: string, params: Param[]) {
    const conn = this.current.getStore()
    if (conn) return conn.query(numbered(sql), params)
    if (this.driver.exclusive) return this.serial(() => this.driver.query(numbered(sql), params))
    return this.driver.query(numbered(sql), params)
  }

  async one<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
    return (await this.exec(sql, params)).rows[0] as T | undefined
  }

  async all<T>(sql: string, ...params: Param[]): Promise<T[]> {
    return (await this.exec(sql, params)).rows as T[]
  }

  async run(sql: string, ...params: Param[]): Promise<{ changes: number }> {
    const r = await this.exec(sql, params)
    return { changes: r.rowCount ?? r.affectedRows ?? 0 }
  }

  // Inside a transaction already, `fn` simply joins it.
  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return fn()
    return this.serial(async () => {
      const conn = await this.driver.session()
      let broken = false
      try {
        await conn.query('BEGIN')
        const out = await this.current.run(inOrder(conn), fn)
        await conn.query('COMMIT')
        return out
      } catch (err) {
        // a connection that can't even roll back is dropped, and Postgres rolls back for it
        await conn.query('ROLLBACK').catch(() => { broken = true })
        throw err
      } finally {
        conn.release(broken)
      }
    })
  }

  private async migrate() {
    await this.tx(async () => {
      // two servers starting at once during a deploy must not both run a migration
      await this.run('SELECT pg_advisory_xact_lock(7316001)')
      await this.run('CREATE TABLE IF NOT EXISTS wayfarer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      await this.run('ALTER TABLE wayfarer_meta ENABLE ROW LEVEL SECURITY')
      const version = Number((await this.one<{ value: string }>(`SELECT value FROM wayfarer_meta WHERE key = 'schema_version'`))?.value ?? 0)
      for (let i = version; i < MIGRATIONS.length; i++) {
        await this.current.getStore()!.script(MIGRATIONS[i])
        await this.run(`INSERT INTO wayfarer_meta (key, value) VALUES ('schema_version', ?)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(i + 1))
      }
    })
  }

  close() { return this.driver.close() }
}

// Production keeps its data in Supabase. With no DATABASE_URL there, this returns null and the
// money API stays off rather than keep people's balances somewhere a deploy would wipe.
export async function openDatabase(): Promise<Db | null> {
  if (process.env.DATABASE_URL) return Db.connect(process.env.DATABASE_URL)
  if (process.env.NODE_ENV === 'production') return null
  return Db.local(resolve(process.env.WAYFARER_DEV_DB ?? 'data/pg'))
}
