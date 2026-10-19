// Gemeinsame Hilfsfunktionen: HTTP mit Wiederholung, Datums-/Text-Helfer, NUTS- und CPV-Zuordnung, Ausgabeformat.

export const UA = () =>
  `AuralisIngest/1.1 (+${process.env.CONTACT_EMAIL ? 'mailto:' + process.env.CONTACT_EMAIL : 'kein-kontakt-hinterlegt'})`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP-Grundfunktion: Timeout, Wiederholung mit Backoff bei 429/5xx/Netzwerkfehlern, Retry-After wird beachtet.
 * 4xx (außer 408/429) werden nicht wiederholt. Liefert { status, headers, buf }. Fehler tragen .status und .body.
 */
export async function request(url, { method = 'GET', headers = {}, body, retries = 3, timeoutMs = 45000, accept = 'application/json' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA(), Accept: accept, ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'follow',
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok) return { status: res.status, headers: res.headers, buf };
      const e = new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
      e.status = res.status; e.body = buf.toString('utf8', 0, Math.min(buf.length, 600));
      if ((res.status === 429 || res.status === 408 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        lastErr = e; await sleep((ra > 0 ? Math.min(ra, 120) * 1000 : 1500 * 2 ** attempt) + Math.random() * 400); continue;
      }
      throw e;
    } catch (err) {
      if (err.status) throw err; // HTTP-Fehler oben bereits entschieden
      const e = err.name === 'AbortError' ? new Error(`Zeitüberschreitung nach ${timeoutMs / 1000} s`) : err;
      if (err.cause && !/\(/.test(e.message)) e.message += ` (${err.cause.code || err.cause.message})`;
      lastErr = e;
      if (attempt < retries) { await sleep(1500 * 2 ** attempt + Math.random() * 400); continue; }
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

/** JSON-Anfrage (Name "http" bleibt für bestehende Aufrufer erhalten). */
export async function http(url, opts = {}) {
  const { buf } = await request(url, opts);
  try { return JSON.parse(buf.toString('utf8')); }
  catch { const e = new Error('Antwort ist kein gültiges JSON'); e.body = buf.toString('utf8', 0, 300); throw e; }
}

/** Mehrsprachige Felder (String | Array | {deu:..., eng:...}) auf einen Text reduzieren. */
export function pickText(v, prefer = ['deu', 'DEU', 'de', 'eng', 'ENG', 'en']) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) { for (const x of v) { const t = pickText(x, prefer); if (t) return t; } return ''; }
  if (typeof v === 'object') {
    for (const k of prefer) if (v[k] != null) { const t = pickText(v[k], prefer); if (t) return t; }
    for (const k of Object.keys(v)) { const t = pickText(v[k], prefer); if (t) return t; }
  }
  return '';
}

export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Liest ein Datum wie "2026-10-12+02:00", "20261012" oder ISO und liefert "YYYY-MM-DD" oder null. */
export function isoDate(v) {
  const s = pickText(v);
  const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Lokales Datum (Europe/Berlin) als YYYY-MM-DD; Fristen sind in Ortszeit angegeben. */
export const todayIso = (d = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Wert per Punktpfad lesen ("urls.notice"). */
export function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u.trim());

/** Schreibweisen wie "www.x.de/abc" zu https ergänzen; alles andere verwerfen. */
export function cleanUrl(u) {
  let s = pickText(u).trim();
  if (!s) return null;
  if (/^www\./i.test(s)) s = 'https://' + s;
  return isHttpUrl(s) ? s : null;
}

/** TED-Titel haben die Form "Land – CPV-Bezeichnung – Titel"; die ersten beiden Teile werden entfernt. */
const COUNTRY_PREFIX = /^(Deutschland|Österreich|Schweiz|Germany|Austria|Switzerland)$/;
export function cleanTitle(t) {
  const parts = String(t || '').split(' – ');
  return parts.length >= 3 && COUNTRY_PREFIX.test(parts[0].trim()) ? parts.slice(2).join(' – ').trim() : String(t || '').trim();
}

/** true, wenn eine URL nur aus Host besteht (z. B. https://www.plattform.de) und nicht auf ein konkretes Verfahren zeigt. */
export const isBareUrl = (u) => { try { const x = new URL(u); return (x.pathname === '/' || x.pathname === '') && !x.search; } catch { return true; } };

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

// --- NUTS -> Land / Bundesland ---------------------------------------------------------------
const DE = { DE1: 'Baden-Württemberg', DE2: 'Bayern', DE3: 'Berlin', DE4: 'Brandenburg', DE5: 'Bremen', DE6: 'Hamburg', DE7: 'Hessen',
  DE8: 'Mecklenburg-Vorpommern', DE9: 'Niedersachsen', DEA: 'Nordrhein-Westfalen', DEB: 'Rheinland-Pfalz', DEC: 'Saarland',
  DED: 'Sachsen', DEE: 'Sachsen-Anhalt', DEF: 'Schleswig-Holstein', DEG: 'Thüringen' };
const AT = { AT11: 'Burgenland', AT12: 'Niederösterreich', AT13: 'Wien', AT21: 'Kärnten', AT22: 'Steiermark', AT31: 'Oberösterreich',
  AT32: 'Salzburg', AT33: 'Tirol', AT34: 'Vorarlberg' };
const COUNTRY = { DEU: 'Deutschland', DE: 'Deutschland', AUT: 'Österreich', AT: 'Österreich', CHE: 'Schweiz', CH: 'Schweiz' };

/** Liefert { land, region } aus NUTS-Codes und/oder Länderkürzel. region = null, wenn nicht bestimmbar. */
export function locate(nutsCodes, countryCode) {
  for (const c of asArray(nutsCodes).map((x) => String(x).toUpperCase().trim())) {
    if (/^DE[0-9A-G]/.test(c) && DE[c.slice(0, 3)]) return { land: 'Deutschland', region: DE[c.slice(0, 3)] };
    if (/^AT\d\d/.test(c) && AT[c.slice(0, 4)]) return { land: 'Österreich', region: AT[c.slice(0, 4)] };
  }
  const land = COUNTRY[String(pickText(countryCode) || '').toUpperCase()] || null;
  return { land, region: null };
}

// --- CPV -> Dashboard-Kategorie ---------------------------------------------------------------
// Medien: 921 Film/Video, 922 Radio/TV, 924 Nachrichtenagenturen, 79961-79963 Fotografie, 79340/79341 Werbung,
// 79416 Öffentlichkeitsarbeit, 79822500 Grafikdesign, 64228 Rundfunkübertragung.
export const MEDIA_CPV = /^(921|922|924|79961|79962|79963|79340|79341|79416|798225|64228)/;
// Präzise Titelbegriffe (normalisiert, ohne Umlaute), damit z. B. "Hydraulikpresse" oder "Produktionsanlage" NICHT als Medien gelten.
export const MEDIA_TITLE = /(medien(produktion|agentur|dienst|gestaltung|arbeit)|content[- ]?(produktion|erstellung|creation)|(image|lehr|erklar|dokumentar|werbe|kurz|schulungs)film|film(produktion|dreh|aufnahme|herstellung)|serien?produktion|video(produktion|dienst|aufnahme|dreh|clip|grafik|schnitt)|foto(graf|dienst|produktion|dokumentation|aufnahme|shooting)|livestream|podcast|rundfunk|mediathek|social[- ]media|bewegtbild|postproduktion|redaktionelle)/;

const DIV = { '72': 'IT & Software', '48': 'IT & Software', '30': 'IT & Software', '32': 'IT & Software', '45': 'Bau', '71': 'Bau', '44': 'Bau',
  '79': 'Beratung', '73': 'Beratung', '75': 'Beratung', '33': 'Medizintechnik', '85': 'Medizintechnik', '09': 'Energie', '65': 'Energie', '31': 'Energie',
  '34': 'Verkehr', '60': 'Verkehr', '63': 'Logistik', '64': 'Logistik', '80': 'Bildung', '90': 'Umwelt', '77': 'Umwelt',
  '35': 'Sicherheit' };
export const CATEGORIES = ['IT & Software', 'Bau', 'Beratung', 'Medizintechnik', 'Energie', 'Verkehr', 'Bildung', 'Umwelt', 'Sicherheit', 'Logistik', 'Medien', 'Sonstige'];

const cpvDigits = (c) => String(c).replace(/\D/g, '');
export function categorize(cpvCodes) {
  const codes = asArray(cpvCodes).map(cpvDigits).filter((c) => c.length >= 2);
  for (const c of codes) if (MEDIA_CPV.test(c)) return 'Medien';
  for (const c of codes) if (DIV[c.slice(0, 2)]) return DIV[c.slice(0, 2)];
  return 'Sonstige';
}

/** IDs nur aus unkritischen Zeichen (sie landen in HTML-Attributen des Dashboards). */
export const safeId = (s) => String(s).replace(/[^\w:.\-]/g, '_').slice(0, 160);

/** Einheitliches Ausgabeformat. Gibt null zurück, wenn Pflichtfelder fehlen (ID, Titel, Link zur Bekanntmachung). */
export function toTender(x) {
  const title = pickText(x.title).replace(/\s+/g, ' ').trim();
  const url = cleanUrl(x.url);
  if (!title || !x.id || !url) return null;
  const cpv = [...new Set(asArray(x.cpv).map(cpvDigits).filter((c) => c.length >= 8).map((c) => c.slice(0, 8)))];
  const loc = locate(x.nuts, x.country);
  const apply = cleanUrl(x.apply);
  const cat = x.cat || categorize(cpv);
  const value = Number(x.value);
  return {
    id: safeId(x.id),
    src: safeId(x.src || 'unbekannt'),
    title: title.slice(0, 400),
    buyer: pickText(x.buyer).replace(/\s+/g, ' ').trim().slice(0, 200) || null,
    cat,
    media: cat === 'Medien' || MEDIA_TITLE.test(norm(title)),
    cpv: cpv.slice(0, 6),
    land: x.land || loc.land,
    region: x.region || loc.region,
    published: x.published || null,
    deadline: x.deadline || null,
    deadlineKind: x.deadline ? (x.deadlineKind || 'tender') : null,
    // Platzhalterwerte wie 1 € (live bei TED beobachtet) gelten als nicht angegeben
    value: Number.isFinite(value) && value >= 100 ? Math.round(value) : null,
    currency: Number.isFinite(value) && value >= 100 ? (x.currency || 'EUR') : null,
    url,
    urlKind: x.urlKind === 'platform' ? 'platform' : 'notice',
    apply: apply || url,
    applyKind: apply ? (x.applyKind || 'direct') : 'notice',
    description: pickText(x.description).replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

// Berichtigungen erscheinen bei TED (und teils im Bekanntmachungsservice) als neue Bekanntmachung desselben Verfahrens.
// Gleiche Quelle + gleicher Titel + gleicher Auftraggeber + gleiche Frist + gleicher Plattform-Link = dasselbe Verfahren;
// die neueste Fassung bleibt. Bei Links auf eine reine Startseite wird nicht zusammengeführt (zu unspezifisch).
export function dedupeRepublished(list) {
  const key = (t) => {
    const link = t.src === 'ted' ? t.apply : t.url;
    if (!link || isBareUrl(link)) return null;
    return [t.src, norm(t.title).trim(), norm(t.buyer).trim(), t.deadline || '', link].join('\u0001');
  };
  const best = new Map(); const out = [];
  for (const t of list) {
    const k = key(t);
    if (!k) { out.push(t); continue; }
    const cur = best.get(k);
    if (!cur || (t.published || '') > (cur.published || '') || ((t.published || '') === (cur.published || '') && t.id > cur.id)) best.set(k, t);
  }
  return out.concat([...best.values()]);
}
