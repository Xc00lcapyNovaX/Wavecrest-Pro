#!/usr/bin/env python3
"""
Wavecrest Pro — Daily Trend Updater  v2
Sources (in priority order):
  1. YouTube Data API v3  (set YOUTUBE_API_KEY — free 10k units/day)
  2. Reddit trending       (free JSON API, no key needed)
  3. Google Trends RSS     (free, no key)
  4. YouTube RSS feeds     (creator channels as signal)
  5. YouTube HTML scrape   (last-resort fallback)
  6. Curated fallback pool (if all else returns < 25 trends)

Scoring uses VELOCITY — topics new today or climbing fast score higher.
Run: python3 update-trends.py
"""

import json, re, os, time, ssl, random, math
import urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from html import unescape

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT     = os.path.join(SCRIPT_DIR, "public", "trends.json")

PLATFORM_EMOJI = {"youtube": "▶️", "tiktok": "♪", "instagram": "📸", "reddit": "🔺", "general": "🔥"}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def make_ctx():
    return ssl.create_default_context()

def fetch_url(url, headers=None, timeout=15):
    h = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "application/json, text/html, */*",
    }
    if headers:
        h.update(headers)
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=timeout, context=make_ctx()) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None

def normalize(text):
    t = re.sub(r'^[\U00010000-\U0010ffff\u25b6\ufe0f\u266a\U0001f4f8\U0001f53a\U0001f525\s]+', '', text.strip())
    return re.sub(r'\s+', ' ', t).strip().lower()

JUNK_PHRASES = {
    "try searching","keyboard shortcuts","playback","subtitles","closed captions",
    "navigate","seek","volume","full screen","caption","skip","toggle","mute",
    "previous","next","turn on","turn off","decrease","increase","activate",
    "start watching","youtube home","rewind","fast forward","settings",
    "watch later","save to","report","share","like this","subscribe",
    "more actions","miniplayer","theater mode","annotations","dialog","chapter",
    "search with your voice","queue","autoplay","ambient mode","sign in",
    "learn more","see more","show more","show less","search youtube",
    "upload video","go live","an error occurred","no results","try again",
    "check your connection","history","liked videos","your videos","loading",
}

def is_junk(title):
    if len(title) < 8:
        return True
    low = title.lower().strip()
    if any(j in low for j in JUNK_PHRASES):
        return True
    words = low.split()
    if len(words) <= 2 and any(w in {"tap","press","click","allow","deny","wait","shorts","next","back"} for w in words):
        return True
    return False

# ─── YouTube title cleaner ────────────────────────────────────────────────────
# Strips video-specific boilerplate so we store concepts, not video titles.

_YT_SUFFIX_RE = re.compile(
    r'\s*[\|\u2014\u2013]\s*.+$'            # everything after  |  —  –
    r'|\s*\((?:'
        r'official\s+(?:video|audio|music\s+video|lyric[s]?\s+video|visualizer|mv)'
        r'|lyric[s]?\s+video|music\s+video|audio|visualizer|animated\s+video'
        r'|full\s+video|hd|4k|remaster(?:ed)?|live\s+performance'
        r'|feat\.?\s+[^)]+|ft\.?\s+[^)]+|explicit'
        r'|track\s+\d+|ep\s+\d+|episode\s+\d+|season\s+\d+'
    r')\)'
    r'|\s+(?:official\s+)?(?:music\s+)?video$'
    r'|\s+\|\s+.*$',
    re.IGNORECASE,
)

_MUSIC_DASH_RE = re.compile(r'^(.+?)\s+[-\u2014]\s+(.+)$')

