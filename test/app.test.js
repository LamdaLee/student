import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { openDb } from "../lib/db.js";
import { createApp, kstDay } from "../lib/app.js";
import { createLunchpassClient, LunchpassError, verifyRequest, verifyToken } from "../lib/lunchpass.js";

// 한국 시간 2026-11-09(월) 10:00
const T0 = Date.parse("2026-11-09T01:00:00Z");
const PW = "pw-123456789";

// 런치패스 서버 대신 쓰는 가짜(계정 저장소). 실제 서명·HTTP 는 아래 별도 테스트에서 확인합니다.
function fakeLunchpass() {
  const byLogin = new Map();
  let nextId = 1;
  const state = { down: false };
  const pub = (u) => ({ id: u.id, name: u.name, loginId: u.loginId, track: u.track, role: u.role, mustChange: u.mustChange });
  const check = () => {
    if (state.down) throw new LunchpassError(502, "런치패스에 연결하지 못했습니다.");
  };
  const auth = (loginId, password) => {
    const u = byLogin.get(loginId);
    if (!u || !u.active || u.password !== password) throw new LunchpassError(401, "학번/ID 또는 비밀번호를 확인해주세요.");
    return u;
  };
  return {
    state,
    url: "https://lunch.example.com",
    add(name, loginId, track, { role = "member", password = PW, mustChange = false } = {}) {
      const u = { id: nextId++, name, loginId, track, role, password, mustChange, active: true };
      byLogin.set(loginId, u);
      return u;
    },
    get: (loginId) => byLogin.get(loginId),
    async login(loginId, password) {
      check();
      return pub(auth(loginId, password));
    },
    async changePassword(loginId, password, newPassword) {
      check();
      const u = auth(loginId, password);
      u.password = newPassword;
      u.mustChange = false;
      return pub(u);
    },
    async users(id) {
      check();
      return [...byLogin.values()].filter((u) => u.active && (id == null || u.id === id)).map(pub);
    },
    enterUrl: (id) => `https://lunch.example.com/api/portal/enter?token=for-${id}`,
  };
}

