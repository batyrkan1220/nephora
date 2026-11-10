// AI-ассистент Safa: Claude отвечает по данным базы через инструменты.
// Доступ ограничен ролью: руководитель сектора получает данные только своих секторов (фильтр применяется здесь, а не моделью).
const C = require('./calc');
const AN = require('./analytics');
const wh = require('./warehouse');

const KEY = () => process.env.ANTHROPIC_API_KEY || '';
const BASE = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const dateP = d => ({ type: 'string', description: d + ' (YYYY-MM-DD)' });
const TOOLS = [
  { name: 'get_board_today', description: 'Текущее состояние лидерборда: касса сегодня и за период, план компании и секторов, топ менеджеров сегодня и за период.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_sales_report', description: 'Продажи (касса) за период по менеджерам: число продаж, сумма, средний чек, % сетки, бонусы, штрафы, зарплата; и касса по дням.',
    input_schema: { type: 'object', properties: { from: dateP('Начало'), to: dateP('Конец'), sector: { type: 'string', description: 'Название сектора (необязательно)' } }, required: ['from', 'to'] } },
  { name: 'get_funnel', description: 'Воронка и выкуп: лиды, сделки, заказы, выкуплено/отказ/в работе, конверсия, % выкупа по менеджерам и секторам; зависшие сделки по стадиям.',
    input_schema: { type: 'object', properties: { from: dateP('Начало'), to: dateP('Конец'), sector: { type: 'string' }, manager: { type: 'string', description: 'Имя менеджера (необязательно)' } }, required: ['from', 'to'] } },
  { name: 'get_calls', description: 'Звонки по менеджерам: всего, исходящие (дозвон %), входящие, пропущенные, минуты разговора, звонков на продажу, скорость первого звонка по новому лиду.',
    input_schema: { type: 'object', properties: { from: dateP('Начало'), to: dateP('Конец'), sector: { type: 'string' }, manager: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'find_deals', description: 'Поиск сделок: по дате заказа или созданию, менеджеру, исходу (won/lost/open), стадии, минимальной сумме.',
    input_schema: { type: 'object', properties: { from: dateP('С'), to: dateP('По'), by: { type: 'string', enum: ['order', 'created'] }, manager: { type: 'string' }, sector: { type: 'string' },
      outcome: { type: 'string', enum: ['won', 'lost', 'open'] }, stage: { type: 'string' }, minSum: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'get_sources', description: 'Продажи по источникам/рекламным каналам (UTM, источник сделки): заказы, сумма, % выкупа.',
    input_schema: { type: 'object', properties: { from: dateP('Начало'), to: dateP('Конец'), sector: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'get_payouts', description: 'Зарплата менеджеров за месяц с выплатами по неделям.', input_schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' }, sector: { type: 'string' } }, required: ['month'] } },
  { name: 'list_people', description: 'Список секторов и менеджеров, доступных пользователю.', input_schema: { type: 'object', properties: {} } },
];

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
function resolveSector(ctx, scope, v) {
  if (!v) return '';
  const secs = C.sectorsOf(ctx.deps).filter(d => !scope.sectors || scope.sectors.includes(d.id));
  const x = secs.find(d => d.id === String(v) || norm(d.name) === norm(v)) || secs.find(d => norm(d.name).includes(norm(v)));
  if (!x) throw new Error(`Сектор «${v}» не найден или нет доступа`);
  return x.id;
}
function resolveManager(ctx, scope, v) {
  if (!v) return '';
  const A = AN.allowedUids(ctx, scope, {});
  const cand = ctx.users.filter(u => A.has(u.id)).map(u => ({ id: u.id, n: norm((ctx.managers[u.id] || {}).name || u.name) }));
  const q = norm(v), x = cand.find(c => c.n === q) || cand.find(c => c.n.includes(q)) || cand.find(c => q.split(/\s+/).every(w => c.n.includes(w)));
  if (!x) throw new Error(`Менеджер «${v}» не найден или нет доступа`);
  return x.id;
}
const r0 = n => Math.round(n || 0), r1 = n => n == null ? null : Math.round(n * 10) / 10;

async function runTool(name, input, env) {
  const { cfg, ctx, scope, stageNames } = env;
  const c = ctx(), today = C.todayKey(cfg.settings.tz);
  const sector = resolveSector(c, scope, input.sector), uid = resolveManager(c, scope, input.manager);
  const f = { from: input.from || C.monthRange(today).from, to: input.to || today, sector, uid, stageNames };
  switch (name) {
    case 'get_board_today': {
      const b = cfg.boards.find(x => x.active) || cfg.boards[0];
      const d = C.computeBoard(b, c), A = AN.allowedUids(c, scope, {});
      const rows = d._all.filter(r => A.has(r.uid));
      return { today, period: d.period, company: scope.sectors ? undefined : { cashToday: d.team.daySum, salesToday: d.team.dayCnt, cashPeriod: d.team.sum, plan: d.team.plan, planPct: d.team.plan ? r1(d.team.sum / d.team.plan * 100) : null },
        sectors: d.sectors.filter(s => !scope.sectors || scope.sectors.includes(s.id)).map(s => ({ name: s.name, today: s.daySum, period: s.sum, plan: s.plan, planPct: s.plan ? r1(s.sum / s.plan * 100) : null, managers: s.managers })),
        topToday: [...rows].filter(r => r.daySum).sort((a, b) => b.daySum - a.daySum).slice(0, 10).map(r => ({ name: r.name, sector: r.sectorName, today: r.daySum, sales: r.dayCnt })),
        topPeriod: rows.slice(0, 15).map(r => ({ name: r.name, sector: r.sectorName, period: r.sum, sales: r.cnt, gridPct: r.commPct, salary: r0(r.salary) })) };
    }
    case 'get_sales_report': {
      const r = await env.report({ from: f.from, to: f.to, sector });
      return { from: r.from, to: r.to, totals: { cash: r.totals.sum, sales: r.totals.cnt, avgCheck: r0(r.totals.avg), salary: r0(r.totals.salary), managers: r.totals.managers },
        managers: r.rows.slice(0, 40).map(x => ({ name: x.name, sector: x.dep, sales: x.cnt, cash: x.sum, avgCheck: r0(x.avg), gridPct: x.commPct, bonus: x.bonus, penalties: x.pen, salary: r0(x.salary) })),
        byDay: r.days.filter(d => d.sum).map(d => ({ day: d.dk, cash: d.sum, sales: d.cnt })) };
    }
    case 'get_funnel': {
      const r = AN.funnel(c, scope, f);
      const slim = x => ({ leads: x.leads, deals: x.deals, orders: x.orders, ordersSum: x.ordersSum, won: x.won, wonSum: x.wonSum, lost: x.lost, lostSum: x.lostSum, open: x.open, convLeadToOrderPct: r1(x.conv), vykupPct: r1(x.vykup) });
      return { from: r.from, to: r.to, total: slim(r.total), sectors: r.sectors.map(s => ({ name: s.name, ...slim(s) })), managers: r.managers.slice(0, 40).map(m => ({ name: m.name, sector: m.sector, ...slim(m) })),
        stuckByStage: r.stuck.map(s => ({ stage: s.name, deals: s.cnt, sum: s.sum, avgDaysInStage: r1(s.avgDays), over7days: s.over7 })), oldestOpen: r.oldest.slice(0, 15) };
    }
    case 'get_calls': {
      const r = AN.calls(c, scope, f), st = wh.status();
      return { callsAvailable: !st.callsError, note: st.callsError || undefined, from: r.from, to: r.to, total: r.total,
        managers: r.managers.slice(0, 40).map(m => ({ name: m.name, sector: m.sector, total: m.total, outgoing: m.out, reachPct: r1(m.reach), incoming: m.inc, missed: m.missed, talkMin: m.talkMin, orders: m.orders, callsPerOrder: r1(m.callsPerOrder), leads: m.leads, firstCallMedianMin: r1(m.respMedianMin), leadsWithoutCall: m.leadsNoCall })),
        leadResponse: { ...r.leadResponse, noCallList: r.leadResponse.noCallList.slice(0, 10) }, callsByHour: r.hours };
    }
    case 'find_deals': return AN.findDeals(c, scope, { ...input, from: input.from, to: input.to, sector, uid, stageNames, limit: Math.min(+input.limit || 30, 60) });
    case 'get_sources': return { rows: AN.sources(c, scope, f).slice(0, 30) };
    case 'get_payouts': {
      const month = /^\d{4}-\d{2}$/.test(input.month || '') ? input.month : today.slice(0, 7);
      const r = C.payouts(cfg, c, { month, boardId: '' }); const A = AN.allowedUids(c, scope, { sector });
      return { month, weeks: r.weeks, managers: r.rows.filter(x => A.has(x.uid)).map(x => ({ name: x.name, cash: x.sum, gridPct: x.commPct, percent: r0(x.comm), tierPremium: x.premium, bonus: x.bonus, penalties: x.pen, total: r0(x.salary), byWeek: x.weeks.map(w => r0(w.pay)) })) };
    }
    case 'list_people': {
      const A = AN.allowedUids(c, scope, {}), secOf = C.sectorMap(c), SN = Object.fromEntries(C.sectorsOf(c.deps).map(d => [d.id, d.name]));
      return { sectors: C.sectorsOf(c.deps).filter(d => !scope.sectors || scope.sectors.includes(d.id)).map(d => d.name),
        managers: c.users.filter(u => u.active && A.has(u.id) && secOf[u.id]).map(u => ({ name: (c.managers[u.id] || {}).name || u.name, sector: SN[secOf[u.id]] })) };
    }
  }
  throw new Error('Неизвестный инструмент ' + name);
}

function systemPrompt(env) {
  const { user, scope, cfg, ctx } = env, c = ctx();
  const secNames = scope.sectors ? C.sectorsOf(c.deps).filter(d => scope.sectors.includes(d.id)).map(d => d.name).join(', ') || 'нет' : 'все секторы компании';
  const today = C.todayKey(cfg.settings.tz);
  return `Ты — AI-аналитик компании ${cfg.settings.company || 'Safa'} (продажи через колл-центр, CRM Bitrix24). Сегодня ${today}, часовой пояс Алматы (UTC+5).
Пользователь: ${user.name} (${user.role === 'owner' ? 'владелец' : 'руководитель сектора'}). Доступ: ${secNames}. Данные других секторов недоступны — не обсуждай их.
Правила:
- Все цифры бери только из инструментов. Ничего не выдумывай. Если данных нет — скажи прямо, что именно недоступно.
- Отвечай на языке вопроса (қазақша или по-русски). Коротко: сначала ответ и ключевые цифры, затем 2–4 вывода или рекомендации.
- Деньги в тенге с пробелами (1 250 000 ₸). Для сравнений используй небольшие таблицы markdown.
- «Касса» = сделки в стадиях факта по дате заказа (как на лидерборде). «Выкуп» = выкуплено / (выкуплено + отказ). Зарплата = % по сетке + премия уровня + бонусы − штрафы.
- Периоды: «сегодня», «вчера», «эта неделя» (с понедельника), «этот месяц» — переводи в даты сам.`;
}

async function callClaude(body) {
  const r = await fetch(BASE() + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY(), 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || 'Ошибка AI: HTTP ' + r.status); e.status = 502; throw e; }
  return j;
}

async function chat(env) {
  if (!KEY()) { const e = new Error('AI не подключён: добавьте ANTHROPIC_API_KEY в переменные окружения Render'); e.status = 400; throw e; }
  const msgs = (env.messages || []).filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-16).map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') { const e = new Error('Пустой вопрос'); e.status = 400; throw e; }
  const used = [];
  for (let i = 0; i < 8; i++) {
    const res = await callClaude({ model: MODEL(), max_tokens: 2000, system: systemPrompt(env), tools: TOOLS, messages: msgs });
    msgs.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') {
      return { text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), tools: used };
    }
    const results = [];
    for (const b of res.content.filter(x => x.type === 'tool_use')) {
      used.push(b.name);
      try { results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(b.name, b.input || {}, env)).slice(0, 60000) }); }
      catch (e) { results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Ошибка: ' + e.message, is_error: true }); }
    }
    msgs.push({ role: 'user', content: results });
  }
  return { text: 'Не удалось получить ответ за разумное число шагов — уточните вопрос.', tools: used };
}

module.exports = { chat, runTool, TOOLS };
