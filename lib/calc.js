// Расчёт рейтинга: участники, план, комиссия, бонусы, зарплата.
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  tz: 'Asia/Almaty', tzOffset: '+05:00',
  dateField: 'UF_CRM_1784559416867',
  stages: ['UC_IP5X36', 'WON', 'C1:NEW', 'C1:PREPARATION', 'C1:PREPAYMENT_INVOICE', 'C1:FINAL_INVOICE', 'C1:WON'],
  syncSec: 30,
  workDays: [1, 2, 3, 4, 5, 6], // 1 = пн … 7 = вс
  holidays: [],
  company: 'Nephora',
};

const newKey = () => crypto.randomBytes(9).toString('base64url');
const newId = () => crypto.randomBytes(6).toString('hex');

function defaultBoard(name = 'Отдел продаж') {
  return {
    id: newId(), key: newKey(), name, active: true,
    auto: true, from: '', to: '',            // auto = текущий месяц
    rankBy: 'sum',                           // sum | count
    plan: 0, defaultPlan: 0,                 // план отдела, план менеджера по умолчанию
    departments: [], members: [], exclude: [], plans: {},
    commission: [],                          // [{from, to, pct}] — % от суммы сделки
    bonuses: [],                             // [{id, name, period: day|week|period, metric: sum|count, tiers: [{min, amount}]}]
    screen: {
      orientation: 'horizontal', theme: 'arena',
      cols: { today: true, sales: true, count: true, pct: true, salary: true },
      popup: true, popupSec: 8, sound: true, losers: true,
    },
  };
}

function normalize(cfg) {
  cfg = cfg || {};
  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  cfg.managers = cfg.managers || {};
  cfg.boards = (cfg.boards && cfg.boards.length ? cfg.boards : [defaultBoard('Nephora Arena')]).map(b => {
    const d = defaultBoard(b.name);
    const out = { ...d, ...b, screen: { ...d.screen, ...(b.screen || {}), cols: { ...d.screen.cols, ...((b.screen || {}).cols || {}) } } };
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
function computeBoard(board, ctx) {
  const s = ctx.settings, today = ctx.today;
  const { from, to } = periodOf(board, today);
  const inPeriod = ctx.deals.filter(d => d.dk >= from && d.dk <= to);
  const members = memberSet(board, ctx, inPeriod);
  const wd = Math.max(1, workdays(from, to, s));
  const todayWork = isWorkday(today, s);
  const byUser = {}; members.forEach(id => { byUser[id] = []; });
  inPeriod.forEach(d => { if (byUser[d.uid]) byUser[d.uid].push(d); });

  const rows = Object.entries(byUser).map(([uid, ds]) => {
    const sum = ds.reduce((a, d) => a + d.sum, 0);
    const td = ds.filter(d => d.dk === today);
    const daySum = td.reduce((a, d) => a + d.sum, 0);
    const plan = +(board.plans || {})[uid] || +board.defaultPlan || 0;
    const dayPlan = plan && todayWork ? Math.round(plan / wd) : 0;
    const comm = ds.reduce((a, d) => a + commissionOf(d.sum, board.commission), 0);
    const bon = bonusesOf(ds, board.bonuses);
    return {
      ...userInfo(uid, ctx), sum, cnt: ds.length, daySum, dayCnt: td.length,
      plan, dayPlan, planPct: plan ? sum / plan * 100 : null, dayPct: dayPlan ? daySum / dayPlan * 100 : null,
      comm, commPct: sum ? comm / sum * 100 : 0, bonus: bon.total, bonusDetail: bon.detail, salary: comm + bon.total,
      last: ds.reduce((a, d) => (d.dk > a ? d.dk : a), ''),
    };
  });
  const key = board.rankBy === 'count' ? 'cnt' : 'sum', alt = key === 'cnt' ? 'sum' : 'cnt';
  rows.sort((a, b) => b[key] - a[key] || b[alt] - a[alt] || a.name.localeCompare(b.name, 'ru'));
  rows.forEach((r, i) => { r.place = i + 1; });

  const tot = rows.reduce((t, r) => ({ sum: t.sum + r.sum, cnt: t.cnt + r.cnt, daySum: t.daySum + r.daySum, dayCnt: t.dayCnt + r.dayCnt }), { sum: 0, cnt: 0, daySum: 0, dayCnt: 0 });
  const plan = +board.plan || rows.reduce((a, r) => a + r.plan, 0);
  const dayPlan = plan && todayWork ? Math.round(plan / wd) : 0;
  const daysLeft = workdays(today, to, s);
  return {
    board: { id: board.id, name: board.name, rankBy: board.rankBy, screen: board.screen, active: board.active },
    period: { from, to, today, workdays: wd, daysLeft },
    team: { ...tot, plan, dayPlan, left: Math.max(0, plan - tot.sum), dayLeft: Math.max(0, dayPlan - tot.daySum) },
    rows, members: [...members],
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
    const comm = ds.reduce((a, d) => a + commissionOf(d.sum, b.commission), 0);
    const bon = bonusesOf(ds, b.bonuses);
    return { ...userInfo(id, ctx), cnt: ds.length, sum, avg: sum / ds.length, comm, bonus: bon.total, salary: comm + bon.total, board: b.name || '' };
  }).sort((a, b) => b.sum - a.sum);
  const days = {}; for (let k = from; k <= to && Object.keys(days).length < 400; k = addDays(k, 1)) days[k] = { sum: 0, cnt: 0 };
  deals.forEach(d => { const x = days[d.dk]; if (x) { x.sum += d.sum; x.cnt++; } });
  const t = rows.reduce((a, r) => ({ sum: a.sum + r.sum, cnt: a.cnt + r.cnt, comm: a.comm + r.comm, bonus: a.bonus + r.bonus }), { sum: 0, cnt: 0, comm: 0, bonus: 0 });
  const todayDeals = deals.filter(d => d.dk === ctx.today);
  return {
    from, to,
    totals: { ...t, avg: t.cnt ? t.sum / t.cnt : 0, salary: t.comm + t.bonus, managers: rows.length,
      todaySum: todayDeals.reduce((a, d) => a + d.sum, 0), todayCnt: todayDeals.length },
    top: rows[0] || null, rows,
    days: Object.entries(days).map(([dk, v]) => ({ dk, ...v })),
    deals: deals.map(d => ({ ...d, name: userInfo(d.uid, ctx).name })).sort((a, b) => b.dk.localeCompare(a.dk) || b.id - a.id),
  };
}

module.exports = {
  DEFAULT_SETTINGS, defaultBoard, normalize, newKey, newId,
  todayKey, monthRange, periodOf, addDays, weekStart, workdays,
  computeBoard, report, memberSet,
};