async function setup(kind) {
  let db;
  let schema;
  let admin;
  if (kind === "postgres") {
    const { default: pg } = await import("pg");
    admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    schema = `t_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = await openDb({ url: process.env.TEST_DATABASE_URL, schema });
  } else {
    db = await openDb({ url: "", file: ":memory:" });
  }
  const clock = { t: T0 };
  const lp = fakeLunchpass();
  const app = createApp(db, { now: () => clock.t, lunchpass: lp, secureCookie: false });
  const call = async (method, path, body, { cookie, ip = "1.1.1.1", headers = {} } = {}) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(payload);
    Object.assign(req, {
      method,
      url: path,
      headers: {
        host: "portal.test",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        "x-forwarded-for": ip,
        ...headers,
      },
      socket: { remoteAddress: ip },
    });
    const res = { status: 0, headers: {}, body: "" };
    await app(req, {
      writeHead(s, h) {
        res.status = s;
        res.headers = h;
      },
      end(d) {
        res.body = d;
      },
    });
    const setCookie = res.headers["Set-Cookie"];
    return {
      status: res.status,
      json: res.body ? JSON.parse(res.body) : null,
      location: res.headers.Location,
      cookie: setCookie ? setCookie.split(";")[0] : undefined,
      setCookie,
    };
  };
  const login = async (loginId, password = PW) => {
    const r = await call("POST", "/api/auth/login", { loginId, password });
    if (r.status !== 200 || !r.cookie) throw new Error(JSON.stringify(r));
    return r.cookie;
  };
  const cleanup = async () => {
    await db.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  };
  return { db, call, clock, lp, login, cleanup };
}

for (const kind of ["sqlite", "postgres"]) {
  describe(kind, { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL 없음" }, () => {
    let t, staff, dm, ax;
    before(async () => {
      t = await setup(kind);
      t.lp.add("김운영", "admin", "OTHER", { role: "admin" });
      t.lp.add("홍길동", "dm001", "DM");
      t.lp.add("김철수", "ax001", "AX");
      t.lp.add("새학생", "dm002", "DM", { password: "1234", mustChange: true });
      t.lp.add("SF학생", "sf001", "SF");
    });
    after(async () => t?.cleanup());

    test("로그인 전에는 아무것도 볼 수 없다", async () => {
      const r = await t.call("GET", "/api/me");
      assert.equal(r.status, 401);
      assert.equal(r.json.lunchpassUrl, "https://lunch.example.com");
      assert.equal((await t.call("GET", "/api/notices")).status, 401);
    });

    test("런치패스 학번·비밀번호로 로그인하면 쿠키로 계속 쓴다", async () => {
      const bad = await t.call("POST", "/api/auth/login", { loginId: "dm001", password: "wrong" });
      assert.equal(bad.status, 401);
      assert.equal(bad.json.error, "학번/ID 또는 비밀번호를 확인해주세요.");
      assert.equal(bad.cookie, undefined);

      const r = await t.call("POST", "/api/auth/login", { loginId: "dm001", password: PW });
      assert.equal(r.status, 200);
      assert.match(r.setCookie, /HttpOnly/);
      assert.match(r.setCookie, /Max-Age=34560000/);
      dm = r.cookie;
      ax = await t.login("ax001");
      staff = await t.login("admin");
      const me = await t.call("GET", "/api/me", undefined, { cookie: dm });
      assert.equal(me.json.member.name, "홍길동");
      assert.equal(me.json.member.class, "DM");
      assert.equal(me.json.member.role, "trainee");
      assert.equal(me.json.today, "2026-11-09");
      // 런치패스 운영진은 포털 운영진
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: staff })).json.member.role, "staff");
      assert.equal((await t.call("GET", "/api/admin/day", undefined, { cookie: dm })).status, 403);

      // 오래 지나도 쓰는 동안 연장된다.
      t.clock.t += 200 * 86400000;
      const later = await t.call("GET", "/api/me", undefined, { cookie: dm });
      assert.equal(later.status, 200);
      assert.match(later.setCookie, /Max-Age=34560000/);
      t.clock.t = T0;
    });

    test("첫 로그인은 포털에서 새 비밀번호를 정하고 런치패스에도 적용된다", async () => {
      const first = await t.call("POST", "/api/auth/login", { loginId: "dm002", password: "1234" });
      assert.equal(first.status, 200);
      assert.equal(first.json.mustChange, true);
      assert.equal(first.cookie, undefined);
      assert.equal((await t.call("POST", "/api/auth/first-password", { loginId: "dm002", password: "1234", newPassword: "short" })).status, 400);
      assert.equal((await t.call("POST", "/api/auth/first-password", { loginId: "dm002", password: "0000", newPassword: "new-password-1" })).status, 401);
      const r = await t.call("POST", "/api/auth/first-password", { loginId: "dm002", password: "1234", newPassword: "new-password-1" });
      assert.equal(r.status, 200);
      assert.ok(r.cookie);
      assert.equal(t.lp.get("dm002").password, "new-password-1");
      assert.equal(t.lp.get("dm002").mustChange, false);
    });

    test("런치패스에 연결이 안 되면 로그인은 안내만 하고, 이미 로그인한 기기는 계속 쓴다", async () => {
      t.lp.state.down = true;
      const r = await t.call("POST", "/api/auth/login", { loginId: "dm001", password: PW });
      assert.equal(r.status, 502);
      t.clock.t += 2 * 3600000; // 확인 주기가 지나도
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: dm })).status, 200);
      t.lp.state.down = false;
      t.clock.t = T0;
    });

    test("한 시간마다 런치패스의 이름·반·운영진 여부를 따라간다", async () => {
      t.lp.get("ax001").name = "김철수2";
      t.lp.get("ax001").role = "admin";
      t.clock.t += 2 * 3600000;
      let me = await t.call("GET", "/api/me", undefined, { cookie: ax });
      assert.equal(me.json.member.name, "김철수2");
      assert.equal(me.json.member.role, "staff");
      t.lp.get("ax001").name = "김철수";
      t.lp.get("ax001").role = "member";
      t.clock.t += 2 * 3600000;
      me = await t.call("GET", "/api/me", undefined, { cookie: ax });
      assert.equal(me.json.member.role, "trainee");
      t.clock.t = T0;
    });

    test("점심 탭은 런치패스 자동 로그인 주소로 보낸다", async () => {
      const r = await t.call("GET", "/api/lunchpass/go", undefined, { cookie: dm });
      assert.equal(r.status, 302);
      assert.equal(r.location, `https://lunch.example.com/api/portal/enter?token=for-${t.lp.get("dm001").id}`);
      // 로그인 전이면 포털 첫 화면으로
      assert.equal((await t.call("GET", "/api/lunchpass/go")).location, "/");
      assert.equal((await t.call("GET", "/api/lunch", undefined, { cookie: dm })).status, 404);
    });

    test("다른 사이트에서 온 요청과 JSON 이 아닌 요청은 거절한다", async () => {
      const r = await t.call("POST", "/api/outings/start", {}, { cookie: dm, headers: { origin: "https://evil.example" } });
      assert.equal(r.status, 403);
      const r2 = await t.call("POST", "/api/outings/start", {}, { cookie: dm, headers: { "content-type": "text/plain" } });
      assert.equal(r2.status, 415);
    });

    test("결석·지각·조퇴 예정 알림", async () => {
      const late = await t.call("POST", "/api/notices", { kind: "late", day: "2026-11-09", time: "09:40", reason: "병원" }, { cookie: dm });
      assert.equal(late.status, 200);
      assert.equal((await t.call("POST", "/api/notices", { kind: "late", day: "2026-11-09", time: "09:50", reason: "x" }, { cookie: dm })).status, 409);
      assert.equal((await t.call("POST", "/api/notices", { kind: "late", day: "2026-11-10", reason: "x" }, { cookie: dm })).status, 400);
      assert.equal((await t.call("POST", "/api/notices", { kind: "absent", day: "2026-11-08", reason: "x" }, { cookie: dm })).status, 400);
      assert.equal((await t.call("POST", "/api/notices", { kind: "absent", day: "2026-02-30", reason: "x" }, { cookie: dm })).status, 400);
      const absent = await t.call("POST", "/api/notices", { kind: "absent", day: "2026-11-12", reason: "면접" }, { cookie: ax });
      assert.equal(absent.status, 200);

      const mine = await t.call("GET", "/api/notices", undefined, { cookie: dm });
      assert.equal(mine.json.notices.length, 1);
      assert.equal(mine.json.notices[0].kindLabel, "지각");

      const day = await t.call("GET", "/api/admin/day?date=2026-11-09", undefined, { cookie: staff });
      assert.equal(day.json.notices.length, 1);
      assert.equal(day.json.notices[0].name, "홍길동");
      assert.equal(day.json.upcoming.length, 1);
      assert.equal(day.json.upcoming[0].name, "김철수");

      // 운영진 확인 표시
      assert.equal((await t.call("POST", `/api/admin/notices/${late.json.id}/check`, {}, { cookie: staff })).status, 200);
      assert.equal((await t.call("GET", "/api/notices", undefined, { cookie: dm })).json.notices[0].checked, true);

      // 남의 알림은 취소 못 하고, 지난 날은 취소 못 한다.
      assert.equal((await t.call("POST", `/api/notices/${absent.json.id}/cancel`, {}, { cookie: dm })).status, 404);
      t.clock.t += 86400000;
      assert.equal((await t.call("POST", `/api/notices/${late.json.id}/cancel`, {}, { cookie: dm })).status, 404);
      t.clock.t = T0;
      assert.equal((await t.call("POST", `/api/notices/${absent.json.id}/cancel`, {}, { cookie: ax })).status, 200);
      assert.equal((await t.call("GET", "/api/notices", undefined, { cookie: ax })).json.notices.length, 0);
    });

    test("외출과 복귀", async () => {
      assert.equal((await t.call("POST", "/api/outings/end", {}, { cookie: dm })).status, 409);
      assert.equal((await t.call("POST", "/api/outings/start", { reason: "은행" }, { cookie: dm })).status, 200);
      assert.equal((await t.call("POST", "/api/outings/start", {}, { cookie: dm })).status, 409);
      let r = await t.call("GET", "/api/outings", undefined, { cookie: dm });
      assert.equal(r.json.current.reason, "은행");
      let day = await t.call("GET", "/api/admin/day", undefined, { cookie: staff });
      assert.equal(day.json.outings.length, 1);
      assert.equal(day.json.outings[0].endAt, null);
      t.clock.t += 30 * 60000;
      assert.equal((await t.call("POST", "/api/outings/end", {}, { cookie: dm })).status, 200);
      r = await t.call("GET", "/api/outings", undefined, { cookie: dm });
      assert.equal(r.json.current, null);
      assert.equal(r.json.outings[0].endAt - r.json.outings[0].startAt, 30 * 60000);
      // 하루에 여러 번 나갈 수 있다.
      assert.equal((await t.call("POST", "/api/outings/start", {}, { cookie: dm })).status, 200);
      // 다음 날에는 전날 복귀를 안 눌렀어도 새로 외출할 수 있다.
      t.clock.t = T0 + 86400000;
      assert.equal((await t.call("GET", "/api/outings", undefined, { cookie: dm })).json.current, null);
      assert.equal((await t.call("POST", "/api/outings/start", {}, { cookie: dm })).status, 200);
      t.clock.t = T0;
    });

    test("문의게시판: 공개·비공개, 답변, 삭제", async () => {
      const pub = await t.call("POST", "/api/posts", { title: "수료 기준?", body: "궁금합니다" }, { cookie: dm });
      const priv = await t.call("POST", "/api/posts", { title: "개인 사정", body: "비밀", private: true }, { cookie: dm });
      assert.equal(pub.status, 200);
      // 다른 훈련생에게 비공개 글은 안 보인다.
      let list = await t.call("GET", "/api/posts", undefined, { cookie: ax });
      assert.deepEqual(list.json.posts.map((p) => p.title), ["수료 기준?"]);
      assert.equal((await t.call("GET", `/api/posts/${priv.json.id}`, undefined, { cookie: ax })).status, 404);
      // 운영진은 모두 본다.
      list = await t.call("GET", "/api/posts", undefined, { cookie: staff });
      assert.equal(list.json.posts.length, 2);
      // 다른 훈련생은 답변을 못 단다.
      assert.equal((await t.call("POST", `/api/posts/${pub.json.id}/replies`, { body: "저도요" }, { cookie: ax })).status, 403);
      assert.equal((await t.call("POST", `/api/posts/${pub.json.id}/replies`, { body: "80% 출석입니다" }, { cookie: staff })).status, 200);
      const detail = await t.call("GET", `/api/posts/${pub.json.id}`, undefined, { cookie: ax });
      assert.equal(detail.json.replies[0].staff, true);
      list = await t.call("GET", "/api/posts", undefined, { cookie: dm });
      assert.equal(list.json.posts.find((p) => p.id === pub.json.id).answered, true);
      // 남의 글은 못 지운다.
      assert.equal((await t.call("POST", `/api/posts/${pub.json.id}/delete`, {}, { cookie: ax })).status, 403);
      assert.equal((await t.call("POST", `/api/posts/${priv.json.id}/delete`, {}, { cookie: dm })).status, 200);
      assert.equal((await t.call("GET", "/api/posts", undefined, { cookie: dm })).json.posts.length, 1);
    });

    test("명단: 런치패스 명단과 포털 사용 현황, 포털 사용 중지", async () => {
      const r = await t.call("GET", "/api/admin/members", undefined, { cookie: staff });
      assert.equal(r.status, 200);
      assert.equal(r.json.lunchpassOk, true);
      const byLogin = Object.fromEntries(r.json.members.map((m) => [m.loginId, m]));
      assert.equal(byLogin.dm001.joined, true);
      assert.equal(byLogin.sf001.joined, false); // 런치패스에는 있지만 포털에는 아직
      assert.equal(byLogin.sf001.id, null);
      assert.equal(byLogin.admin.role, "staff");
      // 훈련생은 볼 수 없다
      assert.equal((await t.call("GET", "/api/admin/members", undefined, { cookie: dm })).status, 403);
      // 명단 등록·코드 발급은 포털에 없다
      assert.equal((await t.call("POST", "/api/admin/members", { entries: [] }, { cookie: staff })).status, 405);

      // 포털 사용 중지: 기존 로그인이 끝나고 다시 로그인도 안 된다
      assert.equal((await t.call("POST", `/api/admin/members/${byLogin.ax001.id}/update`, { active: false }, { cookie: staff })).status, 200);
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: ax })).status, 401);
      assert.equal((await t.call("POST", "/api/auth/login", { loginId: "ax001", password: PW })).status, 403);
      assert.equal((await t.call("POST", `/api/admin/members/${byLogin.ax001.id}/update`, { active: true }, { cookie: staff })).status, 200);
      ax = await t.login("ax001");
      // 나 자신은 중지할 수 없다
      assert.equal((await t.call("POST", `/api/admin/members/${byLogin.admin.id}/update`, { active: false }, { cookie: staff })).status, 400);
      // 재적은 런치패스 훈련생 수(운영진·OTHER 제외)
      const day = await t.call("GET", "/api/admin/day", undefined, { cookie: staff });
      assert.deepEqual(day.json.roster, { DM: 2, AX: 1, SF: 1 });
    });

    test("런치패스에서 사용 중지된 계정은 다음 확인 때 로그아웃된다", async () => {
      const temp = await t.login("sf001");
      t.lp.get("sf001").active = false;
      t.clock.t += 2 * 3600000;
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: temp })).status, 401);
      t.clock.t = T0;
    });

    test("설정: LMS 주소·공지·바로가기", async () => {
      assert.equal((await t.call("POST", "/api/admin/settings", { lmsUrl: "ftp://x" }, { cookie: staff })).status, 400);
      assert.equal((await t.call("POST", "/api/admin/settings", { lmsUrl: "https://lms.example.com" }, { cookie: dm })).status, 403);
      const r = await t.call(
        "POST",
        "/api/admin/settings",
        { lmsUrl: "https://lms.example.com/login", notice: "11/9 첫 수업은 9시까지!", links: [{ label: "시간표", url: "https://example.com/t" }] },
        { cookie: staff },
      );
      assert.equal(r.status, 200);
      const me = await t.call("GET", "/api/me", undefined, { cookie: dm });
      assert.equal(me.json.settings.lmsUrl, "https://lms.example.com/login");
      assert.equal(me.json.settings.notice, "11/9 첫 수업은 9시까지!");
      assert.equal(me.json.settings.links[0].label, "시간표");
    });

    test("로그아웃하면 이 기기 쿠키만 끝난다", async () => {
      const r = await t.call("POST", "/api/auth/logout", {}, { cookie: dm });
      assert.match(r.setCookie, /Max-Age=0/);
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: dm })).status, 401);
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: staff })).status, 200);
    });
  });
}