def clean_youtube_title(raw: str) -> str:
    """Return a clean concept string from a raw YouTube video title."""
    t = raw.strip()

    # Drop everything after a pipe or em/en-dash used as separator (e.g. "| Track 5")
    t = re.sub(r'\s*[|\u2014\u2013].*$', '', t).strip()

    # Strip trailing boilerplate parentheticals: (Official Video), (Lyric Video), (4K), etc.
    t = _YT_SUFFIX_RE.sub('', t).strip()

    # Strip prize/result suffixes common in challenge videos:
    # "Last To Leave Grocery Store, Wins $250,000"  →  "Last To Leave Grocery Store"
    t = re.sub(
        r',\s*(?:wins?|gets?|earns?|loses?|takes?|prize[sd]?|reward[sd]?)\s+[\$£€][\d,\.]+[kKmMbB]?.*$',
        '', t, flags=re.IGNORECASE
    ).strip()

    # Strip leading/trailing decorative non-ASCII (emoji, foreign brackets, etc.)
    t = re.sub(r'^[\W\s]+', '', t).strip()
    t = re.sub(r'[\W\s]+$', '', t).strip()

    # Handle multi-segment "Artist - ForeignText - EnglishSong" patterns:
    # Split on " - " and drop any segment where >40% of characters are non-ASCII.
    def non_ascii_ratio(s):
        return sum(1 for c in s if ord(c) > 127) / max(len(s), 1)

    parts = [p.strip() for p in re.split(r'\s+-\s+', t)]
    if len(parts) > 1:
        clean_parts = [p for p in parts if non_ascii_ratio(p) <= 0.4]
        if clean_parts:
            t = ' - '.join(clean_parts)

    # Remove any dangling open/close parentheses left after stripping
    t = re.sub(r'\s*\([^)]*$', '', t).strip()   # unclosed (
    t = re.sub(r'^\s*[^(]*\)', '', t).strip()    # leading )

    # Collapse whitespace and cap length
    t = re.sub(r'\s+', ' ', t).strip()
    if len(t) > 80:
        t = t[:77].rsplit(' ', 1)[0] + '…'

    return t

def load_yesterday():
    try:
        with open(OUTPUT, "r", encoding="utf-8") as f:
            data = json.load(f)
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        today     = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if data.get("date") in (yesterday, today):
            return {normalize(t["topic"]): i for i, t in enumerate(data.get("trends", []))}
    except Exception:
        pass
    return {}


# ─── Source 1: YouTube Data API v3 ───────────────────────────────────────────

def fetch_youtube_api(api_key, region="US"):
    categories = [("", "overall"), ("20", "gaming"), ("10", "music"), ("24", "entertainment")]
    seen, titles = set(), []
    for cat_id, label in categories:
        params = {"part":"snippet","chart":"mostPopular","regionCode":region,"maxResults":"50","key":api_key}
        if cat_id:
            params["videoCategoryId"] = cat_id
        url = "https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(params)
        raw = fetch_url(url, headers={"Accept": "application/json"})
        if not raw:
            print(f"  [warn] YouTube API ({label}): no response")
            continue
        try:
            data = json.loads(raw)
        except Exception:
            print(f"  [warn] YouTube API ({label}): bad JSON")
            continue
        if "error" in data:
            print(f"  [warn] YouTube API error: {data['error'].get('message','?')}")
            break
        found = 0
        for item in data.get("items", []):
            raw = item.get("snippet", {}).get("title", "").strip()
            t = clean_youtube_title(raw)
            k = normalize(t)
            if t and k not in seen and not is_junk(t):
                seen.add(k); titles.append(t); found += 1
        print(f"  ✓ YouTube API ({label}): {found} titles")
        time.sleep(0.1)
    return titles


# ─── Source 2: Reddit ─────────────────────────────────────────────────────────

SUBREDDIT_MAP = {
    # YouTube / video
    "videos": "youtube", "youtubers": "youtube", "gaming": "youtube",
    "games": "youtube", "pcgaming": "youtube", "leagueoflegends": "youtube",
    "minecraft": "youtube", "livestreamfail": "youtube", "speedrun": "youtube",
    "indiegaming": "youtube", "gamedev": "youtube",
    # TikTok / short-form
    "tiktokcringe": "tiktok", "TikTokTrends": "tiktok", "dankmemes": "tiktok",
    "memes": "tiktok",
    # Instagram
    "Instagram": "instagram", "malefashionadvice": "instagram",
    "femalefashionadvice": "instagram", "streetwear": "instagram",
    "skincareaddiction": "instagram",
    # General / news
    "technology": "general", "programming": "general", "worldnews": "general",
    "entertainment": "general", "Music": "youtube", "movies": "general",
    "television": "general", "comicbooks": "general", "sports": "general",
    "space": "general", "science": "general", "futurology": "general",
    "artificial": "general", "ChatGPT": "general", "MachineLearning": "general",
    "fitness": "instagram", "running": "general", "personalfinance": "general",
    "investing": "general", "cryptocurrency": "general",
}
REDDIT_JUNK = [r"^\[", r"^AITA", r"^CMV", r"^ELI5", r"^Daily", r"^Weekly", r"^Monthly"]

def clean_reddit_title(t):
    t = re.sub(r'^\[[^\]]{1,25}\]\s*', '', t)
    t = re.sub(r'\s*\[(video|gif|image|oc|nsfw|meta|xpost)\]$', '', t, flags=re.I)
    return t.strip()

