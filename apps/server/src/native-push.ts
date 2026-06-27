import { connect } from 'node:http2';
import { createSign } from 'node:crypto';
import type { PushNotification } from '@glance/core';
import type { PushProvider } from './push';
import type { PushPlatform, PushSubscription } from './push-store';

/**
 * Native push for the App Store / Play builds, behind the same {@link PushProvider} seam.
 * APNs (iOS, HTTP/2 + ES256 provider token) and FCM v1 (Android, service-account OAuth).
 * Both are config-gated (active only when their keys are set) and best-effort — a failure
 * never affects the session. Web Push (the PWA) keeps its own provider; this is for the
 * wrapped native shells. No new dependencies (node:http2 + node:crypto + fetch).
 */

const b64u = (b: Buffer): string => b.toString('base64url');

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string; // the .p8 contents (PKCS8 PEM)
  bundleId: string;
  production?: boolean;
}

export class ApnsProvider implements PushProvider {
  private token = '';
  private tokenAt = 0;
  private readonly host: string;

  constructor(private readonly cfg: ApnsConfig) {
    this.host = cfg.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  }

  /** Provider token (ES256 JWT), reused for ~50 min (APNs accepts up to 60). */
  private providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now - this.tokenAt < 3000) return this.token;
    const header = b64u(Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId })));
    const claims = b64u(Buffer.from(JSON.stringify({ iss: this.cfg.teamId, iat: now })));
    const sig = createSign('SHA256')
      .update(`${header}.${claims}`)
      .sign({ key: this.cfg.privateKey, dsaEncoding: 'ieee-p1363' });
    this.token = `${header}.${claims}.${b64u(sig)}`;
    this.tokenAt = now;
    return this.token;
  }

  async send(sub: PushSubscription, note: PushNotification): Promise<void> {
    if (sub.platform !== 'apns') return;
    await new Promise<void>((resolve) => {
      try {
        const client = connect(this.host);
        client.on('error', () => resolve());
        const body = JSON.stringify({ aps: { alert: { title: note.title, body: note.body }, sound: 'default' } });
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${sub.endpoint}`,
          authorization: `bearer ${this.providerToken()}`,
          'apns-topic': this.cfg.bundleId,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
        });
        const done = (): void => {
          try {
            client.close();
          } catch {
            /* ignore */
          }
          resolve();
        };
        req.on('end', done);
        req.on('error', done);
        req.end(body);
      } catch {
        resolve();
      }
    });
  }
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string; // service-account RSA private key (PEM)
}

export class FcmProvider implements PushProvider {
  private accessToken = '';
  private tokenExp = 0;

  constructor(
    private readonly cfg: FcmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && now < this.tokenExp - 60) return this.accessToken;
    const header = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = b64u(
      Buffer.from(
        JSON.stringify({
          iss: this.cfg.clientEmail,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        }),
      ),
    );
    const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.cfg.privateKey);
    const assertion = `${header}.${claims}.${b64u(sig)}`;
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    this.accessToken = json.access_token ?? '';
    this.tokenExp = now + (json.expires_in ?? 3600);
    return this.accessToken;
  }

  async send(sub: PushSubscription, note: PushNotification): Promise<void> {
    if (sub.platform !== 'fcm') return;
    try {
      const token = await this.getAccessToken();
      if (!token) return;
      await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${this.cfg.projectId}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: { token: sub.endpoint, notification: { title: note.title, body: note.body } },
          }),
        },
      );
    } catch {
      /* best-effort */
    }
  }
}

/** Routes each subscription to the provider for its platform, else to a fallback. */
export class RoutingPushProvider implements PushProvider {
  constructor(
    private readonly routes: Partial<Record<PushPlatform, PushProvider>>,
    private readonly fallback: PushProvider,
  ) {}

  async send(sub: PushSubscription, note: PushNotification): Promise<void> {
    await (this.routes[sub.platform] ?? this.fallback).send(sub, note);
  }
}
