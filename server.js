// Nephora Leaderboard — Node-сервер без зависимостей.
// Отдаёт index.html и проксирует ТОЛЬКО чтение нужных методов Bitrix24.
// ENV: BITRIX_WEBHOOK (обязательно), DASH_USER / DASH_PASSWORD (базовая авторизация, по желанию).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const HOOK = (process.env.BITRIX_WEBHOOK || '').replace(/\/?$/, '/');
const USER = process.env.DASH_USER || 'admin', PASS = process.env.DASH_PASSWORD || '';
const ALLOWED = new Set(['department.get', 'user.get', 'crm.stagehistory.list', 'crm.deal.list']);
const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));

function authed(req) {
  if (!PASS) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [u, ...p] = Buffer.from(m[1], 'base64').toString().split(':');
  return u === USER && p.join(':') === PASS;
}
function batchAllowed(body) {
  const cmds = [...new URLSearchParams(body)].filter(([k]) => /^cmd\[/.test(k)).map(([, v]) => v.split('?')[0]);
  return cmds.length > 0 && cmds.every(m => ALLOWED.has(m));
}

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Leaderboard"' }); return res.end('Auth required'); }

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