test("한국 시간 날짜", () => {
  assert.equal(kstDay(Date.parse("2026-11-08T15:00:00Z")), "2026-11-09");
  assert.equal(kstDay(Date.parse("2026-11-08T14:59:59Z")), "2026-11-08");
});

test("런치패스 클라이언트는 요청에 서명하고 자동 로그인 토큰을 만든다", async () => {
  const secret = "s".repeat(40);
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push({ path: u.pathname + u.search, init });
    const ok = verifyRequest(secret, init.method, u.pathname + u.search, init.headers, 1000, init.body || "");
    if (!ok) return new Response(JSON.stringify({ error: "서명 오류" }), { status: 401 });
    if (u.pathname === "/api/portal/login") return new Response(JSON.stringify({ user: { id: 7, name: "가", loginId: "x", track: "DM", role: "member", mustChange: false } }));
    return new Response(JSON.stringify({ users: [] }));
  };
  const client = createLunchpassClient({ url: "https://lunch.example.com", secret, fetchImpl, now: () => 1000 });
  assert.equal((await client.login("x", "pw")).id, 7);
  assert.deepEqual(await client.users(7), []);
  assert.equal(seen[1].path, "/api/portal/users?id=7");
  // 비밀값이 다르면 런치패스가 거절하고, 포털은 안내 문구를 그대로 전달
  const wrong = createLunchpassClient({ url: "https://lunch.example.com", secret: "t".repeat(40), fetchImpl, now: () => 1000 });
  await assert.rejects(wrong.login("x", "pw"), (e) => e instanceof LunchpassError && e.status === 401);
  // 연결 실패는 502
  const offline = createLunchpassClient({ url: "https://lunch.example.com", secret, fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(offline.users(), (e) => e.status === 502);
  // 자동 로그인 토큰
  const url = new URL(client.enterUrl(7));
  assert.equal(url.origin + url.pathname, "https://lunch.example.com/api/portal/enter");
  const payload = verifyToken(secret, "enter", url.searchParams.get("token"), 1000);
  assert.equal(payload.sub, 7);
  assert.equal(payload.exp, 1000 + 120000);
  assert.ok(payload.jti);
});

test("PORTAL_SECRET 이 없으면 시작하지 않는다", async () => {
  const db = await openDb({ url: "", file: ":memory:" });
  const prev = process.env.PORTAL_SECRET;
  delete process.env.PORTAL_SECRET;
  assert.throws(() => createApp(db), /PORTAL_SECRET/);
  if (prev !== undefined) process.env.PORTAL_SECRET = prev;
  await db.close();
});

test("Vercel 경로(route 쿼리)로도 동작한다", async () => {
  const db = await openDb({ url: "", file: ":memory:" });
  const app = createApp(db, { lunchpass: fakeLunchpass() });
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url: "/api/index?route=api/me", headers: { host: "x" }, socket: {} });
  let status;
  await app(req, { writeHead: (s) => (status = s), end() {} });
  assert.equal(status, 401);
  await db.close();
});

