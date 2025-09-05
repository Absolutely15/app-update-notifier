// helpers/discord_bot.js
import axios from "axios";

const API = "https://discord.com/api/v10";
const AUTH = { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } };

async function postWithRetry(url, body, { maxRetries = 5 } = {}) {
  let attempt = 0;
  let delay = 1000;

  while (true) {
    try {
      return await axios.post(url, body, { ...AUTH, timeout: 15000 });
    } catch (err) {
      const res = err.response;

      if (res && res.status === 429) {
        const ms = Math.ceil((res.data?.retry_after ?? 1) * 1000);
        const jitter = Math.floor(Math.random() * 250);
        console.log(`⏳ BOT 429. Chờ ${ms + jitter}ms rồi thử lại...`);
        await new Promise(r => setTimeout(r, ms + jitter));
        continue;
      }

      if (res && String(res.status).startsWith("5") && attempt < maxRetries) {
        const sleep = delay + Math.floor(Math.random() * 250);
        console.log(`⚠️ BOT ${res.status}. Thử lại (lần ${attempt + 1}/${maxRetries}) sau ${sleep}ms`);
        await new Promise(r => setTimeout(r, sleep));
        attempt++;
        delay *= 2;
        continue;
      }

      throw err;
    }
  }
}

export async function createThreadInTextChannel(channelId, name, autoArchiveMinutes = 10080) {
  const body = { name, auto_archive_duration: autoArchiveMinutes, type: 11 }; // GUILD_PUBLIC_THREAD
  const { data } = await postWithRetry(`${API}/channels/${channelId}/threads`, body);
  return data.id;
}

export async function sendMessageToThread(threadId, payload) {
  await postWithRetry(`${API}/channels/${threadId}/messages`, payload);
}

export async function getChannelSafe(channelId) {
  try {
    const { data } = await axios.get(`${API}/channels/${channelId}`, { ...AUTH, timeout: 15000 });
    return data; // null nếu 404
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

export async function unarchiveThread(threadId, autoArchiveMinutes = 10080) {
  try {
    await axios.patch(
      `${API}/channels/${threadId}`,
      { archived: false, auto_archive_duration: autoArchiveMinutes },
      { ...AUTH, timeout: 15000 }
    );
  } catch {
    // có thể locked / thiếu quyền -> cứ bỏ qua, phần gọi sẽ quyết định tiếp
  }
}
