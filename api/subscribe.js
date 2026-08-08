// Serverless function (Vercel Node.js runtime — zero config, just needs
// to live in /api). Receives the signup form POST and sends two emails
// via Resend: a confirmation to the new user, and a notification to you.
//
// Required env vars (set in Vercel dashboard → Project → Settings → Environment Variables):
//   RESEND_API_KEY   - from resend.com/api-keys
//   FROM_EMAIL        - must be on your verified Resend domain, e.g. "Wavecrest Pro <hello@wavecrestpro.com>"
//   NOTIFY_EMAIL      - where new-signup alerts go, e.g. "hello@wavecrest.pro"
//
// Local testing: `vercel dev` (not the python http.server — that only serves
// static files and has no idea this folder exists).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = (body?.email || '').trim();
  const source = (body?.source || 'unknown').toString().slice(0, 40);

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'That email doesn’t look right' });
  }

  const { RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL } = process.env;
  if (!RESEND_API_KEY || !FROM_EMAIL) {
    console.error('Missing RESEND_API_KEY or FROM_EMAIL env vars');
    return res.status(500).json({ error: 'Server isn’t configured yet — missing email credentials' });
  }

  const sendEmail = (payload) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

  try {
    // 1. Confirmation to the new signup
    const confirmRes = await sendEmail({
      from: FROM_EMAIL,
      to: email,
      subject: "You’re on the Wavecrest Pro early access list",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#1e293b">
          <h2 style="margin-bottom:8px">You’re in 👋</h2>
          <p style="line-height:1.6">
            We’re opening up Wavecrest Pro to early access shortly. When your spot is ready,
            you’ll be able to paste any YouTube channel URL and get a full 7-dimension playbook
            — hook patterns, thumbnail formula, posting cadence, audience profile, content pillars,
            monetization signals, and competitive gaps — in under 90 seconds.
          </p>
          <p style="line-height:1.6">First analysis is free. No card needed. Talk soon.</p>
          <p style="color:#64748b;font-size:13px;margin-top:24px">— Wavecrest Pro</p>
        </div>`
    });
    if (!confirmRes.ok) {
      const detail = await confirmRes.text();
      throw new Error(`Resend confirmation email failed: ${detail}`);
    }

    // 2. Notify the founder (best-effort — don't fail the signup over this one)
    if (NOTIFY_EMAIL) {
      const notifyRes = await sendEmail({
        from: FROM_EMAIL,
        to: NOTIFY_EMAIL,
        subject: `New early access signup: ${email}`,
        html: `<p>New Wavecrest Pro early access signup from <strong>${esc(email)}</strong> (source: ${esc(source)}).</p>`
      });
      if (!notifyRes.ok) console.error('Resend notify email failed:', await notifyRes.text());
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Couldn’t send that — try again in a moment' });
  }
}
