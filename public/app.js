'use strict';
const J = ['Sign-in', 'Multi-factor authentication', 'Password reset', 'Account recovery'];
const S = ['new', 'needs more information', 'verified', 'duplicate', 'resolved', 'rejected'];
const IC = { new: '○', 'needs more information': '?', verified: '✓', duplicate: '≡', resolved: '✔✔', rejected: '✕' };
let csrf = null, q = '', flash = '', busy = false, timer = null;
const rf = { q: '', status: 'all', sort: 'newest' };
const openIds = new Set();
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const live = (t) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = t; }, 50); };
function h(t, a, ...k) {
  const e = document.createElement(t);
  for (const [x, v] of Object.entries(a || {})) x.startsWith('on') ? e.addEventListener(x.slice(2), v) : x === 'class' ? (e.className = v) : e.setAttribute(x, v);
  for (const c of k.flat(Infinity)) e.append(c == null ? '' : c.nodeType ? c : String(c));
  return e;
}
function countUp(el, n) {
  if (calm || !n) { el.textContent = n; return; }
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / 700); el.textContent = Math.round(n * p); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const stat = (label, n) => { const s = h('strong', {}, calm ? n : 0); countUp(s, n); return h('div', {}, s, label); };
function pick(id, label, opts, val, on) {
  const s = h('select', { id }, opts.map(([v, t]) => { const o = h('option', { value: v }, t); if (v === val) o.selected = true; return o; }));
  s.addEventListener('change', () => on(s.value));
  return h('div', {}, h('label', { for: id }, label), s);
}
function bars(title, entries) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return h('section', { class: 'c', 'aria-label': title }, h('h3', {}, title),
    h('ul', { class: 'bars' }, entries.map(([k, v]) => {
      const i = h('i'); const w = Math.round((v / max) * 100);
      requestAnimationFrame(() => { i.style.width = w + '%'; });
      return h('li', {}, h('span', {}, k), h('span', { class: 'bar', 'aria-hidden': 'true' }, i), h('strong', {}, v));
    })));
}
const badge = (s) => h('span', { class: 'b' }, IC[s] + ' ' + s);

