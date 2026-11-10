// Расчёт рейтинга: участники, план, комиссия, бонусы, зарплата.
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  tz: 'Asia/Almaty', tzOffset: '+05:00',
  dateField: 'UF_CRM_1784559416867',
  stages: ['UC_IP5X36', 'WON', 'C1:NEW', 'C1:PREPARATION', 'C1:PREPAYMENT_INVOICE', 'C1:FINAL_INVOICE', 'C1:WON'],
  syncSec: 30,
  whDays: 120, whSyncSec: 120,
  penalty: { late: 3000, absent: 10000 },
  workDays: [1, 2, 3, 4, 5, 6], // 1 = пн … 7 = вс
  holidays: [],
  company: 'Safa',
};

// «Условия менеджера отдела продаж» (лист от руководителя)
const SALES_PRESET = {
  commissionMode: 'total',
  commission: [
    { from: 0, to: 500000, pct: 10, premium: 0 },
    { from: 500000, to: 800000, pct: 12, premium: 0 },
    { from: 800000, to: 1500000, pct: 14, premium: 10000 },   // элит
    { from: 1500000, to: 1800000, pct: 15, premium: 20000 },
    { from: 1800000, to: 2500000, pct: 15, premium: 30000 },
    { from: 2500000, to: '', pct: 15, premium: 40000 },
  ],
  eliteFrom: 800000,
  bonuses: [{ id: 'daily', name: 'Ежедневная премия', period: 'day', metric: 'sum', tiers: [
    { min: 200000, amount: 2000 }, { min: 300000, amount: 3000 }, { min: 400000, amount: 4000 }, { min: 500000, amount: 5000 },
    { min: 600000, amount: 7000 }, { min: 700000, amount: 9000 }, { min: 800000, amount: 10000 }] }],
};
const PENALTY_KINDS = { late: 'Опоздание', absent: 'Пропуск без предупреждения', other: 'Другое' };

const newKey = () => crypto.randomBytes(9).toString('base64url');
const newId = () => crypto.randomBytes(6).toString('hex');

function defaultBoard(name = 'Отдел продаж') {
  return {
    id: newId(), key: newKey(), name, active: true,
    auto: true, from: '', to: '',            // auto = текущий месяц
    rankBy: 'sum',                           // sum | count
    sectorPlans: {},                         // { id сектора (отдел 1-го уровня в Bitrix24): план за период }
    departments: [], members: [], exclude: [],
    commissionMode: 'total',                 // total — % от кассы за период по сетке; deal — % от каждой сделки
    commission: [],                          // [{from, to, pct, premium}]
    eliteFrom: 0,                            // с какой кассы менеджер «Элит» (0 — нет)
    bonuses: [],                             // [{id, name, period: day|week|period, metric: sum|count, tiers: [{min, amount}]}]
    screen: {
      orientation: 'horizontal', theme: 'arena',
      cols: { today: true, sales: true, count: true, pct: true, salary: true },
      popup: true, popupSec: 8, sound: true, topN: 10,
    },
  };
}

function normalize(cfg) {
  cfg = cfg || {};
  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  cfg.managers = cfg.managers || {};
  cfg.penalties = cfg.penalties || [];
  cfg.settings.penalty = { ...DEFAULT_SETTINGS.penalty, ...(cfg.settings.penalty || {}) };
  cfg.boards = (cfg.boards && cfg.boards.length ? cfg.boards : [defaultBoard('Safa')]).map(b => {
    const d = defaultBoard(b.name);
    const out = { ...d, ...b, sectorPlans: { ...(b.sectorPlans || {}) }, screen: { ...d.screen, ...(b.screen || {}), cols: { ...d.screen.cols, ...((b.screen || {}).cols || {}) } } };
    if (!out.id) out.id = newId();
    if (!out.key) out.key = newKey();
    return out;
  });
  return cfg;
}

