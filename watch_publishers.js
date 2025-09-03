// watch_publishers.js
import fs from "fs";
import axios from "axios";
import Papa from "papaparse";
import gplay from "google-play-scraper";
import { postDiscord } from "./helpers/discord.js";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/xxx/yyy";
const PUBLISHERS_SHEET_URL = process.env.PUBLISHERS_SHEET_URL; // CSV: platform,publisher_id
const PUBLISHERS_STATE_FILE = "publishers_state.json";

function loadState() {
  try {
    if (fs.existsSync(PUBLISHERS_STATE_FILE)) {
      const raw = fs.readFileSync(PUBLISHERS_STATE_FILE, "utf8").trim();
      if (!raw) return {}; // file rỗng
      return JSON.parse(raw);
    }
  } catch (e) { console.log("❌ Lỗi load publishers state:", e.message); }
  return {};
}
function saveState(s) {
  try {
    fs.writeFileSync(PUBLISHERS_STATE_FILE, JSON.stringify(s, null, 2));
    console.log(`💾 Đã lưu publishers state vào ${PUBLISHERS_STATE_FILE}`);
  } catch (e) { console.log("❌ Lỗi lưu publishers state:", e.message); }
}

async function loadPublishersFromSheet(url) {
  if (!url) return [];
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    const parsed = Papa.parse(data, { header: true, skipEmptyLines: false });
    const pubs = [];
    for (const row of parsed.data) {
      const platform = (row.platform || "").trim().toLowerCase();
      const pid = (row.publisher_id || "").trim();
      if (!platform || !pid) continue;
      if (platform === "ios" || platform === "android") pubs.push({ platform, publisher_id: pid });
    }
    console.log(`✅ Đã tải ${pubs.length} publisher từ Google Sheet.`);
    return pubs;
  } catch (e) {
    console.log("❌ Lỗi đọc sheet publisher:", e.message);
    return [];
  }
}

function formatDate(value) {
  if (!value) return "Không rõ";
  const d = new Date(value);
  return isNaN(d) ? String(value) : d.toLocaleDateString("vi-VN");
}

async function getIOSInfo(appId) {
  try {
    const { data } = await axios.get(`https://itunes.apple.com/lookup?id=${appId}`, { timeout: 15000 });
    if (data.results && data.results.length) {
      const a = data.results[0];
      return {
        name: a.trackName,
        version: a.version || "Không rõ",
        url: a.trackViewUrl,
        icon: a.artworkUrl100,
        releaseNotes: a.releaseNotes || "",
        releaseDate: formatDate(a.currentVersionReleaseDate),
        developer: a.artistName || "Không rõ",
        developerUrl: a.artistViewUrl || a.trackViewUrl,
        genres: (a.genres || []).join(", ") || a.primaryGenreName || "Không rõ",
        screenshot: (a.screenshotUrls || [null])[0]
      };
    }
    return {};
  } catch { return {}; }
}

async function getAndroidInfo(pkg) {
  try {
    const r = await gplay.app({ appId: pkg });
    return {
      name: r.title,
      version: r.version || "Không rõ",
      url: r.url,
      icon: r.icon,
      releaseNotes: r.recentChanges || "",
      releaseDate: formatDate(r.updated),
      developer: r.developer || "Không rõ",
      developerUrl: r.developerId ? `https://play.google.com/store/apps/dev?id=${r.developerId}` : r.url,
      genres: r.genre || "Không rõ",
      screenshot: (r.screenshots && r.screenshots[0]) || null
    };
  } catch { return {}; }
}

function buildAppUrl(platform, appId, infoUrl) {
  if (infoUrl) return infoUrl;
  return platform === "ios"
    ? `https://apps.apple.com/app/id${appId}`
    : `https://play.google.com/store/apps/details?id=${appId}`;
}

async function sendDiscordBatch(embeds) {
  // Gửi theo lô 10 embeds / request, có gap nhỏ giữa các lô
  for (let i = 0; i < embeds.length; i += 10) {
    const chunk = embeds.slice(i, i + 10);
    await postDiscord(DISCORD_WEBHOOK_URL, { embeds: chunk });
    if (i + 10 < embeds.length) {
      const gap = 300 + Math.floor(Math.random() * 300); // 300–600ms
      await new Promise(r => setTimeout(r, gap));
    }
  }
}

