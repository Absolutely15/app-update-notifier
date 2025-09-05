import { sendMessageToThread } from "./discord_bot.js";
import { getRoleIds } from "./discord_channel.js";

/**
 * Ping tất cả role IDs lấy từ role sheet trong 1 message.
 * Chỉ gửi nếu có ít nhất 1 role id.
 */
export async function pingRolesInThread(threadId, { extraText = "" } = {}) {
  const roleIds = getRoleIds();
  if (!Array.isArray(roleIds) || roleIds.length === 0) return;

  const mention = roleIds.map(id => `<@&${id}>`).join(" ");
  const content = [extraText.trim(), mention].filter(Boolean).join(" ").trim();

  await sendMessageToThread(threadId, {
    content,
    allowed_mentions: { parse: [], roles: roleIds }
  });
}
