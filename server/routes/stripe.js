/**
 * Stripe routes (mock) — checkout, webhooks, portal
 * All endpoints use dummy URLs. Replace with real Stripe calls later.
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const router = express.Router();

// Plan config with pricing
const PLANS = {
  free:       { name: 'Free',       price: 0,     stripe_price: 'price_FREE_PLACEHOLDER' },
  plus:       { name: 'Plus',       price: 999,   stripe_price: 'price_PLUS_PLACEHOLDER',       trial_days: 7 },
  pro:        { name: 'Pro',        price: 2499,  stripe_price: 'price_PRO_PLACEHOLDER',         intro_price: 1499, intro_months: 3 },
  max:        { name: 'Max',        price: 9999,  stripe_price: 'price_MAX_PLACEHOLDER',         intro_price: 5999, intro_months: 3 },
  teams:      { name: 'Teams',      price: 4999,  stripe_price: 'price_TEAMS_PLACEHOLDER',       trial_days: 14, per_person: true },
  enterprise: { name: 'Enterprise', price: null,   stripe_price: null },
};

// ── POST /api/stripe/create-checkout — start a subscription ──
router.post('/create-checkout', requireAuth, (req, res) => {
  const { plan, team_size } = req.body;
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const planConfig = PLANS[plan];
  if (!planConfig || plan === 'free') {
    return res.status(400).json({ error: 'Invalid plan. Use: plus, pro, max, teams, enterprise.' });
  }

  if (plan === 'enterprise') {
    return res.json({
      message: 'Enterprise plan — contact sales.',
      redirect: '/checkout-enterprise.html',
    });
  }

  // Mock: generate a fake Stripe checkout session URL
  const sessionId = `cs_mock_${Date.now()}_${plan}`;
  const validTeamSize = Math.max(1, Math.min(parseInt(team_size, 10) || 3, 100));
  const totalPrice = plan === 'teams' ? planConfig.price * validTeamSize : planConfig.price;

  res.json({
    message: `Mock checkout session created for ${planConfig.name}.`,
    session_id: sessionId,
    // In production: this would be a real Stripe Checkout URL
    checkout_url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/stripe/mock-complete?session=${sessionId}&plan=${plan}&user=${user.id}&team_size=${team_size || 1}`,
    plan: planConfig.name,
    price_cents: totalPrice,
    trial_days: planConfig.trial_days || null,
    intro_price: planConfig.intro_price || null,
    intro_months: planConfig.intro_months || null,
  });
});

// ── GET /api/stripe/mock-complete — simulate successful payment ──
router.get('/mock-complete', (req, res) => {
  const { plan, user: userId } = req.query;

  const dbUser = db.findUserById(userId);
  if (!dbUser) return res.status(404).json({ error: 'User not found.' });

  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Invalid plan.' });

  // Cancel existing subscription if any
  const existing = db.findSubscription(userId);
  if (existing) db.cancelSubscription(userId);

  // Create subscription
  const trialEnd = planConfig.trial_days
    ? new Date(Date.now() + planConfig.trial_days * 86400000)
    : null;

  db.createSubscription({
    userId,
    plan,
    status: trialEnd ? 'trialing' : 'active',
    trialEnd,
  });

  // Set session if available
  if (req.session) req.session.userId = userId;

  res.redirect(`/dashboard.html?subscribed=${plan}`);
});

// ── POST /api/stripe/webhook — handle Stripe events (mock) ──
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // In production: verify signature with stripe.webhooks.constructEvent()
  console.log('[Stripe Webhook] Received event (mock mode — not verified)');

  // Acknowledge
  res.json({ received: true });
});

// ── POST /api/stripe/portal — customer billing portal ──
router.post('/portal', requireAuth, (req, res) => {
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  // Mock: return a dummy portal URL
  res.json({
    message: 'Mock billing portal.',
    // In production: this would be a real Stripe Customer Portal URL
    portal_url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/stripe/mock-portal?user=${user.id}`,
  });
});

// ── GET /api/stripe/mock-portal — simulate billing portal ──
router.get('/mock-portal', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><title>Billing Portal (Mock)</title>
    <style>body{font-family:-apple-system,system-ui,sans-serif;background:#000;color:#f5f5f7;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .card{background:#1d1d1f;border-radius:16px;padding:48px;max-width:400px;text-align:center}
    h2{margin-bottom:12px}p{color:#86868b;margin-bottom:24px}
    a{display:inline-block;padding:12px 28px;background:#0071e3;color:#fff;border-radius:980px;text-decoration:none;font-weight:600}</style></head>
    <body><div class="card">
      <h2>Billing Portal</h2>
      <p>This is a mock billing portal. In production, this would be Stripe's hosted customer portal where you can manage your subscription.</p>
      <a href="/dashboard.html">← Back to Dashboard</a>
    </div></body></html>
  `);
});

// ── POST /api/stripe/cancel — cancel subscription ──
router.post('/cancel', requireAuth, (req, res) => {
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });

  const sub = db.cancelSubscription(user.id);
  if (!sub) return res.status(404).json({ error: 'No active subscription found.' });

  res.json({
    message: 'Subscription cancelled. You are now on the Free plan.',
    plan: 'free',
  });
});

// ── GET /api/stripe/plans — list available plans ──
router.get('/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([key, val]) => ({
    id: key,
    name: val.name,
    price_cents: val.price,
    price_display: val.price ? `$${(val.price / 100).toFixed(2)}/mo` : (key === 'enterprise' ? 'Contact us' : 'Free'),
    trial_days: val.trial_days || null,
    intro_price: val.intro_price ? `$${(val.intro_price / 100).toFixed(2)}/mo for ${val.intro_months}mo` : null,
    per_person: val.per_person || false,
    features: getPlanFeatures(key),
  }));
  res.json({ plans });
});

function getPlanFeatures(plan) {
  const features = {
    free:       ['10 trends/day', 'BYOAK (bring your own key)', '1 platform', 'Basic dashboard'],
    plus:       ['50 trends/day', 'All 3 platforms', 'Daily alerts', 'Export CSV', '7-day free trial'],
    pro:        ['500 trends/day', 'All 3 platforms', 'Real-time alerts', 'Niche search', 'AI content hooks', '30-day history', '$14.99/mo for first 3 months'],
    max:        ['Unlimited trends', 'All 3 platforms', 'API access', 'Niche search', 'White-label reports', '90-day history', 'Priority support', '$59.99/mo for first 3 months'],
    teams:      ['Unlimited trends', 'All 3 platforms', 'Team dashboard', 'Niche search', 'Shared workspaces', 'Admin controls', '14-day free trial'],
    enterprise: ['Everything in Max', 'Dedicated account manager', 'Custom integrations', 'SLA guarantee', 'SSO/SAML', 'Unlimited history'],
  };
  return features[plan] || [];
}

module.exports = router;
