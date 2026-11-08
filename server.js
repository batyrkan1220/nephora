// Nephora Leaderboard — Node-сервер без зависимостей.
// Отдаёт index.html и проксирует ТОЛЬКО чтение нужных методов Bitrix24.
// ENV: BITRIX_WEBHOOK (обязательно), DASH_PASSWORD (пароль входа, по желанию).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const HOOK = (process.env.BITRIX_WEBHOOK || '').replace(/\/?$/, '/');
const PASS = process.env.DASH_PASSWORD || '';
const ALLOWED = new Set(['department.get', 'user.get', 'crm.stagehistory.list', 'crm.deal.list']);
const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));

const crypto = require('crypto');
const TOKEN = crypto.createHash('sha256').update('lb:' + PASS).digest('hex').slice(0, 32);
function authed(req) {
  if (!PASS) return true;
  return (req.headers.cookie || '').split(/;\s*/).includes('lb=' + TOKEN);
}
const loginPage = (err) => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · Лидерборд</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f0fb;font-family:system-ui,sans-serif;color:#1b1830}
form{background:#fff;padding:28px;border-radius:20px;width:min(340px,90vw);display:flex;flex-direction:column;gap:12px}
h1{margin:0 0 4px;font-size:20px}input{font:inherit;padding:12px;border:1px solid #e7e5f3;border-radius:10px}
button{font:inherit;font-weight:700;padding:12px;border:0;border-radius:10px;background:#1b1830;color:#fff;cursor:pointer}.e{color:#b42318;font-size:14px}</style>
<form method="post" action="/login"><h1>Лидерборд</h1>${err ? '<div class="e">Неверный пароль</div>' : ''}
<input type="password" name="password" placeholder="Пароль" autofocus required><button>Войти</button></form></html>`;
function batchAllowed(body) {
  const cmds = [...new URLSearchParams(body)].filter(([k]) => /^cmd\[/.test(k)).map(([, v]) => v.split('?')[0]);
  return cmds.length > 0 && cmds.every(m => ALLOWED.has(m));
}

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/login' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const ok = PASS && new URLSearchParams(b).get('password') === PASS;
      if (!ok) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage(true)); }
      res.writeHead(302, { 'Set-Cookie': `lb=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`, Location: '/' });
      res.end();
    });
    return;
  }
  if (!authed(req)) {
    if (req.url.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage(false));
  }

  const m = req.url.match(/^\/api\/rest\/([a-z.]+)\.json$/);
  if (m) {
    const method = m[1];
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!/^https?:\/\//.test(HOOK)) return send(500, { error: 'BITRIX_WEBHOOK is not set' });
      if (!(ALLOWED.has(method) || (method === 'batch' && batchAllowed(body)))) return send(403, { error: 'method not allowed' });
      try {
        const r = await fetch(HOOK + method + '.json', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(await r.text());
      } catch (e) { send(502, { error: 'bitrix unreachable', error_description: String(e.message || e) }); }
    });
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(html());
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Leaderboard on :' + PORT));
