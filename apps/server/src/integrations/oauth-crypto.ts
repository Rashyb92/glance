import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption-at-rest for provider tokens, plus PKCE helpers. Tokens are never
 * written to disk in plaintext: each is sealed with AES-256-GCM under a key derived
 * from GLANCE_TOKEN_KEY. The ciphertext is `iv.tag.data` (all base64url).
 */
const KEY_ENV = 'GLANCE_TOKEN_KEY';

function key(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) throw new Error(`${KEY_ENV} is required to encrypt provider tokens`);
  // Accept any-length secret; derive a fixed 32-byte key.
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(blob: string): string {
  const parts = blob.split('.');
  const [ivB, tagB, dataB] = parts;
  if (parts.length !== 3 || !ivB || !tagB || !dataB) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Create a PKCE verifier + S256 challenge (for OAuth 2.1 providers like Kick). */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
