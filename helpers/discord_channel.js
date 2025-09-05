// helpers/discord_channel.js
import { getChannelSafe, unarchiveThread } from "./discord_bot.js";
import axios from "axios";

const API = "https://discord.com/api/v10";
const AUTH = { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } };

// ---- Channel map loader & guards -------------------------------------------
const MAP = JSON.parse(process.env.DISCORD_CHANNEL_MAP || "{}");

export function pickChannelId(taskName, platform) {
  const id = MAP?.[taskName]?.[platform];
  if (!id) throw new Error(`No channelId for ${taskName}/${platform}`);
  return id;
}


// ---- Thread checks ----------------------------------------------------------

/**
 * Kiểm tra thread có tồn tại và thuộc về channelId mong muốn không.
 * Trả về:
 *  - { ok: true, info }  → tồn tại & đúng parent
 *  - { ok: false, reason, info? } → not_found | not_thread | wrong_parent
 */
export async function ensureThreadBelongsToChannel(threadId, channelId) {
  const info = await getChannelSafe(threadId);
  if (!info) return { ok: false, reason: "not_found" };

  // Discord thread types: 10=news thread, 11=public, 12=private
  const type = info.type;
  const isThread = type === 10 || type === 11 || type === 12;
  if (!isThread) return { ok: false, reason: "not_thread", info };

  if (String(info.parent_id) !== String(channelId)) {
    return { ok: false, reason: "wrong_parent", info };
  }

  return { ok: true, info };
}

function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Tìm thread theo tên *chỉ trong channel này*.
 * - archived: dùng các endpoint per-channel (public, optional private)
 * - active: (tuỳ chọn) gọi guild-active rồi *lọc parent_id* === channelId
 *
 * opts:
 *   - maxArchivedPages: số trang archived/public duyệt (mặc định 3)
 *   - includeActive: có duyệt active threads (qua guild endpoint) không (mặc định true)
 *   - includePrivateArchived: có duyệt archived/private không (mặc định false)
 */
export async function findThreadByNameInThisChannel(channelId, name, {
  maxArchivedPages = 3,
  includeActive = true,
  includePrivateArchived = false,
} = {}) {
  const wanted = norm(name);

  // 0) Lấy channel để biết guild_id (cần nếu includeActive = true)
  const ch = await getChannelSafe(channelId);
  if (!ch) return null;
  const guildId = ch.guild_id;

  // 1) Archived PUBLIC của channel
  let before = undefined;
  for (let page = 0; page < maxArchivedPages; page++) {
    const url = new URL(`${API}/channels/${channelId}/threads/archived/public`);
    if (before) url.searchParams.set("before", before);

    try {
      const { data } = await axios.get(url.toString(), AUTH);
      const threads = data?.threads || [];
      const hit = threads.find(t => norm(t.name) === wanted);
      if (hit) return hit;
      if (!data?.has_more || threads.length === 0) break;
      before = threads[threads.length - 1]?.id;
      if (!before) break;
    } catch (e) {
      console.log("⚠️ archived/public fetch error:", e.message);
      break;
    }
  }

  // 2) Archived PRIVATE của channel (nếu muốn & bot có quyền)
  if (includePrivateArchived) {
    before = undefined;
    for (let page = 0; page < maxArchivedPages; page++) {
      const url = new URL(`${API}/channels/${channelId}/threads/archived/private`);
      if (before) url.searchParams.set("before", before);
      try {
        const { data } = await axios.get(url.toString(), AUTH);
        const threads = data?.threads || [];
        const hit = threads.find(t => norm(t.name) === wanted);
        if (hit) return hit;
        if (!data?.has_more || threads.length === 0) break;
        before = threads[threads.length - 1]?.id;
        if (!before) break;
      } catch (e) {
        console.log("⚠️ archived/private fetch error:", e.message);
        break;
      }
    }
  }

  // 3) Active threads (tuỳ chọn): chỉ lấy trong guild rồi *lọc đúng channel*
  if (includeActive && guildId) {
    try {
      const { data } = await axios.get(`${API}/guilds/${guildId}/threads/active`, AUTH);
      const active = data?.threads || [];
      const hit = active.find(t => String(t.parent_id) === String(channelId) && norm(t.name) === wanted);
      if (hit) return hit;
    } catch (e) {
      console.log("⚠️ guild active fetch error:", e.message);
    }
  }

  return null;
}

/** Reuse thread nếu tìm thấy theo tên *trong channel này*; nếu archived thì unarchive */
export async function reuseThreadByNameInThisChannel(channelId, name) {
  const t = await findThreadByNameInThisChannel(channelId, name, {
    maxArchivedPages: 3,
    includeActive: true,            // vẫn chỉ quan tâm channel này vì có lọc parent_id
    includePrivateArchived: false,  // bật nếu bạn dùng private threads
  });
  if (!t) return null;

  const meta = t.thread_metadata || {};
  if (meta.locked) return null;
  if (meta.archived) {
    try { await unarchiveThread(t.id, 10080); } catch {}
  }
  return t.id;
}
