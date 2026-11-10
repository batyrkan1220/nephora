// AI-разбор звонков: запись из Bitrix24 → расшифровка (ElevenLabs Scribe или OpenAI) → оценка Claude по критериям.
// Работает в фоне для новых звонков (после включения) и по кнопке для любого звонка с записью.
// Хранение: Postgres-таблица call_ai (data — оценка, tr — расшифровка); без Postgres — store 'cai:all'.
const store = require('./store');
const bx = require('./bitrix');
const wh = require('./warehouse');
const ai = require('./ai');

const DEF_CRITERIA = [
  'Приветствие и представление (имя, компания, цель звонка)',
  'Выявление потребностей (открытые вопросы, слушает клиента)',
  'Презентация продукта под потребность клиента',
  'Работа с возражениями',
  'Закрытие: оформление заказа или договорённость о следующем шаге',
  'Тон, вежливость, уверенность, грамотная речь',
  'Следование скрипту компании',
];
const DEF = { on: false, minSec: 40, perDay: 300, lang: 'ru', criteria: DEF_CRITERIA, script: '' };
let cfgRef = null;
const S = () => ({ ...DEF, ...(((cfgRef || {}).settings || {}).callai || {}) });
const RES = new Map();
const st = { running: false, today: '', doneToday: 0, errors: 0, lastError: '', lastAt: 0, fails: {}, busy: new Set() };

/* ===== хранение ===== */
async function init() {
  const pool = store.pool();
  if (pool) {
    await pool.query(`create table if not exists call_ai (id text primary key, d text, data jsonb not null, tr jsonb, updated_at timestamptz not null default now())`);
    const r = await pool.query('select id, data from call_ai');
    r.rows.forEach(x => RES.set(x.id, x.data));
  } else Object.entries(store.get('cai:all') || {}).forEach(([id, v]) => { const { tr, ...d } = v; RES.set(id, d); });
  console.log('callai: loaded', RES.size, 'reviews');
}
async function save(id, data, tr) {
  RES.set(id, data);
  const pool = store.pool();
  if (pool) return pool.query(`insert into call_ai (id, d, data, tr, updated_at) values ($1, $2, $3, $4, now())
    on conflict (id) do update set d = excluded.d, data = excluded.data, tr = excluded.tr, updated_at = now()`, [id, data.d || '', JSON.stringify(data), tr ? JSON.stringify(tr) : null]);
  const all = { ...(store.get('cai:all') || {}) }; all[id] = { ...data, tr }; await store.set('cai:all', all);
}
async function transcript(id) {
  const pool = store.pool();
  if (pool) { const r = await pool.query('select tr from call_ai where id = $1', [id]); return r.rows[0] ? r.rows[0].tr : null; }
  return ((store.get('cai:all') || {})[id] || {}).tr || null;
}

/* ===== ключи (env или сохранённые владельцем) ===== */
const keys = () => { const k = store.get('cai:keys') || {}; return { eleven: process.env.ELEVENLABS_API_KEY || k.eleven || '', openai: process.env.OPENAI_API_KEY || k.openai || '' }; };
async function setKeys({ eleven, openai }) {
  const k = { ...(store.get('cai:keys') || {}) };
  if (typeof eleven === 'string') k.eleven = eleven.trim();
  if (typeof openai === 'string') k.openai = openai.trim();
  await store.set('cai:keys', k);
}
const ready = () => { const k = keys(); return { stt: k.eleven ? 'elevenlabs' : k.openai ? 'openai' : '', claude: ai.configured() }; };

