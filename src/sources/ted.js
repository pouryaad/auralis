// TED (Tenders Electronic Daily, EU) – Such-API v3, anonym nutzbar.
// Doku: https://docs.ted.europa.eu/api/latest/search.html · Feldliste: https://docs.ted.europa.eu/ODS/latest/reuse/field-list.html
// Abgedeckt: EU-weite (oberschwellige) Bekanntmachungen. Unterschwellige nationale Vergaben liefert die Quelle "oev".
//
// Geprüfte Fakten (Doku + Praxisberichte): POST /v3/notices/search, kein Schlüssel; paginationMode ITERATION mit
// iterationNextToken (PAGE_NUMBER bricht bei 15.000 ab); limit ≤ 250; Länder als ISO-3; "notice-type IN (cn-standard)"
// filtert Ausschreibungen (ohne Filter kämen auch Zuschlagsbekanntmachungen); Fristen je Los als Liste; 200 mit
// timedOut=true bedeutet Teilergebnis; anonyme Abrufe werden gedrosselt (429).
import { http, sleep, pickText, asArray, isoDate, todayIso, addDays, cleanUrl, toTender, cleanTitle, isBareUrl } from '../lib.js';

const DEFAULT_ENDPOINT = 'https://api.ted.europa.eu/v3/notices/search';
export const CORE = ['publication-number', 'notice-title', 'buyer-name', 'buyer-country', 'publication-date', 'notice-type',
  'classification-cpv', 'deadline-receipt-tender-date-lot', 'links'];
// Optional: Werden sie abgelehnt, prüft der Abruf jedes Feld einzeln und lässt nur unbekannte weg.
export const OPTIONAL = ['deadline-receipt-request-date-lot', 'deadline-receipt-request', 'deadline-receipt-expressions-date-lot',
  'document-url-lot', 'submission-url-lot', 'buyer-city', 'estimated-value-proc', 'estimated-value-cur-proc', 'estimated-value-lot',
  'estimated-value-cur-lot', 'description-proc', 'description-lot', 'place-of-performance', 'place-of-performance-subdiv-lot'];
const CALL_TYPES = ['cn-standard', 'cn-social', 'cn-desg', 'pin-cfc-standard', 'pin-cfc-social', 'subco'];
const isCall = (t) => !t || /^(cn-|pin-cfc|subco)/.test(t);

export function buildQuery(env = process.env, types = CALL_TYPES) {
  const countries = (env.TED_COUNTRIES || 'DEU,AUT').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s));
  const days = Math.min(Math.max(Number(env.TED_DAYS) || 120, 7), 400);
  const since = addDays(todayIso(), -days).replace(/-/g, '');
  const parts = [];
  if (types && types.length) parts.push(`notice-type IN (${types.join(' ')})`);
  parts.push(`buyer-country IN (${(countries.length ? countries : ['DEU']).join(' ')})`);
  parts.push(`publication-date>=${since}`);
  if (env.TED_EXTRA_QUERY && env.TED_EXTRA_QUERY.trim()) parts.push(`(${env.TED_EXTRA_QUERY.replace(/[\\"]/g, '').trim()})`);
  return parts.join(' AND ') + ' SORT BY publication-number DESC';
}

const urls = (v) => asArray(v).flatMap((x) => (x && typeof x === 'object' ? Object.values(x).flat() : [x])).map(cleanUrl).filter(Boolean);
const dates = (v) => asArray(v).flatMap((x) => (x && typeof x === 'object' ? Object.values(x).flat() : [x])).map(isoDate).filter(Boolean).sort();

/** Wandelt eine TED-Zeile in das Dashboard-Format. Rein, ohne Netzwerk (testbar). */
export function mapNotice(n, srcId = 'ted', today = todayIso()) {
  const pn = pickText(n['publication-number']);
  if (!pn || !/^[\w-]+$/.test(pn)) return null;
  const links = n.links || {};
  const pickLink = (o) => cleanUrl(pickText(o, ['DEU', 'deu', 'ENG', 'eng']));
  const url = pickLink(links.html) || pickLink(links.htmlDirect) || `https://ted.europa.eu/de/notice/-/detail/${pn}`;
  let deadline = null, deadlineKind = null;
  for (const [field, kind] of [['deadline-receipt-tender-date-lot', 'tender'], ['deadline-receipt-request-date-lot', 'request'], ['deadline-receipt-request', 'request'], ['deadline-receipt-expressions-date-lot', 'interest']]) {
    const ds = dates(n[field]);
    const next = ds.find((d) => d >= today);
    if (next) { deadline = next; deadlineKind = kind; break; }
    if (ds.length && !deadline) { deadline = ds[ds.length - 1]; deadlineKind = kind; }
  }
  const cur = pickText(n['estimated-value-cur-proc']) || pickText(n['estimated-value-cur-lot']);
  const rawVal = asArray(n['estimated-value-proc']).concat(asArray(n['estimated-value-lot'])).map(Number).find((x) => Number.isFinite(x) && x > 0);
  // Live beobachtet: submission-url-lot ist oft nur die Startseite der Plattform; dann ist der Unterlagen-Link (BT-15) genauer.
  const subs = urls(n['submission-url-lot']), docs = urls(n['document-url-lot']);
  const subSpecific = subs.find((u) => !isBareUrl(u)), documents = docs.find((u) => !isBareUrl(u)) || docs[0];
  const submission = subSpecific || (!documents ? subs[0] : undefined);
  return toTender({
    id: `ted:${pn}`, src: srcId, title: cleanTitle(pickText(n['notice-title'])), buyer: pickText(n['buyer-name']),
    country: pickText(n['buyer-country']), nuts: asArray(n['place-of-performance-subdiv-lot']).concat(asArray(n['place-of-performance'])).map(String),
    cpv: asArray(n['classification-cpv']).map(String), published: isoDate(n['publication-date']), deadline, deadlineKind,
    value: !cur || cur === 'EUR' ? rawVal : NaN, currency: 'EUR', url,
    apply: submission || documents, applyKind: submission ? 'submission' : documents ? 'documents' : undefined,
    description: pickText(n['description-proc']) || pickText(n['description-lot']),
  });
}

