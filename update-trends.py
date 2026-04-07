#!/usr/bin/env python3
"""
Wavecrest Pro — Daily Trend Updater
Fetches real trending topics from free public sources and writes trends.json.
Run daily via cron, GitHub Actions, or manually:  python3 update-trends.py
"""

import json, re, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html import unescape
import random, ssl, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(SCRIPT_DIR, "public", "trends.json")

# Platform emoji prefixes for display
PLATFORM_EMOJI = {"youtube": "▶️", "tiktok": "♪", "instagram": "📸", "general": "🔥"}

# ─── Google Trends RSS (free, no API key) ───────────────────────────
def fetch_google_trends(geo="US"):
    """Fetch daily trending searches from Google Trends RSS."""
    url = f"https://trends.google.com/trending/rss?geo={geo}"
    trends = []
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(url, headers={"User-Agent": "WavecrestBot/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            data = resp.read().decode("utf-8")
        root = ET.fromstring(data)
        ns = {"ht": "https://trends.google.com/trending/rss"}
        for item in root.findall(".//item"):
            title = item.findtext("title", "").strip()
            traffic_el = item.find("ht:approx_traffic", ns)
            traffic = traffic_el.text.strip() if traffic_el is not None else "0"
            traffic_num = int(re.sub(r"[^\d]", "", traffic) or 0)
            if title:
                trends.append({"topic": title, "traffic": traffic_num})
    except Exception as e:
        print(f"[warn] Google Trends RSS failed: {e}")
    return trends


# ─── YouTube Trending (public page scrape, no API key) ──────────────
YT_JUNK = {
    "try searching", "keyboard shortcuts", "playback", "subtitles",
    "closed captions", "spherical videos", "general", "navigate",
    "seek", "change", "press", "volume", "full screen", "caption",
    "skip", "toggle", "mute", "previous", "next", "open", "close",
    "turn on", "turn off", "decrease", "increase", "activate",
    "start watching", "youtube home", "rewind", "fast forward",
    "rotate through", "font size", "text opacity", "window opacity",
    "listening", "navigate backward", "navigate forward", "settings",
    "watch later", "save to", "report", "share", "like this",
    "subscribe", "more actions", "miniplayer", "theater mode",
    "exit full", "annotations", "dialog", "chapter", "scrubber",
    "search with your voice", "queue", "autoplay", "ambient mode",
    "english (auto", "move to", "play next", "copy link",
    "didn't hear", "try again", "tap microphone", "microphone off",
    "check your connection", "waiting for permission", "allow microphone",
    "search with voice", "an error occurred", "no results",
    "sign in", "learn more", "see more", "show more", "show less",
    "search youtube", "upload video", "go live", "create a post",
    "shorts", "history", "your videos", "your clips", "liked videos",
}

def is_yt_junk(title):
    low = title.lower().strip()
    if len(title) < 15:
        return True
    if any(j in low for j in YT_JUNK):
        return True
    # Filter if it looks like UI text (very few words, imperative mood)
    words = low.split()
    if len(words) <= 3 and any(w in {"tap", "press", "click", "allow", "deny", "wait"} for w in words):
        return True
    return False

def fetch_youtube_trending():
    """Fetch YouTube trending video titles from the public trending page."""
    url = "https://www.youtube.com/feed/trending"
    titles = []
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        })
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        for match in re.finditer(r'"title":\{"runs":\[\{"text":"([^"]{12,80})"\}', html):
            t = unescape(match.group(1)).strip()
            if t and t not in titles and not is_yt_junk(t):
                titles.append(t)
        if not titles:
            for match in re.finditer(r'"text":"([^"]{12,80})"', html):
                t = unescape(match.group(1)).strip()
                if t and t not in titles and not t.startswith("http") and not is_yt_junk(t):
                    titles.append(t)
    except Exception as e:
        print(f"[warn] YouTube trending fetch failed: {e}")
    return titles[:20]


# ─── Score assignment ────────────────────────────────────────────────
def assign_score(traffic, rank, total):
    """Assign hot/rising/warm based on traffic volume and rank."""
    if traffic > 500000 or rank < total * 0.2:
        return "hot"
    elif traffic > 100000 or rank < total * 0.5:
        return "rising"
    return "warm"


# ─── Platform assignment ────────────────────────────────────────────
TIKTOK_KEYWORDS = ["tiktok", "dance", "challenge", "duet", "trend", "viral", "skit", "POV"]
INSTA_KEYWORDS = ["instagram", "reel", "aesthetic", "outfit", "fashion", "beauty", "selfie", "photo"]
YT_KEYWORDS = ["youtube", "video", "vlog", "tutorial", "review", "stream", "episode", "series"]

