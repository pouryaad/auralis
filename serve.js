// Liefert public/ aus (Dashboard + data/tenders.json). Mit --daemon wird zusätzlich regelmäßig aktualisiert.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runIngest } from './src/run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};
let state = { running: false, last: null, lastError: null };

http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...state })); }
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403); return res.end(); }
    const st = await stat(file);
    if (!st.isFile()) throw new Error('kein File');
    let body = await readFile(file);
    const ext = extname(file);
    const headers = { ...SECURITY, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.json' ? 'no-cache' : 'public, max-age=300', 'Last-Modified': st.mtime.toUTCString() };
    if (ext === '.json') headers['Access-Control-Allow-Origin'] = '*';
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024 && /json|html|javascript|css/.test(headers['Content-Type'])) { body = gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, SECURITY); res.end('Nicht gefunden'); }
}).listen(PORT, HOST, () => console.log(`Dashboard: http://localhost:${PORT}`));

if (process.argv.includes('--daemon')) {
  const minutes = Math.max(15, Number(process.env.INTERVAL_MINUTES) || 60); // höchstens alle 15 Minuten
  const tick = async () => {
    if (state.running) return; // keine überlappenden Läufe
    state.running = true;
    try { await runIngest(); state.last = new Date().toISOString(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Abruf fehlgeschlagen:', e.message); }
    finally { state.running = false; }
  };
  tick(); setInterval(tick, minutes * 60 * 1000);
}
