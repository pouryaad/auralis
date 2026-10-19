// Bekanntmachungsservice / Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de) – tägliche eForms-Exporte, ohne Schlüssel.
// Endpunkt laut OpenAPI-Spezifikation (oeffentlichevergabe.de/documentation/api/opendata, live geprüft 14.10.2026):
// GET /api/notice-exports?pubDay=YYYY-MM-DD&format=eforms.zip – ZIP mit einer XML-Datei je Bekanntmachungsversion. Lizenz: CC0.
// Enthält Bekanntmachungen von Bund, Ländern und Kommunen, auch unterhalb der EU-Schwellenwerte.
// EU-weite Bekanntmachungen (Rechtsgrundlage EU-Richtlinie) werden standardmäßig übersprungen, weil TED sie liefert.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request, sleep, isoDate, todayIso, addDays, cleanUrl, toTender, isBareUrl } from '../lib.js';
import { readZip } from '../zip.js';
import { parseNotice } from '../eforms.js';

const DEFAULT_ENDPOINT = 'https://oeffentlichevergabe.de/api/notice-exports';
const isEuDirective = (lb) => /^3\d{4}L\d{4}$/.test(String(lb).trim()); // CELEX einer EU-Richtlinie, z. B. 32014L0024

/** Eine geparste Bekanntmachung in das Dashboard-Format (rein, testbar). */
export function mapEforms(n, srcId = 'oev', env = process.env, today = todayIso()) {
  const tpl = env.OEV_NOTICE_URL_TEMPLATE; // optional, z. B. Detailseite im Bekanntmachungsservice; Platzhalter {id}
  const notice = tpl && n.noticeId ? tpl.replace('{id}', encodeURIComponent(n.noticeId)) : null;
  // Unterlagen-Link (BT-15) zeigt auf das Verfahren auf der Plattform; AccessToolsURI ist ein weiterer Plattform-Link.
  const docsRaw = cleanUrl(n.documentsUrl), acc = cleanUrl(n.accessUrl), subRaw = cleanUrl(n.submissionUrl);
  const docs = docsRaw && !isBareUrl(docsRaw) ? docsRaw : (acc && !isBareUrl(acc) ? acc : docsRaw || acc);
  const sub = subRaw && !isBareUrl(subRaw) ? subRaw : null;
  const td = [...n.tenderDeadlines].map(isoDate).filter(Boolean).sort(), rd = [...n.requestDeadlines].map(isoDate).filter(Boolean).sort();
  const nextT = td.find((d) => d >= today), nextR = rd.find((d) => d >= today);
  const deadline = nextT || nextR || td[td.length - 1] || rd[rd.length - 1] || null;
  return toTender({
    id: `oev:${n.folder || n.noticeId}`, src: srcId, title: n.title, buyer: n.buyer, nuts: n.nuts.length ? n.nuts : [n.buyerNuts],
    country: n.country || 'DEU', cpv: n.cpv, published: isoDate(n.issued), deadline, deadlineKind: nextT || (!nextR && td.length) ? 'tender' : 'request',
    value: !n.currency || n.currency === 'EUR' ? n.value : NaN, currency: 'EUR', description: n.description,
    url: notice || docs || sub, urlKind: notice ? 'notice' : 'platform',
    apply: sub || docs, applyKind: sub ? 'submission' : docs ? 'documents' : undefined,
  });
}

async function dayExport(endpoint, day, fmt) {
  const pubDay = fmt === 'compact' ? day.replace(/-/g, '') : day;
  const url = `${endpoint}?pubDay=${pubDay}&format=eforms.zip`;
  const { buf } = await request(url, { accept: 'application/zip, application/octet-stream, */*', timeoutMs: 120000, retries: 2 });
  if (buf.length > 300 * 1024 * 1024) throw new Error(`Export ${day} zu groß`);
  const events = [];
  for (const entry of readZip(buf)) {
    if (!/\.xml$/i.test(entry.name)) continue;
    const n = parseNotice(entry.data.toString('utf8'), entry.name);
    if (n && (n.folder || n.noticeId)) events.push(n);
  }
  return events;
}