test("PostgreSQL 에서는 테이블 이름 앞에 포털 스키마를 붙인다", async () => {
  const { qualify, schemaName } = await import("../lib/db.js");
  assert.equal(
    qualify("SELECT s.last_seen FROM sessions s JOIN members m ON m.id = s.member_id", "portal"),
    'SELECT s.last_seen FROM "portal".sessions s JOIN "portal".members m ON m.id = s.member_id',
  );
  assert.equal(
    qualify("CREATE INDEX IF NOT EXISTS sessions_member ON sessions (member_id)", "portal"),
    'CREATE INDEX IF NOT EXISTS sessions_member ON "portal".sessions (member_id)',
  );
  assert.equal(
    qualify("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", "p"),
    'INSERT INTO "p".settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  assert.equal(schemaName(undefined), process.env.PORTAL_DB_SCHEMA || "portal");
  assert.throws(() => schemaName("public"), /겹칩니다/);
  assert.throws(() => schemaName("a;drop"), /PORTAL_DB_SCHEMA/);
});

test("런치패스와 같은 DB 를 써도 포털 테이블은 따로 둔다", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL 없음" }, async () => {
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const suffix = randomBytes(5).toString("hex");
  const lpSchema = `lp_${suffix}`; // 런치패스 테이블이 있는 곳(운영에서는 public)
  const portalSchema = `portal_${suffix}`;
  await admin.query(`CREATE SCHEMA ${lpSchema}`);
  await admin.query(`CREATE TABLE ${lpSchema}.sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires BIGINT NOT NULL)`);
  await admin.query(`CREATE TABLE ${lpSchema}.posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT)`);
  await admin.query(`INSERT INTO ${lpSchema}.sessions VALUES ('lp-session', 1, 1)`);
  // 기본 경로가 런치패스 쪽을 가리켜도(접속 옵션) 포털은 자기 스키마만 쓴다.
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${lpSchema}`);
  const db = await openDb({ url: url.toString(), schema: portalSchema });
  try {
    const lp = fakeLunchpass();
    lp.add("홍길동", "dm001", "DM");
    const app = createApp(db, { now: () => T0, lunchpass: lp, secureCookie: false });
    const call = async (method, path, body, cookie) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url: path, headers: { host: "x", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, socket: {} });
      const res = {};
      await app(req, { writeHead: (s, h) => Object.assign(res, { s, h }), end: (d) => (res.d = d) });
      return { status: res.s, cookie: res.h?.["Set-Cookie"]?.split(";")[0] };
    };
    const login = await call("POST", "/api/auth/login", { loginId: "dm001", password: PW });
    assert.equal(login.status, 200);
    assert.equal((await call("POST", "/api/posts", { title: "질문", body: "내용" }, login.cookie)).status, 200);
    const count = async (schema, table) => Number((await admin.query(`SELECT COUNT(*) n FROM ${schema}.${table}`)).rows[0].n);
    assert.equal(await count(portalSchema, "sessions"), 1);
    assert.equal(await count(portalSchema, "posts"), 1);
    assert.equal(await count(lpSchema, "sessions"), 1); // 런치패스 쪽은 그대로
    assert.equal(await count(lpSchema, "posts"), 0);
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${lpSchema} CASCADE`);
    await admin.query(`DROP SCHEMA ${portalSchema} CASCADE`);
    await admin.end();
  }
});

