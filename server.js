'use strict';
// Secure Access Atlas server. Node 20+, no third-party dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JOURNEYS = ['Sign-in', 'Multi-factor authentication', 'Password reset', 'Account recovery'];
const STATUSES = ['new', 'needs more information', 'verified', 'duplicate', 'resolved', 'rejected'];
const PUBLISHABLE = ['verified', 'resolved'];
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const today = () => new Date().toISOString().slice(0, 10);
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max) : '');
const redact = (t) => t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]').replace(/\b\d{4,}\b/g, '[number removed]');
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };
const words = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);

function suggestCategory(r) {
  const t = (r.steps + ' ' + r.actual).toLowerCase();
  const rules = [[/captcha/, 'CAPTCHA'], [/code|expire|otp|sms/, 'Time-limited code'], [/error|invalid|message/, 'Unclear error'],
    [/reset|recover|forgot/, 'Account recovery'], [/focus|keyboard|tab /, 'Keyboard access'], [/screen reader|nvda|jaws|voiceover|label/, 'Screen reader']];
  const hit = rules.find((x) => x[0].test(t));
  return hit ? hit[1] : 'Other';
}

function seed() {
  const d = '2026-10-';
  return [
    { id: 1, service: 'City Library Portal', url: 'https://library.example.org', journey: 'Sign-in', goal: 'Sign in with a screen reader', steps: 'Open sign-in page. Tab to the CAPTCHA. Screen reader announces nothing.', expected: 'An audio or text alternative', actual: 'CAPTCHA has no accessible alternative, so sign-in is blocked', device: 'NVDA, Firefox', status: 'verified', reviewed: true, published: true, securityConcern: false, summary: 'Reporters using a screen reader cannot pass the sign-in CAPTCHA because no alternative is offered.', category: 'CAPTCHA', notes: 'Maintainer contacted.', merged: [3], updated: d + '20' },
    { id: 2, service: 'State University Student Portal', url: 'https://portal.example.edu', journey: 'Multi-factor authentication', goal: 'Enter the texted code', steps: 'Request code. Switch to messages. Return to portal.', expected: 'Time to finish', actual: 'Code expired before I could type it with my switch device', device: 'Switch access, Android', status: 'resolved', reviewed: true, published: true, securityConcern: false, summary: 'A one-time code expired too quickly for some assistive-technology users. The maintainer confirms a longer limit.', category: 'Time-limited code', notes: 'Fix confirmed by IT team.', resolution: 'Code lifetime extended and a resend link added.', updated: d + '28' },
    { id: 3, service: 'City Library Portal', url: 'https://library.example.org', journey: 'Sign-in', goal: 'Log in on my phone', steps: 'Open sign-in, CAPTCHA appears, no audio option.', expected: 'A way to continue', actual: 'CAPTCHA blocks me with a screen reader', device: 'VoiceOver, iPhone', status: 'duplicate', reviewed: true, published: false, securityConcern: false, summary: '', category: 'CAPTCHA', notes: '', mergedInto: 1, updated: d + '12' },
    { id: 4, service: 'Regional Health Portal', url: 'https://health.example.gov', journey: 'Account recovery', goal: 'Recover my account', steps: 'Choose Forgot password. Error says Invalid request.', expected: 'Clear next step', actual: 'Unclear error with no help text', device: 'Keyboard only, Chrome', status: 'new', reviewed: false, published: false, securityConcern: false, summary: '', category: '', notes: '', updated: '2026-11-01' },
  ];
}

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const secureCookie = opts.secureCookie ?? process.env.COOKIE_SECURE === '1';
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  let password = opts.password || process.env.REVIEWER_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(14).toString('base64url'); generated = true; }
  const pwHash = crypto.createHash('sha256').update(password).digest();

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbFile = path.join(dataDir, 'reports.json');
  const cFile = path.join(dataDir, 'contacts.json'); // contact details live apart from report data
  const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const save = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };
  let db = load(dbFile, null);
  if (!db) {
    const sample = (opts.seed ?? process.env.SEED_SAMPLE_DATA) !== '0' && opts.seed !== false;
    db = { nextId: sample ? 5 : 1, reports: sample ? seed() : [] };
    save(dbFile, db);
  }
  const contacts = load(cFile, {});

  const sessions = new Map();
  const hits = new Map();
  const limited = (key, max, ms) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < ms);
    arr.push(now); hits.set(key, arr);
    return arr.length > max;
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
    for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k);
  }, 600e3);
  sweep.unref();

  const ip = (req) => (trustProxy && req.headers['x-forwarded-for']) ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
  const session = (req) => {
    const m = /(?:^|; )sid=([\w-]+)/.exec(req.headers.cookie || '');
    const s = m && sessions.get(m[1]);
    return s && s.exp > Date.now() ? s : null;
  };

  const headers = (extra = {}) => ({
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin', ...extra,
  });
  const send = (res, code, obj, extra = {}) => {
    res.writeHead(code, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }));
    res.end(JSON.stringify(obj));
  };
  const fail = (code, message, fields) => Object.assign(new Error(message), { code, fields });

  const readBody = (req) => new Promise((ok, no) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return no(fail(415, 'Send JSON.'));
    let n = 0; const c = [];
    req.on('data', (d) => { n += d.length; if (n <= 20000) c.push(d); });
    req.on('end', () => {
      if (n > 20000) return no(fail(413, 'That request is too large.'));
      try { const v = JSON.parse(Buffer.concat(c).toString() || '{}'); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { no(fail(400, 'Could not read the request.')); }
    });
    req.on('error', no);
  });

  const LABEL = { service: 'Service name', goal: 'What you were trying to do', steps: 'Steps to reproduce', expected: 'What you expected', actual: 'What happened instead', device: 'Device or assistive technology', contact: 'Contact details' };
  function validateReport(b) {
    const errors = []; const r = {};
    for (const [k, max, req] of [['service', 120, 1], ['goal', 1000, 1], ['steps', 3000, 1], ['expected', 1000, 1], ['actual', 1000, 1], ['device', 200, 0], ['contact', 200, 0]]) {
      const v = clean(b[k], max + 1);
      if (req && !v) errors.push(LABEL[k] + ' is required.');
      else if (v.length > max) errors.push(LABEL[k] + ' must be ' + max + ' characters or fewer.');
      r[k] = v.slice(0, max);
    }
    try { const u = new URL(clean(b.url, 501)); if (!/^https?:$/.test(u.protocol) || u.href.length > 500) throw 0; r.url = u.href; }
    catch { errors.push('Service web address must start with http:// or https://.'); }
    if (!JOURNEYS.includes(b.journey)) errors.push('Choose a journey.'); else r.journey = b.journey;
    r.securityConcern = b.securityConcern === true;
    return { errors, r };
  }

  const duplicates = (r) => {
    const a = words(r.steps + ' ' + r.actual);
    return db.reports.filter((o) => o.id !== r.id && !o.mergedInto && o.url === r.url).map((o) => {
      const b = words(o.steps + ' ' + o.actual);
      const i = [...a].filter((x) => b.has(x)).length;
      return { id: o.id, score: Math.round((i / Math.max(1, new Set([...a, ...b]).size)) * 100) };
    }).filter((x) => x.score > 15).sort((x, y) => y.score - x.score);
  };
  const publicView = (r) => ({ id: r.id, service: r.service, journey: r.journey, status: r.status, category: r.category, summary: r.summary, resolution: r.resolution || '', updated: r.updated, grouped: 1 + (r.merged || []).length, verified: PUBLISHABLE.includes(r.status) });

  async function api(req, res, url) {
    const m = req.method; const p = url.pathname;
    if (m === 'GET' && p === '/api/public') return send(res, 200, { reports: db.reports.filter((r) => r.published && !r.securityConcern && PUBLISHABLE.includes(r.status)).map(publicView) });
    if (m === 'POST' && p === '/api/reports') {
      if (limited('rep:' + ip(req), 10, 3600e3)) throw fail(429, 'Too many reports from this connection. Please try again later.');
      const { errors, r } = validateReport(await readBody(req));
      if (errors.length) throw fail(422, 'Please fix the problems below.', errors);
      const { contact, ...rest } = r;
      const rec = { id: db.nextId++, ...rest, status: 'new', reviewed: false, published: false, summary: '', category: '', notes: '', updated: today(), created: new Date().toISOString() };
      db.reports.push(rec); save(dbFile, db);
      if (contact) { contacts[rec.id] = contact; save(cFile, contacts); }
      return send(res, 201, { ok: true });
    }
    if (m === 'POST' && p === '/api/login') {
      if (limited('login:' + ip(req), 8, 900e3)) throw fail(429, 'Too many attempts. Please wait a few minutes.');
      const b = await readBody(req);
      const given = crypto.createHash('sha256').update(String(b.password || '')).digest();
      if (!crypto.timingSafeEqual(given, pwHash)) throw fail(401, 'That password is not correct.');
      const sid = crypto.randomBytes(24).toString('base64url'); const csrf = crypto.randomBytes(18).toString('base64url');
      sessions.set(sid, { csrf, exp: Date.now() + 8 * 3600e3 });
      return send(res, 200, { csrf }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie ? '; Secure' : ''}` });
    }
    if (!p.startsWith('/api/reviewer') && p !== '/api/logout' && p !== '/api/me') throw fail(404, 'Not found.');
    const s = session(req);
    if (m === 'GET' && p === '/api/me') return send(res, s ? 200 : 401, s ? { csrf: s.csrf } : { error: 'Not signed in.' });
    if (!s) throw fail(401, 'Please sign in.');
    if (m !== 'GET' && req.headers['x-csrf-token'] !== s.csrf) throw fail(403, 'Request blocked. Reload the page and try again.');
    if (m === 'POST' && p === '/api/logout') { sessions.delete(/sid=([\w-]+)/.exec(req.headers.cookie)[1]); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
    if (m === 'GET' && p === '/api/reviewer/reports') {
      const reports = db.reports.map((r) => ({ ...r, hasContact: !!contacts[r.id], suggestion: r.mergedInto ? null : { category: suggestCategory(r), duplicates: duplicates(r) } }));
      const c = (f) => db.reports.filter(f).length;
      return send(res, 200, { reports, metrics: { reviewed: c((r) => r.reviewed), verified: c((r) => r.status === 'verified'), duplicatesGrouped: c((r) => r.mergedInto), confirmedFixes: c((r) => r.status === 'resolved'), total: db.reports.length, byStatus: Object.fromEntries(STATUSES.map((x) => [x, c((r) => r.status === x)])), byJourney: Object.fromEntries(JOURNEYS.map((j) => [j, c((r) => r.journey === j)])), medianHoursToReview: median(db.reports.filter((r) => r.created && r.reviewedAt).map((r) => (new Date(r.reviewedAt) - new Date(r.created)) / 3600e3)) } });
    }
    if (m === 'GET' && p === '/api/reviewer/pulse') return send(res, 200, { total: db.reports.length, newCount: db.reports.filter((r) => r.status === 'new').length });
    const one = /^\/api\/reviewer\/reports\/(\d+)(\/contact|\/merge)?$/.exec(p);
    if (!one) throw fail(404, 'Not found.');
    const r = db.reports.find((x) => x.id === +one[1]);
    if (!r) throw fail(404, 'Report not found.');
    if (m === 'GET' && one[2] === '/contact') return send(res, 200, { contact: contacts[r.id] || '' });
    if (m === 'DELETE' && !one[2]) {
      db.reports = db.reports.filter((x) => x.id !== r.id);
      for (const x of db.reports) { if (x.merged) x.merged = x.merged.filter((i) => i !== r.id); if (x.mergedInto === r.id) delete x.mergedInto; }
      delete contacts[r.id]; save(dbFile, db); save(cFile, contacts);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && one[2] === '/merge') {
      const mb = await readBody(req);
      const dup = db.reports.find((x) => x.id === +mb.duplicateId);
      if (!dup || dup.id === r.id || dup.mergedInto || dup.merged?.length) throw fail(422, 'Choose a different report to merge.');
      dup.mergedInto = r.id; dup.status = 'duplicate'; dup.published = false; dup.reviewed = true; dup.updated = today();
      r.merged = [...(r.merged || []), dup.id]; r.updated = today(); save(dbFile, db);
      return send(res, 200, { ok: true });
    }
    if (m === 'PATCH' && !one[2]) {
      const b = await readBody(req); const errors = [];
      if ('status' in b) { if (STATUSES.includes(b.status)) r.status = b.status; else errors.push('Unknown status.'); }
      for (const [k, max] of [['category', 60], ['summary', 1500], ['notes', 3000], ['resolution', 500]]) {
        if (k in b) { const v = clean(b[k], max + 1); if (v.length > max) errors.push(k + ' is too long.'); else r[k] = v; }
      }
      if ('securityConcern' in b) r.securityConcern = b.securityConcern === true;
      if (b.redact === true) for (const k of ['goal', 'steps', 'expected', 'actual']) r[k] = redact(r[k]);
      if (errors.length) throw fail(422, errors.join(' '));
      r.reviewed = r.status !== 'new';
      if (r.reviewed && !r.reviewedAt) r.reviewedAt = new Date().toISOString();
      if ('published' in b) r.published = b.published === true;
      if (r.published && (!PUBLISHABLE.includes(r.status) || !r.summary || r.securityConcern)) {
        r.published = false;
        if (b.published === true) { save(dbFile, db); throw fail(422, 'Not published. The report must be verified or resolved, have a reviewed summary, and not be flagged as a possible security issue. Other changes were saved.'); }
      }
      r.updated = today(); save(dbFile, db);
      return send(res, 200, { ok: true });
    }
    throw fail(404, 'Not found.');
  }

  function serveStatic(req, res, url) {
    let p; try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad request.' }); }
    if (p === '/') p = '/index.html';
    const f = path.join(PUB, path.normalize(p));
    if (!f.startsWith(PUB + path.sep) || !MIME[path.extname(f)]) return send(res, 404, { error: 'Not found.' });
    fs.readFile(f, (e, buf) => {
      if (e) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, headers({ 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache' })); res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      serveStatic(req, res, url);
    } catch (e) {
      if (e.code && typeof e.code === 'number') return send(res, e.code, { error: e.message, fields: e.fields }, e.code === 413 ? { Connection: 'close' } : {});
      console.error('Unexpected error:', e.message);
      send(res, 500, { error: 'Something went wrong on our side.' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, password, generated };
}

module.exports = { createApp };

if (require.main === module) {
  const { server, password, generated } = createApp();
  const port = +process.env.PORT || 3000; const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`Secure Access Atlas running at http://${host}:${port}`);
    if (generated) console.log(`No REVIEWER_PASSWORD set. Temporary reviewer password for this run: ${password}`);
  });
}
