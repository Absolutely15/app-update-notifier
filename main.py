import requests
import json
from google_play_scraper import app

# ========== CONFIG ==========
DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1410466907332677662/_ubuBsEgtG1_iR17e48jbiPpZvDNBFfF6CKT4GqENSnc4CJeajpKysPpkXuOjq1endAq"

APPS = {
    "ios": [
        {"id": "1517783697", "name": "Genshin Impact (iOS)"}
    ],
    "android": [
        {"id": "com.miHoYo.GenshinImpact", "name": "Genshin Impact (Android)"}
    ]
}

STATE_FILE = "last_versions.json"
# ============================


def load_state():
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except:
        return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def get_ios_version(app_id):
    url = f"https://itunes.apple.com/lookup?id={app_id}"
    res = requests.get(url).json()
    return res["results"][0]["version"]


def get_android_version(pkg_name):
    result = app(pkg_name)
    return result["version"]


def send_discord_embed(app_name, platform, new_version):
    embed = {
        "title": f"📢 {app_name} vừa cập nhật!",
        "description": f"**Platform:** {platform}\n**Version mới:** `{new_version}`",
        "color": 0x1abc9c  # màu xanh Discord
    }
    payload = {"embeds": [embed]}
    requests.post(DISCORD_WEBHOOK_URL, json=payload)


def main():
    state = load_state()

    # Check iOS apps
    for a in APPS["ios"]:
        version = get_ios_version(a["id"])
        old_version = state.get(a["id"])
        if version != old_version:
            send_discord_embed(a["name"], "iOS", version)
            state[a["id"]] = version

    # Check Android apps
    for a in APPS["android"]:
        version = get_android_version(a["id"])
        old_version = state.get(a["id"])
        if version != old_version:
            send_discord_embed(a["name"], "Android", version)
            state[a["id"]] = version

    save_state(state)


if __name__ == "__main__":
    main()
