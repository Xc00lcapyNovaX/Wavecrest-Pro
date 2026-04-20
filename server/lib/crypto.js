/**
 * AES-256-GCM helpers for encrypting at-rest secrets (BYOAK API keys, etc.).
 *
 * Requires API_KEY_ENCRYPTION_KEY — a 32-byte key, hex or base64 encoded.
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function getKey() {
  const raw = process.env.API_KEY_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('API_KEY_ENCRYPTION_KEY env var is required for BYOAK storage');
  }
  const buf = /^[0-9a-fA-F]+$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('API_KEY_ENCRYPTION_KEY must decode to 32 bytes (got ' + buf.length + ')');
  }
  return buf;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) {
    throw new Error('ciphertext is not in v1 format');
  }
  const [, ivB64, tagB64, ctB64] = blob.split(':');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

function isEncrypted(blob) {
  return typeof blob === 'string' && blob.startsWith('v1:');
}

module.exports = { encrypt, decrypt, isEncrypted };
