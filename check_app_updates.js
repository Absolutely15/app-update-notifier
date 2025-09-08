// check_app_updates.js
import fs from "fs";
import axios from "axios";
import Papa from "papaparse";
import gplay from "google-play-scraper";
import { createThreadInTextChannel, sendMessageToThread, unarchiveThread } from "./helpers/discord_bot.js";
import { pickChannelId, ensureThreadBelongsToChannel, reuseThreadByNameInThisChannel } from "./helpers/discord_channel.js";
import { pingRolesInThread } from "./helpers/discord_notifications.js";
import { loadDiscordConfig } from "./helpers/discord_config.js";

// ===== CẤU HÌNH =====
const STATE_FILE = "last_versions.json";
const APPS_SHEET_URL = process.env.APPS_SHEET_URL; // CSV: platform,id,name_fallback

// =====================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8").trim();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(parsed)) {
        if (typeof parsed[k] === "string") parsed[k] = { version: parsed[k] };
      }
      return parsed;
    }
  } catch (e) { console.log("❌ Lỗi load state:", e.message); }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`💾 Đã lưu state vào ${STATE_FILE}`);
  } catch (e) { console.log("❌ Lỗi lưu state:", e.message); }
}

async function ensureAppThread(taskName, platform, appId, appDisplayName, state) {
  let created = false;
  const entry = state[appId] || {};
  const channelId = pickChannelId(taskName, platform);
  const threadName = `${appDisplayName}`;

  if (entry.thread_id) {
   const check = await ensureThreadBelongsToChannel(entry.thread_id, channelId);
   if (check.ok) {
     const meta = check.info.thread_metadata || {};
     if (meta.locked) {
       console.log("🔒 Thread cũ locked → tạo mới.");
     } else {
       if (meta.archived) await unarchiveThread(entry.thread_id, 10080);
       return { threadId: entry.thread_id, created }; // ✅ reuse
    }
   } else {
     console.log(`↪️ Thread cũ không hợp lệ (${check.reason}) → tạo mới trong channel đúng.`);
   }
  }
  
  const reused = await reuseThreadByNameInThisChannel(channelId, threadName);
  if (reused) {
    state[appId] = { ...(state[appId] || {}), thread_id: reused };
    console.log(`♻️ Dùng lại thread theo tên trong channel: ${threadName} (${reused})`);
    return { threadId: reused, created };
  }
  
  const threadId = await createThreadInTextChannel(channelId, threadName, 10080);
  //await pingRolesInThread(threadId);
  created = true;
  state[appId] = { ...(state[appId] || {}), thread_id: threadId };
  console.log(`🧵 Tạo thread game: ${threadName} (${threadId})`);
  return { threadId, created };
}

async function loadAppsFromSheet(url) {
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    const parsed = Papa.parse(data, { header: true, skipEmptyLines: false });
    const cfg = { ios: [], android: [] };
    for (const row of parsed.data) {
      const platform = (row.platform || "").trim().toLowerCase();
      const id = (row.id || "").trim();
      const name_fallback = (row.name_fallback || "").trim() || id;
      if (!platform || !id) continue;
      if (platform === "ios" || platform === "android") {
        cfg[platform].push({ id, name_fallback });
      }
    }
    if (!cfg.ios.length && !cfg.android.length) return null;
    console.log(`✅ Đã tải cấu hình từ Google Sheet: ${cfg.ios.length} iOS, ${cfg.android.length} Android`);
    return cfg;
  } catch (e) {
    console.log("❌ Lỗi đọc Google Sheet CSV:", e.message);
    return null;
  }
}

async function loadAppsConfig() {
  if (APPS_SHEET_URL) {
    const cfg = await loadAppsFromSheet(APPS_SHEET_URL);
    if (cfg) return cfg;
    console.log("⚠️ Sheet lỗi/trống. Dùng APPS_CONFIG nếu có.");
  }
  console.log("⚠️ Dùng cấu hình mặc định cứng.");
  return {
    ios: [{ id: "1517783697", name_fallback: "Genshin Impact" }],
    android: [{ id: "com.miHoYo.GenshinImpact", name_fallback: "Genshin Impact" }]
  };
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

// --- Scrape App Store web ---
function pickFromSrcset(srcset) {
  if (!srcset) return null;
  const first = srcset.split(",")[0]?.trim();
  return first ? first.split(" ")[0] : null;
}

async function scrapeAppStoreScreenshots(appId, limit = 1) {
  const url = `https://apps.apple.com/app/id${appId}`;
  const { data: html } = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
  });

  const $ = cheerio.load(html);
  const urls = [];

  // Nguồn chính: <picture><source srcset="...">
  $(".we-screenshot-viewer__screenshots picture source").each((_, el) => {
    if (urls.length >= limit) return false;
    const u = pickFromSrcset($(el).attr("srcset") || $(el).attr("data-srcset"));
    if (u) urls.push(u);
  });

  // Fallback: <img src>
  if (urls.length < limit) {
    $(".we-screenshot-viewer__screenshots img").each((_, el) => {
      if (urls.length >= limit) return false;
      const u = $(el).attr("src") || $(el).attr("data-src");
      if (u) urls.push(u);
    });
  }

  return urls;
}

