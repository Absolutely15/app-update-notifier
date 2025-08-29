// check_app_updates.js
import fs from "fs";
import axios from "axios";
import Papa from "papaparse";
import gplay from "google-play-scraper"; // npm (facundoolano)

// ===== CẤU HÌNH =====
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/xxx/yyy";
const STATE_FILE = "last_versions.json";
const APPS_SHEET_URL = process.env.APPS_SHEET_URL; // CSV: platform,id,name_fallback
const APPS_CONFIG = process.env.APPS_CONFIG; // JSON string (optional)
// =====================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
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
  if (APPS_CONFIG) {
    try {
      const cfg = JSON.parse(APPS_CONFIG);
      console.log(`✅ Đã tải cấu hình từ APPS_CONFIG: ${cfg.ios?.length || 0} iOS, ${cfg.android?.length || 0} Android`);
      return cfg;
    } catch (e) {
      console.log("❌ Lỗi parse APPS_CONFIG:", e.message);
    }
  }
  console.log("⚠️ Dùng cấu hình mặc định cứng.");
  return {
    ios: [{ id: "1517783697", name_fallback: "Genshin Impact" }],
    android: [{ id: "com.miHoYo.GenshinImpact", name_fallback: "Genshin Impact" }]
  };
}

function formatDate(value) {
  if (!value) return "Không rõ";
  // Try ISO
  if (typeof value === "string") {
    const iso = value.replace("Z", "");
    const d1 = new Date(iso);
    if (!isNaN(d1)) return d1.toLocaleDateString("vi-VN");
    // Try "August 25, 2025"
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
        version: a.version,
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

async function sendDiscordEmbed(appName, platform, oldVersion, info) {
  try {
    const embed = {
      title: `📢 ${appName} (${platform}) vừa cập nhật!`,
      url: info.url,
      description:
        `**Nền tảng:** ${platform}\n` +
        `**Phiên bản cũ:** \`${oldVersion || "N/A"}\`\n` +
        `**Phiên bản mới:** \`${info.version}\`\n` +
        `**Ngày phát hành:** ${info.releaseDate || "Không rõ"}\n` +
        `**Nhà phát triển:** [${info.developer || "Không rõ"}](${info.developerUrl || info.url})\n` +
        `**Thể loại:** ${info.genres || "Không rõ"}\n\n` +
        `**Ghi chú phát hành:**\n${(info.releaseNotes || "").slice(0, 1000)}`,
      color: 0x1abc9c,
      thumbnail: { url: info.icon },
      footer: { text: "App Update Notifier" }
    };
    if (info.screenshot) embed.image = { url: info.screenshot };

    await axios.post(DISCORD_WEBHOOK_URL, { embeds: [embed] }, { timeout: 15000 });
    console.log(`✅ Đã gửi thông báo Discord cho ${appName} (${platform})`);
  } catch (e) {
    console.log("❌ Lỗi gửi Discord:", e.message);
  }
}

async function main() {
  console.log("🔄 Bắt đầu kiểm tra cập nhật phiên bản ứng dụng...");
  const apps = await loadAppsConfig();
  console.log(`📋 Danh sách ứng dụng: ${apps.ios.length} iOS, ${apps.android.length} Android`);

  const state = loadState();
  let changed = false;

  console.log("📱 Kiểm tra iOS...");
  for (const a of apps.ios) {
    console.log(`   🔍 ${a.name_fallback}...`);
    const info = await getIOSInfo(a.id);
    if (!info) { console.log("    ⚠️ Không lấy được thông tin."); continue; }
    const old = state[a.id];
    console.log(`    - Cũ: ${old || "N/A"} | Mới: ${info.version} | Khác nhau: ${info.version !== old}`);
    if (info.version !== old) {
      await sendDiscordEmbed(info.name, "iOS", old, info);
      state[a.id] = info.version;
      changed = true;
    }
  }

  console.log("🤖 Kiểm tra Android...");
  for (const a of apps.android) {
    console.log(`   🔍 ${a.name_fallback}...`);
    const info = await getAndroidInfo(a.id);
    if (!info) { console.log("    ⚠️ Không lấy được thông tin."); continue; }
    const old = state[a.id];
    console.log(`    - Cũ: ${old || "N/A"} | Mới: ${info.version} | Khác nhau: ${info.version !== old}`);
    if (info.version !== old) {
      await sendDiscordEmbed(info.name, "Android", old, info);
      state[a.id] = info.version;
      changed = true;
    }
  }

  if (changed) saveState(state);
  else console.log("ℹ️ Không phát hiện cập nhật phiên bản nào");
}

main().catch(e => { console.error(e); process.exit(1); });
