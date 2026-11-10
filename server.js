// Safa Leaderboard — сервер.
// • Раз в N секунд забирает сделки из Bitrix24 (вебхук только на сервере)
// • Отдаёт ТВ-табло по публичной ссылке /b/<ключ> и кабинет руководителя /admin
// • Настройки (доски, планы, бонусы, фото) хранятся в Postgres (DATABASE_URL)
// • База Safa (сделки, лиды, звонки) + аналитика + AI-ассистент, аккаунты руководителей секторов
// ENV: BITRIX_WEBHOOK, DASH_PASSWORD, DATABASE_URL, ANTHROPIC_API_KEY, PORT
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const store = require('./lib/store');
const bx = require('./lib/bitrix');
const C = require('./lib/calc');
const auth = require('./lib/auth');
const wh = require('./lib/warehouse');
const AN = require('./lib/analytics');
const att = require('./lib/attendance');
const cai = require('./lib/callai');
const EF = require('./lib/efficiency');

const PORT = process.env.PORT || 3000;
const PASS = process.env.DASH_PASSWORD || '';
const PUB = path.join(__dirname, 'public');

let cfg = null;
const cache = { deals: [], users: [], userMap: {}, deps: [], range: null, syncedAt: 0, error: '', meta: null };
let events = [], seq = 0, seen = null, syncing = null, timer = null;

/* ===== синхронизация с Bitrix24 ===== */
function wantedRange() {
  const today = C.todayKey(cfg.settings.tz);
  let from = C.weekStart(today) < C.monthRange(today).from ? C.weekStart(today) : C.monthRange(today).from, to = today;
  for (const b of cfg.boards) {
    if (!b.active) continue;
    const p = C.periodOf(b, today);
    if (p.from < from) from = p.from;
    if (p.to > to) to = p.to;
  }
  return { from, to, today };
}

async function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const s = cfg.settings, { from, to } = wantedRange();
    try {
      const [deps, users, deals] = await Promise.all([
        bx.departments(), bx.users(), bx.deals(from, C.addDays(to, 1), s.stages, s.dateField),
      ]);
      const userMap = Object.fromEntries(users.map(u => [u.id, u]));
      const missing = [...new Set(deals.map(d => d.uid))].filter(id => !userMap[id]);
      if (missing.length) (await bx.users(missing)).forEach(u => { userMap[u.id] = u; users.push(u); });
      // новые продажи → события для попапа
      const ids = new Set(deals.map(d => d.id));
      if (seen) {
        const now = Date.now();
        for (const d of deals) if (!seen.has(d.id)) events.push({ seq: ++seq, at: now, ...d });
        events = events.filter(e => now - e.at < 15 * 60e3).slice(-200);
      }
      seen = ids;
      Object.assign(cache, { deals, users, userMap, deps, range: { from, to }, syncedAt: Date.now(), error: '' });
    } catch (e) {
      cache.error = String(e.message || e);
      console.error('sync:', cache.error);
    } finally { syncing = null; }
  })();
  return syncing;
}
function loop() {
  clearTimeout(timer);
  timer = setTimeout(async () => { await sync(); loop(); }, Math.max(15, +cfg.settings.syncSec || 30) * 1000);
}

function photos() {
  const out = {};
  for (const k of store.keys('photo:')) out[k.slice(6)] = (store.get(k) || {}).ts || 1;
  return out;
}
function ctx(deals) {
  return {
    deals: deals || cache.deals, users: cache.users, userMap: cache.userMap, deps: cache.deps,
    managers: cfg.managers, settings: cfg.settings, today: C.todayKey(cfg.settings.tz), photos: photos(), penalties: [...cfg.penalties, ...att.penalties(cfg)],
  };
}
function stageNames() { return Object.fromEntries(((cache.meta || {}).stages || []).map(x => [x.id, x.name])); }
async function reportFor({ from, to, sector, boardId }, scope) {
  const A = AN.allowedUids(ctx(), scope, { sector: sector || '' });
  const deals = (await dealsFor(from, to)).filter(d => A.has(d.uid));
  return C.report(cfg, ctx(deals), { from, to, boardId: boardId || '', uid: '' });
}
async function dealsFor(from, to) {
  const r = cache.range;
  if (r && from >= r.from && to <= r.to) return cache.deals;
  return bx.deals(from, C.addDays(to, 1), cfg.settings.stages, cfg.settings.dateField);
}

