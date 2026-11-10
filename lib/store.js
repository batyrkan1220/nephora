// Хранилище: Supabase (SUPABASE_DB_URL) → иначе Postgres (DATABASE_URL) → иначе локальный JSON-файл (для разработки).
// При первом запуске с SUPABASE_DB_URL всё из старой базы (DATABASE_URL) копируется в Supabase автоматически.
// Всё лежит в одной таблице ключ → JSON: 'config' и 'photo:<uid>'.
const fs = require('fs'), path = require('path');

const SUPA = process.env.SUPABASE_DB_URL || '', OLD = process.env.DATABASE_URL || '';
const DB_URL = SUPA || OLD;
const mkPool = url => { const { Pool } = require('pg'); const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 }); };
const DDL = [
  `create table if not exists lb_kv (k text primary key, v jsonb not null, updated_at timestamptz not null default now())`,
  `create table if not exists wh_rows (entity text not null, id text not null, data jsonb not null, updated_at timestamptz not null default now(), primary key (entity, id))`,
  `create table if not exists call_ai (id text primary key, d text, data jsonb not null, tr jsonb, updated_at timestamptz not null default now())`,
];
// перенос всех данных из старой базы в Supabase (один раз; повторно не запускается — метка migrated:from)
async function migrate(dst) {
  const done = await dst.query(`select 1 from lb_kv where k = 'migrated:from'`);
  if (done.rows.length) return;
  const src = mkPool(OLD);
  try {
    const t0 = Date.now();
    const has = async t => (await src.query(`select to_regclass($1) as r`, ['public.' + t])).rows[0].r;
    let n = 0;
    if (await has('lb_kv')) {
      const r = await src.query('select k, v from lb_kv');
      for (const x of r.rows) await dst.query(`insert into lb_kv (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v`, [x.k, JSON.stringify(x.v)]);
      n += r.rows.length;
    }
    for (const [t, key, cols] of [['wh_rows', ['entity', 'id'], ['entity', 'id', 'data']], ['call_ai', ['id'], ['id', 'd', 'data', 'tr']]]) {
      if (!(await has(t))) continue;
      let last = null;
      for (;;) {
        const where = last ? `where (${key.join(',')}) > (${key.map((_, i) => '$' + (i + 1)).join(',')})` : '';
        const r = await src.query(`select ${cols.join(',')} from ${t} ${where} order by ${key.join(',')} limit 2000`, last || []);
        if (!r.rows.length) break;
        await dst.query(`insert into ${t} (${cols.join(',')}) select ${cols.map(c => `(x->>'${c}')${c === 'data' || c === 'tr' ? '' : ''}`).map((e, i) => (cols[i] === 'data' || cols[i] === 'tr') ? `x->'${cols[i]}'` : e).join(',')}
          from jsonb_array_elements($1::jsonb) x on conflict (${key.join(',')}) do nothing`, [JSON.stringify(r.rows)]);
        n += r.rows.length; const z = r.rows[r.rows.length - 1]; last = key.map(k => z[k]);
      }
    }
    await dst.query(`insert into lb_kv (k, v) values ('migrated:from', $1) on conflict (k) do nothing`, [JSON.stringify({ at: new Date().toISOString(), rows: n })]);
    console.log('store: перенесено в Supabase', n, 'строк за', Math.round((Date.now() - t0) / 1000), 'с');
  } finally { await src.end().catch(() => {}); }
}
const FILE = process.env.STORE_FILE || path.join(__dirname, '..', 'data', 'store.json');

let pool = null, mem = {};

async function init() {
  if (DB_URL) {
    pool = mkPool(DB_URL);
    for (const q of DDL) await pool.query(q);
    if (SUPA && OLD && OLD !== SUPA) await migrate(pool).catch(e => console.error('store: перенос из старой базы не удался —', e.message));
    const r = await pool.query('select k, v from lb_kv');
    mem = Object.fromEntries(r.rows.map(x => [x.k, x.v]));
    console.log('store:', SUPA ? 'supabase' : 'postgres', r.rows.length, 'keys');
  } else {
    try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { mem = {}; }
    console.log('store: file', FILE);
  }
}

function get(k) { return mem[k]; }
function keys(prefix) { return Object.keys(mem).filter(k => k.startsWith(prefix)); }

async function set(k, v) {
  mem[k] = v;
  if (pool) {
    await pool.query(`insert into lb_kv (k, v, updated_at) values ($1, $2, now())
      on conflict (k) do update set v = excluded.v, updated_at = now()`, [k, JSON.stringify(v)]);
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(mem));
  }
}

async function del(k) {
  delete mem[k];
  if (pool) await pool.query('delete from lb_kv where k = $1', [k]);
  else { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem)); }
}

module.exports = { init, get, set, del, keys, kind: () => (SUPA ? 'supabase' : DB_URL ? 'postgres' : 'file'), pool: () => pool };