export async function fetchTed({ id = 'ted', env = process.env, log = console.log } = {}) {
  const ENDPOINT = env.TED_ENDPOINT || DEFAULT_ENDPOINT;
  // Live geprüft (14.10.2026): limit 250 funktioniert; DEU+AUT, 120 Tage ≈ 27.000 Treffer, davon ≈ 8.000 mit offener Frist.
  const limit = Math.min(Math.max(Number(env.TED_PAGE_SIZE) || 250, 10), 250);
  const maxPages = Number(env.TED_MAX_PAGES) || 160, delay = Math.max(Number(env.TED_DELAY_MS) || 500, 0);
  const post = (body) => http(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const warnings = [];
  const variants = [
    { query: buildQuery(env), scope: 'ACTIVE' },
    { query: buildQuery(env, ['cn-standard']), scope: 'ACTIVE', warn: 'Erweiterte Bekanntmachungsarten abgelehnt, nur "cn-standard" wird abgefragt.' },
    { query: buildQuery(env, []), scope: 'ACTIVE', localTypeFilter: true, warn: 'Filter "notice-type" abgelehnt, Ausschreibungen werden lokal herausgefiltert.' },
  ];

  // 1) Abfrage und Felder prüfen (je 1 Ergebnis), nur bei Ablehnung schrittweise eingrenzen
  let v = 0, fields = [...CORE, ...OPTIONAL];
  const probe = (vv, f) => post({ query: variants[vv].query, fields: f, limit: 1, scope: variants[vv].scope, paginationMode: 'ITERATION' });
  try { await probe(v, fields); } catch (e) {
    if (e.status !== 400) throw wrap(e, 'Verbindung');
    let coreOk = false;
    for (; v < variants.length; v++) {
      try { await probe(v, CORE); coreOk = true; break; } catch (e2) { if (e2.status !== 400) throw wrap(e2, 'Verbindung'); }
      await sleep(delay);
    }
    if (!coreOk) throw wrap(e, 'Abfrage von TED abgelehnt – bitte Feldnamen/Syntax mit https://api.ted.europa.eu/swagger abgleichen');
    if (variants[v].warn) warnings.push(variants[v].warn);
    const ok = [], dropped = [];
    for (const f of OPTIONAL) {
      await sleep(delay);
      try { await probe(v, [...CORE, f]); ok.push(f); } catch (e3) { if (e3.status === 400) dropped.push(f); else throw wrap(e3, 'Feldprüfung'); }
    }
    fields = [...CORE, ...ok];
    if (dropped.length) warnings.push(`Von TED nicht unterstützte Zusatzfelder übersprungen: ${dropped.join(', ')}`);
  }

  // 2) Abruf im Iterationsmodus
  const out = new Map(), today = todayIso();
  let token = null, pages = 0, total = null, skippedTypes = 0;
  while (pages < maxPages) {
    const body = { query: variants[v].query, fields, limit, scope: variants[v].scope, paginationMode: 'ITERATION' };
    if (token) body.iterationNextToken = token;
    let res, tries = 0;
    for (;;) {
      try { res = await post(body); } catch (e) { throw wrap(e, `Seite ${pages + 1}`); }
      if (!res.timedOut || ++tries > 2) break;
      await sleep(2000 * tries);
    }
    if (res.timedOut) { warnings.push(`TED meldete Zeitüberschreitung auf Seite ${pages + 1}; Abruf ist unvollständig.`); }
    const rows = asArray(res.notices);
    total = Number.isFinite(res.totalNoticeCount) ? res.totalNoticeCount : total;
    for (const n of rows) {
      if (variants[v].localTypeFilter && !isCall(pickText(n['notice-type']))) { skippedTypes++; continue; }
      const t = mapNotice(n, id, today); if (t) out.set(t.id, t);
    }
    pages++;
    log(`[${id}] Seite ${pages}: ${rows.length} Einträge (insgesamt laut TED: ${total ?? '?'})`);
    token = res.iterationNextToken;
    if (!rows.length || !token || rows.length < limit || res.timedOut) break;
    await sleep(delay);
  }
  if (pages >= maxPages && token) warnings.push(`Abruf nach ${maxPages} Seiten beendet (TED_MAX_PAGES); laut TED gibt es ${total ?? 'weitere'} Treffer.`);
  const tenders = [...out.values()].filter((t) => !t.deadline || t.deadline >= today);
  return { tenders, warnings, stats: { pages, total, skippedTypes, fields: fields.length } };
}

function wrap(e, where) {
  e.message = `TED (${where}): ${e.message}${e.body ? ' – ' + String(e.body).replace(/\s+/g, ' ').slice(0, 300) : ''}`;
  return e;
}
