// Wazzup (WhatsApp/Instagram/Telegram): каналы, вебхуки сообщений, скорость ответа в мессенджере.
// API v3: https://api.wazzup24.com/v3 · авторизация Bearer <API-ключ из «Интеграции → API»>.
// Вебхук: PATCH /v3/webhooks { webhooksUri, subscriptions:{ messagesAndStatuses:true } } → POST на наш адрес с { messages:[…] } / { statuses:[…] } / { test:true }.
// Хранение: Postgres-таблица wa_msgs (в памяти — последние 120 дней), без Postgres — store 'wa:msgs'.
const crypto = require('crypto');
const store = require('./store');

const BASE = () => (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com').replace(/\/$/, '') + '/v3';
const KEEP = 120 * 864e5;
const MSG = new Map();        // messageId → { id, ch, chat, dir:'in'|'out', at, author, aid, type, ct }
let CH = {};                  // channelId → { transport, plainId, state }
const st = { lastAt: 0, total: 0, error: '' };

const key = () => process.env.WAZZUP_API_KEY || (store.get('wz:cfg') || {}).key || '';
function token() { let t = (store.get('wz:cfg') || {}).token; if (!t) { t = crypto.randomBytes(12).toString('hex'); store.set('wz:cfg', { ...(store.get('wz:cfg') || {}), token: t }); } return t; }

async function api(method, path, body) {
  const r = await fetch(BASE() + path, { method, headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`Wazzup ${path}: ${r.status} ${typeof j === 'object' ? (j.description || j.error || JSON.stringify(j)).slice(0, 200) : String(j).slice(0, 200)}`);
  return j;
}

/* ===== хранение ===== */
async function init() {
  const pool = store.pool(); const since = new Date(Date.now() - KEEP).toISOString();
  if (pool) {
    await pool.query(`create table if not exists wa_msgs (id text primary key, at timestamptz not null, data jsonb not null)`);
    await pool.query(`create index if not exists wa_msgs_at on wa_msgs (at)`);
    const r = await pool.query('select data from wa_msgs where at >= $1', [since]);
    r.rows.forEach(x => MSG.set(x.data.id, x.data));
  } else (store.get('wa:msgs') || []).forEach(m => { if (m.at >= since) MSG.set(m.id, m); });
  CH = (store.get('wz:cfg') || {}).channels || {};
  st.total = MSG.size; for (const m of MSG.values()) { const t = new Date(m.at).getTime(); if (t > st.lastAt) st.lastAt = t; }
  console.log('wazzup: loaded', MSG.size, 'messages');
}
async function persist(rows) {
  const pool = store.pool();
  if (pool) {
    if (rows.length) await pool.query(`insert into wa_msgs (id, at, data) select x->>'id', (x->>'at')::timestamptz, x from jsonb_array_elements($1::jsonb) x
      on conflict (id) do update set data = excluded.data`, [JSON.stringify(rows)]);
  } else await store.set('wa:msgs', [...MSG.values()].slice(-20000));
}

/* ===== приём вебхука ===== */
const iso = v => { if (!v) return new Date().toISOString(); const s = String(v); const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z'); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };
const digits = s => String(s || '').replace(/\D/g, '');
async function ingest(body) {
  const rows = [];
  for (const m of body.messages || []) {
    if (!m || !m.messageId || m.isDeleted) continue;
    if (m.chatType === 'whatsgroup') continue;              // групповые чаты не считаем
    const inbound = m.status === 'inbound' || (m.isEcho === false && !['sent', 'delivered', 'read', 'error'].includes(m.status));
    const x = { id: m.messageId, ch: m.channelId || '', chat: m.chatType === 'whatsapp' || m.chatType === 'viber' ? digits(m.chatId) : String(m.chatId || ''),
      ct: m.chatType || '', dir: inbound ? 'in' : 'out', at: iso(m.dateTime), type: m.type || 'text',
      author: inbound ? '' : (m.authorName || ''), aid: inbound ? '' : String(m.authorId || ''), name: inbound && m.contact ? String(m.contact.name || '').slice(0, 80) : '' };
    // пропущенный звонок: входящий — только если звонил клиент (isEcho=false); звонок менеджера клиенту — исходящий
    const old = MSG.get(x.id);
    if (old) { if (!x.author && old.author) x.author = old.author; if (!x.aid && old.aid) x.aid = old.aid; }
    MSG.set(x.id, x); rows.push(x);
  }
  if (rows.length) { await persist(rows); st.lastAt = Date.now(); st.total = MSG.size; }
  // чистим старое из памяти
  if (Math.random() < 0.02) { const lim = new Date(Date.now() - KEEP).toISOString(); for (const [k, v] of MSG) if (v.at < lim) MSG.delete(k); }
  return rows.length;
}

/* ===== подключение ===== */
async function refreshChannels() {
  const list = await api('GET', '/channels');
  CH = Object.fromEntries((Array.isArray(list) ? list : []).map(c => [c.channelId, { transport: c.transport, plainId: c.plainId || '', state: c.state || '' }]));
  await store.set('wz:cfg', { ...(store.get('wz:cfg') || {}), channels: CH });
  return CH;
}
async function connect(newKey, hookUrl) {
  const cfg = { ...(store.get('wz:cfg') || {}) };
  if (newKey) cfg.key = String(newKey).trim();
  await store.set('wz:cfg', cfg);
  await refreshChannels();
  await api('PATCH', '/webhooks', { webhooksUri: hookUrl, subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: false } });
  await store.set('wz:cfg', { ...(store.get('wz:cfg') || {}), hookUrl, connectedAt: Date.now(), keyFp: fp(key()) });
  st.error = '';
  return status();
}
function status() {
  const c = store.get('wz:cfg') || {}, k = key();
  return { connected: !!(k && c.hookUrl), key: k ? '••••' + k.slice(-4) : '', env: !!process.env.WAZZUP_API_KEY, hookUrl: c.hookUrl || '', connectedAt: c.connectedAt || 0,
    channels: Object.entries(CH).map(([id, x]) => ({ id, ...x })), messages: st.total, lastAt: st.lastAt, error: st.error, backfill: { ...BF } };
}
const channelName = id => { const c = CH[id]; if (!c) return ''; const t = { whatsapp: 'WhatsApp', wapi: 'WhatsApp API', instagram: 'Instagram', tgapi: 'Telegram', telegram: 'Telegram Bot', vk: 'VK', avito: 'Avito' }[c.transport] || c.transport;
  const p = digits(c.plainId); return t + (p.length >= 10 ? ' +' + p.replace(/^(\d)(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5') : c.plainId ? ' ' + c.plainId : ''); };

/* ===== индексы для касаний и скорости ответа ===== */
let IX = { key: '', byChat: new Map() };
function byChat() {
  const k = MSG.size + ':' + st.lastAt; if (IX.key === k) return IX.byChat;
  const m = new Map();
  for (const x of MSG.values()) { if (!x.chat) continue; let a = m.get(x.chat); if (!a) m.set(x.chat, a = []); a.push({ t: new Date(x.at).getTime(), dir: x.type === 'missing_call' && (x.author || x.aid) ? 'out' : x.dir, author: x.author, aid: x.aid, ch: x.ch, name: x.name, type: x.type }); }
  for (const a of m.values()) a.sort((p, q) => p.t - q.t);
  IX = { key: k, byChat: m }; return m;
}
// номер телефона из сделки: «Сделка по обращению в WhatsApp (77051406041)» → 77051406041
const phoneOf = title => { const m = String(title || '').match(/(?:\+?7|8)\d{10}/); return m ? '7' + digits(m[0]).slice(-10) : ''; };
// исходящие сообщения по сделке в окне [t0, t1] — как касания
function touchesFor(title, t0, t1) {
  const ph = phoneOf(title); if (!ph) return [];
  return (byChat().get(ph) || []).filter(x => x.dir === 'out' && x.t >= t0 && x.t <= t1).map(x => ({ t: x.t, ok: true, wa: true }));
}

/* ===== отчёт: скорость ответа в мессенджере ===== */
function report(from, to, tz, nameOf, uidByName, allowed) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Almaty' });
  const day = t => fmt.format(new Date(t));
  const chats = byChat(), dialogs = [], by = {}, CHS = {};
  for (const [chat, list] of chats) {
    // диалог = входящее после ≥24 ч тишины (или первое) — считаем время до первого ответа менеджера
    let i = 0;
    while (i < list.length) {
      const x = list[i];
      if (x.dir !== 'in' || (i > 0 && x.t - list[i - 1].t < 24 * 3600e3)) { i++; continue; }
      const d = day(x.t); if (d < from || d > to) { i++; continue; }
      const ans = list.slice(i + 1).find(y => y.dir === 'out');
      const uid = ans ? (ans.aid && nameOf(ans.aid) ? ans.aid : uidByName(ans.author)) : '';
      if (uid && !allowed(uid)) { i++; continue; }
      dialogs.push({ chat, at: x.t, ans: ans ? ans.t : null, min: ans ? (ans.t - x.t) / 6e4 : null, uid, author: ans ? ans.author : '' });
      i++;
    }
  }
  const out = [...MSG.values()].filter(m => m.dir === 'out' && day(new Date(m.at).getTime()) >= from && day(new Date(m.at).getTime()) <= to);
  for (const m of out) { const uid = m.aid && nameOf(m.aid) ? m.aid : uidByName(m.author); if (uid && !allowed(uid)) continue; const k = uid || ('n:' + m.author); const r = by[k] || (by[k] = { uid, name: uid ? nameOf(uid) : (m.author || 'Без автора'), sent: 0, chats: new Set(), mins: [], dialogs: 0, noAns: 0 }); r.sent++; r.chats.add(m.chat); }
  for (const dg of dialogs) { if (!dg.uid && !dg.author) continue; const k = dg.uid || ('n:' + dg.author); const r = by[k] || (by[k] = { uid: dg.uid, name: dg.uid ? nameOf(dg.uid) : dg.author, sent: 0, chats: new Set(), mins: [], dialogs: 0, noAns: 0 }); r.dialogs++; if (dg.min != null) r.mins.push(dg.min); }
  for (const m of MSG.values()) { if (m.dir !== 'in') continue; const t = new Date(m.at).getTime(), d = day(t); if (d < from || d > to) continue; CHS[m.ch] = (CHS[m.ch] || 0) + 1; }
  const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const answered = dialogs.filter(x => x.min != null), now = Date.now();
  const waiting = dialogs.filter(x => x.min == null).map(x => ({ chat: x.chat, at: new Date(x.at).toISOString(), waitMin: Math.round((now - x.at) / 6e4) })).sort((a, b) => b.waitMin - a.waitMin);
  return {
    from, to, connected: status().connected,
    total: { dialogs: dialogs.length, answered: answered.length, waiting: waiting.length, medianMin: med(answered.map(x => x.min)), within5: answered.filter(x => x.min <= 5).length, within15: answered.filter(x => x.min <= 15).length, sent: out.length },
    managers: Object.values(by).map(r => ({ uid: r.uid, name: r.name, sent: r.sent, chats: r.chats.size, dialogs: r.dialogs, medianMin: med(r.mins), within15: r.mins.filter(x => x <= 15).length })).sort((a, b) => b.sent - a.sent),
    channels: Object.entries(CHS).map(([id, n]) => ({ id, name: channelName(id) || id, inbound: n })).sort((a, b) => b.inbound - a.inbound),
    waiting: waiting.slice(0, 60),
  };
}

// лиды: обращение = входящее после ≥24 ч тишины (или самое первое). Повтор по WhatsApp — номер уже писал раньше.
function leads(from, to, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Almaty' }), day = t => fmt.format(new Date(t));
  const out = [];
  for (const [chat, list] of byChat()) {
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      if (x.dir !== 'in' || (i > 0 && x.t - list[i - 1].t < 24 * 3600e3)) continue;
      const d = day(x.t); if (d < from || d > to) continue;
      const before = list.slice(0, i).filter(y => y.dir === 'in');
      const ans = list.slice(i + 1).find(y => y.dir === 'out');
      const msgs = list.slice(i).filter(y => y.dir === 'in' && y.t - x.t < 24 * 3600e3).length;
      out.push({ phone: chat, at: x.t, day: d, ch: x.ch, chName: channelName(x.ch) || x.ch || '—', name: (list.slice(i).find(y => y.name) || list.find(y => y.name) || {}).name || '',
        waBefore: before.length ? before[before.length - 1].t : null, firstWa: list[0].t, msgs, missedCall: x.type === 'missing_call',
        ansMin: ans ? Math.round((ans.t - x.t) / 6e4) : null, ansBy: ans ? (ans.author || '') : '', ansAid: ans ? ans.aid : '' });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
const historyFrom = () => { let m = Infinity; for (const x of MSG.values()) { const t = new Date(x.at).getTime(); if (t < m) m = t; } return m === Infinity ? null : m; };
const count = () => st.total + ':' + st.lastAt;
// отправка текста в WhatsApp через канал Wazzup (используется Есеп-ботом, только если владелец включил отправку)
async function sendText(channelId, phone, text) {
  if (!key()) throw new Error('Wazzup не подключён');
  return api('POST', '/message', { channelId, chatType: 'whatsapp', chatId: String(phone).replace(/\D/g, ''), text: String(text).slice(0, 9000) });
}

/* ===== автоподключение по ключу из Render (WAZZUP_API_KEY) ===== */
const fp = k => k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 16) : '';
// при старте: если ключ в окружении новый (или вебхук не зарегистрирован) — подключаемся сами и подтягиваем историю
async function autoConnect(baseUrl) {
  const k = process.env.WAZZUP_API_KEY; if (!k) return null;
  const c = store.get('wz:cfg') || {}, base = (baseUrl || (c.hookUrl || '').replace(/\/api\/wz\/.*$/, '')).replace(/\/$/, '');
  if (!base) return null;
  const hook = `${base}/api/wz/${token()}`;
  if (c.keyFp === fp(k) && c.hookUrl === hook) { refreshChannels().catch(e => { st.error = e.message; }); return null; }
  try {
    await connect('', hook);
    await store.set('wz:cfg', { ...(store.get('wz:cfg') || {}), keyFp: fp(k) });
    console.log('wazzup: auto-connected with WAZZUP_API_KEY →', hook);
    const since = st.lastAt ? st.lastAt - 3600e3 : Date.now() - 60 * 864e5;
    backfill(since).catch(e => console.error('wazzup backfill', e.message));
  } catch (e) { st.error = e.message; console.error('wazzup auto-connect', e.message); }
}

/* ===== история: выгрузка сообщений за период (POST /v2/messages/messages_dump → CSV) ===== */
const BF = { state: '', from: 0, to: 0, added: 0, error: '', at: 0, cols: [] };
function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  const d = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
    if (ch === '"') q = true; else if (ch === d) { row.push(f); f = ''; } else if (ch === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9а-я]/g, '');
const pick = (H, ...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return -1; };
async function backfill(fromMs, toMs) {
  if (!key()) throw new Error('Wazzup не подключён');
  if (BF.state === 'running') return BF;
  Object.assign(BF, { state: 'running', from: fromMs, to: toMs || Date.now(), added: 0, error: '', at: Date.now() });
  try {
    const host = (process.env.WAZZUP_TECH_URL || 'https://tech.wazzup24.com').replace(/\/$/, '');
    const H = { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json' };
    const r = await fetch(host + '/v2/messages/messages_dump', { method: 'POST', headers: H, body: JSON.stringify({ start_at: new Date(BF.from).toISOString(), end_at: new Date(BF.to).toISOString() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.data || !j.data.export_id) throw new Error(`выгрузка истории: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    let url = null;
    for (let i = 0; i < 120 && !url; i++) {           // ждём до ~20 минут
      await new Promise(z => setTimeout(z, 10e3));
      const s = await (await fetch(host + '/v2/messages/messages_dump/' + j.data.export_id, { headers: H })).json().catch(() => ({}));
      if (s.data && s.data.url) url = s.data.url;
    }
    if (!url) throw new Error('выгрузка истории не готова за 20 минут');
    const rows = parseCSV(await (await fetch(url)).text());
    const head = rows.shift().map(norm); BF.cols = head;
    const I = { id: pick(head, 'messageid', 'id'), ch: pick(head, 'channelid', 'channel'), chat: pick(head, 'chatid', 'phone', 'chat'), ct: pick(head, 'chattype', 'transport'),
      at: pick(head, 'datetime', 'createdat', 'date', 'sentat', 'time'), status: pick(head, 'status', 'direction'), echo: pick(head, 'isecho', 'echo', 'outgoing', 'fromme'),
      author: pick(head, 'authorname', 'author', 'manager', 'user'), aid: pick(head, 'authorid', 'userid'), type: pick(head, 'type', 'messagetype'), name: pick(head, 'contactname', 'name', 'clientname'), text: pick(head, 'text', 'message', 'body') };
    const g = (r, k) => I[k] >= 0 ? r[I[k]] || '' : '';
    const msgs = rows.map(r => {
      const st_ = g(r, 'status').toLowerCase(), echo = g(r, 'echo').toLowerCase();
      const inbound = /inbound|incoming|^in$|входящ/.test(st_) || (echo !== '' && /^(false|0|no|нет)$/.test(echo));
      const id = g(r, 'id') || crypto.createHash('md5').update([g(r, 'chat'), g(r, 'at'), g(r, 'text'), g(r, 'status')].join('|')).digest('hex');
      return { messageId: id, channelId: g(r, 'ch'), chatId: g(r, 'chat'), chatType: g(r, 'ct') || 'whatsapp', dateTime: g(r, 'at'), type: g(r, 'type') || 'text',
        status: inbound ? 'inbound' : 'sent', isEcho: !inbound, authorName: inbound ? '' : g(r, 'author'), authorId: inbound ? '' : g(r, 'aid'), contact: inbound ? { name: g(r, 'name') } : undefined };
    }).filter(m => m.chatId && m.dateTime);
    for (let i = 0; i < msgs.length; i += 500) BF.added += await ingest({ messages: msgs.slice(i, i + 500) });
    BF.state = 'done'; console.log('wazzup backfill: +', BF.added, 'cols', head.join(','));
  } catch (e) { BF.state = 'error'; BF.error = e.message; console.error('wazzup backfill', e.message); }
  return BF;
}
const backfillStatus = () => ({ ...BF });
module.exports = { autoConnect, backfill, backfillStatus, leads, historyFrom, sendText, count, init, ingest, connect, refreshChannels, status, token, channelName, touchesFor, phoneOf, report, chats: byChat };
