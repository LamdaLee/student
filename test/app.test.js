import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { openDb } from "../lib/db.js";
import { createApp, kstDay, normalizeCode } from "../lib/app.js";

// 한국 시간 2026-11-09(월) 10:00
const T0 = Date.parse("2026-11-09T01:00:00Z");

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
  const app = createApp(db, { now: () => clock.t, setupKey: "test-setup-key-123456789012", secret: "s".repeat(32), secureCookie: false });
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
    return { status: res.status, json: JSON.parse(res.body), cookie: setCookie ? setCookie.split(";")[0] : undefined, setCookie };
  };
  const cleanup = async () => {
    await db.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  };
  return { db, call, clock, cleanup };
}

for (const kind of ["sqlite", "postgres"]) {
  describe(kind, { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL 없음" }, () => {
    let t, staff, dm, ax, codes;
    before(async () => {
      t = await setup(kind);
    });
    after(async () => t?.cleanup());

    test("미인증 상태에서는 최초 운영진 등록만 보인다", async () => {
      const r = await t.call("GET", "/api/me");
      assert.equal(r.status, 401);
      assert.equal(r.json.setup, true);
      assert.equal((await t.call("GET", "/api/notices")).status, 401);
    });

    test("최초 운영진 등록은 설정 키가 맞아야 하고 한 번만 된다", async () => {
      assert.equal((await t.call("POST", "/api/setup", { key: "wrong", name: "운영" })).status, 400);
      const r = await t.call("POST", "/api/setup", { key: "test-setup-key-123456789012", name: "김운영" });
      assert.equal(r.status, 200);
      assert.match(r.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.match(r.setCookie, /HttpOnly/);
      assert.match(r.setCookie, /Max-Age=34560000/);
      staff = r.cookie;
      const again = await t.call("POST", "/api/setup", { key: "test-setup-key-123456789012", name: "또" });
      assert.equal(again.status, 403);
      const me = await t.call("GET", "/api/me", undefined, { cookie: staff });
      assert.equal(me.json.member.role, "staff");
      assert.equal(me.json.today, "2026-11-09");
    });

    test("운영진이 명단을 등록하면 개인 코드가 나오고, 한 번 인증하면 쿠키로 계속 쓴다", async () => {
      const bad = await t.call("POST", "/api/admin/members", { entries: [{ name: "가", class: "SF" }] }, { cookie: staff });
      assert.equal(bad.status, 400);
      const r = await t.call(
        "POST",
        "/api/admin/members",
        { entries: [{ name: "홍길동", class: "dm" }, { name: "김철수", class: "AX" }, { name: "홍길동", class: "AX" }] },
        { cookie: staff },
      );
      assert.equal(r.status, 200);
      assert.equal(r.json.created.length, 3);
      assert.equal(r.json.created[0].class, "DM");
      codes = r.json.created.map((c) => c.code);
      assert.equal(new Set(codes).size, 3);

      const login = await t.call("POST", "/api/auth/redeem", { code: codes[0].toLowerCase().replace("-", " ") });
      assert.equal(login.status, 200);
      dm = login.cookie;
      ax = (await t.call("POST", "/api/auth/redeem", { code: codes[1] })).cookie;
      const me = await t.call("GET", "/api/me", undefined, { cookie: dm });
      assert.equal(me.json.member.name, "홍길동");
      assert.equal(me.json.member.class, "DM");

      // 같은 코드로 다른 기기도 등록할 수 있다.
      assert.equal((await t.call("POST", "/api/auth/redeem", { code: codes[0] })).status, 200);

      // 훈련생은 관리 화면에 못 들어간다.
      assert.equal((await t.call("GET", "/api/admin/day", undefined, { cookie: dm })).status, 403);

      // 오래 지나도 쓰는 동안 연장된다.
      t.clock.t += 200 * 86400000;
      const later = await t.call("GET", "/api/me", undefined, { cookie: dm });
      assert.equal(later.status, 200);
      assert.match(later.setCookie, /Max-Age=34560000/);
      t.clock.t = T0;
    });

    test("틀린 코드가 많으면 같은 IP 를 잠시 막는다", async () => {
      for (let i = 0; i < 30; i++) {
        const r = await t.call("POST", "/api/auth/redeem", { code: "AAAA-AAAA" }, { ip: "9.9.9.9" });
        assert.equal(r.status, 400);
      }
      assert.equal((await t.call("POST", "/api/auth/redeem", { code: codes[2] }, { ip: "9.9.9.9" })).status, 429);
      assert.equal((await t.call("POST", "/api/auth/redeem", { code: codes[2] }, { ip: "8.8.8.8" })).status, 200);
      t.clock.t += 16 * 60000;
      assert.equal((await t.call("POST", "/api/auth/redeem", { code: codes[2] }, { ip: "9.9.9.9" })).status, 200);
      t.clock.t = T0;
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

    test("점심 정하기", async () => {
      const a = await t.call("POST", "/api/restaurants", { name: "한밭칼국수", category: "한식", mapUrl: "https://map.naver.com/x" }, { cookie: dm });
      assert.equal(a.status, 200);
      const b = await t.call("POST", "/api/restaurants", { name: "분식왕" }, { cookie: ax });
      assert.equal((await t.call("POST", "/api/restaurants", { name: "분식왕" }, { cookie: dm })).status, 409);
      assert.equal((await t.call("POST", "/api/restaurants", { name: "x", mapUrl: "javascript:alert(1)" }, { cookie: dm })).status, 400);

      assert.equal((await t.call("POST", "/api/lunch/pick", { restaurantId: a.json.id }, { cookie: dm })).status, 200);
      assert.equal((await t.call("POST", "/api/lunch/pick", { restaurantId: a.json.id }, { cookie: ax })).status, 200);
      assert.equal((await t.call("POST", "/api/lunch/pick", { restaurantId: b.json.id }, { cookie: ax })).status, 200); // 바꾸기
      let r = await t.call("GET", "/api/lunch", undefined, { cookie: dm });
      const han = r.json.restaurants.find((x) => x.id === a.json.id);
      assert.equal(han.count, 1);
      assert.deepEqual(han.byClass, { DM: 1 });
      assert.equal(han.people[0].me, true);
      assert.equal(r.json.myPick, a.json.id);
      assert.equal(r.json.restaurants.find((x) => x.id === b.json.id).count, 1);

      assert.equal((await t.call("POST", "/api/lunch/pick", { restaurantId: null }, { cookie: dm })).status, 200);
      r = await t.call("GET", "/api/lunch", undefined, { cookie: dm });
      assert.equal(r.json.myPick, null);

      // 운영진이 숨기면 목록에서 빠지고 선택할 수 없다.
      assert.equal((await t.call("POST", `/api/admin/restaurants/${b.json.id}`, { active: false }, { cookie: staff })).status, 200);
      r = await t.call("GET", "/api/lunch", undefined, { cookie: dm });
      assert.equal(r.json.restaurants.length, 1);
      assert.equal((await t.call("POST", "/api/lunch/pick", { restaurantId: b.json.id }, { cookie: dm })).status, 404);

      // 다음 날은 새로 정한다.
      t.clock.t = T0 + 86400000;
      r = await t.call("GET", "/api/lunch", undefined, { cookie: ax });
      assert.equal(r.json.myPick, null);
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

    test("코드 재발급과 사용 중지는 기존 로그인을 끝낸다", async () => {
      const members = (await t.call("GET", "/api/admin/members", undefined, { cookie: staff })).json.members;
      const hong = members.find((m) => m.name === "홍길동" && m.class === "DM");
      assert.equal(hong.devices, 2);
      const re = await t.call("POST", `/api/admin/members/${hong.id}/reissue`, {}, { cookie: staff });
      assert.equal(re.status, 200);
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: dm })).status, 401);
      assert.equal((await t.call("POST", "/api/auth/redeem", { code: codes[0] })).status, 400);
      dm = (await t.call("POST", "/api/auth/redeem", { code: re.json.code })).cookie;
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: dm })).status, 200);

      const kim = members.find((m) => m.name === "김철수");
      assert.equal((await t.call("POST", `/api/admin/members/${kim.id}/update`, { active: false }, { cookie: staff })).status, 200);
      assert.equal((await t.call("GET", "/api/me", undefined, { cookie: ax })).status, 401);
      assert.equal((await t.call("POST", "/api/auth/redeem", { code: codes[1] })).status, 400);

      // 내 권한은 스스로 해제할 수 없다.
      const me = members.find((m) => m.role === "staff");
      assert.equal((await t.call("POST", `/api/admin/members/${me.id}/update`, { role: "trainee", class: "DM" }, { cookie: staff })).status, 400);
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

test("한국 시간 날짜와 코드 정리", () => {
  assert.equal(kstDay(Date.parse("2026-11-08T15:00:00Z")), "2026-11-09");
  assert.equal(kstDay(Date.parse("2026-11-08T14:59:59Z")), "2026-11-08");
  assert.equal(normalizeCode(" ab12-cd34 "), "AB12CD34");
});

test("Vercel 경로(route 쿼리)로도 동작한다", async () => {
  const db = await openDb({ url: "", file: ":memory:" });
  const app = createApp(db, { secret: "s".repeat(32), setupKey: "" });
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url: "/api/index?route=api/me", headers: { host: "x" }, socket: {} });
  let status;
  await app(req, { writeHead: (s) => (status = s), end() {} });
  assert.equal(status, 401);
  await db.close();
});
