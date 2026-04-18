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
  const link = `${baseUrl}/verify.html?token=${token}&type=verify`;
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
  const link = `${baseUrl}/verify.html?token=${token}&type=magic`;
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

module.exports = { sendVerificationEmail, sendMagicLink };