/* ===== запись и расшифровка ===== */
async function audioOf(id) {
  const r = await bx.call('voximplant.statistic.get', { FILTER: { CALL_ID: id } });
  const raw = (r.result || [])[0] || {};
  const urls = [];
  if (raw.CALL_RECORD_URL) urls.push(raw.CALL_RECORD_URL);
  if (raw.RECORD_FILE_ID) { try { const f = await bx.call('disk.file.get', { id: raw.RECORD_FILE_ID }); if (f.result && f.result.DOWNLOAD_URL) urls.push(f.result.DOWNLOAD_URL); } catch {} }
  for (const u of urls) {
    const a = await fetch(u); const type = a.headers.get('content-type') || '';
    if (a.ok && !/json|html/.test(type)) { const buf = Buffer.from(await a.arrayBuffer()); if (buf.length > 1000) return { buf, type: /mpeg|mp3|octet/.test(type) || !type ? 'audio/mpeg' : type }; }
  }
  throw new Error('Запись звонка недоступна в Bitrix24');
}
// склеиваем подряд идущие реплики одного говорящего
function merge(parts) {
  const out = [];
  for (const p of parts) {
    const t = String(p.t || '').trim(); if (!t) continue;
    const last = out[out.length - 1];
    if (last && last.sp === p.sp) last.t += ' ' + t; else out.push({ sp: p.sp, t, s: Math.round(p.s || 0) });
  }
  return out;
}
async function sttEleven(a, key) {
  const fd = new FormData();
  fd.append('file', new Blob([a.buf], { type: a.type }), 'call.mp3');
  fd.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v2');
  fd.append('diarize', 'true'); fd.append('num_speakers', '2'); fd.append('tag_audio_events', 'false'); fd.append('timestamps_granularity', 'word');
  const r = await fetch((process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io') + '/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('ElevenLabs: ' + ((j.detail && (j.detail.message || j.detail)) || 'HTTP ' + r.status));
  const sp = {}, lab = id => sp[id] || (sp[id] = String.fromCharCode(65 + Object.keys(sp).length));
  const words = (j.words || []).filter(w => w.type !== 'audio_event');
  const parts = words.length ? words.map(w => ({ sp: lab(w.speaker_id || 'x'), t: w.text, s: w.start })) : [{ sp: 'A', t: j.text || '' }];
  // слова приходят по одному — собираем без лишних пробелов
  const lines = [];
  for (const p of parts) { const l = lines[lines.length - 1]; if (l && l.sp === p.sp) l.t += p.t; else lines.push({ sp: p.sp, t: p.t, s: p.s }); }
  return { lines: merge(lines.map(l => ({ ...l, t: l.t.replace(/\s+/g, ' ') }))), lang: j.language_code || '', stt: 'elevenlabs' };
}
async function sttOpenAI(a, key) {
  const fd = new FormData();
  fd.append('file', new Blob([a.buf], { type: a.type }), 'call.mp3');
  fd.append('model', process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe-diarize');
  fd.append('response_format', 'diarized_json'); fd.append('chunking_strategy', 'auto');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('OpenAI: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
  const segs = j.segments || [{ speaker: 'A', text: j.text || '' }];
  return { lines: merge(segs.map(x => ({ sp: String(x.speaker || 'A').slice(0, 12), t: x.text, s: x.start }))), lang: j.language || '', stt: 'openai' };
}

/* ===== оценка ===== */
const TOOL = {
  name: 'call_review', description: 'Сохранить разбор звонка менеджера',
  input_schema: { type: 'object', required: ['manager_speaker', 'score', 'criteria', 'summary', 'strengths', 'mistakes', 'recommendations', 'outcome'], properties: {
    manager_speaker: { type: 'string', description: 'Метка говорящего, который является менеджером компании' },
    kind: { type: 'string', enum: ['sale', 'service', 'not_target', 'voicemail', 'other'], description: 'sale — продажа/консультация клиента; service — сервис/доставка; not_target — нецелевой; voicemail — автоответчик/нет разговора' },
    score: { type: 'integer', minimum: 0, maximum: 100, description: 'Итоговая оценка работы менеджера' },
    criteria: { type: 'array', items: { type: 'object', required: ['name', 'score', 'comment'], properties: { name: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 10 }, comment: { type: 'string' } } } },
    summary: { type: 'string', description: '2–3 предложения: о чём разговор и чем закончился' },
    strengths: { type: 'array', items: { type: 'string' } },
    mistakes: { type: 'array', items: { type: 'string' }, description: 'Конкретные ошибки с цитатой или моментом разговора' },
    recommendations: { type: 'array', items: { type: 'string' }, description: 'Что сказать иначе — конкретные фразы' },
    objections: { type: 'array', items: { type: 'string' }, description: 'Возражения клиента' },
    outcome: { type: 'string', enum: ['order', 'next_step', 'refusal', 'no_result', 'other'] },
    next_step: { type: 'string' },
    client_mood: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
  } },
};
function prompt(s, meta) {
  const L = s.lang === 'kk' ? 'казахском' : 'русском';
  return `Ты — руководитель отдела продаж и эксперт по контролю качества звонков. Оцени работу МЕНЕДЖЕРА компании «${meta.company}» в телефонном разговоре с клиентом.
Расшифровка автоматическая: говорящие помечены буквами, возможны ошибки распознавания; разговор может быть на казахском, русском или смешанный. Сам определи, кто менеджер (представляется, говорит от компании).
Критерии (каждый 0–10, в ответе — в этом же порядке и с этими названиями):
${s.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${s.script ? `\nСкрипт компании:\n${s.script.slice(0, 6000)}\n` : ''}
Итог score 0–100 — общая оценка, а не просто сумма. Критерий, который в этом звонке неприменим (например, возражений не было), оценивай по ситуации и напиши это в комментарии.
Если это автоответчик, нецелевой или служебный звонок — укажи kind и оцени мягко, без придирок.
Будь конкретным: ошибки — с моментом разговора, рекомендации — готовыми фразами. Пиши на ${L} языке. Тип звонка: ${meta.dir}, длительность ${meta.dur}.`;
}
async function review(lines, s, meta) {
  const text = lines.map(l => `[${l.sp}] ${l.t}`).join('\n').slice(0, 60000);
  const res = await ai.callClaude({ model: ai.MODEL(), max_tokens: 2500, system: prompt(s, meta), tools: [TOOL], tool_choice: { type: 'tool', name: 'call_review' },
    messages: [{ role: 'user', content: 'Расшифровка разговора:\n' + text }] });
  const t = (res.content || []).find(c => c.type === 'tool_use');
  if (!t) throw new Error('AI не вернул оценку');
  return t.input;
}

/* ===== обработка одного звонка ===== */
async function analyze(id) {
  const c = wh.byId('call', id);
  if (!c) throw new Error('Звонок не найден в базе');
  if (!c.rec) throw new Error('У звонка нет записи');
  const R = ready(), s = S();
  if (!R.stt) throw new Error('Не задан ключ расшифровки (ElevenLabs или OpenAI)');
  if (!R.claude) throw new Error('AI не подключён (ANTHROPIC_API_KEY)');
  if (st.busy.has(id)) throw new Error('Разбор уже идёт');
  st.busy.add(id);
  try {
    const a = await audioOf(id), k = keys();
    const tr = R.stt === 'elevenlabs' ? await sttEleven(a, k.eleven) : await sttOpenAI(a, k.openai);
    const words = tr.lines.reduce((n, l) => n + l.t.split(/\s+/).length, 0);
    const base = { id, uid: c.uid, d: c.d, at: c.at, dur: c.dur, ty: c.ty, stt: tr.stt, lang: tr.lang, ts: Date.now() };
    if (words < 15) { const d = { ...base, skip: true, reason: 'Слишком короткий разговор для оценки' }; await save(id, d, tr.lines); return d; }
    const dir = c.ty === 1 || c.ty === 4 ? 'исходящий' : 'входящий';
    const r = await review(tr.lines, s, { company: ((cfgRef || {}).settings || {}).company || 'Safa', dir, dur: Math.floor(c.dur / 60) + ' мин ' + (c.dur % 60) + ' с' });
    const d = { ...base, score: Math.max(0, Math.min(100, Math.round(+r.score || 0))), kind: r.kind || 'sale', criteria: (r.criteria || []).slice(0, 12),
      summary: r.summary || '', strengths: r.strengths || [], mistakes: r.mistakes || [], recommendations: r.recommendations || [], objections: r.objections || [],
      outcome: r.outcome || 'other', next: r.next_step || '', mood: r.client_mood || '', mgr: r.manager_speaker || '', model: ai.MODEL() };
    await save(id, d, tr.lines);
    return d;
  } finally { st.busy.delete(id); }
}

/* ===== фоновая очередь ===== */
const todayKey = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: ((cfgRef || {}).settings || {}).tz || 'Asia/Almaty' }).format(new Date(t));
async function tick() {
  const s = S(); if (!s.on || st.running) return;
  const R = ready(); if (!R.stt || !R.claude) return;
  const today = todayKey(); if (st.today !== today) { st.today = today; st.doneToday = [...RES.values()].filter(x => x.ts && todayKey(x.ts) === today).length; }
  let since = store.get('cai:since'); if (!since) { since = new Date(Date.now() - 864e5).toISOString(); await store.set('cai:since', since); }
  const left = Math.max(0, (+s.perDay || 300) - st.doneToday); if (!left) return;
  const t0 = new Date(since).getTime();
  const todo = wh.all('call').filter(c => c.rec && c.code === '200' && c.dur >= (+s.minSec || 40) && new Date(c.at).getTime() >= t0 && !RES.has(c.id) && (st.fails[c.id] || 0) < 2)
    .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, Math.min(left, 12));
  if (!todo.length) return;
  st.running = true;
  try {
    for (let i = 0; i < todo.length; i += 2) {
      await Promise.all(todo.slice(i, i + 2).map(c => analyze(c.id).then(() => { st.doneToday++; st.lastAt = Date.now(); })
        .catch(e => { st.fails[c.id] = (st.fails[c.id] || 0) + 1; st.errors++; st.lastError = e.message; console.error('callai', c.id, e.message); })));
    }
  } finally { st.running = false; }
}
function start(cfg) {
  cfgRef = cfg;
  init().catch(e => console.error('callai init', e.message)).finally(() => setInterval(() => tick().catch(e => { st.lastError = e.message; }), 60e3));
}
const setCfg = cfg => { cfgRef = cfg; if (S().on && !store.get('cai:since')) store.set('cai:since', new Date().toISOString()); };

