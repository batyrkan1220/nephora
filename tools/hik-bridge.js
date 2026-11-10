#!/usr/bin/env node
// Safa · мост Hikvision → платформа.
// Запускается на любом компьютере в офисе (в той же сети, что и терминал). Каждые 20 секунд забирает
// события прохода из терминала (ISAPI /AccessControl/AcsEvent, Digest-авторизация) и отправляет их в Safa.
// Нужен Node.js 18+ (https://nodejs.org). Запуск:
//   HIK_HOST=192.168.1.64 HIK_USER=admin HIK_PASS=пароль node hik-bridge.js
// Windows (cmd):  set HIK_HOST=192.168.1.64 && set HIK_USER=admin && set HIK_PASS=пароль && node hik-bridge.js
// Необязательно: HIK_TZ=+05:00 (часовой пояс терминала), BACKFILL_DAYS=1 (сколько дней истории загрузить при первом запуске).
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const SAFA_URL = process.env.SAFA_URL || '';
const HOST = (process.env.HIK_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const PROTO = /^https:/.test(process.env.HIK_HOST || '') ? 'https' : 'http';
const USER = process.env.HIK_USER || 'admin', PASS = process.env.HIK_PASS || '';
const TZ = process.env.HIK_TZ || '+05:00';
const EVERY = Math.max(10, +process.env.EVERY_SEC || 20) * 1000;
const STATE = path.join(__dirname, 'hik-bridge.state.json');

if (!SAFA_URL || !HOST || !PASS) {
  console.error('Укажите HIK_HOST (IP терминала), HIK_USER, HIK_PASS' + (SAFA_URL ? '' : ' и SAFA_URL') + '. Пример:\n  HIK_HOST=192.168.1.64 HIK_USER=admin HIK_PASS=пароль node hik-bridge.js');
  process.exit(1);
}

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
let digest = null, nc = 0;
// HTTP Digest (так авторизуется ISAPI)
async function isapi(method, uri, body) {
  const url = `${PROTO}://${HOST}${uri}`;
  const headers = { 'Content-Type': 'application/json' };
  const auth = () => {
    if (!digest) return;
    const cnonce = crypto.randomBytes(8).toString('hex'), n = (++nc).toString(16).padStart(8, '0');
    const ha1 = md5(`${USER}:${digest.realm}:${PASS}`), ha2 = md5(`${method}:${uri}`);
    const resp = digest.qop ? md5(`${ha1}:${digest.nonce}:${n}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${digest.nonce}:${ha2}`);
    headers.Authorization = `Digest username="${USER}", realm="${digest.realm}", nonce="${digest.nonce}", uri="${uri}", response="${resp}"` +
      (digest.qop ? `, qop=auth, nc=${n}, cnonce="${cnonce}"` : '') + (digest.opaque ? `, opaque="${digest.opaque}"` : '');
  };
  for (let i = 0; i < 2; i++) {
    auth();
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && i === 0) {
      const h = r.headers.get('www-authenticate') || '';
      const g = k => (h.match(new RegExp(k + '="?([^",]+)"?')) || [])[1];
      digest = { realm: g('realm'), nonce: g('nonce'), opaque: g('opaque'), qop: /qop="?[^"]*auth/.test(h) }; nc = 0;
      continue;
    }
    const t = await r.text();
    if (!r.ok) throw new Error(`ISAPI ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  }
  throw new Error('ISAPI: неверный логин или пароль терминала');
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => { // локальное время терминала в формате ISAPI
  const o = (TZ[0] === '-' ? -1 : 1) * (+TZ.slice(1, 3) * 60 + +TZ.slice(4, 6));
  const x = new Date(d.getTime() + o * 6e4);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}${TZ}`;
};

// все события прохода (major 5) за интервал; если терминал не принимает minor 0 — спрашиваем лицо/отпечаток/карту
async function fetchEvents(from, to) {
  const out = [];
  const run = async minor => {
    const id = crypto.randomBytes(6).toString('hex');
    for (let pos = 0, g = 0; g < 500; g++) {
      const j = await isapi('POST', '/ISAPI/AccessControl/AcsEvent?format=json', { AcsEventCond: {
        searchID: id, searchResultPosition: pos, maxResults: 10, major: 5, minor, startTime: stamp(from), endTime: stamp(to) } });
      const a = j.AcsEvent || {}, list = a.InfoList || [];
      out.push(...list);
      pos += list.length;
      if (a.responseStatusStrg !== 'MORE' || !list.length) break;
    }
  };
  try { await run(0); } catch (e) { for (const m of [75, 38, 1, 39, 76]) await run(m).catch(() => {}); }
  return out.filter(e => e.employeeNoString && e.employeeNoString !== '0')
    .map(e => ({ emp: String(e.employeeNoString), name: e.name || '', time: e.time }));
}

let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
async function tick() {
  const now = new Date();
  const since = st.since ? new Date(st.since) : new Date(now.getTime() - (+process.env.BACKFILL_DAYS || 1) * 864e5);
  const from = new Date(since.getTime() - 5 * 6e4); // перекрытие 5 минут — сервер сам убирает дубли
  const events = await fetchEvents(from, now);
  if (events.length) {
    const r = await fetch(SAFA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'safa-hik-bridge' }, body: JSON.stringify({ events }) });
    if (!r.ok) throw new Error('Safa ответил ' + r.status + ': ' + (await r.text()).slice(0, 200));
  }
  st.since = now.toISOString(); fs.writeFileSync(STATE, JSON.stringify(st));
  console.log(new Date().toLocaleTimeString(), `событий: ${events.length}`);
}
(async function loop() {
  try { await tick(); } catch (e) { console.error(new Date().toLocaleTimeString(), 'ошибка:', e.message); }
  setTimeout(loop, EVERY);
})();
