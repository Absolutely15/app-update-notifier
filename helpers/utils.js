// helpers/utils.js
import axios from "axios";

export async function fetchTextWithRetry(url, {
  attempts = 5,
  baseDelayMs = 1000,
  timeout = 45000,
} = {}) {
  let attempt = 0;
  let delay = baseDelayMs;

  while (attempt < attempts) {
    try {
      const { data } = await axios.get(url, { timeout, responseType: "text" });
      return typeof data === "string" ? data : String(data ?? "");
    } catch (err) {
      const res = err.response;

      if (res?.status === 429) {
        const ms = Math.ceil((res.data?.retry_after ?? 1) * 1000);
        const jitter = Math.floor(Math.random() * 250);
        console.log(`⏳ Sheet 429. Chờ ${ms + jitter}ms rồi thử lại...`);
        await new Promise(r => setTimeout(r, ms + jitter));
        continue;
      }

      if (res && String(res.status).startsWith("5") && attempt < attempts - 1) {
        const sleep = delay + Math.floor(Math.random() * 250);
        console.log(`⚠️ Sheet ${res.status}. Thử lại (lần ${attempt + 1}/${attempts}) sau ${sleep}ms`);
        await new Promise(r => setTimeout(r, sleep));
        delay *= 2;
        attempt++;
        continue;
      }

      if (attempt < attempts - 1) {
        const sleep = delay + Math.floor(Math.random() * 250);
        console.log(`⚠️ Lỗi đọc sheet (${err.message}). Thử lại sau ${sleep}ms`);
        await new Promise(r => setTimeout(r, sleep));
        delay *= 2;
        attempt++;
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchTextWithRetry: exhausted attempts");
}
