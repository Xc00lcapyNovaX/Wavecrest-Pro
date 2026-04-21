// server/middleware/validate.js
const VALID_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'reddit', 'all'];
const VALID_SCORES    = ['hot', 'rising', 'warm'];
const DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE          = /^https?:\/\//;

function assertPlatform(val) {
  if (val && !VALID_PLATFORMS.includes(val))
    return `platform must be one of: ${VALID_PLATFORMS.join(', ')}`;
}
function assertScore(val) {
  if (val && !VALID_SCORES.includes(val))
    return `score must be one of: ${VALID_SCORES.join(', ')}`;
}
function assertDate(val) {
  if (val && !DATE_RE.test(val))
    return 'date must be YYYY-MM-DD';
}
function assertPageUrl(val) {
  if (!val) return;
  if (!URL_RE.test(val)) return 'page_url must be a valid http/https URL';
  if (val.length > 2048) return 'page_url too long (max 2048 chars)';
}
function assertNumericId(val, label) {
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0) return `${label} must be a positive integer`;
}

module.exports = { assertPlatform, assertScore, assertDate, assertPageUrl, assertNumericId };
