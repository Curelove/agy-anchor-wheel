import zlib from 'node:zlib';

const MAX_DEFAULT_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_DEFAULT_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_DEFAULT_ENTRIES = 4000;

export function normalizeZipPath(rawName) {
  let s = String(rawName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return '';
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Pure zero-dependency ZIP archive reader using Node built-in `zlib.inflateRawSync`.
 * Only reads Central Directory metadata upfront; individual entries are inflated lazily
 * with strict per-entry and cumulative decompression ceilings to guard against zip bombs.
 */
export function readZipArchive(rawBuffer, options = {}) {
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer || '');
  const maxEntryBytes = Math.max(64 * 1024, Number(options.maxEntryBytes || MAX_DEFAULT_ENTRY_BYTES));
  const maxTotalBytes = Math.max(maxEntryBytes, Number(options.maxTotalBytes || MAX_DEFAULT_TOTAL_BYTES));
  const maxEntries = Math.max(50, Number(options.maxEntries || MAX_DEFAULT_ENTRIES));

  if (buf.length < 22) {
    throw new Error('Invalid ZIP archive: file too small');
  }

  // Locate End of Central Directory (EOCD) signature 0x06054b50 scanning backwards up to 64KB + 22B
  const minPos = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: EOCD record not found');
  }

  let cdSize = buf.readUInt32LE(eocdOffset + 12);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let totalEntriesHint = buf.readUInt16LE(eocdOffset + 10);

  // Basic ZIP64 EOCD locator fallback when 32-bit fields are saturated
  if (
    (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntriesHint === 0xffff) &&
    eocdOffset >= 20 &&
    buf.readUInt32LE(eocdOffset - 20) === 0x07064b50
  ) {
    const z64EocdOff = Number(buf.readBigUInt64LE(eocdOffset - 12));
    if (Number.isSafeInteger(z64EocdOff) && z64EocdOff >= 0 && z64EocdOff + 56 <= buf.length && buf.readUInt32LE(z64EocdOff) === 0x06064b50) {
      totalEntriesHint = Number(buf.readBigUInt64LE(z64EocdOff + 32));
      cdSize = Number(buf.readBigUInt64LE(z64EocdOff + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64EocdOff + 48));
    }
  }

  if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > buf.length) {
    throw new Error('Invalid ZIP archive: corrupt central directory bounds');
  }

  const entries = [];
  const byName = new Map();
  const byLowerName = new Map();

  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (pos + 46 <= cdEnd && entries.length < maxEntries) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    let compressedSize = buf.readUInt32LE(pos + 20);
    let uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    let localHeaderOffset = buf.readUInt32LE(pos + 42);

    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    const extraEnd = nameEnd + extraLen;
    const nextPos = extraEnd + commentLen;
    if (nextPos > buf.length) break;

    const nameBuf = buf.subarray(nameStart, nameEnd);
    const rawName = (flags & 0x0800) ? nameBuf.toString('utf8') : decodeZipEntryName(nameBuf);

    // Parse ZIP64 extra field (header ID 0x0001) if needed
    if (
      (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) &&
      extraLen >= 4
    ) {
      let ex = nameEnd;
      while (ex + 4 <= extraEnd) {
        const hid = buf.readUInt16LE(ex);
        const hsz = buf.readUInt16LE(ex + 2);
        ex += 4;
        if (hid === 0x0001 && ex + hsz <= extraEnd) {
          let p64 = ex;
          if (uncompressedSize === 0xffffffff && p64 + 8 <= ex + hsz) {
            uncompressedSize = Number(buf.readBigUInt64LE(p64));
            p64 += 8;
          }
          if (compressedSize === 0xffffffff && p64 + 8 <= ex + hsz) {
            compressedSize = Number(buf.readBigUInt64LE(p64));
            p64 += 8;
          }
          if (localHeaderOffset === 0xffffffff && p64 + 8 <= ex + hsz) {
            localHeaderOffset = Number(buf.readBigUInt64LE(p64));
          }
          break;
        }
        ex += hsz;
      }
    }

    const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\');
    const normName = normalizeZipPath(rawName);
    if (normName) {
      const rec = {
        name: normName,
        rawName,
        isDirectory,
        method,
        encrypted: Boolean(flags & 0x0001),
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
      entries.push(rec);
      if (!isDirectory) {
        byName.set(normName, rec);
        byLowerName.set(normName.toLowerCase(), rec);
      }
    }
    pos = nextPos;
  }

  let totalDecompressed = 0;
  const cache = new Map();

  function lookup(name) {
    const norm = normalizeZipPath(name);
    if (!norm) return null;
    return byName.get(norm) || byLowerName.get(norm.toLowerCase()) || null;
  }

  function getEntryBuffer(name) {
    const rec = lookup(name);
    if (!rec || rec.isDirectory) return null;
    if (cache.has(rec.name)) return cache.get(rec.name);
    if (rec.encrypted) {
      throw new Error(`ZIP entry is password-protected: ${rec.name}`);
    }
    if (rec.uncompressedSize > maxEntryBytes) {
      throw new Error(`ZIP entry exceeds size cap (${rec.name})`);
    }
    const lh = rec.localHeaderOffset;
    if (lh < 0 || lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP local header: ${rec.name}`);
    }
    const lhNameLen = buf.readUInt16LE(lh + 26);
    const lhExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const dataEnd = dataStart + rec.compressedSize;
    if (dataStart < 0 || dataEnd > buf.length) {
      throw new Error(`Corrupt ZIP entry bounds: ${rec.name}`);
    }
    const compressed = buf.subarray(dataStart, dataEnd);
    let out;
    if (rec.method === 0) {
      out = Buffer.from(compressed);
    } else if (rec.method === 8) {
      out = zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    } else {
      throw new Error(`Unsupported ZIP compression method ${rec.method} for ${rec.name}`);
    }
    totalDecompressed += out.length;
    if (totalDecompressed > maxTotalBytes) {
      throw new Error('ZIP archive exceeds cumulative decompression safety limit');
    }
    cache.set(rec.name, out);
    return out;
  }

  function getEntryText(name, encoding = 'utf8') {
    const b = getEntryBuffer(name);
    if (!b) return '';
    let txt = b.toString(encoding);
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    return txt;
  }

  return {
    entries,
    totalEntriesHint,
    truncated: entries.length >= maxEntries && totalEntriesHint > entries.length,
    hasEntry: (name) => Boolean(lookup(name)),
    getEntryMeta: (name) => lookup(name),
    getEntryBuffer,
    getEntryText,
    listEntries: () => entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      encrypted: e.encrypted,
    })),
  };
}

function decodeZipEntryName(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: false }).decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/**
 * Resolves relative paths inside a ZIP archive (e.g. from `word/document.xml` to `media/image1.png` or `../media/image1.png`).
 */
export function resolveZipRelPath(baseXmlPath, relTarget) {
  const target = String(relTarget || '').trim();
  if (!target) return '';
  if (target.startsWith('/')) return normalizeZipPath(target.slice(1));
  const normBase = normalizeZipPath(baseXmlPath);
  const slash = normBase.lastIndexOf('/');
  const baseDir = slash >= 0 ? normBase.slice(0, slash) : '';
  const combined = baseDir ? `${baseDir}/${target}` : target;
  const parts = [];
  for (const seg of combined.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

const NAMED_XML_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '\u00A9',
  reg: '\u00AE',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bull: '\u2022',
  middot: '\u00B7',
  times: '\u00D7',
  divide: '\u00F7',
});

export function decodeXmlEntities(raw) {
  const s = String(raw ?? '');
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    return NAMED_XML_ENTITIES[code] ?? m;
  });
}

export function localName(tagName) {
  const s = String(tagName || '');
  const idx = s.indexOf(':');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function parseAttributes(attrStr) {
  const attrs = Object.create(null);
  if (!attrStr || !attrStr.trim()) return attrs;
  const re = /([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1];
    const val = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
    attrs[key] = val;
    const colon = key.indexOf(':');
    if (colon >= 0) {
      const local = key.slice(colon + 1);
      if (attrs[local] === undefined) attrs[local] = val;
    }
  }
  return attrs;
}

/**
 * Fast, forgiving, zero-dependency XML tree parser designed for OOXML, ODF, and XHTML.
 * Returns a root document node: `{ tag: '#root', local: '#root', attrs: {}, children: [...] }`.
 */
export function parseXml(xmlInput) {
  const src = String(xmlInput || '');
  const root = { tag: '#root', local: '#root', attrs: Object.create(null), children: [] };
  const stack = [root];
  const len = src.length;
  let i = 0;

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (i < len) {
        const txt = decodeXmlEntities(src.slice(i));
        if (txt) stack[stack.length - 1].children.push({ text: txt });
      }
      break;
    }

    if (lt > i) {
      const txt = decodeXmlEntities(src.slice(i, lt));
      if (txt) stack[stack.length - 1].children.push({ text: txt });
    }

    // Comments <!-- ... -->
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const cdata = end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      if (cdata) stack[stack.length - 1].children.push({ text: cdata });
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Processing instruction <? ... ?>
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // DOCTYPE or other declaration <! ... >
    if (src.startsWith('<!', lt)) {
      let depth = 1;
      let j = lt + 2;
      let quote = '';
      while (j < len && depth > 0) {
        const ch = src[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '<') {
          depth++;
        } else if (ch === '>') {
          depth--;
        }
        j++;
      }
      i = j;
      continue;
    }

    // Scan to matching '>' outside quotes
    let gt = -1;
    let quote = '';
    for (let j = lt + 1; j < len; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        gt = j;
        break;
      }
    }
    if (gt === -1) break;

    const rawTag = src.slice(lt + 1, gt);
    i = gt + 1;

    if (!rawTag) continue;

    // Closing tag </...>
    if (rawTag[0] === '/') {
      const closeName = rawTag.slice(1).trim();
      const closeLocal = localName(closeName);
      // Unwind stack defensively if mismatched
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === closeName || stack[k].local === closeLocal) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag.trim();
    if (!body) continue;

    let nameEnd = 0;
    while (nameEnd < body.length && !/\s/.test(body[nameEnd])) nameEnd++;
    const tag = body.slice(0, nameEnd);
    const attrStr = body.slice(nameEnd);
    const node = {
      tag,
      local: localName(tag),
      attrs: parseAttributes(attrStr),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root;
}

export function getAttr(node, name) {
  if (!node || !node.attrs) return '';
  if (node.attrs[name] !== undefined) return node.attrs[name];
  const loc = localName(name);
  return node.attrs[loc] !== undefined ? node.attrs[loc] : '';
}

export function findChild(node, targetLocal) {
  if (!node || !Array.isArray(node.children)) return null;
  for (const ch of node.children) {
    if (ch && ch.local === targetLocal) return ch;
  }
  return null;
}

export function findChildren(node, targetLocal) {
  if (!node || !Array.isArray(node.children)) return [];
  const out = [];
  for (const ch of node.children) {
    if (ch && ch.local === targetLocal) out.push(ch);
  }
  return out;
}

export function findAll(node, targetLocal, out = []) {
  if (!node || !Array.isArray(node.children)) return out;
  for (const ch of node.children) {
    if (!ch || ch.text !== undefined) continue;
    if (ch.local === targetLocal) out.push(ch);
    if (ch.children?.length) findAll(ch, targetLocal, out);
  }
  return out;
}

export function collectText(node) {
  if (!node) return '';
  if (node.text !== undefined) return node.text;
  if (!Array.isArray(node.children)) return '';
  let out = '';
  for (const ch of node.children) {
    out += collectText(ch);
  }
  return out;
}

export function parseRelsXml(xmlStr) {
  const map = new Map();
  if (!xmlStr) return map;
  const root = parseXml(xmlStr);
  for (const rel of findAll(root, 'Relationship')) {
    const id = getAttr(rel, 'Id');
    const target = getAttr(rel, 'Target');
    const type = getAttr(rel, 'Type');
    const targetMode = getAttr(rel, 'TargetMode');
    if (id && target) {
      map.set(id, { id, target, type, external: /^external$/i.test(targetMode) });
    }
  }
  return map;
}
