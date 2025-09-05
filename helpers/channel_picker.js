// helpers/channel_picker.js
const MAP = JSON.parse(process.env.DISCORD_CHANNEL_MAP || "{}");

export function pickChannelId(taskName, platform) {
  const id = MAP?.[taskName]?.[platform];
  if (!id) throw new Error(`No channelId for ${taskName}/${platform}`);
  return id;
}
