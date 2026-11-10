// Аналитика по базе: воронка, выкуп, зависшие сделки, звонки, скорость реакции на лид.
const wh = require('./warehouse');
const C = require('./calc');

const DAY = 864e5;
const name = (ctx, uid) => (ctx.managers[uid] || {}).name || (ctx.userMap[uid] || {}).name || (uid ? 'ID ' + uid : '—');
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Какие менеджеры доступны: роль (сектора руководителя) + фильтры сектора/менеджера. null — все.
function allowedUids(ctx, scope, { sector, uid } = {}) {
  const secOf = C.sectorMap(ctx);
  let sectors = scope && scope.sectors ? new Set(scope.sectors) : null;
  if (sector) sectors = sectors ? new Set([...sectors].filter(s => s === sector)) : new Set([sector]);
  const hidden = id => (ctx.managers[id] || {}).hidden;
  if (!sectors && !uid) return { has: id => !hidden(id), secOf, all: true };
  const ok = id => !hidden(id) && (!sectors || sectors.has(secOf[id])) && (!uid || id === uid);
  return { has: ok, secOf, all: false };
}
function sectorNames(ctx) { return Object.fromEntries(C.sectorsOf(ctx.deps).map(d => [d.id, d.name])); }

/* ===== воронка и выкуп ===== */
function funnel(ctx, scope, f) {
  const { from, to } = f, A = allowedUids(ctx, scope, f), SN = sectorNames(ctx);
  const stName = f.stageNames || {};
  // «простой режим» CRM: лидов в Bitrix24 нет — верх воронки = новые сделки (обращения), «сконвертировано» = дошли до заказа
  const simple = wh.all('lead').length === 0;
  const created = wh.all('deal').filter(d => d.crd >= from && d.crd <= to && A.has(d.uid));
  const leads = simple ? created.map(d => ({ uid: d.uid, sem: d.od ? 'S' : 'P' })) : wh.all('lead').filter(l => l.crd >= from && l.crd <= to && A.has(l.uid));
  const orders = wh.all('deal').filter(d => d.od && d.od >= from && d.od <= to && A.has(d.uid));
  const row = () => ({ leads: 0, leadsWon: 0, deals: 0, orders: 0, ordersSum: 0, won: 0, wonSum: 0, lost: 0, lostSum: 0, open: 0, openSum: 0 });
  const by = {}, sec = {}, tot = row();
  const get = (map, k) => map[k] || (map[k] = row());
  const add = (uid, fn) => { fn(get(by, uid)); fn(get(sec, A.secOf[uid] || '')); fn(tot); };
  leads.forEach(l => add(l.uid, r => { r.leads++; if (l.sem === 'S') r.leadsWon++; }));
  created.forEach(d => add(d.uid, r => { r.deals++; }));
  orders.forEach(d => add(d.uid, r => {
    r.orders++; r.ordersSum += d.sum;
    if (d.sem === 'S') { r.won++; r.wonSum += d.sum; } else if (d.sem === 'F') { r.lost++; r.lostSum += d.sum; } else { r.open++; r.openSum += d.sum; }
  }));
  const fin = r => ({ ...r, conv: r.leads ? r.leadsWon / r.leads * 100 : null, vykup: r.won + r.lost ? r.won / (r.won + r.lost) * 100 : null,
    vykupSum: r.wonSum + r.lostSum ? r.wonSum / (r.wonSum + r.lostSum) * 100 : null, avg: r.orders ? r.ordersSum / r.orders : 0 });
  const managers = Object.entries(by).map(([uid, r]) => ({ uid, name: name(ctx, uid), sector: SN[A.secOf[uid]] || '', ...fin(r) })).sort((a, b) => b.ordersSum - a.ordersSum);
  const sectors = Object.entries(sec).map(([id, r]) => ({ id, name: SN[id] || 'Без сектора', ...fin(r) })).sort((a, b) => b.ordersSum - a.ordersSum);

  // зависшие: заказы в работе (не выкуплены и не отказ), сколько дней в текущей стадии
  const now = Date.now();
  const openDeals = wh.all('deal').filter(d => d.sem === 'P' && d.od && A.has(d.uid)).map(d => ({
    id: d.id, title: d.t, sum: d.sum, uid: d.uid, manager: name(ctx, d.uid), stage: d.st, stageName: stName[d.st] || d.st, od: d.od,
    days: d.mv ? Math.floor((now - new Date(d.mv)) / DAY) : null,
  }));
  const stages = {};
  openDeals.forEach(d => { const x = stages[d.stage] || (stages[d.stage] = { stage: d.stage, name: d.stageName, cnt: 0, sum: 0, days: [] }); x.cnt++; x.sum += d.sum; if (d.days != null) x.days.push(d.days); });
  const stuck = Object.values(stages).map(x => ({ stage: x.stage, name: x.name, cnt: x.cnt, sum: x.sum, avgDays: x.days.length ? x.days.reduce((a, b) => a + b, 0) / x.days.length : null, over7: x.days.filter(v => v > 7).length }))
    .sort((a, b) => b.sum - a.sum);
  const oldest = openDeals.filter(d => d.days != null).sort((a, b) => b.days - a.days).slice(0, 30);
  return { from, to, mode: simple ? 'deals' : 'leads', total: fin(tot), managers, sectors, stuck, oldest };
}

