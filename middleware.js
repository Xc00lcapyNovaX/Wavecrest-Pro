// Vercel Edge Middleware — runs in V8 isolate before the serverless fn.
// Rate-limits /api/analyze-stream to RATE_LIMIT requests per WINDOW_SECS per IP.
// Fails open if KV env vars aren't set (so dev still works without KV).

const RATE_LIMIT  = 5;     // analyses per IP
const WINDOW_SECS = 3600;  // per hour

export const config = {
  matcher: '/api/analyze-stream'
};

export default async function middleware(request) {
  const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return; // fail open

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown';

  const key = `rl:analyze:${ip}`;

  // Atomic pipeline: INCR key, then set EXPIRE only if key is new (NX flag)
  const r = await fetch(`${KV_REST_API_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, WINDOW_SECS, 'NX']
    ])
  });

  if (!r.ok) return; // KV error — fail open

  const results = await r.json();
  const count = results[0]?.result ?? 0;

  if (count > RATE_LIMIT) {
    return new Response(
      JSON.stringify({ error: `Rate limit: ${RATE_LIMIT} analyses per hour per IP` }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(WINDOW_SECS),
          'X-RateLimit-Limit': String(RATE_LIMIT),
          'X-RateLimit-Remaining': '0'
        }
      }
    );
  }

  // Pass the remaining count downstream as a header (optional, useful for debugging)
  const res = new Response(null, { status: 200 });
  res.headers.set('X-RateLimit-Remaining', String(RATE_LIMIT - count));
  return; // continue to serverless fn
}
