# watch_publishers.py
import requests
import json
import os
import csv
import io
from datetime import datetime
from google_play_scraper import app as gp_app
from google_play_scraper import developer as gp_developer

# ========== CẤU HÌNH ==========
DISCORD_WEBHOOK_URL = os.getenv('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/xxx/yyy')
PUBLISHERS_SHEET_URL = os.getenv("PUBLISHERS_SHEET_URL")   # CSV: platform,publisher_id
PUBLISHERS_STATE_FILE = "publishers_state.json"
# ==============================


# ---------- UTILS ----------
def format_date(value):
    """Chuẩn hóa các kiểu date thành DD-MM-YYYY"""
    if not value:
        return "Không rõ"

    # Nếu là datetime hoặc date object
    if hasattr(value, "strftime"):
        return value.strftime("%d-%m-%Y")

    # Nếu là int (timestamp ms hoặc s)
    if isinstance(value, int):
        # Nếu lớn hơn năm 3000 thì chắc chắn ms
        ts = value / 1000 if value > 32503680000 else value
        return datetime.fromtimestamp(ts).strftime("%d-%m-%Y")

    # Nếu là string ISO (iOS thường có dạng 2024-08-12T10:15:23Z)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "")).strftime("%d-%m-%Y")
        except Exception:
            # Nếu dạng "August 25, 2025"
            try:
                return datetime.strptime(value, "%B %d, %Y").strftime("%d-%m-%Y")
            except Exception:
                return value  # fallback giữ nguyên

    return str(value)


# ---------- LẤY THÔNG TIN APP (tái dùng) ----------
def get_ios_info(app_id):
    """Mặc định US Store vì không truyền country."""
    try:
        url = f"https://itunes.apple.com/lookup?id={app_id}"
        res = requests.get(url, timeout=15).json()
        if "results" in res and len(res["results"]) > 0:
            app_data = res["results"][0]
            return {
                "name": app_data["trackName"],
                "version": app_data.get("version", "Không rõ"),
                "url": app_data["trackViewUrl"],
                "icon": app_data["artworkUrl100"],
                "releaseNotes": app_data.get("releaseNotes", ""),
                "releaseDate": format_date(app_data.get("currentVersionReleaseDate")),
                "developer": app_data.get("artistName", "Không rõ"),
                "developerUrl": app_data.get("artistViewUrl", app_data["trackViewUrl"]),
                "genres": ", ".join(app_data.get("genres", [])) or app_data.get("primaryGenreName", "Không rõ"),
                "screenshot": (app_data.get("screenshotUrls") or [None])[0],
            }
        return {}
    except Exception:
        return {}


def get_android_info(pkg_name):
    """Mặc định US Play Store vì không truyền lang/country."""
    try:
        result = gp_app(pkg_name)
        return {
            "name": result.get("title", pkg_name),
            "version": result.get("version", "Không rõ"),
            "url": result.get("url", ""),
            "icon": result.get("icon", ""),
            "releaseNotes": result.get("recentChanges", ""),
            "releaseDate": format_date(result.get("updated")),
            "developer": result.get("developer", "Không rõ"),
            "developerUrl": f"https://play.google.com/store/apps/dev?id={result.get('developerId')}" if result.get("developerId") else result.get("url", ""),
            "genres": result.get("genre", "Không rõ"),
            "screenshot": (result.get("screenshots") or [None])[0] if result.get("screenshots") else None,
        }
    except Exception:
        return {}


# ---------- DISCORD ----------
def send_discord_new_app(publisher_name, platform, app_id, app_title, info):
    """Thông báo khi publisher ra app mới"""
    try:
        title = f"🆕 {publisher_name} vừa phát hành app mới trên {platform}!"
        description = (
            f"**Publisher:** [{publisher_name}]({info.get('developerUrl','')})\n"
            f"**Platform:** {platform}\n"
            f"**App:** {app_title}\n"
            f"**Version:** `{info.get('version', 'Không rõ')}`\n"
            f"**Release Date:** {info.get('releaseDate', 'Không rõ')}\n"
            f"\n**Release Notes:**\n{(info.get('releaseNotes') or '')[:800]}"
        )
        embed = {
            "title": title,
            "url": info.get("url"),
            "description": description,
            "color": 0x5865F2,
            "thumbnail": {"url": info.get("icon")},
            "footer": {"text": "Publisher Watch"}
        }
        if info.get("screenshot"):
            embed["image"] = {"url": info["screenshot"]}
        payload = {"embeds": [embed]}
        response = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=15)
        response.raise_for_status()
        print(f"✅ Đã thông báo app mới: {app_title} ({platform})")
    except Exception as e:
        print(f"❌ Lỗi gửi Discord app mới: {e}")


