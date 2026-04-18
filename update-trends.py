#!/usr/bin/env python3
"""
Wavecrest Pro — Daily Trend Updater
Fetches real trending topics from free public sources and writes trends.json.
Run daily via cron, GitHub Actions, or manually:  python3 update-trends.py

Priority order: YouTube (primary) > Google Trends > Instagram/TikTok fallbacks
"""

import json, re, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html import unescape
import random, ssl, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(SCRIPT_DIR, "public", "trends.json")

PLATFORM_EMOJI = {"youtube": "▶️", "tiktok": "♪", "instagram": "📸", "general": "🔥"}


# ─── Google Trends RSS (free, no API key) ────────────────────────────
def fetch_google_trends(geo="US"):
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


# ─── YouTube Trending — main feed ────────────────────────────────────
YT_JUNK = {
    "try searching", "keyboard shortcuts", "playback", "subtitles",
    "closed captions", "spherical videos", "navigate", "seek", "change",
    "volume", "full screen", "caption", "skip", "toggle", "mute",
    "previous", "next", "open", "close", "turn on", "turn off",
    "decrease", "increase", "activate", "start watching", "youtube home",
    "rewind", "fast forward", "rotate through", "font size", "text opacity",
    "window opacity", "navigate backward", "navigate forward", "settings",
    "watch later", "save to", "report", "share", "like this", "subscribe",
    "more actions", "miniplayer", "theater mode", "exit full", "annotations",
    "dialog", "chapter", "scrubber", "search with your voice", "queue",
    "autoplay", "ambient mode", "english (auto", "move to", "play next",
    "copy link", "didn't hear", "try again", "tap microphone",
    "microphone off", "check your connection", "waiting for permission",
    "allow microphone", "search with voice", "an error occurred", "no results",
    "sign in", "learn more", "see more", "show more", "show less",
    "search youtube", "upload video", "go live", "create a post",
    "history", "your videos", "your clips", "liked videos",
}

def is_yt_junk(title):
    low = title.lower().strip()
    if len(title) < 12:
        return True
    if any(j in low for j in YT_JUNK):
        return True
    words = low.split()
    if len(words) <= 3 and any(w in {"tap","press","click","allow","deny","wait","shorts"} for w in words):
        return True
    return False

def fetch_youtube_trending():
    """Fetch trending YouTube video titles from multiple feeds."""
    all_titles = []
    seen = set()

    # Main trending feed
    urls = [
        ("https://www.youtube.com/feed/trending", "trending"),
        ("https://www.youtube.com/feed/trending?bp=6gQJRkVleHBsb3Jl", "gaming"),  # Gaming
        ("https://www.youtube.com/feed/trending?bp=4gINGgt5dGRfbXVzaWNfMQ%3D%3D", "music"),  # Music
    ]

    for url, label in urls:
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
            })
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                html = resp.read().decode("utf-8", errors="replace")

            found = 0
            # Primary pattern: videoTitle in structured JSON
            for match in re.finditer(r'"videoTitle"\s*:\s*"([^"]{12,100})"', html):
                t = unescape(match.group(1)).strip()
                k = t.lower()
                if t and k not in seen and not is_yt_junk(t):
                    seen.add(k)
                    all_titles.append(t)
                    found += 1

            # Fallback: runs text pattern
            if found < 5:
                for match in re.finditer(r'"title":\{"runs":\[\{"text":"([^"]{12,100})"\}', html):
                    t = unescape(match.group(1)).strip()
                    k = t.lower()
                    if t and k not in seen and not is_yt_junk(t):
                        seen.add(k)
                        all_titles.append(t)
                        found += 1

            print(f"  ✓ YouTube {label}: {found} titles")
        except Exception as e:
            print(f"[warn] YouTube {label} fetch failed: {e}")

    return all_titles[:40]


