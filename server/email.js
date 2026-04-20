/**
 * Wavecrest Pro — Email service via Resend
 */
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || 'Wavecrest Pro <noreply@wavecrest.pro>';
const configured = !!process.env.RESEND_API_KEY;

if (!configured) {
  console.warn('[Email] RESEND_API_KEY not set — emails will be logged to console only.');
}

async function send({ to, subject, html }) {
  if (!configured) {
    console.log(`[Email DEV] To: ${to} | Subject: ${subject}`);
    return;
  }
  const { error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error(`[Email] Resend error: ${error.message}`);
}

// ── Templates ──────────────────────────────────────────────────────────────

function baseTemplate(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wavecrest Pro</title>
</head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f7">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 0">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#1a1a1f;border-radius:16px;border:1px solid rgba(255,255,255,.08);overflow:hidden">
      <!-- Header -->
      <tr><td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,.06)">
        <span style="font-size:1.3rem;font-weight:700;color:#f5f5f7">Wavecrest <span style="color:#0071e3">Pro</span></span>
      </td></tr>
      <!-- Body -->
      <tr><td style="padding:36px 40px">
        ${content}
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,.06)">
        <p style="margin:0;font-size:.78rem;color:#636366">You received this because you have an account at <a href="https://wavecrest.pro" style="color:#0071e3;text-decoration:none">wavecrest.pro</a>. If this was unexpected, you can ignore it.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function btnStyle() {
  return 'display:inline-block;padding:14px 28px;background:#0071e3;color:#fff;text-decoration:none;border-radius:10px;font-size:.95rem;font-weight:600;margin:24px 0';
}

// ── Verification email ─────────────────────────────────────────────────────

async function sendVerificationEmail({ to, token, baseUrl }) {
  const link = `${baseUrl}/verify?token=${token}&type=verify`;
  const html = baseTemplate(`
    <h2 style="margin:0 0 12px;font-size:1.4rem;font-weight:700">Verify your email</h2>
    <p style="margin:0 0 8px;color:#adadb8;line-height:1.6">Thanks for signing up! Click the button below to confirm your email address and activate your Wavecrest Pro account.</p>
    <p style="margin:4px 0 0;color:#636366;font-size:.85rem">This link expires in 24 hours.</p>
    <div style="text-align:center">
      <a href="${link}" style="${btnStyle()}">Verify Email</a>
    </div>
    <p style="margin:0;color:#636366;font-size:.82rem;text-align:center">Or paste this link into your browser:<br>
      <span style="color:#0071e3;word-break:break-all">${link}</span>
    </p>
  `);
  await send({ to, subject: 'Verify your Wavecrest Pro email', html });
}

// ── Magic link email ───────────────────────────────────────────────────────

async function sendMagicLink({ to, token, baseUrl }) {
  const link = `${baseUrl}/verify?token=${token}&type=magic`;
  const html = baseTemplate(`
    <h2 style="margin:0 0 12px;font-size:1.4rem;font-weight:700">Your sign-in link</h2>
    <p style="margin:0 0 8px;color:#adadb8;line-height:1.6">Click the button below to sign in to Wavecrest Pro. No password needed.</p>
    <p style="margin:4px 0 0;color:#636366;font-size:.85rem">This link expires in 15 minutes and can only be used once.</p>
    <div style="text-align:center">
      <a href="${link}" style="${btnStyle()}">Sign In to Wavecrest Pro</a>
    </div>
    <p style="margin:0;color:#636366;font-size:.82rem;text-align:center">Or paste this link into your browser:<br>
      <span style="color:#0071e3;word-break:break-all">${link}</span>
    </p>
    <p style="margin:16px 0 0;color:#636366;font-size:.82rem;text-align:center">Didn't request this? You can safely ignore this email.</p>
  `);
  await send({ to, subject: 'Your Wavecrest Pro sign-in link', html });
}

// ── Daily digest email ─────────────────────────────────────────────────────

function scoreEmoji(score) {
  return score === 'hot' ? '🔥' : score === 'rising' ? '📈' : '🌊';
}

function scoreBadge(score) {
  const colors = {
    hot:    { bg: 'rgba(255,69,58,.18)',  text: '#ff453a' },
    rising: { bg: 'rgba(48,209,88,.18)', text: '#30d158' },
    warm:   { bg: 'rgba(255,159,10,.18)',text: '#ff9f0a' },
  };
  const c = colors[score] || colors.warm;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:980px;font-size:.72rem;font-weight:700;text-transform:uppercase;background:${c.bg};color:${c.text}">${score}</span>`;
}

function platformLabel(platform) {
  const labels = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', reddit: 'Reddit', general: 'General' };
  return labels[platform] || platform;
}

async function sendDailyDigest({ to, name, trends, date, baseUrl, unsubscribeToken }) {
  const displayDate = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const unsubUrl = `${baseUrl}/api/auth/unsubscribe?token=${unsubscribeToken}`;

  const trendRows = trends.slice(0, 10).map((t, i) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="28" style="color:#636366;font-size:.82rem;font-weight:600;vertical-align:top;padding-top:2px">${i + 1}</td>
            <td style="vertical-align:top">
              <div style="font-weight:600;color:#f5f5f7;font-size:.95rem;margin-bottom:4px">${scoreEmoji(t.score)} ${t.topic}</div>
              <div style="font-size:.78rem;color:#636366">${platformLabel(t.platform)}</div>
            </td>
            <td width="70" style="text-align:right;vertical-align:top;padding-top:2px">${scoreBadge(t.score)}</td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  const hotCount  = trends.filter(t => t.score === 'hot').length;
  const riseCount = trends.filter(t => t.score === 'rising').length;

  const html = baseTemplate(`
    <h2 style="margin:0 0 6px;font-size:1.35rem;font-weight:700">Your daily trend briefing</h2>
    <p style="margin:0 0 24px;color:#636366;font-size:.88rem">${displayDate}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td width="48%" style="background:rgba(255,69,58,.08);border-radius:10px;padding:14px 16px;text-align:center">
          <div style="font-size:1.6rem;font-weight:700;color:#ff453a">${hotCount}</div>
          <div style="font-size:.78rem;color:#636366;margin-top:2px">🔥 Hot trends</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:rgba(48,209,88,.08);border-radius:10px;padding:14px 16px;text-align:center">
          <div style="font-size:1.6rem;font-weight:700;color:#30d158">${riseCount}</div>
          <div style="font-size:.78rem;color:#636366;margin-top:2px">📈 Rising trends</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${trendRows}
    </table>

    <div style="text-align:center;margin-top:28px">
      <a href="${baseUrl}/dashboard" style="${btnStyle()}">Open Dashboard →</a>
    </div>

    <p style="margin:28px 0 0;font-size:.78rem;color:#636366;text-align:center">
      You're receiving this because you signed up for daily trend updates.<br>
      <a href="${unsubUrl}" style="color:#636366">Unsubscribe</a>
    </p>
  `);

  await send({ to, subject: `🌊 ${hotCount} hot trends today — ${displayDate}`, html });
}

module.exports = { sendVerificationEmail, sendMagicLink, sendDailyDigest };
