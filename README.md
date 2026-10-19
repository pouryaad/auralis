# Auralis – echte Ausschreibungen abrufen und anzeigen

**Live:** https://pouryaad.github.io/auralis/ – wird stündlich von GitHub Actions aktualisiert (Workflow „Ausschreibungen aktualisieren“).

Zwei Teile, keine Abhängigkeiten außer Node.js ab Version 18:

1. **Abruf-Dienst** (`src/`, `sources.json`): holt offene Ausschreibungen aus offiziellen Quellen, vereinheitlicht sie und schreibt `public/data/tenders.json`. Jeder Eintrag enthält: Quelle, Link zur Originalbekanntmachung bzw. Vergabeplattform, Bewerbungslink (falls veröffentlicht), Frist (Angebots- oder Teilnahmefrist), Land, Bundesland, Kategorie (inkl. Medien), CPV-Codes, Auftragswert (falls angegeben).
2. **Dashboard** (`public/index.html`): liest diese Datei. Es enthält **keine Beispieldaten und keine Platzhalter-Links**. Ohne Feed zeigt es eine Einrichtungsseite.

## Schnellstart

```bash
cp .env.example .env     # optional: CONTACT_EMAIL eintragen
npm test                 # 18 Tests, laufen ohne Internet
npm run check            # erster echter Abruf, zeigt je Quelle Status, Fehler und Hinweise
npm start                # Dashboard unter http://localhost:8080
npm run daemon           # Dashboard + automatischer Abruf alle INTERVAL_MINUTES (mindestens 15)
```

`public/data/tenders.json` enthält bereits einen echten Abzug vom 14.10.2026: 13.053 offene Ausschreibungen (TED 7.711, Bekanntmachungsservice 5.342). Ohne regelmäßigen Abruf veraltet er; siehe „Betrieb“.

## Betrieb

| Variante | So geht es |
|---|---|
| **GitHub Actions + Pages** (empfohlen, kostenlos) | Ordner in ein Repository legen. Unter *Settings → Pages → Source* „GitHub Actions“ wählen. `.github/workflows/ingest.yml` läuft stündlich, testet, ruft ab und veröffentlicht Dashboard und Feed. Optional Secrets `CONTACT_EMAIL`, `COMMERCIAL_API_KEY`. |
| **Server / Docker** | `docker build -t auralis . && docker run -d -p 8080:8080 --env-file .env -v auralis-cache:/app/.cache auralis` |
| **Lokal + Import** | `npm run check` auf einem Rechner mit Internet, dann im veröffentlichten Dashboard unter *Quellen → Feed-Datei importieren* `public/data/tenders.json` wählen. Der Import bleibt in diesem Browser gespeichert (IndexedDB). |

Das als Claude-Artifact veröffentlichte Dashboard darf aus Sicherheitsgründen keine fremden Server abrufen. Dort geht der Import, oder du betreibst das Dashboard über Pages/Docker auf eigener Adresse.

## Quellen

| Quelle | Status | Schlüssel | Inhalt |
|---|---|---|---|
| **TED** (EU), `api.ted.europa.eu/v3/notices/search` | implementiert | **keiner** | EU-weite Ausschreibungen oberhalb der Schwellenwerte, standardmäßig Deutschland und Österreich |
| **Bekanntmachungsservice** (oeffentlichevergabe.de), `/api/notice-exports?pubDay=…&format=eforms.zip` | implementiert | **keiner** | Bund, Länder, Kommunen, auch unterschwellig. EU-weite Bekanntmachungen werden dort übersprungen (kommen über TED), damit nichts doppelt erscheint |
| Kommerzielle Anbieter | Vorlage in `sources.json` (deaktiviert) | ja, laut Vertrag | über den allgemeinen JSON-Adapter anbindbar, ohne Code |

Was der Abruf beachtet:

