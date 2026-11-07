// 아주 작은 DB 어댑터: 운영은 PostgreSQL(DATABASE_URL), 로컬은 SQLite 파일.
// SQL 은 두 DB 에서 모두 동작하는 문법만 쓰고, 자리표시자는 `?` 로 씁니다.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'trainee',
  code_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions (member_id);
CREATE TABLE IF NOT EXISTS auth_fails (
  ip_hash TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_fails_ip ON auth_fails (ip_hash, at);
CREATE TABLE IF NOT EXISTS absence_notices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  time TEXT,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  canceled_at BIGINT,
  checked_at BIGINT,
  checked_by TEXT
);
CREATE INDEX IF NOT EXISTS absence_day ON absence_notices (day);
CREATE INDEX IF NOT EXISTS absence_member ON absence_notices (member_id, day);
CREATE TABLE IF NOT EXISTS outings (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  day TEXT NOT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outings_day ON outings (day);
CREATE UNIQUE INDEX IF NOT EXISTS outings_one_open ON outings (member_id, day) WHERE end_at IS NULL;
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_post ON replies (post_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const statements = SCHEMA.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

export async function openDb({
  url = process.env.DATABASE_URL,
  file = ".local/portal.sqlite",
  schema,
} = {}) {
  const db = url ? await openPg(url, schema) : await openSqlite(file);
  for (const sql of statements) await db.run(sql);
  return db;
}

async function openPg(url, schema) {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT → number
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    // 테스트에서만 별도 스키마를 씁니다.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    kind: "postgres",
    async all(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows;
    },
    async get(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows[0];
    },
    async run(sql, params = []) {
      const r = await pool.query(toPg(sql), params);
      return { changes: r.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  };
}

async function openSqlite(file) {
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const norm = (params) =>
    params.map((v) => (typeof v === "boolean" ? Number(v) : v ?? null));
  return {
    kind: "sqlite",
    async all(sql, params = []) {
      return sqlite.prepare(sql).all(...norm(params));
    },
    async get(sql, params = []) {
      return sqlite.prepare(sql).get(...norm(params));
    },
    async run(sql, params = []) {
      const r = sqlite.prepare(sql).run(...norm(params));
      return { changes: Number(r.changes) };
    },
    async close() {
      sqlite.close();
    },
  };
}
