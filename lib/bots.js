// «ИИ завод»: боты-сотрудники. Каждый бот проверяет свой участок по данным Bitrix24 (копия в базе)
// и ставит задачи людям. В CRM боты ничего не меняют — только находят и поручают.
//  • Звонок-бот      — пропущенные входящие без перезвона, слабые AI-оценки звонков
//  • Логистика-бот   — зависшие доставки, отказы банка, дубли «Заказ ↔ Логистика», заказы без даты/суммы
//  • Есеп-бот        — утренний отчёт руководителю (план/факт, вчера, лучшие и отстающие, открытые задачи)
const store = require('./store');

const BOTS = [
  { id: 'calls', name: 'Звонок-бот', role: 'Контроль звонков', color: '#4B4FE8' },
  { id: 'logi', name: 'Логистика-бот', role: 'Доставка и касса', color: '#F59E0B' },
  { id: 'wa', name: 'WhatsApp-бот', role: 'Потерянные обращения', color: '#25A244' },
  { id: 'report', name: 'Есеп-бот', role: 'Отчёт руководителю', color: '#16A34A' },
];
const DEF = { on: true, stuckDays: 3, lowScore: 50, missedDays: 2, reportAt: '09:00', reportPhone: '', reportChannel: '', reportSend: false };

let D = null;            // зависимости из server.js
const st = { running: false, lastRun: {}, lastError: {}, runs: 0 };
const S = () => ({ ...DEF, ...(store.get('bots:cfg') || {}) });
const tasks = () => store.get('bots:tasks') || [];
const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
const mask = t => String(t || '').replace(/(\d{4})\d{4}(\d{2})/g, '$1****$2');
const dayAgo = (n, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() - n * 864e5));

/* ===== Звонок-бот ===== */
function botCalls(s, c) {
  const out = [], tz = c.settings.tz, since = dayAgo(s.missedDays, tz);
  const calls = D.wh.all('call').filter(x => x.d >= since);
  // последний исходящий/успешный контакт по номеру
  const lastOut = {};
  calls.forEach(x => { const k = digits(x.ph); if (!k) return; if ((x.ty === 1 || x.ty === 4) || (x.ty === 2 && x.dur > 0)) lastOut[k] = Math.max(lastOut[k] || 0, +new Date(x.at)); });
  const missed = {};
  calls.forEach(x => {
    if (x.ty !== 2 || x.dur > 0) return;                         // входящий без разговора
    const k = digits(x.ph), t = +new Date(x.at); if (!k) return;
    if ((lastOut[k] || 0) > t) return;                           // уже перезвонили
    if (!missed[k] || missed[k].t < t) missed[k] = { t, x };
  });
  Object.entries(missed).forEach(([k, { t, x }]) => out.push({
    key: 'calls:missed:' + k, bot: 'calls', kind: 'Пропущенный', uid: x.uid,
    title: 'Перезвонить клиенту +7 ' + k.slice(0, 3) + ' *** ' + k.slice(-4), detail: 'Входящий без ответа ' + new Date(t).toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' — перезвона не было',
    url: x.et === 'DEAL' && x.eid ? D.deal(x.eid) : '',
  }));
  // слабые разговоры по AI-оценке за 7 дней
  const from7 = dayAgo(7, tz);
  D.cai.recent(from7).filter(r => !r.skip && r.score < s.lowScore).forEach(r => out.push({
    key: 'calls:low:' + r.id, bot: 'calls', kind: 'Слабый звонок', uid: r.uid,
    title: `Разобрать звонок: оценка ${r.score}/100`, detail: (r.mistakes || []).slice(0, 2).join('; ') || r.summary || '', url: '#/calls/rec', call: r.id,
  }));
  return out;
}

