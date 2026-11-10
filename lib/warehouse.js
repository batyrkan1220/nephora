// База Safa: копия CRM из Bitrix24 — сделки, лиды, звонки.
// Держим в памяти (быстрые отчёты и AI), сохраняем в Postgres (таблица wh_rows), синхронизируем по изменениям.
const store = require('./store');
const bx = require('./bitrix');

const DATA = { deal: new Map(), lead: new Map(), call: new Map() };
const st = { syncing: null, lastRun: 0, error: '', callsError: '', counts: {}, progress: '' };
let cfgRef = null;

const S = () => cfgRef.settings;
const fmtDay = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
let dayFmt = null;
function dayKey(v) {
  if (!v) return '';
  const d = new Date(v); if (isNaN(d)) return String(v).slice(0, 10);
  dayFmt = dayFmt || fmtDay(S().tz); return dayFmt.format(d);
}

/* ===== приведение записей Bitrix24 к компактному виду ===== */
function mapDeal(d) {
  const F = S().dateField;
  return {
    id: String(d.ID), t: d.TITLE || '', st: d.STAGE_ID || '', cat: String(d.CATEGORY_ID || '0'), sem: d.STAGE_SEMANTIC_ID || 'P',
    sum: +d.OPPORTUNITY || 0, uid: String(d.ASSIGNED_BY_ID || ''), lead: d.LEAD_ID ? String(d.LEAD_ID) : '', contact: d.CONTACT_ID ? String(d.CONTACT_ID) : '',
    src: d.SOURCE_ID || '', utm: d.UTM_SOURCE || '', cr: d.DATE_CREATE || '', md: d.DATE_MODIFY || '', mv: d.MOVED_TIME || '',
    od: String(d[F] || '').slice(0, 10), crd: dayKey(d.DATE_CREATE),
  };
}
function mapLead(l) {
  return { id: String(l.ID), t: l.TITLE || '', st: l.STATUS_ID || '', sem: l.STATUS_SEMANTIC_ID || 'P', uid: String(l.ASSIGNED_BY_ID || ''),
    cr: l.DATE_CREATE || '', md: l.DATE_MODIFY || '', crd: dayKey(l.DATE_CREATE), src: l.SOURCE_ID || '', utm: l.UTM_SOURCE || '' };
}
function mapCall(c) {
  return { id: String(c.CALL_ID || c.ID), uid: String(c.PORTAL_USER_ID || ''), ph: c.PHONE_NUMBER || '', ty: +c.CALL_TYPE || 0,
    dur: +c.CALL_DURATION || 0, at: c.CALL_START_DATE || '', d: dayKey(c.CALL_START_DATE), code: String(c.CALL_FAILED_CODE || ''),
    et: c.CRM_ENTITY_TYPE || '', eid: c.CRM_ENTITY_ID ? String(c.CRM_ENTITY_ID) : '', rec: !!(c.RECORD_FILE_ID || c.CALL_RECORD_URL) };
}

/* ===== Postgres ===== */
async function initDb() {
  const pool = store.pool(); if (!pool) return;
  await pool.query(`create table if not exists wh_rows (entity text not null, id text not null, data jsonb not null,
    updated_at timestamptz not null default now(), primary key (entity, id))`);
  const r = await pool.query('select entity, id, data from wh_rows');
  for (const row of r.rows) if (DATA[row.entity]) DATA[row.entity].set(row.id, row.data);
  console.log('warehouse: loaded', r.rows.length, 'rows from postgres');
}
async function persist(entity, rows) {
  const pool = store.pool(); if (!pool || !rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await pool.query(`insert into wh_rows (entity, id, data, updated_at)
      select $1, x->>'id', x, now() from jsonb_array_elements($2::jsonb) x
      on conflict (entity, id) do update set data = excluded.data, updated_at = now()`, [entity, JSON.stringify(chunk)]);
  }
}

/* ===== синхронизация ===== */
const SEL_DEAL = () => ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'STAGE_SEMANTIC_ID', 'OPPORTUNITY', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'LEAD_ID',
  'SOURCE_ID', 'UTM_SOURCE', 'DATE_CREATE', 'DATE_MODIFY', 'MOVED_TIME', S().dateField];
const SEL_LEAD = ['ID', 'TITLE', 'STATUS_ID', 'STATUS_SEMANTIC_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY', 'SOURCE_ID', 'UTM_SOURCE'];

