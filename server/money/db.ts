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
`, `
  -- Dev tools (server/dev): every log line and error, from the server and from browsers.
  CREATE TABLE dev_logs (
    id BIGSERIAL PRIMARY KEY,
    at BIGINT NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    user_id TEXT,
    url TEXT,
    agent TEXT
  );
  CREATE INDEX dev_logs_at ON dev_logs(at DESC);
  CREATE INDEX dev_logs_level ON dev_logs(level, at DESC);

  -- Signed-in sessions for sites that hide posts behind a login (Instagram, X, LinkedIn…),
  -- used by the link reader. One row per site; cookies is the JSON list the browser takes.
  CREATE TABLE dev_cookies (
    domain TEXT PRIMARY KEY,
    cookies TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  -- Tokens for the cookie-sync Chrome extension. Only a hash is kept.
  CREATE TABLE dev_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT
  );

  ALTER TABLE dev_logs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dev_cookies ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dev_tokens ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON dev_logs, dev_cookies, dev_tokens FROM anon, authenticated;
    END IF;
  END $$;
`, `
  -- Reels and videos found for a place, by name and city, so the slow search runs once per
  -- place rather than once per server start. videos is the PlaceVideos JSON the browser takes.
  CREATE TABLE place_videos (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    videos TEXT NOT NULL,
    found_at BIGINT NOT NULL
  );
  ALTER TABLE place_videos ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON place_videos FROM anon, authenticated;
    END IF;
  END $$;
`, `
  -- Cities built from public guides when a traveller named one (server/cities). city is the
  -- City JSON the app takes, places and hotels included.
  CREATE TABLE cities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    city TEXT NOT NULL,
    built_at BIGINT NOT NULL
  );

  -- Travellers' finds promoted into a city's shared catalog (a real attraction, restaurant or
  -- bar, never someone's home). place is the Place JSON; hidden takes one out again.
  CREATE TABLE city_places (
    id TEXT PRIMARY KEY,
    city_id TEXT NOT NULL,
    place TEXT NOT NULL,
    added_by TEXT,
    added_at BIGINT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX city_places_city ON city_places(city_id);

  -- What a place is good and bad at and who it suits, from Claude or OpenAI, for places in
  -- any city, hand-made ones included. profile is the PlaceProfile JSON.
  CREATE TABLE place_profiles (
    city_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    profiled_at BIGINT NOT NULL,
    PRIMARY KEY (city_id, place_id)
  );

  -- Every swipe, with who the traveller is (their audiences, never who they are), so a place
  -- learns who keeps it and who skips it.
  CREATE TABLE place_signals (
    id BIGSERIAL PRIMARY KEY,
    city_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    kept INTEGER NOT NULL,
    audiences TEXT NOT NULL,
    at BIGINT NOT NULL
  );
  CREATE INDEX place_signals_place ON place_signals(city_id, place_id);

  ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
  ALTER TABLE city_places ENABLE ROW LEVEL SECURITY;
  ALTER TABLE place_profiles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE place_signals ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON cities, city_places, place_profiles, place_signals FROM anon, authenticated;
      REVOKE ALL ON SEQUENCE place_signals_id_seq FROM anon, authenticated;
    END IF;
  END $$;
`, `
  -- Settings the owner changes in the dev tools without a redeploy (the OpenAI key, for one).
  CREATE TABLE dev_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    updated_by TEXT
  );

  -- Every activity, server and app: requests, sign-ins, refusals, city builds, what the system
  -- decided about a new place, and what people do in the app. detail is JSON.
  CREATE TABLE activity_events (
    id BIGSERIAL PRIMARY KEY,
    at BIGINT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    user_id TEXT,
    device TEXT,
    ip TEXT,
    agent TEXT,
    subject TEXT,
    detail TEXT
  );
  CREATE INDEX activity_events_at ON activity_events(at DESC);
  CREATE INDEX activity_events_kind ON activity_events(kind, at DESC);
  CREATE INDEX activity_events_user ON activity_events(user_id, at DESC) WHERE user_id IS NOT NULL;

  -- What the analyst agent made of the activity: scheduled reviews and questions asked.
  CREATE TABLE dev_reports (
    id TEXT PRIMARY KEY,
    at BIGINT NOT NULL,
    kind TEXT NOT NULL,
    question TEXT,
    hours INTEGER NOT NULL,
    model TEXT,
    report TEXT NOT NULL
  );
  CREATE INDEX dev_reports_at ON dev_reports(at DESC);

  -- Travellers' finds the system couldn't call either way (a hidden gem, or someone's home?),
  -- waiting for the owner to accept or deny in the dev tools. place is the Place JSON.
  CREATE TABLE place_reviews (
    id TEXT PRIMARY KEY,
    city_id TEXT NOT NULL,
    place TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'denied')),
    reason TEXT NOT NULL,
    verdict TEXT NOT NULL,
    added_by TEXT,
    created_at BIGINT NOT NULL,
    decided_at BIGINT,
    decided_by TEXT
  );
  CREATE INDEX place_reviews_status ON place_reviews(status, created_at DESC);

  ALTER TABLE dev_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dev_reports ENABLE ROW LEVEL SECURITY;
  ALTER TABLE place_reviews ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON dev_settings, activity_events, dev_reports, place_reviews FROM anon, authenticated;
      REVOKE ALL ON SEQUENCE activity_events_id_seq FROM anon, authenticated;
    END IF;
  END $$;