def is_reddit_junk(title):
    if len(title) < 10:
        return True
    for p in REDDIT_JUNK:
        if re.search(p, title, re.I):
            return True
    return False

def fetch_reddit_trending():
    results, seen = [], set()
    for sub, platform in SUBREDDIT_MAP.items():
        url = f"https://www.reddit.com/r/{sub}/hot.json?limit=15&raw_json=1"
        raw = fetch_url(url, headers={"User-Agent": "WavecrestBot/2.0 (wavecrest.pro)"})
        if not raw:
            print(f"  [warn] Reddit r/{sub}: no response")
            time.sleep(0.3); continue
        try:
            posts = json.loads(raw)["data"]["children"]
        except Exception:
            print(f"  [warn] Reddit r/{sub}: bad JSON")
            time.sleep(0.3); continue
        found = 0
        for post in posts:
            d = post.get("data", {})
            if d.get("stickied") or d.get("pinned"): continue
            if d.get("score", 0) < 50: continue
            title = clean_reddit_title(d.get("title", "").strip())
            if not title or is_junk(title) or is_reddit_junk(title): continue
            key = normalize(title)
            if key in seen: continue
            seen.add(key)
            results.append({"topic": title, "platform": platform, "raw_score": d.get("score", 0), "source": "reddit"})
            found += 1
        print(f"  ✓ Reddit r/{sub}: {found} posts")
        time.sleep(0.4)
    return results


# ─── Source 3: Google Trends RSS ─────────────────────────────────────────────

def fetch_google_trends_geo(geo):
    raw = fetch_url(f"https://trends.google.com/trending/rss?geo={geo}", headers={"User-Agent": "WavecrestBot/2.0"})
    trends = []
    if not raw:
        print(f"  [warn] Google Trends RSS ({geo}): no response"); return trends
    try:
        root = ET.fromstring(raw)
        ns = {"ht": "https://trends.google.com/trending/rss"}
        for item in root.findall(".//item"):
            title = item.findtext("title", "").strip()
            el    = item.find("ht:approx_traffic", ns)
            traffic = int(re.sub(r"[^\d]", "", el.text.strip() if el is not None else "0") or 0)
            if title and len(title) > 2:
                trends.append({"topic": title, "traffic": traffic})
        print(f"  ✓ Google Trends ({geo}): {len(trends)} topics")
    except Exception as e:
        print(f"  [warn] Google Trends ({geo}) parse error: {e}")
    return trends

def fetch_google_trends(geo="US"):
    seen, combined = set(), []
    for region in ["US", "GB", "AU", "CA"]:
        for item in fetch_google_trends_geo(region):
            key = normalize(item["topic"])
            if key not in seen:
                seen.add(key)
                combined.append(item)
        time.sleep(0.3)
    return combined


# ─── Source 4: YouTube RSS creator feeds ─────────────────────────────────────

YT_RSS_FEEDS = [
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA",  # MrBeast
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCnUYZLuoy1rq1aVMwx4aTzw",  # GrahamStephan
    "https://www.youtube.com/feeds/videos.xml?channel_id=UC-lHJZR3Gqxm24_Vd_AJ5Yw",  # PewDiePie
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCam8T03EOFBsNdR0thrFHdQ",  # Veritasium
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCVjgV3uCgF8bnYPsqZFnFDA",  # MKBHD
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCo8bcnLyZH8tBIH9V1mLgqQ",  # Théo Joe
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA",  # Vsauce
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCR1IuLEqb6UEA_zQ81kwXfg",  # Linus Tech Tips
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCddiUEpeqJcYeBxX1IVBKvQ",  # The Try Guys
    "https://www.youtube.com/feeds/videos.xml?channel_id=UC7_YxT-KID8kRbqZo7MyscQ",  # Markiplier
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCpB959t8iPrxQWj7G6n0ctQ",  # SciShow
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ",  # MKBHD backup
    "https://www.youtube.com/feeds/videos.xml?channel_id=UC0e3QhIYukixgh5VVpKHH9Q",  # Code Bullet
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCvJJ_dzjViJCoLf5uKUTwoA",  # CGPT explainers
]