# ─── YouTube RSS feeds for creator trends ────────────────────────────
YT_RSS_FEEDS = [
    # Top creator channels — their latest uploads signal what's trending
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA",  # MrBeast
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCnUYZLuoy1rq1aVMwx4aTzw",  # GrahamStephan (Finance)
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCbmNph6atAoGfqLoCL_duAg",  # Technoblade Memorial / top gaming
]

def fetch_youtube_rss_topics():
    """Pull recent video titles from top YouTube RSS feeds as trend signals."""
    topics = []
    seen = set()
    for url in YT_RSS_FEEDS:
        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, headers={"User-Agent": "WavecrestBot/1.0"})
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                data = resp.read().decode("utf-8")
            root = ET.fromstring(data)
            ns = {"media": "http://search.yahoo.com/mrss/", "atom": "http://www.w3.org/2005/Atom"}
            for entry in root.findall(".//atom:entry", ns)[:5]:
                title_el = entry.find("atom:title", ns)
                if title_el is not None and title_el.text:
                    t = unescape(title_el.text.strip())
                    k = t.lower()
                    if t and k not in seen and not is_yt_junk(t) and len(t) > 10:
                        seen.add(k)
                        topics.append(t)
        except Exception:
            pass
    return topics


# ─── Score assignment ─────────────────────────────────────────────────
def assign_score(traffic, rank, total, source_boost=0):
    base = 0
    if traffic > 1000000:
        base = 3
    elif traffic > 500000:
        base = 2.5
    elif traffic > 100000:
        base = 2
    elif traffic > 0:
        base = 1.5

    rank_score = 0
    if rank < total * 0.15:
        rank_score = 3
    elif rank < total * 0.4:
        rank_score = 2
    elif rank < total * 0.7:
        rank_score = 1

    total_score = base + rank_score + source_boost
    if total_score >= 4.5:
        return "hot"
    elif total_score >= 2.5:
        return "rising"
    return "warm"


# ─── Platform assignment ──────────────────────────────────────────────
TIKTOK_KEYWORDS = ["tiktok","dance","challenge","duet","viral","skit","POV","pov","fyp","trend alert"]
INSTA_KEYWORDS  = ["instagram","reel","aesthetic","outfit","fashion","beauty","selfie","photo","ootd","grwm"]
YT_KEYWORDS     = ["youtube","vlog","tutorial","review","stream","episode","series","shorts","gameplay",
                    "unboxing","react","challenge","explained","documentary","podcast","interview"]

def guess_platform(topic):
    low = topic.lower()
    # YouTube signals are strongest
    yt_score = sum(1 for k in YT_KEYWORDS if k in low)
    tt_score = sum(1 for k in TIKTOK_KEYWORDS if k in low)
    ig_score = sum(1 for k in INSTA_KEYWORDS if k in low)

    if yt_score > 0 and yt_score >= tt_score and yt_score >= ig_score:
        return "youtube"
    if tt_score > ig_score:
        return "tiktok"
    if ig_score > 0:
        return "instagram"
    # Default distribution: skew toward YouTube since it's the focus
    return random.choices(["youtube", "tiktok", "instagram", "general"], weights=[45, 25, 20, 10])[0]


