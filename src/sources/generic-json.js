// Allgemeiner JSON-Adapter für kommerzielle oder weitere öffentliche Quellen (Konfiguration in sources.json).
// Zugangsdaten stehen NIE in sources.json, sondern als ${ENV_VARIABLE} und werden aus der Umgebung gelesen.
import { http, sleep, getPath, isoDate, asArray, pickText, toTender } from '../lib.js';

export class MissingCredentials extends Error {
  constructor(vars) { super(`Zugangsdaten fehlen: ${vars.join(', ')}`); this.vars = vars; this.skipped = true; }
}

export function interpolate(str, env = process.env, missing = []) {
  return String(str).replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => { if (!env[k]) missing.push(k); return env[k] || ''; });
}

export function mapItem(item, map, srcId) {
  const g = (k) => getPath(item, map[k]);
  const value = Number(g('value'));
  return toTender({
    id: `${srcId}:${pickText(g('id'))}`, src: srcId, title: pickText(g('title')), buyer: pickText(g('buyer')),
    published: isoDate(g('published')), deadline: isoDate(g('deadline')), url: pickText(g('notice')), apply: pickText(g('apply')),
    nuts: asArray(g('region')).map(String), country: pickText(g('country')) || 'DE', cpv: asArray(g('cpv')).map(String),
    description: pickText(g('description')), value: Number.isFinite(value) ? value : NaN, currency: pickText(g('currency')) || 'EUR',
  });
}

export async function fetchGeneric(cfg, { env = process.env, log = console.log } = {}) {
  const missing = [];
  const url = interpolate(cfg.request.url, env, missing);
  const headers = Object.fromEntries(Object.entries(cfg.request.headers || {}).map(([k, v]) => [k, interpolate(v, env, missing)]));
  const query = Object.fromEntries(Object.entries(cfg.request.query || {}).map(([k, v]) => [k, interpolate(v, env, missing)]));
  if (missing.length) throw new MissingCredentials([...new Set(missing)]);
  const pg = cfg.pagination || { maxPages: 1 };
  const tenders = new Map();
  for (let page = pg.start ?? 1, n = 0; n < (pg.maxPages || 1); page++, n++) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    if (pg.pageParam) u.searchParams.set(pg.pageParam, String(page));
    if (pg.sizeParam) u.searchParams.set(pg.sizeParam, String(pg.size || 100));
    const body = cfg.request.body ? JSON.parse(interpolate(JSON.stringify(cfg.request.body), env, [])) : undefined;
    const res = await http(u.toString(), { method: cfg.request.method || 'GET', headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body });
    const items = asArray(cfg.itemsPath ? getPath(res, cfg.itemsPath) : res);
    for (const it of items) { const t = mapItem(it, cfg.map, cfg.id); if (t) tenders.set(t.id, t); }
    log(`[${cfg.id}] Seite ${page}: ${items.length} Einträge`);
    if (!pg.pageParam || items.length < (pg.size || 100)) break;
    await sleep(300);
  }
  return { tenders: [...tenders.values()], warnings: [] };
}