/* ===== звонки ===== */
const isIn = c => c.ty === 2 || c.ty === 3;
const isOut = c => c.ty === 1 || c.ty === 4;
const answered = c => c.code === '200' && c.dur > 0;
function calls(ctx, scope, f) {
  const { from, to } = f, A = allowedUids(ctx, scope, f), SN = sectorNames(ctx);
  const list = wh.all('call').filter(c => c.d >= from && c.d <= to && A.has(c.uid));
  const orders = wh.all('deal').filter(d => d.od && d.od >= from && d.od <= to && A.has(d.uid));
  const row = () => ({ total: 0, out: 0, outOk: 0, inc: 0, missed: 0, talk: 0, phones: new Set(), orders: 0, ordersSum: 0 });
  const by = {}, tot = row(), hours = Array(24).fill(0);
  const get = uid => by[uid] || (by[uid] = row());
  for (const c of list) {
    for (const r of [get(c.uid), tot]) {
      r.total++; if (isOut(c)) { r.out++; if (answered(c)) r.outOk++; }
      if (isIn(c)) { r.inc++; if (!answered(c)) r.missed++; }
      if (answered(c)) r.talk += c.dur; if (c.ph) r.phones.add(c.ph);
    }
    const h = new Date(c.at).getUTCHours() + 5; hours[(h + 24) % 24]++;
  }
  orders.forEach(d => { for (const r of [get(d.uid), tot]) { r.orders++; r.ordersSum += d.sum; } });
  const fin = r => ({ total: r.total, out: r.out, outOk: r.outOk, inc: r.inc, missed: r.missed, talkMin: Math.round(r.talk / 60), avgTalkSec: r.outOk + (r.inc - r.missed) ? Math.round(r.talk / (r.outOk + r.inc - r.missed)) : 0,
    unique: r.phones.size, orders: r.orders, ordersSum: r.ordersSum, callsPerOrder: r.orders ? r.total / r.orders : null, reach: r.out ? r.outOk / r.out * 100 : null });
  const managers = Object.entries(by).filter(([uid]) => uid).map(([uid, r]) => ({ uid, name: name(ctx, uid), sector: SN[A.secOf[uid]] || '', ...fin(r) })).sort((a, b) => b.total - a.total);

  // скорость реакции на лид: первый звонок по лиду после его создания
  const simple = wh.all('lead').length === 0, ET = simple ? 'DEAL' : 'LEAD';
  const leads = (simple ? wh.all('deal') : wh.all('lead')).filter(l => l.crd >= from && l.crd <= to && A.has(l.uid));
  const first = {};
  for (const c of wh.all('call')) if (c.et === ET && c.eid) { const t = new Date(c.at).getTime(); if (!first[c.eid] || t < first[c.eid]) first[c.eid] = t; }
  const resp = [], noCall = [];
  for (const l of leads) { const t0 = new Date(l.cr).getTime(), t1 = first[l.id]; if (t1 && t1 >= t0 - 60e3) resp.push((t1 - t0) / 60e3); else noCall.push(l); }
  const respBy = {};
  for (const l of leads) { const t1 = first[l.id]; const r = respBy[l.uid] || (respBy[l.uid] = { leads: 0, mins: [], none: 0 }); r.leads++; if (t1) r.mins.push((t1 - new Date(l.cr).getTime()) / 60e3); else r.none++; }
  managers.forEach(m => { const r = respBy[m.uid]; m.leads = r ? r.leads : 0; m.respMedianMin = r ? median(r.mins) : null; m.leadsNoCall = r ? r.none : 0; });
  return {
    from, to, mode: simple ? 'deals' : 'leads', total: fin(tot), managers, hours,
    leadResponse: { leads: leads.length, called: resp.length, noCall: noCall.length, medianMin: median(resp), within5: resp.filter(m => m <= 5).length, within15: resp.filter(m => m <= 15).length,
      noCallList: noCall.slice(0, 30).map(l => ({ id: l.id, title: l.t, manager: name(ctx, l.uid), created: l.cr, kind: simple ? 'deal' : 'lead' })) },
  };
}

