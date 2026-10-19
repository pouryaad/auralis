// Minimaler ZIP-Leser ohne Abhängigkeiten (Methoden 0 = gespeichert, 8 = Deflate). Für die Tagesexporte des Bekanntmachungsservice.
import { inflateRawSync } from 'node:zlib';

export function* readZip(buf, { maxEntryBytes = 50 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei (Endsignatur fehlt)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new Error('ZIP64 wird nicht unterstützt');
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (usize > maxEntryBytes) throw new Error(`ZIP-Eintrag zu groß: ${name}`);
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('ZIP-Eintrag beschädigt');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
    else throw new Error(`ZIP-Kompression ${method} nicht unterstützt (${name})`);
    yield { name, data };
  }
}
