// Vercel 서버 함수: /api/* 요청을 모두 이 함수가 처리합니다(vercel.json rewrites).
import { openDb } from "../lib/db.js";
import { createApp } from "../lib/app.js";

let ready;
function getApp() {
  ready ??= openDb().then((db) => createApp(db)).catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "서버 설정을 확인해 주세요. (DATABASE_URL, AUTH_SECRET)" }));
  }
}