/* ===== Логистика/Касса-бот ===== */
function botLogi(s, c) {
  const out = [], tz = c.settings.tz, meta = (D.cache.meta || {}).stages || [];
  const nm = Object.fromEntries(meta.map(x => [x.id, x]));
  const isLogi = d => /логист/i.test((nm[d.st] || {}).category || '');
  const deals = D.wh.all('deal');
  const now = Date.now();
  // 1) зависшие доставки: открытая стадия логистики дольше N дней
  deals.filter(d => isLogi(d) && d.sem === 'P').forEach(d => {
    const moved = +new Date(d.mv || d.md || d.cr); const days = Math.floor((now - moved) / 864e5);
    if (days < s.stuckDays) return;
    out.push({ key: 'logi:stuck:' + d.id, bot: 'logi', kind: 'Зависла доставка', uid: d.uid, url: D.deal(d.id),
      title: `${mask(d.t) || 'Сделка #' + d.id} — ${days} дн. в «${(nm[d.st] || {}).name || d.st}»`, detail: `${Math.round(d.sum).toLocaleString('ru-RU')} ₸ · двигается медленно, уточнить статус у курьера/клиента` });
  });
  // 2) отказ банка за 3 дня — предложить другой банк или способ оплаты
  const bankIds = new Set(meta.filter(x => /банк/i.test(x.name) && !/логист/i.test(x.category)).map(x => x.id));
  const d3 = +new Date(Date.now() - 3 * 864e5);
  deals.filter(d => bankIds.has(d.st) && +new Date(d.mv || d.md) >= d3).forEach(d => out.push({
    key: 'logi:bank:' + d.id, bot: 'logi', kind: 'Отказ банка', uid: d.uid, url: D.deal(d.id),
    title: `Отказ банка: ${mask(d.t) || 'сделка #' + d.id}`, detail: `${Math.round(d.sum).toLocaleString('ru-RU')} ₸ · предложить другой банк или другой способ оплаты`,
  }));
  // 3) дубли «Общая → Заказ» ↔ Логистика (точные пары по сумме)
  try {
    const won = meta.find(x => !/логист/i.test(x.category) && x.id === 'WON') ? 'WON' : null;
    if (won) D.dupePairs(won, 'логист').pairs.filter(x => x.how !== 'client').forEach(x => out.push({
      key: 'logi:dup:' + x.src.id, bot: 'logi', kind: 'Дубль', uid: x.src.uid, url: D.deal(x.src.id), owner: true,
      title: `Дубль: сделка #${x.src.id} уже есть в Логистике (#${x.tgt.id})`, detail: `${Math.round(x.src.sum).toLocaleString('ru-RU')} ₸ считается в кассе дважды — закрыть или удалить дубль`,
    }));
  } catch {}
  // 4) заказы этого месяца в кассе без даты заказа или с нулевой суммой
  const kassa = new Set(c.settings.stages || []), m0 = dayAgo(0, tz).slice(0, 8) + '01';
  deals.filter(d => kassa.has(d.st) && (d.crd || '') >= m0 && (!d.od || !d.sum)).forEach(d => out.push({
    key: 'logi:fill:' + d.id, bot: 'logi', kind: 'Не заполнено', uid: d.uid, url: D.deal(d.id),
    title: `Заполнить ${!d.od && !d.sum ? 'дату заказа и сумму' : !d.od ? 'дату заказа' : 'сумму'}: ${mask(d.t) || '#' + d.id}`, detail: 'Без этого заказ неверно считается в кассе и зарплате',
  }));
  return out;
}

/* ===== WhatsApp-бот: клиент написал, но обращение не попало в «Новая сделка» на Админа ===== */
function botWa() {
  if (!D.waLost) return [];
  return D.waLost().map(r => ({
    key: 'wa:lost:' + r.phone + ':' + r.at, bot: 'wa', kind: r.repeat ? 'Повторный клиент' : 'Новый клиент', uid: r.lastDeal ? r.lastDeal.uid : '',
    title: `Клиент +${r.phone}${r.name ? ' (' + r.name + ')' : ''} написал в WhatsApp — не попал в работу`,
    detail: r.lostWhy + (r.ansMin == null ? ' · ответа не было' : ` · ответили через ${r.ansMin} мин`), url: r.lastDeal ? r.lastDeal.url : '',
  }));
}

