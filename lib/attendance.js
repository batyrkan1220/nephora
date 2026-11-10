// Посещаемость: события Hikvision (DS-K1T343M и др. терминалы доступа) → приход/уход, опоздания, авто-штрафы.
// Источники событий:
//  1) терминал сам шлёт события (ISAPI «HTTP Listening» / event_log, multipart или JSON/XML) на /api/att/<token>
//  2) мост tools/hik-bridge.js в офисе опрашивает /ISAPI/AccessControl/AcsEvent и шлёт JSON {events:[{emp,name,time}]}
// Хранение (store): att:m:YYYY-MM → { emp: { 'YYYY-MM-DD': ['HH:MM', 'HH:MM'] } }, att:people → { emp: {name, first, last} },
// att:dismissed → { id: true } (снятые вручную авто-штрафы), att:token, att:status.
const crypto = require('crypto');
const store = require('./store');
const C = require('./calc');

const DEF = { start: '10:00', grace: 0, lateUntil: '13:00', autoLate: true, autoAbsent: false, map: {} };
const S = cfg => ({ ...DEF, ...((cfg.settings || {}).att || {}), map: { ...(((cfg.settings || {}).att || {}).map || {}) } });
let ver = 0, memo = { key: '', list: [] };

function token() {
  let t = store.get('att:token');
  if (!t) { t = crypto.randomBytes(12).toString('hex'); store.set('att:token', t); }
  return t;
}
async function newToken() { const t = crypto.randomBytes(12).toString('hex'); await store.set('att:token', t); return t; }

/* ===== разбор входящих событий ===== */
const pick = (s, tag) => { const m = String(s).match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>')); return m ? m[1] : ''; };
function fromObj(o) {
  if (!o || typeof o !== 'object') return null;
  const e = o.AccessControllerEvent || o;
  const emp = String(e.employeeNoString || e.employeeNo || e.emp || '').trim();
  const time = o.dateTime || e.time || o.time || '';
  if (!emp || emp === '0' || !time) return null;
  return { emp, name: String(e.name || o.name || '').trim(), time, mode: e.currentVerifyMode || '', status: e.attendanceStatus || '' };
}
// тело запроса терминала: JSON, multipart (часть event_log + картинка) или XML EventNotificationAlert
function parse(body, type) {
  const out = [];
  const tryJson = s => { try { const j = JSON.parse(s); (Array.isArray(j.events) ? j.events : [j]).forEach(x => { const e = fromObj(x); if (e) out.push(e); }); return true; } catch { return false; } };
  const txt = String(body || '');
  if (tryJson(txt.trim())) return out;
  const b = (String(type || '').match(/boundary="?([^";]+)"?/) || [])[1];
  const parts = b ? txt.split('--' + b) : [txt];
  for (const p of parts) {
    const i = p.indexOf('\r\n\r\n'), c = (i >= 0 ? p.slice(i + 4) : p).trim();
    if (!c) continue;
    if (c[0] === '{' && tryJson(c)) continue;
    const j = c.indexOf('{'), k = c.lastIndexOf('}');
    if (j >= 0 && k > j && /employeeNo|AccessControllerEvent/.test(c) && tryJson(c.slice(j, k + 1))) continue;
    if (/<employeeNoString>|<employeeNo>/.test(c)) {
      const e = fromObj({ dateTime: pick(c, 'dateTime'), AccessControllerEvent: { employeeNoString: pick(c, 'employeeNoString') || pick(c, 'employeeNo'), name: pick(c, 'name'), currentVerifyMode: pick(c, 'currentVerifyMode') } });
      if (e) out.push(e);
    }
  }
  return out;
}

// время события → локальная дата и HH:MM (в поясе компании)
function local(time, tz) {
  const s = String(time);
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s); if (isNaN(d)) return null;
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const g = t => (f.find(x => x.type === t) || {}).value;
    return { day: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
  }
  const m = s.match(/^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)/);
  return m ? { day: m[1], hm: m[2] } : null;
}

async function ingest(events, cfg, from) {
  const tz = cfg.settings.tz, months = {}, people = { ...(store.get('att:people') || {}) };
  let n = 0;
  for (const e of events) {
    const t = local(e.time, tz); if (!t) continue;
    const mk = 'att:m:' + t.day.slice(0, 7);
    const M = months[mk] || (months[mk] = JSON.parse(JSON.stringify(store.get(mk) || {})));
    const P = M[e.emp] || (M[e.emp] = {});
    const r = P[t.day];
    if (!r) P[t.day] = [t.hm, t.hm];
    else { if (t.hm < r[0]) r[0] = t.hm; if (t.hm > r[1]) r[1] = t.hm; }
    const pp = people[e.emp] || (people[e.emp] = { name: '', first: t.day, last: '' });
    if (e.name) pp.name = e.name;
    if (t.day < pp.first) pp.first = t.day;
    const at = t.day + ' ' + t.hm; if (at > (pp.last || '')) pp.last = at;
    n++;
  }
  for (const [k, v] of Object.entries(months)) await store.set(k, v);
  if (n) await store.set('att:people', people);
  const st = store.get('att:status') || { total: 0 };
  await store.set('att:status', { total: (st.total || 0) + n, lastAt: Date.now(), lastFrom: from || '', lastCount: n });
  ver++;
  return n;
}