test("운영진 휴대폰 알림: 출결 알림·취소, 새 문의·댓글", async () => {
  const db = await openDb({ url: "", file: ":memory:" });
  const lp = fakeLunchpass();
  lp.add("김운영", "admin", "OTHER", { role: "admin" });
  lp.add("박운영", "admin2", "OTHER", { role: "admin" });
  lp.add("홍길동", "dm001", "DM");
  const sent = [];
  const push = {
    publicKey: "test-public-key",
    async send(sub, payload) {
      if (sub.endpoint.endsWith("/gone")) return { gone: true };
      sent.push({ endpoint: sub.endpoint, ...payload });
      return { ok: true };
    },
  };
  const app = createApp(db, { now: () => T0, lunchpass: lp, push, secureCookie: false });
  const call = async (method, path, body, cookie) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: "x", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, socket: {} });
    const res = {};
    await app(req, { writeHead: (s, h) => Object.assign(res, { s, h }), end: (d) => (res.d = d) });
    return { status: res.s, json: res.d ? JSON.parse(res.d) : null, cookie: res.h?.["Set-Cookie"]?.split(";")[0] };
  };
  const login = async (id) => (await call("POST", "/api/auth/login", { loginId: id, password: PW })).cookie;
  const staff = await login("admin");
  const staff2 = await login("admin2");
  const dm = await login("dm001");
  const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: "k", auth: "a" } }, device: "아이폰 · 사파리" });

  // 훈련생은 알림을 등록할 수 없다
  assert.equal((await call("POST", "/api/push/subscribe", sub("https://push.example.com/x"), dm)).status, 403);
  assert.equal((await call("POST", "/api/push/subscribe", sub("http://insecure.example.com/x"), staff)).status, 400);
  assert.equal((await call("POST", "/api/push/subscribe", sub("https://push.example.com/a1"), staff)).status, 200);
  assert.equal((await call("POST", "/api/push/subscribe", sub("https://push.example.com/a2"), staff2)).status, 200);
  assert.equal((await call("POST", "/api/push/subscribe", sub("https://push.example.com/gone"), staff2)).status, 200);
  const info = await call("GET", "/api/push", undefined, staff);
  assert.equal(info.json.enabled, true);
  assert.equal(info.json.publicKey, "test-public-key");
  assert.deepEqual(info.json.devices.map((d) => d.device), ["아이폰 · 사파리"]);

  // 지각 알림 → 운영진 두 명의 기기로
  const n = await call("POST", "/api/notices", { kind: "late", day: "2026-11-10", time: "09:40", reason: "병원" }, dm);
  assert.equal(n.status, 200);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["https://push.example.com/a1", "https://push.example.com/a2"]);
  assert.equal(sent[0].title, "[지각] 홍길동(DM)");
  assert.equal(sent[0].body, "11/10(화) 09:40 · 병원");
  assert.equal(sent[0].url, "/#admin/day/2026-11-10");
  // 만료된 기기는 지운다
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%/gone'")).n, 0);

  sent.length = 0;
  await call("POST", `/api/notices/${n.json.id}/cancel`, {}, dm);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].title, "[지각 취소] 홍길동(DM)");

  sent.length = 0;
  const post = await call("POST", "/api/posts", { title: "노트북 대여", body: "가능한가요?", private: true }, dm);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].title, "[새 문의 · 비공개] 홍길동(DM)");
  assert.equal(sent[0].url, `/#qna/${post.json.id}`);

  // 운영진 답변은 운영진에게 알리지 않고, 훈련생 추가 댓글은 알린다
  sent.length = 0;
  await call("POST", `/api/posts/${post.json.id}/replies`, { body: "네 가능합니다" }, staff);
  assert.equal(sent.length, 0);
  await call("POST", `/api/posts/${post.json.id}/replies`, { body: "감사합니다" }, dm);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].title, "[문의 댓글] 홍길동(DM)");

  // 운영진이 쓴 글은 본인에게 오지 않고 다른 운영진에게만
  sent.length = 0;
  await call("POST", "/api/notices", { kind: "absent", day: "2026-11-11", reason: "출장" }, staff);
  assert.deepEqual(sent.map((s) => s.endpoint), ["https://push.example.com/a2"]);

  // 테스트 알림은 내 기기로만
  sent.length = 0;
  const test1 = await call("POST", "/api/push/test", {}, staff);
  assert.equal(test1.json.sent, 1);
  assert.deepEqual(sent.map((s) => s.endpoint), ["https://push.example.com/a1"]);

  // 끄면 더 이상 안 온다
  await call("POST", "/api/push/unsubscribe", { endpoint: "https://push.example.com/a1" }, staff);
  sent.length = 0;
  await call("POST", "/api/notices", { kind: "early", day: "2026-11-12", time: "15:00", reason: "면접" }, dm);
  assert.deepEqual(sent.map((s) => s.endpoint), ["https://push.example.com/a2"]);
  await db.close();
});

