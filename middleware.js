// Vercel Edge Middleware — runs in V8 isolate before the serverless fn.
// Per-IP rate limiting backed by Upstash Redis (KV REST API).
//
// Limits: /api/analyze-stream 5/hr (expensive: YouTube + Groq quota),
//         /api/subscribe      3/hr (sends 2 Resend emails per call).
//
// KV env vars missing: fail OPEN in dev/preview so local work isn't blocked,
// fail CLOSED in production for analyze-stream (misconfig must not expose
// unmetered LLM spend). Transient KV errors always fail open.

const LIMITS = {
  '/api/analyze-stream': { max: 5, windowSecs: 3600, method: 'GET' },
  '/api/subscribe':      { max: 3, windowSecs: 3600, method: 'POST' }
};

export const config = {
  matcher: ['/api/analyze-stream', '/api/subscribe']
};

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  const limit = LIMITS[pathname];
  if (!limit || request.method !== limit.method) return;

  const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    if (process.env.VERCEL_ENV === 'production' && pathname === '/api/analyze-stream') {
      console.error('[middleware] KV env vars missing in production — failing closed');
      return json({ error: 'Service temporarily unavailable', code: 'RATE_LIMITER_DOWN' }, 503);
    }
    return; // dev/preview: fail open
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown';

  const key = `rl:${pathname}:${ip}`;

  // Atomic pipeline: INCR key, then set EXPIRE only if key is new (NX flag)
  const r = await fetch(`${KV_REST_API_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, limit.windowSecs, 'NX']
    ])
  }).catch(() => null);

  if (!r || !r.ok) return; // transient KV error — fail open

  const results = await r.json();
  const count = results[0]?.result ?? 0;

  if (count > limit.max) {
    return json(
      { error: `Rate limit: ${limit.max} requests per hour`, code: 'RATE_LIMITED' },
      429,
      {
        'Retry-After': String(limit.windowSecs),
        'X-RateLimit-Limit': String(limit.max),
        'X-RateLimit-Remaining': '0'
      }
    );
  }
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
