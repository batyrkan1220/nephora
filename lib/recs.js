// Записи звонков: Bitrix24/Voximplant → копия в нашей базе Supabase (таблица call_audio).
// Хранилище Voximplant (storage-gw-ru-*.voximplant.com) с Render часто не отвечает (connect timeout),
// поэтому: несколько попыток с паузой, а удачно скачанный файл сохраняем к себе — дальше отдаём из Supabase.
const store = require('./store');
const bx = require('./bitrix');
const CAP = (+process.env.REC_CACHE_MB || 300) * 1024 * 1024; // сколько места под записи в базе (старые удаляются); поднять — переменной REC_CACHE_MB в Render
let ready = false;
async function init() {
  const pool = store.pool(); if (!pool || ready) return pool;
  await pool.query(`create table if not exists call_audio (id text primary key, type text, size int, audio bytea not null, created_at timestamptz not null default now())`);
  ready = true; return pool;
}
async function fromDb(id) {
  const pool = await init(); if (!pool) return null;
  const r = await pool.query('select type, audio from call_audio where id = $1', [id]);
  return r.rows[0] ? { buf: r.rows[0].audio, type: r.rows[0].type || 'audio/mpeg', cached: true } : null;
}
async function toDb(id, a) {
  const pool = await init(); if (!pool) return;
  await pool.query('insert into call_audio (id, type, size, audio) values ($1, $2, $3, $4) on conflict (id) do nothing', [id, a.type, a.buf.length, a.buf]); HAVE.add(id);
  // держим объём в пределах лимита: удаляем самые старые
  const t = await pool.query('select coalesce(sum(size),0)::bigint s from call_audio');
  if (+t.rows[0].s > CAP) { const d = await pool.query(`delete from call_audio where id in (select id from call_audio order by created_at asc limit 50) returning id`); d.rows.forEach(r => HAVE.delete(r.id)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// сжатие разговора: моно 16 кГц, Opus 12 кбит/с (~90 КБ на минуту вместо ~300) — голос звучит так же разборчиво
function squeeze(a) {
  return new Promise(res => {
    try {
      const p = require('child_process').spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '12k', '-application', 'voip', '-f', 'webm', 'pipe:1']);
      const out = []; p.stdout.on('data', d => out.push(d)); p.on('error', () => res(a));
      p.on('close', code => { const b = Buffer.concat(out); res(code === 0 && b.length > 500 ? { buf: b, type: 'audio/webm' } : a); });
      p.stdin.on('error', () => {}); p.stdin.end(a.buf);
    } catch { res(a); }
  });
}
const errOf = (u, e) => `${new URL(u).hostname}: ${(e.cause && (e.cause.code || e.cause.message)) || e.message}`;
async function urlsOf(id) {
  const r = await bx.call('voximplant.statistic.get', { FILTER: { CALL_ID: id } });
  const raw = (r.result || [])[0] || {}, urls = []; let why = '';
  if (raw.RECORD_FILE_ID) {
    try { const f = await bx.call('disk.file.get', { id: raw.RECORD_FILE_ID }); if (f.result && f.result.DOWNLOAD_URL) urls.push(f.result.DOWNLOAD_URL); }
    catch (e) { why = /insufficient|scope|access/i.test(e.message) ? 'у вебхука Bitrix24 нет права «Диск» (disk)' : e.message; }
  }
  if (raw.CALL_RECORD_URL) urls.push(raw.CALL_RECORD_URL);
  return { urls, why };
}
const busy = new Map();
// запись целиком: сначала из нашей базы, иначе из Bitrix24 (до 5 попыток) и сразу сохраняем
async function get(id) {
  const c = await fromDb(id).catch(() => null); if (c) return c;
  if (busy.has(id)) return busy.get(id);
  const job = (async () => {
    const { urls, why: w0 } = await urlsOf(id); let why = w0;
    if (!urls.length) throw new Error(why || 'У звонка нет записи');
    // хранилище Voximplant часто «молчит» при подключении: шлём несколько запросов внахлёст, берём первый удачный
    const one = async u => {
      const a = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30e3) }); const type = a.headers.get('content-type') || '';
      if (!a.ok || /json|html/.test(type)) throw new Error(`HTTP ${a.status}`);
      const buf = Buffer.from(await a.arrayBuffer()); if (buf.length <= 1000) throw new Error('пустой файл');
      return { buf, type: /mpeg|mp3|octet/.test(type) || !type ? 'audio/mpeg' : type };
    };
    for (let round = 0; round < 3; round++) {
      const tries = [];
      urls.forEach((u, k) => { for (let i = 0; i < 3; i++) tries.push(sleep((i * 1200) + k * 300).then(() => one(u)).catch(e => { why = errOf(u, e); throw e; })); });
      try { const raw = await Promise.any(tries); const out = await squeeze(raw); await toDb(id, out).catch(e => console.error('call_audio save', e.message)); return out; } catch {}
      await sleep(1000);
    }
    throw new Error('Запись звонка недоступна (' + why + '). Хранилище записей Bitrix24 не ответило — попробуйте ещё раз через минуту');
  })().finally(() => busy.delete(id));
  busy.set(id, job); return job;
}

/* фоновый архив: каждые 2 минуты забираем новые записи (разговоры от 40 с за сегодня и вчера) в базу — «Слушать» играет сразу */
const HAVE = new Set(); let haveLoaded = false, running = false;
async function archive(calls, today, yesterday) {
  if (running) return; running = true;
  try {
    const pool = await init(); if (!pool) return;
    if (!haveLoaded) { (await pool.query('select id from call_audio')).rows.forEach(r => HAVE.add(r.id)); haveLoaded = true; }
    const todo = calls.filter(c => c.rec && c.dur >= 40 && (c.d === today || c.d === yesterday) && !HAVE.has(c.id)).sort((a, z) => String(z.at).localeCompare(String(a.at))).slice(0, 30);
    for (let i = 0; i < todo.length; i += 2) await Promise.all(todo.slice(i, i + 2).map(c => get(c.id).then(() => HAVE.add(c.id)).catch(() => {})));
  } finally { running = false; }
}
module.exports = { get, init, archive, has: id => HAVE.has(id) };
