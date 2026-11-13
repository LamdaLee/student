// 아주 작은 DB 어댑터: 운영은 PostgreSQL(DATABASE_URL), 로컬은 SQLite 파일.
// SQL 은 두 DB 에서 모두 동작하는 문법만 쓰고, 자리표시자는 `?` 로 씁니다.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  lunch_id BIGINT NOT NULL UNIQUE,
  login_id TEXT NOT NULL,
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'trainee',
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  synced_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions (member_id);
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
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_member ON push_subscriptions (member_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const statements = SCHEMA.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

// 포털 테이블 이름. PostgreSQL 에서는 SQL 을 보낼 때 앞에 스키마를 붙입니다.
const TABLES = ["members", "sessions", "absence_notices", "outings", "posts", "replies", "settings", "push_subscriptions"];

// 런치패스와 같은 DB 를 쓰므로 포털 테이블은 별도 스키마(기본 portal)에 둡니다.
// 두 앱 모두 sessions·posts 테이블이 있어 같은 스키마에 두면 겹칩니다.
export function schemaName(value = process.env.PORTAL_DB_SCHEMA || "portal") {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new Error("PORTAL_DB_SCHEMA 는 영문 소문자·숫자·_ 만 쓸 수 있습니다.");
  if (value === "public") throw new Error("PORTAL_DB_SCHEMA 를 public 으로 두면 런치패스 테이블과 겹칩니다.");
  return value;
}

// members → "portal".members (앞뒤가 . " 글자가 아닌, 단어 전체가 테이블 이름인 경우만)
export function qualify(sql, schema) {
  const re = new RegExp(`(?<![."\\w])(${TABLES.join("|")})(?![."\\w])`, "g");
  return sql.replace(re, `"${schema}".$1`);
}

export async function openDb({
  url = process.env.DATABASE_URL,
  file = ".local/portal.sqlite",
  schema,
} = {}) {
  const db = url ? await openPg(url, schemaName(schema)) : await openSqlite(file);
  for (const sql of statements) await db.run(sql);
  // 나중에 추가한 칸: 외출 예고의 복귀 예정 시각(end_time), '다녀왔습니다' 보고 시각(returned_at)
  for (const [table, column, type] of [
    ["absence_notices", "end_time", "TEXT"],
    ["absence_notices", "returned_at", "BIGINT"],
  ]) {
    if (db.kind === "postgres") await db.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    else if (!(await db.all(`PRAGMA table_info(${table})`)).some((c) => c.name === column))
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

async function openPg(url, schema) {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT → number
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
  });
  // Neon pooled 연결(PgBouncer)에서는 접속 옵션 search_path 를 믿을 수 없어서,
  // 연결 설정 대신 SQL 의 테이블 이름 앞에 스키마를 직접 붙입니다.
  const toPg = (sql) => {
    let i = 0;
    return qualify(sql, schema).replace(/\?/g, () => `$${++i}`);
  };
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
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