/* ===== отчёты ===== */
const get = id => RES.get(String(id));
function summary(allowed, from, to, name) {
  const rows = [...RES.values()].filter(x => !x.skip && x.d >= from && x.d <= to && allowed(x.uid));
  const by = {};
  for (const x of rows) {
    const m = by[x.uid] || (by[x.uid] = { uid: x.uid, n: 0, sum: 0, crit: {}, orders: 0 });
    m.n++; m.sum += x.score; if (x.outcome === 'order') m.orders++;
    (x.criteria || []).forEach(c => { const k = c.name; const a = m.crit[k] || (m.crit[k] = [0, 0]); a[0] += +c.score || 0; a[1]++; });
  }
  const crit = m => Object.entries(m.crit).map(([k, [s, n]]) => ({ name: k, avg: Math.round(s / n * 10) / 10 })).sort((a, b) => a.avg - b.avg);
  const managers = Object.values(by).map(m => { const c = crit(m); return { uid: m.uid, name: name(m.uid), reviews: m.n, avg: Math.round(m.sum / m.n), orders: m.orders, weakest: c[0] || null, strongest: c[c.length - 1] || null }; })
    .sort((a, b) => b.avg - a.avg);
  const all = { n: rows.length, avg: rows.length ? Math.round(rows.reduce((a, x) => a + x.score, 0) / rows.length) : null };
  const tc = {}; rows.forEach(x => (x.criteria || []).forEach(c => { const a = tc[c.name] || (tc[c.name] = [0, 0]); a[0] += +c.score || 0; a[1]++; }));
  return { total: all, criteria: Object.entries(tc).map(([k, [s, n]]) => ({ name: k, avg: Math.round(s / n * 10) / 10 })), managers };
}
function status() {
  const k = keys(), mask = v => v ? '••••' + v.slice(-4) : '';
  return { settings: S(), ready: ready(), keys: { eleven: mask(k.eleven), openai: mask(k.openai), env: { eleven: !!process.env.ELEVENLABS_API_KEY, openai: !!process.env.OPENAI_API_KEY } },
    total: RES.size, doneToday: st.doneToday, running: st.running, errors: st.errors, lastError: st.lastError, lastAt: st.lastAt, since: store.get('cai:since') || null };
}

module.exports = { DEF, DEF_CRITERIA, start, setCfg, analyze, get, transcript, summary, status, setKeys };