# ─── Main ─────────────────────────────────────────────────────────────
def main():
    print("🌊 Wavecrest Pro — Fetching daily trends...")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    all_trends = []
    seen = set()

    # 1. YouTube Trending (PRIMARY source — most weight)
    yt = fetch_youtube_trending()
    print(f"  ✓ YouTube Trending total: {len(yt)} titles")
    for i, title in enumerate(yt):
        key = title.lower()
        if key not in seen:
            seen.add(key)
            score = "hot" if i < 8 else ("rising" if i < 22 else "warm")
            all_trends.append({
                "topic": f"▶️ {title}",
                "score": score,
                "platform": "youtube",
                "traffic": max(0, 500000 - i * 10000),
            })

    # 2. YouTube RSS creator signals
    rss_topics = fetch_youtube_rss_topics()
    for t in rss_topics:
        key = t.lower()
        if key not in seen:
            seen.add(key)
            all_trends.append({
                "topic": f"▶️ {t}",
                "score": "rising",
                "platform": "youtube",
                "traffic": 0,
            })

    # 3. Google Trends (strong signal, cross-platform)
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

    # 4. Pad with curated fallbacks if needed (date-seeded for consistency)
    FALLBACK_POOL = [
        # YouTube-focused (weighted higher)
        ("I Tried This For 30 Days — Here's What Happened", "youtube"),
        ("The Truth About YouTube Shorts in 2026", "youtube"),
        ("My Studio Setup Tour (Full Breakdown)", "youtube"),
        ("Reacting to Viral TikToks So You Don't Have To", "youtube"),
        ("The Ultimate Productivity Setup for Creators", "youtube"),
        ("Honest Review: Best Cameras for YouTube 2026", "youtube"),
        ("Day in the Life: Full-Time YouTuber", "youtube"),
        ("How I Hit 100K Subscribers (What Actually Worked)", "youtube"),
        ("Speed Code Challenge: Build an App in 1 Hour", "youtube"),
        ("Minimalist Apartment Tour — NYC on a Budget", "youtube"),
        # Social/cross-platform
        ("GRWM morning routines", "tiktok"),
        ("Street style lookbooks", "instagram"),
        ("AI music generation tools", "youtube"),
        ("#BookTok dark academia", "tiktok"),
        ("Coffee shop aesthetic reels", "instagram"),
        ("#FitnessTok home workouts", "tiktok"),
        ("Golden hour photography", "instagram"),
        ("Silent vlog trend", "tiktok"),
        ("Meal prep aesthetic reels", "instagram"),
        ("Lo-fi study setups", "youtube"),
        ("#CleanTok deep cleaning", "tiktok"),
        ("Sunset drone cinematography", "instagram"),
        ("Budget travel hacks", "youtube"),
        ("#NailTok chrome art", "tiktok"),
        ("Cottagecore baking reels", "instagram"),
        ("Car detailing ASMR", "youtube"),
        ("Thrift flip challenges", "tiktok"),
        ("#OOTD street fashion", "instagram"),
        ("Tiny house living tours", "youtube"),
        ("Skincare routine layers", "tiktok"),
        ("Studio apartment hacks", "instagram"),
        ("3D printing oddities", "youtube"),
        ("Analog photography revival", "tiktok"),
        ("Pet rescue stories", "instagram"),
        ("Micro-adventure weekends", "youtube"),
        ("#HairTok curtain bangs", "tiktok"),
        ("Cafe hopping vlogs", "instagram"),
        ("Retro gaming nostalgia", "youtube"),
        ("Storytime animated shorts", "tiktok"),
        ("Vintage fashion hauls", "instagram"),
    ]

    day_seed = int(today.replace("-", ""))
    rng = random.Random(day_seed)
    rng.shuffle(FALLBACK_POOL)

    needed = max(0, 30 - len(all_trends))
    if needed > 0:
        print(f"  ⚠ Only {len(all_trends)} real trends, padding with {needed} curated fallbacks")
        scores = ["hot", "rising", "warm"]
        for i, (topic, plat) in enumerate(FALLBACK_POOL[:needed]):
            key = topic.lower()
            if key not in seen:
                seen.add(key)
                emoji = PLATFORM_EMOJI.get(plat, "🔥")
                all_trends.append({
                    "topic": f"{emoji} {topic}",
                    "score": scores[i % 3],
                    "platform": plat,
                    "traffic": 0,
                })

    # Sort: hot first, then by traffic
    score_order = {"hot": 0, "rising": 1, "warm": 2}
    all_trends.sort(key=lambda t: (score_order.get(t["score"], 3), -t.get("traffic", 0)))

    # Remove internal traffic field
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
