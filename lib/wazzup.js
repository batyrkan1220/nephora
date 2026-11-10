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
    if (x.type === 'missing_call') x.dir = 'in';
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
  await store.set('wz:cfg', { ...(store.get('wz:cfg') || {}), hookUrl, connectedAt: Date.now() });
  st.error = '';
  return status();
}
function status() {
  const c = store.get('wz:cfg') || {}, k = key();
  return { connected: !!(k && c.hookUrl), key: k ? '••••' + k.slice(-4) : '', env: !!process.env.WAZZUP_API_KEY, hookUrl: c.hookUrl || '', connectedAt: c.connectedAt || 0,
    channels: Object.entries(CH).map(([id, x]) => ({ id, ...x })), messages: st.total, lastAt: st.lastAt, error: st.error };
}
const channelName = id => { const c = CH[id]; if (!c) return ''; const t = { whatsapp: 'WhatsApp', wapi: 'WhatsApp API', instagram: 'Instagram', tgapi: 'Telegram', telegram: 'Telegram Bot', vk: 'VK', avito: 'Avito' }[c.transport] || c.transport;
  const p = digits(c.plainId); return t + (p.length >= 10 ? ' +' + p.replace(/^(\d)(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5') : c.plainId ? ' ' + c.plainId : ''); };

/* ===== индексы для касаний и скорости ответа ===== */
let IX = { key: '', byChat: new Map() };
function byChat() {
  const k = MSG.size + ':' + st.lastAt; if (IX.key === k) return IX.byChat;
  const m = new Map();
  for (const x of MSG.values()) { if (!x.chat) continue; let a = m.get(x.chat); if (!a) m.set(x.chat, a = []); a.push({ t: new Date(x.at).getTime(), dir: x.dir, author: x.author, aid: x.aid }); }
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

const count = () => st.total + ':' + st.lastAt;
module.exports = { count, init, ingest, connect, refreshChannels, status, token, channelName, touchesFor, phoneOf, report, chats: byChat };
