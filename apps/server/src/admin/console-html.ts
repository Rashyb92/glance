/**
 * The admin/support console — a single self-contained page served at GET /admin. No build step and
 * no third-party scripts (CSP-friendly): the operator pastes their admin token (kept in sessionStorage
 * for the tab only) and every call carries it as a Bearer header to the operator-gated /api/admin API.
 */
export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Glance · Admin console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b0e14; color: #e6e9ef; }
  header { padding: 16px 24px; border-bottom: 1px solid #1c2230; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  header .dot { width: 10px; height: 10px; border-radius: 50%; background: #3b82f6; box-shadow: 0 0 12px #3b82f6; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
  .card { background: #111725; border: 1px solid #1c2230; border-radius: 12px; padding: 18px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #8b94a7; margin: 0 0 14px; }
  label { display: block; font-size: 12px; color: #8b94a7; margin: 0 0 4px; }
  input { width: 100%; padding: 9px 11px; border-radius: 8px; border: 1px solid #283044; background: #0b0e14;
    color: #e6e9ef; font: inherit; }
  input:focus { outline: none; border-color: #3b82f6; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1; min-width: 160px; }
  button { padding: 9px 14px; border-radius: 8px; border: 1px solid #283044; background: #1b2333; color: #e6e9ef;
    font: inherit; font-weight: 500; cursor: pointer; }
  button:hover { background: #232d42; }
  button.primary { background: #2563eb; border-color: #2563eb; }
  button.primary:hover { background: #1d4ed8; }
  button.danger { background: #3a1620; border-color: #7f1d1d; color: #fecaca; }
  button.danger:hover { background: #4c1d2a; }
  .muted { color: #8b94a7; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .stat { background: #0b0e14; border: 1px solid #1c2230; border-radius: 8px; padding: 10px 12px; }
  .stat b { display: block; font-size: 18px; font-weight: 600; }
  .stat span { font-size: 11px; color: #8b94a7; text-transform: uppercase; letter-spacing: .5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #1c2230; vertical-align: top; }
  th { color: #8b94a7; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1b2333;
    border: 1px solid #283044; padding: 10px 16px; border-radius: 8px; opacity: 0; transition: opacity .2s;
    pointer-events: none; max-width: 90vw; }
  #toast.show { opacity: 1; }
  #toast.err { background: #3a1620; border-color: #7f1d1d; color: #fecaca; }
  .hint { font-size: 12px; color: #8b94a7; margin-top: 6px; }
</style>
</head>
<body>
<header><span class="dot"></span><h1>Glance · Admin & Support Console</h1></header>
<main>
  <section class="card">
    <h2>Operator token</h2>
    <div class="row">
      <div><label>Admin token (Bearer)</label><input id="token" type="password" placeholder="paste operator token" autocomplete="off" /></div>
      <button class="primary" onclick="saveToken()">Save</button>
      <button onclick="clearToken()">Clear</button>
    </div>
    <p class="hint">Kept only in this browser tab (sessionStorage). Every action below is recorded in the audit log.</p>
  </section>

  <section class="card">
    <h2>Tenant lookup</h2>
    <div class="row">
      <div><label>Tenant id</label><input id="tenant" placeholder="tenant id (UUID)" /></div>
      <button class="primary" onclick="lookup()">Look up</button>
    </div>
    <div id="snapshot" style="margin-top:16px"></div>
  </section>

  <section class="card">
    <h2>Account deletion (GDPR erasure, by email)</h2>
    <div class="row">
      <div><label>Account email</label><input id="delEmail" placeholder="user@example.com" /></div>
      <button class="danger" onclick="deleteAccount()">Delete account + wipe data</button>
    </div>
    <p class="hint">Removes the login, revokes sessions, and erases all tenant data. Irreversible.</p>
  </section>

  <section class="card">
    <h2>Audit log</h2>
    <div class="row">
      <div><label>Filter by tenant (optional)</label><input id="auditTenant" placeholder="tenant id" /></div>
      <button onclick="loadAudit()">Refresh</button>
    </div>
    <div id="audit" style="margin-top:14px" class="muted">No entries loaded.</div>
  </section>
</main>
<div id="toast"></div>
<script>
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('glance_admin_token') || '';
  if (token) $('token').value = token;

  function saveToken() { token = $('token').value.trim(); sessionStorage.setItem('glance_admin_token', token); toast('Token saved'); }
  function clearToken() { token = ''; sessionStorage.removeItem('glance_admin_token'); $('token').value = ''; toast('Token cleared'); }

  function toast(msg, err) {
    const t = $('toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
    setTimeout(() => { t.className = ''; }, 2600);
  }

  async function api(path, method, body) {
    if (!token) { toast('Set an operator token first', true); throw new Error('no token'); }
    const res = await fetch(path, {
      method: method || 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && data.error) || ('HTTP ' + res.status), true); throw new Error(data.error || res.status); }
    return data;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const fmt = (v) => v === null || v === undefined ? '—' : v;

  async function lookup() {
    const id = $('tenant').value.trim(); if (!id) return toast('Enter a tenant id', true);
    let s; try { s = await api('/api/admin/tenant/' + encodeURIComponent(id)); } catch { return; }
    const set = s.settings;
    $('snapshot').innerHTML =
      '<div class="grid">' +
        stat('Plan', esc(s.plan)) +
        stat('Status', s.connected ? 'Live' : (s.loaded ? 'Idle' : 'Cold')) +
        stat('Channels', esc((s.channels || []).join(', ') || '—')) +
        stat('Viewers', fmt(s.viewers)) +
        stat('AI today', fmt(s.aiUsedToday) + ' / ' + esc(s.aiCapPerDay)) +
        stat('Archives', fmt(s.archives)) +
        stat('Team', esc(s.teamMembers)) +
        stat('Push devices', esc(s.pushDevices)) +
      '</div>' +
      (set ? '<p class="hint">surfaceThreshold ' + esc(set.surfaceThreshold) + ' · retentionDays ' + esc(set.retentionDays) +
        ' · storeMessageText ' + (set.storeMessageText ? 'on' : 'off') + '</p>' : '') +
      '<div class="row" style="margin-top:14px">' +
        '<button onclick="forceLogout(\\'' + esc(id) + '\\')">Force log-out (revoke sessions)</button>' +
        '<button class="danger" onclick="eraseTenant(\\'' + esc(id) + '\\')">Erase tenant data</button>' +
      '</div>' +
      '<div class="row" style="margin-top:10px">' +
        '<div><label>Member id</label><input id="memberId" placeholder="member id to revoke" /></div>' +
        '<button onclick="revokeMember(\\'' + esc(id) + '\\')">Revoke member</button>' +
      '</div>';
  }
  const stat = (label, val) => '<div class="stat"><b>' + val + '</b><span>' + label + '</span></div>';

  async function forceLogout(id) {
    if (!confirm('Revoke ALL owner sessions for ' + id + '?')) return;
    try { await api('/api/admin/tenant/' + encodeURIComponent(id) + '/logout', 'POST'); toast('Sessions revoked'); } catch {}
  }
  async function revokeMember(id) {
    const mid = ($('memberId') && $('memberId').value.trim()); if (!mid) return toast('Enter a member id', true);
    try { await api('/api/admin/tenant/' + encodeURIComponent(id) + '/member/' + encodeURIComponent(mid) + '/revoke', 'POST'); toast('Member revoked'); } catch {}
  }
  async function eraseTenant(id) {
    if (prompt('Type the tenant id to confirm IRREVERSIBLE data wipe:') !== id) return toast('Confirmation did not match', true);
    try { await api('/api/admin/tenant/' + encodeURIComponent(id), 'DELETE', { confirm: id }); toast('Tenant data erased'); lookup(); } catch {}
  }
  async function deleteAccount() {
    const email = $('delEmail').value.trim(); if (!email) return toast('Enter an email', true);
    if (prompt('Type the email to confirm IRREVERSIBLE account deletion:') !== email) return toast('Confirmation did not match', true);
    try { const r = await api('/api/admin/account/delete', 'POST', { email, confirm: email }); toast('Account deleted (tenant ' + r.tenant + ')'); } catch {}
  }

  async function loadAudit() {
    const t = $('auditTenant').value.trim();
    let r; try { r = await api('/api/admin/audit' + (t ? '?tenant=' + encodeURIComponent(t) : '')); } catch { return; }
    const rows = (r.entries || []).map((e) =>
      '<tr><td class="mono">' + new Date(e.ts).toISOString().replace('T',' ').slice(0,19) + '</td>' +
      '<td>' + esc(e.operator) + '</td><td>' + esc(e.action) + '</td>' +
      '<td class="mono">' + esc(e.tenant || '') + '</td><td class="mono">' + esc(e.detail || '') + '</td>' +
      '<td class="mono">' + esc(e.ip || '') + '</td></tr>').join('');
    $('audit').innerHTML = rows
      ? '<table><thead><tr><th>Time (UTC)</th><th>Operator</th><th>Action</th><th>Tenant</th><th>Detail</th><th>IP</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<span class="muted">No entries.</span>';
  }
</script>
</body>
</html>`;
