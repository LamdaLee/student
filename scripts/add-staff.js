// 운영진 계정을 만들고 개인 코드를 출력합니다. (운영진 코드를 모두 잃어버렸을 때 복구용)
// 사용: npm run add-staff -- 이름
import { openDb } from "../lib/db.js";
import { createApp } from "../lib/app.js";
import { randomUUID } from "node:crypto";

const name = process.argv.slice(2).join(" ").trim();
if (!name) {
  console.error("사용법: npm run add-staff -- 이름");
  process.exit(1);
}
const db = await openDb();
// 앱의 API 를 그대로 호출해 만듭니다. 운영진이 없으면 최초 등록, 있으면 운영진 추가입니다.
const key = randomUUID();
const app = createApp(db, { setupKey: key });
const staff = await db.get("SELECT id FROM members WHERE role = 'staff' AND active = 1");
let code;
if (!staff) {
  code = (await call(app, "/api/setup", { key, name })).code;
} else {
  // 운영진이 이미 있으면 그 중 한 명의 권한으로 새 운영진을 추가합니다.
  const { createHash, randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  const t = Date.now();
  await db.run("INSERT INTO sessions (token_hash, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)", [
    createHash("sha256").update(token).digest("hex"), staff.id, t, t,
  ]);
  try {
    code = (await call(app, "/api/admin/members", { role: "staff", entries: [{ name }] }, token)).created[0].code;
  } finally {
    await db.run("DELETE FROM sessions WHERE token_hash = ?", [createHash("sha256").update(token).digest("hex")]);
  }
}
console.log(`운영진 "${name}" 개인 코드: ${code}`);
await db.close();

async function call(handler, path, body, token) {
  const { Readable } = await import("node:stream");
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", host: "cli", ...(token ? { cookie: `portal_session=${token}` } : {}) },
    socket: { remoteAddress: "cli" },
  });
  let status = 0, out = "";
  await handler(req, { writeHead: (s) => (status = s), end: (d) => (out = d) });
  const json = JSON.parse(out);
  if (status !== 200) throw new Error(json.error);
  return json;
}
