// Аккаунты: владелец (email + пароль из кабинета; до настройки — пароль DASH_PASSWORD) и руководители секторов (свой логин/пароль, видят только свои сектора).
const crypto = require('crypto');
const store = require('./store');

const PASS = process.env.DASH_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update('sess:' + PASS + ':' + (process.env.SESSION_SECRET || '')).digest();
const LEGACY = crypto.createHash('sha256').update('lb:' + PASS).digest('hex').slice(0, 32);
const OWNER = { id: 'owner', login: 'admin', name: 'Владелец', role: 'owner', sectors: null };
const ROLES = { owner: 'Владелец', head: 'Руководитель сектора' };

const users = () => store.get('users') || [];
const owner = () => store.get('owner') || null;            // { login(email), salt, hash } — задаётся владельцем в кабинете
const ownerSet = () => !!(owner() && owner().hash);
const LOGIN_RE = /^[a-z0-9._@+-]{3,64}$/;
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

function publicUser(u) { return u && { id: u.id, login: u.login, name: u.name, role: u.role, sectors: u.role === 'owner' ? null : (u.sectors || []), active: u.active !== false }; }

function login(loginName, pw) {
  loginName = String(loginName || '').trim().toLowerCase();
  const o = owner();
  if (o && o.hash && loginName === o.login) return safeEq(hashPw(pw, o.salt), o.hash) ? OWNER : null;
  // резервный вход владельца: логин admin + пароль DASH_PASSWORD из настроек Render (на случай, если пароль забыт)
  if ((loginName === 'admin' || (!loginName && !ownerSet())) && PASS && pw === PASS) return OWNER;
  const u = users().find(x => x.login === loginName && x.active !== false);
  if (!u || !u.hash) return null;
  return safeEq(hashPw(pw, u.salt), u.hash) ? u : null;
}
function cookieFor(u) {
  const exp = Date.now() + 365 * 864e5, v = `${u.id}.${exp}`;
  return `sid=${v}.${sign(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}
function fromReq(req) {
  if (!PASS && !ownerSet()) return OWNER; // пароль не задан — кабинет открыт (как раньше)
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
  if (!LOGIN_RE.test(loginName)) throw new Error('Логин: email или 3–64 символа — латиница, цифры, . _ - @');
  if (loginName === 'admin' || (owner() && owner().login === loginName)) throw new Error('Этот логин занят владельцем');
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
// владелец задаёт свой вход (email + пароль). Нужен текущий пароль владельца (или DASH_PASSWORD, если вход ещё не настроен).
async function setOwner({ login: loginName, password, current }) {
  loginName = String(loginName || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginName)) throw new Error('Укажите email');
  if (users().some(x => x.login === loginName)) throw new Error('Этот email уже занят руководителем');
  const o = owner();
  const okCur = (o && o.hash && safeEq(hashPw(current, o.salt), o.hash)) || (PASS && current === PASS) || (!PASS && !ownerSet());
  if (!okCur) throw new Error('Текущий пароль неверный');
  const next = { login: loginName, salt: o && o.salt, hash: o && o.hash };
  if (password) {
    if (String(password).length < 8) throw new Error('Пароль: минимум 8 символов');
    next.salt = crypto.randomBytes(12).toString('hex'); next.hash = hashPw(password, next.salt);
  }
  if (!next.hash) throw new Error('Задайте пароль');
  await store.set('owner', next);
  return { login: loginName };
}
const ownerLogin = () => (owner() || {}).login || '';
async function deleteUser(id) { await store.set('users', users().filter(x => x.id !== id)); }

module.exports = { setOwner, ownerLogin, login, cookieFor, fromReq, scopeOf, saveUser, deleteUser, list: () => users().map(publicUser), publicUser, ROLES, OWNER };