def guess_platform(topic):
    low = topic.lower()
    if any(k in low for k in TIKTOK_KEYWORDS):
        return "tiktok"
    if any(k in low for k in INSTA_KEYWORDS):
        return "instagram"
    if any(k in low for k in YT_KEYWORDS):
        return "youtube"
    return random.choice(["youtube", "tiktok", "instagram"])


# ─── Main ────────────────────────────────────────────────────────────
def main():
    print("🌊 Wavecrest Pro — Fetching daily trends...")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    all_trends = []
    seen = set()

    # 1. Google Trends
    gt = fetch_google_trends()
    print(f"  ✓ Google Trends: {len(gt)} topics")
    for i, t in enumerate(gt):
        key = t["topic"].lower()
        if key not in seen:
            seen.add(key)
            platform = guess_platform(t["topic"])
            emoji = PLATFORM_EMOJI[platform]
            all_trends.append({
                "topic": f'{emoji} {t["topic"]}',
                "score": assign_score(t["traffic"], i, max(len(gt), 1)),
                "platform": platform,
                "traffic": t["traffic"],
            })

    # 2. YouTube Trending
    yt = fetch_youtube_trending()
    print(f"  ✓ YouTube Trending: {len(yt)} titles")
    for i, title in enumerate(yt):
        key = title.lower()
        if key not in seen:
            seen.add(key)
            all_trends.append({
                "topic": f'▶️ {title}',
                "score": "hot" if i < 5 else ("rising" if i < 12 else "warm"),
                "platform": "youtube",
                "traffic": 0,
            })

    # Pad with date-seeded social media topics if we have too few
    FALLBACK_POOL = [
        ("GRWM morning routines", "tiktok"), ("Minimalist apartment tours", "youtube"),
        ("Street style lookbooks", "instagram"), ("AI music generation tools", "youtube"),
        ("#BookTok dark academia", "tiktok"), ("Coffee shop aesthetic reels", "instagram"),
        ("Speed coding challenges", "youtube"), ("#FitnessTok home workouts", "tiktok"),
        ("Golden hour photography", "instagram"), ("DIY room makeover timelapse", "youtube"),
        ("Silent vlog trend", "tiktok"), ("#PlantTok propagation tips", "instagram"),
        ("Retro gaming nostalgia", "youtube"), ("POV acting skits", "tiktok"),
        ("Meal prep aesthetic reels", "instagram"), ("Lo-fi study setups", "youtube"),
        ("#CleanTok deep cleaning", "tiktok"), ("Sunset drone cinematography", "instagram"),
        ("Budget travel hacks", "youtube"), ("#NailTok chrome art", "tiktok"),
        ("Cottagecore baking reels", "instagram"), ("Car detailing ASMR", "youtube"),
        ("Thrift flip challenges", "tiktok"), ("#OOTD street fashion", "instagram"),
        ("Tiny house living tours", "youtube"), ("Skincare routine layers", "tiktok"),
        ("Studio apartment hacks", "instagram"), ("3D printing oddities", "youtube"),
        ("Analog photography revival", "tiktok"), ("Pet rescue stories", "instagram"),
        ("Micro-adventure weekends", "youtube"), ("#HairTok curtain bangs", "tiktok"),
        ("Cafe hopping vlogs", "instagram"), ("Coding tutorial series", "youtube"),
        ("Storytime animated shorts", "tiktok"), ("Vintage fashion hauls", "instagram"),
    ]
    # Use date as seed so same day = same fallbacks
    day_seed = int(today.replace("-", ""))
    rng = random.Random(day_seed)
    rng.shuffle(FALLBACK_POOL)

    needed = max(0, 30 - len(all_trends))
    if needed > 0:
        print(f"  ⚠ Only {len(all_trends)} real trends, adding {needed} curated fallbacks")
        scores = ["hot", "rising", "warm"]
        for i, (topic, plat) in enumerate(FALLBACK_POOL[:needed]):
            key = topic.lower()
            if key not in seen:
                seen.add(key)
                emoji = PLATFORM_EMOJI.get(plat, "🔥")
                all_trends.append({
                    "topic": f'{emoji} {topic}',
                    "score": scores[i % 3],
                    "platform": plat,
                    "traffic": 0,
                })

    # Sort: hot first, then rising, then warm
    score_order = {"hot": 0, "rising": 1, "warm": 2}
    all_trends.sort(key=lambda t: (score_order.get(t["score"], 3), -t.get("traffic", 0)))

    # Remove traffic field from output (internal use only)
    for t in all_trends:
        t.pop("traffic", None)

    output = {
        "date": today,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(all_trends),
        "trends": all_trends,
    }

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"  ✅ Wrote {len(all_trends)} trends to {OUTPUT}")
    print(f"  📅 Date: {today}")


if __name__ == "__main__":
    main()