def fetch_youtube_rss():
    topics, seen = [], set()
    for url in YT_RSS_FEEDS:
        raw = fetch_url(url, headers={"User-Agent": "WavecrestBot/2.0"})
        if not raw: continue
        try:
            root = ET.fromstring(raw)
            ns = {"atom": "http://www.w3.org/2005/Atom"}
            for entry in root.findall(".//atom:entry", ns)[:6]:
                el = entry.find("atom:title", ns)
                if el is not None and el.text:
                    t = clean_youtube_title(unescape(el.text.strip()))
                    k = normalize(t)
                    if t and k not in seen and not is_junk(t) and len(t) > 10:
                        seen.add(k); topics.append(t)
        except Exception:
            pass
    return topics


# ─── Source 5: YouTube HTML scrape (last resort) ─────────────────────────────

def fetch_youtube_html():
    seen, titles = set(), []
    for url in ["https://www.youtube.com/feed/trending", "https://www.youtube.com/feed/trending?bp=6gQJRkVleHBsb3Jl"]:
        raw = fetch_url(url)
        if not raw: continue
        for pattern in [r'"videoTitle"\s*:\s*"([^"]{12,120})"', r'"title":\{"runs":\[\{"text":"([^"]{12,120})"\}']:
            for m in re.finditer(pattern, raw):
                t = clean_youtube_title(unescape(m.group(1)).strip())
                k = normalize(t)
                if t and k not in seen and not is_junk(t):
                    seen.add(k); titles.append(t)
    if titles:
        print(f"  ✓ YouTube HTML scrape: {len(titles)} titles")
    return titles[:30]


# ─── Scoring ─────────────────────────────────────────────────────────────────

SOURCE_QUALITY = {"youtube_api":3.0,"reddit":2.0,"google_trends":2.0,"youtube_rss":1.5,"youtube_html":1.0,"fallback":0.0}

def compute_score(topic_raw, rank, total, source, raw_score=0, yesterday_map=None):
    pts = 0.0
    frac = rank / max(total, 1)
    if frac < 0.20:   pts += 3.0
    elif frac < 0.45: pts += 2.0
    elif frac < 0.70: pts += 1.0
    pts += SOURCE_QUALITY.get(source, 0.5)
    if raw_score > 0:
        pts += min(1.5, math.log10(raw_score + 1) / 4)
    if yesterday_map:
        key = normalize(topic_raw)
        if key not in yesterday_map:
            pts += 1.5
        else:
            prev_frac = yesterday_map[key] / max(len(yesterday_map), 1)
            if frac < prev_frac - 0.15:
                pts += 0.8
    if pts >= 4.0: return "hot"
    if pts >= 2.5: return "rising"
    return "warm"


# ─── Platform guesser ────────────────────────────────────────────────────────

YT_KW = ["youtube","vlog","tutorial","review","stream","episode","series","shorts","gameplay","unboxing","react","challenge","explained","documentary","podcast","interview","minecraft","roblox","fortnite","speedrun","gaming"]
TT_KW = ["tiktok","dance","duet","skit","pov","fyp","trend alert","transition","viral"]
IG_KW = ["instagram","reel","aesthetic","outfit","fashion","beauty","selfie","ootd","grwm","golden hour","photodump","carousel"]

def guess_platform(topic):
    low = topic.lower()
    yt = sum(1 for k in YT_KW if k in low)
    tt = sum(1 for k in TT_KW if k in low)
    ig = sum(1 for k in IG_KW if k in low)
    if yt > 0 and yt >= tt and yt >= ig: return "youtube"
    if tt > ig: return "tiktok"
    if ig > 0:  return "instagram"
    return "general"


# ─── Fallbacks ───────────────────────────────────────────────────────────────

