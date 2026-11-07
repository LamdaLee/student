// 운영진 휴대폰 웹 푸시(VAPID). 외부 서비스 계정 없이 브라우저 표준 푸시를 씁니다.
// 키는 처음 쓸 때 자동으로 만들어 DB 에 저장합니다. 환경 변수 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 가 있으면 그것을 씁니다.
import webpush from "web-push";

export const generateVapidKeys = () => webpush.generateVAPIDKeys();

export function pushConfig(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY || "";
  const privateKey = env.VAPID_PRIVATE_KEY || "";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT || "mailto:admin@example.com" };
}

// send(subscription, payload) → { ok } 또는 { gone: true }(만료된 구독: 지워야 함)
export function createPushSender(config) {
  if (!config) return null;
  const vapidDetails = { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey };
  return {
    publicKey: config.publicKey,
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails,
          TTL: 12 * 3600, // 꺼져 있던 휴대폰도 12시간 안에 켜지면 받습니다.
          urgency: "high",
          timeout: 5000,
        });
        return { ok: true };
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) return { gone: true };
        return { ok: false, error: err.statusCode || err.message };
      }
    },
  };
}
