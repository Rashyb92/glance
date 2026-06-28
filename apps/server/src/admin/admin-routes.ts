import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAuth } from './admin-auth';
import type { AuditLog } from './audit-log';
import type { AdminSnapshot } from '../hub';

/**
 * The operations the admin/support console drives. Wired in main from the Hub + AuthService, so the
 * route layer stays decoupled from them (mirrors {@link IntegrationDeps}).
 */
export interface AdminDeps {
  auth: AdminAuth;
  audit: AuditLog;
  /** Read-only tenant overview (no message content). */
  snapshot: (tenant: string) => Promise<AdminSnapshot>;
  /** Revoke every owner session for a tenant (kill switch). */
  forceLogout: (tenant: string) => void;
  /** Force-logout one team member; null when team management isn't on the plan, false when absent. */
  revokeMember: (tenant: string, memberId: string) => boolean | null;
  /** Wipe all of a tenant's data (archives, roster, devices, tokens, entitlement) + revoke sessions. */
  eraseTenant: (tenant: string) => void;
  /** Delete an account by email (GDPR erasure); returns the freed tenant id, or null if not found. */
  deleteAccountByEmail: (email: string) => Promise<string | null>;
}

const MAX_ADMIN_BODY = 16 * 1024;

/**
 * Admin/support console API, mounted under `/api/admin/`. Gated by operator auth (separate from
 * tenant auth) and fully audited: every action records who/what/when/target. Returns true when it
 * has handled (or claimed) the request, false when the path isn't an admin route.
 */
export function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  cors: Record<string, string>,
  admin: AdminDeps,
  ip: string,
): boolean {
  if (url !== '/api/admin' && !url.startsWith('/api/admin/')) return false;
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };

  // Operator gate — fail closed (also returns 401 when the admin API is unconfigured).
  const operator = admin.auth.resolveOperator(req.headers.authorization);
  if (!operator) {
    send(401, { error: 'unauthorized' });
    return true;
  }
  const audit = (action: string, tenant?: string, detail?: string): void => {
    void admin.audit.record({ ts: Date.now(), operator, action, tenant, detail, ip });
  };

  // GET /api/admin/audit?tenant=&limit= — recent operator actions.
  if (url.startsWith('/api/admin/audit') && req.method === 'GET') {
    const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const tenant = params.get('tenant') ?? undefined;
    const limit = Number(params.get('limit')) || 100;
    void admin.audit
      .list({ tenant, limit })
      .then((entries) => send(200, { entries }))
      .catch(() => send(500, { error: 'audit read failed' }));
    return true;
  }

  // POST /api/admin/account/delete { email, confirm:email } — GDPR erasure by email.
  if (url === '/api/admin/account/delete' && req.method === 'POST') {
    readAdminJson(req)
      .then(async (body) => {
        const email = typeof body['email'] === 'string' ? body['email'] : '';
        if (!email || body['confirm'] !== email) {
          send(400, { error: 'email and a matching confirm are required' });
          return;
        }
        const tenant = await admin.deleteAccountByEmail(email);
        if (!tenant) {
          audit('delete-account-miss', undefined, email);
          send(404, { error: 'no such account' });
          return;
        }
        admin.eraseTenant(tenant);
        audit('delete-account', tenant, email);
        send(200, { ok: true, tenant });
      })
      .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
    return true;
  }

  // /api/admin/tenant/:id and sub-actions.
  if (url.startsWith('/api/admin/tenant/')) {
    const rest = url.slice('/api/admin/tenant/'.length);

    // POST /api/admin/tenant/:id/logout — revoke all sessions.
    if (rest.endsWith('/logout') && req.method === 'POST') {
      const tenant = decodeURIComponent(rest.slice(0, -'/logout'.length));
      admin.forceLogout(tenant);
      audit('force-logout', tenant);
      send(200, { ok: true });
      return true;
    }

    // POST /api/admin/tenant/:id/member/:memberId/revoke — force-logout a member.
    const member = /^(.+)\/member\/(.+)\/revoke$/.exec(rest);
    if (member && req.method === 'POST') {
      const tenant = decodeURIComponent(member[1] ?? '');
      const memberId = decodeURIComponent(member[2] ?? '');
      const ok = admin.revokeMember(tenant, memberId);
      audit('revoke-member', tenant, memberId);
      if (ok === null) send(403, { error: 'team management is not on that plan' });
      else send(ok ? 200 : 404, { ok });
      return true;
    }

    // Single-segment tenant id: GET (overview) or DELETE (wipe data, requires confirm===id).
    if (!rest.includes('/')) {
      const tenant = decodeURIComponent(rest);
      if (req.method === 'GET') {
        void admin
          .snapshot(tenant)
          .then((snap) => {
            audit('view-tenant', tenant);
            send(200, snap);
          })
          .catch(() => send(500, { error: 'snapshot failed' }));
        return true;
      }
      if (req.method === 'DELETE') {
        readAdminJson(req)
          .then((body) => {
            if (body['confirm'] !== tenant) {
              send(400, { error: 'confirm must equal the tenant id' });
              return;
            }
            admin.eraseTenant(tenant);
            audit('erase-tenant-data', tenant);
            send(200, { ok: true });
          })
          .catch((err: Error) =>
            send(err.message === 'too_large' ? 413 : 400, { error: err.message }),
          );
        return true;
      }
    }
  }

  send(404, { error: 'not found' });
  return true;
}

function readAdminJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_ADMIN_BODY) {
        req.destroy();
        reject(new Error('too_large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', () => reject(new Error('request_error')));
  });
}