test("알림 키가 없으면 알림만 꺼지고 나머지는 동작한다", async () => {
  const db = await openDb({ url: "", file: ":memory:" });
  const lp = fakeLunchpass();
  lp.add("김운영", "admin", "OTHER", { role: "admin" });
  const app = createApp(db, { now: () => T0, lunchpass: lp, push: null, secureCookie: false });
  const call = async (method, path, body, cookie) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: "x", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, socket: {} });
    const res = {};
    await app(req, { writeHead: (s, h) => Object.assign(res, { s, h }), end: (d) => (res.d = d) });
    return { status: res.s, json: res.d ? JSON.parse(res.d) : null, cookie: res.h?.["Set-Cookie"]?.split(";")[0] };
  };
  const staff = (await call("POST", "/api/auth/login", { loginId: "admin", password: PW })).cookie;
  assert.equal((await call("GET", "/api/push", undefined, staff)).json.enabled, false);
  assert.equal((await call("POST", "/api/push/subscribe", { subscription: { endpoint: "https://p.example.com/1", keys: { p256dh: "k", auth: "a" } } }, staff)).status, 503);
  assert.equal((await call("POST", "/api/notices", { kind: "absent", day: "2026-11-10", reason: "x" }, staff)).status, 200);
  await db.close();
});

