// helpers/discord_channel.js
import { getChannelSafe } from "./discord_bot.js";

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