- **TED:** nur Ausschreibungsarten (`notice-type IN (cn-standard cn-social cn-desg pin-cfc-standard pin-cfc-social subco)`), keine Zuschlagsbekanntmachungen; Iterationsmodus mit Token (die Seitenzählung bricht bei 15.000 ab); `scope=ACTIVE`; Teilnahmefrist als Rückfall, wenn keine Angebotsfrist angegeben ist; Bewerbungslink aus der Einreichungs-URL oder der Vergabeunterlagen-URL (BT-15); 600 ms Pause zwischen Seiten, Wiederholung bei 429/5xx und bei `timedOut`. Lehnt TED ein Zusatzfeld ab, prüft der Abruf jedes Feld einzeln und lässt nur das unbekannte weg (Hinweis im Dashboard).
- **Bekanntmachungsservice:** liest die täglichen eForms-Exporte (ZIP mit XML) der letzten `OEV_DAYS` Tage; vergangene Tage werden in `.cache/` zwischengespeichert und nicht erneut geladen; spätere Berichtigungen ersetzen frühere Fassungen; ein Zuschlag entfernt die Ausschreibung. Die Detailseite im Bekanntmachungsservice hat keinen dokumentierten Linkaufbau. Deshalb führt „Ausschreibung öffnen“ zur Vergabeplattform aus der Bekanntmachung (BT-15). Wenn du den Linkaufbau prüfst, kannst du ihn mit `OEV_NOTICE_URL_TEMPLATE` hinterlegen.
- **Medien:** CPV 921 (Film/Video), 922 (Radio/TV), 924 (Nachrichtenagenturen), 79961–79963 (Fotografie), 79340/79341 (Werbung), 79416 (Öffentlichkeitsarbeit), 79822500 (Grafikdesign), 64228 (Rundfunkübertragung), außerdem eindeutige Titelbegriffe wie Imagefilm, Videoproduktion, Fotodokumentation, Serienproduktion, Content-Produktion, Livestream. Sport (CPV 926) oder „Hydraulikpresse“ zählen bewusst nicht dazu.
- **Bundesland:** aus dem NUTS-Code des Erfüllungsorts, sonst aus dem Sitz des Auftraggebers. Fehlt beides, steht „nicht angegeben“.

## Zugangsdaten

Für TED und den Bekanntmachungsservice brauchst du **keine** Zugangsdaten. Empfohlen ist nur eine Kontaktadresse:

| Variable | Wofür | Wo |
|---|---|---|
| `CONTACT_EMAIL` | Kontakt im User-Agent für die Betreiber | `.env` oder GitHub-Secret |
| `COMMERCIAL_API_KEY` (Name frei) | nur für einen kommerziellen Anbieter | `.env` oder GitHub-Secret; in `sources.json` als `${COMMERCIAL_API_KEY}` |

Schlüssel stehen nie in `sources.json` oder im Dashboard. Fehlt ein referenzierter Schlüssel, wird die Quelle übersprungen und im Dashboard als „Zugangsdaten fehlen“ mit dem Variablennamen angezeigt.

## Fehlerbehandlung

- Jede Quelle läuft getrennt. Fällt eine aus, bleiben ihre letzten Einträge erhalten (im Dashboard als „Stand älter“ markiert), die Fehlermeldung steht unter *Quellen*.
- HTTP: Zeitlimit, bis zu 3 Wiederholungen mit wachsender Pause, `Retry-After` wird beachtet; 4xx wird nicht wiederholt.
- Die Feed-Datei wird atomar geschrieben. Ungültige `sources.json` bricht mit klarer Meldung ab, statt still nichts zu tun.
- Das Dashboard prüft den Feed: Einträge ohne Titel oder ohne `http(s)`-Link werden verworfen, IDs bereinigt, alle Texte escaped. Ladefehler überschreiben vorhandene Daten nie; es zeigt dann den zwischengespeicherten Stand mit Hinweis.
- Neue Daten während der Bearbeitung (offene Detailansicht, Eingabe) werden nicht hineingeschoben, sondern als „Neue Ausschreibungen verfügbar“ angeboten.

## Sicherheit und Datenschutz

- Keine Schlüssel im Browser. Kontaktpersonen aus Bekanntmachungen werden nicht übernommen.
- Merkliste, Pipeline und Notizen bleiben im Browser des Nutzers (localStorage); der Feed liegt in IndexedDB. Es gibt kein Tracking.
- CSV-Export schützt gegen Formel-Einschleusung (Zellen, die mit `= + - @` beginnen).
- `serve.js`: nur GET/HEAD, Schutz gegen Pfad-Ausbruch, Sicherheits-Header inkl. Content-Security-Policy, gzip, `/healthz`. Docker läuft als Nicht-root-Benutzer.

## Rechtliches (keine Rechtsberatung)

- **TED:** Weiterverwendung nach dem Rechtshinweis auf ted.europa.eu; Quelle angeben. Bitte den aktuellen Text selbst prüfen.
- **Bekanntmachungsservice:** Open-Data-Richtlinie auf oeffentlichevergabe.de vor dem Dauerbetrieb lesen. Die Weboberfläche ist per robots.txt für automatische Abrufe gesperrt; der Dienst nutzt nur die Exportschnittstelle.
- **Andere Portale** (DTVP, evergabe-online, Länderportale, kommerzielle Dienste): nur mit Erlaubnis bzw. Vertrag anbinden. Kein Scraping gegen Nutzungsbedingungen oder robots.txt; systematisches Kopieren geschützter Datenbanken kann gegen das Datenbankherstellerrecht (§§ 87a ff. UrhG) verstoßen.
- **Bewerbung:** Das Dashboard reicht nichts ein. Angebote gibst du auf der Vergabeplattform ab, meist mit Firmenkonto und elektronischer Signatur.

