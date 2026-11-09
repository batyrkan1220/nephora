// Хранилище настроек: Postgres (DATABASE_URL) или локальный JSON-файл (для разработки).
// Всё лежит в одной таблице ключ → JSON: 'config' и 'photo:<uid>'.
const fs = require('fs'), path = require('path');

const DB_URL = process.env.DATABASE_URL || '';
const FILE = process.env.STORE_FILE || path.join(__dirname, '..', 'data', 'store.json');

let pool = null, mem = {};

async function init() {
  if (DB_URL) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
    pool = new Pool({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    await pool.query(`create table if not exists lb_kv (
      k text primary key, v jsonb not null, updated_at timestamptz not null default now())`);
    const r = await pool.query('select k, v from lb_kv');
    mem = Object.fromEntries(r.rows.map(x => [x.k, x.v]));
    console.log('store: postgres,', r.rows.length, 'keys');
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

module.exports = { init, get, set, del, keys, kind: () => (DB_URL ? 'postgres' : 'file') };