async function api(path, opt = {}) {
  const method = opt.method || 'GET';
  const headers = {};
  if (opt.body) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let r;
  try { r = await fetch(path, { method, headers, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch { throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 }); }
  let d = {}; try { d = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong.'), { fields: d.fields, status: r.status });
  return d;
}

/* Public directory */
async function dirView() {
  let { reports } = await api('/api/public');
  let last = JSON.stringify(reports), jf = 'all', sf = 'all', so = 'newest';
  const list = h('div'), count = h('p', { class: 'm', role: 'status' }), stats = h('div', { class: 'g c' });
  const card = (r) => h('article', { class: 'c fade lift' },
    h('h2', {}, r.service),
    h('p', {}, badge(r.status), ' ', h('span', { class: 'b' }, r.verified ? 'Reviewed, verified issue' : 'Single user report')),
    h('p', {}, r.summary),
    h('p', { class: 'm' }, 'Affected: ' + r.journey + ' · Category: ' + r.category + ' · Last updated ' + r.updated + ' · Reports grouped: ' + r.grouped),
    r.resolution ? h('p', {}, h('strong', {}, 'Resolution (confirmed by maintainer): '), r.resolution) : '');
  const drawStats = () => stats.replaceChildren(stat('Published issues', reports.length), stat('Confirmed fixes', reports.filter((r) => r.status === 'resolved').length), stat('Reports grouped', reports.reduce((n, r) => n + r.grouped, 0)));
  const draw = () => {
    const f = reports.filter((r) => (jf === 'all' || r.journey === jf) && (sf === 'all' || r.status === sf) && (r.service + ' ' + r.summary + ' ' + r.category).toLowerCase().includes(q.toLowerCase()))
      .sort((x, y) => (so === 'grouped' ? y.grouped - x.grouped : y.updated.localeCompare(x.updated)));
    list.replaceChildren(...(f.length ? f.map(card) : [h('p', {}, 'No matching published reports.')]));
    count.textContent = 'Showing ' + f.length + ' of ' + reports.length + ' published reports';
  };
  const search = h('input', { id: 's', type: 'search', value: q });
  search.addEventListener('input', () => { q = search.value; draw(); });
  const box = h('div', {}, h('h1', {}, 'Public issue directory'),
    h('p', { class: 'warn' }, 'Only human-reviewed reports appear here. Listings reflect people’s experiences. They are not a finding that a site is secure, insecure, accessible, inaccessible or compliant.'),
    stats,
    h('div', { class: 'row c' }, h('div', {}, h('label', { for: 's' }, 'Search services and issues'), search),
      pick('jf', 'Journey', [['all', 'All journeys'], ...J.map((j) => [j, j])], jf, (v) => { jf = v; draw(); }),
      pick('sf', 'Status', [['all', 'All statuses'], ['verified', 'verified'], ['resolved', 'resolved']], sf, (v) => { sf = v; draw(); }),
      pick('so', 'Sort by', [['newest', 'Recently updated'], ['grouped', 'Most reports grouped']], so, (v) => { so = v; draw(); })),
    count, list);
  drawStats(); draw();
  timer = setInterval(async () => {
    if (document.hidden) return;
    try { const d = await api('/api/public'); const n = JSON.stringify(d.reports); if (n !== last) { last = n; reports = d.reports; drawStats(); draw(); live('Directory updated'); } } catch { /* try again later */ }
  }, 60000);
  return box;
}

/* Report form */
function formView() {
  const err = h('div', { role: 'alert', class: 'warn', tabindex: '-1', hidden: '' });
  const f = h('form', { novalidate: '' });
  const field = (id, label, hint, kind, req, opts) => [
    h('label', { for: id }, label + (req ? ' (required)' : ' (optional)'), hint ? h('span', { class: 'h' }, hint) : ''),
    kind === 'select' ? h('select', { id }, opts.map((o) => h('option', {}, o)))
      : kind === 'area' ? h('textarea', { id, rows: '3' }) : h('input', { id, type: kind || 'text' })];
  const btn = h('button', { type: 'submit', class: 'p' }, 'Submit report');
  f.append(...[err, h('h1', {}, 'Report a barrier'),
    h('p', {}, 'Anonymous reports are welcome. There is no time limit on this form.'),
    h('p', { class: 'warn' }, 'Never include passwords, one-time codes, recovery answers, cookies or full account numbers. Screenshots are not collected in this version. If one would help, describe it in words and remove any personal details.'),
    field('service', 'Service name', '', 'text', 1), field('url', 'Service web address', 'For example https://library.example.org', 'url', 1),
    field('journey', 'Journey', '', 'select', 1, J), field('goal', 'What were you trying to do?', '', 'area', 1),
    field('steps', 'Steps to reproduce', 'One step per line.', 'area', 1), field('expected', 'What did you expect to happen?', '', 'area', 1),
    field('actual', 'What happened instead?', '', 'area', 1), field('device', 'Device, browser or assistive technology', 'Share only what you are comfortable with.', 'text'),
    h('label', { class: 'cb' }, h('input', { id: 'sec', type: 'checkbox' }), h('span', {}, 'This may describe a security vulnerability', h('span', { class: 'h' }, 'We will keep it private and will not publish it. Please do not describe how to exploit it.'))),
    field('contact', 'Contact for follow-up', 'Only if you want one. Kept separate from the report and never published.', 'text'),
    h('p', {}, btn)].flat(Infinity));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const v = (id) => f.querySelector('#' + id).value;
    busy = true; btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Sending…'; live('Sending your report');
    try {
      await api('/api/reports', { method: 'POST', body: { service: v('service'), url: v('url'), journey: v('journey'), goal: v('goal'), steps: v('steps'), expected: v('expected'), actual: v('actual'), device: v('device'), contact: v('contact'), securityConcern: f.querySelector('#sec').checked } });
      const m = $('app');
      m.replaceChildren(h('h1', {}, 'Thank you'), h('p', { class: 'c' }, 'Your report was received. A person will review it. Nothing is published automatically.'));
      m.querySelector('h1').tabIndex = -1; m.querySelector('h1').focus(); live('Report submitted');
    } catch (ex) {
      err.hidden = false;
      err.replaceChildren(h('strong', {}, ex.message), ex.fields ? h('ul', {}, ex.fields.map((x) => h('li', {}, x))) : '');
      err.focus(); live('Report not sent');
    } finally { busy = false; btn.removeAttribute('aria-disabled'); btn.textContent = 'Submit report'; }
  });
  return f;
}

/* Reviewer */
function loginView() {
  const err = h('p', { role: 'alert', class: 'warn', hidden: '' });
  const f = h('form', {}, h('h1', {}, 'Reviewer sign-in'), err,
    h('label', { for: 'pw' }, 'Reviewer password'), h('input', { id: 'pw', type: 'password', autocomplete: 'current-password' }),
    h('p', {}, h('button', { class: 'p', type: 'submit' }, 'Sign in')));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { csrf = (await api('/api/login', { method: 'POST', body: { password: f.querySelector('#pw').value } })).csrf; go(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; live(ex.message); }
  });
  return f;
}