`, `
  -- Email verification is required. An account is verified once its owner types a code sent
  -- to its address; until then its sessions open nothing.
  ALTER TABLE users ADD COLUMN email_verified_at BIGINT;

  -- Codes sent by email: to sign in or up, or to move an account to a new address. Only a hash
  -- is kept. name is the name a new account asked for, made once the code is right.
  CREATE TABLE email_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL CHECK (email = lower(email)),
    purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'signup', 'change')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT,
    ip TEXT
  );
  CREATE INDEX email_codes_email ON email_codes(email, created_at DESC);

  ALTER TABLE email_codes ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON email_codes FROM anon, authenticated;
    END IF;
  END $$;
`, `
  -- Wayfarer as an MCP server (server/mcp): apps like Claude sign in on a person's behalf with
  -- OAuth. Clients register themselves; codes and tokens are kept only as hashes.
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    ip TEXT
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT,
    token_id TEXT
  );
  CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_hash TEXT NOT NULL UNIQUE,
    access_expires BIGINT NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    refresh_expires BIGINT NOT NULL,
    scope TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT,
    revoked_at BIGINT
  );
  CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);

  ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON oauth_clients, oauth_codes, oauth_tokens FROM anon, authenticated;
    END IF;
  END $$;
`, `
  -- The documents vault (server/docs): tickets, bookings, passports, visas and insurance, kept
  -- privately in the vault's bucket, read by the model, and the alerts they raise. An alert is
  -- shown in the app once due, emailed then (if the person wants that), and scheduled on their
  -- iPhone ahead of time. Keys are stable per document, so reading one again replaces its alerts.
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    file_name TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    kind TEXT,
    data TEXT,
    trip_id TEXT REFERENCES money_groups(id) ON DELETE SET NULL,
    tz_offset INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    read_at BIGINT
  );
  CREATE INDEX documents_owner ON documents(owner_id, created_at);
  CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    due_at BIGINT NOT NULL,
    delivered_at BIGINT,
    emailed_at BIGINT,
    read_at BIGINT,
    created_at BIGINT NOT NULL,
    UNIQUE (user_id, key)
  );
  CREATE INDEX alerts_due ON alerts(delivered_at, due_at);
  CREATE INDEX alerts_user ON alerts(user_id, due_at);
  ALTER TABLE users ADD COLUMN alert_email BOOLEAN NOT NULL DEFAULT TRUE;

  ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
  ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON documents, alerts FROM anon, authenticated;
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
