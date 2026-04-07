/**
 * Wavecrest Pro — In-memory database (mock)
 * Replace with PostgreSQL when ready.
 */
const { v4: uuid } = require('uuid');

const db = {
  users: [],
  subscriptions: [],
  trends: [],
  apiKeys: [],
  usageLog: [],
};

// ── Users ──────────────────────────────────────────
db.findUserByEmail = (email) =>
  db.users.find((u) => u.email === email.toLowerCase());

db.findUserById = (id) => db.users.find((u) => u.id === id);

db.findUserByProvider = (provider, providerId) =>
  db.users.find((u) => u.provider === provider && u.provider_id === providerId);

db.createUser = ({ email, passwordHash, name, provider = 'email', providerId, avatarUrl }) => {
  const user = {
    id: uuid(),
    email: email.toLowerCase(),
    password_hash: passwordHash || null,
    name: name || email.split('@')[0],
    avatar_url: avatarUrl || null,
    provider,
    provider_id: providerId || null,
    plan: 'free',
    stripe_customer_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  db.users.push(user);
  return user;
};

db.updateUser = (id, fields) => {
  const user = db.findUserById(id);
  if (!user) return null;
  Object.assign(user, fields, { updated_at: new Date() });
  return user;
};

// ── Subscriptions ──────────────────────────────────
db.createSubscription = ({ userId, plan, stripeSubId, status = 'active', trialEnd, periodEnd }) => {
  const sub = {
    id: uuid(),
    user_id: userId,
    stripe_sub_id: stripeSubId || `mock_sub_${uuid().slice(0, 8)}`,
    plan,
    status,
    trial_end: trialEnd || null,
    current_period_end: periodEnd || new Date(Date.now() + 30 * 86400000),
    created_at: new Date(),
  };
  db.subscriptions.push(sub);
  db.updateUser(userId, { plan });
  return sub;
};

db.findSubscription = (userId) =>
  db.subscriptions.find((s) => s.user_id === userId && s.status !== 'cancelled');

db.cancelSubscription = (userId) => {
  const sub = db.findSubscription(userId);
  if (sub) {
    sub.status = 'cancelled';
    db.updateUser(userId, { plan: 'free' });
  }
  return sub;
};

// ── Trends ─────────────────────────────────────────
db.addTrends = (trends, date) => {
  const dateStr = date || new Date().toISOString().slice(0, 10);
  trends.forEach((t) => {
    db.trends.push({
      id: db.trends.length + 1,
      topic: t.topic,
      score: t.score,
      platform: t.platform || 'general',
      traffic: t.traffic || 0,
      fetched_at: dateStr,
      created_at: new Date(),
    });
  });
};

db.getTrends = ({ date, platform, score, limit = 30, offset = 0 }) => {
  let results = [...db.trends];
  if (date) results = results.filter((t) => t.fetched_at === date);
  if (platform) results = results.filter((t) => t.platform === platform);
  if (score) results = results.filter((t) => t.score === score);
  // Most recent first
  results.sort((a, b) => b.id - a.id);
  return { trends: results.slice(offset, offset + limit), total: results.length };
};

db.searchTrends = (query, { platform, limit = 20 } = {}) => {
  const q = query.toLowerCase();
  let results = db.trends.filter((t) => t.topic.toLowerCase().includes(q));
  if (platform) results = results.filter((t) => t.platform === platform);
  // Deduplicate by topic, keep most recent
  const seen = new Map();
  results.forEach((t) => {
    const key = t.topic.toLowerCase();
    if (!seen.has(key) || t.id > seen.get(key).id) seen.set(key, t);
  });
  results = [...seen.values()];
  results.sort((a, b) => {
    const scoreOrder = { hot: 0, rising: 1, warm: 2 };
    return (scoreOrder[a.score] || 3) - (scoreOrder[b.score] || 3);
  });
  return results.slice(0, limit);
};

// ── Usage / Rate Limits ────────────────────────────
const PLAN_LIMITS = {
  free: 10,
  plus: 50,
  pro: 500,
  max: -1,    // unlimited
  teams: -1,
  enterprise: -1,
};

db.checkRateLimit = (userId, plan) => {
  const limit = PLAN_LIMITS[plan] ?? 10;
  if (limit === -1) return { allowed: true, remaining: Infinity, limit: 'unlimited' };

  const today = new Date().toISOString().slice(0, 10);
  const used = db.usageLog.filter(
    (l) => l.user_id === userId && l.used_at.toISOString().slice(0, 10) === today
  ).length;

  return { allowed: used < limit, remaining: Math.max(0, limit - used), limit, used };
};

db.logUsage = (userId, endpoint) => {
  db.usageLog.push({ user_id: userId, endpoint, used_at: new Date() });
};

// ── API Keys (BYOAK) ──────────────────────────────
db.saveApiKey = (userId, service, key) => {
  const existing = db.apiKeys.find((k) => k.user_id === userId && k.service === service);
  if (existing) {
    existing.api_key = key;
    return existing;
  }
  const entry = { id: uuid(), user_id: userId, service, api_key: key, created_at: new Date() };
  db.apiKeys.push(entry);
  return entry;
};

db.getApiKeys = (userId) => db.apiKeys.filter((k) => k.user_id === userId);

module.exports = db;