# ---------- SHEET: PUBLISHERS ----------
def load_publishers_from_sheet(url: str):
    """
    CSV: platform,publisher_id
    - iOS: publisher_id = artistId (số)
    - Android: publisher_id = developerId
    """
    pubs = []
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        content = r.content.decode("utf-8", errors="ignore")
        reader = csv.DictReader(io.StringIO(content))
        for row in reader:
            platform = (row.get("platform") or "").strip().lower()
            pid = (row.get("publisher_id") or "").strip()
            if not platform or not pid:
                continue
            if platform in ("ios", "android"):
                pubs.append({"platform": platform, "publisher_id": pid})
        if pubs:
            print(f"✅ Đã tải {len(pubs)} publisher từ Google Sheet.")
        else:
            print("⚠️ Sheet publisher trống.")
    except Exception as e:
        print(f"❌ Lỗi đọc sheet publisher: {e}")
    return pubs


# ---------- STATE ----------
def load_publishers_state(path=PUBLISHERS_STATE_FILE):
    try:
        if os.path.exists(path):
            with open(path, "r") as f:
                return json.load(f)
        return {}
    except Exception as e:
        print(f"❌ Lỗi khi load publishers state: {e}")
        return {}

def save_publishers_state(state, path=PUBLISHERS_STATE_FILE):
    try:
        with open(path, "w") as f:
            json.dump(state, f, indent=2)
        print(f"💾 Đã lưu publishers state vào {path}")
    except Exception as e:
        print(f"❌ Lỗi khi lưu publishers state: {e}")


# ---------- LIỆT KÊ APP THEO PUBLISHER ----------
def list_ios_apps_by_publisher(artist_id: str):
    """Trả về (publisher_name, apps[{id,name}]) — mặc định US."""
    try:
        url = f"https://itunes.apple.com/lookup?id={artist_id}&entity=software"
        res = requests.get(url, timeout=15).json()
        apps = []
        publisher_name = "Không rõ"
        for item in res.get("results", []):
            if "artistName" in item:
                publisher_name = item["artistName"]
            if "trackId" in item and item.get("kind") == "software":
                apps.append({
                    "id": str(item["trackId"]),
                    "name": item.get("trackName", str(item["trackId"]))
                })
        return publisher_name, apps
    except Exception as e:
        print(f"❌ Lỗi iOS artist {artist_id}: {e}")
        return "Không rõ", []


def list_android_apps_by_publisher(dev_id: str):
    """Trả về (publisher_name, apps[{id,name}]) — mặc định US/en."""
    try:
        items = gp_developer(dev_id, results=200)
        apps = []
        publisher_name = "Không rõ"
        if items:
            publisher_name = items[0].get("developer", "Không rõ")
            for it in items:
                app_id = it.get("appId")
                title = it.get("title") or app_id
                if app_id:
                    apps.append({"id": app_id, "name": title})
        return publisher_name, apps
    except Exception as e:
        print(f"❌ Lỗi Android developer {dev_id}: {e}")
        return "Không rõ", []


# ---------- KIỂM TRA PUBLISHER ----------
def check_publishers_new_apps():
    if not PUBLISHERS_SHEET_URL:
        print("ℹ️ Không có PUBLISHERS_SHEET_URL. Bỏ qua theo dõi publisher.")
        return False

    publishers = load_publishers_from_sheet(PUBLISHERS_SHEET_URL)
    if not publishers:
        print("ℹ️ Danh sách publisher rỗng. Bỏ qua.")
        return False

    state = load_publishers_state()
    has_new = False

    for p in publishers:
        platform = p["platform"]
        publisher_id = p["publisher_id"]
        key = f"{platform}:{publisher_id}"

        if platform == "ios":
            publisher_name, current = list_ios_apps_by_publisher(publisher_id)
        else:
            publisher_name, current = list_android_apps_by_publisher(publisher_id)

        print(f"👤 Publisher: {publisher_name} ({key}) — đang kiểm tra...")

        current_ids = {item["id"] for item in current}
        prev_ids = set((state.get(key) or {}).get("app_ids", []))
        new_ids = current_ids - prev_ids

        if new_ids:
            has_new = True
            print(f"   🎯 Có {len(new_ids)} app mới: {', '.join(list(new_ids)[:5])}...")
            for item in current:
                if item["id"] in new_ids:
                    app_id = item["id"]
                    app_title = item["name"]
                    info = get_ios_info(app_id) if platform == "ios" else get_android_info(app_id)
                    info = info or {"url": "", "icon": "", "version": "Không rõ", "releaseNotes": "", "screenshot": None, "releaseDate": "Không rõ"}
                    send_discord_new_app(publisher_name, platform, app_id, app_title, info)
        else:
            print("   ✅ Chưa có app mới.")

        # Cập nhật state
        state[key] = {
            "publisher_name": publisher_name,
            "app_ids": sorted(list(current_ids)),
            "checked_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }

    if has_new:
        save_publishers_state(state)
    else:
        print("ℹ️ Không phát hiện app mới nào từ các publisher.")
    return has_new


# ---------- MAIN ----------
def main():
    print("🔄 Bắt đầu theo dõi publisher phát hành app mới...")
    check_publishers_new_apps()

if __name__ == "__main__":
    main()