/* ===== расчёт ===== */
const mins = hm => { const [h, m] = String(hm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const rec = (emp, day) => ((store.get('att:m:' + day.slice(0, 7)) || {})[emp] || {})[day] || null;

// статус дня менеджера: off (выходной) | none (нет данных/до подключения) | ok | late | absent | wait (сегодня, ещё не пришёл)
function dayStatus(emp, day, cfg, today) {
  const A = S(cfg), s = cfg.settings, r = rec(emp, day);
  const work = C.isWorkday ? C.isWorkday(day, s) : true;
  const first = ((store.get('att:people') || {})[emp] || {}).first;
  if (r) {
    const late = mins(r[0]) - mins(A.start) - (+A.grace || 0);
    const st = mins(r[0]) > mins(A.lateUntil) ? 'absent' : late > 0 ? 'late' : 'ok';
    return { st: work ? st : 'extra', in: r[0], out: r[1] !== r[0] ? r[1] : '', lateMin: work && late > 0 ? late + (+A.grace || 0) : 0, hours: (mins(r[1]) - mins(r[0])) / 60 };
  }
  if (!work) return { st: 'off' };
  if (!first || day < first) return { st: 'none' };
  if (day === today) return { st: mins(nowHM(s.tz)) > mins(A.lateUntil) ? 'absent' : 'wait' };
  return day < today ? { st: 'absent' } : { st: 'none' };
}
const nowHM = tz => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

// авто-штрафы по данным терминала (не хранятся в cfg.penalties — считаются на лету; снятые вручную — в att:dismissed)
function penalties(cfg) {
  const A = S(cfg), today = C.todayKey(cfg.settings.tz);
  if (!A.autoLate && !A.autoAbsent) return [];
  const key = [ver, today, nowHM(cfg.settings.tz).slice(0, 4), JSON.stringify(A), JSON.stringify(cfg.settings.penalty), JSON.stringify(cfg.settings.workDays), JSON.stringify(cfg.settings.holidays || []), JSON.stringify(store.get('att:dismissed') || {})].join('|');
  if (memo.key === key) return memo.list;
  const people = store.get('att:people') || {}, dis = store.get('att:dismissed') || {}, out = [];
  const amt = cfg.settings.penalty || {};
  for (const [emp, uid] of Object.entries(A.map)) {
    if (!uid || !people[emp]) continue;
    for (let d = people[emp].first; d <= today; d = C.addDays(d, 1)) {
      const x = dayStatus(emp, d, cfg, today), id = `att-${uid}-${d}`;
      if (dis[id]) continue;
      if (x.st === 'late' && A.autoLate) out.push({ id, uid, date: d, kind: 'late', amount: +amt.late || 0, note: `Терминал: пришёл ${x.in} (+${x.lateMin} мин)`, auto: true });
      if (x.st === 'absent' && A.autoAbsent && (x.in || d < today)) out.push({ id, uid, date: d, kind: 'absent', amount: +amt.absent || 0, note: x.in ? `Терминал: пришёл ${x.in} (после ${A.lateUntil})` : 'Терминал: не пришёл', auto: true });
    }
  }
  memo = { key, list: out };
  return out;
}
async function dismiss(id, on) {
  const d = { ...(store.get('att:dismissed') || {}) };
  if (on) d[id] = true; else delete d[id];
  await store.set('att:dismissed', d); ver++;
}

// отчёт: день (rows) или месяц (матрица) по сопоставленным менеджерам
function report(cfg, { date, month }, allowed) {
  const A = S(cfg), today = C.todayKey(cfg.settings.tz), people = store.get('att:people') || {};
  const dis = store.get('att:dismissed') || {}, pen = Object.fromEntries(penalties(cfg).map(p => [p.id, p]));
  const pairs = Object.entries(A.map).filter(([emp, uid]) => uid && allowed(uid));
  const one = (emp, uid, d) => { const x = dayStatus(emp, d, cfg, today), id = `att-${uid}-${d}`; return { ...x, pen: pen[id] ? pen[id].amount : 0, penId: pen[id] || dis[id] ? id : '', dismissed: !!dis[id] }; };
  if (month) {
    const { from, to } = C.monthRange(month + '-01'), days = [];
    for (let d = from; d <= to; d = C.addDays(d, 1)) days.push(d);
    const rows = pairs.map(([emp, uid]) => {
      const cells = days.map(d => one(emp, uid, d));
      const c = k => cells.filter(x => x.st === k).length;
      return { emp, uid, cells, ok: c('ok'), late: c('late'), absent: c('absent'), lateMin: cells.reduce((a, x) => a + (x.lateMin || 0), 0), pen: cells.reduce((a, x) => a + x.pen, 0), hours: cells.reduce((a, x) => a + (x.hours || 0), 0) };
    });
    return { month, days, rows, today };
  }
  const d = date || today;
  return { date: d, today, work: C.isWorkday(d, cfg.settings), rows: pairs.map(([emp, uid]) => ({ emp, uid, ...one(emp, uid, d) })) };
}

function setup(cfg) {
  const A = S(cfg), people = store.get('att:people') || {};
  return { token: token(), status: store.get('att:status') || null, settings: A,
    people: Object.entries(people).map(([emp, p]) => ({ emp, ...p, uid: A.map[emp] || '' })).sort((a, b) => (b.last || '').localeCompare(a.last || '')) };
}
const touch = () => { ver++; };

module.exports = { DEF, parse, ingest, penalties, dismiss, report, setup, token, newToken, touch, local };
