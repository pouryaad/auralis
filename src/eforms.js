// Schlanker eForms-Leser (UBL-XML) für Bekanntmachungen. Liest nur die Felder, die das Dashboard braucht.
// Pfade nach eForms-SDK: BT-21 Titel (ProcurementProject/Name), BT-131 Angebotsfrist (TenderSubmissionDeadlinePeriod),
// BT-1311 Teilnahmefrist (ParticipationRequestReceptionPeriod), BT-15 Unterlagen-URL (CallForTendersDocumentReference//URI),
// BT-18 Einreichungs-URL (TenderRecipientParty/EndpointID), BT-5071 Ort (RealizedLocation//CountrySubentityCode),
// BT-262/263 CPV (ItemClassificationCode listName="cpv"), BT-27 Wert (EstimatedOverallContractAmount), BT-01 Rechtsgrundlage (RegulatoryDomain).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decode = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m))
  .replace(/\s+/g, ' ').trim();

const tagRe = (name, flags = 'g') => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, flags);
/** Alle Vorkommen eines Elements (beliebiges Präfix): [{ attrs, inner }] */
export function all(xml, name) {
  const out = []; if (!xml) return out;
  for (const m of xml.matchAll(tagRe(name))) out.push({ attrs: m[0].slice(0, m[0].indexOf('>') + 1), inner: m[1] ?? '' });
  return out;
}
export const first = (xml, name) => all(xml, name)[0] || null;
export const text = (xml, name) => { const f = first(xml, name); return f ? decode(f.inner) : ''; };
const attr = (attrs, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(attrs || ''); return m ? m[1] : ''; };

/** Text in bevorzugter Sprache (languageID DEU, sonst ENG, sonst erster). */
function langText(xml, name) {
  const xs = all(xml, name); if (!xs.length) return '';
  const by = (l) => xs.find((x) => attr(x.attrs, 'languageID').toUpperCase() === l);
  return decode((by('DEU') || by('ENG') || xs[0]).inner);
}

export function parseNotice(xml, fileName = '') {
  const root = /<(?:[\w-]+:)?(ContractNotice|PriorInformationNotice|ContractAwardNotice)[\s>]/.exec(xml);
  if (!root) return null;
  const kind = root[1] === 'ContractAwardNotice' ? 'award' : root[1] === 'ContractNotice' ? 'call' : 'pin';
  // Nur eine UBLExtensions direkt am Dokumentanfang enthält die Organisationen. Ältere eForms-Fassungen (sdk-0.1, live beobachtet)
  // haben keine; dort stehen UBLExtensions nur innerhalb der Lose und dürfen das Dokument nicht abschneiden.
  const extOpen = xml.search(/<(?:[\w-]+:)?UBLExtensions[\s>]/), firstField = xml.search(/<(?:[\w-]+:)?(UBLVersionID|CustomizationID|ContractFolderID)[\s>]/);
  const hasRootExt = extOpen >= 0 && (firstField < 0 || extOpen < firstField);
  const extEnd = hasRootExt ? xml.search(/<\/(?:[\w-]+:)?UBLExtensions>/) : -1;
  const ext = extEnd > 0 ? xml.slice(0, extEnd) : '';
  const body = extEnd > 0 ? xml.slice(extEnd) : xml;
  const lots = all(body, 'ProcurementProjectLot').map((l) => l.inner);
  const procedure = body.replace(tagRe('ProcurementProjectLot'), '');
  const proj = first(procedure, 'ProcurementProject')?.inner || '';

  // Organisationen (in den Erweiterungen) und Auftraggeber
  const orgs = all(ext, 'Organization').map((o) => {
    const company = first(o.inner, 'Company')?.inner || o.inner;
    return { id: text(first(company, 'PartyIdentification')?.inner, 'ID'), name: langText(first(company, 'PartyName')?.inner, 'Name'),
      nuts: text(company, 'CountrySubentityCode'), country: text(first(company, 'Country')?.inner, 'IdentificationCode'), web: text(company, 'WebsiteURI') };
  });
  const cp = (first(procedure, 'ContractingParty')?.inner || '').replace(tagRe('ServiceProviderParty'), '');
  const buyerRef = text(first(cp, 'PartyIdentification')?.inner, 'ID');
  let buyer = orgs.find((o) => o.id && o.id === buyerRef) || orgs[0];
  if (!buyer) { // ältere Fassung: Auftraggeber direkt in ContractingParty/Party
    buyer = { name: langText(first(cp, 'PartyName')?.inner, 'Name'), nuts: text(cp, 'CountrySubentityCode'), country: text(first(cp, 'Country')?.inner, 'IdentificationCode'), web: text(cp, 'WebsiteURI') };
  }

  // Fristen: Angebotsfrist je Los, sonst Teilnahmefrist
  const pick = (blockName) => lots.map((l) => text(first(l, blockName)?.inner, 'EndDate')).filter(Boolean);
  const tenderDl = pick('TenderSubmissionDeadlinePeriod'), requestDl = pick('ParticipationRequestReceptionPeriod');
  const uris = (blockName) => [...lots, procedure].flatMap((l) => all(l, blockName).map((b) => text(b.inner, 'URI'))).filter(Boolean);
  const endpoint = [...lots, procedure].flatMap((l) => all(l, 'TenderRecipientParty').map((b) => text(b.inner, 'EndpointID'))).filter(Boolean);
  const amount = first(first(proj, 'RequestedTenderTotal')?.inner, 'EstimatedOverallContractAmount')
    || first(lots.map((l) => first(l, 'RequestedTenderTotal')?.inner || '').join(''), 'EstimatedOverallContractAmount');

  return {
    kind,
    // Manche Plattformen liefern weder schemeName="notice-id" noch eine ContractFolderID (live beobachtet);
    // dann dient der Dateiname im Export ("<Notice-ID>-<Version>.xml") als Kennung.
    noticeId: (all(body, 'ID').find((x) => attr(x.attrs, 'schemeName') === 'notice-id') || {}).inner?.trim()
      || String(fileName).replace(/^.*\//, '').replace(/\.xml$/i, '').replace(/-\d+$/, ''),
    folder: text(body, 'ContractFolderID'),
    issued: text(body, 'IssueDate').slice(0, 10),
    legalBasis: text(body, 'RegulatoryDomain'),
    title: langText(proj, 'Name') || (lots[0] ? langText(first(lots[0], 'ProcurementProject')?.inner, 'Name') : ''),
    description: langText(proj, 'Description'),
    cpv: [...new Set(all(body, 'ItemClassificationCode').filter((x) => attr(x.attrs, 'listName') === 'cpv').map((x) => decode(x.inner)))],
    nuts: [...new Set(all(body, 'RealizedLocation').map((r) => text(r.inner, 'CountrySubentityCode')).filter(Boolean))],
    buyer: buyer.name || '', buyerNuts: buyer.nuts || '', country: buyer.country || '',
    tenderDeadlines: tenderDl, requestDeadlines: requestDl,
    documentsUrl: uris('CallForTendersDocumentReference')[0] || '',
    submissionUrl: endpoint.find((e) => /^(https?:\/\/|www\.)/i.test(e)) || '',
    accessUrl: [...lots, procedure].map((l) => text(l, 'AccessToolsURI')).find(Boolean) || '',
    value: amount ? Number(decode(amount.inner)) : null, currency: amount ? attr(amount.attrs, 'currencyID') : '',
  };
}
