// The SQLite schema as it stood before the move to Postgres, for testing the one-time copy.
// History: never change it.
export const SQLITE_MIGRATIONS = [`
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