/* ===== http helpers ===== */
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const file = (res, name) => send(res, 200, fs.readFileSync(path.join(PUB, name)), 'text/html; charset=utf-8');
function readBody(req, limit = 4e6) {
  return new Promise((ok, fail) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > limit) { fail(new Error('too large')); req.destroy(); } });
    req.on('end', () => ok(b)); req.on('error', fail);
  });
}
const loginPage = err => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · Safa Leaderboard</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;700;800&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 600px at 0 0,#ffe1ef,transparent 60%),radial-gradient(900px 600px at 100% 100%,#dff3ff,transparent 60%),#fff8f0;font-family:Poppins,system-ui,sans-serif;color:#1f1640}
form{background:#fff;padding:32px;border-radius:24px;width:min(360px,90vw);display:flex;flex-direction:column;gap:12px;box-shadow:0 30px 60px -30px rgba(123,92,255,.5)}
h1{margin:0 0 6px;font-size:22px}h1 b{background:linear-gradient(90deg,#ff3d8b,#a24bff,#22b8f0);-webkit-background-clip:text;color:transparent}
input{font:inherit;padding:13px 14px;border:1.5px solid #ece4ff;border-radius:12px;outline:none}input:focus{border-color:#a24bff}
button{font:inherit;font-weight:700;padding:13px;border:0;border-radius:12px;background:linear-gradient(90deg,#ff3d8b,#a24bff);color:#fff;cursor:pointer}.e{color:#be123c;font-size:14px}</style>
<form method="post" action="/login"><h1>Safa <b>Leaderboard</b></h1>${err ? '<div class="e">Неверный логин или пароль</div>' : ''}
<input name="login" placeholder="Логин (руководителю сектора)" autocomplete="username" autocapitalize="none">
<input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required><button>Войти</button>
<div style="font-size:12px;color:#8a83a8">Владелец входит только по паролю</div></form></html>`;

function csv(rows) {
  return '﻿' + rows.map(r => r.map(v => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
}

/* ===== маршруты ===== */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');

  // --- публичное: табло по ключу, фото ---
  let m;
  if ((m = p.match(/^\/b\/([\w-]+)\/?$/))) return file(res, 'board.html');
  if ((m = p.match(/^\/api\/board\/([\w-]+)$/))) {
    const b = cfg.boards.find(x => x.key === m[1]);
    if (!b) return send(res, 404, { error: 'Лидерборд не найден' });
    if (!b.active) return send(res, 200, { paused: true, name: b.name });
    if (!cache.syncedAt) await sync();
    const data = C.computeBoard(b, ctx());
    const hasSince = url.searchParams.has('since'), since = +url.searchParams.get('since') || 0;
    const mem = new Set(data.members), { from, to } = data.period;
    const ev = hasSince ? events.filter(e => e.seq > since && (e.test || (mem.has(e.uid) && e.dk >= from && e.dk <= to)))
      .map(e => { const r = data._all.find(x => x.uid === e.uid) || { name: e.name || 'Менеджер', photo: '' };
        return { name: r.name, photo: r.photo, place: r.place, total: r.sum, sector: r.sectorName || '', seq: e.seq, sum: e.sum, title: e.title }; }) : [];
    return send(res, 200, { ...data, members: undefined, _all: undefined, events: ev, seq, syncedAt: cache.syncedAt, error: cache.error, company: cfg.settings.company });
  }
  if (p === '/sale.mp3') {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUB, 'sale.mp3')));
  }
  if ((m = p.match(/^\/photo\/(\w+)$/))) {
    const ph = store.get('photo:' + m[1]);
    if (!ph) return send(res, 404, 'no photo', 'text/plain');
    const [, type, b64] = String(ph.data).match(/^data:([^;]+);base64,(.*)$/) || [];
    if (!b64) return send(res, 404, 'bad photo', 'text/plain');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(Buffer.from(b64, 'base64'));
  }

  // --- терминал Hikvision: события прихода/ухода (HTTP Listening терминала или мост hik-bridge) ---
  if ((m = p.match(/^\/api\/att\/(\w+)\/?$/))) {
    const t = att.token(), ok = m[1].length === t.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(t));
    if (!ok) return send(res, 403, { error: 'bad token' });
    if (req.method !== 'POST') return send(res, 200, { ok: true, service: 'Safa attendance' });
    const body = await new Promise(ok => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n < 12e6) ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', () => ok('')); });
    const evs = att.parse(body, req.headers['content-type']);
    const n = evs.length ? await att.ingest(evs, cfg, req.headers['user-agent'] && /bridge/i.test(req.headers['user-agent']) ? 'bridge' : 'terminal') : 0;
    return send(res, 200, { ok: true, accepted: n });
  }

  // --- вход ---
  if (p === '/login' && req.method === 'POST') {
    const q = new URLSearchParams(await readBody(req, 1e4));
    const u = auth.login(q.get('login'), q.get('password'));
    if (!u) { await new Promise(r => setTimeout(r, 600)); return send(res, 401, loginPage(true), 'text/html; charset=utf-8'); }
    res.writeHead(302, { 'Set-Cookie': [auth.cookieFor(u), 'lb=; Path=/; Max-Age=0'], Location: '/admin' });
    return res.end();
  }
  if (p === '/logout') {
    res.writeHead(302, { 'Set-Cookie': ['lb=; Path=/; Max-Age=0', 'sid=; Path=/; Max-Age=0'], Location: '/admin' }); return res.end();
  }
  const user = auth.fromReq(req);
  if (!user) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, loginPage(false), 'text/html; charset=utf-8');
  }
  const scope = auth.scopeOf(user), isOwner = user.role === 'owner';
  // только владелец: настройки, фото, сверка, пересинхронизация, аккаунты, база
  const ownerOnly = (p === '/api/admin/config' && req.method !== 'GET') || p.startsWith('/api/admin/photo/') || p === '/api/admin/diag' ||
    p === '/api/admin/resync' || /\/test-sale$/.test(p) || p.startsWith('/api/admin/users') || p.startsWith('/api/admin/wh/') || p.startsWith('/api/admin/att/') || p.startsWith('/api/admin/callai/settings');
  if (ownerOnly && !isOwner) return send(res, 403, { error: 'Доступно только владельцу' });

  // --- кабинет ---
  if (p === '/' || p === '/index.html') { res.writeHead(302, { Location: '/admin' }); return res.end(); }
  if (p === '/admin' || p.startsWith('/admin/')) return file(res, 'admin.html');

  if (p === '/api/admin/state') {
    if (!cache.syncedAt) await sync();
    if (!cache.meta && bx.configured()) cache.meta = await bx.meta().catch(e => ({ error: String(e.message) }));
    const used = new Set([...Object.keys(cfg.managers), ...cache.deals.map(d => d.uid)]);
    const users = cache.users.filter(u => u.active || used.has(u.id))
      .map(u => ({ ...u, photoUrl: store.get('photo:' + u.id) ? `/photo/${u.id}?v=${store.get('photo:' + u.id).ts}` : u.photo }));
    return send(res, 200, {
      cfg, users, deps: cache.deps, meta: cache.meta || {}, store: store.kind(), bitrix: bx.configured(),
      syncedAt: cache.syncedAt, error: cache.error, today: C.todayKey(cfg.settings.tz),
      boards: cfg.boards.map(b => ({ id: b.id, members: C.computeBoard(b, ctx()).members })),
      dealUids: [...new Set(cache.deals.map(d => d.uid))],
      secOf: C.sectorMap(ctx()), me: auth.publicUser(user), sectors: C.sectorsOf(cache.deps).map(d => ({ id: d.id, name: d.name })),
      accounts: isOwner ? auth.list() : undefined, attPen: isOwner ? att.penalties(cfg) : undefined, wh: wh.status(), ai: !!process.env.ANTHROPIC_API_KEY,
    });
  }
  if (p === '/api/admin/config' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    const prevStages = JSON.stringify([cfg.settings.stages, cfg.settings.dateField]);
    cfg = C.normalize({ settings: body.settings, managers: body.managers, boards: body.boards, penalties: body.penalties || [], sectorBoards: cfg.sectorBoards || [], presetV: cfg.presetV, oneBoardV2: cfg.oneBoardV2, brandV3: cfg.brandV3 });
    await store.set('config', cfg); wh.setCfg(cfg); att.touch(); cai.setCfg(cfg);
    if (JSON.stringify([cfg.settings.stages, cfg.settings.dateField]) !== prevStages) seen = null;
    sync().then(loop);
    return send(res, 200, { ok: true, cfg });
  }
  if ((m = p.match(/^\/api\/admin\/photo\/(\w+)$/))) {
    if (req.method === 'DELETE') { await store.del('photo:' + m[1]); return send(res, 200, { ok: true }); }
    const { data } = JSON.parse(await readBody(req));
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(data || '')) return send(res, 400, { error: 'Нужна картинка' });
    await store.set('photo:' + m[1], { data, ts: Date.now() });
    return send(res, 200, { ok: true, url: `/photo/${m[1]}?v=${Date.now()}` });
  }
  // Сверка кассы за день: какие сделки Bitrix24 попали / не попали в рейтинг и почему
  if (p === '/api/admin/diag') {
    const S = cfg.settings, date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : C.todayKey(S.tz);
    const next = C.addDays(date, 1), F = S.dateField;
    const sel = ['ID', 'TITLE', 'OPPORTUNITY', 'ASSIGNED_BY_ID', 'STAGE_ID', 'CATEGORY_ID', F, 'DATE_CREATE', 'MOVED_TIME', 'CLOSEDATE'];
    const list = async filter => {
      const out = []; let start = 0;
      for (let k = 0; k < 40; k++) {
        const r = await bx.call('crm.deal.list', { order: { ID: 'DESC' }, filter, select: sel, start });
        out.push(...(r.result || [])); if (r.next == null) break; start = r.next;
      }
      return out;
    };
    const [byDate, movedToday, createdToday] = await Promise.all([
      list({ ['>=' + F]: date, ['<' + F]: next }),
      list({ '@STAGE_ID': S.stages, '>=MOVED_TIME': date + 'T00:00:00' + S.tzOffset, '<MOVED_TIME': next + 'T00:00:00' + S.tzOffset }).catch(() => []),
      list({ '>=DATE_CREATE': date + 'T00:00:00' + S.tzOffset, '<DATE_CREATE': next + 'T00:00:00' + S.tzOffset }).catch(() => []),
    ]);
    if (!cache.meta && bx.configured()) cache.meta = await bx.meta().catch(() => ({}));
    const stName = Object.fromEntries(((cache.meta || {}).stages || []).map(x => [x.id, x.name + ' · ' + x.category]));
    const board = cfg.boards.find(b => b.active) || cfg.boards[0];
    const members = board ? new Set(C.computeBoard(board, ctx()).members) : new Set();
    const uname = id => (cfg.managers[id] || {}).name || (cache.userMap[id] || {}).name || ('ID ' + id);
    const row = d => ({ id: String(d.ID), title: d.TITLE, sum: +d.OPPORTUNITY || 0, uid: String(d.ASSIGNED_BY_ID), manager: uname(String(d.ASSIGNED_BY_ID)),
      stage: d.STAGE_ID, stageName: stName[d.STAGE_ID] || d.STAGE_ID, date: String(d[F] || '').slice(0, 10), moved: String(d.MOVED_TIME || '').slice(0, 16), created: String(d.DATE_CREATE || '').slice(0, 16) });
    const reason = d => !S.stages.includes(d.stage) ? 'стадия не отмечена' : !d.date ? 'не заполнена дата заказа' : d.date !== date ? 'другая дата заказа' : (cfg.managers[d.uid] || {}).hidden ? 'менеджер скрыт' : board && !members.has(d.uid) ? 'менеджер не на доске' : '';
    const A = byDate.map(row).map(d => ({ ...d, why: reason(d) }));
    const counted = A.filter(d => !d.why);
    const stages = {};
    A.forEach(d => { const x = stages[d.stage] || (stages[d.stage] = { stage: d.stage, name: d.stageName, cnt: 0, sum: 0, on: S.stages.includes(d.stage) }); x.cnt++; x.sum += d.sum; });
    const seen = new Set(A.map(d => d.id));
    const other = [...movedToday, ...createdToday].map(row).filter(d => !seen.has(d.id) && (seen.add(d.id), true)).map(d => ({ ...d, why: reason(d) }));
    return send(res, 200, {
      date, dateField: F, counted: { cnt: counted.length, sum: counted.reduce((a, d) => a + d.sum, 0) },
      stages: Object.values(stages).sort((a, b) => b.sum - a.sum), deals: A, other,
    });
  }
  // посещаемость (руководитель видит только свои секторы)
  if (p === '/api/admin/att') {
    const A = AN.allowedUids(ctx(), scope, { sector: url.searchParams.get('sector') || '' });
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : '';
    const r = att.report(cfg, { date, month }, uid => A.has(uid));
    const secOf = A.secOf, SN = Object.fromEntries(C.sectorsOf(cache.deps).map(d => [d.id, d.name]));
    r.rows.forEach(x => { x.name = (cfg.managers[x.uid] || {}).name || (cache.userMap[x.uid] || {}).name || ('ID ' + x.uid); x.sector = SN[secOf[x.uid]] || ''; });
    r.rows.sort((a, b) => a.sector.localeCompare(b.sector, 'ru') || a.name.localeCompare(b.name, 'ru'));
    r.settings = att.setup(cfg).settings; delete r.settings.map;
    return send(res, 200, r);
  }
  if (p === '/api/admin/att/setup') {
    const proto = req.headers['x-forwarded-proto'] || 'http', host = req.headers.host;
    return send(res, 200, { ...att.setup(cfg), url: `${proto}://${host}/api/att/${att.token()}` });
  }
  if (p === '/api/admin/att/token' && req.method === 'POST') { await att.newToken(); return send(res, 200, { ok: true }); }
  if (p === '/api/admin/att/dismiss' && req.method === 'POST') {
    const { id, on } = JSON.parse(await readBody(req, 1e4));
    if (!/^att-\w+-\d{4}-\d{2}-\d{2}$/.test(id || '')) return send(res, 400, { error: 'bad id' });
    await att.dismiss(id, !!on); return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/att/bridge.js') {
    const proto = req.headers['x-forwarded-proto'] || 'http', host = req.headers.host;
    const src = fs.readFileSync(path.join(__dirname, 'tools', 'hik-bridge.js'), 'utf8').replace("process.env.SAFA_URL || ''", `process.env.SAFA_URL || '${proto}://${host}/api/att/${att.token()}'`);
    return send(res, 200, src, 'application/javascript; charset=utf-8', { 'Content-Disposition': 'attachment; filename="hik-bridge.js"' });
  }
  if (p === '/api/admin/resync' && req.method === 'POST') {
    cache.meta = null; await sync(); return send(res, 200, { ok: !cache.error, error: cache.error, syncedAt: cache.syncedAt });
  }
  if ((m = p.match(/^\/api\/admin\/board\/(\w+)\/test-sale$/)) && req.method === 'POST') {
    const b = cfg.boards.find(x => x.id === m[1]); if (!b) return send(res, 404, { error: 'not found' });
    const data = C.computeBoard(b, ctx()); const r = data.rows[0];
    events.push({ seq: ++seq, at: Date.now(), test: true, id: 'test', uid: r ? r.uid : '0', name: r ? r.name : 'Тестовый менеджер', sum: 150000, title: 'Тестовая продажа', dk: data.period.today });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/payouts') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : today.slice(0, 7);
    const mr = C.monthRange(month + '-01');
    const deals = await dealsFor(mr.from, mr.to);
    const r = C.payouts(cfg, ctx(deals), { month, boardId: q.get('board') || '' });
    if (!r) return send(res, 404, { error: 'not found' });
    { const A = AN.allowedUids(ctx(), scope, { sector: q.get('sector') || '' }); r.rows = r.rows.filter(x => A.has(x.uid)); }
    if (q.get('format') === 'csv') {
      const hd = ['Менеджер', 'Касса', '% сетки', 'Процент', 'Премия уровня', 'Бонусы', 'Штрафы', 'Итого',
        ...r.weeks.map(w => `Выплата ${w.from.slice(8)}.${w.from.slice(5, 7)}–${w.to.slice(8)}.${w.to.slice(5, 7)}`)];
      const body = csv([hd, ...r.rows.map(x => [x.name, Math.round(x.sum), x.commPct, Math.round(x.comm), x.premium, x.bonus, x.pen, Math.round(x.salary), ...x.weeks.map(w => Math.round(w.pay))])]);
      return send(res, 200, body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="safa_payouts_${month}.csv"` });
    }
    return send(res, 200, r);
  }
  /* ===== аналитика по базе ===== */
  if (p === '/api/admin/funnel' || p === '/api/admin/calls' || p === '/api/admin/sources') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const f = { from: q.get('from') || C.monthRange(today).from, to: q.get('to') || today, sector: q.get('sector') || '', uid: q.get('uid') || '', stageNames: stageNames() };
    const fn = { '/api/admin/funnel': AN.funnel, '/api/admin/calls': AN.calls, '/api/admin/sources': AN.sources }[p];
    return send(res, 200, { ...(p === '/api/admin/sources' ? { rows: fn(ctx(), scope, f) } : fn(ctx(), scope, f)), wh: wh.status() });
  }
  // записи разговоров: список и прослушивание (файл берётся из Bitrix24 через вебхук и отдаётся потоком)
  if (p === '/api/admin/calls/list') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const f = { from: q.get('from') || today, to: q.get('to') || today, sector: q.get('sector') || '', uid: q.get('uid') || '' };
    const out = AN.callList(ctx(), scope, f, { q: q.get('q') || '', rec: q.get('all') !== '1', limit: q.get('limit') });
    out.rows.forEach(r => { const x = cai.get(r.id); if (x) r.ai = x.skip ? { skip: true } : { score: x.score, outcome: x.outcome }; });
    out.callai = { on: cai.status().settings.on, ready: cai.status().ready };
    return send(res, 200, out);
  }
  // эффективность менеджеров и касания
  if (p === '/api/admin/eff' || p === '/api/admin/touches') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const f = { from: q.get('from') || C.monthRange(today).from, to: q.get('to') || today, sector: q.get('sector') || '', uid: q.get('uid') || '', stageNames: stageNames() };
    return send(res, 200, p === '/api/admin/eff' ? EF.efficiency(ctx(), scope, f, cfg) : EF.touches(ctx(), scope, f, cfg));
  }
  if ((m = p.match(/^\/api\/admin\/eff\/card\/(\w+)$/))) {
    const c = ctx();
    if (!AN.allowedUids(c, scope, {}).has(m[1])) return send(res, 403, { error: 'Нет доступа' });
    return send(res, 200, EF.card(c, scope, m[1], cfg));
  }
  // AI-разбор звонков
  if (p === '/api/admin/callai/summary') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz), c = ctx();
    const A = AN.allowedUids(c, scope, { sector: q.get('sector') || '', uid: q.get('uid') || '' });
    const nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || ('ID ' + id);
    return send(res, 200, { ...cai.summary(id => A.has(id), q.get('from') || C.monthRange(today).from, q.get('to') || today, nm), status: (({ settings, ready, doneToday, total }) => ({ on: settings.on, ready, doneToday, total }))(cai.status()) });
  }
  if (p === '/api/admin/callai/settings') {
    if (req.method === 'POST') { await cai.setKeys(JSON.parse(await readBody(req, 1e4))); }
    return send(res, 200, cai.status());
  }
  if ((m = p.match(/^\/api\/admin\/callai\/([\w.-]+)$/))) {
    const c = wh.byId('call', m[1]);
    if (!c) return send(res, 404, { error: 'Звонок не найден в базе' });
    if (!AN.allowedUids(ctx(), scope, {}).has(c.uid)) return send(res, 403, { error: 'Нет доступа к этому звонку' });
    try {
      const d = req.method === 'POST' ? await cai.analyze(c.id) : cai.get(c.id);
      if (!d) return send(res, 404, { error: 'Разбора ещё нет' });
      const x = ctx(); const nm = (cfg.managers[c.uid] || {}).name || (x.userMap[c.uid] || {}).name || '';
      return send(res, 200, { ...d, name: nm, phone: c.ph, transcript: await cai.transcript(c.id) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/admin/calls/raw') { // диагностика: какие поля записи отдаёт Bitrix24
    if (!isOwner) return send(res, 403, { error: 'Доступно только владельцу' });
    const r = await bx.call('voximplant.statistic.get', { FILTER: { '>CALL_DURATION': 0 }, SORT: 'CALL_START_DATE', ORDER: 'DESC' });
    const rows = (r.result || []).slice(0, 5).map(c => ({ CALL_ID: c.CALL_ID, CALL_START_DATE: c.CALL_START_DATE, CALL_DURATION: c.CALL_DURATION, RECORD_FILE_ID: c.RECORD_FILE_ID, CALL_RECORD_URL: c.CALL_RECORD_URL ? String(c.CALL_RECORD_URL).replace(/(auth|token)=[^&]+/g, '$1=…') : c.CALL_RECORD_URL, keys: Object.keys(c) }));
    let disk = null; const withFile = (r.result || []).find(c => c.RECORD_FILE_ID);
    if (withFile) disk = await bx.call('disk.file.get', { id: withFile.RECORD_FILE_ID }).then(x => ({ ok: true, name: x.result.NAME, size: x.result.SIZE, hasUrl: !!x.result.DOWNLOAD_URL })).catch(e => ({ ok: false, error: e.message }));
    const all = wh.all('call');
    return send(res, 200, { total: all.length, withRecord: all.filter(c => c.rec).length, sample: rows, disk });
  }
  if ((m = p.match(/^\/api\/admin\/call-rec\/([\w.-]+)$/))) {
    const c = wh.byId('call', m[1]);
    if (!c) return send(res, 404, { error: 'Звонок не найден в базе' });
    if (!AN.allowedUids(ctx(), scope, {}).has(c.uid)) return send(res, 403, { error: 'Нет доступа к этому звонку' });
    try {
      const r = await bx.call('voximplant.statistic.get', { FILTER: { CALL_ID: c.id } });
      const raw = (r.result || [])[0] || {};
      const urls = []; let why = '';
      if (raw.RECORD_FILE_ID) {
        try { const fl = await bx.call('disk.file.get', { id: raw.RECORD_FILE_ID }); if (fl.result && fl.result.DOWNLOAD_URL) urls.push(fl.result.DOWNLOAD_URL); }
        catch (e) { why = /insufficient|scope|access/i.test(e.message) ? 'У вебхука Bitrix24 нет права «Диск» (disk) — добавьте его в настройках вебхука' : e.message; }
      }
      if (raw.CALL_RECORD_URL) urls.push(raw.CALL_RECORD_URL);
      if (!urls.length) return send(res, 404, { error: why || 'У звонка нет записи' });
      for (const u of urls) {
        const up = await fetch(u, { headers: req.headers.range ? { Range: req.headers.range } : {}, redirect: 'follow' });
        const type = up.headers.get('content-type') || '';
        if (!up.ok || /json|html/.test(type)) { why = why || `Bitrix24 не отдал файл (HTTP ${up.status})`; continue; }
        const h = { 'Content-Type': /octet-stream/.test(type) || !type ? 'audio/mpeg' : type, 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': up.headers.get('accept-ranges') || 'bytes' };
        for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) h[k] = up.headers.get(k);
        if (url.searchParams.has('dl')) h['Content-Disposition'] = `attachment; filename="call_${c.id.replace(/[^\w.-]/g, '')}.mp3"`;
        res.writeHead(up.status, h);
        return require('stream').Readable.fromWeb(up.body).pipe(res);
      }
      return send(res, 502, { error: why || 'Не удалось получить запись' });
    } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === '/api/admin/users' && req.method === 'POST') {
    try { return send(res, 200, { ok: true, user: await auth.saveUser(JSON.parse(await readBody(req, 1e5))) }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if ((m = p.match(/^\/api\/admin\/users\/(\w+)$/)) && req.method === 'DELETE') { await auth.deleteUser(m[1]); return send(res, 200, { ok: true }); }
  if (p === '/api/admin/wh/sync' && req.method === 'POST') { await wh.sync(); return send(res, 200, wh.status()); }
  if (p === '/api/admin/wh/rebuild' && req.method === 'POST') { wh.resetAndResync(); return send(res, 200, { ok: true }); }
  if (p === '/api/ai/chat' && req.method === 'POST') {
    const ai = require('./lib/ai');
    const body = JSON.parse(await readBody(req, 2e5));
    try { return send(res, 200, await ai.chat({ messages: body.messages || [], user, scope, cfg, ctx, stageNames: stageNames(), report: (f) => reportFor(f, scope) })); }
    catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }
  if (p === '/api/admin/report') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const from = q.get('from') || C.monthRange(today).from, to = q.get('to') || today;
    const A = AN.allowedUids(ctx(), scope, { sector: q.get('sector') || '' });
    const deals = (await dealsFor(from, to)).filter(d => A.has(d.uid));
    const r = C.report(cfg, ctx(deals), { from, to, boardId: q.get('board') || '', uid: q.get('uid') || '' });
    if (!r) return send(res, 404, { error: 'not found' });
    if (q.get('format') === 'csv') {
      const name = `safa_${q.get('kind') === 'deals' ? 'sales' : 'report'}_${from}_${to}.csv`;
      const body = q.get('kind') === 'deals'
        ? csv([['ID сделки', 'Дата', 'Менеджер', 'Сделка', 'Сумма'], ...r.deals.map(d => [d.id, d.dk, d.name, d.title, Math.round(d.sum)])])
        : csv([['Менеджер', 'Отдел', 'Продаж', 'Выручка', 'Ср. чек', '% сетки', 'Процент', 'Премия уровня', 'Бонусы', 'Штрафы', 'Зарплата'],
          ...r.rows.map(x => [x.name, x.dep, x.cnt, Math.round(x.sum), Math.round(x.avg), x.commPct, Math.round(x.comm), x.premium, Math.round(x.bonus), x.pen, Math.round(x.salary)]),
          ['Итого', '', r.totals.cnt, Math.round(r.totals.sum), Math.round(r.totals.avg), '', Math.round(r.totals.comm), r.totals.premium, Math.round(r.totals.bonus), r.totals.pen, Math.round(r.totals.salary)]]);
      return send(res, 200, body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
    }
    return send(res, 200, r);
  }
  send(res, 404, 'Not found', 'text/plain');
}

(async () => {
  await store.init();
  cfg = C.normalize(store.get('config'));
  // v1: условия отдела продаж (сетка, элит, ежедневная премия, график 6/1 с выходным в понедельник)
  if (cfg.presetV !== 1) {
    for (const b of cfg.boards) {
      if ((b.commission || []).length || (b.bonuses || []).length) continue;
      Object.assign(b, JSON.parse(JSON.stringify(C.SALES_PRESET)));
    }
    if (JSON.stringify(cfg.settings.workDays) === JSON.stringify([1, 2, 3, 4, 5, 6])) cfg.settings.workDays = [2, 3, 4, 5, 6, 7];
    cfg.presetV = 1;
  }
  // v2: один лидерборд (топ-10), планы по секторам. Убираем автоматически созданные доски секторов.
  if (!cfg.oneBoardV2) {
    const auto = new Set(cfg.sectorBoards || []);
    const keep = cfg.boards.filter(b => !((b.departments || []).length === 1 && auto.has(String(b.departments[0]))));
    if (keep.length) cfg.boards = keep;
    cfg.oneBoardV2 = true;
  }
  // v3: бренд Safa вместо Nephora (название доски и подпись компании)
  if (!cfg.brandV3) {
    for (const b of cfg.boards) if (/nephora/i.test(b.name || '')) b.name = (b.name.replace(/nephora\s*arena/i, 'Safa').replace(/nephora/ig, 'Safa').trim() || 'Safa');
    if (/nephora/i.test(cfg.settings.company || '')) cfg.settings.company = cfg.settings.company.replace(/nephora/ig, 'Safa');
    cfg.brandV3 = true;
  }
  await store.set('config', cfg);
  http.createServer((req, res) => handle(req, res).catch(e => {
    console.error(e); if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  })).listen(PORT, () => console.log('Leaderboard on :' + PORT));
  sync().then(async () => { loop(); if (!cache.meta && bx.configured()) cache.meta = await bx.meta().catch(() => null); });
  wh.start(cfg); cai.start(cfg);
})();
