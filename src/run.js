// Orchestrator: ruft alle aktivierten Quellen ab, behandelt Fehler je Quelle getrennt und schreibt public/data/tenders.json.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchTed } from './sources/ted.js';
import { fetchOev } from './sources/oev.js';
import { fetchGeneric, MissingCredentials } from './sources/generic-json.js';
import { todayIso, addDays, dedupeRepublished } from './lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_DAYS_AFTER_DEADLINE = 3;
const MAX_TENDERS = 20000;

async function readJson(path, fallback, { required = false } = {}) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (e) { if (required) throw new Error(`${path} fehlt`); return fallback; }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${path} ist kein gültiges JSON: ${e.message}`); }
}

export async function runIngest({ log = console.log, env = process.env } = {}) {
  const OUT = env.AURALIS_OUT || join(ROOT, 'public', 'data', 'tenders.json');
  const cfg = await readJson(env.AURALIS_SOURCES || join(ROOT, 'sources.json'), null, { required: true });
  if (!Array.isArray(cfg.sources)) throw new Error('sources.json: Feld "sources" (Liste) fehlt');
  let previous = { tenders: [], sources: [] };
  try { previous = await readJson(OUT, previous); } catch (e) { log(`Hinweis: vorheriger Feed unlesbar (${e.message}), starte leer.`); }
  if (!Array.isArray(previous.tenders)) previous.tenders = [];
  const meta = [], fresh = [];
  for (const s of cfg.sources) {
    const base = { id: s.id, name: s.name, homepage: s.homepage || '', license: s.license || '', type: s.type, coverage: s.coverage || '' };
    if (!s.enabled) { meta.push({ ...base, status: 'disabled', count: 0 }); continue; }
    const t0 = Date.now();
    try {
      let res;
      if (s.type === 'ted') res = await fetchTed({ id: s.id, env, log });
      else if (s.type === 'oev') res = await fetchOev({ id: s.id, env, log, cacheDir: env.AURALIS_CACHE || join(ROOT, '.cache') });
      else if (s.type === 'generic-json') res = await fetchGeneric(s, { env, log });
      else throw new Error(`Unbekannter Quellentyp: ${s.type}`);
      fresh.push(...res.tenders);
      meta.push({ ...base, status: 'ok', count: res.tenders.length, lastSuccess: new Date().toISOString(), durationMs: Date.now() - t0, warnings: res.warnings || [], stats: res.stats || null });
      log(`[${s.id}] OK: ${res.tenders.length} offene Ausschreibungen${res.warnings?.length ? ` (${res.warnings.length} Hinweise)` : ''}`);
    } catch (e) {
      const old = (previous.sources || []).find((x) => x.id === s.id) || {};
      const kept = previous.tenders.filter((t) => t.src === s.id).map((t) => ({ ...t, stale: true }));
      fresh.push(...kept);
      meta.push({ ...base, status: e instanceof MissingCredentials ? 'needs-credentials' : 'error', count: kept.length, lastSuccess: old.lastSuccess || null,
        error: String(e.message || e).slice(0, 600), keptStale: kept.length });
      log(`[${s.id}] FEHLER: ${e.message}${kept.length ? ` (${kept.length} ältere Einträge behalten)` : ''}`);
    }
  }
  // Duplikate zusammenführen, abgelaufene entfernen (kurze Kulanz, damit "heute abgelaufen" noch sichtbar ist)
  const cutoff = addDays(todayIso(), -KEEP_DAYS_AFTER_DEADLINE);
  const map = new Map();
  for (const t of fresh) if (!t.deadline || t.deadline >= cutoff) if (!map.has(t.id) || !t.stale) map.set(t.id, t);
  let tenders = dedupeRepublished([...map.values()]).sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  if (tenders.length > MAX_TENDERS) tenders = tenders.slice(0, MAX_TENDERS);
  const feed = { schema: 1, generatedAt: new Date().toISOString(), today: todayIso(), sources: meta, tenders };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT + '.tmp', JSON.stringify(feed));
  await rename(OUT + '.tmp', OUT); // atomar
  const ok = meta.filter((m) => m.status === 'ok').length, active = meta.filter((m) => m.status !== 'disabled').length;
  log(`Fertig: ${tenders.length} Ausschreibungen, ${ok}/${active} aktive Quellen erfolgreich → ${OUT}`);
  return { feed, ok, active };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  runIngest().then(({ ok, active, feed }) => {
    if (check) for (const s of feed.sources) console.log(`\n${s.id}: ${s.status}${s.error ? '\n  Fehler: ' + s.error : ''}${(s.warnings || []).map((w) => '\n  Hinweis: ' + w).join('')}`);
    process.exit(active > 0 && ok === 0 ? 1 : 0);
  }).catch((e) => { console.error('Abbruch:', e.message); process.exit(2); });
}
