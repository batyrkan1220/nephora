// Профиль менеджера: всё, что платформа знает о человеке — касса, сделки, звонки, AI-оценки, активность, эффективность.
const C = require('./calc');
const AN = require('./analytics');
const wh = require('./warehouse');
const cai = require('./callai');
const ACT = require('./activity');
const EF = require('./efficiency');
function profile(ctx, scope, uid, cfg, portal) {
  const today = C.todayKey(cfg.settings.tz), M = C.monthRange(today), nm = id => AN.name(ctx, id);
  const secOf = C.sectorMap(ctx), b = cfg.boards.find(x => x.active) || cfg.boards[0];
  const data = b ? C.computeBoard(b, ctx) : { rows: [], sectors: [] }, secName = Object.fromEntries((data.sectors || []).map(s => [s.id, s.name]));
  const heads = new Set([...(ctx.deps || []).map(d => d.head).filter(Boolean), ...Object.entries(cfg.managers || {}).filter(([, m]) => m && m.rop).map(([id]) => id)]);
  const u = ctx.userMap[uid] || {};
  // касса: место в компании и в секторе, продажи по дням месяца
  const rows = (data.rows || []).slice().sort((a, z) => z.sum - a.sum), me = rows.find(r => r.uid === uid) || {};
  const sec = secOf[uid], secRows = rows.filter(r => secOf[r.uid] === sec);
  const days = []; for (let d = M.from; d <= today; d = C.addDays(d, 1)) days.push({ d, sum: 0, cnt: 0 });
  const DI = Object.fromEntries(days.map((x, i) => [x.d, i]));
  (ctx.deals || []).forEach(x => { if (x.uid === uid && DI[x.dk] != null) { days[DI[x.dk]].sum += x.sum; days[DI[x.dk]].cnt++; } });
  // сделки из склада
  const all = wh.all('deal').filter(d => d.uid === uid), base = portal || '';
  const meta = {}; ((ctx.meta || {}).stages || []).forEach(s => { meta[s.id] = s.name; });
  const open = all.filter(d => d.sem === 'P'), stg = {}; open.forEach(d => { const k = meta[d.st] || d.st; stg[k] = (stg[k] || 0) + 1; });
  const mon = all.filter(d => d.crd >= M.from);
  const lastDeals = all.slice().sort((a, z) => String(z.md || z.cr).localeCompare(String(a.md || a.cr))).slice(0, 12)
    .map(d => ({ id: d.id, t: String(d.t || '').replace(/(\d{4})\d{4}(\d{2})/g, '$1****$2'), stage: meta[d.st] || d.st, sem: d.sem, sum: d.sum, at: d.md || d.cr, url: base ? `${base}/crm/deal/details/${d.id}/` : '' }));
  // звонки
  const callsM = wh.all('call').filter(c => c.uid === uid && c.d >= M.from && c.d <= today), callsT = callsM.filter(c => c.d === today);
  const cs = L => { const t = L.filter(c => c.dur > 0); return { all: L.length, out: L.filter(c => c.ty === 1 || c.ty === 4).length, talks: t.length, talkMin: Math.round(t.reduce((a, c) => a + c.dur, 0) / 60), avgSec: t.length ? Math.round(t.reduce((a, c) => a + c.dur, 0) / t.length) : 0, long: t.filter(c => c.dur >= 180).length }; };
  const perDay = {}; callsM.forEach(c => { const x = perDay[c.d] || (perDay[c.d] = { d: c.d, calls: 0, talkMin: 0 }); x.calls++; x.talkMin += (c.dur || 0) / 60; });
  // AI-оценки разговоров
  const rv = cai.recent(M.from).filter(x => x.uid === uid && !x.skip && !x.pending).sort((a, z) => String(z.at).localeCompare(String(a.at)));
  const crit = {}; rv.forEach(x => (x.criteria || []).forEach(c => { const k = c.name; (crit[k] = crit[k] || []).push(+c.score || 0); }));
  const mistakes = {}; rv.forEach(x => (x.mistakes || []).forEach(t => { const k = String(t).slice(0, 120); mistakes[k] = (mistakes[k] || 0) + 1; }));
  // активность за 7 дней
  const one = { has: id => id === uid, all: false };
  const act = []; for (let d = today, k = 0; k < 7; k++, d = C.addDays(d, -1)) { const R = ACT.activity(ctx, one, cfg, d); const r = R.rows.find(x => x.uid === uid && !x.none); act.push(r ? { d, start: r.start, end: r.end, active: r.active, brkMin: r.brkMin, breaks: r.breaks.length, pct: r.pct, calls: r.calls, slots: r.slots } : { d, none: true }); }
  // эффективность
  let eff = null; try { const e = EF.efficiency(ctx, scope, { from: M.from, to: today }, cfg); const r = e.rows.find(x => x.uid === uid); if (r) eff = { index: r.index, weak: r.weak, groups: r.groups, rank: e.rows.filter(x => x.index != null).findIndex(x => x.uid === uid) + 1, of: e.rows.filter(x => x.index != null).length }; } catch {}
  return {
    uid, name: nm(uid), sector: secName[sec] || '', rop: heads.has(uid) || /\b(роп|rop)\b/i.test(nm(uid)), position: u.position || '', month: M.from.slice(0, 7), today,
    sales: { sum: me.sum || 0, cnt: me.cnt || 0, daySum: me.daySum || 0, dayCnt: me.dayCnt || 0, rank: rows.findIndex(r => r.uid === uid) + 1 || null, of: rows.length, secRank: secRows.findIndex(r => r.uid === uid) + 1 || null, secOf: secRows.length, avg: me.cnt ? Math.round(me.sum / me.cnt) : 0, days },
    deals: { open: open.length, stages: Object.entries(stg).sort((a, z) => z[1] - a[1]).slice(0, 8), monthNew: mon.length, monthWon: mon.filter(d => d.sem === 'S').length, monthLost: mon.filter(d => d.sem === 'F').length, last: lastDeals },
    calls: { today: cs(callsT), month: cs(callsM), perDay: Object.values(perDay).sort((a, z) => a.d.localeCompare(z.d)).map(x => ({ ...x, talkMin: Math.round(x.talkMin) })) },
    reviews: { n: rv.length, avg: rv.length ? Math.round(rv.reduce((a, x) => a + x.score, 0) / rv.length) : null,
      criteria: Object.entries(crit).map(([k, v]) => ({ name: k, avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 })).sort((a, z) => a.avg - z.avg),
      mistakes: Object.entries(mistakes).sort((a, z) => z[1] - a[1]).slice(0, 6).map(([t, n]) => ({ t, n })), last: rv.slice(0, 8).map(x => ({ id: x.id, at: x.at, score: x.score, summary: x.summary, outcome: x.outcome })) },
    activity: act, eff,
  };
}
module.exports = { profile };
