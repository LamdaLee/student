// 런치패스(lunch 저장소)와의 연결. 로그인 화면은 포털이 기본이고, 계정(명단·비밀번호)은 런치패스에 있습니다.
// 두 앱은 PORTAL_SECRET 으로 서명한 짧은 토큰과 요청만 주고받고, DB 는 공유하지 않습니다.
// 서명 코드는 런치패스의 lib/portal.js 와 같습니다. 바꿀 때는 둘 다 바꿔 주세요.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const DEFAULT_LUNCHPASS_URL = "https://matzip-six.vercel.app";

const b64 = (value) => Buffer.from(value).toString("base64url");
const mac = (secret, text) => createHmac("sha256", secret).update(text).digest();


export function signToken(secret, purpose, payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, `${purpose}.${body}`))}`;
}

export function verifyToken(secret, purpose, token, nowMs) {
  const [body, sig, extra] = String(token || "").split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(secret, `${purpose}.${body}`);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < nowMs) return null;
  return payload;
}

// 서버끼리 부르는 요청: 메서드·경로·시각·본문에 서명합니다(±5분).
export function requestSignature(secret, method, path, ts, body = "") {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return b64(mac(secret, `req.${method}.${path}.${ts}.${bodyHash}`));
}

export function verifyRequest(secret, method, path, headers, nowMs, body = "") {
  const ts = Number(headers["x-portal-ts"]);
  const sig = String(headers["x-portal-signature"] || "");
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > 5 * 60_000) return false;
  const expected = Buffer.from(requestSignature(secret, method, path, ts, body));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function lunchpassConfig(env = process.env) {
  return {
    url: new URL(env.LUNCHPASS_URL || DEFAULT_LUNCHPASS_URL).origin,
    secret: env.PORTAL_SECRET || "",
  };
}

export class LunchpassError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 런치패스 서버를 서명해서 부릅니다.
export function createLunchpassClient({ url, secret, fetchImpl = fetch, now = () => Date.now(), timeoutMs = 5000 }) {
  async function call(method, path, body) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = now();
    let res;
    try {
      res = await fetchImpl(url + path, {
        method,
        headers: {
          ...(raw ? { "Content-Type": "application/json" } : {}),
          "x-portal-ts": String(ts),
          "x-portal-signature": requestSignature(secret, method, path, ts, raw),
        },
        body: raw || undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LunchpassError(502, "런치패스에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    }
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      // 로그인 실패·시도 제한·입력 오류는 런치패스 안내를 그대로 보여 줍니다.
      if ([400, 401, 429].includes(res.status)) throw new LunchpassError(res.status, data.error || "요청을 처리하지 못했습니다.");
      throw new LunchpassError(502, "런치패스 연결 설정을 확인해 주세요.");
    }
    return data;
  }
  return {
    url,
    login: async (loginId, password) => (await call("POST", "/api/portal/login", { loginId, password })).user,
    changePassword: async (loginId, password, newPassword) =>
      (await call("POST", "/api/portal/password", { loginId, password, newPassword })).user,
    users: async (id) => (await call("GET", `/api/portal/users${id != null ? `?id=${id}` : ""}`)).users,
    // 점심 탭: 런치패스에 자동 로그인하는 1회용 주소(2분 유효)
    enterUrl: (lunchId) =>
      `${url}/api/portal/enter?token=${encodeURIComponent(signToken(secret, "enter", { sub: lunchId, jti: randomUUID(), exp: now() + 120_000 }))}`,
  };
}
