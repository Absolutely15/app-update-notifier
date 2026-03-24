// check_app_updates.js
import fs from "fs";
import axios from "axios";
import Papa from "papaparse";
import * as cheerio from "cheerio";
import { createThreadInTextChannel, sendMessageToThread, unarchiveThread } from "./helpers/discord_bot.js";
import { pickChannelId, ensureThreadBelongsToChannel, reuseThreadByNameInThisChannel } from "./helpers/discord_channel.js";
import { pingRolesInThread } from "./helpers/discord_notifications.js";
import { loadDiscordConfig } from "./helpers/discord_config.js";
import { fetchTextWithRetry } from "./helpers/utils.js";
import { formatDate, getIOSInfo as _getIOSInfo, getAndroidInfo } from "./helpers/app_info.js";

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
    const csvText = await fetchTextWithRetry(url);
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: false });
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

// --- Scrape App Store web ---
function pickFromSrcset(srcset) {
  if (!srcset) return null;

  const parts = srcset.split(",").map((p) => p.trim());
  let best = null;

  for (const part of parts) {
    const [url, size] = part.split(/\s+/);
    const m = size && size.match(/(\d+)w/);
    const w = m ? parseInt(m[1], 10) : 0;

    if (!best || w > best.w) {
      best = { url, w };
    }
  }

  return best ? best.url : null;
}

function normalizeUrl(u, base) {
  if (!u) return null;
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

async function scrapeAppStoreScreenshots(appId, limit = 1) {
  const pageUrl = `https://apps.apple.com/app/id${appId}`;

  const res = await axios.get(pageUrl, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const html = res.data;
  const $ = cheerio.load(html);

  const candidates = [];

  const selectors = [
    ".we-screenshot-viewer__screenshots img",
    ".we-screenshot-viewer__screenshots source[srcset]",
    "figure.we-artwork img",
    "figure.we-artwork source[srcset]",
    "picture source[srcset]",
    "img[srcset]",
    "img[src]",
  ];

  $(selectors.join(", ")).each((_, el) => {
    const tag = el.name?.toLowerCase?.() || "";
    const $el = $(el);

    let rawUrl = null;
    if (tag === "source") {
      rawUrl =
        pickFromSrcset($el.attr("srcset") || $el.attr("data-srcset")) || null;
    } else {
      rawUrl =
        $el.attr("src") ||
        $el.attr("data-src") ||
        pickFromSrcset($el.attr("srcset") || $el.attr("data-srcset")) ||
        null;
    }

    const url = normalizeUrl(rawUrl, pageUrl);
    if (!url) return;

    const alt = $el.attr("alt") || "";

    candidates.push({ url, alt });
  });

  const iconPattern =
    /(icon|icons|badge|logo|apple-touch-icon|square|thumbnail|small|100x100|60x60|512x512|1024x1024)/i;
  const screenshotKeywords =
    /(screenshot|screen|iphone|ipad|android|screenshotUrls)/i;

  const scored = candidates.map(({ url, alt }) => {
    let score = 0;

    // + điểm nếu có từ khóa screenshot
    if (screenshotKeywords.test(alt)) score += 50;
    if (screenshotKeywords.test(url)) score += 40;

    // + điểm nếu là ảnh to (dựa trên pattern WxH trong URL)
    const dimMatch = url.match(/(\d{2,4})x(\d{2,4})/);
    if (dimMatch) {
      const w = parseInt(dimMatch[1], 10);
      const h = parseInt(dimMatch[2], 10);
      if (w >= 300 || h >= 300) score += 30;
      if (w >= 600 || h >= 600) score += 10; // ưu tiên siêu to
    }

    // - điểm nếu giống icon / logo nhỏ
    if (iconPattern.test(url) || iconPattern.test(alt)) score -= 60;

    return { url, score };
  });

  // sort theo score giảm dần
  scored.sort((a, b) => b.score - a.score);

  // unique URL + limit
  const out = [];
  for (const s of scored) {
    if (!out.includes(s.url)) {
      out.push(s.url);
      if (out.length >= limit) break;
    }
  }

  return out;
}

// Wrapper: getIOSInfo with screenshot scraping
async function getIOSInfo(appId) {
  return _getIOSInfo(appId, { scrapeScreenshot: scrapeAppStoreScreenshots });
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
