// watch_publishers.js
import fs from "fs";
import axios from "axios";
import Papa from "papaparse";
import gplay from "google-play-scraper";
import { createThreadInTextChannel, sendMessageToThread, getChannelSafe, unarchiveThread } from "./helpers/discord_bot.js";
import { pickChannelId, ensureThreadBelongsToChannel } from "./helpers/discord_channel.js";

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
  if (typeof value === "string") {
    const iso = value.replace("Z", "");
    const d1 = new Date(iso);
    if (!isNaN(d1)) return d1.toLocaleDateString("vi-VN");
    const d2 = new Date(value);
    if (!isNaN(d2)) return d2.toLocaleDateString("vi-VN");
    return value;
  }
  if (typeof value === "number") {
    const d = new Date(value > 32503680000 ? value : value * 1000);
    return d.toLocaleDateString("vi-VN");
  }
  if (value instanceof Date) return value.toLocaleDateString("vi-VN");
  return String(value);
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
        icon: a.artworkUrl512,
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

async function sendThreadBatch(threadId, embeds) {
  for (let i = 0; i < embeds.length; i += 10) {
   const chunk = embeds.slice(i, i + 10);
     try {
     await sendMessageToThread(threadId, { embeds: chunk });
    } catch (e) {
     console.log("❌ Lỗi gửi batch vào thread:", e.message);
     await new Promise(r => setTimeout(r, 1200));
      try { await sendMessageToThread(threadId, { embeds: chunk }); } catch {}
    }
    if (i + 10 < embeds.length) await new Promise(r => setTimeout(r, 1200));
  }
}

async function ensurePublisherThread(platform, publisherId, publisherName, state) {
  const key = `${platform}:${publisherId}`;
  const entry = state[key] || {};
  const channelId = pickChannelId("watch_publisher", platform);
  if (entry.thread_id) {
    // 1) Tồn tại & đúng channel?
    const check = await ensureThreadBelongsToChannel(entry.thread_id, channelId);
    if (check.ok) {
      const meta = check.info.thread_metadata || {};
      if (meta.locked) {
        console.log("🔒 Thread cũ locked → tạo mới.");
      } else {
        if (meta.archived) await unarchiveThread(entry.thread_id, 10080);
        return entry.thread_id; // ✅ reuse
      }
    } else {
      // not_found / wrong_parent / not_thread
        console.log(`↪️ Thread cũ không hợp lệ (${check.reason}) → tạo mới trong channel đúng.`);
    }
  }
  const name = `${publisherName} — ${platform === "ios" ? "iOS" : "Android"} — New Apps`;
  const threadId = await createThreadInTextChannel(channelId, name, 10080);
  state[key] = { ...(state[key] || {}), thread_id: threadId, publisher_name: publisherName };
  console.log(`🧵 Tạo thread publisher: ${name} (${threadId})`);
  return threadId;
}

async function listIOSAppsByPublisher(artistId) {
  try {
    const { data } = await axios.get(`https://itunes.apple.com/lookup?id=${artistId}&limit=200&entity=software`, { timeout: 15000 });
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

    if (firstRun) {
      try {
      const tid = await ensurePublisherThread(platform, publisher_id, publisherName, state);
          console.log(`🧵 (First run) Đã tạo thread sẵn cho ${publisherName}: ${tid}`);
        } catch (e) {
          console.log(`⚠️ Không tạo được thread (first run) cho ${publisherName}:`, e.message);
          }
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
            `**Genres:** ${safe.genres || "Không rõ"}\n\n` +
            `**Release Notes:**\n${(safe.releaseNotes || "").slice(0, 800)}`,
          color: 0x5865f2,
          thumbnail: { url: safe.icon || "" },
          footer: { text: "Publisher Watch" }
        };
        if (safe.screenshot) embed.image = { url: safe.screenshot };
        embeds.push(embed);
      }

    const threadId = await ensurePublisherThread(platform, publisher_id, publisherName, state);
    await sendThreadBatch(threadId, embeds);
    } else if (!firstRun) {
      console.log("   ✅ Chưa có app mới.");
    } else {
      console.log("   (First run) Bỏ qua gửi Discord cho publisher này.");
    }

    // Luôn cập nhật snapshot state
    state[key] = {
      ...(state[key] || {}),
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