/* ===== Есеп-бот: отчёт ===== */
function makeReport() {
  const c = D.ctx(), cfg = D.cfg(), b = cfg.boards.find(x => x.active) || cfg.boards[0];
  if (!b) return null;
  const tz = c.settings.tz, y = dayAgo(1, tz), data = D.C.computeBoard({ ...b, auto: true }, c);
  const mem = new Set(data.members), money = n => Math.round(n).toLocaleString('ru-RU') + ' ₸';
  const yd = {}; c.deals.filter(d => d.dk === y && mem.has(d.uid)).forEach(d => { yd[d.uid] = (yd[d.uid] || 0) + d.sum; });
  const ySum = Object.values(yd).reduce((a, v) => a + v, 0);
  const sum = data.team.sum, plan = data.team.plan || 0;
  const left = data.period.daysLeft || null;
  const yRows = data.rows.map(r => ({ name: r.name, v: yd[r.uid] || 0 })).sort((a, z) => z.v - a.v);
  const top = yRows.filter(r => r.v > 0).slice(0, 3), zero = yRows.filter(r => !r.v).map(r => r.name);
  const open = tasks().filter(t => t.status === 'open'), byBot = id => open.filter(t => t.bot === id).length;
  const L = [];
  L.push(`📊 Safa · отчёт за ${y.split('-').reverse().join('.')}`);
  L.push('');
  L.push(`Касса вчера: ${money(ySum)}`);
  L.push(`Касса месяца: ${money(sum)}${plan ? ` из ${money(plan)} (${Math.round(sum / plan * 100)}%)` : ''}`);
  if (plan && left) L.push(`Нужно в день до конца месяца: ${money(Math.max(0, plan - sum) / left)} (${left} раб. дн.)`);
  L.push('');
  L.push('Секторы (месяц):');
  data.sectors.slice().sort((a, z) => z.sum - a.sum).forEach((x, i) => L.push(`${i + 1}. ${x.name} — ${money(x.sum)}${x.plan ? ` · ${Math.round(x.sum / x.plan * 100)}% плана` : ''}`));
  if (top.length) { L.push(''); L.push('Лучшие вчера:'); top.forEach((r, i) => L.push(`${['🥇', '🥈', '🥉'][i]} ${r.name} — ${money(r.v)}`)); }
  if (zero.length) { L.push(''); L.push(`Без продаж вчера (${zero.length}): ${zero.slice(0, 8).join(', ')}${zero.length > 8 ? '…' : ''}`); }
  L.push('');
  L.push(`Задачи ботов: звонки ${byBot('calls')} · логистика/касса ${byBot('logi')} · потерянные WhatsApp ${byBot('wa')}`);
  return { day: y, text: L.join('\n'), at: Date.now() };
}

