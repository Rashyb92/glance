import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGateway, type Gateway, type GatewayControl } from '../src/gateway';
import type { Bus } from '../src/bus';
import type { AdminDeps } from '../src/admin/admin-routes';
import { AdminAuth } from '../src/admin/admin-auth';
import { AuditLog } from '../src/admin/audit-log';
import { MemoryKvStore } from '../src/kv';
import type { AdminSnapshot } from '../src/hub';
import type { FunnelReport } from '../src/analytics/product-analytics';

// Real HTTP test: start the gateway with an admin console wired and drive /api/admin via fetch.
// The admin routes resolve before the tenant gate and never touch GatewayControl, so a stub is fine.
const PORT = 18801;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'op-secret';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const calls = {
  forceLogout: [] as string[],
  revokeMember: [] as string[][],
  eraseTenant: [] as string[],
  deleteByEmail: [] as string[],
};
let gw: Gateway;

const snapshot = (tenant: string): AdminSnapshot => ({
  tenant,
  loaded: true,
  plan: 'pro',
  connected: false,
  channels: [],
  viewers: null,
  aiUsedToday: 0,
  aiCapPerDay: 100,
  archives: 0,
  teamMembers: 0,
  pushDevices: 0,
  settings: null,
});

beforeAll(() => {
  const bus: Bus = { publish: () => undefined, subscribe: () => undefined };
  const control = {} as unknown as GatewayControl; // unused by admin routes
  const admin: AdminDeps = {
    auth: new AdminAuth({ tokens: '', token: TOKEN }),
    audit: new AuditLog(new MemoryKvStore()),
    snapshot: (t) => Promise.resolve(snapshot(t)),
    forceLogout: (t) => {
      calls.forceLogout.push(t);
    },
    revokeMember: (t, m) => {
      calls.revokeMember.push([t, m]);
      return true;
    },
    eraseTenant: (t) => {
      calls.eraseTenant.push(t);
    },
    deleteAccountByEmail: (e) => {
      calls.deleteByEmail.push(e);
      return Promise.resolve(e === 'known@x.com' ? 'tenant-123' : null);
    },
    analyticsReport: () =>
      Promise.resolve({
        funnel: { signup: 3, activated: 2, engaged: 1, subscribed: 0 },
        conversion: { activation: 67, engagement: 50, subscription: 0 },
      }),
  };
  gw = startGateway(PORT, control, bus, undefined, undefined, admin);
});

afterAll(() => gw.close());

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('admin console (HTTP)', () => {
  it('serves the console page', async () => {
    const r = await fetch(`${BASE}/admin`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('Admin');
  });

  it('rejects API calls without a valid operator token', async () => {
    expect((await fetch(`${BASE}/api/admin/tenant/t1`)).status).toBe(401);
    expect(
      (await fetch(`${BASE}/api/admin/tenant/t1`, { headers: { Authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401);
  });

  it('returns a tenant snapshot for an authorized operator', async () => {
    const r = await fetch(`${BASE}/api/admin/tenant/t1`, { headers: AUTH });
    expect(r.status).toBe(200);
    expect(((await r.json()) as AdminSnapshot).tenant).toBe('t1');
  });

  it('force-logs-out a tenant and revokes a member', async () => {
    expect(
      (await fetch(`${BASE}/api/admin/tenant/t7/logout`, { method: 'POST', headers: AUTH })).status,
    ).toBe(200);
    expect(calls.forceLogout).toContain('t7');
    const r = await fetch(`${BASE}/api/admin/tenant/t7/member/m3/revoke`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(r.status).toBe(200);
    expect(calls.revokeMember).toContainEqual(['t7', 'm3']);
  });

  it('erases tenant data only when confirm matches the id', async () => {
    const bad = await fetch(`${BASE}/api/admin/tenant/t9`, {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'nope' }),
    });
    expect(bad.status).toBe(400);
    expect(calls.eraseTenant).not.toContain('t9');

    const ok = await fetch(`${BASE}/api/admin/tenant/t9`, {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 't9' }),
    });
    expect(ok.status).toBe(200);
    expect(calls.eraseTenant).toContain('t9');
  });

  it('deletes an account by email (404 for an unknown one)', async () => {
    const hit = await fetch(`${BASE}/api/admin/account/delete`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'known@x.com', confirm: 'known@x.com' }),
    });
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { tenant: string }).tenant).toBe('tenant-123');
    expect(calls.eraseTenant).toContain('tenant-123'); // data wiped after the record

    const miss = await fetch(`${BASE}/api/admin/account/delete`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@x.com', confirm: 'ghost@x.com' }),
    });
    expect(miss.status).toBe(404);
  });

  it('returns the activation funnel report', async () => {
    const r = await fetch(`${BASE}/api/admin/analytics`, { headers: AUTH });
    expect(r.status).toBe(200);
    const body = (await r.json()) as FunnelReport;
    expect(body.funnel.signup).toBe(3);
    expect(body.conversion.activation).toBe(67);
  });

  it('records actions in the audit log, attributed to the operator', async () => {
    await wait(40); // let the prior actions' async audit writes settle
    const r = await fetch(`${BASE}/api/admin/audit`, { headers: AUTH });
    expect(r.status).toBe(200);
    const { entries } = (await r.json()) as {
      entries: Array<{ operator: string; action: string }>;
    };
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.operator === 'admin')).toBe(true);
    expect(entries.some((e) => e.action === 'force-logout')).toBe(true);
    expect(entries.some((e) => e.action === 'erase-tenant-data')).toBe(true);
  });
});
