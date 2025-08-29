// helpers/discord.js
import axios from "axios";

/**
 * Gửi webhook Discord với retry:
 * - 429: chờ đúng `retry_after` (cộng jitter) rồi gửi lại (không trừ quota retry)
 * - 5xx: exponential backoff + jitter, tối đa maxRetries lần
 */
export async function postDiscord(webhookUrl, payload, { maxRetries = 5 } = {}) {
  let attempt = 0;
  let delay = 1000; // 1s, dùng cho 5xx

  /* eslint-disable no-constant-condition */
  while (true) {
    try {
      return await axios.post(webhookUrl, payload, { timeout: 15000 });
    } catch (err) {
      const res = err.response;

      // 429: Discord trả { retry_after: <seconds> }
      if (res && res.status === 429) {
        const ms = Math.ceil((res.data?.retry_after ?? 1) * 1000);
        const jitter = Math.floor(Math.random() * 250);
        console.log(`⏳ Rate limit 429. Chờ ${ms + jitter}ms rồi thử lại...`);
        await new Promise(r => setTimeout(r, ms + jitter));
        continue; // không tính vào maxRetries
      }

      // 5xx: backoff lũy tiến
      if (res && String(res.status).startsWith("5") && attempt < maxRetries) {
        const sleep = delay + Math.floor(Math.random() * 250);
        console.log(`⚠️ Discord ${res.status}. Thử lại (lần ${attempt + 1}/${maxRetries}) sau ${sleep}ms`);
        await new Promise(r => setTimeout(r, sleep));
        attempt++;
        delay *= 2;
        continue;
      }

      // lỗi khác: quăng ra ngoài
      throw err;
    }
  }
}
