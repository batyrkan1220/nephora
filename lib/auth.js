// Аккаунты: владелец (общий пароль DASH_PASSWORD) и руководители секторов (свой логин/пароль, видят только свои сектора).
const crypto = require('crypto');
const store = require('./store');

const PASS = process.env.DASH_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update('sess:' + PASS + ':' + (process.env.SESSION_SECRET || '')).digest();
const LEGACY = crypto.createHash('sha256').update('lb:' + PASS).digest('hex').slice(0, 32);
const OWNER = { id: 'owner', login: 'admin', name: 'Владелец', role: 'owner', sectors: null };
const ROLES = { owner: 'Владелец', head: 'Руководитель сектора' };

const users = () => store.get('users') || [];
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

function publicUser(u) { return u && { id: u.id, login: u.login, name: u.name, role: u.role, sectors: u.role === 'owner' ? null : (u.sectors || []), active: u.active !== false }; }

function login(loginName, pw) {
  loginName = String(loginName || '').trim().toLowerCase();
  if ((!loginName || loginName === 'admin') && PASS && pw === PASS) return OWNER;
  const u = users().find(x => x.login === loginName && x.active !== false);
  if (!u || !u.hash) return null;
  return safeEq(hashPw(pw, u.salt), u.hash) ? u : null;
}
function cookieFor(u) {
  const exp = Date.now() + 365 * 864e5, v = `${u.id}.${exp}`;
  return `sid=${v}.${sign(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}
function fromReq(req) {
  if (!PASS) return OWNER; // пароль не задан — кабинет открыт (как раньше)
  const ck = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  if (ck.lb === LEGACY) return OWNER;
  const m = String(ck.sid || '').match(/^([\w-]+)\.(\d+)\.([\w-]+)$/);
  if (!m || +m[2] < Date.now() || !safeEq(sign(`${m[1]}.${m[2]}`), m[3])) return null;
  if (m[1] === 'owner') return OWNER;
  const u = users().find(x => x.id === m[1] && x.active !== false);
  return u || null;
}
const scopeOf = u => ({ role: u.role, sectors: u.role === 'owner' ? null : (u.sectors || []) });

async function saveUser(data) {
  const list = users();
  const loginName = String(data.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(loginName)) throw new Error('Логин: 3–32 символа, латиница, цифры, . _ -');
  if (loginName === 'admin') throw new Error('Логин admin занят владельцем');
  if (list.some(x => x.login === loginName && x.id !== data.id)) throw new Error('Такой логин уже есть');
  let u = list.find(x => x.id === data.id);
  if (!u) { u = { id: crypto.randomBytes(5).toString('hex'), created: Date.now() }; list.push(u); }
  Object.assign(u, { login: loginName, name: String(data.name || loginName).slice(0, 80), role: 'head',
    sectors: (data.sectors || []).map(String), active: data.active !== false });
  if (data.password) {
    if (String(data.password).length < 6) throw new Error('Пароль: минимум 6 символов');
    u.salt = crypto.randomBytes(12).toString('hex'); u.hash = hashPw(data.password, u.salt);
  }
  if (!u.hash) throw new Error('Задайте пароль');
  await store.set('users', list);
  return publicUser(u);
}
async function deleteUser(id) { await store.set('users', users().filter(x => x.id !== id)); }

module.exports = { login, cookieFor, fromReq, scopeOf, saveUser, deleteUser, list: () => users().map(publicUser), publicUser, ROLES, OWNER };
