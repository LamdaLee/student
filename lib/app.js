// 훈련생 포털 API. 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 같이 씁니다.
// 계정은 런치패스에 있고, 포털은 런치패스 학번·비밀번호로 로그인합니다(lib/lunchpass.js).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLunchpassClient, lunchpassConfig, LunchpassError } from "./lunchpass.js";

const KINDS = { absent: "결석", late: "지각", early: "조퇴" };

const COOKIE = "portal_session";
const SESSION_DAYS = 400; // 브라우저가 허용하는 최대 쿠키 유지 기간
const SESSION_MS = SESSION_DAYS * 86_400_000;
const REFRESH_MS = 6 * 3_600_000;
const SYNC_MS = 3_600_000; // 한 시간마다 런치패스에서 이름·반·운영진 여부를 다시 확인
const SYNC_RETRY_MS = 5 * 60_000;

const TZ = "Asia/Seoul";
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const kstDay = (ms) => dayFmt.format(ms);
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

// ---- 입력 검사 ----
function text(value, label, { max, min = 1 } = {}) {
  const v = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (v.length < min) fail(400, `${label}을(를) 입력해 주세요.`);
  if (v.length > max) fail(400, `${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return v;
}
function optionalUrl(value, label) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  let u;
  try {
    u = new URL(v);
  } catch {
    fail(400, `${label} 주소가 올바르지 않습니다.`);
  }
  if (!["http:", "https:"].includes(u.protocol))
    fail(400, `${label} 주소는 http(s)로 시작해야 합니다.`);
  if (v.length > 500) fail(400, `${label} 주소가 너무 깁니다.`);
  return u.toString();
}
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && addDays(v, 0) === v;
const isTime = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// ---- HTTP 도우미 ----
function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function readJson(req) {
  if (req.body !== undefined && typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) fail(413, "내용이 너무 깁니다.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    fail(400, "요청 형식이 올바르지 않습니다.");
  }
}
function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

// ---- 앱 ----
export function createApp(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const secureCookie =
    options.secureCookie ?? (process.env.VERCEL ? true : process.env.COOKIE_SECURE === "true");
  const lp =
    options.lunchpass ??
    (() => {
      const config = lunchpassConfig();
      if (config.secret.length < 32)
        throw new Error("PORTAL_SECRET 환경 변수(32자 이상, 런치패스와 같은 값)를 설정해 주세요.");
      return createLunchpassClient({ ...config, now });
    })();
  const today = () => kstDay(now());

  const routes = [];
  const route = (method, pattern, opts, fn) => {
    if (typeof opts === "function") [fn, opts] = [opts, {}];
    const keys = [];
    const re = new RegExp(
      "^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$",
    );
    routes.push({ method, re, keys, fn, auth: opts.auth ?? "member" });
  };

  function sessionCookie(token, maxAgeSec) {
    return [
      `${COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSec}`,
      ...(secureCookie ? ["Secure"] : []),
    ].join("; ");
  }
  async function startSession(ctx, memberId) {
    const token = randomBytes(32).toString("base64url");
    const t = now();
    await db.run("INSERT INTO sessions (token_hash, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)", [sha256(token), memberId, t, t]);
    ctx.setCookie = sessionCookie(token, SESSION_DAYS * 86400);
  }
  const roleOf = (u) => (u.role === "admin" ? "staff" : "trainee");
  // 런치패스 계정 정보를 포털 회원으로 저장(처음이면 추가)합니다.
  async function syncMember(u) {
    const id = `lp${u.id}`;
    const t = now();
    const existing = await db.get("SELECT id, active FROM members WHERE id = ?", [id]);
    if (existing) {
      await db.run("UPDATE members SET login_id = ?, name = ?, class = ?, role = ?, synced_at = ? WHERE id = ?", [
        u.loginId, u.name, u.track, roleOf(u), t, id,
      ]);
    } else {
      await db.run(
        "INSERT INTO members (id, lunch_id, login_id, name, class, role, active, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
        [id, u.id, u.loginId, u.name, u.track, roleOf(u), t, t],
      );
    }
    return { id, active: existing ? !!existing.active : true };
  }
  async function loadMember(ctx) {
    const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (!token) return null;
    const hash = sha256(token);
    const row = await db.get(
      `SELECT s.last_seen, m.id, m.lunch_id, m.synced_at, m.name, m.class, m.role FROM sessions s
       JOIN members m ON m.id = s.member_id WHERE s.token_hash = ? AND m.active = 1`,
      [hash],
    );
    if (!row) return null;
    const t = now();
    if (t - row.last_seen > SESSION_MS) {
      await db.run("DELETE FROM sessions WHERE token_hash = ?", [hash]);
      return null;
    }
    if (t - row.last_seen > REFRESH_MS) {
      // 쓰는 동안에는 계속 연장됩니다.
      await db.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", [t, hash]);
      ctx.setCookie = sessionCookie(token, SESSION_DAYS * 86400);
    }
    let member = { id: row.id, lunchId: Number(row.lunch_id), name: row.name, class: row.class, role: row.role };
    if (t - row.synced_at > SYNC_MS) {
      try {
        const [u] = await lp.users(member.lunchId);
        if (!u) {
          // 런치패스에서 사용 중지된 계정
          await db.run("DELETE FROM sessions WHERE member_id = ?", [row.id]);
          return null;
        }
        await syncMember(u);
        member = { ...member, name: u.name, class: u.track, role: roleOf(u) };
      } catch (err) {
        // 런치패스에 잠시 연결되지 않아도 포털은 계속 씁니다. 5분 뒤 다시 확인합니다.
        console.error("런치패스 확인 실패:", err.message);
        await db.run("UPDATE members SET synced_at = ? WHERE id = ?", [t - SYNC_MS + SYNC_RETRY_MS, row.id]);
      }
    }
    ctx.tokenHash = hash;
    return member;
  }
  async function getSettings() {
    const rows = await db.all("SELECT key, value FROM settings");
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let links = [];
    try {
      links = JSON.parse(s.links || "[]");
    } catch {}
    return { lmsUrl: s.lms_url || "", lunchpassUrl: lp.url, notice: s.notice || "", links };
  }
  async function setSetting(key, value) {
    await db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
  async function lunchpassCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LunchpassError) fail(err.status, err.message);
      throw err;
    }
  }
  async function finishLogin(ctx, u) {
    const m = await syncMember(u);
    if (!m.active) fail(403, "포털 사용이 중지된 계정입니다. 운영진에게 문의해 주세요.");
    await startSession(ctx, m.id);
    return { ok: true, name: u.name };
  }

  // ---- 인증 (런치패스 학번·비밀번호) ----
  route("GET", "/api/me", { auth: "none" }, async (ctx) => {
    const settings = await getSettings();
    if (!ctx.member) return { status: 401, body: { error: "로그인이 필요합니다.", lunchpassUrl: lp.url } };
    return { member: ctx.member, settings, today: today() };
  });

  route("POST", "/api/auth/login", { auth: "none" }, async (ctx) => {
    const loginId = text(ctx.body.loginId, "학번/ID", { max: 40 });
    const password = String(ctx.body.password ?? "");
    if (!password) fail(400, "비밀번호를 입력해 주세요.");
    const u = await lunchpassCall(() => lp.login(loginId, password));
    // 처음 로그인했거나 비밀번호가 초기화된 경우: 화면에서 새 비밀번호를 정한 뒤 로그인합니다.
    if (u.mustChange) return { mustChange: true, name: u.name };
    return finishLogin(ctx, u);
  });

  route("POST", "/api/auth/first-password", { auth: "none" }, async (ctx) => {
    const loginId = text(ctx.body.loginId, "학번/ID", { max: 40 });
    const password = String(ctx.body.password ?? "");
    const newPassword = String(ctx.body.newPassword ?? "");
    if (newPassword.length < 8 || newPassword.length > 128) fail(400, "새 비밀번호는 8~128자여야 합니다.");
    const u = await lunchpassCall(() => lp.changePassword(loginId, password, newPassword));
    return finishLogin(ctx, u);
  });

  route("POST", "/api/auth/logout", { auth: "none" }, async (ctx) => {
    if (ctx.tokenHash) await db.run("DELETE FROM sessions WHERE token_hash = ?", [ctx.tokenHash]);
    ctx.setCookie = sessionCookie("", 0);
    return { ok: true };
  });

  // 점심 탭: 런치패스에 자동 로그인해서 엽니다.
  route("GET", "/api/lunchpass/go", { auth: "none" }, async (ctx) => {
    if (!ctx.member) return { redirect: "/" };
    return { redirect: lp.enterUrl(ctx.member.lunchId) };
  });

  // ---- 결석·지각·조퇴 예정 알림 ----
  const noticeRow = (r) => ({
    id: r.id,
    kind: r.kind,
    kindLabel: KINDS[r.kind],
    day: r.day,
    time: r.time,
    reason: r.reason,
    createdAt: r.created_at,
    checked: !!r.checked_at,
    ...(r.name !== undefined ? { name: r.name, class: r.class } : {}),
  });

  route("GET", "/api/notices", async (ctx) => {
    const rows = await db.all(
      "SELECT * FROM absence_notices WHERE member_id = ? AND canceled_at IS NULL AND day >= ? ORDER BY day DESC, created_at DESC",
      [ctx.member.id, addDays(today(), -30)],
    );
    return { today: today(), notices: rows.map(noticeRow) };
  });

  route("POST", "/api/notices", async (ctx) => {
    const { kind, day } = ctx.body;
    if (!KINDS[kind]) fail(400, "결석·지각·조퇴 중에서 골라 주세요.");
    if (!isDay(day)) fail(400, "날짜를 골라 주세요.");
    const t = today();
    if (day < t) fail(400, "지난 날짜는 등록할 수 없습니다.");
    if (day > addDays(t, 60)) fail(400, "60일 이내 날짜만 등록할 수 있습니다.");
    let time = null;
    if (kind !== "absent") {
      if (!isTime(ctx.body.time)) fail(400, kind === "late" ? "도착 예정 시각을 입력해 주세요." : "나갈 예정 시각을 입력해 주세요.");
      time = ctx.body.time;
    }
    const reason = text(ctx.body.reason, "사유", { max: 200 });
    const dup = await db.get(
      "SELECT id FROM absence_notices WHERE member_id = ? AND day = ? AND kind = ? AND canceled_at IS NULL",
      [ctx.member.id, day, kind],
    );
    if (dup) fail(409, "같은 날 같은 알림이 이미 있습니다. 바꾸려면 취소 후 다시 등록해 주세요.");
    const id = randomUUID();
    await db.run(
      "INSERT INTO absence_notices (id, member_id, kind, day, time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.member.id, kind, day, time, reason, now()],
    );
    return { ok: true, id };
  });

  route("POST", "/api/notices/:id/cancel", async (ctx) => {
    const r = await db.run(
      "UPDATE absence_notices SET canceled_at = ? WHERE id = ? AND member_id = ? AND canceled_at IS NULL AND day >= ?",
      [now(), ctx.params.id, ctx.member.id, today()],
    );
    if (!r.changes) fail(404, "취소할 수 있는 알림이 없습니다.");
    return { ok: true };
  });

  // ---- 외출 기록 ----
  const outingRow = (r) => ({
    id: r.id,
    day: r.day,
    startAt: r.start_at,
    endAt: r.end_at,
    reason: r.reason,
    ...(r.name !== undefined ? { name: r.name, class: r.class } : {}),
  });

  route("GET", "/api/outings", async (ctx) => {
    const rows = await db.all(
      "SELECT * FROM outings WHERE member_id = ? AND day >= ? ORDER BY start_at DESC",
      [ctx.member.id, addDays(today(), -14)],
    );
    const current = rows.find((r) => r.day === today() && r.end_at == null);
    return { today: today(), current: current ? outingRow(current) : null, outings: rows.map(outingRow) };
  });

  route("POST", "/api/outings/start", async (ctx) => {
    const reason = text(ctx.body.reason, "외출 사유", { max: 100, min: 0 });
    const open = await db.get("SELECT id FROM outings WHERE member_id = ? AND day = ? AND end_at IS NULL", [ctx.member.id, today()]);
    if (open) fail(409, "이미 외출 중입니다. 먼저 복귀를 눌러 주세요.");
    const id = randomUUID();
    try {
      await db.run(
        "INSERT INTO outings (id, member_id, day, start_at, end_at, reason) VALUES (?, ?, ?, ?, NULL, ?)",
        [id, ctx.member.id, today(), now(), reason],
      );
    } catch {
      fail(409, "이미 외출 중입니다. 먼저 복귀를 눌러 주세요.");
    }
    return { ok: true, id };
  });

  route("POST", "/api/outings/end", async (ctx) => {
    const r = await db.run(
      "UPDATE outings SET end_at = ? WHERE member_id = ? AND day = ? AND end_at IS NULL",
      [now(), ctx.member.id, today()],
    );
    if (!r.changes) fail(409, "외출 중이 아닙니다.");
    return { ok: true };
  });

  // ---- 문의게시판 ----
  route("GET", "/api/posts", async (ctx) => {
    const staff = ctx.member.role === "staff";
    const rows = await db.all(
      `SELECT p.id, p.title, p.private, p.created_at, p.member_id, m.name, m.class,
        (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS reply_count,
        (SELECT COUNT(*) FROM replies r JOIN members rm ON rm.id = r.member_id
          WHERE r.post_id = p.id AND rm.role = 'staff') AS staff_replies
       FROM posts p JOIN members m ON m.id = p.member_id
       WHERE p.deleted_at IS NULL AND (p.private = 0 OR p.member_id = ? OR ? = 1)
       ORDER BY p.created_at DESC LIMIT 200`,
      [ctx.member.id, staff ? 1 : 0],
    );
    return {
      posts: rows.map((r) => ({
        id: r.id,
        title: r.title,
        private: !!r.private,
        createdAt: r.created_at,
        author: r.name,
        class: r.class,
        mine: r.member_id === ctx.member.id,
        replyCount: Number(r.reply_count),
        answered: Number(r.staff_replies) > 0,
      })),
    };
  });

  async function visiblePost(ctx) {
    const p = await db.get(
      `SELECT p.*, m.name, m.class FROM posts p JOIN members m ON m.id = p.member_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [ctx.params.id],
    );
    if (!p || (p.private && p.member_id !== ctx.member.id && ctx.member.role !== "staff"))
      fail(404, "글을 찾을 수 없습니다.");
    return p;
  }

  route("GET", "/api/posts/:id", async (ctx) => {
    const p = await visiblePost(ctx);
    const replies = await db.all(
      `SELECT r.id, r.body, r.created_at, m.name, m.role FROM replies r
       JOIN members m ON m.id = r.member_id WHERE r.post_id = ? ORDER BY r.created_at`,
      [p.id],
    );
    const mine = p.member_id === ctx.member.id;
    return {
      post: {
        id: p.id,
        title: p.title,
        body: p.body,
        private: !!p.private,
        createdAt: p.created_at,
        author: p.name,
        class: p.class,
        mine,
        canReply: mine || ctx.member.role === "staff",
        canDelete: mine || ctx.member.role === "staff",
      },
      replies: replies.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: r.name, staff: r.role === "staff" })),
    };
  });

  route("POST", "/api/posts", async (ctx) => {
    const title = text(ctx.body.title, "제목", { max: 80 });
    const body = text(ctx.body.body, "내용", { max: 2000 });
    const id = randomUUID();
    await db.run(
      "INSERT INTO posts (id, member_id, title, body, private, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, ctx.member.id, title, body, ctx.body.private ? 1 : 0, now()],
    );
    return { ok: true, id };
  });

  route("POST", "/api/posts/:id/replies", async (ctx) => {
    const p = await visiblePost(ctx);
    if (p.member_id !== ctx.member.id && ctx.member.role !== "staff")
      fail(403, "답변은 운영진과 글쓴이만 달 수 있습니다.");
    const body = text(ctx.body.body, "답변", { max: 1000 });
    await db.run("INSERT INTO replies (id, post_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?)", [
      randomUUID(),
      p.id,
      ctx.member.id,
      body,
      now(),
    ]);
    return { ok: true };
  });

  route("POST", "/api/posts/:id/delete", async (ctx) => {
    const p = await visiblePost(ctx);
    if (p.member_id !== ctx.member.id && ctx.member.role !== "staff") fail(403, "본인 글만 지울 수 있습니다.");
    await db.run("UPDATE posts SET deleted_at = ? WHERE id = ?", [now(), p.id]);
    return { ok: true };
  });

  // ---- 운영진 ----
  route("GET", "/api/admin/day", { auth: "staff" }, async (ctx) => {
    const day = isDay(ctx.query.get("date")) ? ctx.query.get("date") : today();
    const notices = await db.all(
      `SELECT n.*, m.name, m.class FROM absence_notices n JOIN members m ON m.id = n.member_id
       WHERE n.day = ? AND n.canceled_at IS NULL ORDER BY m.class, n.kind, m.name`,
      [day],
    );
    const upcoming = await db.all(
      `SELECT n.*, m.name, m.class FROM absence_notices n JOIN members m ON m.id = n.member_id
       WHERE n.day > ? AND n.day <= ? AND n.canceled_at IS NULL ORDER BY n.day, m.class, m.name`,
      [day, addDays(day, 7)],
    );
    const outings = await db.all(
      `SELECT o.*, m.name, m.class FROM outings o JOIN members m ON m.id = o.member_id
       WHERE o.day = ? ORDER BY o.start_at`,
      [day],
    );
    // 재적: 런치패스에 등록된 훈련생 수(반별). 연결이 안 되면 포털에 로그인한 사람 수로 대신합니다.
    let roster = {};
    try {
      for (const u of await lp.users()) if (u.role !== "admin" && u.track !== "OTHER") roster[u.track] = (roster[u.track] || 0) + 1;
    } catch {
      const rows = await db.all("SELECT class, COUNT(*) AS n FROM members WHERE active = 1 AND role = 'trainee' GROUP BY class");
      roster = Object.fromEntries(rows.map((r) => [r.class, Number(r.n)]));
    }
    return {
      day,
      today: today(),
      roster,
      notices: notices.map(noticeRow),
      upcoming: upcoming.map(noticeRow),
      outings: outings.map(outingRow),
    };
  });

  route("POST", "/api/admin/notices/:id/check", { auth: "staff" }, async (ctx) => {
    const checked = ctx.body.checked !== false;
    const r = await db.run("UPDATE absence_notices SET checked_at = ?, checked_by = ? WHERE id = ?", [
      checked ? now() : null,
      checked ? ctx.member.id : null,
      ctx.params.id,
    ]);
    if (!r.changes) fail(404, "알림을 찾을 수 없습니다.");
    return { ok: true };
  });

  // 명단은 런치패스에서 등록합니다. 여기서는 런치패스 명단과 포털 사용 현황을 함께 보여 줍니다.
  route("GET", "/api/admin/members", { auth: "staff" }, async () => {
    const portalRows = await db.all(
      `SELECT m.id, m.lunch_id, m.active,
        (SELECT COUNT(*) FROM sessions s WHERE s.member_id = m.id) AS devices,
        (SELECT MAX(s.last_seen) FROM sessions s WHERE s.member_id = m.id) AS last_seen
       FROM members m`,
    );
    const byLunchId = new Map(portalRows.map((r) => [Number(r.lunch_id), r]));
    let users = [];
    let lunchpassOk = true;
    try {
      users = await lp.users();
    } catch (err) {
      lunchpassOk = false;
      console.error("런치패스 명단 조회 실패:", err.message);
      users = (await db.all("SELECT lunch_id, login_id, name, class, role FROM members")).map((m) => ({
        id: Number(m.lunch_id), loginId: m.login_id, name: m.name, track: m.class, role: m.role === "staff" ? "admin" : "member", mustChange: false,
      }));
    }
    return {
      lunchpassOk,
      members: users.map((u) => {
        const p = byLunchId.get(u.id);
        return {
          id: p ? p.id : null,
          name: u.name,
          loginId: u.loginId,
          class: u.track,
          role: roleOf(u),
          firstLoginPending: !!u.mustChange,
          joined: !!p,
          active: p ? !!p.active : true,
          devices: p ? Number(p.devices) : 0,
          lastSeen: p && p.last_seen != null ? Number(p.last_seen) : null,
        };
      }),
    };
  });

  // 포털 사용만 중지/재개합니다(런치패스 계정은 그대로).
  route("POST", "/api/admin/members/:id/update", { auth: "staff" }, async (ctx) => {
    const m = await db.get("SELECT id FROM members WHERE id = ?", [ctx.params.id]);
    if (!m) fail(404, "포털에 로그인한 적이 없는 사람입니다.");
    if (m.id === ctx.member.id) fail(400, "내 계정은 중지할 수 없습니다.");
    const active = ctx.body.active ? 1 : 0;
    await db.run("UPDATE members SET active = ? WHERE id = ?", [active, m.id]);
    if (!active) await db.run("DELETE FROM sessions WHERE member_id = ?", [m.id]);
    return { ok: true };
  });

  route("POST", "/api/admin/settings", { auth: "staff" }, async (ctx) => {
    const b = ctx.body;
    if (b.lmsUrl !== undefined) await setSetting("lms_url", optionalUrl(b.lmsUrl, "LMS"));
    if (b.notice !== undefined) await setSetting("notice", text(b.notice, "공지", { max: 300, min: 0 }));
    if (b.links !== undefined) {
      if (!Array.isArray(b.links) || b.links.length > 8) fail(400, "바로가기는 8개까지 넣을 수 있습니다.");
      const links = b.links.map((l) => ({
        label: text(l?.label, "바로가기 이름", { max: 20 }),
        url: optionalUrl(l?.url, "바로가기") || fail(400, "바로가기 주소를 입력해 주세요."),
      }));
      await setSetting("links", JSON.stringify(links));
    }
    return { ok: true, settings: await getSettings() };
  });

  // ---- 요청 처리 ----
  return async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    let path = url.pathname;
    const vercelRoute = url.searchParams.get("route");
    if (path === "/api/index" && vercelRoute) path = `/${vercelRoute.replace(/^\/+/, "")}`;
    const ctx = { req, query: url.searchParams, params: {}, body: {}, member: null };
    const send = (status, body) => {
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (ctx.setCookie) headers["Set-Cookie"] = ctx.setCookie;
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    try {
      const candidates = routes.filter((r) => r.re.test(path));
      const match = candidates.find((r) => r.method === req.method);
      if (!match) return send(candidates.length ? 405 : 404, { error: "없는 주소입니다." });
      match.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(path.match(match.re)[i + 1])));
      if (req.method === "POST") {
        // 다른 사이트에서 보내는 요청(CSRF)을 막습니다.
        const origin = req.headers.origin;
        if (origin && originHost(origin) !== req.headers.host) fail(403, "허용되지 않은 요청입니다.");
        if (!String(req.headers["content-type"] || "").includes("application/json")) fail(415, "요청 형식이 올바르지 않습니다.");
        ctx.body = await readJson(req);
      }
      ctx.member = await loadMember(ctx);
      if (match.auth !== "none" && !ctx.member) fail(401, "인증이 필요합니다.");
      if (match.auth === "staff" && ctx.member.role !== "staff") fail(403, "운영진만 볼 수 있습니다.");
      const result = await match.fn(ctx);
      if (result && result.redirect) {
        const headers = { Location: result.redirect, "Cache-Control": "no-store" };
        if (ctx.setCookie) headers["Set-Cookie"] = ctx.setCookie;
        res.writeHead(302, headers);
        return res.end();
      }
      if (result && result.status) return send(result.status, result.body);
      return send(200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      console.error(err);
      return send(500, { error: "일시적인 오류입니다. 잠시 뒤 다시 시도해 주세요." });
    }
  };
}
