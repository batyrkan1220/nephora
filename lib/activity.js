// Активность менеджеров за день: все касания (звонки, разговоры, сообщения WhatsApp) на шкале времени,
// рабочее окно, активное время и перерывы (паузы без касаний дольше порога).
const C = require('./calc');
const wh = require('./warehouse');
const wz = require('./wazzup');
const DAY_FROM = 8 * 60, DAY_TO = 22 * 60, SLOT = 10; // шкала 08:00–22:00, ячейка 10 минут
function activity(ctx, allowed, cfg, day, { gap = 20, tzMin = 300 } = {}) {
  const b = cfg.boards.find(x => x.active) || cfg.boards[0];
  const data = b ? C.computeBoard(b, ctx) : { members: [], sectors: [] };
  const secName = Object.fromEntries((data.sectors || []).map(s => [s.id, s.name])), secOf = C.sectorMap(ctx);
  const nm = id => (cfg.managers[id] || {}).name || (ctx.userMap[id] || {}).name || ('ID ' + id);
  const mod = v => { const t = new Date(v).getTime(); return isNaN(t) ? null : Math.floor((t / 6e4 + tzMin) % 1440 + 1440) % 1440; };
  const ev = {}; // uid → [{m, e, k}]  m — минута дня, e — конец (для разговора), k — вид
  const add = (uid, m, e, k) => { if (m == null || !allowed.has(uid)) return; (ev[uid] = ev[uid] || []).push({ m, e: Math.max(m, e), k }); };
  for (const c of wh.all('call')) if (c.d === day && c.uid) { const m = mod(c.at); add(c.uid, m, m + Math.ceil((c.dur || 0) / 60), c.dur > 0 ? 'talk' : 'call'); }
  // WhatsApp: автор сообщения → менеджер Bitrix24 по имени
  const byName = {}; Object.keys(ctx.userMap || {}).forEach(id => { const n = String(nm(id)).toLowerCase().replace(/\s+/g, ' ').trim(); if (n) byName[n] = id; });
  const findUid = a => { const n = String(a || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (!n) return ''; if (byName[n]) return byName[n]; const f = n.split(' ')[0]; const hits = Object.keys(byName).filter(k => k.split(' ')[0] === f); return hits.length === 1 ? byName[hits[0]] : ''; };
  const dk = v => new Date(new Date(v).getTime() + tzMin * 6e4).toISOString().slice(0, 10);
  for (const x of (wz.messages ? wz.messages() : [])) if (x.dir === 'out' && x.author && dk(x.at) === day) { const u = findUid(x.author); if (u) add(u, mod(x.at), mod(x.at), 'wa'); }
  const slots = Math.ceil((DAY_TO - DAY_FROM) / SLOT), hours = Array(24).fill(0);
  const rows = Object.entries(ev).map(([uid, E]) => {
    E.sort((a, z) => a.m - z.m);
    const start = E[0].m, end = Math.max(...E.map(x => x.e)); let busyTo = start; const breaks = [];
    for (const x of E) { if (x.m - busyTo >= gap) breaks.push({ from: busyTo, to: x.m, min: x.m - busyTo }); busyTo = Math.max(busyTo, x.e); }
    const span = Math.max(1, end - start), brk = breaks.reduce((a, x) => a + x.min, 0), active = span - brk;
    const S = Array(slots).fill(0); E.forEach(x => { for (let m = x.m; m <= Math.max(x.m, x.e - 1); m += SLOT) { const i = Math.floor((m - DAY_FROM) / SLOT); if (i >= 0 && i < slots) S[i]++; } hours[Math.floor(x.m / 60)]++; });
    const talk = E.filter(x => x.k === 'talk');
    return { uid, name: nm(uid), sector: secName[secOf[uid]] || '', start, end, span, active, pct: Math.round(active / span * 100),
      breaks: breaks.map(x => ({ ...x })), brkMin: brk, longest: breaks.reduce((a, x) => Math.max(a, x.min), 0),
      calls: E.filter(x => x.k !== 'wa').length, talks: talk.length, talkMin: Math.round(talk.reduce((a, x) => a + (x.e - x.m), 0)), wa: E.filter(x => x.k === 'wa').length, slots: S };
  }).filter(r => r.calls + r.wa > 0);
  // все люди сектора: РОП и менеджеры без касаний за день тоже видны (строка «нет касаний»)
  const heads = new Set([...(ctx.deps || []).map(d => d.head).filter(Boolean), ...Object.entries(cfg.managers || {}).filter(([, m]) => m && m.rop).map(([id]) => id)]);
  const isRop = id => heads.has(id) || /\b(роп|rop)\b/i.test(nm(id));
  const have = new Set(rows.map(r => r.uid));
  for (const u of ctx.users || []) if (u.active !== false && secOf[u.id] && allowed.has(u.id) && !have.has(u.id) && !(cfg.managers[u.id] || {}).hidden)
    rows.push({ uid: u.id, name: nm(u.id), sector: secName[secOf[u.id]] || '', none: true, start: 0, end: 0, span: 0, active: 0, pct: 0, breaks: [], brkMin: 0, longest: 0, calls: 0, talks: 0, talkMin: 0, wa: 0, slots: [] });
  rows.forEach(r => { r.rop = isRop(r.uid); });
  const so = Object.fromEntries((data.sectors || []).map((x, i) => [x.name, i]));
  rows.sort((a, z) => (so[a.sector] ?? 99) - (so[z.sector] ?? 99) || (z.rop - a.rop) || (a.none - z.none) || z.active - a.active);
  const act = rows.filter(r => !r.none), n = act.length || 1;
  return { day, gap, from: DAY_FROM, to: DAY_TO, slot: SLOT, hours,
    team: { people: act.length, total: rows.length, active: Math.round(act.reduce((a, r) => a + r.active, 0) / n), brk: Math.round(act.reduce((a, r) => a + r.brkMin, 0) / n),
      pct: Math.round(act.reduce((a, r) => a + r.pct, 0) / n), calls: act.reduce((a, r) => a + r.calls, 0), talkMin: act.reduce((a, r) => a + r.talkMin, 0), wa: act.reduce((a, r) => a + r.wa, 0) },
    rows };
}
module.exports = { activity };
