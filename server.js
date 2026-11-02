// 로컬 실행용 서버: 정적 화면(public/)과 API 를 함께 제공합니다.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { openDb } from "./lib/db.js";
import { createApp } from "./lib/app.js";
import { SECURITY_HEADERS } from "./lib/headers.js";

const PUBLIC = join(import.meta.dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const db = await openDb();
const api = createApp(db);

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const path = new URL(req.url, "http://local").pathname;
  if (path.startsWith("/api/")) return api(req, res);
  const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
  if (!file.startsWith(PUBLIC)) return res.writeHead(404).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`훈련생 포털: http://localhost:${port} (DB: ${db.kind})`));
