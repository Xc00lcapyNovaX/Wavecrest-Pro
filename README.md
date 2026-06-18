# Wavecrest Pro landing page

Single-file landing page (`index.html`) plus a serverless function
(`api/subscribe.js`) that sends real signup emails through Resend.

## Local preview (static only, no email sending)

```bash
python3 -m http.server 3333
```

This serves `index.html` but **cannot run `api/subscribe.js`** — that's a
serverless function, not a static file. The signup forms will hit a 404
on `/api/subscribe` and show the inline error state. That's expected; it's
just not the full stack.

## Local preview with the API working

```bash
npm i -g vercel   # one-time
vercel dev
```

Copy `.env.example` to `.env` and fill in real values first, or `vercel dev`
will prompt you to link env vars from your Vercel project.

## Deploy

1. Push this folder to a GitHub repo (or run `vercel` directly from here).
2. Import it in [vercel.com](https://vercel.com) — no build settings needed,
   it auto-detects the static `index.html` + `/api` function.
3. In Project Settings → Environment Variables, set:
   - `RESEND_API_KEY` — from resend.com/api-keys
   - `FROM_EMAIL` — an address on the domain you verified in Resend, e.g.
     `"Wavecrest Pro <hello@wavecrestpro.com>"`
   - `NOTIFY_EMAIL` — where you want new-signup alerts sent (optional)
4. Redeploy after setting env vars (Vercel only injects them into new builds).

## What happens on signup

`POST /api/subscribe` with `{ email, source }` →

1. Validates the email format.
2. Sends a confirmation email to the signup via Resend.
3. Sends a "new signup" notification to `NOTIFY_EMAIL` (best-effort — won't
   fail the signup if this one bounces).

No database yet — this just sends mail. If you want to actually store
signups (for the morning-brief pipeline itself, not just the landing page),
that's a separate, bigger build: you'll want a real table for users +
their ICP + daily-send state, not something to bolt onto this function.
