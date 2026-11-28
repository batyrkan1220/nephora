// Safa портал — сервер.
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
const recs = require('./lib/recs');
setTimeout(() => setInterval(() => { try { const t = C.todayKey(cfg.settings.tz); recs.archive(wh.all('call'), t, C.addDays(t, -1)).catch(e => console.error('rec archive', e.message)); } catch {} }, 2 * 6e4), 60e3);
const ACT = require('./lib/activity');
const EF = require('./lib/efficiency');
const wz = require('./lib/wazzup');
const bots = require('./lib/bots');
const BUILD = String(Date.now()); // версия сервера: открытые табло перезагружаются сами после деплоя

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
      const sig = deals.length + ':' + deals.reduce((a, d) => a + (+d.sum || 0) + (+d.id || 0), 0) + ':' + users.map(u => u.id + u.name + u.photo + u.deps.join(',')).join('|').length + ':' + users.length + ':' + deps.map(d => d.id + d.name + d.parent).join('|');
      const changed = sig !== cache.sig;
      Object.assign(cache, { deals, users, userMap, deps, range: { from, to }, syncedAt: Date.now(), error: '', sig });
      saveSnap();
      if (changed) livePush('data');
    } catch (e) {
      cache.error = String(e.message || e);
      console.error('sync:', cache.error);
    } finally { syncing = null; }
  })();
  return syncing;
}
// снимок живого кэша в базе: после перезапуска страницы открываются сразу из базы, Bitrix догружается в фоне
let snapAt = 0, snapSig = '';
function saveSnap(force) {
  const sig = cache.deals.length + ':' + cache.deals.reduce((a, d) => a + (+d.sum || 0), 0) + ':' + cache.users.length + ':' + !!cache.meta + ':' + (cache.range || {}).from;
  if (!force && sig === snapSig && Date.now() - snapAt < 10 * 60e3) return;
  snapSig = sig; snapAt = Date.now();
  store.set('cache:snap', { v: 1, deals: cache.deals, users: cache.users, deps: cache.deps, meta: cache.meta || null, range: cache.range, syncedAt: cache.syncedAt })
    .catch(e => console.error('snap:', e.message));
}
function loadSnap() {
  const x = store.get('cache:snap');
  if (!x || x.v !== 1 || !Array.isArray(x.deals)) return false;
  const userMap = Object.fromEntries((x.users || []).map(u => [u.id, u]));
  Object.assign(cache, { deals: x.deals, users: x.users || [], userMap, deps: x.deps || [], meta: x.meta || null, range: x.range, syncedAt: x.syncedAt, error: '' });
  seen = new Set(x.deals.map(d => d.id));
  console.log('cache: снимок из базы —', x.deals.length, 'сделок от', new Date(x.syncedAt).toISOString());
  return true;
}
// прогрев: после загрузки/обновления базы заранее считаем тяжёлые отчёты главной (эффективность, касания) для владельца
let warmLast = -1;
/* профили менеджеров: собираются в фоне каждые 10 минут и хранятся в базе (Supabase) — открываются мгновенно */
const PROF = new Map(); let profBusy = false, profLoaded = false;
async function buildProfiles() {
  if (profBusy || !cache.syncedAt) return; profBusy = true;
  try {
    if (!profLoaded) { profLoaded = true; Object.entries(store.get('profiles') || {}).forEach(([k, v]) => PROF.set(k, v)); }
    const c = ctx(), secOf = C.sectorMap(c), sc = { role: 'owner', sectors: null }, P = require('./lib/profile');
    for (const u of c.users) {
      if (u.active === false || !secOf[u.id]) continue;
      try { PROF.set(u.id, { ...P.profile(c, sc, u.id, cfg, bx.portal()), at: Date.now() }); } catch (e) { console.error('profile', u.id, e.message); }
      await new Promise(r => setImmediate(r)); // не блокируем сервер
    }
    await store.set('profiles', Object.fromEntries(PROF));
  } finally { profBusy = false; }
}
// фоновые профили отключены (профиль менеджера убран)
function warm() {
  setTimeout(warm, 20e3);
  const st = wh.status(); if (!st.counts.deal || st.lastRun === warmLast || !cache.syncedAt) return;
  warmLast = st.lastRun;
  try {
    const b = cfg.boards[0]; if (!b) return;
    const c = ctx(), P = C.computeBoard(b, c).period, sc = { role: 'owner', sectors: null };
    const f = { from: P.from, to: P.today, stageNames: stageNames() };
    EF.touches(c, sc, f, cfg); EF.efficiency(c, sc, f, cfg);
  } catch (e) { console.error('warm:', e.message); }
}


