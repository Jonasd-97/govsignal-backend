const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY || process.env.FIELD_ENCRYPTION_KEY || '';
  if (!raw) return null;

  // Support hex, base64, or arbitrary passphrase.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
  } catch {}
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptIfPossible(value) {
  if (!value) return null;
  const key = getKey();
  if (!key) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptIfPossible(value) {
  if (!value) return null;
  const key = getKey();
  if (!key || !String(value).startsWith('enc:')) return value;

  try {
    const [, ivB64, tagB64, dataB64] = String(value).split(':');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encryptIfPossible, decryptIfPossible };