async function getIOSInfo(appId) {
  try {
    const { data } = await axios.get(`https://itunes.apple.com/lookup?id=${appId}`, { timeout: 15000 });
    if (data.results && data.results.length) {
      const a = data.results[0];

      let screenshot = null;
      try {
        const shots = await scrapeAppStoreScreenshots(appId, 1);
        screenshot = shots[0] || null;
      } catch (err) {
        console.log(`⚠️ Lỗi scrape screenshot app ${appId}:`, err.message);
        screenshot = (a.screenshotUrls || [null])[0];
      }

      return {
        name: a.trackName,
        version: a.version,
        url: a.trackViewUrl,
        icon: a.artworkUrl512,
        releaseNotes: a.releaseNotes || "",
        releaseDate: formatDate(a.currentVersionReleaseDate),
        developer: a.artistName || "Không rõ",
        developerUrl: a.artistViewUrl || a.trackViewUrl,
        genres: (a.genres || []).join(", ") || a.primaryGenreName || "Không rõ",
        screenshot
      };
    }
    return null;
  } catch (e) {
    console.log(`❌ Lỗi iOS app ${appId}:`, e.message);
    return null;
  }
}

async function getAndroidInfo(pkg) {
  try {
    const r = await gplay.app({ appId: pkg }); // mặc định US/en
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
  } catch (e) {
    console.log(`❌ Lỗi Android app ${pkg}:`, e.message);
    return null;
  }
}

async function sendDiscordEmbed(threadId, appName, platform, oldVersion, info) {
  try {
    const embed = {
      title: `📢 ${appName} (${platform}) vừa cập nhật!`,
      url: info.url,
      description:
        `**Platform:** ${platform}\n` +
        `**Old Version:** \`${oldVersion || "N/A"}\`\n` +
        `**New Version:** \`${info.version}\`\n` +
        `**Release Date:** ${info.releaseDate || "Không rõ"}\n` +
        `**Developer:** [${info.developer || "Không rõ"}](${info.developerUrl || info.url})\n` +
        `**Genres:** ${info.genres || "Không rõ"}\n\n` +
        `**Release Notes:**\n${(info.releaseNotes || "").slice(0, 1000)}`,
      color: 0x1abc9c,
      thumbnail: { url: info.icon },
      footer: { text: "App Update Notifier" }
    };
    if (info.screenshot) embed.image = { url: info.screenshot };

    await sendMessageToThread(threadId, { embeds: [embed] });
    console.log(`✅ Đã gửi thông báo Discord cho ${appName} (${platform})`);
  } catch (e) {
    console.log("❌ Lỗi gửi Discord:", e.message);
  }
}

async function main() {
  console.log("🔄 Bắt đầu kiểm tra cập nhật phiên bản ứng dụng...");
  await loadDiscordConfig(); // load channel + role config
  const apps = await loadAppsConfig();
  console.log(`📋 Danh sách ứng dụng: ${apps.ios.length} iOS, ${apps.android.length} Android`);
  const state = loadState();
  const getOldVersion = (entry) => {
    if (!entry) return null;
    if (typeof entry === "string") return entry;
    if (typeof entry.version === "string") return entry.version;
    return null; // có thể đã có thread_id nhưng chưa có version
  };

  let changed = false;

  console.log("📱 Kiểm tra iOS...");
  for (const a of apps.ios) {
    console.log(`   🔍 ${a.name_fallback}...`);
    const info = await getIOSInfo(a.id);
    if (!info) { console.log("    ⚠️ Không lấy được thông tin."); continue; }
    const { threadId: iosThreadId, created: iosCreated } = await ensureAppThread("check_app_updates", "ios", a.id, info.name || a.name_fallback, state);
    const old = getOldVersion(state[a.id]);
    const first = !state[a.id] || !old; // 👈 app này chưa từng có trong state
    const isDifferent = info.version !== old;
    console.log(`    - Cũ: ${old || "N/A"} | Mới: ${info.version} | Khác nhau: ${isDifferent}`);
    if (isDifferent) {
      if (!first) {
        if (!iosCreated){
          await pingRolesInThread(iosThreadId);
        }
        await sendDiscordEmbed(iosThreadId, info.name || a.name_fallback, "iOS", old, info);
      }
      state[a.id] = { ...(state[a.id] || {}), version: info.version };
      changed = true;
    }
  }

  console.log("🤖 Kiểm tra Android...");
  for (const a of apps.android) {
    console.log(`   🔍 ${a.name_fallback}...`);
    const info = await getAndroidInfo(a.id);
    if (!info) { console.log("    ⚠️ Không lấy được thông tin."); continue; }
    const { threadId: androidThreadId, created: androidCreated } = await ensureAppThread("check_app_updates", "android", a.id, info.name || a.name_fallback, state);
    const old = getOldVersion(state[a.id]);
    const first = !state[a.id] || !old;
    const isDifferent = info.version !== old;
    console.log(`    - Cũ: ${old || "N/A"} | Mới: ${info.version} | Khác nhau: ${isDifferent}`);
    if (isDifferent) {
      if (!first) {
        if (!androidCreated){
          await pingRolesInThread(androidThreadId);
        }
         await sendDiscordEmbed(androidThreadId, info.name || a.name_fallback, "Android", old, info);
      }
      state[a.id] = { ...(state[a.id] || {}), version: info.version };
      changed = true;
    }
  }

  saveState(state);
  if (!changed) {
    console.log("ℹ️ Không phát hiện cập nhật phiên bản nào");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
