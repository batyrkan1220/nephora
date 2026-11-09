// Bitrix24 REST через входящий вебхук (только чтение). Вебхук не уходит в браузер.
const HOOK = (process.env.BITRIX_WEBHOOK || '').replace(/\/?$/, '/');

function qs(obj, prefix) {
  const out = [];
  for (const k in obj) {
    const v = obj[k]; if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') out.push(qs(v, key));
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v === null ? '' : v));
  }
  return out.filter(Boolean).join('&');
}

async function call(method, params = {}) {
  if (!/^https?:\/\//.test(HOOK)) throw new Error('BITRIX_WEBHOOK не задан');
  const r = await fetch(HOOK + method + '.json', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${method}: ${j.error_description || j.error || 'HTTP ' + r.status}`);
  return j;
}

async function batch(cmds) {
  const keys = Object.keys(cmds), out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const cmd = {};
    keys.slice(i, i + 50).forEach(k => { cmd[k] = cmds[k][0] + '?' + qs(cmds[k][1]); });
    const r = await call('batch', { halt: 0, cmd });
    const res = r.result.result || {}, errs = r.result.result_error || {};
    const ek = Object.keys(errs).filter(k => errs[k] && (Array.isArray(errs[k]) ? errs[k].length : true));
    if (ek.length) throw new Error(ek.map(k => errs[k].error_description || errs[k].error || JSON.stringify(errs[k])).join('; '));
    Object.assign(out, res);
  }
  return out;
}

async function listAll(method, params, pick = r => r || []) {
  const first = await call(method, { ...params, start: 0 });
  const items = [...pick(first.result)];
  const total = first.total || 0, cmds = {};
  for (let s = 50; s < total; s += 50) cmds['p' + s] = [method, { ...params, start: s }];
  if (Object.keys(cmds).length) {
    const r = await batch(cmds);
    Object.keys(cmds).forEach(k => items.push(...pick(r[k])));
  }
  return items;
}

// Сделки в «фактовых» стадиях с датой (поле dateField) в [from, toExcl)
async function deals(from, toExcl, stages, dateField) {
  const rows = await listAll('crm.deal.list', {
    order: { ID: 'ASC' },
    filter: { '@STAGE_ID': stages, ['>=' + dateField]: from, ['<' + dateField]: toExcl },
    select: ['ID', 'TITLE', 'OPPORTUNITY', 'ASSIGNED_BY_ID', 'STAGE_ID', dateField],
  });
  return rows.map(d => ({
    id: String(d.ID), uid: String(d.ASSIGNED_BY_ID), sum: +d.OPPORTUNITY || 0,
    dk: String(d[dateField] || '').slice(0, 10), title: d.TITLE || '', stage: d.STAGE_ID,
  })).filter(d => d.dk);
}

async function users(ids) {
  const filter = ids ? { ID: ids } : { ACTIVE: true };
  return (await listAll('user.get', { FILTER: filter })).map(u => ({
    id: String(u.ID), name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || ('ID ' + u.ID),
    photo: u.PERSONAL_PHOTO || '', deps: (u.UF_DEPARTMENT || []).map(String), active: u.ACTIVE !== false,
    position: u.WORK_POSITION || '',
  }));
}

async function departments() {
  return ((await call('department.get', {})).result || []).map(d => ({ id: String(d.ID), name: d.NAME, parent: d.PARENT ? String(d.PARENT) : '' }));
}

// Для админки: стадии всех воронок и поля-даты сделки
async function meta() {
  const [st, cats, fields] = await Promise.all([
    call('crm.status.list', { order: { SORT: 'ASC' } }).then(r => r.result || []),
    call('crm.dealcategory.list', {}).then(r => r.result || []).catch(() => []),
    call('crm.deal.fields', {}).then(r => r.result || {}),
  ]);
  const catName = { '': 'Общая' }; cats.forEach(c => { catName[String(c.ID)] = c.NAME; });
  const stages = st.filter(s => /^DEAL_STAGE(_\d+)?$/.test(s.ENTITY_ID)).map(s => {
    const cid = (s.ENTITY_ID.match(/_(\d+)$/) || [])[1] || '';
    return { id: s.STATUS_ID, name: s.NAME, category: catName[cid] || ('Воронка ' + cid) };
  });
  const dateFields = Object.entries(fields).filter(([, f]) => /date/.test(f.type))
    .map(([id, f]) => ({ id, name: f.formLabel || f.listLabel || f.title || id }));
  return { stages, dateFields };
}

module.exports = { call, deals, users, departments, meta, configured: () => /^https?:\/\//.test(HOOK) };