export async function fetchOev({ id = 'oev', env = process.env, log = console.log, cacheDir } = {}) {
  const endpoint = env.OEV_ENDPOINT || DEFAULT_ENDPOINT;
  const days = Math.min(Math.max(Number(env.OEV_DAYS) || 45, 1), 120), delay = Number(env.OEV_DELAY_MS) || 1500;
  const includeEu = env.OEV_INCLUDE_EU === '1';
  const today = todayIso(), warnings = [];
  if (cacheDir) await mkdir(cacheDir, { recursive: true }).catch(() => { warnings.push('Cache-Ordner nicht beschreibbar, Exporte werden jedes Mal neu geladen.'); cacheDir = null; });
  let fmt = 'iso', okDays = 0, missing = 0, fetched = 0, failedStart = 0;
  const byFolder = new Map();
  for (let i = days; i >= 1; i--) { // ältester Tag zuerst; heutiger Export ist meist noch nicht fertig
    const day = addDays(today, -i);
    const cacheFile = cacheDir && join(cacheDir, `oev-${day}.json`);
    let events = null;
    if (cacheFile && (i > 2 || env.OEV_OFFLINE === '1')) { try { events = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {} }
    if (!events && env.OEV_OFFLINE === '1') { missing++; continue; }
    if (!events) {
      try {
        events = await dayExport(endpoint, day, fmt); fetched++;
      } catch (e) {
        if (e.status === 400 && fmt === 'iso' && okDays === 0) { // anderes Datumsformat versuchen
          try { fmt = 'compact'; events = await dayExport(endpoint, day, fmt); fetched++; } catch (e2) { e = e2; fmt = 'iso'; }
        }
        if (!events) {
          if (e.status === 404 || e.status === 204) { missing++; continue; }
          // Einzelne Tage (z. B. HTTP 504 bei noch nicht erzeugtem Export) überspringen; nur wenn die ersten drei Tage scheitern, gilt der Dienst als nicht erreichbar.
          if (okDays === 0 && ++failedStart >= 3) throw Object.assign(e, { message: `Bekanntmachungsservice nicht erreichbar: ${e.message}${e.body ? ' – ' + e.body.slice(0, 200) : ''}` });
          warnings.push(`Export ${day} übersprungen: ${e.message}`); await sleep(delay * 4); continue;
        }
      }
      if (cacheFile) await writeFile(cacheFile, JSON.stringify(events)).catch(() => {});
      await sleep(delay);
    }
    okDays++;
    for (const n of events) {
      const key = n.folder || n.noticeId;
      if (n.kind === 'award') { byFolder.delete(key); continue; } // Zuschlag erteilt: keine offene Ausschreibung mehr
      if (n.kind !== 'call') continue;
      if (!includeEu && isEuDirective(n.legalBasis)) continue;
      byFolder.set(key, n); // spätere Version (Berichtigung) ersetzt frühere
    }
    if (fetched && fetched % 10 === 0) log(`[${id}] ${okDays} Tage verarbeitet …`);
  }
  if (okDays === 0) throw new Error(`Bekanntmachungsservice: für ${days} Tage keine Exporte erhalten (${missing}× nicht vorhanden)`);
  if (missing > days / 3) warnings.push(`${missing} von ${days} Tagesexporten fehlten.`);
  const tenders = [], noLink = [];
  for (const n of byFolder.values()) { const t = mapEforms(n, id, env, today); if (t) tenders.push(t); else noLink.push(n); }
  if (noLink.length) warnings.push(`${noLink.length} Bekanntmachungen ohne Link zu Unterlagen oder Plattform übersprungen.`);
  return { tenders: tenders.filter((t) => !t.deadline || t.deadline >= today), warnings, stats: { days: okDays, missing, fetched } };
}
