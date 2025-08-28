import requests
import json
import os
from google_play_scraper import app

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
            release_date = app_data.get("currentVersionReleaseDate")
            if release_date:
                # convert "2024-08-12T10:15:23Z" -> "12-08-2024"
                release_date = datetime.fromisoformat(release_date.replace("Z", "")).strftime("%d-%m-%Y")
            return {
                "name": app_data["trackName"],
                "version": app_data["version"],
                "url": app_data["trackViewUrl"],
                "icon": app_data["artworkUrl100"],
                "releaseNotes": app_data.get("releaseNotes", "Không có ghi chú"),
                "releaseDate": release_date or "Không rõ",
                "developer": app_data.get("artistName", "Unknown"),
            }
        return None
    except Exception as e:
        print(f"❌ Lỗi khi lấy thông tin iOS app {app_id}: {e}")
        return None

def get_android_info(pkg_name):
    try:
        result = app(pkg_name)
        release_date = result.get("updated")
        if release_date:
            # datetime.date -> string "DD-MM-YYYY"
            release_date = release_date.strftime("%d-%m-%Y")
        return {
            "name": result["title"],
            "version": result["version"],
            "url": result["url"],
            "icon": result["icon"],
            "releaseNotes": result.get("recentChanges", "Không có ghi chú"),
            "releaseDate": release_date or "Không rõ",
            "developer": result.get("developer", "Unknown"),
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
                f"**New Version:** `{info['version']}`\n\n"
                f"**Release Date:** {info.get('releaseDate', 'Không rõ')}\n\n"
                f"**Developer:** [{info.get('publisher','Unknown')}]({info['url']})\n\n"
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
                print(f"   ✅ {info['name']} (Android) không có cập nhật")

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
                print(f"   ✅ {info['name']} (iOS) không có cập nhật")

    if has_update:
        save_state(state)
        print("💾 Đã lưu state mới")
    else:
        print("ℹ️ Không có cập nhật nào")

if __name__ == "__main__":
    main()