import { describe, it, expect } from 'vitest';
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  createVerify,
} from 'node:crypto';
import { encryptPayload, vapidAuthHeader } from '../src/web-push';

const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');
const b64u = (b: Buffer): string => b.toString('base64url');
const hmac = (k: Buffer, d: Buffer): Buffer => createHmac('sha256', k).update(d).digest();
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  return hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
}

// Test-only inverse of encryptPayload — proves the RFC 8291 pipeline round-trips.
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublicB64: string, authB64: string): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const prkKey = hmac(fromB64u(authB64), shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), fromB64u(uaPublicB64), asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return pt.subarray(0, pt.length - 1); // strip the 0x02 delimiter
}

describe('web-push encryption (RFC 8291)', () => {
  it('round-trips a payload to the subscriber keys', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const uaPub = b64u(ua.getPublicKey());
    const auth = b64u(Buffer.from('0123456789abcdef')); // 16-byte auth secret
    const msg = Buffer.from(JSON.stringify({ title: 'Donation!', body: 'Whale tipped 500 bits' }));
    const body = encryptPayload(msg, uaPub, auth);
    expect(body.readUInt8(20)).toBe(65); // aes128gcm keyid length
    expect(decrypt(body, ua.getPrivateKey(), uaPub, auth).equals(msg)).toBe(true);
  });
});

describe('VAPID auth header (RFC 8292)', () => {
  it('produces a JWT that verifies with the VAPID public key', () => {
    const vapid = createECDH('prime256v1');
    vapid.generateKeys();
    const pub = vapid.getPublicKey();
    const header = vapidAuthHeader(
      'https://fcm.googleapis.com',
      'mailto:ops@glance.app',
      b64u(pub),
      b64u(vapid.getPrivateKey()),
    );
    expect(header).toContain('vapid t=');
    expect(header).toContain(`k=${b64u(pub)}`);
    const jwt = header.slice('vapid t='.length, header.indexOf(', k='));
    const [h, c, s] = jwt.split('.');
    const key = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    });
    const verified = createVerify('SHA256')
      .update(`${h}.${c}`)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, fromB64u(s ?? ''));
    expect(verified).toBe(true);
    const claims = JSON.parse(fromB64u(c ?? '').toString()) as { aud: string; sub: string };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:ops@glance.app');
  });
});