function backfillFrom() {
  const days = Math.max(7, +S().whDays || 120);
  const d = new Date(Date.now() - days * 864e5); return d.toISOString().slice(0, 10);
}
async function pull(entity, method, select, mapper, stateKey) {
  const state = store.get('wh:state') || {};
  const since = state[stateKey];
  const filter = since ? { '>=DATE_MODIFY': since } : { '>=DATE_CREATE': backfillFrom() };
  const rows = (await bx.listAll(method, { order: { DATE_MODIFY: 'ASC' }, filter, select })).map(mapper);
  for (const r of rows) DATA[entity].set(r.id, r);
  await persist(entity, rows);
  const maxMd = rows.reduce((a, r) => (r.md > a ? r.md : a), since || '');
  if (maxMd) { state[stateKey] = maxMd; await store.set('wh:state', state); }
  return rows.length;
}
// звонки — неделями: каждую неделю сохраняем и сдвигаем отметку, чтобы большая история не начиналась заново после сбоя
async function pullCalls() {
  const state = store.get('wh:state') || {};
  const off = S().tzOffset;
  let since = state.callsAt || backfillFrom() + 'T00:00:00' + off, total = 0;
  for (let guard = 0; guard < 60; guard++) {
    const end = new Date(new Date(since).getTime() + 7 * 864e5);
    const last = end.getTime() >= Date.now();
    const filter = { '>=CALL_START_DATE': since };
    if (!last) filter['<CALL_START_DATE'] = end.toISOString();
    const rows = (await bx.listAll('voximplant.statistic.get', { FILTER: filter, SORT: 'CALL_START_DATE', ORDER: 'ASC' })).map(mapCall);
    for (const r of rows) DATA.call.set(r.id, r);
    await persist('call', rows); total += rows.length;
    since = last ? rows.reduce((a, r) => (r.at > a ? r.at : a), since) : end.toISOString();
    state.callsAt = since; await store.set('wh:state', state);
    st.progress = `звонки загружены до ${String(since).slice(0, 10)}`;
    if (last) break;
  }
  st.progress = '';
  return total;
}
async function sync() {
  if (st.syncing) return st.syncing;
  st.syncing = (async () => {
    try {
      const n = { deal: await pull('deal', 'crm.deal.list', SEL_DEAL(), mapDeal, 'dealMd'), lead: await pull('lead', 'crm.lead.list', SEL_LEAD, mapLead, 'leadMd') };
      try { n.call = await pullCalls(); st.callsError = ''; }
      catch (e) { st.callsError = /access|scope|insufficient|method/i.test(e.message) ? 'Нет доступа к телефонии: добавьте право «telephony» во входящий вебхук Bitrix24' : e.message; }
      st.counts = { deal: DATA.deal.size, lead: DATA.lead.size, call: DATA.call.size, last: n };
      st.error = ''; st.lastRun = Date.now();
    } catch (e) { st.error = String(e.message || e); console.error('warehouse:', st.error); }
    finally { st.syncing = null; }
  })();
  return st.syncing;
}
async function resetAndResync() {
  for (const m of Object.values(DATA)) m.clear();
  const pool = store.pool(); if (pool) await pool.query('delete from wh_rows');
  await store.set('wh:state', {});
  return sync();
}

let timer = null;
async function start(cfg) {
  cfgRef = cfg; dayFmt = null;
  await initDb();
  // без Postgres (или пустой базы) копия в памяти пустая — начинаем загрузку заново, а не «с последнего изменения»
  if (!store.pool() || !DATA.deal.size) await store.set('wh:state', {});
  const loop = async () => { await sync(); timer = setTimeout(loop, Math.max(60, +S().whSyncSec || 120) * 1000); };
  setTimeout(loop, 3000);
}
function setCfg(cfg) { cfgRef = cfg; dayFmt = null; }
const all = entity => [...DATA[entity].values()];
const status = () => ({ ...st, syncing: !!st.syncing, counts: { deal: DATA.deal.size, lead: DATA.lead.size, call: DATA.call.size }, from: backfillFrom(), persisted: !!store.pool() });

const byId = (ent, id) => DATA[ent].get(String(id));
module.exports = { byId, start, setCfg, sync, resetAndResync, all, status, dayKey };