/* ===== запуск ===== */
async function runAll(force) {
  if (st.running || !D) return;
  const s = S(); if (!s.on && !force) return;
  st.running = true;
  try {
    const c = D.ctx(), found = [];
    for (const [id, fn] of [['calls', botCalls], ['logi', botLogi], ['wa', botWa]]) {
      try { found.push(...fn(s, c)); st.lastRun[id] = Date.now(); delete st.lastError[id]; }
      catch (e) { st.lastError[id] = e.message; console.error('bot', id, e.message); }
    }
    // слияние: новые задачи — открыты; исчезнувшие открытые — решены сами (ситуация исправлена)
    const cur = tasks(), byKey = new Map(cur.map(t => [t.key, t])), seen = new Set(found.map(f => f.key)), now = Date.now();
    for (const f of found) {
      const t = byKey.get(f.key);
      if (!t) byKey.set(f.key, { ...f, id: now.toString(36) + Math.random().toString(36).slice(2, 6), status: 'open', at: now });
      else if (t.status === 'open') Object.assign(t, { title: f.title, detail: f.detail, uid: f.uid, url: f.url });
    }
    for (const t of byKey.values()) if (t.status === 'open' && (t.bot === 'calls' || t.bot === 'logi' || t.bot === 'wa') && !seen.has(t.key) && st.lastRun[t.bot] && !st.lastError[t.bot]) { t.status = 'auto'; t.doneAt = now; }
    const keep = now - 30 * 864e5;
    const list = [...byKey.values()].filter(t => t.status === 'open' || (t.doneAt || t.at) >= keep).slice(-3000);
    await store.set('bots:tasks', list);
    // отчёт: раз в день после reportAt
    const tz = c.settings.tz, hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const last = store.get('bots:report');
    if (hm >= s.reportAt && (!last || last.day !== dayAgo(1, tz))) await report(s.reportSend);
    st.lastRun.report = (store.get('bots:report') || {}).at || st.lastRun.report;
    st.runs++;
  } finally { st.running = false; }
}
async function report(send) {
  const r = makeReport(); if (!r) return null;
  const s = S();
  if (send && s.reportPhone && s.reportChannel) {
    try { await D.wz.sendText(s.reportChannel, s.reportPhone, r.text); r.sent = { to: s.reportPhone, at: Date.now() }; }
    catch (e) { r.sendError = e.message; }
  }
  await store.set('bots:report', r);
  return r;
}

function init(deps) {
  D = deps;
  setTimeout(() => runAll().catch(e => console.error('bots:', e.message)), 60e3);
  setInterval(() => runAll().catch(e => console.error('bots:', e.message)), 10 * 60e3);
}
async function setCfg(x) {
  const s = S(), n = { ...s };
  if (x.on !== undefined) n.on = !!x.on;
  if (x.stuckDays !== undefined) n.stuckDays = Math.max(1, Math.min(30, +x.stuckDays || DEF.stuckDays));
  if (x.lowScore !== undefined) n.lowScore = Math.max(10, Math.min(90, +x.lowScore || DEF.lowScore));
  if (x.missedDays !== undefined) n.missedDays = Math.max(1, Math.min(7, +x.missedDays || DEF.missedDays));
  if (x.reportAt !== undefined && /^\d{2}:\d{2}$/.test(x.reportAt)) n.reportAt = x.reportAt;
  if (x.reportPhone !== undefined) { const p = String(x.reportPhone).replace(/\D/g, ''); n.reportPhone = p ? (p.length === 10 ? '7' + p : p.replace(/^8/, '7')) : ''; }
  if (x.reportChannel !== undefined) n.reportChannel = String(x.reportChannel || '');
  if (x.reportSend !== undefined) n.reportSend = !!x.reportSend;
  await store.set('bots:cfg', n); return n;
}
async function setStatus(id, status, by) {
  const list = tasks(), t = list.find(x => x.id === id); if (!t) throw new Error('Задача не найдена');
  t.status = status === 'open' ? 'open' : 'done'; t.doneAt = t.status === 'done' ? Date.now() : undefined; t.doneBy = t.status === 'done' ? by : undefined;
  await store.set('bots:tasks', list); return t;
}
function view(allowed, isOwner) {
  const list = tasks().filter(t => isOwner || (!t.owner && allowed(t.uid)));
  return { bots: BOTS.map(b => ({ ...b, open: list.filter(t => t.bot === b.id && t.status === 'open').length, last: st.lastRun[b.id] || null, error: st.lastError[b.id] || null })),
    tasks: list.sort((a, z) => (a.status === 'open' ? 0 : 1) - (z.status === 'open' ? 0 : 1) || z.at - a.at).slice(0, 600),
    report: isOwner ? store.get('bots:report') || null : null, settings: isOwner ? S() : null, running: st.running };
}
module.exports = { _t: { botCalls, botLogi, setD: d => { D = d; } }, BOTS, init, runAll, report, makeReport, setCfg, setStatus, view, settings: S };
