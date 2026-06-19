const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';

export function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

export function computeCadence(videos) {
  if (videos.length < 2) return {};
  const dates = videos.map(v => new Date(v.publishedAt)).filter(d => !isNaN(d)).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86400000);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayCount = new Array(7).fill(0);
  dates.slice(-60).forEach(d => dayCount[d.getDay()]++);
  const peakDay = dayNames[dayCount.indexOf(Math.max(...dayCount))];
  const durations = videos.map(v => v.duration).filter(d => d > 0);
  const avgDurationSec = durations.reduce((a, b) => a + b, 0) / (durations.length || 1);
  return {
    avgDaysBetweenVideos: Math.round(avgGap * 10) / 10,
    videosPerMonth: Math.round((30 / avgGap) * 10) / 10,
    peakDay,
    avgDurationMinutes: Math.round(avgDurationSec / 60 * 10) / 10,
    shortestMinutes: Math.round(Math.min(...durations) / 60 * 10) / 10,
    longestMinutes: Math.round(Math.max(...durations) / 60 * 10) / 10
  };
}

export async function runAnalysis(channel, videos, groqKey) {
  const cadence = computeCadence(videos);
  const byViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
  const top20 = byViews.slice(0, 20);
  const recent = videos.slice(0, 30);

  const videoList = (arr, includeStats = true) =>
    arr.map((v, i) => {
      const stats = includeStats
        ? ` | ${fmtNum(v.viewCount)} views | ${Math.round(v.duration / 60)}min`
        : ` | ${v.publishedAt.slice(0, 10)}`;
      return `${i + 1}. "${v.title}"${stats}`;
    }).join('\n');

  const topViewsAvg = top20.reduce((a, v) => a + v.viewCount, 0) / top20.length;
  const allViewsAvg = videos.reduce((a, v) => a + v.viewCount, 0) / videos.length;
  const outperformers = top20.filter(v => v.viewCount > topViewsAvg * 1.5);
  const channelAgeMonths = channel.publishedAt
    ? Math.max(1, (Date.now() - new Date(channel.publishedAt)) / (1000 * 60 * 60 * 24 * 30))
    : 12;
  const estimatedMonthlyViews = Math.round(channel.viewCountTotal / channelAgeMonths);

  const prompt = `You are a creator intelligence analyst. Study the video titles and stats below. Return ONLY a JSON object — no other text.

CRITICAL RULES:
1. CITE SPECIFIC TITLES by number (e.g. "video #3"). Never make generic statements.
2. GAPS must be topics appearing ZERO times in the title list.
3. MONETIZATION SIGNALS must be exact observations from titles/descriptions, not guesses.
4. HOOK PATTERNS must include verbatim word structures from actual titles.
5. Never state things obvious from the channel name alone.

CHANNEL: ${channel.name}${channel.handle ? ' (' + channel.handle + ')' : ''}
Subscribers: ${fmtNum(channel.subscriberCount)} | Total views: ${fmtNum(channel.viewCountTotal)}
Channel avg views: ${fmtNum(Math.round(allViewsAvg))} | Top 20 avg: ${fmtNum(Math.round(topViewsAvg))}
Description: ${channel.description}

TOP 20 VIDEOS BY VIEWS:
${videoList(top20)}

OUTPERFORMERS (>${fmtNum(Math.round(topViewsAvg * 1.5))} views):
${outperformers.map(v => `"${v.title}" | ${fmtNum(v.viewCount)} views`).join('\n') || 'None significantly above average'}

RECENT 30 VIDEOS:
${videoList(recent, false)}

CADENCE:
- Avg ${cadence.avgDaysBetweenVideos} days between uploads (~${cadence.videosPerMonth}/month)
- Peak day: ${cadence.peakDay} | Avg duration: ${cadence.avgDurationMinutes}min (range: ${cadence.shortestMinutes}–${cadence.longestMinutes}min)
- Estimated monthly views: ~${fmtNum(estimatedMonthlyViews)}

Return JSON with exactly these keys:
hooks: { primaryPattern: "Verbatim structural formula from actual titles", examples: ["3 real titles"], frequency: "X of top 20", secondaryPatterns: ["2nd", "3rd"] }
thumbnails: { formula: "Specific visual approach", characteristics: ["3 elements"], textOverlayStyle: "Text style" }
cadence: { schedule: "Specific pattern with numbers", consistency: "Erratic or clockwork", durationStrategy: "What the range reveals", peakPerformanceWindow: "When outperformers cluster" }
audience: { primaryProfile: "Specific psychographic", estimatedAge: "Range", viewerIntent: "One sentence", loyaltySignal: "Engagement observation" }
pillars: [3: { name: "Label", percentage: number (sum 100), description: "Which videos + performance" }]
monetization: { primaryApproach: "Model with evidence or 'No clear signals — likely AdSense'", signals: ["Evidence from titles only — omit if none"], brandAffinities: "Specific brands/categories" }
gaps: [3: { opportunity: "Topic appearing ZERO times in titles", rationale: "Cite video numbers" }]
earningsEstimate: { monthlyViewsEstimate: ${estimatedMonthlyViews}, cpmRPM: "Pick: Finance $5-17 | Insurance $7-17 | Legal $5-15 | Real Estate $5-13 | Health/Medical $7-22 | Crypto $5-13 | AI/Tech $4-10 | B2B SaaS $4-12 | Marketing $4-9 | Education $3-8 | Consumer Tech $2-10 | Automotive $4-9 | Food/Cooking $2-5 | Beauty $2-5 | Travel $2-6 | DIY $2-6 | Parenting $3-6 | Gaming $1-5 | Entertainment $1-4 | Music $0.5-1.5. State niche and RPM range.", estimatedMonthlyAdRevenue: "low=monthlyViews*RPM_low/1000, high=monthlyViews*RPM_high/1000, show math", otherRevenue: "Evidence-based or 'unclear from data'", totalEstimate: "'$X,000–$Y,000/month'" }
videoIdeas: [5: { title: "Ready-to-publish title in creator's style", rationale: "Cite top performers", estimatedPerformance: "vs ${fmtNum(Math.round(allViewsAvg))} avg" }]`;

  const r = await fetch(GROQ_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are a creator intelligence analyst. Always respond with valid JSON only — no markdown, no explanation.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' }
    })
  });

  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`AI analysis failed (${r.status}): ${err.slice(0, 200)}`);
  }

  const data = await r.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI returned empty response — try again');

  const aiAnalysis = JSON.parse(text);
  return {
    ...aiAnalysis,
    cadence: {
      ...aiAnalysis.cadence,
      avgDaysBetweenVideos: cadence.avgDaysBetweenVideos,
      videosPerMonth: cadence.videosPerMonth,
      peakDay: cadence.peakDay,
      avgDurationMinutes: cadence.avgDurationMinutes
    }
  };
}
