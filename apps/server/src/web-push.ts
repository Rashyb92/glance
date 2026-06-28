import { createCipheriv, createECDH, createHmac, createPrivateKey, createSign, randomBytes } from 'node:crypto';
import type { PushNotification } from '@glance/core';
import type { PushProvider } from './push';
import { isPublicEndpoint, type PushSubscription } from './push-store';

/**
 * Real Web Push delivery (the background-notification path for the companion PWA and,
 * through it, phones / wearables). Implements VAPID auth (RFC 8292, ES256) and the
 * aes128gcm payload encryption (RFC 8291 + RFC 8188) with node:crypto only — no new
 * dependencies. Salt + ephemeral key are injectable so the encryption is unit-tested
 * with a decrypt round-trip.
 */

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** HKDF-Expand(HKDF-Extract(salt, ikm), info, len) — one-block (len <= 32). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
}

export interface EncryptOptions {
  salt?: Buffer;
  ecdh?: ReturnType<typeof createECDH>;
}

/** Encrypt a payload into an aes128gcm body bound to the subscriber's keys (RFC 8291). */
export function encryptPayload(
  payload: Buffer,
  uaPublicB64: string,
  authB64: string,
  opts: EncryptOptions = {},
): Buffer {
  const uaPublic = fromB64u(uaPublicB64); // receiver public key (65 bytes)
  const authSecret = fromB64u(authB64); // receiver auth secret (16 bytes)
  const salt = opts.salt ?? randomBytes(16);
  const as = opts.ecdh ?? createECDH('prime256v1');
  if (!opts.ecdh) as.generateKeys();
  const asPublic = as.getPublicKey(); // sender (ephemeral) public key (65 bytes)
  const sharedSecret = as.computeSecret(uaPublic);

  // Derive the input keying material from the ECDH secret + the auth secret.
  const prkKey = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32);

  // Content-encryption key + nonce.
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // One record: plaintext || 0x02 (last-record delimiter), then AES-128-GCM.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // aes128gcm header: salt(16) | recordSize(4 BE) | keyIdLen(1) | keyId(asPublic 65).
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** Build the `Authorization: vapid …` header for a push request to `audience` (its origin). */
export function vapidAuthHeader(
  audience: string,
  subject: string,
  vapidPublicB64: string,
  vapidPrivateB64: string,
  now: number = Date.now(),
): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const signingInput = `${header}.${claims}`;
  const sig = createSign('SHA256')
    .update(signingInput)
    .sign({ key: vapidPrivateKey(vapidPublicB64, vapidPrivateB64), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64u(sig)}, k=${vapidPublicB64}`;
}

function vapidPrivateKey(publicB64: string, privateB64: string) {
  const pub = fromB64u(publicB64); // 0x04 || X(32) || Y(32)
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateB64,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
  });
}

/**
 * Delivers `webpush` subscriptions for real; anything else (apns/fcm/webhook) is handed
 * to the fallback provider. Best-effort: a flaky device never affects the session.
 */
export class WebPushProvider implements PushProvider {
  constructor(
    private readonly vapidPublic: string,
    private readonly vapidPrivate: string,
    private readonly subject: string,
    private readonly fallback: PushProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(sub: PushSubscription, note: PushNotification): Promise<void> {
    if (sub.platform !== 'webpush' || !sub.keys) {
      await this.fallback.send(sub, note);
      return;
    }
    if (!(await isPublicEndpoint(sub.endpoint))) return; // SSRF guard — re-resolves the host
    try {
      const body = encryptPayload(Buffer.from(JSON.stringify(note), 'utf8'), sub.keys.p256dh, sub.keys.auth);
      await this.fetchImpl(sub.endpoint, {
        method: 'POST',
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: '60',
          authorization: vapidAuthHeader(
            new URL(sub.endpoint).origin,
            this.subject,
            this.vapidPublic,
            this.vapidPrivate,
          ),
        },
        body: new Uint8Array(body),
      });
    } catch {
      /* best-effort */
    }
  }
}