/* ===== даты (ключи YYYY-MM-DD) ===== */
const toDate = k => new Date(k + 'T00:00:00Z');
const fromDate = d => d.toISOString().slice(0, 10);
const addDays = (k, n) => { const d = toDate(k); d.setUTCDate(d.getUTCDate() + n); return fromDate(d); };
const weekday = k => toDate(k).getUTCDay() || 7;
const weekStart = k => addDays(k, 1 - weekday(k));
function todayKey(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function monthRange(k) {
  const from = k.slice(0, 8) + '01';
  const d = toDate(from); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  return { from, to: fromDate(d) };
}
function periodOf(board, today) {
  if (board.auto || !board.from || !board.to) return monthRange(today);
  return { from: board.from, to: board.to };
}
function isWorkday(k, s) { return s.workDays.includes(weekday(k)) && !(s.holidays || []).includes(k); }
function workdays(from, to, s) {
  let n = 0; for (let k = from; k <= to; k = addDays(k, 1)) if (isWorkday(k, s)) n++;
  return n;
}

/* ===== участники ===== */
function subtree(deps, ids) {
  const kids = {}; deps.forEach(d => { (kids[d.parent] = kids[d.parent] || []).push(d.id); });
  const out = new Set(); const walk = id => { if (out.has(id)) return; out.add(id); (kids[id] || []).forEach(walk); };
  ids.map(String).forEach(walk); return out;
}
function memberSet(board, ctx, dealsInPeriod) {
  const set = new Set();
  const hasDeps = board.departments && board.departments.length;
  if (hasDeps) {
    const allowed = subtree(ctx.deps, board.departments);
    ctx.users.forEach(u => { if (u.active && u.deps.some(d => allowed.has(d))) set.add(u.id); });
  }
  (board.members || []).forEach(id => set.add(String(id)));
  if (!hasDeps && !(board.members || []).length) dealsInPeriod.forEach(d => set.add(d.uid));
  (board.exclude || []).forEach(id => set.delete(String(id)));
  for (const id of [...set]) if ((ctx.managers[id] || {}).hidden) set.delete(id);
  return set;
}

/* ===== деньги ===== */
function commissionOf(sum, tiers) {
  for (const t of tiers || []) {
    const from = +t.from || 0, to = t.to === '' || t.to == null ? Infinity : +t.to;
    if (sum >= from && sum < to) return sum * (+t.pct || 0) / 100;
  }
  return 0;
}
function bonusFor(value, tiers) {
  let best = 0;
  for (const t of tiers || []) if (value >= (+t.min || 0) && (+t.amount || 0) > best) best = +t.amount;
  return best;
}
function bonusesOf(deals, defs) {
  let total = 0; const detail = [];
  for (const b of defs || []) {
    const groups = {};
    for (const d of deals) {
      const g = b.period === 'day' ? d.dk : b.period === 'week' ? weekStart(d.dk) : 'p';
      const x = groups[g] || (groups[g] = { sum: 0, count: 0 }); x.sum += d.sum; x.count++;
    }
    let s = 0; for (const g in groups) s += bonusFor(b.metric === 'count' ? groups[g].count : groups[g].sum, b.tiers);
    if (s) detail.push({ name: b.name, amount: s });
    total += s;
  }
  return { total, detail };
}

function tierOf(sum, tiers) {
  for (const t of tiers || []) {
    const from = +t.from || 0, to = t.to === '' || t.to == null ? Infinity : +t.to;
    if (sum >= from && sum < to) return t;
  }
  return null;
}
// Зарплата менеджера за период: % по сетке (+ премия уровня) + бонусы − штрафы
function salaryOf(uid, ds, board, ctx, from, to) {
  const sum = ds.reduce((a, d) => a + d.sum, 0);
  let comm = 0, premium = 0, pct = 0, next = null;
  const tiers = board.commission || [];
  if (board.commissionMode === 'deal') {
    comm = ds.reduce((a, d) => a + commissionOf(d.sum, tiers), 0);
    pct = sum ? comm / sum * 100 : 0;
  } else {
    const t = tierOf(sum, tiers);
    pct = t ? +t.pct || 0 : 0; comm = sum * pct / 100; premium = t ? +t.premium || 0 : 0;
    const up = tiers.filter(x => (+x.from || 0) > sum && ((+x.pct || 0) > pct || (+x.premium || 0) > premium))
      .sort((a, b) => (+a.from || 0) - (+b.from || 0))[0];
    if (up) next = { pct: +up.pct || 0, premium: +up.premium || 0, left: (+up.from || 0) - sum };
  }
  const bon = bonusesOf(ds, board.bonuses);
  const pens = (ctx.penalties || []).filter(p => p.uid === uid && p.date >= from && p.date <= to);
  const pen = pens.reduce((a, p) => a + (+p.amount || 0), 0);
  const elite = +board.eliteFrom > 0 && sum >= +board.eliteFrom;
  return { comm, commPct: pct, premium, bonus: bon.total, bonusDetail: bon.detail, pen, penCount: pens.length,
    salary: comm + premium + bon.total - pen, elite, next };
}

function userInfo(uid, ctx) {
  const u = ctx.userMap[uid] || { id: uid, name: 'ID ' + uid, photo: '', deps: [] };
  const m = ctx.managers[uid] || {};
  const depName = Object.fromEntries(ctx.deps.map(d => [d.id, d.name]));
  return {
    uid, name: m.name || u.name,
    photo: ctx.photos[uid] ? `/photo/${uid}?v=${ctx.photos[uid]}` : (u.photo || ''),
    dep: m.category || u.deps.map(d => depName[d]).filter(Boolean)[0] || '',
  };
}

/* ===== доска ===== */
/* ===== секторы: отделы 1-го уровня под корневым отделом Bitrix24 ===== */
function sectorsOf(deps) {
  const root = deps.find(d => !d.parent);
  return root ? deps.filter(d => d.parent === root.id) : [];
}
function sectorMap(ctx) {
  const sec = new Set(sectorsOf(ctx.deps).map(d => d.id));
  const parent = Object.fromEntries(ctx.deps.map(d => [d.id, d.parent]));
  const up = id => { for (let k = id, n = 0; k && n < 50; k = parent[k], n++) if (sec.has(k)) return k; return ''; };
  const out = {};
  for (const u of ctx.users) for (const d of u.deps) { const sid = up(d); if (sid) { out[u.id] = sid; break; } }
  return out;
}

/* ===== доска: топ-N менеджеров + планы секторов (план компании = сумма секторов) ===== */
function computeBoard(board, ctx) {
  const s = ctx.settings, today = ctx.today;
  const { from, to } = periodOf(board, today);
  const inPeriod = ctx.deals.filter(d => d.dk >= from && d.dk <= to);
  const members = memberSet(board, ctx, inPeriod);
  const wd = Math.max(1, workdays(from, to, s));
  const todayWork = isWorkday(today, s);
  const dayShare = p => (p && todayWork ? Math.round(p / wd) : 0);
  const byUser = {}; members.forEach(id => { byUser[id] = []; });
  inPeriod.forEach(d => { if (byUser[d.uid]) byUser[d.uid].push(d); });
  const secOf = sectorMap(ctx);
  const secName = Object.fromEntries(ctx.deps.map(d => [d.id, d.name]));

  const all = Object.entries(byUser).map(([uid, ds]) => {
    const sum = ds.reduce((a, d) => a + d.sum, 0);
    const td = ds.filter(d => d.dk === today);
    const info = userInfo(uid, ctx);
    return {
      ...info, dep: (ctx.managers[uid] || {}).category || secName[secOf[uid]] || info.dep, sector: secOf[uid] || '', sectorName: secName[secOf[uid]] || '',
      sum, cnt: ds.length, daySum: td.reduce((a, d) => a + d.sum, 0), dayCnt: td.length,
      ...salaryOf(uid, ds, board, ctx, from, to),
    };
  });
  const key = board.rankBy === 'count' ? 'cnt' : 'sum', alt = key === 'cnt' ? 'sum' : 'cnt';
  all.sort((a, b) => b[key] - a[key] || b[alt] - a[alt] || a.name.localeCompare(b.name, 'ru'));
  all.forEach((r, i) => { r.place = i + 1; });
  const topN = Math.max(3, +(board.screen || {}).topN || 10);

  // секторы: факт — по всем сотрудникам сектора на доске, план — из настроек доски
  const plans = board.sectorPlans || {};
  const sectors = sectorsOf(ctx.deps).map(sec => {
    const rs = all.filter(r => r.sector === sec.id);
    const plan = +plans[sec.id] || 0;
    const sum = rs.reduce((a, r) => a + r.sum, 0), daySum = rs.reduce((a, r) => a + r.daySum, 0);
    return { id: sec.id, name: sec.name, plan, dayPlan: dayShare(plan), sum, daySum, cnt: rs.reduce((a, r) => a + r.cnt, 0), managers: rs.length };
  }).filter(x => x.plan > 0 || x.sum > 0);

  const tot = all.reduce((t, r) => ({ sum: t.sum + r.sum, cnt: t.cnt + r.cnt, daySum: t.daySum + r.daySum, dayCnt: t.dayCnt + r.dayCnt }), { sum: 0, cnt: 0, daySum: 0, dayCnt: 0 });
  const plan = sectors.reduce((a, x) => a + x.plan, 0);
  const dayPlan = dayShare(plan);
  return {
    board: { id: board.id, name: board.name, rankBy: board.rankBy, screen: board.screen, active: board.active },
    period: { from, to, today, workdays: wd, daysLeft: workdays(today, to, s) },
    team: { ...tot, plan, dayPlan, left: Math.max(0, plan - tot.sum), dayLeft: Math.max(0, dayPlan - tot.daySum), managers: all.length },
    sectors, rows: all, topN, members: [...members], _all: all,
    // последние продажи сегодня (по ID сделки — чем больше, тем позже) — для бегущей строки
    recent: inPeriod.filter(d => d.dk === today && members.has(d.uid)).sort((a, b) => +b.id - +a.id).slice(0, 15)
      .map(d => { const r = all.find(x => x.uid === d.uid) || {}; return { name: r.name || '', dep: r.dep || '', sum: d.sum }; }),
  };
}

/* ===== отчёт для кабинета ===== */
function report(cfg, ctx, { from, to, boardId, uid }) {
  const boards = cfg.boards.filter(b => !boardId || b.id === boardId);
  // для каждого менеджера — правила первой доски, в которой он участвует
  const ruleOf = {};
  let deals = ctx.deals.filter(d => d.dk >= from && d.dk <= to);
  if (boardId) {
    const b = boards[0]; if (!b) return null;
    const m = memberSet(b, ctx, deals); deals = deals.filter(d => m.has(d.uid)); m.forEach(id => { ruleOf[id] = b; });
  } else {
    for (const b of cfg.boards) memberSet(b, ctx, deals).forEach(id => { if (!ruleOf[id]) ruleOf[id] = b; });
    deals = deals.filter(d => !(ctx.managers[d.uid] || {}).hidden);
  }
  if (uid) deals = deals.filter(d => d.uid === uid);
  const by = {};
  deals.forEach(d => { (by[d.uid] = by[d.uid] || []).push(d); });
  const rows = Object.entries(by).map(([id, ds]) => {
    const b = ruleOf[id] || {};
    const sum = ds.reduce((a, d) => a + d.sum, 0);
    const sal = salaryOf(id, ds, b, ctx, from, to);
    return { ...userInfo(id, ctx), cnt: ds.length, sum, avg: ds.length ? sum / ds.length : 0, ...sal, board: b.name || '' };
  }).sort((a, b) => b.sum - a.sum);
  const days = {}; for (let k = from; k <= to && Object.keys(days).length < 400; k = addDays(k, 1)) days[k] = { sum: 0, cnt: 0 };
  deals.forEach(d => { const x = days[d.dk]; if (x) { x.sum += d.sum; x.cnt++; } });
  const t = rows.reduce((a, r) => ({ sum: a.sum + r.sum, cnt: a.cnt + r.cnt, comm: a.comm + r.comm, bonus: a.bonus + r.bonus,
    premium: a.premium + r.premium, pen: a.pen + r.pen, salary: a.salary + r.salary }),
    { sum: 0, cnt: 0, comm: 0, bonus: 0, premium: 0, pen: 0, salary: 0 });
  const todayDeals = deals.filter(d => d.dk === ctx.today);
  return {
    from, to,
    totals: { ...t, avg: t.cnt ? t.sum / t.cnt : 0, managers: rows.length,
      todaySum: todayDeals.reduce((a, d) => a + d.sum, 0), todayCnt: todayDeals.length },
    top: rows[0] || null, rows,
    days: Object.entries(days).map(([dk, v]) => ({ dk, ...v })),
    deals: deals.map(d => ({ ...d, name: userInfo(d.uid, ctx).name })).sort((a, b) => b.dk.localeCompare(a.dk) || b.id - a.id),
  };
}

/* ===== выплаты по неделям (зарплата еженедельно) =====
   Выплата недели = начислено на конец недели − начислено на конец прошлой недели.
   Так переход на более высокий % сетки автоматически доплачивается в той неделе, где он случился. */
function payouts(cfg, ctx, { month, boardId }) {
  const b = cfg.boards.find(x => x.id === boardId) || cfg.boards[0];
  if (!b) return null;
  const from = month + '-01', to = monthRange(from).to;
  const inMonth = ctx.deals.filter(d => d.dk >= from && d.dk <= to);
  const members = [...memberSet(b, ctx, inMonth)];
  const weeks = [];
  for (let s = from; s <= to;) {
    const e0 = addDays(weekStart(s), 6), e = e0 > to ? to : e0;
    weeks.push({ from: s, to: e }); s = addDays(e, 1);
  }
  const rows = members.map(uid => {
    const ds = inMonth.filter(d => d.uid === uid);
    let prev = 0;
    const w = weeks.map(wk => {
      const acc = salaryOf(uid, ds.filter(d => d.dk <= wk.to), b, ctx, from, wk.to);
      const sum = ds.filter(d => d.dk >= wk.from && d.dk <= wk.to).reduce((a, d) => a + d.sum, 0);
      const pay = acc.salary - prev; prev = acc.salary;
      return { sum, pay, acc: acc.salary, pct: acc.commPct };
    });
    const total = salaryOf(uid, ds, b, ctx, from, to);
    return { ...userInfo(uid, ctx), sum: ds.reduce((a, d) => a + d.sum, 0), weeks: w, ...total };
  }).sort((a, x) => x.sum - a.sum);
  return { board: { id: b.id, name: b.name }, from, to, weeks, rows };
}

module.exports = {
  DEFAULT_SETTINGS, defaultBoard, normalize, newKey, newId,
  todayKey, monthRange, periodOf, addDays, weekStart, workdays,
  computeBoard, report, memberSet, payouts, sectorsOf, sectorMap, SALES_PRESET, PENALTY_KINDS,
};