FALLBACK_POOL = [
    ("I Tried This For 30 Days — Here's What Happened","youtube"),
    ("The Truth About YouTube Shorts in 2026","youtube"),
    ("My Studio Setup Tour (Full Breakdown)","youtube"),
    ("How I Hit 100K Subscribers (What Actually Worked)","youtube"),
    ("Speed Code Challenge: Build an App in 1 Hour","youtube"),
    ("Honest Review: Best Cameras for YouTube 2026","youtube"),
    ("Day in the Life: Full-Time YouTuber","youtube"),
    ("AI music generation tools","youtube"),
    ("Lo-fi study setups","youtube"),
    ("Budget travel hacks","youtube"),
    ("Retro gaming nostalgia","youtube"),
    ("3D printing oddities","youtube"),
    ("Micro-adventure weekends","youtube"),
    ("Tiny house living tours","youtube"),
    ("GRWM morning routines","tiktok"),
    ("#BookTok dark academia","tiktok"),
    ("#FitnessTok home workouts","tiktok"),
    ("#CleanTok deep cleaning","tiktok"),
    ("Silent vlog trend","tiktok"),
    ("Thrift flip challenges","tiktok"),
    ("Analog photography revival","tiktok"),
    ("Skincare routine layers","tiktok"),
    ("Street style lookbooks","instagram"),
    ("Coffee shop aesthetic reels","instagram"),
    ("Golden hour photography","instagram"),
    ("Meal prep aesthetic reels","instagram"),
    ("Sunset drone cinematography","instagram"),
    ("#OOTD street fashion","instagram"),
    ("Studio apartment hacks","instagram"),
    ("Cafe hopping vlogs","instagram"),
]


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    print("🌊 Wavecrest Pro — Fetching daily trends (v2)...")
    today         = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    yesterday_map = load_yesterday()
    print(f"  📅 {today}  |  {len(yesterday_map)} yesterday trends for velocity scoring")

    all_trends, seen = [], set()

    def add(topic, platform, source, raw_score=0):
        key = normalize(topic)
        if key in seen or len(key) < 5: return False
        seen.add(key)
        emoji = PLATFORM_EMOJI.get(platform, "🔥")
        all_trends.append({"_raw": topic, "topic": f"{emoji} {topic}", "platform": platform, "source": source, "raw_score": raw_score})
        return True

    # 1. YouTube API
    yt_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if yt_key and yt_key not in ("", "PLACEHOLDER"):
        print("\n[YouTube Data API v3]")
        for t in fetch_youtube_api(yt_key): add(t, "youtube", "youtube_api")
    else:
        print("\n[YouTube API] No YOUTUBE_API_KEY — skipping. Add it for best results.")

    # 2. Reddit
    print("\n[Reddit]")
    for r in fetch_reddit_trending(): add(r["topic"], r["platform"], "reddit", r["raw_score"])

    # 3. Google Trends
    print("\n[Google Trends RSS]")
    for item in fetch_google_trends():
        platform = guess_platform(item["topic"])
        if platform == "youtube" and not any(k in item["topic"].lower() for k in ["youtube","video","stream","vlog","gameplay"]):
            platform = "general"
        add(item["topic"], platform, "google_trends", item["traffic"])
    print(f"  Total Google Trends added: {sum(1 for t in all_trends if t['source']=='google_trends')}")

    # 4. YouTube RSS
    print("\n[YouTube RSS (creator feeds)]")
    for t in fetch_youtube_rss(): add(t, "youtube", "youtube_rss")
    print(f"  Total RSS added: {sum(1 for t in all_trends if t['source']=='youtube_rss')}")

    # 5. HTML scrape (only if thin)
    if len(all_trends) < 35:
        print("\n[YouTube HTML scrape — fallback]")
        for t in fetch_youtube_html(): add(t, "youtube", "youtube_html")

    real_count = len(all_trends)
    print(f"\n  Real trends collected: {real_count}")

    # 6. Curated fallbacks
    needed = max(0, 40 - real_count)
    if needed > 0:
        print(f"  ⚠  Padding with {needed} curated fallbacks")
        rng = random.Random(int(today.replace("-", "")))
        pool = list(FALLBACK_POOL); rng.shuffle(pool)
        for topic, plat in pool:
            if needed <= 0: break
            if add(topic, plat, "fallback"): needed -= 1

    # Score
    total = len(all_trends)
    for i, t in enumerate(all_trends):
        t["score"] = compute_score(t["_raw"], i, total, t["source"], t.get("raw_score", 0), yesterday_map)

    # Sort
    SCORE_ORDER  = {"hot":0,"rising":1,"warm":2}
    SOURCE_ORDER = {"youtube_api":0,"reddit":1,"google_trends":1,"youtube_rss":2,"youtube_html":3,"fallback":4}
    all_trends.sort(key=lambda t: (SCORE_ORDER.get(t["score"],3), SOURCE_ORDER.get(t["source"],5), -t.get("raw_score",0)))

    sources = {}
    for t in all_trends: sources[t["source"]] = sources.get(t["source"], 0) + 1

    output = {
        "date":       today,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "count":      len(all_trends),
        "sources":    sources,
        "trends":     [{"topic": t["topic"], "score": t["score"], "platform": t["platform"]} for t in all_trends],
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n  ✅ Wrote {len(all_trends)} trends → {OUTPUT}")
    print(f"  📊 Sources: {sources}")

if __name__ == "__main__":
    main()
