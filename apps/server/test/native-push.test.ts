import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { PushNotification } from '@glance/core';
import { FcmProvider, RoutingPushProvider } from '../src/native-push';
import type { PushProvider } from '../src/push';
import type { PushPlatform, PushSubscription } from '../src/push-store';

function sub(platform: PushPlatform): PushSubscription {
  return { id: '1', platform, endpoint: 'device-token', createdAt: 0 };
}
const note: PushNotification = {
  title: 'Donation!',
  body: '500 bits',
  category: 'event',
  tag: 't',
};

describe('RoutingPushProvider', () => {
  it('routes by platform and falls back otherwise', async () => {
    const hits: string[] = [];
    const provider = (name: string): PushProvider => ({
      send: async () => {
        hits.push(name);
      },
    });
    const router = new RoutingPushProvider({ fcm: provider('fcm') }, provider('fallback'));
    await router.send(sub('fcm'), note);
    await router.send(sub('webhook'), note);
    expect(hits).toEqual(['fcm', 'fallback']);
  });
});

describe('FcmProvider', () => {
  it('mints an OAuth token from a signed JWT, then posts to FCM v1', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('oauth2')) {
        expect(String(init?.body ?? '')).toContain('assertion=');
        return {
          ok: true,
          json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }),
        } as unknown as Response;
      }
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer ya29.test');
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const fcm = new FcmProvider(
      { projectId: 'proj', clientEmail: 'svc@proj.iam.gserviceaccount.com', privateKey: pem },
      fakeFetch,
    );
    await fcm.send(sub('fcm'), note);
    expect(calls[0]).toContain('oauth2.googleapis.com/token');
    expect(calls[1]).toContain('fcm.googleapis.com/v1/projects/proj/messages:send');
  });

  it('ignores non-fcm subscriptions without fetching', async () => {
    const fcm = new FcmProvider(
      { projectId: 'p', clientEmail: 'e', privateKey: 'x' },
      (async () => {
        throw new Error('should not fetch');
      }) as unknown as typeof fetch,
    );
    await fcm.send(sub('apns'), note); // returns early; no throw
  });
});
