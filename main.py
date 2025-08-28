import requests
import json
import os
from google_play_scraper import app
from datetime import datetime

# ========== CONFIG ==========
def load_apps_config():
    """Load cấu hình apps từ Repository Variable"""
    config_str = os.getenv('APPS_CONFIG')
    if config_str:
        try:
            return json.loads(config_str)
        except Exception as e:
            print(f"❌ Lỗi khi parse APPS_CONFIG: {e}")
            print(f"Config string: {config_str[:100]}...")  # Log một phần để debug
    
    # Fallback config nếu không có variable
    return {
        "ios": [
            {"id": "1517783697", "name_fallback": "Genshin Impact"}
        ],
        "android": [
            {"id": "com.miHoYo.GenshinImpact", "name_fallback": "Genshin Impact"}
        ]
    }

DISCORD_WEBHOOK_URL = os.getenv('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/xxx/yyy')
STATE_FILE = "last_versions.json"
# ============================

def load_state():
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        return {}
    except Exception as e:
        print(f"❌ Lỗi khi load state: {e}")
        return {}

def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
        print(f"✅ Đã lưu state vào {STATE_FILE}")
    except Exception as e:
        print(f"❌ Lỗi khi save state: {e}")

def get_ios_info(app_id):
    try:
        url = f"https://itunes.apple.com/lookup?id={app_id}"
        res = requests.get(url, timeout=10).json()
        if "results" in res and len(res["results"]) > 0:
            app_data = res["results"][0]
            return {
                "name": app_data["trackName"],
                "version": app_data["version"],
                "url": app_data["trackViewUrl"],
                "icon": app_data["artworkUrl100"],
                "releaseNotes": app_data.get("releaseNotes", "Không có ghi chú"),
                "releaseDate": format_date(app_data.get("currentVersionReleaseDate")),
                "developer": app_data.get("artistName", "Unknown"),
                "developerUrl": app_data.get("artistViewUrl", app_data["trackViewUrl"]),  # link dev riêng
                "genres": ", ".join(app_data.get("genres", [])) or app_data.get("primaryGenreName", "Unknown"),
            }
        return None
    except Exception as e:
        print(f"❌ Lỗi khi lấy thông tin iOS app {app_id}: {e}")
        return None

def get_android_info(pkg_name):
    try:
        result = app(pkg_name)
        return {
            "name": result["title"],
            "version": result["version"],
            "url": result["url"],
            "icon": result["icon"],
            "releaseNotes": result.get("recentChanges", "Không có ghi chú"),
            "releaseDate": format_date(result.get("updated")),
            "developer": result.get("developer", "Unknown"),
            "developerUrl": f"https://play.google.com/store/apps/dev?id={result.get('developerId')}" if result.get("developerId") else result["url"],
            "genres": result.get("genre", "Unknown"),
        }
    except Exception as e:
        print(f"❌ Lỗi khi lấy thông tin Android app {pkg_name}: {e}")
        return None

def send_discord_embed(app_name, platform, old_version, info):
    try:
        embed = {
            "title": f"📢 {app_name} {platform} vừa cập nhật!",
            "url": info["url"],
            "description": (
                f"**Platform:** {platform}\n"
                f"**Old Version:** `{old_version or 'N/A'}`\n"
                f"**New Version:** `{info['version']}`\n"
                f"**Release Date:** {info.get('releaseDate', 'Không rõ')}\n"
                f"**Developer:** [{info.get('developer','Unknown')}]({info.get('developerUrl', 'url')})\n"
                f"**Genres:** {info.get('genres','Unknown')}\n"
                f"\n"
                f"**Release Notes:**\n{info['releaseNotes'][:1000]}"
            ),
            "color": 0x1abc9c,
            "thumbnail": {"url": info["icon"]},
            "footer": {"text": "App Update Notifier"}
        }
        payload = {"embeds": [embed]}
        response = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=10)
        response.raise_for_status()
        print(f"✅ Đã gửi thông báo Discord cho {app_name}")
    except Exception as e:
        print(f"❌ Lỗi khi gửi Discord: {e}")

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

def main():
    print("🔄 Bắt đầu kiểm tra cập nhật...")
    APPS = load_apps_config()
    print(f"📋 Loaded config: {len(APPS.get('ios', []))} iOS apps, {len(APPS.get('android', []))} Android apps")
    
    state = load_state()
    has_update = False

    print(f"📱 Đang kiểm tra iOS apps...")
    for app_data in APPS.get("ios", []):
        print(f"   🔍 Kiểm tra {app_data['name_fallback']}...")
        info = get_ios_info(app_data["id"])
        if info:
            old_version = state.get(app_data["id"])
            if info["version"] != old_version:
                print(f"   🎉 PHÁT HIỆN CẬP NHẬT: {info['name']} | {old_version} → {info['version']}")
                send_discord_embed(info['name'], "iOS", old_version, info)
                state[app_data["id"]] = info["version"]
                has_update = True
            else:
                print(f"   ✅ {info['name']} (iOS) không có cập nhật")

    print(f"🤖 Đang kiểm tra Android apps...")
    for app_data in APPS.get("android", []):
        print(f"   🔍 Kiểm tra {app_data['name_fallback']}...")
        info = get_android_info(app_data["id"])
        if info:
            old_version = state.get(app_data["id"])
            if info["version"] != old_version:
                print(f"   🎉 PHÁT HIỆN CẬP NHẬT: {info['name']} | {old_version} → {info['version']}")
                send_discord_embed(info['name'], "Android", old_version, info)
                state[app_data["id"]] = info["version"]
                has_update = True
            else:
                print(f"   ✅ {info['name']} (Android) không có cập nhật")

    if has_update:
        save_state(state)
        print("💾 Đã lưu state mới")
    else:
        print("ℹ️ Không có cập nhật nào")

if __name__ == "__main__":
    main()