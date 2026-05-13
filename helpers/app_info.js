// helpers/app_info.js
// Shared app info utilities used by both check_app_updates.js and watch_publishers.js
import axios from "axios";
import gplay from "google-play-scraper";

export function formatDate(value) {
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

export function toTimestampMs(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const ms = value > 32503680000 ? value : value * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export async function getIOSInfo(appId, { scrapeScreenshot } = {}) {
  try {
    const { data } = await axios.get(`https://itunes.apple.com/lookup?id=${appId}`, { timeout: 15000 });
    if (data.results && data.results.length) {
      const a = data.results[0];

      let screenshot = (a.screenshotUrls || [null])[0];
      if (scrapeScreenshot) {
        try {
          const shots = await scrapeScreenshot(appId, 1);
          screenshot = shots[0] || screenshot;
        } catch (err) {
          console.log(`⚠️ Lỗi scrape screenshot app ${appId}:`, err.message);
        }
      }

      return {
        name: a.trackName,
        version: a.version,
        url: a.trackViewUrl,
        icon: a.artworkUrl512,
        releaseNotes: a.releaseNotes || "",
        releaseDate: formatDate(a.currentVersionReleaseDate),
        originalReleaseDate: formatDate(a.releaseDate),
        currentVersionReleaseTimestamp: toTimestampMs(a.currentVersionReleaseDate),
        releaseTimestamp: toTimestampMs(a.releaseDate),
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

export function isVaryVersion(v) {
  return /^varies?\b/i.test(v) || /^vary$/i.test(v);
}

export async function getAndroidInfo(pkg) {
  try {
    const r = await gplay.app({ appId: pkg }); // mặc định US/en
    const version = r.version || "Không rõ";
    const releaseTimestamp = toTimestampMs(r.released);
    const updatedTimestamp = toTimestampMs(r.updated);
    return {
      name: r.title,
      version,
      originalReleaseDate: formatDate(r.released),
      releaseTimestamp,
      updated: r.updated, // raw timestamp – dùng làm fallback khi version là VARY
      updatedTimestamp,
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