/* ===== сделки (для AI и списков) ===== */
function findDeals(ctx, scope, f) {
  const A = allowedUids(ctx, scope, f), stName = f.stageNames || {};
  let rows = wh.all('deal').filter(d => A.has(d.uid));
  const by = f.by === 'created' ? 'crd' : 'od';
  if (f.from) rows = rows.filter(d => d[by] && d[by] >= f.from);
  if (f.to) rows = rows.filter(d => d[by] && d[by] <= f.to);
  if (f.outcome) rows = rows.filter(d => d.sem === { won: 'S', lost: 'F', open: 'P' }[f.outcome]);
  if (f.stage) rows = rows.filter(d => d.st === f.stage || (stName[d.st] || '').toLowerCase().includes(String(f.stage).toLowerCase()));
  if (f.minSum) rows = rows.filter(d => d.sum >= +f.minSum);
  rows.sort((a, b) => (b[by] || '').localeCompare(a[by] || '') || b.sum - a.sum);
  return { count: rows.length, sum: rows.reduce((a, d) => a + d.sum, 0),
    deals: rows.slice(0, Math.min(200, +f.limit || 50)).map(d => ({ id: d.id, title: d.t, sum: d.sum, manager: name(ctx, d.uid), stage: stName[d.st] || d.st, outcome: { S: 'выкуп/успех', F: 'отказ', P: 'в работе' }[d.sem], orderDate: d.od, created: d.crd, source: d.utm || d.src })) };
}

/* ===== источники продаж ===== */
function sources(ctx, scope, f) {
  const A = allowedUids(ctx, scope, f);
  const orders = wh.all('deal').filter(d => d.od && d.od >= f.from && d.od <= f.to && A.has(d.uid));
  const by = {};
  orders.forEach(d => { const k = d.utm || d.src || 'не указан'; const x = by[k] || (by[k] = { source: k, orders: 0, sum: 0, won: 0, lost: 0 }); x.orders++; x.sum += d.sum; if (d.sem === 'S') x.won++; if (d.sem === 'F') x.lost++; });
  return Object.values(by).map(x => ({ ...x, vykup: x.won + x.lost ? x.won / (x.won + x.lost) * 100 : null })).sort((a, b) => b.sum - a.sum);
}

module.exports = { funnel, calls, findDeals, sources, allowedUids };
