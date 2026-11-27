// Записи звонков: Bitrix24/Voximplant → копия в нашей базе Supabase (таблица call_audio).
// Хранилище Voximplant (storage-gw-ru-*.voximplant.com) с Render часто не отвечает (connect timeout),
// поэтому: несколько попыток с паузой, а удачно скачанный файл сохраняем к себе — дальше отдаём из Supabase.
const store = require('./store');
const bx = require('./bitrix');
const CAP = (+process.env.REC_CACHE_MB || 600) * 1024 * 1024; // сколько места под записи (старые удаляются)
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
  await pool.query('insert into call_audio (id, type, size, audio) values ($1, $2, $3, $4) on conflict (id) do nothing', [id, a.type, a.buf.length, a.buf]);
  // держим объём в пределах лимита: удаляем самые старые
  const t = await pool.query('select coalesce(sum(size),0)::bigint s from call_audio');
  if (+t.rows[0].s > CAP) await pool.query(`delete from call_audio where id in (select id from call_audio order by created_at asc limit 50)`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
    for (let attempt = 0; attempt < 5; attempt++) {
      for (const u of urls) {
        try {
          const a = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(40e3) }); const type = a.headers.get('content-type') || '';
          if (a.ok && !/json|html/.test(type)) {
            const buf = Buffer.from(await a.arrayBuffer());
            if (buf.length > 1000) { const out = { buf, type: /mpeg|mp3|octet/.test(type) || !type ? 'audio/mpeg' : type }; toDb(id, out).catch(e => console.error('call_audio save', e.message)); return out; }
          }
          why = `HTTP ${a.status}`;
        } catch (e) { why = errOf(u, e); }
      }
      await sleep(1500 * (attempt + 1));
    }
    throw new Error('Запись звонка недоступна (' + why + '). Хранилище записей Bitrix24 не ответило — попробуйте ещё раз через минуту');
  })().finally(() => busy.delete(id));
  busy.set(id, job); return job;
}
module.exports = { get, init };