// аккаунт «Админ» в Bitrix24 — по почте (batyr7752@gmail.com), запасной вариант — по имени
const ADMIN_EMAIL = (process.env.ADMIN_BX_EMAIL || 'batyr7752@gmail.com').toLowerCase();
const adminUser = c => c.users.find(u => u.email === ADMIN_EMAIL) || c.users.find(u => /^\s*админ\s*$|^\s*admin\s*$/i.test(u.name)) || null;
// «С Админа»: сколько сделок/лидов было на аккаунте «Админ» и кому они переданы
function fromAdmin(q, scope) {
  const c = ctx(), today = C.todayKey(cfg.settings.tz), M = C.monthRange(today);
  const from = q.get('from') || M.from, to = q.get('to') || today;
  const admin = adminUser(c); if (!admin) return { error: `Аккаунт ${ADMIN_EMAIL} не найден в Bitrix24` };
  const A = admin.id, allowed = AN.allowedUids(c, scope, {}), base = bx.portal();
  const nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || ('#' + id);
  const mask = t => String(t || '').replace(/(\d{4})\d{4}(\d{2})/g, '$1****$2');
  const dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.settings.tz }), day = v => { const t = new Date(v); return isNaN(t) ? '' : dfmt.format(t); };
  const meta = Object.fromEntries(((cache.meta || {}).stages || []).map(x => [x.id, x])), stName = id => meta[id] ? meta[id].category + ' → ' + meta[id].name : id;
  // журнал передач (точное время, ведётся платформой)
  const log = wh.transfers().filter(x => x.from === A && x.to !== A && day(x.at) >= from && day(x.at) <= to);
  const logDeal = new Map(); log.forEach(x => { if (x.e === 'deal') logDeal.set(x.id, x); });
  // сделки, созданные на Админе за период (создатель — Админ): где они сейчас
  // «Новая сделка»: всё, что создаётся на Админе, попадает в «Общая → Новая»; проданные потом уходят в логистику — их тоже считаем
  const NEW = 'NEW';
  const deals = wh.all('deal').filter(d => d.crd >= from && d.crd <= to && (d.cb === A || logDeal.has(d.id)));
  const by = {}, days = {};
  let onAdmin = 0, given = 0;
  for (const d of deals) {
    const dk = d.crd, D = days[dk] || (days[dk] = { day: dk, total: 0, given: 0, onAdmin: 0 }); D.total++;
    if (d.uid === A) { onAdmin++; D.onAdmin++; continue; }
    given++; D.given++;
    if (!allowed.has(d.uid)) continue;
    const r = by[d.uid] || (by[d.uid] = { uid: d.uid, name: nm(d.uid), cnt: 0, won: 0, lost: 0, work: 0, wonSum: 0 });
    r.cnt++; if (d.sem === 'S') { r.won++; r.wonSum += d.sum || 0; } else if (d.sem === 'F') r.lost++; else r.work++;
  }
  const leads = wh.all('lead').filter(l => l.crd >= from && l.crd <= to && l.cb === A);
  // сейчас на Админе как на ответственном — независимо от даты (всё, что висит на нём)
  const nowDeals = wh.all('deal').filter(d => d.uid === A), nowLeads = wh.all('lead').filter(l => l.uid === A);
  const cur = { newNow: nowDeals.filter(d => d.st === NEW).length, deals: nowDeals.length, dealsOpen: nowDeals.filter(d => d.sem === 'P').length, dealsWon: nowDeals.filter(d => d.sem === 'S').length, dealsLost: nowDeals.filter(d => d.sem === 'F').length,
    leads: nowLeads.length, leadsOpen: nowLeads.filter(l => l.sem === 'P').length,
    byStage: Object.entries(nowDeals.filter(d => d.sem === 'P').reduce((m, d) => { const k = stName(d.st); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, z) => z[1] - a[1]).slice(0, 12) };
  const curLeads = nowLeads.filter(l => l.sem === 'P').sort((a, z) => String(z.cr).localeCompare(String(a.cr))).slice(0, 200)
    .map(l => ({ id: l.id, t: mask(l.t), cr: l.cr, url: base ? `${base}/crm/lead/details/${l.id}/` : '' }));
  const curOpen = nowDeals.filter(d => d.sem === 'P').sort((a, z) => String(z.cr).localeCompare(String(a.cr))).slice(0, 300)
    .map(d => ({ id: d.id, t: mask(d.t), cr: d.cr, stage: stName(d.st), url: base ? `${base}/crm/deal/details/${d.id}/` : '' }));
  const stillOpen = deals.filter(d => d.uid === A && d.sem === 'P').sort((a, z) => String(z.cr).localeCompare(String(a.cr))).slice(0, 200)
    .map(d => ({ id: d.id, t: mask(d.t), cr: d.cr, stage: stName(d.st), url: base ? `${base}/crm/deal/details/${d.id}/` : '' }));
  return {
    from, to, admin: admin.name, adminId: admin.id, adminEmail: ADMIN_EMAIL,
    total: { created: deals.length, given, onAdmin, leads: leads.length, leadsGiven: leads.filter(l => l.uid !== A).length, logged: log.length },
    managers: Object.values(by).sort((a, z) => z.cnt - a.cnt),
    days: Object.values(days).sort((a, z) => z.day.localeCompare(a.day)),
    log: log.slice(-300).reverse().filter(x => allowed.has(x.to)).map(x => ({ e: x.e, id: x.id, to: nm(x.to), at: x.at, t: mask(x.t), url: base ? `${base}/crm/${x.e}/details/${x.id}/` : '' })),
    stillOpen, cur, curOpen, curLeads,
  };
}
function waLeads(q, scope, isOwner) {
    const today = C.todayKey(cfg.settings.tz), c = ctx(), tz = cfg.settings.tz;
    const from = q.get('from') || C.monthRange(today).from, to = q.get('to') || today;
    const A = AN.allowedUids(c, scope, { sector: q.get('sector') || '', uid: q.get('uid') || '' });
    const meta = Object.fromEntries(((cache.meta || {}).stages || []).map(x => [x.id, x]));
    const kassa = new Set(cfg.settings.stages || []), nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || '';
    const secOf = C.sectorMap(c), secName = Object.fromEntries((c.deps || []).map(d => [d.id, d.name]));
    // сделки по номеру телефона (из названия «Сделка по обращению в WhatsApp (7705…)»)
    const byPhone = dealsByPhone();
    const base = bx.portal(), H = 3600e3;
    // «Админ» — аккаунт, на который должны падать новые обращения (по имени в Bitrix24)
    const admin = adminUser(c), adminId = admin ? admin.id : '';
    const wasWorked = (L, ds) => ds.some(d => {
      const cr = +new Date(d.cr), mv = +new Date(d.mv || d.md || d.cr), md = +new Date(d.md || d.cr);
      return cr >= L.at - H                                            // создана новая сделка
        || (d.st === 'NEW' && mv >= L.at - H)                          // старую вернули в «Новая сделка»
        || (adminId && d.uid === adminId && d.sem === 'P' && md >= L.at - H) // передана на Админа
        || (adminId && d.uid === adminId && d.st === 'NEW');           // уже лежит в очереди у Админа
    });
    const rows = wz.leads(from, to, tz).map(L => {
      const ds = byPhone[L.phone] || [];
      const earlier = ds.filter(d => +new Date(d.cr) < L.at - H);                         // сделки до обращения → клиент уже был в CRM
      const deal = ds.find(d => +new Date(d.cr) >= L.at - H && +new Date(d.cr) <= L.at + 3 * 24 * H) || ds[ds.length - 1] || null;
      const repeat = !!L.waBefore || earlier.length > 0;
      const st = deal ? meta[deal.st] || {} : {};
      const sold = ds.filter(d => +new Date(d.cr) >= L.at - H && (kassa.has(d.st) || d.sem === 'S'));
      // потерян: не попал в «Новая сделка»/на Админа И никто не ответил в WhatsApp (ответили — значит, с клиентом работают)
      const lost = Date.now() - L.at > 15 * 6e4 && L.ansMin == null && !wasWorked(L, ds);
      const last = ds[ds.length - 1] || null, lst = last ? meta[last.st] || {} : {};
      const lostWhy = !lost ? '' : !ds.length ? 'в CRM нет сделки по этому номеру' :
        `сообщение ушло в старую сделку #${last.id} («${lst.category ? lst.category + ' → ' : ''}${lst.name || last.st}»${last.sem === 'F' ? ', закрыта отказом' : last.sem === 'S' ? ', успешно закрыта' : ''}) у ${nm(last.uid) || 'без ответственного'} — в «Новая сделка» на ${admin ? admin.name : 'Админа'} не попало`;
      return { ...L, repeat, lost, lostWhy, lastDeal: last ? { id: last.id, url: base ? `${base}/crm/deal/details/${last.id}/` : '', uid: last.uid, manager: nm(last.uid), stage: (lst.category ? lst.category + ' → ' : '') + (lst.name || last.st) } : null, why: L.waBefore ? 'писал(а) ' + new Date(L.waBefore).toISOString().slice(0, 10) : earlier.length ? 'есть в CRM с ' + earlier[0].cr.slice(0, 10) + ` (${earlier.length} сд.)` : '',
        crmBefore: earlier.length, deal: deal ? { id: deal.id, url: base ? `${base}/crm/deal/details/${deal.id}/` : '', stage: st.name || deal.st, cat: st.category || '', sum: deal.sum,
          uid: deal.uid, manager: nm(deal.uid), sector: secName[secOf[deal.uid]] || '', cr: deal.cr, won: kassa.has(deal.st) || deal.sem === 'S', lost: deal.sem === 'F' } : null,
        soldSum: sold.reduce((a, d) => a + d.sum, 0), sold: sold.length > 0 };
    }).filter(r => !r.deal || !r.deal.uid || A.has(r.deal.uid) || isOwner);
    const agg = list => ({ lost: list.filter(r => r.lost).length, leads: list.length, firstChat: list.filter(r => !r.waBefore).length, new: list.filter(r => !r.repeat).length, repeat: list.filter(r => r.repeat).length, deals: list.filter(r => r.deal).length,
      sold: list.filter(r => r.sold).length, soldSum: list.reduce((a, r) => a + r.soldSum, 0), noAnswer: list.filter(r => r.ansMin == null).length,
      ansMed: (a => a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null)(list.filter(r => r.ansMin != null).map(r => r.ansMin)) });
    const group = key => Object.entries(rows.reduce((m, r) => { (m[key(r)] = m[key(r)] || []).push(r); return m; }, {}));
    const days = group(r => r.day).map(([d, l]) => ({ day: d, ...agg(l), byCh: l.reduce((m, r) => { m[r.chName] = (m[r.chName] || 0) + 1; return m; }, {}) })).sort((a, b) => a.day.localeCompare(b.day));
    const channels = group(r => r.chName).map(([n, l]) => ({ name: n, ...agg(l) })).sort((a, b) => b.leads - a.leads);
    const managers = group(r => r.deal && r.deal.manager || '— без сделки').map(([n, l]) => ({ name: n, uid: (l.find(r => r.deal) || { deal: {} }).deal.uid || '', ...agg(l) })).sort((a, b) => b.leads - a.leads);
    const hf = wz.historyFrom();
    return { admin: admin ? admin.name : '', from, to, connected: wz.status().connected, historyFrom: hf ? new Date(hf).toISOString().slice(0, 10) : null, total: agg(rows), days, channels, managers, rows: rows.slice(0, 2000) };
}
/* ===== телефон → сделки клиента: по номеру в названии сделки и по телефонам контакта ===== */
let dbpAt = 0, dbp = null;
function dealsByPhone() {
  const st = wh.status(); if (dbp && dbpAt === st.lastRun) return dbp;
  const byContact = {}, out = {}, add = (ph, d) => { const a = out[ph] = out[ph] || []; if (!a.includes(d)) a.push(d); };
  wh.all('deal').forEach(d => { if (d.contact) (byContact[d.contact] = byContact[d.contact] || []).push(d); const ph = wz.phoneOf(d.t); if (ph) add(ph, d); });
  wh.all('contact').forEach(c => (c.ph || []).forEach(p => (byContact[c.id] || []).forEach(d => add('7' + p, d))));
  Object.values(out).forEach(a => a.sort((x, y) => +new Date(x.cr) - +new Date(y.cr)));
  dbp = out; dbpAt = st.lastRun; return out;
}