## Was geprüft ist und was nicht

Live geprüft am 14.10.2026 (Abruf über einen Browser mit Internetzugang, Ergebnis im mitgelieferten Feed):

- **TED API v3:** anonym nutzbar, `limit` 250, Iterationsmodus mit `iterationNextToken`. Die Abfrage und alle Zusatzfelder in `src/sources/ted.js` werden angenommen. 120 Tage DE+AT ergeben 27.416 „aktive“ Bekanntmachungen, davon nur 8.179 mit noch offener Frist. `scope=ACTIVE` bedeutet also nicht „offen“, deshalb filtert der Abruf zusätzlich nach Frist. Titel kommen als „Land – CPV-Text – Titel“ und werden gekürzt. Der Wert `estimated-value-proc` ist manchmal ein Platzhalter („1“); Werte unter 100 werden verworfen. Die Einreichungs-URL ist manchmal nur die Startseite der Plattform; dann wird der Link zu den Vergabeunterlagen bevorzugt.
- **Bekanntmachungsservice:** `/api/notice-exports?pubDay=YYYY-MM-DD&format=eforms.zip` (OpenAPI unter `/documentation/api/opendata`, Lizenz CC0). Ein Tag ≈ 3,6 MB mit ≈ 1.000 XML-Dateien. Es kommen zwei eForms-Varianten vor (eForms-DE 2.1 und ältere SDK-0.1-Dateien ohne Root-Erweiterung, Auftraggeber dann in `ContractingParty/Party`); beide werden gelesen (Test `cn-sdk01`).
- Berichtigungen erscheinen als neue Bekanntmachung. Gleiche Quelle, Titel, Auftraggeber, Frist und Plattform-Link werden zur neuesten Fassung zusammengeführt (897 Einträge im Abzug).
- `npm test`: 18 Tests (synthetische Daten plus Fixtures nach den Live-Funden), darunter ein Ende-zu-Ende-Lauf gegen lokale Mock-Server.
- Dashboard (Bereiche Übersicht, Ausschreibungen, Pipeline, Kalender, Quellen): 64 Browsertests mit synthetischen Daten (Filter, Suche, Links, XSS-Schutz, CSV, Pipeline, Persistenz, Bereinigung alter Browserdaten, Feed-Ausfall, 320–1440 px) und 14 Tests mit dem echten Feed (Medien, Bundesland, Österreich, „ohne Ortsangabe“, Suche < 200 ms, Links der Detailansicht, kein Überlauf, keine JS-Fehler).

Bekannte Grenzen:

- Rund 11 % der Einträge (vor allem aus dem Bekanntmachungsservice) haben weder Erfüllungsort noch NUTS-Code des Auftraggebers. Sie stehen unter Bundesland „Ohne Angabe zum Ort“ und erscheinen bei „alle Bundesländer“.
- Für Einträge aus dem Bekanntmachungsservice gibt es keinen dokumentierten Link auf die eigene Detailseite. „Ausschreibung öffnen“ führt zur Vergabeplattform aus der Bekanntmachung; Einträge ganz ohne Link werden ausgelassen.
- Der Abruf läuft seit dem 20.10.2026 in GitHub Actions: TED erfolgreich (8.331 offene Ausschreibungen). Der Bekanntmachungsservice antwortete zu diesem Zeitpunkt auf alle Anfragen nach 60 s mit HTTP 504 (auch die Dokumentationsseite, auch von anderen Rechnern). Der Abruf behält dann die letzten Einträge (abgelaufene werden entfernt) und holt die Tagesexporte automatisch nach, sobald der Dienst wieder antwortet.

## Feed-Format (schema 1)

```json
{ "schema": 1, "generatedAt": "ISO-Zeit", "sources": [ { "id": "ted", "name": "…", "status": "ok|error|needs-credentials|disabled|pending", "coverage": "…", "license": "…", "homepage": "…", "lastSuccess": "…", "error": "…", "warnings": [] } ],
  "tenders": [ { "id": "ted:123456-2026", "src": "ted", "title": "…", "buyer": "…", "cat": "Medien", "media": true, "cpv": ["92111200"],
                 "land": "Deutschland", "region": "Bayern", "published": "2026-10-12", "deadline": "2026-11-10", "deadlineKind": "tender|request|interest",
                 "value": 150000, "currency": "EUR", "url": "https://…", "urlKind": "notice|platform", "apply": "https://…", "applyKind": "submission|documents|direct|notice", "description": "…" } ] }
```
