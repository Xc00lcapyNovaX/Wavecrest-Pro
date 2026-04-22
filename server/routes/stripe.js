/**
 * Stripe routes — real Stripe SDK with mock fallback.
 * If STRIPE_SECRET_KEY is a placeholder, falls back to mock behavior.
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const router = express.Router();

// Initialize Stripe only if real key is present
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const isMock = !stripeKey || stripeKey.includes('PLACEHOLDER');
const stripe = isMock ? null : require('stripe')(stripeKey);

// Plan config with pricing
const PLANS = {
  free:       { name: 'Free',       price: 0,     stripe_price: process.env.STRIPE_PRICE_FREE || null },
  plus:       { name: 'Plus',       price: 999,   stripe_price: process.env.STRIPE_PRICE_PLUS || 'price_PLUS_PLACEHOLDER',       trial_days: 7 },
  pro:        { name: 'Pro',        price: 2499,  stripe_price: process.env.STRIPE_PRICE_PRO || 'price_PRO_PLACEHOLDER',         intro_price: 1499, intro_months: 3, intro_stripe_price: process.env.STRIPE_PRICE_PRO_INTRO || null },
  max:        { name: 'Max',        price: 9999,  stripe_price: process.env.STRIPE_PRICE_MAX || 'price_MAX_PLACEHOLDER',         intro_price: 5999, intro_months: 3, intro_stripe_price: process.env.STRIPE_PRICE_MAX_INTRO || null },
  teams:      { name: 'Teams',      price: 4999,  stripe_price: process.env.STRIPE_PRICE_TEAMS || 'price_TEAMS_PLACEHOLDER',     trial_days: 14, per_person: true },
  enterprise: { name: 'Enterprise', price: null,   stripe_price: null },
};

// In-memory dedup: Stripe retries up to 3 days; keep IDs for 25 hours.
const processedEvents = new Map();
const EVENT_TTL_MS    = 25 * 60 * 60 * 1000;

function isEventProcessed(eventId) {
  const ts = processedEvents.get(eventId);
  if (!ts) return false;
  if (Date.now() - ts > EVENT_TTL_MS) { processedEvents.delete(eventId); return false; }
  return true;
}

function markEventProcessed(eventId) {
  processedEvents.set(eventId, Date.now());
  if (processedEvents.size > 5000) {
    const cutoff = Date.now() - EVENT_TTL_MS;
    for (const [id, ts] of processedEvents) {
      if (ts < cutoff) processedEvents.delete(id);
    }
  }
}

// ── POST /api/stripe/create-checkout — start a subscription ──
router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { plan, team_size } = req.body;
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    const planConfig = PLANS[plan];
    if (!planConfig || plan === 'free') {
      return res.status(400).json({ error: 'Invalid plan. Use: plus, pro, max, teams, enterprise.' });
    }

    if (plan === 'enterprise') {
      return res.json({ message: 'Enterprise plan — contact sales.', redirect: '/checkout?plan=enterprise' });
    }

    // ── Real Stripe ──
    if (stripe) {
      // Use intro price for first-time Pro/Max subscribers
      const priceId = planConfig.intro_stripe_price || planConfig.stripe_price;
      const lineItems = [{
        price: priceId,
        quantity: plan === 'teams' ? Math.max(1, Math.min(parseInt(team_size, 10) || 3, 100)) : 1,
      }];

      const sessionParams = {
        mode: 'subscription',
        customer_email: user.email,
        line_items: lineItems,
        success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/dashboard?session_id={CHECKOUT_SESSION_ID}&subscribed=${plan}`,
        cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}/checkout?plan=${plan}&cancelled=true`,
        metadata: { userId: user.id, plan },
      };

      // Add trial if plan supports it
      if (planConfig.trial_days) {
        sessionParams.subscription_data = {
          trial_period_days: planConfig.trial_days,
        };
      }

      const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
      return res.json({ url: checkoutSession.url });
    }

    // ── Mock fallback ──
    const sessionId = `cs_mock_${Date.now()}_${plan}`;
    const validTeamSize = Math.max(1, Math.min(parseInt(team_size, 10) || 3, 100));
    const totalPrice = plan === 'teams' ? planConfig.price * validTeamSize : planConfig.price;

    res.json({
      message: `Mock checkout session created for ${planConfig.name}.`,
      session_id: sessionId,
      url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/stripe/mock-complete?session=${sessionId}&plan=${plan}&user=${user.id}&team_size=${team_size || 1}`,
      plan: planConfig.name, price_cents: totalPrice,
      trial_days: planConfig.trial_days || null,
      intro_price: planConfig.intro_price || null,
      intro_months: planConfig.intro_months || null,
    });
  } catch (err) {
    console.error('[Stripe] create-checkout error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/stripe/mock-complete — simulate successful payment (dev only) ──
router.get('/mock-complete', async (req, res) => {
  if (!isMock) return res.status(404).json({ error: 'Not available in live mode.' });
  try {
    const { plan, user: userId } = req.query;

    const dbUser = await db.findUserById(userId);
    if (!dbUser) return res.status(404).json({ error: 'User not found.' });

    const planConfig = PLANS[plan];
    if (!planConfig) return res.status(400).json({ error: 'Invalid plan.' });

    const existing = await db.findSubscription(userId);
    if (existing) await db.cancelSubscription(userId);

    const trialEnd = planConfig.trial_days
      ? new Date(Date.now() + planConfig.trial_days * 86400000)
      : null;

    await db.createSubscription({
      userId, plan,
      status: trialEnd ? 'trialing' : 'active',
      trialEnd,
    });

    if (req.session) req.session.userId = userId;
    res.redirect(`/dashboard?subscribed=${plan}`);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/stripe/webhook — handle Stripe events ──
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    console.log('[Stripe Webhook] Mock mode — ignoring.');
    return res.json({ received: true });
  }

  if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET not set in production.');
    return res.status(500).json({ error: 'Webhook secret not configured.' });
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  if (isEventProcessed(event.id)) {
    console.log(`[Stripe Webhook] Duplicate event ${event.id} — skipping.`);
    return res.json({ received: true });
  }
  markEventProcessed(event.id);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan;
        if (!userId || !plan) break;

        // Save Stripe customer ID on user
        if (session.customer) {
          await db.updateUserStripeId(userId, session.customer);
        }

        // Cancel any existing subscription
        const existing = await db.findSubscription(userId);
        if (existing) await db.cancelSubscription(userId);

        // Create new subscription from Stripe data
        await db.createSubscriptionFromStripe({
          userId,
          plan,
          stripeSubId: session.subscription,
          stripeSessionId: session.id,
          status: 'active',
        });
        console.log(`[Stripe] ✓ Subscription created: ${plan} for user ${userId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const updates = {
          status: sub.status,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
        };

        if (sub.trial_end) {
          updates.trial_ends_at = new Date(sub.trial_end * 1000);
        }

        await db.updateSubscriptionFromStripe(sub.id, updates);

        // If past_due or unpaid, downgrade user
        if (['past_due', 'unpaid'].includes(sub.status)) {
          const dbSub = await db.findSubscriptionByStripeId(sub.id);
          if (dbSub) await db.updateUser(dbSub.user_id, { plan: 'free' });
        }
        console.log(`[Stripe] ✓ Subscription updated: ${sub.id} → ${sub.status}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.updateSubscriptionFromStripe(sub.id, {
          status: 'cancelled',
          cancelled_at: new Date(),
        });
        // Downgrade user to free
        const dbSub = await db.findSubscriptionByStripeId(sub.id);
        if (dbSub) await db.updateUser(dbSub.user_id, { plan: 'free' });
        console.log(`[Stripe] ✓ Subscription cancelled: ${sub.id}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`[Stripe] ⚠ Payment failed for customer ${invoice.customer}, invoice ${invoice.id}`);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        console.log(`[Stripe] ✓ Invoice paid: ${invoice.id}`);
        break;
      }

      default:
        console.log(`[Stripe] Unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error(`[Stripe Webhook] Error handling ${event.type}:`, err.message);
  }

  res.json({ received: true });
});

// ── POST /api/stripe/portal — customer billing portal ──
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    // ── Real Stripe ──
    if (stripe && user.stripe_customer_id) {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${process.env.BASE_URL || 'http://localhost:3000'}/dashboard`,
      });
      return res.json({ url: portalSession.url });
    }

    // ── Mock fallback ──
    res.json({
      message: 'Mock billing portal.',
      url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/stripe/mock-portal?user=${user.id}`,
    });
  } catch (err) {
    console.error('[Stripe] portal error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/stripe/mock-portal — simulate billing portal (dev only) ──
router.get('/mock-portal', (req, res) => {
  if (!isMock) return res.status(404).json({ error: 'Not available in live mode.' });
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
      <a href="/dashboard">← Back to Dashboard</a>
    </div></body></html>
  `);
});

// ── POST /api/stripe/cancel — cancel subscription ──
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    // ── Real Stripe — cancel at period end ──
    if (stripe) {
      const dbSub = await db.findSubscription(user.id);
      if (!dbSub || !dbSub.stripe_sub_id) {
        return res.status(404).json({ error: 'No active Stripe subscription found.' });
      }

      await stripe.subscriptions.update(dbSub.stripe_sub_id, {
        cancel_at_period_end: true,
      });

      return res.json({
        message: 'Subscription will cancel at the end of the current billing period.',
        cancel_at: dbSub.current_period_end,
      });
    }

    // ── Mock fallback ──
    const sub = await db.cancelSubscription(user.id);
    if (!sub) return res.status(404).json({ error: 'No active subscription found.' });

    res.json({ message: 'Subscription cancelled. You are now on the Free plan.', plan: 'free' });
  } catch (err) {
    console.error('[Stripe] cancel error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/stripe/subscription — current user's subscription info ──
router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const sub = await db.findSubscription(req.session.userId);
    if (!sub) return res.json({ plan: 'free', status: 'none' });

    res.json({
      plan: sub.plan,
      status: sub.status,
      trial_ends_at: sub.trial_ends_at,
      current_period_end: sub.current_period_end,
      created_at: sub.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
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
    free:       ['10 trends/day', '1 platform only', 'Basic dashboard', 'BYOAK (bring your own API key)'],
    plus:       ['50 trends/day', 'All 3 platforms', 'CSV export', 'Daily email digest', '7-day trend history', '7-day free trial'],
    pro:        ['500 trends/day', 'All 3 platforms', '🔥 AI Trend Predictions — see what\'s about to blow up', '🎯 Content Hooks — AI-generated video/post ideas per trend', 'Niche keyword search', 'Real-time velocity alerts', '30-day history', '$14.99/mo for first 3 months'],
    max:        ['Unlimited trends', 'All 3 platforms', 'Everything in Pro, plus:', '🌐 Cross-Platform Tracking — see trends jump between platforms', '📊 Full API access for your tools', 'Predictive confidence scoring', 'White-label PDF reports', '90-day history', 'Priority support', '$59.99/mo for first 3 months'],
    teams:      ['Unlimited trends', 'All 3 platforms', 'Everything in Max, plus:', 'Team dashboard & shared workspaces', 'Admin controls & permissions', 'Team activity feed', '14-day free trial'],
    enterprise: ['Everything in Teams', 'Dedicated account manager', 'Custom integrations & webhooks', 'SLA guarantee', 'SSO/SAML', 'Unlimited history', 'Custom trend sources'],
  };
  return features[plan] || [];
}

module.exports = router;