/* ===== дубли сделок ===== */
let dupeJob = null;
function dupeCtx() {
  const nm = Object.fromEntries(((cache.meta || {}).stages || []).map(x => [x.id, x]));
  return { nm, label: id => nm[id] ? nm[id].category + ' → ' + nm[id].name : id };
}
function dupePairs(stage, target) {
  const { nm, label } = dupeCtx(), D = wh.all('deal'), tgtRe = new RegExp(target, 'i');
  const T = D.filter(d => tgtRe.test((nm[d.st] || {}).category || '')), src = D.filter(d => d.st === stage);
  const ph = d => wz.phoneOf(d.t), idx = {}, add = (k, d) => { if (k) (idx[k] = idx[k] || []).push(d); };
  T.forEach(d => { add('c' + d.contact, d); add('p' + ph(d), d); add('l' + d.lead, d); });
  const cands = d => [...new Map([...(d.contact ? idx['c' + d.contact] || [] : []), ...(ph(d) ? idx['p' + ph(d)] || [] : []), ...(d.lead ? idx['l' + d.lead] || [] : [])].map(x => [x.id, x])).values()];
  const used = new Set(), paired = new Map();
  // проходы от самых надёжных пар к менее надёжным: сумма+дата → сумма → любая
  const passes = [['sum+date', (a, b) => a.sum === b.sum && a.od && a.od === b.od], ['sum', (a, b) => a.sum === b.sum], ['client', () => true]];
  for (const [how, ok] of passes) for (const d of src) {
    if (paired.has(d.id)) continue;
    const c = cands(d).filter(x => !used.has(x.id) && ok(d, x)).sort((x, y) => Math.abs(+new Date(x.cr) - +new Date(d.cr)) - Math.abs(+new Date(y.cr) - +new Date(d.cr)))[0];
    if (c) { used.add(c.id); paired.set(d.id, { src: d, tgt: c, how }); }
  }
  const pairs = [...paired.values()], unmatched = src.filter(d => !paired.has(d.id));
  const byHow = {}; pairs.forEach(x => { byHow[x.how] = (byHow[x.how] || 0) + 1; });
  const months = {}; src.forEach(d => { const k = (d.od || d.cr || '').slice(0, 7), M = months[k] = months[k] || { n: 0, sum: 0, dup: 0, dupSum: 0 }; M.n++; M.sum += d.sum; if (paired.has(d.id)) { M.dup++; M.dupSum += d.sum; } });
  return { pairs, unmatched, label, summary: { stage: label(stage), total: src.length, sum: src.reduce((a, d) => a + d.sum, 0), dupes: pairs.length,
    dupSum: pairs.reduce((a, x) => a + x.src.sum, 0), byHow, unmatchedN: unmatched.length, unmatchedSum: unmatched.reduce((a, d) => a + d.sum, 0), months } };
}
// удаление: перед каждым пакетом сделки перечитываются из Bitrix — удаляются только те, что всё ещё в той же стадии
async function runDupeDelete(pairs, stage) {
  for (let i = 0; i < pairs.length; i += 25) {
    const chunk = pairs.slice(i, i + 25), ids = chunk.map(x => x.src.id), pids = chunk.map(x => x.tgt.id);
    const fresh = await bx.call('crm.deal.list', { filter: { '@ID': [...ids, ...pids] }, select: ['ID', 'STAGE_ID'] });
    const stOf = Object.fromEntries((fresh.result || []).map(d => [String(d.ID), d.STAGE_ID]));
    const go = chunk.filter(x => stOf[x.src.id] === stage && stOf[x.tgt.id]);
    chunk.filter(x => !go.includes(x)).forEach(x => dupeJob.skipped.push({ id: x.src.id, why: stOf[x.src.id] !== stage ? 'стадия изменилась' : 'пара в логистике не найдена' }));
    if (go.length) {
      const r = await bx.call('batch', { halt: 0, cmd: Object.fromEntries(go.map(x => ['d' + x.src.id, 'crm.deal.delete?id=' + x.src.id])) });
      const errs = (r.result || {}).result_error || {}, ok = [];
      for (const x of go) { const e = errs['d' + x.src.id]; if (e && (!Array.isArray(e) || e.length)) dupeJob.errors.push(x.src.id + ': ' + (e.error_description || e.error || JSON.stringify(e))); else ok.push(x.src.id); }
      await wh.remove('deal', ok); dupeJob.deleted += ok.length;
    }
    dupeJob.done += chunk.length;
    await new Promise(z => setTimeout(z, 600));
  }
  cache.deals = cache.deals.filter(d => wh.byId('deal', d.id) || !pairs.some(x => x.src.id === d.id));
  sync();
}
/* ===== live-обновление: сервер сам сообщает табло и кабинету, что данные изменились (Server-Sent Events) ===== */
const liveClients = new Set();
function livePush(kind) {
  const msg = `event: ${kind}\ndata: ${Date.now()}\n\n`;
  for (const r of liveClients) { try { r.write(msg); } catch { liveClients.delete(r); } }
}
function liveOpen(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n'); liveClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20e3);
  req.on('close', () => { clearInterval(ping); liveClients.delete(res); });
}
// входящее событие Bitrix24 (исходящий вебхук: сделка добавлена/изменена/удалена, звонок завершён) → синхронизация сразу
const bxHookToken = () => { let t = store.get('bx:hook'); if (!t) { t = crypto.randomBytes(16).toString('hex'); store.set('bx:hook', t); } return t; };
let kickT = null, kickRun = false;
function kick(why) {
  clearTimeout(kickT);
  kickT = setTimeout(async () => {
    if (kickRun) return kick(why); kickRun = true;
    try { await sync(); loop(); wh.sync && wh.sync().catch(() => {}); } finally { kickRun = false; }
  }, 1500);
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
    salesOwners: salesOwners(),
  };
}
// кто ведёт сделки в воронке продаж («Общая», стадии без префикса C…) за последние 30 дней — для автодобавления новых секторов
let soAt = 0, soSet = null;
function salesOwners() {
  if (soSet && Date.now() - soAt < 5 * 60e3) return soSet;
  const t0 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), set = new Set();
  wh.all('deal').forEach(d => { if (d.uid && d.cat === '0' && (d.cr || '') >= t0) set.add(String(d.uid)); });
  (cache.deals || []).forEach(d => { if (d.uid && !/^C\d+:/.test(d.stage || '')) set.add(String(d.uid)); });
  soAt = Date.now(); soSet = set; return set;
}
// воронки сейчас: открытые сделки по воронкам и стадиям (логистика — сколько заказов «в пути» и на какую сумму)
function pipesOf(c, A) {
  const st = Object.fromEntries(((cache.meta || {}).stages || []).map((x, i) => [x.id, { ...x, i }]));
  const P = {};
  for (const d of wh.all('deal')) {
    if (d.sem !== 'P' || !A.has(d.uid)) continue;
    const m = st[d.st] || { name: d.st, category: 'Воронка ' + d.cat, i: 999 }, k = m.category;
    const p = P[k] || (P[k] = { name: k, cnt: 0, sum: 0, stages: {} }); p.cnt++; p.sum += d.sum || 0;
    const s2 = p.stages[m.name] || (p.stages[m.name] = { name: m.name, cnt: 0, sum: 0, i: m.i }); s2.cnt++; s2.sum += d.sum || 0;
  }
  return Object.values(P).map(p => ({ ...p, logi: /логист/i.test(p.name), stages: Object.values(p.stages).sort((a, z) => a.i - z.i) })).sort((a, z) => z.logi - a.logi || z.sum - a.sum);
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


/* ===== уменьшенные фото менеджеров ===== */
let sharp = null; try { sharp = require('sharp'); } catch (e) { console.warn('sharp не установлен — фото отдаются как есть'); }
const IMG = new Map(), IMGQ = new Map();
async function imgProxy(u, res) {
  let host = ''; try { host = new URL(u).hostname; } catch {}
  if (!/(^|\.)bitrix24\.(kz|ru|com|by|ua)$|^cdn[\w-]*\.bitrix24\.\w+$/.test(host)) return send(res, 400, 'bad url', 'text/plain');
  if (!sharp) { res.writeHead(302, { Location: u }); return res.end(); }
  try {
    let b = IMG.get(u);
    if (!b) {
      if (!IMGQ.has(u)) IMGQ.set(u, (async () => {
        const r = await fetch(u); if (!r.ok) throw new Error('photo ' + r.status);
        const out = await sharp(Buffer.from(await r.arrayBuffer())).rotate().resize(192, 192, { fit: 'cover' }).webp({ quality: 72 }).toBuffer();
        if (IMG.size > 600) IMG.delete(IMG.keys().next().value);
        IMG.set(u, out); return out;
      })().finally(() => IMGQ.delete(u)));
      b = await IMGQ.get(u);
    }
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': b.length, 'Cache-Control': 'public, max-age=2592000, immutable' });
    return res.end(b);
  } catch (e) { res.writeHead(302, { Location: u }); return res.end(); }
}


/* быстрые ответы тяжёлых отчётов: результат держим 45 с (по пользователю и параметрам), данные всё равно обновляются каждые 30 с */
const MEMO = new Map();
const memoClear = () => MEMO.clear();
function memo(key, fn, ttl = 45e3) { const h = MEMO.get(key); if (h && Date.now() - h.t < ttl) return h.v; const v = fn(); MEMO.set(key, { t: Date.now(), v }); if (MEMO.size > 400) MEMO.delete(MEMO.keys().next().value); return v; }
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
const loginPage = err => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Safa портал</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#EEF0F7;font-family:Inter,system-ui,sans-serif;color:#151827;padding:20px}
form{background:#fff;padding:36px 32px 28px;border-radius:24px;width:min(380px,100%);display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px -30px rgba(75,79,232,.35)}
.lg{display:flex;align-items:center;gap:12px;margin-bottom:14px}.lg i{width:44px;height:44px;border-radius:13px;background:#4B4FE8;display:grid;place-items:center}.lg i svg{width:22px;height:22px}
.lg b{font-size:22px;font-weight:700;letter-spacing:-.02em}.lg span{display:block;font-size:13px;color:#8A8FA8;font-weight:500}
input{font:inherit;font-size:15px;padding:14px 15px;border:1.5px solid #E4E6F0;border-radius:12px;outline:none;background:#F7F8FC}input:focus{border-color:#4B4FE8;background:#fff}
button{font:inherit;font-size:15px;font-weight:600;padding:14px;border:0;border-radius:12px;background:#4B4FE8;color:#fff;cursor:pointer;margin-top:4px}button:hover{background:#3F43D6}
.e{color:#DC2626;font-size:14px;background:#FEF2F2;padding:10px 12px;border-radius:10px}.n{font-size:12.5px;color:#8A8FA8;text-align:center;margin-top:6px}</style>
<form method="post" action="/login"><div class="lg"><i><svg viewBox="0 0 24 24" fill="#fff"><path d="M13.5 2L5 13.5h6L10 22l9-12.5h-6.2z"/></svg></i><div><b>Safa портал</b><span>Вход в систему</span></div></div>
${err ? '<div class="e">Неверный email или пароль</div>' : ''}
<input name="login" type="text" inputmode="email" placeholder="Email" autocomplete="username" autocapitalize="none" autofocus required>
<input type="password" name="password" placeholder="Пароль" autocomplete="current-password" required><button>Войти</button>
<div class="n">Аккаунт выдаёт администратор</div></form></html>`;

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
  // короткая ссылка для ТВ: /tv → активное табло (удобно набрать на пульте)
  if (/^\/tv\/?$/i.test(p)) {
    const b = cfg.boards.find(x => x.active) || cfg.boards[0];
    if (!b) return send(res, 404, 'Табло не настроено', 'text/plain; charset=utf-8');
    res.writeHead(302, { Location: '/b/' + b.key + (url.search || '') }); return res.end();
  }
  // ИИ завод — публичная ссылка без входа (только показ, данные выдуманные)
  if (p === '/office' || p === '/zavod' || p === '/ai') return file(res, 'office.html');
  if ((m = p.match(/^\/b\/([\w-]+)\/?$/))) {
    const buf = fs.readFileSync(path.join(PUB, 'board.html')), tag = '"' + require('crypto').createHash('md5').update(buf).digest('hex').slice(0, 16) + '"';
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: tag, 'Cache-Control': 'no-cache' }); return res.end(buf);
  }
  // сделки за суммой на табло: менеджер или сектор, за день / период / месяц → ссылки в CRM
  if ((m = p.match(/^\/api\/board\/([\w-]+)\/deals$/))) {
    const b = cfg.boards.find(x => x.key === m[1]);
    if (!b || !b.active) return send(res, 404, { error: 'Лидерборд не найден' });
    const q = url.searchParams, scope = q.get('scope') || 'day', uid = q.get('uid') || '', sector = q.get('sector') || '';
    const c = ctx(), data = C.computeBoard(scope === 'month' ? { ...b, auto: true } : b, c), { from, to, today } = data.period;
    const mem = new Set(data.members), secOf = C.sectorMap(c);
    const ok = d => mem.has(d.uid) && (scope === 'day' ? d.dk === today : d.dk >= from && d.dk <= to) && (uid ? d.uid === uid : sector ? secOf[d.uid] === sector : true);
    const base = bx.portal(), mask = t => String(t || '').replace(/(\d{4})\d{4}(\d{2})/g, '$1****$2');
    const nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || '';
    const list = c.deals.filter(ok).sort((a, z) => z.dk.localeCompare(a.dk) || z.sum - a.sum)
      .map(d => ({ id: d.id, sum: d.sum, dk: d.dk, t: mask(d.title), who: uid ? '' : nm(d.uid), url: base ? `${base}/crm/deal/details/${d.id}/` : '' }));
    // что связано с сегодняшним днём, но в кассу не попало (только для всей компании за день) — с причиной
    let skipped = [];
    if (scope === 'day' && !uid && !sector) {
      const kassa = new Set(cfg.settings.stages || []), meta = Object.fromEntries(((cache.meta || {}).stages || []).map(x => [x.id, x]));
      const stName = id => meta[id] ? meta[id].category + ' → ' + meta[id].name : id, counted = new Set(list.map(d => d.id));
      const dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: c.settings.tz }), dayOf = v => { const t = v ? new Date(v) : null; return t && !isNaN(t) ? dfmt.format(t) : ''; };
      for (const d of wh.all('deal')) {
        if (counted.has(d.id)) continue;
        const od = d.od || '', moved = dayOf(d.mv || d.md), created = dayOf(d.cr);
        let why = '';
        if (od === today && !kassa.has(d.st)) why = d.sem === 'F' ? 'дата заказа сегодня, но сделка закрыта как отказ' : 'дата заказа сегодня, но стадия не входит в кассу';
        else if (od === today && kassa.has(d.st) && !mem.has(d.uid)) why = 'менеджер не участвует в табло (скрыт или исключён)';
        else if (kassa.has(d.st) && !od && (moved === today || created === today)) why = 'в кассовой стадии, но дата заказа не заполнена';
        else if (kassa.has(d.st) && od && od !== today && moved === today) why = 'перешла в кассу сегодня, но дата заказа — ' + od.split('-').reverse().join('.');
        if (!why) continue;
        skipped.push({ id: d.id, sum: d.sum, t: mask(d.t), who: nm(d.uid), stage: stName(d.st), why, url: base ? `${base}/crm/deal/details/${d.id}/` : '' });
      }
      skipped.sort((a, z) => z.sum - a.sum); skipped = skipped.slice(0, 80);
    }
    return send(res, 200, { from: scope === 'day' ? today : from, to: scope === 'day' ? today : to, sum: list.reduce((a, d) => a + d.sum, 0), deals: list, skipped });
  }
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
    // «Топ месяца» — всегда за текущий календарный месяц, даже если у доски свой период
    const M = C.monthRange(data.period.today);
    const month = M.from === from && M.to === to ? { from, to, rows: null } : { ...M, rows: C.computeBoard({ ...b, auto: true }, ctx()).rows };
    return send(res, 200, { ...data, now: Date.now(), build: BUILD, month, members: undefined, _all: undefined, events: ev, seq, syncedAt: cache.syncedAt, error: cache.error, company: cfg.settings.company });
  }
  if (p === '/live.mp4' || p === '/live.webm' || p === '/stripes.mp4' || p === '/stripes.webm') {
    const buf = fs.readFileSync(path.join(PUB, p.slice(1))), type = p.endsWith('webm') ? 'video/webm' : 'video/mp4';
    const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (rg) { const st = +rg[1] || 0, en = rg[2] ? +rg[2] : buf.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${st}-${en}/${buf.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': en - st + 1, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(buf.subarray(st, en + 1)); }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(buf);
  }
  // шрифт — свой (без Google Fonts), кэш навсегда
  if ((m = p.match(/^\/fonts\/([\w-]+\.woff2)$/))) {
    const f = path.join(PUB, 'fonts', m[1]); if (!fs.existsSync(f)) return send(res, 404, 'no', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(f));
  }
  // фото из Bitrix24: уменьшаем до 192×192 webp (было до сотен КБ на фото), кэш в памяти и в браузере
  if (p === '/img') return imgProxy(url.searchParams.get('u') || '', res);
  if (p === '/sale.mp3' || p === '/overtake.mp3') {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUB, p.slice(1))));
  }
  if ((m = p.match(/^\/photo\/(\w+)$/))) {
    const ph = store.get('photo:' + m[1]);
    if (!ph) return send(res, 404, 'no photo', 'text/plain');
    const [, type, b64] = String(ph.data).match(/^data:([^;]+);base64,(.*)$/) || [];
    if (!b64) return send(res, 404, 'bad photo', 'text/plain');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(Buffer.from(b64, 'base64'));
  }

  // --- live-поток для табло (публичный, без данных — только сигнал «обновись») ---
  if (p === '/api/live') return liveOpen(req, res);
  // --- Bitrix24: исходящий вебхук (адрес с секретным ключом из «Настройки → Система») ---
  if ((m = p.match(/^\/api\/bx\/(\w+)\/?$/))) {
    const t = bxHookToken(), ok = m[1].length === t.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(t));
    if (!ok) return send(res, 403, { error: 'bad token' });
    kick('bitrix'); return send(res, 200, { ok: true });
  }
  // --- Wazzup: вебхук сообщений (адрес с секретным ключом, ставится при подключении в настройках) ---
  if ((m = p.match(/^\/api\/wz\/(\w+)\/?$/))) {
    const t = wz.token(), ok = m[1].length === t.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(t));
    if (!ok) return send(res, 403, { error: 'bad token' });
    if (req.method !== 'POST') return send(res, 200, { ok: true });
    let body = {}; try { body = JSON.parse(await readBody(req, 5e6) || '{}'); } catch {}
    const n = body.test ? 0 : await wz.ingest(body).catch(e => { console.error('wazzup ingest', e.message); return 0; });
    return send(res, 200, { ok: true, accepted: n });
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
  // пока данные из базы грузятся после перезапуска (несколько секунд) — отчёты ждут, а не отдают пустоту
  if (p.startsWith('/api/admin/') && p !== '/api/admin/state') await wh.ready();
  let scope = auth.scopeOf(user); const isOwner = user.role === 'owner';
  // фильтр «сектор» сверху страницы: все отчёты, звонки, активность и AI-ассистент — только по выбранному сектору
  { const qs_ = url.searchParams.get('sector'); if (qs_ && /^\/api\/(admin|ai)\//.test(p) && !/^\/api\/admin\/(config|users|settings|state|owner)/.test(p))
      scope = { ...scope, sectors: scope.sectors ? scope.sectors.filter(x => x === qs_) : [qs_] }; }
  // только владелец: настройки, фото, сверка, пересинхронизация, аккаунты, база
  const ownerOnly = (p.startsWith('/api/admin/bots/') && !p.startsWith('/api/admin/bots/task/')) || (p === '/api/admin/config' && req.method !== 'GET') || p.startsWith('/api/admin/photo/') || p === '/api/admin/diag' ||
    p === '/api/admin/resync' || /\/test-sale$/.test(p) || p.startsWith('/api/admin/users') || p.startsWith('/api/admin/wh/') || p.startsWith('/api/admin/att/') || p.startsWith('/api/admin/callai/settings') || p.startsWith('/api/admin/wz/settings');
  if (ownerOnly && !isOwner) return send(res, 403, { error: 'Доступно только владельцу' });
  if (req.method !== 'GET' && p.startsWith('/api/admin/')) MEMO.clear(); // изменили настройки/данные — отчёты пересчитать
  // тяжёлые отчёты: повторное открытие страницы — мгновенно из памяти (45 с)
  if (req.method === 'GET' && /^\/api\/admin\/(profile\/\w+|overview|calls|calls\/list|calls\/minutes|funnel|sources|activity|fromadmin|wz\/leads|wz\/speed|eff|touches|sales|tv\/today|callai\/summary)$/.test(p)) {
    const key = (user.id || user.login || '') + '|' + p + url.search, h = MEMO.get(key);
    if (h && Date.now() - h.t < 45e3) return send(res, 200, h.v);
    const end = res.end.bind(res), wh_ = res.writeHead.bind(res); let code = 200;
    res.writeHead = (c, ...r) => { code = c; return wh_(c, ...r); };
    res.end = b => { if (code === 200 && b) { try { MEMO.set(key, { t: Date.now(), v: JSON.parse(b) }); if (MEMO.size > 400) MEMO.delete(MEMO.keys().next().value); } catch {} } return end(b); };
  }

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
      accounts: isOwner ? auth.list() : undefined, ownerLogin: isOwner ? auth.ownerLogin() : undefined, bxHook: isOwner ? '/api/bx/' + bxHookToken() : undefined, wzCh: Object.fromEntries(wz.status().channels.map(x => [x.id, wz.channelName(x.id)])), attPen: isOwner ? att.penalties(cfg) : undefined, wh: wh.status(), ai: !!process.env.ANTHROPIC_API_KEY,
    });
  }
  if (p === '/api/admin/config' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    const prevStages = JSON.stringify([cfg.settings.stages, cfg.settings.dateField]);
    cfg = C.normalize({ settings: body.settings, managers: body.managers, boards: body.boards, penalties: body.penalties || [], sectorBoards: cfg.sectorBoards || [], presetV: cfg.presetV, oneBoardV2: cfg.oneBoardV2, brandV3: cfg.brandV3 });
    await store.set('config', cfg); wh.setCfg(cfg); att.touch(); cai.setCfg(cfg);
    if (JSON.stringify([cfg.settings.stages, cfg.settings.dateField]) !== prevStages) seen = null;
    sync().then(loop); livePush('config');
    return send(res, 200, { ok: true, cfg });
  }
  if ((m = p.match(/^\/api\/admin\/photo\/(\w+)$/))) {
    if (req.method === 'DELETE') { await store.del('photo:' + m[1]); return send(res, 200, { ok: true }); }
    const { data } = JSON.parse(await readBody(req));
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(data || '')) return send(res, 400, { error: 'Нужна картинка' });
    await store.set('photo:' + m[1], { data, ts: Date.now() });
    livePush('config');
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
  // заказы сегодня на табло + «показать на экране снова» (если на ТВ пропустили попап)
  if (p === '/api/admin/tv/today') {
    const b = cfg.boards.find(x => x.active) || cfg.boards[0]; if (!b) return send(res, 200, { rows: [] });
    const c = ctx(), data = C.computeBoard(b, c), today = data.period.today, mem = new Set(data.members);
    const nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || 'Менеджер', base = bx.portal();
    const mask = t => String(t || '').replace(/(\d{4})\d{4}(\d{2})/g, '$1****$2');
    const shown = Object.fromEntries(events.filter(e => !e.test).map(e => [e.id, e.at]));
    const rows = c.deals.filter(d => d.dk === today && mem.has(d.uid)).sort((a, z) => (shown[z.id] || 0) - (shown[a.id] || 0) || +z.id - +a.id)
      .map(d => ({ id: d.id, uid: d.uid, name: nm(d.uid), sum: d.sum, title: mask(d.title), shownAt: shown[d.id] || null, replayed: (store.get('tv:replay') || {})[d.id] || null, url: base ? `${base}/crm/deal/details/${d.id}/` : '' }));
    return send(res, 200, { board: b.name, today, rows });
  }
  if (p === '/api/admin/tv/replay' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 1e4) || '{}'), b = cfg.boards.find(x => x.active) || cfg.boards[0];
    const c = ctx(), d = c.deals.find(x => String(x.id) === String(body.id)); if (!b || !d) return send(res, 404, { error: 'Сделка не найдена' });
    events.push({ seq: ++seq, at: Date.now(), ...d, replay: true });
    const rp = { ...(store.get('tv:replay') || {}) }; rp[d.id] = Date.now(); for (const k of Object.keys(rp)) if (Date.now() - rp[k] > 2 * 864e5) delete rp[k]; store.set('tv:replay', rp);
    livePush('data');
    return send(res, 200, { ok: true });
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
  // минуты разговоров за период (все звонки склада, без фильтров) — для расчёта стоимости ИИ-оценки
  if (p === '/api/admin/calls/minutes') {
    const q = url.searchParams, from = q.get('from'), to = q.get('to') || from, c = ctx();
    const L = wh.all('call').filter(x => x.d >= from && x.d <= to), B = [[0, 0], [1, 30], [31, 60], [61, 180], [181, 600], [601, 1e9]];
    const S = a => a.reduce((s, x) => s + x.dur, 0), by = {};
    L.forEach(x => { if (x.dur > 0) { const r = by[x.uid] || (by[x.uid] = { name: (c.userMap[x.uid] || {}).name || x.uid, n: 0, sec: 0 }); r.n++; r.sec += x.dur; } });
    return send(res, 200, { from, to, calls: L.length, talked: L.filter(x => x.dur > 0).length, sec: S(L), recSec: S(L.filter(x => x.rec)), recCnt: L.filter(x => x.rec && x.dur > 0).length,
      buckets: B.map(([lo, hi]) => { const a = L.filter(x => x.dur >= lo && x.dur <= hi); return { lo, hi, n: a.length, sec: S(a) }; }),
      people: Object.keys(by).length, top: Object.values(by).sort((a, z) => z.sec - a.sec).slice(0, 60) });
  }
  if (p === '/api/admin/calls/list') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const f = { from: q.get('from') || today, to: q.get('to') || today, sector: q.get('sector') || '', uid: q.get('uid') || '' };
    const out = AN.callList(ctx(), scope, f, { q: q.get('q') || '', rec: q.get('all') !== '1', limit: q.get('limit') });
    out.rows.forEach(r => { const x = cai.get(r.id); if (x && x.pending) r.ai = { pending: true }; else if (x) r.ai = x.skip ? { skip: true } : { score: x.score, outcome: x.outcome }; });
    out.callai = { on: cai.status().settings.on, ready: cai.status().ready };
    return send(res, 200, out);
  }
  // главная: всё важное одним запросом (руководитель — только свои секторы)
  if (p === '/api/admin/overview') {
    const c = ctx(), A = AN.allowedUids(c, scope, {}), b = cfg.boards[0];
    if (!b) return send(res, 200, { empty: true });
    const d = C.computeBoard(b, c), mine = r => A.has(r.uid);
    const secs = d.sectors.filter(x => !scope.sectors || scope.sectors.includes(x.id));
    const rows = d.rows.filter(mine);
    const sum = rows.reduce((a, r) => a + r.sum, 0), daySum = rows.reduce((a, r) => a + r.daySum, 0);
    const cnt = rows.reduce((a, r) => a + r.cnt, 0), dayCnt = rows.reduce((a, r) => a + r.dayCnt, 0);
    const plan = secs.reduce((a, x) => a + x.plan, 0), dayPlan = secs.reduce((a, x) => a + x.dayPlan, 0);
    const P = d.period, elapsed = Math.max(1, P.workdays - P.daysLeft + 1);
    const forecast = P.today >= P.from && P.today <= P.to ? Math.round(sum / elapsed * P.workdays) : sum;
    const days = []; for (let k = P.from; k <= P.to; k = C.addDays(k, 1)) days.push({ dk: k, sum: 0, cnt: 0 });
    const DI = Object.fromEntries(days.map((x, i) => [x.dk, i]));
    const mem = new Set(d.members);
    c.deals.forEach(x => { if (mem.has(x.uid) && A.has(x.uid) && DI[x.dk] != null) { days[DI[x.dk]].sum += x.sum; days[DI[x.dk]].cnt++; } });
    const nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || ('ID ' + id);
    const recent = c.deals.filter(x => x.dk === P.today && mem.has(x.uid) && A.has(x.uid)).sort((x, y) => +y.id - +x.id).slice(0, 8)
      .map(x => ({ id: x.id, title: x.title, sum: x.sum, uid: x.uid, name: nm(x.uid) }));
    // сигналы «требует внимания»
    const f = { from: P.from, to: P.today, stageNames: stageNames() };
    let alerts = {};
    try {
      const T = EF.touches(c, scope, f, cfg);
      alerts = { zero: T.total.zero, deals: T.total.deals, lostLow: T.total.lostLow, lost: T.total.lost, forgotten: T.total.forgotten, forgetDays: T.forgetDays };
      const CL = AN.calls(c, scope, { from: P.today, to: P.today });
      alerts.missedToday = CL.total.missed; alerts.callsToday = CL.total.total;
      const at = att.report(cfg, { date: P.today }, uid => A.has(uid));
      if (at.rows.length) { alerts.lateToday = at.rows.filter(r => r.st === 'late').length; alerts.absentToday = at.rows.filter(r => r.st === 'absent').length; alerts.attTotal = at.rows.length; }
      const q = cai.summary(uid => A.has(uid), P.from, P.today, nm);
      if (q.total.n) alerts.ai = { avg: q.total.avg, n: q.total.n };
    } catch (e) { alerts.error = e.message; }
    // сравнение с прошлым периодом и динамика по месяцам — по базе (дата заказа, стадии факта кассы)
    const FS = new Set(cfg.settings.stages || []), WD = wh.all('deal').filter(x => x.od && A.has(x.uid));
    const cash = (from, to) => WD.reduce((a, x) => a + (x.od >= from && x.od <= to && FS.has(x.st) ? x.sum : 0), 0);
    const cntOf = (from, to) => WD.filter(x => x.od >= from && x.od <= to && FS.has(x.st)).length;
    const shiftM = (k, n) => { const d = new Date(k.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.toISOString().slice(0, 8) + String(Math.min(+k.slice(8, 10), last)).padStart(2, '0'); };
    const pFrom = shiftM(P.from, -1), pTo = shiftM(P.today, -1), yest = C.addDays(P.today, -1);
    const cmp = { prevSum: cash(pFrom, pTo), prevCnt: cntOf(pFrom, pTo), yestSum: cash(yest, yest), prevFrom: pFrom, prevTo: pTo };
    const months = [];
    for (let i = 6; i >= 0; i--) {
      const m0 = shiftM(P.from, -i).slice(0, 7), mf = m0 + '-01', mt = C.monthRange(mf).to;
      const os = WD.filter(x => x.od >= mf && x.od <= mt);
      months.push({ m: m0, orders: os.reduce((a, x) => a + x.sum, 0), won: os.reduce((a, x) => a + (C.vykupOf(x, cfg.settings) === 'won' ? x.sum : 0), 0), cnt: os.length });
    }
    let sources = [];
    try { sources = AN.sources(c, scope, { from: P.from, to: P.today }).slice(0, 4); } catch {}
    let eff = null;
    try { const E = EF.efficiency(c, scope, f, cfg); eff = { team: E.team, top: E.rows.slice(0, 3).map(r => ({ uid: r.uid, name: r.name, index: r.index })), low: E.rows.filter(r => r.index != null).slice(-3).reverse().map(r => ({ uid: r.uid, name: r.name, index: r.index, weak: r.weak })) }; } catch {}
    return send(res, 200, {
      period: P, board: { key: b.key, active: b.active, name: b.name }, syncedAt: cache.syncedAt, error: cache.error,
      team: { sum, daySum, cnt, dayCnt, plan, dayPlan, forecast, avg: cnt ? sum / cnt : 0, salary: isOwner ? rows.reduce((a, r) => a + (r.salary || 0), 0) : undefined, managers: rows.length },
      sectors: secs, today: rows.filter(r => r.daySum > 0).sort((x, y) => y.daySum - x.daySum).slice(0, 5).map(r => ({ uid: r.uid, name: r.name, photo: r.photo, sector: r.sectorName, daySum: r.daySum, dayCnt: r.dayCnt })),
      leaders: rows.slice(0, 5).map(r => ({ uid: r.uid, name: r.name, photo: r.photo, sector: r.sectorName, sum: r.sum, cnt: r.cnt })),
      days, recent, alerts, eff, cmp, months, sources, pipes: pipesOf(c, A),
      managers: rows.map(r => ({ uid: r.uid, name: r.name, sector: r.sectorName, sum: r.sum, cnt: r.cnt, daySum: r.daySum, dayCnt: r.dayCnt })),
    });
  }
  // эффективность менеджеров и касания
  if (p === '/api/admin/eff' || p === '/api/admin/touches') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz);
    const f = { from: q.get('from') || C.monthRange(today).from, to: q.get('to') || today, sector: q.get('sector') || '', uid: q.get('uid') || '', stageNames: stageNames() };
    return send(res, 200, p === '/api/admin/eff' ? EF.efficiency(ctx(), scope, f, cfg) : EF.touches(ctx(), scope, f, cfg));
  }
  if ((m = p.match(/^\/api\/admin\/profile\/(\w+)$/))) {
    const c = ctx(); if (!AN.allowedUids(c, scope, {}).has(m[1])) return send(res, 403, { error: 'Нет доступа к этому менеджеру' });
    if (!profLoaded) { profLoaded = true; Object.entries(store.get('profiles') || {}).forEach(([k, v]) => PROF.set(k, v)); }
    const hit = PROF.get(m[1]); if (hit) return send(res, 200, hit);
    try { const v = { ...require('./lib/profile').profile(c, { role: 'owner', sectors: null }, m[1], cfg, bx.portal()), at: Date.now() }; PROF.set(m[1], v); return send(res, 200, v); } catch (e) { return send(res, 500, { error: e.message }); }
  }
  if ((m = p.match(/^\/api\/admin\/eff\/card\/(\w+)$/))) {
    const c = ctx();
    if (!AN.allowedUids(c, scope, {}).has(m[1])) return send(res, 403, { error: 'Нет доступа' });
    return send(res, 200, EF.card(c, scope, m[1], cfg));
  }
  // Wazzup: подключение и отчёт по мессенджерам
  if (p === '/api/admin/wz/settings') {
    if (req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}'), proto = req.headers['x-forwarded-proto'] || 'http';
      try {
        if (b.backfill) { wz.backfill(Date.now() - Math.min(+b.days || 30, 120) * 864e5).catch(() => {}); return send(res, 200, wz.status()); }
        const before = wz.status().lastAt, R = await wz.connect(b.key, `${proto}://${req.headers.host}/api/wz/${wz.token()}`);
        wz.backfill(before ? before - 3600e3 : Date.now() - 60 * 864e5).catch(() => {});
        return send(res, 200, { ...R, backfill: wz.backfillStatus() });
      }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    return send(res, 200, wz.status());
  }
  // WhatsApp-лиды по дням: сколько написало, сколько новых/повторных, с какого номера, что в CRM (сделка, стадия, менеджер, сумма)
  if (p === '/api/admin/activity') { const q = url.searchParams, c = ctx(); return send(res, 200, ACT.activity(c, AN.allowedUids(c, scope, { sector: q.get('sector') || '' }), cfg, q.get('day') || C.todayKey(cfg.settings.tz), { gap: Math.max(5, Math.min(120, +q.get('gap') || 20)) })); }
  if (p === '/api/admin/fromadmin') return send(res, 200, fromAdmin(url.searchParams, scope));
  if (p === '/api/admin/wz/leads') return send(res, 200, waLeads(url.searchParams, scope, isOwner));
  if (p === '/api/admin/wz/report') {
    const q = url.searchParams, today = C.todayKey(cfg.settings.tz), c = ctx();
    const A = AN.allowedUids(c, scope, { sector: q.get('sector') || '', uid: q.get('uid') || '' });
    const norm = x => String(x || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-яәғқңөұүһі0-9 ]/gi, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
    const byName = {}; c.users.forEach(u => { const k = norm((cfg.managers[u.id] || {}).name || u.name); if (k) byName[k] = u.id; });
    const nm = id => (c.userMap[id] ? ((cfg.managers[id] || {}).name || c.userMap[id].name) : '');
    return send(res, 200, wz.report(q.get('from') || C.monthRange(today).from, q.get('to') || today, cfg.settings.tz, nm, n => byName[norm(n)] || '', id => A.has(id)));
  }
  // AI-разбор звонков
  // «ИИ завод»: боты, задачи, отчёт
  if (p === '/api/admin/bots') {
    const c = ctx(), A = AN.allowedUids(c, scope, {});
    const v = bots.view(id => A.has(id), isOwner), nm = id => (cfg.managers[id] || {}).name || (c.userMap[id] || {}).name || '';
    v.tasks.forEach(t => { t.who = nm(t.uid); });
    if (isOwner) v.channels = wz.status().channels.filter(x => /whatsapp|wapi/.test(x.transport || '') && x.state === 'active').map(x => ({ id: x.id, name: wz.channelName(x.id) }));
    return send(res, 200, v);
  }
  if ((m = p.match(/^\/api\/admin\/bots\/task\/([\w-]+)$/)) && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 1e4) || '{}'), t = bots.view(() => true, true).tasks.find(x => x.id === m[1]);
    if (!t) return send(res, 404, { error: 'Задача не найдена' });
    const A = AN.allowedUids(ctx(), scope, {});
    if (!isOwner && (t.owner || !A.has(t.uid))) return send(res, 403, { error: 'Нет доступа' });
    return send(res, 200, await bots.setStatus(m[1], body.status, user.name || user.login || 'владелец'));
  }
  if (p === '/api/admin/bots/run' && req.method === 'POST') { await bots.runAll(true); return send(res, 200, { ok: true }); }
  if (p === '/api/admin/bots/settings' && req.method === 'POST') return send(res, 200, await bots.setCfg(JSON.parse(await readBody(req, 1e4) || '{}')));
  if (p === '/api/admin/bots/report' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 1e4) || '{}');
    return send(res, 200, await bots.report(!!body.send));
  }
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
  if ((m = p.match(/^\/api\/admin\/callai\/([\w.-]+)\/mgr$/)) && req.method === 'POST') {
    const c = wh.byId('call', m[1]); if (!c || !AN.allowedUids(ctx(), scope, {}).has(c.uid)) return send(res, 404, { error: 'Звонок не найден' });
    try { const b = JSON.parse(await readBody(req, 1e3) || '{}'); await cai.setMgr(c.id, b.mgr); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if ((m = p.match(/^\/api\/admin\/callai\/([\w.-]+)$/))) {
    const c = wh.byId('call', m[1]);
    if (!c) return send(res, 404, { error: 'Звонок не найден в базе' });
    if (!AN.allowedUids(ctx(), scope, {}).has(c.uid)) return send(res, 403, { error: 'Нет доступа к этому звонку' });
    try {
      const d = req.method === 'POST' ? await cai.analyze(c.id) : cai.get(c.id);
      if (!d) return send(res, 404, { error: 'Разбора ещё нет' });
      const x = ctx(); const nm = (cfg.managers[c.uid] || {}).name || (x.userMap[c.uid] || {}).name || '';
      const tr = await cai.transcript(c.id);
      return send(res, 200, { ...d, mgr: d.mgr || cai.guessMgr(tr), name: nm, phone: c.ph, transcript: tr });
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
      // запись из нашей копии в Supabase, иначе скачиваем из Bitrix24 (с повторами) и сохраняем
      const a = await recs.get(c.id), total = a.buf.length;
      if (url.searchParams.has('prep')) return send(res, 200, { ok: true, size: total }); // только подготовить (скачать к себе)
      const h = { 'Content-Type': a.type, 'Cache-Control': 'private, max-age=86400', 'Accept-Ranges': 'bytes' };
      if (url.searchParams.has('dl')) h['Content-Disposition'] = `attachment; filename="call_${c.id.replace(/[^\w.-]/g, '')}.mp3"`;
      const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (rg) { const st = rg[1] ? +rg[1] : 0, en = Math.min(rg[2] ? +rg[2] : total - 1, total - 1);
        res.writeHead(206, { ...h, 'Content-Range': `bytes ${st}-${en}/${total}`, 'Content-Length': en - st + 1 }); return res.end(a.buf.subarray(st, en + 1)); }
      res.writeHead(200, { ...h, 'Content-Length': total }); return res.end(a.buf);
    } catch (e) { return send(res, 502, { error: e.message }); }
  }
  // владелец: вручную перенести человека в сектор (если в Bitrix24 он числится в другом отделе)
  if (p === '/api/admin/managers/sector' && req.method === 'POST') {
    if (!isOwner) return send(res, 403, { error: 'Доступно только владельцу' });
    const b = JSON.parse(await readBody(req, 1e3) || '{}'), id = String(b.uid || ''); if (!id) return send(res, 400, { error: 'uid' });
    cfg.managers[id] = { ...(cfg.managers[id] || {}), sector: b.sector ? String(b.sector) : undefined }; if (!b.sector) delete cfg.managers[id].sector;
    if (b.rop != null) { if (b.rop) cfg.managers[id].rop = true; else delete cfg.managers[id].rop; }
    await store.set('config', cfg); MEMO.clear(); livePush('config'); return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/diag/dupes') {
    if (!isOwner) return send(res, 403, { error: 'owner' });
    const out = {};
    const grp = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); if (!k) continue; const a = m.get(k); if (a) a.push(x.id); else m.set(k, [x.id]); } const d = [...m.values()].filter(a => a.length > 1); return { groups: d.length, extra: d.reduce((s, a) => s + a.length - 1, 0), sample: d.slice(0, 5) }; };
    const calls = wh.all('call'); out.calls = { total: calls.length, byIdShape: { withDot: calls.filter(c => c.id.includes('.')).length, numeric: calls.filter(c => /^\d+$/.test(c.id)).length }, dup: grp(calls, c => c.uid + '|' + c.at + '|' + c.ph + '|' + c.dur) };
    const deals = wh.all('deal'); out.deals = { total: deals.length, dup: grp(deals, d => d.id) };
    const leads = wh.all('lead'); out.leads = { total: leads.length };
    out.contacts = { total: wh.all('contact').length };
    const pool = store.pool();
    if (pool) { const r = await pool.query(`select entity, count(*) n from wh_rows group by entity`); out.db = r.rows; }
    return send(res, 200, out);
  }
  if (p === '/api/admin/diag/db') {
    if (!isOwner) return send(res, 403, { error: 'owner' });
    const pool = store.pool(); const out = { kind: store.kind() };
    try { if (pool) { const r = await pool.query(`select pg_database_size(current_database()) db, (select coalesce(sum(size),0) from call_audio) audio, (select count(*) from call_audio) n, current_database() name, inet_server_addr()::text host`); out.db = r.rows[0]; } } catch (e) { out.err = e.message; }
    try { out.ffmpeg = require('child_process').execSync('ffmpeg -version 2>&1 | head -1').toString().trim(); } catch { out.ffmpeg = null; }
    out.supaHost = String(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').replace(/^.*@/, '').replace(/[:/].*$/, '');
    return send(res, 200, out);
  }
  if (p === '/api/admin/users' && req.method === 'POST') {
    try { return send(res, 200, { ok: true, user: await auth.saveUser(JSON.parse(await readBody(req, 1e5))) }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/admin/owner' && req.method === 'POST') {
    if (!isOwner) return send(res, 403, { error: 'Доступно только владельцу' });
    try { return send(res, 200, { ok: true, ...(await auth.setOwner(JSON.parse(await readBody(req, 1e4)))) }); }
    catch (e) { await new Promise(r => setTimeout(r, 400)); return send(res, 400, { error: e.message }); }
  }
  if ((m = p.match(/^\/api\/admin\/users\/(\w+)$/)) && req.method === 'DELETE') { await auth.deleteUser(m[1]); return send(res, 200, { ok: true }); }
  // дубли: сделки стадии stage (напр. «Общая → Заказ»), у которых есть пара в другой воронке (по умолчанию «Логистика»).
  // Пары один-к-одному: одна сделка логистики закрывает только одну сделку-источник (повторные заказы клиента не считаются дублями).
  // Только владелец (префикс /api/admin/wh/).
  if (p === '/api/admin/wh/dupes' && req.method === 'GET') {
    const q = url.searchParams, stage = q.get('stage');
    if (!stage) {
      const { label } = dupeCtx(), cnt = {}; wh.all('deal').forEach(d => { cnt[d.st] = (cnt[d.st] || 0) + 1; });
      return send(res, 200, { stages: Object.entries(cnt).map(([id, n]) => ({ id, n, name: label(id) })).sort((a, b) => b.n - a.n), wh: wh.status() });
    }
    const r = dupePairs(stage, q.get('target') || 'логист');
    const mask = s => String(s || '').replace(/(\d{4})\d{4}(\d{2})/g, '$1****$2'), lim = +q.get('limit') || 50;
    return send(res, 200, { ...r.summary, pairs: r.pairs.slice(0, lim).map(x => ({ id: x.src.id, pair: x.tgt.id, how: x.how, sum: x.src.sum, pairSum: x.tgt.sum, od: x.src.od, pairOd: x.tgt.od, pairStage: r.label(x.tgt.st) })),
      unmatched: r.unmatched.slice(0, lim).map(d => ({ id: d.id, t: mask(d.t), sum: d.sum, od: d.od, cr: (d.cr || '').slice(0, 10) })), job: dupeJob });
  }
  if (p === '/api/admin/wh/dupes/delete' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
    if (body.confirm !== 'DELETE' || !body.stage) return send(res, 400, { error: 'нужно подтверждение' });
    if (dupeJob && dupeJob.running) return send(res, 409, { error: 'удаление уже идёт', job: dupeJob });
    const r = dupePairs(body.stage, body.target || 'логист');
    if (Array.isArray(body.only)) r.pairs = r.pairs.filter(x => body.only.includes(x.how));
    if (+body.expect !== r.pairs.length) return send(res, 409, { error: 'число дублей изменилось', now: r.pairs.length });
    const key = 'dupes:backup:' + new Date().toISOString();
    await store.set(key, { stage: body.stage, target: body.target || 'логист', at: Date.now(), by: user.login || user.role,
      pairs: r.pairs.map(x => ({ deal: x.src, pair: x.tgt, how: x.how })) });
    dupeJob = { running: true, total: r.pairs.length, done: 0, deleted: 0, skipped: [], errors: [], backup: key, startedAt: Date.now() };
    runDupeDelete(r.pairs, body.stage).catch(e => { dupeJob.errors.push(String(e.message || e)); }).finally(() => { dupeJob.running = false; dupeJob.finishedAt = Date.now(); });
    return send(res, 200, dupeJob);
  }
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
  loadSnap();
  http.createServer((req, res) => handle(req, res).catch(e => {
    console.error(e); if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  })).listen(PORT, () => console.log('Leaderboard on :' + PORT));
  sync().then(async () => { loop(); if (!cache.meta && bx.configured()) { cache.meta = await bx.meta().catch(() => null); if (cache.meta) saveSnap(true); } });
  wh.start(cfg).then(warm);
  bots.init({ wh, cai, wz, C, cache, ctx, cfg: () => cfg, dupePairs,
    waLost: () => { const t = C.todayKey(cfg.settings.tz), f = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
      return waLeads(new URLSearchParams({ from: f, to: t }), { role: 'owner', sectors: null }, true).rows.filter(r => r.lost); }, deal: id => { const b = bx.portal(); return b ? `${b}/crm/deal/details/${id}/` : ''; } }); cai.start(cfg); wz.init().then(() => wz.autoConnect(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '')).catch(e => console.error('wazzup init', e.message));
})();