test("알림 키는 처음 쓸 때 만들어 DB 에 저장하고, 서버가 여러 개여도 같은 키를 쓴다", async () => {
  const db = await openDb({ url: "", file: ":memory:" });
  const prev = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    const lp = fakeLunchpass();
    lp.add("김운영", "admin", "OTHER", { role: "admin" });
    const make = () => createApp(db, { now: () => T0, lunchpass: lp, secureCookie: false });
    const call = async (app, method, path, body, cookie) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url: path, headers: { host: "x", ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, socket: {} });
      const res = {};
      await app(req, { writeHead: (s, h) => Object.assign(res, { s, h }), end: (d) => (res.d = d) });
      return { status: res.s, json: res.d ? JSON.parse(res.d) : null, cookie: res.h?.["Set-Cookie"]?.split(";")[0] };
    };
    const [a, b] = [make(), make()];
    const cookie = (await call(a, "POST", "/api/auth/login", { loginId: "admin", password: PW })).cookie;
    const [ka, kb] = await Promise.all([call(a, "GET", "/api/push", undefined, cookie), call(b, "GET", "/api/push", undefined, cookie)]);
    assert.equal(ka.json.enabled, true);
    assert.match(ka.json.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(kb.json.publicKey, ka.json.publicKey);
    // 개인 키는 화면 설정으로 나가지 않는다
    const me = await call(a, "GET", "/api/me", undefined, cookie);
    assert.equal(JSON.stringify(me.json).includes("vapid"), false);
    const stored = await db.get("SELECT value FROM settings WHERE key = 'vapid_public'");
    assert.equal(stored.value, ka.json.publicKey);
  } finally {
    if (prev[0] !== undefined) process.env.VAPID_PUBLIC_KEY = prev[0];
    if (prev[1] !== undefined) process.env.VAPID_PRIVATE_KEY = prev[1];
    await db.close();
  }
});
