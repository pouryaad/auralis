// Tests mit SYNTHETISCHEN Testdaten (keine echten Ausschreibungen). Laufen ohne Internet.
// Die Feldformen folgen den am 14.10.2026 live geprüften Antworten von TED und dem Bekanntmachungsservice.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { categorize, locate, isoDate, pickText, toTender, MEDIA_TITLE, norm, addDays, todayIso, safeId, cleanTitle, isBareUrl } from '../src/lib.js';
import { mapNotice, buildQuery } from '../src/sources/ted.js';
import { interpolate, mapItem, fetchGeneric, MissingCredentials } from '../src/sources/generic-json.js';
import { parseNotice, decode } from '../src/eforms.js';
import { readZip } from '../src/zip.js';
import { mapEforms } from '../src/sources/oev.js';
import { runIngest } from '../src/run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = await readFile(join(HERE, 'fixtures', 'cn-national.xml'), 'utf8');

function zip(files) { // kleiner ZIP-Schreiber nur für Tests
  const locals = [], centrals = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), comp = deflateRawSync(data), nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const mock = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s)); });

test('Datumsformate', () => {
  assert.equal(isoDate('2026-11-10+01:00'), '2026-11-10');
  assert.equal(isoDate('20261110'), '2026-11-10');
  assert.equal(isoDate('2026-02-30'), null);
  assert.equal(isoDate(null), null);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
test('Mehrsprachige Felder bevorzugen Deutsch', () => {
  assert.equal(pickText({ eng: 'Film', deu: 'Filmproduktion' }), 'Filmproduktion');
  assert.equal(pickText({ fra: ['x'] }), 'x');
});
test('NUTS → Bundesland', () => {
  assert.deepEqual(locate(['DE212'], 'DEU'), { land: 'Deutschland', region: 'Bayern' });
  assert.deepEqual(locate(['DEA23'], 'DEU'), { land: 'Deutschland', region: 'Nordrhein-Westfalen' });
  assert.deepEqual(locate(['AT130'], 'AUT'), { land: 'Österreich', region: 'Wien' });
  assert.deepEqual(locate([], 'DEU'), { land: 'Deutschland', region: null });
});
test('CPV → Kategorie; Sport (926) ist keine Medienleistung', () => {
  assert.equal(categorize(['72000000']), 'IT & Software');
  assert.equal(categorize(['92111200-4']), 'Medien');
  assert.equal(categorize(['79961000']), 'Medien');
  assert.equal(categorize(['92600000']), 'Sonstige');
  assert.equal(categorize(['45000000']), 'Bau');
  assert.equal(categorize([]), 'Sonstige');
});
test('Medien-Erkennung über Titel ist präzise', () => {
  for (const t of ['Imagefilm-Produktion', 'Fotodokumentation Brückensanierung', 'Videoproduktion Schulung', 'Serienproduktion', 'Content-Produktion', 'Livestream Ratssitzung', 'Fotografin für Events'])
    assert.ok(MEDIA_TITLE.test(norm(t)), t);
  for (const t of ['Hydraulikpresse', 'Produktionsanlage', 'Videoüberwachung Rathaus', 'Schutzfilm für Fenster', 'Photovoltaikanlage', 'Seriennummer-Scanner'])
    assert.ok(!MEDIA_TITLE.test(norm(t)), t);
});
test('toTender: Pflichtfelder, sichere IDs, kein javascript:-Link', () => {
  assert.equal(toTender({ id: 'a', title: '', url: 'https://x.de' }), null);
  assert.equal(toTender({ id: 'a', title: 'T', url: 'javascript:alert(1)' }), null);
  const t = toTender({ id: 'a"><x', title: 'T', url: 'https://x.de/n' });
  assert.equal(t.id, 'a___x'); assert.equal(t.apply, 'https://x.de/n'); assert.equal(t.applyKind, 'notice');
  assert.equal(toTender({ id: 'a', title: 'T', url: 'www.x.de/n' }).url, 'https://www.x.de/n');
  assert.equal(safeId('ted:1-2026'), 'ted:1-2026');
});

test('TED: Abfrage nur Ausschreibungen, Iteration nach Nummer', () => {
  const q = buildQuery({ TED_COUNTRIES: 'DEU, aut,XX', TED_DAYS: '30' });
  assert.match(q, /^notice-type IN \(cn-standard cn-social cn-desg pin-cfc-standard pin-cfc-social subco\) AND buyer-country IN \(DEU AUT\) AND publication-date>=\d{8} SORT BY publication-number DESC$/);
  assert.match(buildQuery({ TED_EXTRA_QUERY: 'FT~("film")' }), /AND \(FT~\(film\)\) SORT/);
});
test('TED: Zeile → Dashboard (Teilnahmefrist als Rückfall, Unterlagen-URL als Bewerbungslink)', () => {
  const t = mapNotice({
    'publication-number': '123456-2099', 'notice-title': { deu: 'Videoproduktion Imagefilm' }, 'buyer-name': { deu: ['Stadt X'] },
    'buyer-country': ['DEU'], 'publication-date': '2099-01-12+02:00', 'deadline-receipt-request-date-lot': ['2099-02-10+01:00'],
    'classification-cpv': ['92111200'], 'place-of-performance-subdiv-lot': ['DE212'], 'estimated-value-proc': 150000, 'estimated-value-cur-proc': 'EUR',
    'document-url-lot': ['https://vergabe.plattform.test/docs/1'], links: { html: { DEU: 'https://ted.europa.eu/de/notice/-/detail/123456-2099' } },
  }, 'ted', '2099-01-15');
  assert.equal(t.id, 'ted:123456-2099'); assert.equal(t.cat, 'Medien'); assert.equal(t.region, 'Bayern');
  assert.equal(t.deadline, '2099-02-10'); assert.equal(t.deadlineKind, 'request'); assert.equal(t.value, 150000);
  assert.equal(t.apply, 'https://vergabe.plattform.test/docs/1'); assert.equal(t.applyKind, 'documents');
});
test('TED: ohne Links wird der offizielle Detail-Link gebaut', () => {
  const t = mapNotice({ 'publication-number': '9-2099', 'notice-title': 'X' });
  assert.equal(t.url, 'https://ted.europa.eu/de/notice/-/detail/9-2099'); assert.equal(t.applyKind, 'notice');
  assert.equal(mapNotice({ 'publication-number': '9"><script>', 'notice-title': 'X' }), null);
});

test('eForms: XML wird korrekt gelesen', () => {
  const n = parseNotice(FIX);
  assert.equal(n.kind, 'call'); assert.equal(n.folder, 'aaaaaaaa-0000-0000-0000-000000000001');
  assert.equal(n.title, 'Imagefilm-Produktion für das Rathaus'); assert.equal(n.buyer, 'Teststadt & Kreis');
  assert.deepEqual(n.cpv, ['92111200']); assert.deepEqual(n.nuts, ['DEA23']); assert.deepEqual(n.tenderDeadlines, ['2099-02-15+01:00']);
  assert.equal(n.documentsUrl, 'https://plattform.test/unterlagen/1'); assert.equal(n.submissionUrl, 'https://plattform.test/abgabe/1');
  assert.equal(n.value, 48000); assert.equal(n.legalBasis, 'other');
  assert.equal(decode('A&#252;&#x3c;'), 'Aü<');
});
test('eForms → Dashboard: Plattform-Link, Abgabe-Link, NRW über Erfüllungsort', () => {
  const t = mapEforms(parseNotice(FIX), 'oev', {}, '2099-01-10');
  assert.equal(t.url, 'https://plattform.test/unterlagen/1'); assert.equal(t.urlKind, 'platform');
  assert.equal(t.apply, 'https://plattform.test/abgabe/1'); assert.equal(t.applyKind, 'submission');
  assert.equal(t.region, 'Nordrhein-Westfalen'); assert.equal(t.cat, 'Medien'); assert.equal(t.deadline, '2099-02-15');
  const tpl = mapEforms(parseNotice(FIX), 'oev', { OEV_NOTICE_URL_TEMPLATE: 'https://oev.test/n/{id}' }, '2099-01-10');
  assert.equal(tpl.url, 'https://oev.test/n/11111111-2222-3333-4444-555555555555'); assert.equal(tpl.urlKind, 'notice');
});
test('Live-Befunde: TED-Titelpräfix, Plattform-Startseite, Platzhalterwert 1 €', () => {
  assert.equal(cleanTitle('Deutschland – Fotokopiergeräte – Digitale Multifunktionssysteme für Schulen'), 'Digitale Multifunktionssysteme für Schulen');
  assert.equal(cleanTitle('Neubau – Los 2 – Fenster'), 'Neubau – Los 2 – Fenster');
  assert.ok(isBareUrl('https://www.meinauftrag.rib.de')); assert.ok(!isBareUrl('https://www.meinauftrag.rib.de/public/x/1'));
  const t = mapNotice({ 'publication-number': '1-2099', 'notice-title': { deu: 'Deutschland – Kopierer – Geräte' }, 'estimated-value-proc': '1', 'estimated-value-cur-proc': 'EUR',
    'submission-url-lot': ['https://www.meinauftrag.rib.de'], 'document-url-lot': ['https://www.meinauftrag.rib.de/public/x/158033'] }, 'ted', '2099-01-01');
  assert.equal(t.title, 'Geräte'); assert.equal(t.value, null);
  assert.equal(t.apply, 'https://www.meinauftrag.rib.de/public/x/158033'); assert.equal(t.applyKind, 'documents');
});
test('eForms ältere Fassung ohne Wurzel-Erweiterung (live beobachtet)', async () => {
  const x = await readFile(join(HERE, 'fixtures', 'cn-sdk01.xml'), 'utf8');
  const n = parseNotice(x);
  assert.equal(n.buyer, 'Landkreis Testland, Vergabestelle'); assert.equal(n.buyerNuts, 'DEE0D', 'Dienstleister-NUTS darf nicht greifen');
  assert.equal(n.legalBasis, 'de-uvgo'); assert.deepEqual(n.tenderDeadlines, ['2099-02-01+01:00']);
  const t = mapEforms(n, 'oev', {}, '2099-01-10');
  assert.equal(parseNotice(x.replace('<cbc:ContractFolderID>folder-sdk01</cbc:ContractFolderID>', '<cbc:ContractFolderID/>'), 'dir/25923334-1.xml').noticeId, '25923334');
  assert.equal(t.region, 'Sachsen-Anhalt'); assert.equal(t.url, 'https://plattform.test/tenderdetails.html?id=1'); assert.equal(t.deadline, '2099-02-01');
});
test('ZIP-Leser', () => {
  const entries = [...readZip(zip({ 'a.xml': '<x/>', 'dir/b.xml': 'Hallo ü' }))];
  assert.deepEqual(entries.map((e) => [e.name, e.data.toString()]), [['a.xml', '<x/>'], ['dir/b.xml', 'Hallo ü']]);
  assert.throws(() => [...readZip(Buffer.from('kein zip'))], /ZIP/);
});
test('Zugangsdaten-Platzhalter: fehlende Variablen werden gemeldet, nie geraten', async () => {
  const miss = []; interpolate('Bearer ${NOPE_KEY}', {}, miss); assert.deepEqual(miss, ['NOPE_KEY']);
  await assert.rejects(fetchGeneric({ id: 'k', request: { url: 'https://a.test', headers: { Authorization: 'Bearer ${NOPE_KEY}' } }, map: {} }, { env: {} }), MissingCredentials);
});
test('generic-json: Mapping per Pfad', () => {
  const t = mapItem({ id: 7, title: 'T', buyer: { name: 'B' }, urls: { notice: 'https://a.de/n', apply: 'https://a.de/b' }, deadline_at: '2099-02-01', nuts_code: 'DE300' },
    { id: 'id', title: 'title', buyer: 'buyer.name', notice: 'urls.notice', apply: 'urls.apply', deadline: 'deadline', region: 'nuts_code' }, 'k');
  assert.equal(t.region, 'Berlin'); assert.equal(t.applyKind, 'direct');
});

test('Ende-zu-Ende: TED (Feldprüfung, Iteration, 500er, timedOut) + Bekanntmachungsservice (ZIP, Zuschlag, EU-Filter) + Teilausfälle', async () => {
  const today = todayIso(), d = (n) => addDays(today, n);
  const row = (n, extra = {}) => ({ 'publication-number': `${n}-2099`, 'notice-title': { deu: `Titel ${n}` }, 'buyer-name': { deu: ['Stadt'] }, 'buyer-country': ['DEU'], 'notice-type': 'cn-standard',
    'publication-date': d(-3), 'deadline-receipt-tender-date-lot': [d(20)], 'classification-cpv': ['72000000'], links: {}, ...extra });
  let fail500 = 1, timedOutOnce = 1, tedCalls = 0;
  const award = FIX.replace(/ContractNotice/g, 'ContractAwardNotice').replace('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
  const callB = FIX.replace('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002').replace('Imagefilm', 'Später vergeben');
  const eu = FIX.replace('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003').replace('<cbc:RegulatoryDomain>other', '<cbc:RegulatoryDomain>32014L0024');
  const fresh = (x) => x.replace(/2099-02-15/g, d(25));
  const srv = await mock((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/fail') { res.writeHead(401); return res.end('nope'); }
      if (u.pathname === '/oev') {
        const day = u.searchParams.get('pubDay');
        if (day === d(-5)) { res.writeHead(504); return res.end('Gateway Time-out'); } // live beobachtet am 20.10.2026
        if (day === d(-3)) { res.writeHead(200); return res.end(zip({ '1.xml': fresh(FIX), '2.xml': fresh(callB), '3.xml': fresh(eu) })); }
        if (day === d(-2)) { res.writeHead(200); return res.end(zip({ '4.xml': fresh(award) })); }
        res.writeHead(404); return res.end();
      }
      tedCalls++;
      const body = JSON.parse(b);
      if (body.fields.includes('submission-url-lot')) { res.writeHead(400); return res.end('{"message":"Unknown field submission-url-lot"}'); }
      if (body.limit === 1) { res.writeHead(200); return res.end(JSON.stringify({ notices: [], totalNoticeCount: 0 })); }
      if (body.iterationNextToken === 't2' && fail500-- > 0) { res.writeHead(500); return res.end('boom'); }
      if (body.iterationNextToken === 't2' && timedOutOnce-- > 0) { res.writeHead(200); return res.end(JSON.stringify({ notices: [], timedOut: true })); }
      const out = !body.iterationNextToken ? { notices: Array.from({ length: 10 }, (_, i) => row(i)), iterationNextToken: 't2', totalNoticeCount: 12 }
        : { notices: [row(100), row(101, { 'deadline-receipt-tender-date-lot': [d(-30)] })], totalNoticeCount: 12 };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  const port = srv.address().port, dir = await mkdtemp(join(tmpdir(), 'au-'));
  const out = join(dir, 'tenders.json'), src = join(dir, 'sources.json');
  await writeFile(src, JSON.stringify({ sources: [
    { id: 'ted', type: 'ted', name: 'TED', enabled: true },
    { id: 'oev', type: 'oev', name: 'OEV', enabled: true },
    { id: 'k', type: 'generic-json', name: 'Kaputt', enabled: true, request: { url: `http://127.0.0.1:${port}/fail` }, map: { id: 'id', title: 't', notice: 'n' } },
    { id: 'c', type: 'generic-json', name: 'Ohne Schlüssel', enabled: true, request: { url: 'https://x.test', headers: { A: '${MISSING_ONE}' } }, map: {} },
    { id: 'off', type: 'ted', name: 'Aus', enabled: false },
  ] }));
  // alter Feed: Einträge der kaputten Quelle bleiben (als veraltet markiert) erhalten
  await writeFile(out, JSON.stringify({ sources: [{ id: 'k', lastSuccess: '2099-01-01T00:00:00Z' }], tenders: [{ id: 'k:1', src: 'k', title: 'Alt', url: 'https://k.test/1', deadline: d(5) }] }));
  const env = { AURALIS_OUT: out, AURALIS_SOURCES: src, AURALIS_CACHE: join(dir, 'cache'), TED_ENDPOINT: `http://127.0.0.1:${port}/ted`, TED_DELAY_MS: '1', TED_PAGE_SIZE: '10',
    OEV_ENDPOINT: `http://127.0.0.1:${port}/oev`, OEV_DAYS: '5', OEV_DELAY_MS: '1' };
  const r = await runIngest({ log: () => {}, env });
  srv.close();
  const feed = JSON.parse(await readFile(out, 'utf8'));
  const m = Object.fromEntries(feed.sources.map((s) => [s.id, s]));
  assert.equal(m.ted.status, 'ok', m.ted.error); assert.equal(m.ted.count, 11, 'abgelaufene TED-Zeile entfernt');
  assert.ok(m.ted.warnings.some((w) => /submission-url-lot/.test(w)), 'abgelehntes Feld gemeldet');
  assert.equal(m.oev.status, 'ok', m.oev.error);
  assert.ok(m.oev.warnings.some((w) => /übersprungen.*504/.test(w)), 'einzelner 504-Tag übersprungen statt Quelle abgebrochen');
  const oev = feed.tenders.filter((t) => t.src === 'oev');
  assert.deepEqual(oev.map((t) => t.title), ['Imagefilm-Produktion für das Rathaus'], 'vergebene und EU-Bekanntmachungen ausgeschlossen');
  assert.equal(m.k.status, 'error'); assert.match(m.k.error, /401/); assert.equal(m.k.keptStale, 1);
  assert.ok(feed.tenders.find((t) => t.id === 'k:1').stale);
  assert.equal(m.c.status, 'needs-credentials'); assert.match(m.c.error, /MISSING_ONE/);
  assert.equal(m.off.status, 'disabled');
  assert.equal(r.ok, 2);
});

test('Berichtigungen desselben Verfahrens werden zusammengeführt, verschiedene Verfahren nicht', async () => {
  const { dedupeRepublished } = await import('../src/lib.js');
  const base = { src: 'ted', title: 'Gebäudereinigung', buyer: 'Landkreis X', deadline: '2026-11-02', apply: 'https://plattform.example/v/abc' };
  const out = dedupeRepublished([
    { ...base, id: 'ted:1-2026', published: '2026-10-05' },
    { ...base, id: 'ted:2-2026', published: '2026-10-14' },
    { ...base, id: 'ted:3-2026', published: '2026-10-14', deadline: '2026-12-01' },
    { ...base, id: 'ted:4-2026', published: '2026-10-01', apply: 'https://plattform.example/' },
    { ...base, id: 'ted:5-2026', published: '2026-10-02', apply: 'https://plattform.example/' },
  ]);
  assert.deepEqual(out.map((t) => t.id).sort(), ['ted:2-2026', 'ted:3-2026', 'ted:4-2026', 'ted:5-2026']);
});
