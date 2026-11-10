// Эффективность менеджеров и касания.
// Касание = звонок по сделке: привязанный к самой сделке, к её контакту (в период жизни сделки) или к её лиду.
// Индекс эффективности 0–100: по группам (результат, конверсия, активность, скорость, качество, дисциплина),
// внутри группы — место менеджера среди коллег (перцентиль) или абсолютная оценка; веса групп задаются в настройках.
const wh = require('./warehouse');
const C = require('./calc');
const AN = require('./analytics');
const att = require('./attendance');
const cai = require('./callai');

const DAY = 864e5;
const answered = c => c.code === '200' && c.dur > 0;
const isOut = c => c.ty === 1 || c.ty === 4;
const GROUPS = [
  { key: 'result', name: 'Результат', short: 'Рез.', w: 35 },
  { key: 'conv', name: 'Конверсия и выкуп', short: 'Конв.', w: 20 },
  { key: 'activity', name: 'Активность', short: 'Актив.', w: 15 },
  { key: 'speed', name: 'Скорость реакции', short: 'Скор.', w: 10 },
  { key: 'quality', name: 'Качество разговоров', short: 'Кач.', w: 10 },
  { key: 'discipline', name: 'Дисциплина', short: 'Дисц.', w: 10 },
];
const weights = cfg => { const w = ((cfg.settings || {}).eff || {}).weights || {}; return Object.fromEntries(GROUPS.map(g => [g.key, w[g.key] == null ? g.w : Math.max(0, +w[g.key] || 0)])); };

