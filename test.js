'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./server');

let base, server, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-'));
  ({ server } = createApp({ dataDir: dir, password: 'test-pass' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const j = (p, o = {}) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) });
const good = { service: 'Test Portal', url: 'https://test.example.org', journey: 'Sign-in', goal: 'Log in', steps: 'Open page', expected: 'Works', actual: 'Fails', contact: 'me@example.org' };
async function login() {
  const r = await j('/api/login', { method: 'POST', body: { password: 'test-pass' } });
  return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf, status: r.status };
}

test('public list shows only reviewed, published reports', async () => {
  const d = await (await j('/api/public')).json();
  assert.ok(d.reports.length >= 1);
  assert.ok(d.reports.every((r) => r.verified && !('notes' in r) && !('url' in r)));
});
test('anonymous report is accepted, validated, and not public', async () => {
  assert.strictEqual((await j('/api/reports', { method: 'POST', body: { ...good, url: 'javascript:alert(1)' } })).status, 422);
  assert.strictEqual((await j('/api/reports', { method: 'POST', body: { ...good, steps: '' } })).status, 422);
  assert.strictEqual((await j('/api/reports', { method: 'POST', body: good })).status, 201);
  const pub = JSON.stringify(await (await j('/api/public')).json());
  assert.ok(!pub.includes('Test Portal') && !pub.includes('me@example.org'));
});
test('reviewer routes need sign-in and a CSRF token', async () => {
  assert.strictEqual((await j('/api/reviewer/reports')).status, 401);
  assert.strictEqual((await j('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const s = await login();
  assert.strictEqual(s.status, 200);
  const r = await j('/api/reviewer/reports/4', { method: 'PATCH', headers: { cookie: s.cookie }, body: { status: 'verified' } });
  assert.strictEqual(r.status, 403);
});
test('publishing rules and security flag are enforced on the server', async () => {
  const s = await login(); const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
  let r = await j('/api/reviewer/reports/4', { method: 'PATCH', headers: h, body: { status: 'new', published: true } });
  assert.strictEqual(r.status, 422);
  r = await j('/api/reviewer/reports/4', { method: 'PATCH', headers: h, body: { status: 'verified', summary: 'Reviewed summary', securityConcern: true, published: true } });
  assert.strictEqual(r.status, 422);
  r = await j('/api/reviewer/reports/4', { method: 'PATCH', headers: h, body: { status: 'verified', summary: 'Reviewed summary', category: 'Unclear error', securityConcern: false, published: true } });
  assert.strictEqual(r.status, 200);
  assert.ok((await (await j('/api/public')).json()).reports.some((x) => x.id === 4));
});
test('merge keeps the duplicate submission; contact is reviewer-only', async () => {
  const s = await login(); const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
  const m = await j('/api/reviewer/reports/1/merge', { method: 'POST', headers: h, body: { duplicateId: 4 } });
  assert.strictEqual(m.status, 200);
  const list = await (await j('/api/reviewer/reports', { headers: h })).json();
  assert.ok(list.reports.find((x) => x.id === 4).mergedInto === 1);
  const c = await (await j('/api/reviewer/reports/5/contact', { headers: h })).json();
  assert.strictEqual(c.contact, 'me@example.org');
});
test('static files are served with security headers; traversal is blocked', async () => {
  const r = await fetch(base + '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual((await fetch(base + '/..%2Fserver.js')).status, 404);
  assert.strictEqual((await fetch(base + '/server.js')).status, 404);
});
test('pulse and chart metrics are available to reviewers only', async () => {
  assert.strictEqual((await j('/api/reviewer/pulse')).status, 401);
  const s = await login(); const h = { cookie: s.cookie };
  const p = await (await j('/api/reviewer/pulse', { headers: h })).json();
  assert.ok(p.total >= 4 && typeof p.newCount === 'number');
  const m = (await (await j('/api/reviewer/reports', { headers: h })).json()).metrics;
  assert.strictEqual(m.total, p.total);
  assert.ok('verified' in m.byStatus && 'Sign-in' in m.byJourney);
});