async function listIOSAppsByPublisher(artistId) {
  try {
    const { data } = await axios.get(`https://itunes.apple.com/lookup?id=${artistId}&entity=software`, { timeout: 15000 });
    const apps = [];
    let publisherName = "Không rõ";
    for (const it of (data.results || [])) {
      if (it.artistName) publisherName = it.artistName;
      if (it.trackId && it.kind === "software") {
        apps.push({ id: String(it.trackId), name: it.trackName || String(it.trackId) });
      }
    }
    return { publisherName, apps };
  } catch (e) {
    console.log(`❌ Lỗi iOS artist ${artistId}:`, e.message);
    return { publisherName: "Không rõ", apps: [] };
  }
}

async function listAndroidAppsByPublisher(devId) {
  try {
    const items = await gplay.developer({ devId, num: 200, fullDetail: true });
    const apps = [];
    let publisherName = "Không rõ";
    if (items && items.length) {
      publisherName = items[0].developer || "Không rõ";
      for (const it of items) {
        if (it.appId) apps.push({ id: it.appId, name: it.title || it.appId });
      }
    }
    return { publisherName, apps };
  } catch (e) {
    console.log(`❌ Lỗi Android developer ${devId}:`, e.message);
    return { publisherName: "Không rõ", apps: [] };
  }
}

async function main() {
  console.log("🔄 Bắt đầu theo dõi publisher phát hành app mới...");
  const publishers = await loadPublishersFromSheet(PUBLISHERS_SHEET_URL);
  if (!publishers.length) { console.log("ℹ️ Danh sách publisher rỗng. Bỏ qua."); return; }

  const state = loadState();
  const firstRun = !fs.existsSync(PUBLISHERS_STATE_FILE) || Object.keys(state).length === 0;
  if (firstRun) {
    console.log("🆕 Lần chạy đầu (publishers state rỗng) → chỉ lưu snapshot, KHÔNG gửi Discord.");
  }

  let hasNew = false;

  for (const p of publishers) {
    const { platform, publisher_id } = p;
    const key = `${platform}:${publisher_id}`;

    let publisherName, current;
    if (platform === "ios") {
      const r = await listIOSAppsByPublisher(publisher_id);
      publisherName = r.publisherName; current = r.apps;
    } else {
      const r = await listAndroidAppsByPublisher(publisher_id);
      publisherName = r.publisherName; current = r.apps;
    }

    console.log(`👤 Publisher: ${publisherName} (${key}) — đang kiểm tra...`);
    const currentIds = new Set(current.map(x => x.id));
    const prevIds = new Set((state[key]?.app_ids || []));

    const newIds = [...currentIds].filter(id => !prevIds.has(id));

    if (!firstRun && newIds.length) {
      hasNew = true;
      console.log(`   🎯 Có ${newIds.length} app mới: ${newIds.slice(0, 5).join(", ")}...`);

      // Gom embeds
      const embeds = [];
      for (const item of current) {
        if (!newIds.includes(item.id)) continue;

        const info = platform === "ios" ? await getIOSInfo(item.id) : await getAndroidInfo(item.id);
        const safe = info || {};
        const appUrl = buildAppUrl(platform, item.id, safe.url);

        const embed = {
          title: `🆕 ${publisherName} vừa phát hành app mới! - ${item.name}`,
          url: appUrl,
          description:
            `**Publisher:** [${publisherName}](${safe.developerUrl || ""})\n` +
            `**Platform:** ${platform}\n` +
            `**App:** ${item.name}\n` +
            `**Version:** \`${safe.version || "Không rõ"}\`\n` +
            `**Release Date:** ${safe.releaseDate || "Không rõ"}\n\n` +
            `**Genres:** ${info.genres || "Không rõ"}\n\n` +
            `**Release Notes:**\n${(safe.releaseNotes || "").slice(0, 800)}`,
          color: 0x5865f2,
          thumbnail: { url: safe.icon || "" },
          footer: { text: "Publisher Watch" }
        };
        if (safe.screenshot) embed.image = { url: safe.screenshot };
        embeds.push(embed);
      }

      await sendDiscordBatch(embeds);
    } else if (!firstRun) {
      console.log("   ✅ Chưa có app mới.");
    } else {
      console.log("   (First run) Bỏ qua gửi Discord cho publisher này.");
    }

    // Luôn cập nhật snapshot state
    state[key] = {
      publisher_name: publisherName,
      app_ids: [...currentIds].sort(),
      checked_at: new Date().toISOString().slice(0, 19).replace("T", " ")
    };
  }

  // Lưu state (kể cả firstRun)
  saveState(state);

  if (!firstRun && !hasNew) {
    console.log("ℹ️ Không phát hiện app mới nào từ các publisher.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