/* ===== касания ===== */
let IXC = { key: '', ix: null };
function callIndex() {
  const st = wh.status(), key = (st.counts.call || 0) + ':' + st.lastRun;
  if (IXC.key === key && IXC.ix) return IXC.ix;
  IXC = { key, ix: buildIndex() };
  return IXC.ix;
}
function buildIndex() {
  const by = { DEAL: new Map(), CONTACT: new Map(), LEAD: new Map() };
  for (const c of wh.all('call')) {
    const m = by[c.et]; if (!m || !c.eid) continue;
    const t = new Date(c.at).getTime(); if (isNaN(t)) continue;
    let a = m.get(c.eid); if (!a) m.set(c.eid, a = []);
    a.push({ t, ok: answered(c), out: isOut(c) });
  }
  return by;
}
function touchesOf(d, IX, now) {
  const t0 = new Date(d.cr).getTime(), t1 = d.sem !== 'P' && d.mv ? new Date(d.mv).getTime() + DAY : now;
  const list = [...(IX.DEAL.get(d.id) || [])];
  if (d.contact) for (const c of IX.CONTACT.get(d.contact) || []) if (c.t >= t0 - 3600e3 && c.t <= t1) list.push(c);
  if (d.lead) for (const c of IX.LEAD.get(d.lead) || []) list.push(c);
  const seen = new Set(), u = list.filter(c => { const k = c.t + (c.ok ? 'y' : 'n'); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t);
  const odT = d.od ? new Date(d.od + 'T23:59:59+05:00').getTime() : null;
  return { n: u.length, ok: u.filter(c => c.ok).length, first: u.length ? u[0].t : null, last: u.length ? u[u.length - 1].t : null,
    beforeOrder: odT ? u.filter(c => c.t <= odT).length : null };
}
const outcome = d => d.sem === 'S' ? 'won' : d.sem === 'F' ? 'lost' : d.od ? 'order' : 'open';

function touches(ctx, scope, f, cfg) {
  const { from, to } = f, A = AN.allowedUids(ctx, scope, f), SN = AN.sectorNames(ctx), now = Date.now();
  const forgetDays = Math.max(1, +(((cfg.settings || {}).eff || {}).forgetDays) || 3);
  const IX = callIndex(), stName = f.stageNames || {};
  const deals = wh.all('deal').filter(d => d.crd >= from && d.crd <= to && A.has(d.uid));
  const by = {}, tot = { deals: 0, n: 0, ok: 0, zero: 0, orders: 0, toOrder: [], daysToOrder: [], lostLow: 0, lost: 0 };
  const byOut = { won: [], order: [], lost: [], open: [] };
  const buckets = ['0', '1', '2', '3–4', '5–7', '8+'], bIdx = n => n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : n <= 7 ? 4 : 5;
  const dist = { order: Array(6).fill(0), lost: Array(6).fill(0) };
  const row = () => ({ deals: 0, n: 0, ok: 0, zero: 0, orders: 0, toOrder: [], daysToOrder: [], lostLow: 0, lost: 0, firstMin: [] });
  for (const d of deals) {
    const x = touchesOf(d, IX, now), o = outcome(d);
    for (const r of [by[d.uid] || (by[d.uid] = row()), tot]) {
      r.deals++; r.n += x.n; r.ok += x.ok; if (!x.n) r.zero++;
      if (d.od) { r.orders++; if (x.beforeOrder != null) r.toOrder.push(x.beforeOrder); r.daysToOrder.push(Math.max(0, (new Date(d.od) - new Date(d.crd)) / DAY)); }
      if (o === 'lost') { r.lost++; if (x.ok <= 1) r.lostLow++; }
      if (r.firstMin && x.first) r.firstMin.push(Math.max(0, (x.first - new Date(d.cr).getTime()) / 6e4));
    }
    byOut[o].push(x.n);
    if (o === 'lost') dist.lost[bIdx(x.n)]++; else if (d.od) dist.order[bIdx(x.n)]++;
  }
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const fin = r => ({ deals: r.deals, avgTouches: r.deals ? r.n / r.deals : null, avgOk: r.deals ? r.ok / r.deals : null, zero: r.zero, orders: r.orders,
    touchesToOrder: avg(r.toOrder), daysToOrder: AN.median(r.daysToOrder), lost: r.lost, lostLow: r.lostLow, firstMin: r.firstMin ? AN.median(r.firstMin) : undefined });
  const managers = Object.entries(by).map(([uid, r]) => ({ uid, name: AN.name(ctx, uid), sector: SN[A.secOf[uid]] || '', ...fin(r) })).sort((a, b) => b.deals - a.deals);

  // забытые клиенты: открытые сделки (созданы за 90 дней), где давно не было касания
  const lim = now - 90 * DAY;
  const forgotten = wh.all('deal').filter(d => d.sem === 'P' && !d.od && A.has(d.uid) && new Date(d.cr).getTime() >= lim).map(d => {
    const x = touchesOf(d, IX, now), ref = x.last || new Date(d.cr).getTime();
    return { id: d.id, title: d.t, sum: d.sum, uid: d.uid, manager: AN.name(ctx, d.uid), stage: stName[d.st] || d.st, touches: x.n, last: x.last ? new Date(x.last).toISOString() : null, days: Math.floor((now - ref) / DAY), order: !!d.od };
  }).filter(x => x.days >= forgetDays).sort((a, b) => b.days - a.days);
  const fBy = {}; forgotten.forEach(x => { fBy[x.uid] = (fBy[x.uid] || 0) + 1; });
  managers.forEach(m => { m.forgotten = fBy[m.uid] || 0; });
  return { from, to, forgetDays, total: { ...fin(tot), forgotten: forgotten.length }, managers,
    byOutcome: Object.fromEntries(Object.entries(byOut).map(([k, a]) => [k, { deals: a.length, avg: avg(a) }])),
    dist: { buckets, ...dist }, forgotten: forgotten.slice(0, 150) };
}

/* ===== индекс эффективности ===== */
function workdaysIn(from, to, s) { let n = 0; for (let d = from; d <= to; d = C.addDays(d, 1)) if (C.isWorkday(d, s)) n++; return Math.max(1, n); }
// место среди коллег 0–100 (выше — лучше); lowerBetter — меньше значит лучше
function pct(vals, v, lowerBetter) {
  const a = vals.filter(x => x != null); if (v == null || !a.length) return null; if (a.length === 1) return 75;
  const below = a.filter(x => lowerBetter ? x > v : x < v).length, eq = a.filter(x => x === v).length - 1;
  return Math.round((below + eq / 2) / (a.length - 1) * 100);
}

function metrics(ctx, scope, f, cfg) {
  const { from, to } = f, A = AN.allowedUids(ctx, scope, f), SN = AN.sectorNames(ctx), s = cfg.settings;
  const today = C.todayKey(s.tz), end = to < today ? to : today, wd = workdaysIn(from, end, s);
  const stages = new Set(s.stages || []);
  const M = {}, get = uid => M[uid] || (M[uid] = { uid, cash: 0, orders: 0, created: 0, createdOrdered: 0, won: 0, lost: 0, calls: 0, out: 0, outOk: 0, talk: 0 });
  for (const d of wh.all('deal')) {
    if (!A.has(d.uid)) continue;
    if (d.od && d.od >= from && d.od <= to) { const m = get(d.uid); m.orders++; if (stages.has(d.st) || d.sem === 'S') m.cash += d.sum; if (d.sem === 'S') m.won++; else if (d.sem === 'F') m.lost++; }
    if (d.crd >= from && d.crd <= to) { const m = get(d.uid); m.created++; if (d.od) m.createdOrdered++; }
  }
  for (const c of wh.all('call')) {
    if (c.d < from || c.d > to || !A.has(c.uid)) continue;
    const m = get(c.uid); m.calls++; if (isOut(c)) { m.out++; if (answered(c)) m.outOk++; } if (answered(c)) m.talk += c.dur;
  }
  const nm = id => AN.name(ctx, id);
  const q = Object.fromEntries(cai.summary(id => A.has(id), from, to, nm).managers.map(m => [m.uid, m]));
  const disc = att.stats(cfg, from, to);
  const T = touchesM(ctx, scope, { from, to, sector: f.sector, uid: f.uid, stageNames: f.stageNames }, cfg);
  const tch = Object.fromEntries(T.managers.map(m => [m.uid, m]));
  return Object.values(M).filter(m => m.uid && (m.cash > 0 || m.calls >= 20 || m.created >= 5)).map(m => ({
    uid: m.uid, name: nm(m.uid), sector: SN[A.secOf[m.uid]] || '',
    cash: m.cash, orders: m.orders, avgCheck: m.orders ? m.cash / m.orders : null,
    created: m.created, conv: m.created >= 3 ? m.createdOrdered / m.created * 100 : null,
    vykup: m.won + m.lost >= 3 ? m.won / (m.won + m.lost) * 100 : null,
    callsDay: m.calls / wd, talkDay: m.talk / 60 / wd, reach: m.out >= 10 ? m.outOk / m.out * 100 : null,
    resp: tch[m.uid] && tch[m.uid].firstMin != null ? tch[m.uid].firstMin : null,
    ai: q[m.uid] ? q[m.uid].avg : null, aiN: q[m.uid] ? q[m.uid].reviews : 0,
    late: disc[m.uid] ? disc[m.uid].late : null, absent: disc[m.uid] ? disc[m.uid].absent : null, lateMin: disc[m.uid] ? disc[m.uid].lateMin : null,
    touchesToOrder: tch[m.uid] ? tch[m.uid].touchesToOrder : null, forgotten: tch[m.uid] ? tch[m.uid].forgotten : 0,
  }));
}

function score(rows, cfg) {
  const W = weights(cfg), col = k => rows.map(r => r[k]);
  const P = (k, lb) => r => pct(col(k), r[k], lb);
  const parts = {
    result: [[P('cash'), .7], [P('orders'), .3]],
    conv: [[P('conv'), .5], [P('vykup'), .5]],
    activity: [[P('callsDay'), .5], [P('talkDay'), .3], [P('reach'), .2]],
    speed: [[P('resp', true), 1]],
    quality: [[r => r.ai, 1]],
    discipline: [[r => r.late == null ? null : Math.max(0, 100 - r.late * 8 - r.absent * 20), 1]],
  };
  return rows.map(r => {
    const g = {};
    for (const [k, list] of Object.entries(parts)) {
      let s = 0, w = 0; for (const [fn, wt] of list) { const v = fn(r); if (v != null) { s += v * wt; w += wt; } }
      g[k] = w ? Math.round(s / w) : null;
    }
    let s = 0, w = 0; for (const k of Object.keys(g)) if (g[k] != null && W[k]) { s += g[k] * W[k]; w += W[k]; }
    const avail = Object.entries(g).filter(([k, v]) => v != null && W[k]);
    const weak = avail.sort((a, b) => a[1] - b[1])[0];
    return { ...r, groups: g, index: w ? Math.round(s / w) : null, weak: weak ? weak[0] : null };
  }).sort((a, b) => (b.index ?? -1) - (a.index ?? -1));
}

function efficiency(ctx, scope, f, cfg) {
  const rows = score(metrics(ctx, scope, f, cfg), cfg);
  const team = rows.length ? Math.round(rows.reduce((a, r) => a + (r.index || 0), 0) / rows.length) : null;
  return { from: f.from, to: f.to, groups: GROUPS.map(g => ({ ...g, w: weights(cfg)[g.key] })), team, rows };
}

// карточка менеджера: последние 3 месяца (индекс считается среди коллег за тот же месяц)
function card(ctx, scope, uid, cfg) {
  const today = C.todayKey(cfg.settings.tz), months = [];
  let m = today.slice(0, 7);
  for (let i = 0; i < 3; i++) { months.unshift(m); const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); m = d.toISOString().slice(0, 7); }
  return { uid, name: AN.name(ctx, uid), months: months.map(mo => {
    const { from, to } = C.monthRange(mo + '-01');
    const r = efficiencyM(ctx, scope, { from, to }, cfg).rows.find(x => x.uid === uid);
    return { month: mo, ...(r || {}) };
  }) };
}

const MEMO = new Map();
function memo(name, fn) {
  return (ctx, scope, f, cfg) => {
    const st = wh.status(), k = [name, st.lastRun, (st.counts.call || 0), JSON.stringify(scope && scope.sectors || null), f.from, f.to, f.sector || '', f.uid || '', JSON.stringify(cfg.settings.eff || {}), JSON.stringify(cfg.settings.stages || [])].join('|');
    const hit = MEMO.get(k); if (hit && Date.now() - hit.t < 60e3) return hit.v;
    const v = fn(ctx, scope, f, cfg); MEMO.set(k, { t: Date.now(), v });
    if (MEMO.size > 200) MEMO.delete(MEMO.keys().next().value);
    return v;
  };
}
const touchesM = memo('t', touches), efficiencyM = memo('e', efficiency);
module.exports = { GROUPS, touches: touchesM, efficiency: efficiencyM, card };