async function reviewView() {
  if (!csrf) return loginView();
  let data;
  try { data = await api('/api/reviewer/reports'); } catch (ex) { if (ex.status === 401) { csrf = null; return loginView(); } throw ex; }
  const { reports, metrics } = data;
  const act = async (id, fn, ok) => {
    if (id) openIds.add(id);
    try { await fn(); flash = ''; live(ok); } catch (ex) { flash = ex.message; live(ex.message); }
    go(id);
  };
  let known = metrics.total;
  const banner = h('div', { class: 'warn', role: 'status', hidden: '' });
  const box = h('div', {}, h('h1', {}, 'Reviewer dashboard'),
    h('p', {}, h('button', { onclick: async () => { try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* already signed out */ } csrf = null; go(); } }, 'Sign out')),
    flash ? h('p', { class: 'warn', role: 'alert' }, flash) : '', banner,
    h('div', { class: 'g c' }, [['Reviewed', metrics.reviewed], ['Verified', metrics.verified], ['Duplicates grouped', metrics.duplicatesGrouped], ['Confirmed fixes', metrics.confirmedFixes]].map((x) => stat(x[0], x[1])),
      h('div', {}, h('strong', {}, metrics.medianHoursToReview == null ? '–' : metrics.medianHoursToReview), 'Median hours to review')),
    h('div', { class: 'two' }, bars('Reports by status', Object.entries(metrics.byStatus)), bars('Reports by journey', Object.entries(metrics.byJourney))),
    h('p', { class: 'm' }, 'Counts only. No individuals are tracked and no AI scores are used.'));
  const items = [], list = h('div');
  timer = setInterval(async () => {
    if (document.hidden || !csrf) return;
    try {
      const p = await api('/api/reviewer/pulse');
      if (p.total > known) {
        const n = p.total - known;
        banner.hidden = false;
        banner.replaceChildren(h('strong', {}, n + (n === 1 ? ' new report has' : ' new reports have') + ' arrived. '), h('button', { onclick: () => go() }, 'Refresh list'), h('span', { class: 'h' }, 'Unsaved edits on this page will be lost.'));
        live(n + (n === 1 ? ' new report arrived' : ' new reports arrived'));
      }
    } catch (ex) { if (ex.status === 401) { csrf = null; go(); } }
  }, 30000);
  for (const r of reports.filter((x) => !x.mergedInto)) {
    const sel = h('select', { id: 'st' + r.id }, S.map((s) => { const o = h('option', { value: s }, s); if (s === r.status) o.selected = true; return o; }));
    const cat = h('input', { id: 'ca' + r.id, type: 'text', value: r.category });
    const sum = h('textarea', { id: 'su' + r.id, rows: '3' }); sum.value = r.summary;
    const rs = h('input', { id: 'rs' + r.id, type: 'text', value: r.resolution || '' });
    const nt = h('textarea', { id: 'nt' + r.id, rows: '2' }); nt.value = r.notes;
    const sc = h('input', { id: 'sc' + r.id, type: 'checkbox' }); sc.checked = r.securityConcern;
    const fields = () => ({ status: sel.value, category: cat.value, summary: sum.value, resolution: rs.value, notes: nt.value, securityConcern: sc.checked });
    const contactOut = h('p', { class: 'm' });
    const patch = (extra, ok) => act(r.id, () => api('/api/reviewer/reports/' + r.id, { method: 'PATCH', body: { ...fields(), ...extra } }), ok);
    const sg = r.suggestion;
    const el = h('details', { class: 'c fade lift' },
      h('summary', {}, h('h2', { id: 't' + r.id, tabindex: '-1', class: 'inl' }, '#' + r.id + ' ' + r.service), ' ', badge(r.status), ' ', h('span', { class: 'b' }, r.published ? 'Published' : 'Not public'), ' ', r.securityConcern ? h('span', { class: 'b' }, '⚠ Possible security issue') : '', ' ', r.merged && r.merged.length ? h('span', { class: 'b' }, 'Merged: ' + r.merged.length) : ''),
      h('h3', {}, 'Original report (untrusted text, shown as plain text)'),
      h('div', { class: 'x' }, h('p', {}, h('strong', {}, r.journey + ': '), r.goal), h('p', {}, 'Steps: ' + r.steps), h('p', {}, 'Expected: ' + r.expected + ' | Actual: ' + r.actual), h('p', { class: 'm' }, 'Device: ' + (r.device || 'not provided') + ' · Service: ' + r.url)),
      h('p', {}, h('button', { onclick: () => patch({ redact: true }, 'Emails and long numbers removed from the report text') }, 'Remove emails and long numbers'), ' ',
        r.hasContact ? h('button', { onclick: async () => { try { contactOut.textContent = 'Contact: ' + (await api('/api/reviewer/reports/' + r.id + '/contact')).contact; } catch (ex) { contactOut.textContent = ex.message; } } }, 'Show contact details') : ''),
      contactOut,
      h('h3', {}, 'Suggestions (not findings; you decide)'),
      h('p', {}, 'Suggested category: ', h('strong', {}, sg.category), ' ', h('button', { onclick: () => { cat.value = sg.category; live('Category filled. Save to keep it.'); } }, 'Use it')),
      h('p', {}, sg.duplicates.length ? ['Possible duplicates: ', sg.duplicates.map((d) => h('span', {}, h('button', { onclick: () => act(r.id, () => api('/api/reviewer/reports/' + r.id + '/merge', { method: 'POST', body: { duplicateId: d.id } }), 'Merged #' + d.id + '. Its submission is kept.') }, 'Merge #' + d.id + ' (' + d.score + '% word overlap)'), ' '))] : 'No likely duplicates.'),
      h('p', { class: 'm' }, 'A question you could ask: ' + (r.device ? 'Did this happen on every attempt?' : 'Which device or assistive technology were you using?')),
      h('label', { for: 'st' + r.id }, 'Status'), sel,
      h('label', { for: 'ca' + r.id }, 'Category'), cat,
      h('label', { for: 'su' + r.id }, 'Public summary', h('span', { class: 'h' }, 'Write only what the reporter provided. No private details or exploit information.')), sum,
      h('label', { for: 'rs' + r.id }, 'Resolution note (only after the maintainer confirms a fix)'), rs,
      h('label', { for: 'nt' + r.id }, 'Private reviewer notes'), nt,
      h('label', { class: 'cb', for: 'sc' + r.id }, sc, h('span', {}, 'Possible security issue (blocks publishing)')),
      h('p', {}, h('button', { class: 'p', onclick: () => patch({}, 'Saved') }, 'Save'), ' ',
        h('button', { onclick: () => patch({ published: !r.published }, r.published ? 'Unpublished' : 'Published') }, r.published ? 'Unpublish' : 'Publish after review'), ' ',
        h('button', { onclick: () => { if (confirm('Delete this report and any contact details permanently?')) act(null, () => api('/api/reviewer/reports/' + r.id, { method: 'DELETE' }), 'Report deleted'); } }, 'Delete (removal request)')));
    if (openIds.has(r.id)) el.open = true;
    el.addEventListener('toggle', () => { if (el.open) openIds.add(r.id); else openIds.delete(r.id); });
    items.push({ r, el });
  }
  const count = h('p', { class: 'm', role: 'status' });
  const apply = () => {
    const ql = rf.q.toLowerCase();
    const sorted = [...items].sort((x, y) => (rf.sort === 'oldest' ? x.r.updated.localeCompare(y.r.updated) : rf.sort === 'id' ? x.r.id - y.r.id : y.r.updated.localeCompare(x.r.updated)));
    let shown = 0;
    for (const { r, el } of sorted) {
      const ok = (rf.status === 'all' || r.status === rf.status) && (r.service + ' ' + r.goal + ' ' + r.actual + ' ' + r.category).toLowerCase().includes(ql);
      el.hidden = !ok; if (ok) shown++;
      list.append(el);
    }
    count.textContent = 'Showing ' + shown + ' of ' + items.length + ' reports';
  };
  const rq = h('input', { id: 'rq', type: 'search', value: rf.q });
  rq.addEventListener('input', () => { rf.q = rq.value; apply(); });
  box.append(h('div', { class: 'row c' }, h('div', {}, h('label', { for: 'rq' }, 'Search reports'), rq),
    pick('rs2', 'Status', [['all', 'All statuses'], ...S.map((x) => [x, x])], rf.status, (v) => { rf.status = v; apply(); }),
    pick('ro', 'Sort by', [['newest', 'Recently updated'], ['oldest', 'Oldest update first'], ['id', 'Report number']], rf.sort, (v) => { rf.sort = v; apply(); })),
    count, list);
  apply();
  return box;
}

/* Router */
async function go(focusId) {
  clearInterval(timer);
  const v = location.hash.slice(1) || 'directory';
  document.querySelectorAll('nav a').forEach((a) => (a.getAttribute('href') === '#' + v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const m = $('app'); m.setAttribute('aria-busy', 'true');
  try { m.replaceChildren(v === 'report' ? formView() : v === 'review' ? await reviewView() : await dirView()); }
  catch (ex) { m.replaceChildren(h('h1', {}, 'Something went wrong'), h('p', { class: 'warn', role: 'alert' }, ex.message)); }
  m.removeAttribute('aria-busy');
  const target = (focusId && $('t' + focusId)) || m.querySelector('h1');
  if (target) { target.tabIndex = -1; target.focus(); }
  document.title = (m.querySelector('h1') ? m.querySelector('h1').textContent : 'Home') + ' · Secure Access Atlas';
}
addEventListener('hashchange', () => { flash = ''; go(); });
api('/api/me').then((d) => { csrf = d.csrf; }, () => {}).finally(() => go());
