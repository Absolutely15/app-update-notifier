import axios from "axios";
import Papa from "papaparse";

let CHANNELS = {}; // { [task]: { ios: "id", android: "id" } }
let ROLE_IDS = []; // [ "987...", "876..." ]
let loaded = false;

async function loadCsv(url) {
  const { data } = await axios.get(url, { timeout: 15000 });
  const parsed = Papa.parse(data, { header: true, skipEmptyLines: true });
  return parsed.data || [];
}

export async function loadDiscordConfig({
  channelUrl = process.env.DISCORD_CHANNEL_SHEET_URL,
  roleUrl = process.env.DISCORD_ROLE_SHEET_URL,
} = {}) {
  CHANNELS = {};
  ROLE_IDS = [];
  loaded = false;

  try {
    // Channels
    if (!channelUrl) throw new Error("DISCORD_CHANNEL_SHEET_URL is not set");
    const chanRows = await loadCsv(channelUrl);
    for (const r of chanRows) {
      const task = String(r.task || "").trim();
      const platform = String(r.platform || "").trim().toLowerCase();
      const id = String(r.channel_id || r.id || "").trim();
      if (!task || !id || !["ios", "android"].includes(platform)) continue;
      CHANNELS[task] = CHANNELS[task] || {};
      CHANNELS[task][platform] = id;
    }
    console.log(`✅ Loaded channels: ${Object.keys(CHANNELS).length} tasks`);

    // Roles
    if (!roleUrl) {
      console.warn("⚠️ DISCORD_ROLE_SHEET_URL is not set; role ping disabled.");
    } else {
      const roleRows = await loadCsv(roleUrl);
      for (const r of roleRows) {
        const id = String(r.role_id || r.id || "").trim();
        if (/^\d{5,}$/.test(id)) ROLE_IDS.push(id);
      }
      console.log(`✅ Loaded roles: ${ROLE_IDS.length} ids`);
    }

    loaded = true;
  } catch (e) {
    console.error("❌ loadDiscordConfig failed:", e.message);
    loaded = true;
  }
}

export function pickChannelIdFromConfig(taskName, platform) {
  if (!loaded) throw new Error("Discord config not loaded. Call loadDiscordConfig() first.");
  const id = CHANNELS?.[taskName]?.[platform];
  if (!id) throw new Error(`No channelId for ${taskName}/${platform} in channel sheet.`);
  return id;
}

export function getAllRoleIdsFromConfig() {
  if (!loaded) throw new Error("Discord config not loaded. Call loadDiscordConfig() first.");
  return ROLE_IDS;
}
