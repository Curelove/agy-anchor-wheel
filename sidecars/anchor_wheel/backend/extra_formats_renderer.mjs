import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { decodeBuffer } from './encoding.mjs';
import { escapeHtml } from './security.mjs';
import { collectText, findAll, findChild, findChildren, getAttr, parseXml, pruneAlternateContent } from './zip_xml.mjs';

const requireBuiltin = createRequire(import.meta.url);

const MAX_PLAIN_CHARS = 180000;
const MAX_ARCHIVE_UNZIP_BYTES = 48 * 1024 * 1024;
const MAX_FONT_EMBED_BYTES = 14 * 1024 * 1024;
const MAX_MESH_TRIANGLES = 32000;

function formatBytes(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

function indexToColLetters(colIdx) {
  let n = colIdx + 1;
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s || 'A';
}

function stripAnsiCodes(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ── Shared Minimal MS-CFB (OLE2 Compound File Binary) Stream Reader ─────────

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

export function isOle2Buffer(buf) {
  return Boolean(buf && buf.length >= 512 && buf.subarray(0, 8).equals(OLE2_MAGIC));
}

export function readOle2Streams(buf) {
  if (!isOle2Buffer(buf)) return null;
  const sectorShift = buf.readUInt16LE(30);
  const miniSectorShift = buf.readUInt16LE(32);
  if (sectorShift < 7 || sectorShift > 16) return null;
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << Math.max(4, Math.min(12, miniSectorShift || 6));

  const firstDirSect = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56) || 4096;
  const firstMiniFatSect = buf.readUInt32LE(60);
  const numMiniFatSects = buf.readUInt32LE(64);
  const firstDifatSect = buf.readUInt32LE(68);
  const numDifatSects = buf.readUInt32LE(72);

  const sectorOffset = (secId) => (secId + 1) * sectorSize;
  const maxSectors = Math.floor(buf.length / sectorSize);

  // 1. Collect DIFAT -> FAT sector IDs
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const sid = buf.readUInt32LE(76 + i * 4);
    if (sid !== FREESECT && sid !== ENDOFCHAIN && sid < maxSectors) fatSectors.push(sid);
  }
  let difatSec = firstDifatSect;
  let difatGuard = 0;
  while (difatSec !== ENDOFCHAIN && difatSec !== FREESECT && difatSec < maxSectors && difatGuard++ < numDifatSects + 4) {
    const off = sectorOffset(difatSec);
    if (off + sectorSize > buf.length) break;
    const entriesPerSect = sectorSize / 4 - 1;
    for (let i = 0; i < entriesPerSect; i++) {
      const sid = buf.readUInt32LE(off + i * 4);
      if (sid !== FREESECT && sid !== ENDOFCHAIN && sid < maxSectors) fatSectors.push(sid);
    }
    difatSec = buf.readUInt32LE(off + entriesPerSect * 4);
  }

  // 2. Build FAT array
  const intsPerSector = sectorSize / 4;
  const fat = new Uint32Array(fatSectors.length * intsPerSector);
  fat.fill(FREESECT);
  fatSectors.forEach((sid, idx) => {
    const off = sectorOffset(sid);
    if (off + sectorSize > buf.length) return;
    for (let j = 0; j < intsPerSector; j++) {
      fat[idx * intsPerSector + j] = buf.readUInt32LE(off + j * 4);
    }
  });

  const readChain = (startSec, sizeHint = 0, maxCap = 24 * 1024 * 1024) => {
    const chunks = [];
    let total = 0;
    let cur = startSec;
    let steps = 0;
    while (cur !== ENDOFCHAIN && cur !== FREESECT && cur < maxSectors && steps++ < maxSectors + 2) {
      const off = sectorOffset(cur);
      if (off < 0 || off + sectorSize > buf.length) break;
      chunks.push(buf.subarray(off, off + sectorSize));
      total += sectorSize;
      if (total >= maxCap || (sizeHint > 0 && total >= sizeHint)) break;
      cur = cur < fat.length ? fat[cur] : ENDOFCHAIN;
    }
    const joined = Buffer.concat(chunks);
    return sizeHint > 0 && sizeHint < joined.length ? joined.subarray(0, sizeHint) : joined;
  };

  // 3. Read Directory Stream
  const dirBuf = readChain(firstDirSect, 0, 4 * 1024 * 1024);
  const entries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameBytes = dirBuf.readUInt16LE(off + 64);
    const objType = dirBuf[off + 66];
    if (objType === 0 || nameBytes < 2 || nameBytes > 64) continue;
    const name = dirBuf.subarray(off, off + nameBytes - 2).toString('utf16le');
    const startSec = dirBuf.readUInt32LE(off + 116);
    const sizeLow = dirBuf.readUInt32LE(off + 120);
    const sizeHigh = sectorShift >= 12 ? dirBuf.readUInt32LE(off + 124) : 0;
    const size = sizeHigh * 0x100000000 + sizeLow;
    entries.push({ name, objType, startSec, size });
  }

  const rootEntry = entries.find((e) => e.objType === 5);
  let miniStream = null;
  let miniFat = null;

  const ensureMiniStream = () => {
    if (miniStream !== null) return;
    if (!rootEntry || rootEntry.startSec === ENDOFCHAIN || rootEntry.startSec === FREESECT) {
      miniStream = Buffer.alloc(0);
      miniFat = new Uint32Array(0);
      return;
    }
    miniStream = readChain(rootEntry.startSec, rootEntry.size, 16 * 1024 * 1024);
    const mfBuf =
      firstMiniFatSect !== ENDOFCHAIN && firstMiniFatSect !== FREESECT && numMiniFatSects > 0
        ? readChain(firstMiniFatSect, numMiniFatSects * sectorSize, 2 * 1024 * 1024)
        : Buffer.alloc(0);
    miniFat = new Uint32Array(Math.floor(mfBuf.length / 4));
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mfBuf.readUInt32LE(i * 4);
  };

  const getStream = (targetName) => {
    const lower = String(targetName || '').toLowerCase();
    const ent = entries.find((e) => e.objType === 2 && e.name.toLowerCase() === lower);
    if (!ent || ent.size <= 0) return null;
    if (ent.size < miniCutoff && rootEntry) {
      ensureMiniStream();
      if (!miniStream.length) return null;
      const chunks = [];
      let total = 0;
      let cur = ent.startSec;
      let guard = 0;
      const maxMini = Math.floor(miniStream.length / miniSectorSize);
      while (cur !== ENDOFCHAIN && cur !== FREESECT && cur < maxMini && guard++ < maxMini + 2) {
        const off = cur * miniSectorSize;
        chunks.push(miniStream.subarray(off, off + miniSectorSize));
        total += miniSectorSize;
        if (total >= ent.size) break;
        cur = cur < miniFat.length ? miniFat[cur] : ENDOFCHAIN;
      }
      const res = Buffer.concat(chunks);
      return res.subarray(0, Math.min(ent.size, res.length));
    }
    return readChain(ent.startSec, ent.size);
  };

  return { entries, getStream };
}

// ── 1. Legacy .xls (Disguised HTML/XML/XLSX + Native BIFF8 Workbook Parser) ─

function decodeBiff8UnicodeString(buf, pos, endLimit) {
  if (pos + 3 > endLimit) return { text: '', nextPos: endLimit };
  const cch = buf.readUInt16LE(pos);
  let flags = buf[pos + 2];
  let p = pos + 3;
  let rtRuns = 0;
  let extLen = 0;
  if (flags & 0x08) {
    if (p + 2 > endLimit) return { text: '', nextPos: endLimit };
    rtRuns = buf.readUInt16LE(p);
    p += 2;
  }
  if (flags & 0x04) {
    if (p + 4 > endLimit) return { text: '', nextPos: endLimit };
    extLen = buf.readUInt32LE(p);
    p += 4;
  }
  const is16Bit = Boolean(flags & 0x01);
  const byteLen = is16Bit ? cch * 2 : cch;
  const sliceEnd = Math.min(endLimit, p + byteLen);
  const text = is16Bit
    ? buf.subarray(p, sliceEnd).toString('utf16le')
    : buf.subarray(p, sliceEnd).toString('latin1');
  p = Math.min(endLimit, sliceEnd + rtRuns * 4 + extLen);
  return { text, nextPos: p };
}

function parseSstWithContinues(sstPayload, continuePayloads) {
  const chunks = [sstPayload, ...continuePayloads];
  if (!sstPayload || sstPayload.length < 8) return [];
  const uniqueCount = sstPayload.readUInt32LE(4);
  const out = [];

  let chunkIdx = 0;
  let pos = 8;

  const ensureBytes = (n) => {
    while (chunkIdx < chunks.length && pos + n > chunks[chunkIdx].length) {
      chunkIdx++;
      pos = 0;
    }
    return chunkIdx < chunks.length;
  };

  for (let s = 0; s < uniqueCount && out.length < 50000; s++) {
    if (!ensureBytes(3)) break;
    let curBuf = chunks[chunkIdx];
    const cch = curBuf.readUInt16LE(pos);
    let flags = curBuf[pos + 2];
    pos += 3;
    let rtRuns = 0;
    let extLen = 0;
    if (flags & 0x08) {
      if (!ensureBytes(2)) break;
      curBuf = chunks[chunkIdx];
      rtRuns = curBuf.readUInt16LE(pos);
      pos += 2;
    }
    if (flags & 0x04) {
      if (!ensureBytes(4)) break;
      curBuf = chunks[chunkIdx];
      extLen = curBuf.readUInt32LE(pos);
      pos += 4;
    }

    let is16 = Boolean(flags & 0x01);
    let charsRemaining = cch;
    let str = '';

    while (charsRemaining > 0 && chunkIdx < chunks.length) {
      curBuf = chunks[chunkIdx];
      const availBytes = curBuf.length - pos;
      if (availBytes <= 0) {
        chunkIdx++;
        pos = 0;
        if (chunkIdx < chunks.length && chunks[chunkIdx].length > 0) {
          is16 = Boolean(chunks[chunkIdx][0] & 0x01);
          pos = 1;
        }
        continue;
      }
      const bytesPerChar = is16 ? 2 : 1;
      const takeChars = Math.min(charsRemaining, Math.floor(availBytes / bytesPerChar));
      if (takeChars <= 0) {
        chunkIdx++;
        pos = 0;
        if (chunkIdx < chunks.length && chunks[chunkIdx].length > 0) {
          is16 = Boolean(chunks[chunkIdx][0] & 0x01);
          pos = 1;
        }
        continue;
      }
      const takeBytes = takeChars * bytesPerChar;
      str += is16
        ? curBuf.subarray(pos, pos + takeBytes).toString('utf16le')
        : curBuf.subarray(pos, pos + takeBytes).toString('latin1');
      pos += takeBytes;
      charsRemaining -= takeChars;
    }

    // Skip formatting runs & phonetic ext data across chunk boundaries
    let skipExtra = rtRuns * 4 + extLen;
    while (skipExtra > 0 && chunkIdx < chunks.length) {
      const rem = chunks[chunkIdx].length - pos;
      if (skipExtra <= rem) {
        pos += skipExtra;
        skipExtra = 0;
      } else {
        skipExtra -= rem;
        chunkIdx++;
        pos = 0;
      }
    }
    out.push(str);
  }
  return out;
}

function decodeRkNumber(rk) {
  const isMul100 = Boolean(rk & 0x01);
  const isInt = Boolean(rk & 0x02);
  let val;
  if (isInt) {
    val = rk >> 2;
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeUInt32LE(0, 0);
    tmp.writeInt32LE(rk & 0xfffffffc, 4);
    val = tmp.readDoubleLE(0);
  }
  if (isMul100) val /= 100;
  return Number.isFinite(val) ? (/\.\d{7,}/.test(String(val)) ? Number(val.toFixed(4)) : val) : 0;
}

function renderGridSectionHtml(rowMap, maxRow, maxCol) {
  const rowCount = maxRow + 1;
  const colCount = maxCol + 1;
  if (rowCount <= 0 || colCount <= 0) return '<p class="aw-doc-empty-msg">此工作表暂无数据。</p>';
  const colHeaders = Array.from({ length: colCount }, (_, c) => `<th>${indexToColLetters(c)}</th>`).join('');
  const trs = [];
  for (let r = 0; r < rowCount; r++) {
    const cells = rowMap.get(r);
    const tds = [`<td class="aw-sheet-rn">${r + 1}</td>`];
    for (let c = 0; c < colCount; c++) {
      const v = String(cells?.get(c) ?? '');
      const isNum = v !== '' && /^-?\d+(?:\.\d+)?%?$/.test(v.trim());
      tds.push(`<td${isNum ? ' class="aw-sheet-num"' : ''}>${escapeHtml(v)}</td>`);
    }
    trs.push(`<tr data-aw-row="${r + 1}">${tds.join('')}</tr>`);
  }
  return `<div class="aw-sheet-wrap"><table class="aw-sheet-table"><thead><tr><th class="aw-sheet-corner">#</th>${colHeaders}</tr></thead><tbody>${trs.join('')}</tbody></table></div>`;
}

export function parseLegacyXls(buf, filePath, stat, { snippetOnly = false } = {}) {
  // 1. Disguised XLSX (ZIP)
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return { redirectFormat: 'xlsx', warning: '此 .xls 文件实为标准 XLSX 格式，已自动按新版工作簿解析。' };
  }

  const headStr = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1').trimStart();
  // 2. Disguised HTML Table / XML Spreadsheet 2003 (extremely common in ERP/web exports!)
  if (/^(?:<!doctype\s+html|<html|<meta|<table|<\?xml|<Workbook)/i.test(headStr)) {
    const decoded = decodeBuffer(buf);
    const root = pruneAlternateContent(parseXml(decoded.text));
    const sections = [];
    const outline = [];
    const plainLines = [];
    const maxRows = snippetOnly ? 14 : 500;
    const maxCols = snippetOnly ? 8 : 60;

    const xmlWorksheets = findAll(root, 'Worksheet');
    if (xmlWorksheets.length) {
      xmlWorksheets.slice(0, snippetOnly ? 1 : 20).forEach((ws, sIdx) => {
        const name = getAttr(ws, 'Name') || `Sheet${sIdx + 1}`;
        const rowMap = new Map();
        let maxR = -1;
        let maxC = -1;
        findAll(ws, 'Row').slice(0, maxRows).forEach((rNode, rIdx) => {
          const cells = new Map();
          let cCursor = 0;
          for (const cNode of findChildren(rNode, 'Cell')) {
            const explicitIdx = Number(getAttr(cNode, 'Index'));
            if (Number.isFinite(explicitIdx) && explicitIdx > 0) cCursor = explicitIdx - 1;
            if (cCursor < maxCols) {
              const txt = collectText(findChild(cNode, 'Data') || cNode).trim();
              if (txt) {
                cells.set(cCursor, txt);
                if (rIdx > maxR) maxR = rIdx;
                if (cCursor > maxC) maxC = cCursor;
              }
            }
            cCursor++;
          }
          if (cells.size) {
            rowMap.set(rIdx, cells);
            if (plainLines.length < 400) plainLines.push(Array.from(cells.values()).join('\t'));
          }
        });
        const id = `sheet-${sIdx}`;
        outline.push({ id, level: 1, title: name });
        sections.push({ id, title: name, rowCount: maxR + 1, colCount: maxC + 1, html: renderGridSectionHtml(rowMap, maxR, maxC) });
      });
    } else {
      const tables = findAll(root, 'table');
      (tables.length ? tables : [root]).slice(0, snippetOnly ? 1 : 10).forEach((tbl, sIdx) => {
        const name = tables.length > 1 ? `表格 ${sIdx + 1}` : 'Sheet1';
        const rowMap = new Map();
        let maxR = -1;
        let maxC = -1;
        findAll(tbl, 'tr').slice(0, maxRows).forEach((tr, rIdx) => {
          const cells = new Map();
          let cIdx = 0;
          for (const cell of (tr.children || []).filter((n) => n.local === 'td' || n.local === 'th')) {
            if (cIdx >= maxCols) break;
            const txt = collectText(cell).replace(/\s+/g, ' ').trim();
            if (txt) {
              cells.set(cIdx, txt);
              if (rIdx > maxR) maxR = rIdx;
              if (cIdx > maxC) maxC = cIdx;
            }
            cIdx += Math.max(1, Number(getAttr(cell, 'colspan') || 1));
          }
          if (cells.size) {
            rowMap.set(rIdx, cells);
            if (plainLines.length < 400) plainLines.push(Array.from(cells.values()).join('\t'));
          }
        });
        const id = `sheet-${sIdx}`;
        outline.push({ id, level: 1, title: name });
        sections.push({ id, title: name, rowCount: maxR + 1, colCount: maxC + 1, html: renderGridSectionHtml(rowMap, maxR, maxC) });
      });
    }

    return {
      ok: true,
      format: 'xlsx',
      formatLabel: 'Excel 表格',
      badge: 'XLS',
      path: filePath,
      title: path.basename(filePath),
      ext: 'xls',
      sizeBytes: stat.size,
      autoRender: true,
      supportsPaperMode: false,
      meta: { statsLabel: `${sections.length} 个工作表` },
      outline,
      sections,
      bodyHtml: sections[0]?.html || '<p class="aw-doc-empty-msg">表格为空。</p>',
      plainText: plainLines.join('\n').slice(0, MAX_PLAIN_CHARS),
      snippetLines: plainLines.slice(0, 12),
      warnings: [],
    };
  }

  // 3. True OLE2 BIFF8 Workbook
  const ole = readOle2Streams(buf);
  const wbBuf = ole ? ole.getStream('Workbook') || ole.getStream('Book') : null;
  if (!wbBuf) {
    // Check if plain text TSV/CSV disguised as .xls
    const dec = decodeBuffer(buf.subarray(0, Math.min(buf.length, 65536)));
    if (!dec.isBinary && dec.text.trim()) {
      return { redirectFormat: 'tsv_or_csv' };
    }
    throw new Error('未能识别此 .xls 文件的二进制工作簿结构');
  }

  // Pass 1: Collect BOUNDSHEET names & SST shared strings
  const boundSheets = [];
  let sstStrings = [];
  let pos = 0;
  while (pos + 4 <= wbBuf.length) {
    const recId = wbBuf.readUInt16LE(pos);
    const recLen = wbBuf.readUInt16LE(pos + 2);
    const dataStart = pos + 4;
    const dataEnd = Math.min(wbBuf.length, dataStart + recLen);
    pos = dataEnd;

    if (recId === 0x0085 && recLen >= 8) {
      // BOUNDSHEET
      const bofOffset = wbBuf.readUInt32LE(dataStart);
      const cch = wbBuf[dataStart + 6];
      const grbit = wbBuf[dataStart + 7];
      const is16 = Boolean(grbit & 0x01);
      const nameStart = dataStart + 8;
      const nameBytes = is16 ? cch * 2 : cch;
      const sheetName = is16
        ? wbBuf.subarray(nameStart, Math.min(dataEnd, nameStart + nameBytes)).toString('utf16le')
        : new TextDecoder('gb18030', { fatal: false }).decode(wbBuf.subarray(nameStart, Math.min(dataEnd, nameStart + nameBytes)));
      boundSheets.push({ name: sheetName || `Sheet${boundSheets.length + 1}`, bofOffset });
    } else if (recId === 0x00fc) {
      // SST + immediate CONTINUE (0x003C) records
      const sstFirst = wbBuf.subarray(dataStart, dataEnd);
      const continues = [];
      while (pos + 4 <= wbBuf.length && wbBuf.readUInt16LE(pos) === 0x003c) {
        const cLen = wbBuf.readUInt16LE(pos + 2);
        continues.push(wbBuf.subarray(pos + 4, Math.min(wbBuf.length, pos + 4 + cLen)));
        pos = Math.min(wbBuf.length, pos + 4 + cLen);
      }
      sstStrings = parseSstWithContinues(sstFirst, continues);
    } else if (recId === 0x000a) {
      // Globals EOF — sheets start right after!
      break;
    }
  }

  const maxRows = snippetOnly ? 14 : 500;
  const maxCols = snippetOnly ? 8 : 60;
  const sections = [];
  const outline = [];
  const plainChunks = [];
  const snippetLines = [];

  const sheetStarts = boundSheets.length
    ? boundSheets
    : [{ name: 'Sheet1', bofOffset: pos }];

  for (let sIdx = 0; sIdx < sheetStarts.length && sIdx < (snippetOnly ? 1 : 25); sIdx++) {
    const shMeta = sheetStarts[sIdx];
    let p = shMeta.bofOffset;
    if (p < 0 || p + 4 > wbBuf.length) continue;

    const rowMap = new Map();
    let maxR = -1;
    let maxC = -1;
    let lastFormulaCell = null;

    const putCell = (r, c, valStr) => {
      if (r < 0 || r >= maxRows || c < 0 || c >= maxCols || valStr === '') return;
      let row = rowMap.get(r);
      if (!row) {
        row = new Map();
        rowMap.set(r, row);
      }
      row.set(c, String(valStr));
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    };

    let depth = 0;
    while (p + 4 <= wbBuf.length) {
      const rid = wbBuf.readUInt16LE(p);
      const rlen = wbBuf.readUInt16LE(p + 2);
      const ds = p + 4;
      const de = Math.min(wbBuf.length, ds + rlen);
      p = de;

      if (rid === 0x0809) {
        depth++;
        continue;
      }
      if (rid === 0x000a) {
        depth--;
        if (depth <= 0) break;
        continue;
      }

      if (rid === 0x00fd && rlen >= 10) {
        // LABELSST
        const r = wbBuf.readUInt16LE(ds);
        const c = wbBuf.readUInt16LE(ds + 2);
        const idx = wbBuf.readUInt32LE(ds + 6);
        if (sstStrings[idx] !== undefined) putCell(r, c, sstStrings[idx]);
      } else if (rid === 0x0204 && rlen >= 8) {
        // LABEL
        const r = wbBuf.readUInt16LE(ds);
        const c = wbBuf.readUInt16LE(ds + 2);
        const str = decodeBiff8UnicodeString(wbBuf, ds + 6, de).text;
        putCell(r, c, str);
      } else if (rid === 0x0203 && rlen >= 14) {
        // NUMBER (IEEE 754)
        const r = wbBuf.readUInt16LE(ds);
        const c = wbBuf.readUInt16LE(ds + 2);
        const num = wbBuf.readDoubleLE(ds + 6);
        if (Number.isFinite(num)) putCell(r, c, /\.\d{7,}/.test(String(num)) ? Number(num.toFixed(4)) : num);
      } else if (rid === 0x027e && rlen >= 10) {
        // RK
        const r = wbBuf.readUInt16LE(ds);
        const c = wbBuf.readUInt16LE(ds + 2);
        putCell(r, c, decodeRkNumber(wbBuf.readInt32LE(ds + 6)));
      } else if (rid === 0x00bd && rlen >= 10) {
        // MULRK
        const r = wbBuf.readUInt16LE(ds);
        const colFirst = wbBuf.readUInt16LE(ds + 2);
        const colLast = wbBuf.readUInt16LE(de - 2);
        let curOff = ds + 4;
        for (let c = colFirst; c <= colLast && curOff + 6 <= de - 2; c++, curOff += 6) {
          putCell(r, c, decodeRkNumber(wbBuf.readInt32LE(curOff + 2)));
        }
      } else if (rid === 0x0006 && rlen >= 20) {
        // FORMULA cached result
        const r = wbBuf.readUInt16LE(ds);
        const c = wbBuf.readUInt16LE(ds + 2);
        if (wbBuf[ds + 12] === 0xff && wbBuf[ds + 13] === 0xff) {
          const fType = wbBuf[ds + 6];
          if (fType === 0) {
            lastFormulaCell = { r, c };
          } else if (fType === 1) {
            putCell(r, c, wbBuf[ds + 8] ? 'TRUE' : 'FALSE');
          }
        } else {
          const num = wbBuf.readDoubleLE(ds + 6);
          if (Number.isFinite(num)) putCell(r, c, /\.\d{7,}/.test(String(num)) ? Number(num.toFixed(4)) : num);
        }
      } else if (rid === 0x0207 && lastFormulaCell) {
        // STRING record following a string FORMULA
        const str = decodeBiff8UnicodeString(wbBuf, ds, de).text;
        putCell(lastFormulaCell.r, lastFormulaCell.c, str);
        lastFormulaCell = null;
      } else {
        lastFormulaCell = null;
      }
    }

    for (let r = 0; r <= maxR; r++) {
      const cells = rowMap.get(r);
      if (!cells) continue;
      const vals = Array.from(cells.values()).filter(Boolean);
      if (vals.length) {
        plainChunks.push(vals.join('\t'));
        if (sIdx === 0 && snippetLines.length < 12) snippetLines.push(vals.slice(0, 6).join(' | '));
      }
    }

    const secId = `sheet-${sIdx}`;
    outline.push({ id: secId, level: 1, title: shMeta.name });
    sections.push({
      id: secId,
      title: shMeta.name,
      rowCount: Math.max(0, maxR + 1),
      colCount: Math.max(0, maxC + 1),
      html: renderGridSectionHtml(rowMap, maxR, maxC),
    });
  }

  return {
    ok: true,
    format: 'xlsx',
    formatLabel: 'Excel 97-2003 表格',
    badge: 'XLS',
    path: filePath,
    title: path.basename(filePath),
    ext: 'xls',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: { statsLabel: `${sections.length} 个工作表` },
    outline,
    sections,
    bodyHtml: sections[0]?.html || '<p class="aw-doc-empty-msg">工作簿为空。</p>',
    plainText: plainChunks.join('\n').slice(0, MAX_PLAIN_CHARS),
    snippetLines: snippetLines.slice(0, 14),
    warnings: [],
  };
}

// ── 2. Legacy .ppt (PowerPoint 97-2003 OLE2 Slide Extractor + HiRes Hook) ───

export function parseLegacyPpt(buf, filePath, stat, { snippetOnly = false } = {}) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return { redirectFormat: 'pptx', warning: '此 .ppt 文件实为标准 PPTX 压缩包，已按新版画布解析。' };
  }

  const ole = readOle2Streams(buf);
  const pptStream = ole ? ole.getStream('PowerPoint Document') : null;
  if (!pptStream) {
    throw new Error('未能读取旧版 .ppt 的 PowerPoint Document 流，可点击右上角用系统软件打开。');
  }

  const slides = [];
  let currentSlideTexts = [];

  const walkRecords = (start, end, inSlide = false) => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = pptStream.readUInt16LE(p);
      const recVer = verInst & 0x0f;
      const recType = pptStream.readUInt16LE(p + 2);
      const recLen = pptStream.readUInt32LE(p + 4);
      const bodyStart = p + 8;
      const bodyEnd = Math.min(end, bodyStart + recLen);
      if (recLen > end - start || bodyEnd < bodyStart) break;

      if (recType === 0x03ee) {
        // Slide container
        const prev = currentSlideTexts;
        currentSlideTexts = [];
        walkRecords(bodyStart, bodyEnd, true);
        if (currentSlideTexts.length) slides.push(currentSlideTexts);
        currentSlideTexts = prev;
      } else if (recType === 0x03f3 && !inSlide) {
        // SlidePersistAtom inside SlideListWithText separates slide text runs
        if (currentSlideTexts.length) {
          slides.push(currentSlideTexts);
          currentSlideTexts = [];
        }
      } else if (recType === 0x0fa0) {
        // TextCharsAtom (UTF-16LE)
        const txt = pptStream
          .subarray(bodyStart, bodyEnd)
          .toString('utf16le')
          .replace(/\r/g, '\n')
          .trim();
        if (txt) currentSlideTexts.push(txt);
      } else if (recType === 0x0fa8) {
        // TextBytesAtom (Latin1 / CJK single-byte fallback)
        const txt = new TextDecoder('gb18030', { fatal: false })
          .decode(pptStream.subarray(bodyStart, bodyEnd))
          .replace(/\r/g, '\n')
          .trim();
        if (txt) currentSlideTexts.push(txt);
      } else if (recVer === 0x0f && recType !== 0x03e8) {
        // Container record (skip MainMaster 0x03F8 so master boilerplate isn't mistaken for slides!)
        if (recType !== 0x03f8 && recType !== 0x03f0) {
          walkRecords(bodyStart, bodyEnd, inSlide);
        }
      }

      p = bodyEnd;
    }
  };

  walkRecords(0, pptStream.length, false);
  if (currentSlideTexts.length) slides.push(currentSlideTexts);

  const outline = [];
  const cardsHtml = [];
  const plainChunks = [];
  const snippetLines = [];
  const limit = snippetOnly ? 6 : 100;

  slides.slice(0, limit).forEach((texts, idx) => {
    const lines = texts
      .flatMap((t) => t.split(/\n+/))
      .map((s) => s.trim())
      .filter((s) => s && s !== '*');
    if (!lines.length) return;
    const title = lines[0].slice(0, 72);
    const bodyLines = lines.slice(1);
    const slideNo = outline.length + 1;
    const anchorId = `aw-slide-${slideNo}`;
    outline.push({ id: anchorId, level: 1, title: `${slideNo}. ${title}` });
    snippetLines.push(`${slideNo}. ${title}`);
    plainChunks.push(`--- 第 ${slideNo} 页: ${title} ---\n${lines.join('\n')}`);

    if (!snippetOnly) {
      cardsHtml.push(`
        <section class="aw-slide-frame-wrap" id="${anchorId}" data-slide-no="${slideNo}">
          <div class="aw-slide-meta-line">
            <span class="aw-slide-idx">${String(slideNo).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}</span>
            <span class="aw-slide-caption">${escapeHtml(title)}</span>
          </div>
          <div class="aw-slide-stage aw-slide-stage-legacy" style="aspect-ratio:4 / 3">
            <div class="aw-ppt-legacy-inner">
              <div class="aw-ppt-legacy-title">${escapeHtml(title)}</div>
              ${bodyLines.map((b) => `<div class="aw-ppt-legacy-line">${escapeHtml(b)}</div>`).join('')}
            </div>
          </div>
        </section>
      `);
    }
  });

  return {
    ok: true,
    format: 'pptx',
    formatLabel: 'PowerPoint 97-2003 演示',
    badge: 'PPT',
    path: filePath,
    title: path.basename(filePath),
    ext: 'ppt',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    supportsLocalHiRes: true,
    meta: {
      statsLabel: `${outline.length || slides.length} 页 · 旧版 PPT`,
      slideCount: outline.length || slides.length,
    },
    outline,
    bodyHtml: cardsHtml.length
      ? `<div class="aw-slides-deck">${cardsHtml.join('\n')}</div>`
      : '<p class="aw-doc-empty-msg">未能提取旧版 .ppt 文本，可点击「本机精绘」或「系统打开」查看完整幻灯片。</p>',
    plainText: plainChunks.join('\n\n').slice(0, MAX_PLAIN_CHARS),
    snippetLines: snippetLines.slice(0, 14),
    warnings: ['旧版二进制 .ppt 默认展示提取版面；若本机装有 PowerPoint / WPS / LibreOffice，点击工具栏「本机精绘」即可无窗渲染 1:1 原稿画面。'],
  };
}

// ── 3. Jupyter / Colab Notebook (.ipynb) Renderer ───────────────────────────

function renderSimpleNotebookMarkdown(mdText, outline, headingSeqRef) {
  const lines = String(mdText || '').split(/\r?\n/);
  const html = [];
  let inFence = false;
  let fenceBuf = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        html.push(`<pre class="aw-nb-md-pre"><code>${escapeHtml(fenceBuf.join('\n'))}</code></pre>`);
        fenceBuf = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    const hm = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (hm) {
      const lvl = hm[1].length;
      const rawTitle = hm[2].replace(/[*_`]/g, '').trim();
      const hid = `aw-h-${++headingSeqRef.n}`;
      if (rawTitle) outline.push({ id: hid, level: lvl, title: rawTitle.slice(0, 80) });
      html.push(`<h${lvl} id="${hid}" class="aw-doc-h aw-doc-h${lvl}">${escapeHtml(rawTitle)}</h${lvl}>`);
      continue;
    }
    if (!line.trim()) continue;
    let inline = escapeHtml(line)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    if (/^\s*[-*+]\s+/.test(line)) {
      inline = inline.replace(/^\s*[-*+]\s+/, '');
      html.push(`<p class="aw-doc-p aw-doc-list-item"><span class="aw-doc-list-marker">•</span><span class="aw-doc-list-body">${inline}</span></p>`);
    } else {
      html.push(`<p class="aw-doc-p">${inline}</p>`);
    }
  }
  if (inFence && fenceBuf.length) {
    html.push(`<pre class="aw-nb-md-pre"><code>${escapeHtml(fenceBuf.join('\n'))}</code></pre>`);
  }
  return html.join('\n');
}

export function parseIpynb(buf, filePath, stat, { snippetOnly = false } = {}) {
  const text = buf.toString('utf8');
  let nb;
  try {
    nb = JSON.parse(text);
  } catch (err) {
    throw new Error(`Notebook JSON 解析失败：${err?.message || err}`);
  }
  const cells = Array.isArray(nb?.cells) ? nb.cells : [];
  const kernel =
    nb?.metadata?.kernelspec?.display_name ||
    nb?.metadata?.language_info?.name ||
    'Python';

  const outline = [];
  const plainChunks = [];
  const snippetLines = [];
  const cellsHtml = [];
  const headingSeqRef = { n: 0 };
  let usedImgBytes = 0;

  const joinSource = (src) => (Array.isArray(src) ? src.join('') : String(src || ''));
  const maxCells = snippetOnly ? 8 : 300;

  for (let i = 0; i < cells.length && i < maxCells; i++) {
    const cell = cells[i];
    if (!cell || typeof cell !== 'object') continue;
    const cType = String(cell.cell_type || 'code');
    const src = joinSource(cell.source).replace(/\r\n/g, '\n');

    if (cType === 'markdown' || cType === 'raw') {
      if (!src.trim()) continue;
      plainChunks.push(src.trim());
      if (snippetLines.length < 12) snippetLines.push(...src.trim().split('\n').slice(0, 3));
      if (!snippetOnly) {
        const mdHtml = cType === 'raw' ? `<pre class="aw-nb-md-pre">${escapeHtml(src)}</pre>` : renderSimpleNotebookMarkdown(src, outline, headingSeqRef);
        cellsHtml.push(`<section class="aw-nb-cell aw-nb-cell-md">${mdHtml}</section>`);
      }
      continue;
    }

    if (cType === 'code') {
      const execCount = cell.execution_count ?? ' ';
      if (src.trim()) {
        plainChunks.push(`In [${execCount}]:\n${src.trim()}`);
        if (snippetLines.length < 12) snippetLines.push(`[${execCount}] ${src.trim().split('\n')[0].slice(0, 72)}`);
      }
      if (snippetOnly) continue;

      const outBlocks = [];
      for (const out of Array.isArray(cell.outputs) ? cell.outputs : []) {
        const oType = out?.output_type;
        if (oType === 'stream') {
          const sTxt = stripAnsiCodes(joinSource(out.text)).trimEnd();
          if (sTxt) {
            plainChunks.push(sTxt.slice(0, 2000));
            outBlocks.push(`<pre class="aw-nb-out-pre${out.name === 'stderr' ? ' aw-nb-out-err' : ''}">${escapeHtml(sTxt.slice(0, 16000))}</pre>`);
          }
        } else if (oType === 'error') {
          const tb = stripAnsiCodes((Array.isArray(out.traceback) ? out.traceback.join('\n') : `${out.ename || 'Error'}: ${out.evalue || ''}`)).trim();
          if (tb) outBlocks.push(`<pre class="aw-nb-out-pre aw-nb-out-err">${escapeHtml(tb.slice(0, 12000))}</pre>`);
        } else if (oType === 'display_data' || oType === 'execute_result') {
          const data = out.data || {};
          let renderedRich = false;
          for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
            if (data[mime]) {
              const b64 = joinSource(data[mime]).replace(/\s+/g, '');
              if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) continue;
              if (b64.length * 0.75 <= 4 * 1024 * 1024 && usedImgBytes + b64.length * 0.75 <= 14 * 1024 * 1024) {
                usedImgBytes += b64.length * 0.75;
                outBlocks.push(`<div class="aw-nb-out-img"><img src="data:${escapeHtml(mime)};base64,${escapeHtml(b64)}" alt="Notebook 输出图表" loading="lazy" /></div>`);
                renderedRich = true;
                break;
              }
            }
          }
          if (!renderedRich && data['text/plain']) {
            const pTxt = stripAnsiCodes(joinSource(data['text/plain'])).trimEnd();
            if (pTxt) {
              plainChunks.push(pTxt.slice(0, 2000));
              outBlocks.push(`<pre class="aw-nb-out-pre">${escapeHtml(pTxt.slice(0, 16000))}</pre>`);
            }
          }
        }
      }

      cellsHtml.push(`
        <section class="aw-nb-cell aw-nb-cell-code">
          <div class="aw-nb-code-wrap">
            <span class="aw-nb-prompt">[${escapeHtml(String(execCount))}]</span>
            <pre class="aw-nb-code-pre"><code>${escapeHtml(src)}</code></pre>
          </div>
          ${outBlocks.length ? `<div class="aw-nb-outputs">${outBlocks.join('\n')}</div>` : ''}
        </section>
      `);
    }
  }

  const codeCellCount = cells.filter((c) => c?.cell_type === 'code').length;
  return {
    ok: true,
    format: 'ipynb',
    formatLabel: 'Jupyter 笔记本',
    badge: 'IPYNB',
    path: filePath,
    title: path.basename(filePath),
    ext: 'ipynb',
    sizeBytes: stat.size,
    autoRender: true,
    preferWhenRawCode: true,
    supportsPaperMode: false,
    meta: {
      statsLabel: `${cells.length} 单元 (${codeCellCount} 代码) · ${kernel}`,
    },
    outline,
    bodyHtml: `<div class="aw-nb-List">${cellsHtml.join('\n') || '<p class="aw-doc-empty-msg">笔记本无单元格。</p>'}</div>`,
    plainText: plainChunks.join('\n\n').slice(0, MAX_PLAIN_CHARS),
    snippetLines: [`[${kernel} · ${cells.length} 单元]`, ...snippetLines].slice(0, 14),
    warnings: cells.length > maxCells && !snippetOnly ? [`共 ${cells.length} 个单元格，已展示前 ${maxCells} 个。`] : [],
  };
}

// ── 4. SQLite Database (.sqlite / .sqlite3 / .db) Read-Only Inspector ───────

const SQLITE_MAGIC = 'SQLite format 3\0';

function quoteSqlIdent(name) {
  return `"${String(name || '').replace(/"/g, '""')}"`;
}

export function parseSqliteDb(buf, filePath, stat, { snippetOnly = false } = {}) {
  let hdr = buf;
  if (!hdr) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const slice = Buffer.allocUnsafe(100);
      const n = fs.readSync(fd, slice, 0, 100, 0);
      hdr = slice.subarray(0, n);
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }
  if (!hdr || hdr.length < 100 || hdr.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    throw new Error('该文件不是标准 SQLite 3 数据库格式');
  }

  let sqliteMod;
  try {
    sqliteMod = requireBuiltin('node:sqlite');
  } catch {
    throw new Error('当前 Node.js 运行时未内置 node:sqlite 模块（需 Node >= 22.5）');
  }

  const { DatabaseSync } = sqliteMod;
  let db = null;
  try {
    try {
      db = new DatabaseSync(filePath, { open: true, readOnly: true });
    } catch (openErr) {
      // Fallback for WAL databases located in read-only directories
      const roUri = `${pathToFileURL(path.resolve(filePath)).href}?mode=ro&immutable=1`;
      try {
        db = new DatabaseSync(roUri, { open: true, readOnly: true });
      } catch {
        throw openErr;
      }
    }
    const objects = db
      .prepare(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name LIMIT 40`
      )
      .all();

    const sections = [];
    const outline = [];
    const snippetLines = [];
    const plainChunks = [];
    const warnings = [];
    const maxRows = snippetOnly ? 10 : 300;
    const maxTables = snippetOnly ? 3 : 30;

    for (let i = 0; i < objects.length && i < maxTables; i++) {
      const obj = objects[i];
      const tName = String(obj.name || '');
      const qName = quoteSqlIdent(tName);
      let cols = [];
      let totalRows = 0;
      let rows = [];

      try {
        cols = db.prepare(`PRAGMA table_info(${qName})`).all();
        const cntRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${qName}`).get();
        totalRows = Number(cntRow?.cnt || 0);
        if (!snippetOnly || i === 0) {
          rows = db.prepare(`SELECT * FROM ${qName} LIMIT ${maxRows}`).all();
        }
      } catch (qErr) {
        warnings.push(`读取表 ${tName} 时跳过：${qErr?.message || qErr}`);
        continue;
      }

      const colNames = cols.length ? cols.map((c) => String(c.name)) : rows[0] ? Object.keys(rows[0]) : [];
      snippetLines.push(`${tName} (${totalRows} 行 · ${colNames.length} 列)`);

      if (!snippetOnly) {
        let html = '<p class="aw-doc-empty-msg">此数据表暂无记录。</p>';
        if (colNames.length > 0) {
          const thead = `<thead><tr><th class="aw-sheet-corner">#</th>${colNames
            .map((cn) => {
              const colInfo = cols.find((c) => c.name === cn);
              const tHint = colInfo?.type ? ` <span class="aw-sqlite-type">${escapeHtml(String(colInfo.type).toUpperCase())}</span>` : '';
              return `<th>${escapeHtml(cn)}${tHint}</th>`;
            })
            .join('')}</tr></thead>`;
          const tbody = rows.length
            ? `<tbody>${rows
                .map((row, rIdx) => {
                  const vals = [];
                  const tds = [`<td class="aw-sheet-rn">${rIdx + 1}</td>`];
                  for (const cn of colNames) {
                    const rawV = row[cn];
                    let display = '';
                    let isNum = false;
                    if (rawV === null || rawV === undefined) {
                      display = 'NULL';
                    } else if (rawV instanceof Uint8Array || Buffer.isBuffer(rawV)) {
                      display = `[BLOB ${formatBytes(rawV.byteLength)}]`;
                    } else if (typeof rawV === 'number' || typeof rawV === 'bigint') {
                      display = String(rawV);
                      isNum = true;
                    } else {
                      display = String(rawV).slice(0, 400);
                    }
                    vals.push(display);
                    tds.push(`<td${isNum ? ' class="aw-sheet-num"' : rawV === null ? ' class="aw-doc-muted"' : ''}>${escapeHtml(display)}</td>`);
                  }
                  if (plainChunks.length < 600) plainChunks.push(vals.join('\t'));
                  return `<tr data-aw-row="${rIdx + 1}">${tds.join('')}</tr>`;
                })
                .join('')}</tbody>`
            : `<tbody><tr><td colspan="${colNames.length + 1}" class="aw-doc-empty-msg">表内 0 条记录（列结构已展示）</td></tr></tbody>`;
          html = `<div class="aw-sheet-wrap"><table class="aw-sheet-table">${thead}${tbody}</table></div>`;
        }
        if (totalRows > maxRows) {
          warnings.push(`表「${tName}」共 ${totalRows.toLocaleString('en-US')} 行，当前展示前 ${maxRows} 行。`);
        }
        const secId = `table-${i}`;
        outline.push({ id: secId, level: 1, title: `${tName} (${totalRows})` });
        sections.push({
          id: secId,
          title: `${tName} (${totalRows})`,
          rowCount: totalRows,
          colCount: colNames.length,
          html,
        });
      }
    }

    return {
      ok: true,
      format: 'sqlite',
      formatLabel: 'SQLite 数据库',
      badge: 'SQLITE',
      path: filePath,
      title: path.basename(filePath),
      ext: path.extname(filePath).slice(1).toLowerCase() || 'sqlite',
      sizeBytes: stat.size,
      autoRender: true,
      supportsPaperMode: false,
      meta: {
        statsLabel: `${objects.length} 张数据表 · ${formatBytes(stat.size)}`,
      },
      outline,
      sections,
      bodyHtml: sections[0]?.html || '<p class="aw-doc-empty-msg">数据库中暂无用户表。</p>',
      plainText: plainChunks.join('\n').slice(0, MAX_PLAIN_CHARS),
      snippetLines: snippetLines.slice(0, 14),
      warnings,
    };
  } finally {
    try { db?.close?.(); } catch {}
  }
}

// ── 5. POSIX & Multi-Archive Inventory (.tar, .tar.gz, .tgz, .7z, .rar) ─────

function parseTarBufferEntries(tarBuf, maxItems = 400) {
  const entries = [];
  let pos = 0;
  let paxPath = '';
  let gnuLongName = '';

  while (pos + 512 <= tarBuf.length && entries.length < maxItems) {
    const hdr = tarBuf.subarray(pos, pos + 512);
    // Check end-of-archive zero block
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (hdr[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const readNullTerm = (start, len) => {
      const sub = hdr.subarray(start, start + len);
      const nul = sub.indexOf(0);
      return (nul >= 0 ? sub.subarray(0, nul) : sub).toString('utf8').trim();
    };

    const rawName = readNullTerm(0, 100);
    const sizeOctal = readNullTerm(124, 12);
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const typeFlag = hdr[156] ? String.fromCharCode(hdr[156]) : '0';
    const prefix = readNullTerm(345, 155);
    const dataStart = pos + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    pos = dataStart + paddedSize;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // PAX extended header
      const paxText = tarBuf.subarray(dataStart, Math.min(tarBuf.length, dataStart + size)).toString('utf8');
      for (const line of paxText.split('\n')) {
        const m = /^\d+\s+path=(.+)$/.exec(line);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (typeFlag === 'L') {
      // GNU LongLink
      gnuLongName = tarBuf.subarray(dataStart, Math.min(tarBuf.length, dataStart + size)).toString('utf8').replace(/\0+$/, '');
      continue;
    }

    const fullName = (paxPath || gnuLongName || (prefix ? `${prefix}/${rawName}` : rawName)).replace(/^\/+/, '');
    paxPath = '';
    gnuLongName = '';
    if (!fullName) continue;

    const isDir = typeFlag === '5' || fullName.endsWith('/');
    entries.push({ name: fullName, isDirectory: isDir, size });
  }
  return entries;
}

export function parseTarListingLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  const isDir = line.startsWith('d') || line.endsWith('/');
  // GNU tar -tvf: -rw-r--r-- root/root 1248 2026-11-27 02:15 path/to/file
  const gnu = /^[dlbcps-][rwxstST-]{9}[.+@]?\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/.exec(line);
  if (gnu) {
    const name = gnu[2].trim();
    return { name, isDirectory: isDir || name.endsWith('/'), size: Number(gnu[1] || 0) };
  }
  // BSD tar -tvf: -rw-r--r--  0 user group 1248 Nov 27 02:15 path/to/file
  const bsd = /^[dlbcps-][rwxstST-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
  if (bsd) {
    const name = bsd[2].trim();
    return { name, isDirectory: isDir || name.endsWith('/'), size: Number(bsd[1] || 0) };
  }
  return { name: line, isDirectory: isDir, size: 0 };
}

function parse7zSltOutput(rawOut, maxItems = 400) {
  const entries = [];
  let cur = null;
  const flush = () => {
    if (!cur || !cur.name || entries.length >= maxItems) return;
    entries.push({
      name: cur.name.replace(/\\/g, '/'),
      isDirectory: Boolean(cur.isDirectory || cur.name.endsWith('/')),
      size: Number(cur.size || 0),
    });
  };
  let inList = false;
  for (const rawLine of String(rawOut || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '----------') {
      inList = true;
      cur = null;
      continue;
    }
    if (!inList) continue;
    if (!line.trim()) {
      flush();
      cur = null;
      continue;
    }
    if (!cur) cur = { name: '', size: 0, isDirectory: false };
    if (line.startsWith('Path = ')) cur.name = line.slice(7).trim();
    else if (line.startsWith('Size = ')) cur.size = Number(line.slice(7).trim() || 0);
    else if (line.startsWith('Folder = ')) cur.isDirectory = line.slice(9).trim() === '+';
    else if (line.startsWith('Attributes = ')) {
      if (/\bD\b|^D/i.test(line.slice(13).trim())) cur.isDirectory = true;
    }
  }
  flush();
  return entries;
}

function listArchiveViaExternalTools(filePath, maxItems = 400) {
  const lower = path.basename(filePath).toLowerCase();
  const is7zOrRar = lower.endsWith('.7z') || lower.endsWith('.rar');
  const execOpts = {
    encoding: 'utf8',
    timeout: 4500,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  };

  if (is7zOrRar) {
    for (const bin of ['7z', '7zz', '7za']) {
      try {
        const out = execFileSync(bin, ['l', '-slt', '-sccUTF-8', filePath], execOpts);
        const parsed = parse7zSltOutput(out, maxItems);
        if (parsed.length) return parsed;
      } catch {}
    }
    if (lower.endsWith('.rar')) {
      for (const bin of ['unrar', 'rar']) {
        try {
          const out = execFileSync(bin, ['lb', filePath], execOpts);
          const entries = String(out || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, maxItems)
            .map((name) => ({ name: name.replace(/\\/g, '/'), isDirectory: name.endsWith('/') || name.endsWith('\\'), size: 0 }));
          if (entries.length) return entries;
        } catch {}
      }
    }
  }

  const tarBins = process.platform === 'win32' ? ['tar'] : ['bsdtar', 'tar'];
  let lastErr = null;
  for (const bin of tarBins) {
    const argVariants = [];
    if (bin === 'tar' && process.platform !== 'win32' && filePath.includes(':')) {
      argVariants.push(['--force-local', '-tvf', filePath]);
    }
    argVariants.push(['-tvf', filePath]);
    for (const args of argVariants) {
      try {
        const out = execFileSync(bin, args, execOpts);
        const entries = [];
        for (const line of String(out || '').split(/\r?\n/)) {
          if (!line.trim() || entries.length >= maxItems) continue;
          const item = parseTarListingLine(line);
          if (item) entries.push(item);
        }
        return entries;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr || new Error('当前系统缺少可用归档列表工具（可安装 7z / bsdtar / unrar）');
}

export function parseArchiveInventory(buf, filePath, stat, { snippetOnly = false } = {}) {
  const lower = path.basename(filePath).toLowerCase();
  const maxItems = snippetOnly ? 12 : 400;
  let entries = [];
  let badge = path.extname(filePath).slice(1).toUpperCase() || 'ARCHIVE';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) badge = 'TAR.GZ';
  else if (lower.endsWith('.tar.xz')) badge = 'TAR.XZ';
  else if (lower.endsWith('.tar.bz2')) badge = 'TAR.BZ2';
  else if (lower.endsWith('.tar.zst')) badge = 'TAR.ZST';

  const isGzipMagic = buf.length >= 3 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (lower.endsWith('.tar')) {
    entries = parseTarBufferEntries(buf, maxItems);
  } else if ((lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) && isGzipMagic) {
    const inflated = zlib.gunzipSync(buf, { maxOutputLength: MAX_ARCHIVE_UNZIP_BYTES });
    entries = parseTarBufferEntries(inflated, maxItems);
  } else {
    entries = listArchiveViaExternalTools(filePath, maxItems);
  }

  const files = entries.filter((e) => !e.isDirectory);
  const totalBytes = files.reduce((s, e) => s + (e.size || 0), 0);
  const rowsHtml = entries
    .map((e) => {
      const kind = e.isDirectory ? '目录' : (path.extname(e.name).slice(1).toUpperCase() || '文件');
      return `<tr><td><span class="aw-doc-zip-tag">${escapeHtml(kind)}</span>${escapeHtml(e.name)}</td><td class="aw-sheet-num">${e.isDirectory ? '—' : formatBytes(e.size)}</td></tr>`;
    })
    .join('');

  const snippetLines = entries.slice(0, 12).map((e) => `${e.isDirectory ? '[目录] ' : ''}${e.name}`);
  return {
    ok: true,
    format: 'zip',
    formatLabel: `${badge} 归档包`,
    badge,
    path: filePath,
    title: path.basename(filePath),
    ext: badge.toLowerCase(),
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: {
      statsLabel: `${files.length} 个文件 · 原始约 ${formatBytes(totalBytes)}`,
    },
    outline: [],
    bodyHtml: entries.length
      ? `<div class="aw-doc-table-wrap"><table class="aw-doc-table"><thead><tr><th>归档内路径</th><th style="width:110px">原始大小</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
      : '<p class="aw-doc-empty-msg">归档包为空。</p>',
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings: [],
  };
}

// ── 6. Interactive 3D Mesh Parser (.obj / .stl / .glb) ──────────────────────

function finalizeMeshPreview(rawVerts, rawTris, filePath, stat, extraMeta = {}, { snippetOnly = false } = {}) {
  const vertexCount = Math.floor(rawVerts.length / 3);
  const totalTriCount = Math.floor(rawTris.length / 3);
  if (vertexCount === 0 || totalTriCount === 0) {
    throw new Error('模型中未检测到有效的三维网格顶点与三角面');
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < rawVerts.length; i += 3) {
    const x = rawVerts[i], y = rawVerts[i + 1], z = rawVerts[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const sizeX = Number((maxX - minX).toFixed(3));
  const sizeY = Number((maxY - minY).toFixed(3));
  const sizeZ = Number((maxZ - minZ).toFixed(3));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const maxSpan = Math.max(1e-6, maxX - minX, maxY - minY, maxZ - minZ);
  const normScale = 2 / maxSpan;

  const badge = path.extname(filePath).slice(1).toUpperCase() || '3D';
  const statsLabel = `${vertexCount.toLocaleString('en-US')} 顶点 · ${totalTriCount.toLocaleString('en-US')} 三角面`;
  const snippetLines = [
    `三维模型 (${badge}) · ${statsLabel}`,
    `包围盒尺寸: ${sizeX} × ${sizeY} × ${sizeZ}`,
    ...(extraMeta.notes || []),
  ];

  let meshData = null;
  const warnings = [];
  if (!snippetOnly) {
    // Decimate triangles uniformly if model is huge so sidebar stays 60fps with <500KB payload
    const stride = totalTriCount > MAX_MESH_TRIANGLES ? Math.ceil(totalTriCount / MAX_MESH_TRIANGLES) : 1;
    if (stride > 1) {
      warnings.push(`原模型含 ${totalTriCount.toLocaleString('en-US')} 个三角面，侧边栏已按 1/${stride} 均匀抽稀以保持流畅旋转。`);
    }
    const remap = new Int32Array(vertexCount).fill(-1);
    const outVerts = [];
    const outTris = [];
    let nextIdx = 0;

    for (let t = 0; t < totalTriCount; t += stride) {
      const i0 = rawTris[t * 3];
      const i1 = rawTris[t * 3 + 1];
      const i2 = rawTris[t * 3 + 2];
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;
      const mapped = [i0, i1, i2].map((orig) => {
        if (remap[orig] !== -1) return remap[orig];
        const nx = Number(((rawVerts[orig * 3] - cx) * normScale).toFixed(4));
        const ny = Number(((rawVerts[orig * 3 + 1] - cy) * normScale).toFixed(4));
        const nz = Number(((rawVerts[orig * 3 + 2] - cz) * normScale).toFixed(4));
        outVerts.push(nx, ny, nz);
        remap[orig] = nextIdx;
        return nextIdx++;
      });
      outTris.push(mapped[0], mapped[1], mapped[2]);
    }

    meshData = {
      positions: outVerts,
      indices: outTris,
      vertexCount,
      triangleCount: totalTriCount,
      bbox: [sizeX, sizeY, sizeZ],
      materialsCount: extraMeta.materialsCount || 0,
      animationsCount: extraMeta.animationsCount || 0,
    };
  }

  return {
    ok: true,
    format: 'model3d',
    formatLabel: `${badge} 三维模型`,
    badge,
    path: filePath,
    title: path.basename(filePath),
    ext: badge.toLowerCase(),
    sizeBytes: stat.size,
    autoRender: true,
    preferWhenRawCode: badge === 'OBJ' || badge === 'STL',
    supportsPaperMode: false,
    meshData,
    meta: { statsLabel },
    outline: [],
    bodyHtml: '',
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings,
  };
}

function parseObjMesh(buf, filePath, stat, opts) {
  const txt = buf.toString('utf8');
  const verts = [];
  const tris = [];
  const materials = new Set();

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] === '#') continue;
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      if (p.length >= 4) {
        verts.push(Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0);
      }
    } else if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1);
      if (p.length < 3) continue;
      const vTotal = verts.length / 3;
      const idxs = p.map((tok) => {
        const rawIdx = parseInt(tok.split('/')[0], 10);
        return rawIdx < 0 ? vTotal + rawIdx : rawIdx - 1;
      });
      for (let k = 1; k + 1 < idxs.length; k++) {
        if (idxs[0] >= 0 && idxs[k] >= 0 && idxs[k + 1] >= 0) {
          tris.push(idxs[0], idxs[k], idxs[k + 1]);
        }
      }
    } else if (line.startsWith('usemtl ')) {
      materials.add(line.slice(7).trim());
    }
  }
  return finalizeMeshPreview(verts, tris, filePath, stat, { materialsCount: materials.size }, opts);
}

function parseStlMesh(buf, filePath, stat, opts) {
  // Detect binary STL vs ASCII STL accurately
  let isBinary = false;
  if (buf.length >= 84) {
    const triCount = buf.readUInt32LE(80);
    if (triCount > 0 && 84 + triCount * 50 === buf.length) {
      isBinary = true;
    } else if (!buf.subarray(0, 64).toString('latin1').trimStart().toLowerCase().startsWith('solid')) {
      isBinary = buf.length >= 134;
    }
  }

  const verts = [];
  const tris = [];
  if (isBinary) {
    const count = Math.min(Math.floor((buf.length - 84) / 50), 300000);
    for (let i = 0; i < count; i++) {
      const off = 84 + i * 50 + 12; // skip 12-byte normal
      const baseV = verts.length / 3;
      for (let v = 0; v < 3; v++) {
        verts.push(
          buf.readFloatLE(off + v * 12),
          buf.readFloatLE(off + v * 12 + 4),
          buf.readFloatLE(off + v * 12 + 8)
        );
      }
      tris.push(baseV, baseV + 1, baseV + 2);
    }
  } else {
    const txt = buf.toString('utf8');
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      verts.push(Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0);
    }
    const triCount = Math.floor(verts.length / 9);
    for (let i = 0; i < triCount; i++) {
      tris.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
  }
  return finalizeMeshPreview(verts, tris, filePath, stat, {}, opts);
}

function parseGlbMesh(buf, filePath, stat, opts) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('不是有效的二进制 glTF (.glb) 文件');
  }
  let pos = 12;
  let jsonDoc = null;
  let binChunk = null;
  while (pos + 8 <= buf.length) {
    const chunkLen = buf.readUInt32LE(pos);
    const chunkType = buf.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = Math.min(buf.length, dataStart + chunkLen);
    if (chunkType === 0x4e4f534a) {
      jsonDoc = JSON.parse(buf.subarray(dataStart, dataEnd).toString('utf8'));
    } else if (chunkType === 0x004e4942) {
      binChunk = buf.subarray(dataStart, dataEnd);
    }
    pos = dataEnd;
  }
  if (!jsonDoc || !binChunk) {
    throw new Error('GLB 缺少 JSON 或二进制几何数据块');
  }

  const accessors = jsonDoc.accessors || [];
  const bufferViews = jsonDoc.bufferViews || [];
  const verts = [];
  const tris = [];

  for (const mesh of jsonDoc.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue; // TRIANGLES = 4
      const posAccIdx = prim.attributes?.POSITION;
      if (posAccIdx === undefined || !accessors[posAccIdx]) continue;
      const posAcc = accessors[posAccIdx];
      const posBv = bufferViews[posAcc.bufferView];
      if (!posBv || posAcc.componentType !== 5126) continue; // FLOAT = 5126

      const baseVert = verts.length / 3;
      const stride = posBv.byteStride || 12;
      const startOff = (posBv.byteOffset || 0) + (posAcc.byteOffset || 0);
      for (let i = 0; i < posAcc.count; i++) {
        const o = startOff + i * stride;
        if (o + 12 > binChunk.length) break;
        verts.push(binChunk.readFloatLE(o), binChunk.readFloatLE(o + 4), binChunk.readFloatLE(o + 8));
      }

      if (prim.indices !== undefined && accessors[prim.indices]) {
        const idxAcc = accessors[prim.indices];
        const idxBv = bufferViews[idxAcc.bufferView];
        if (!idxBv) continue;
        const iStart = (idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0);
        const ct = idxAcc.componentType;
        const readIdx = (k) => {
          if (ct === 5123) return binChunk.readUInt16LE(iStart + k * 2);
          if (ct === 5125) return binChunk.readUInt32LE(iStart + k * 4);
          if (ct === 5121) return binChunk[iStart + k];
          return 0;
        };
        for (let k = 0; k + 2 < idxAcc.count; k += 3) {
          tris.push(baseVert + readIdx(k), baseVert + readIdx(k + 1), baseVert + readIdx(k + 2));
        }
      } else {
        for (let k = 0; k + 2 < posAcc.count; k += 3) {
          tris.push(baseVert + k, baseVert + k + 1, baseVert + k + 2);
        }
      }
    }
  }

  return finalizeMeshPreview(
    verts,
    tris,
    filePath,
    stat,
    {
      materialsCount: (jsonDoc.materials || []).length,
      animationsCount: (jsonDoc.animations || []).length,
      notes: [
        `材质: ${(jsonDoc.materials || []).length} · 动画: ${(jsonDoc.animations || []).length}`,
      ],
    },
    opts
  );
}

export function parse3dModel(buf, filePath, stat, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.glb') return parseGlbMesh(buf, filePath, stat, opts);
  if (ext === '.stl') return parseStlMesh(buf, filePath, stat, opts);
  return parseObjMesh(buf, filePath, stat, opts);
}

// ── 7. Font Specimen Waterfall (.ttf / .otf / .woff / .woff2) ───────────────

const FONT_MIME = Object.freeze({
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function extractOpenTypeNames(buf) {
  const info = { family: '', subfamily: '', fullName: '', version: '' };
  if (!buf || buf.length < 12) return info;
  const sfnt = buf.readUInt32BE(0);
  // TrueType 0x00010000 or OpenType 'OTTO' 0x4f54544f
  if (sfnt !== 0x00010000 && sfnt !== 0x4f54544f && sfnt !== 0x74727565) return info;
  const numTables = buf.readUInt16BE(4);
  let nameOffset = 0;
  let nameLen = 0;
  for (let i = 0; i < numTables && 12 + (i + 1) * 16 <= buf.length; i++) {
    const recOff = 12 + i * 16;
    const tag = buf.subarray(recOff, recOff + 4).toString('latin1');
    if (tag === 'name') {
      nameOffset = buf.readUInt32BE(recOff + 8);
      nameLen = buf.readUInt32BE(recOff + 12);
      break;
    }
  }
  if (!nameOffset || nameOffset + 6 > buf.length) return info;
  const count = buf.readUInt16BE(nameOffset + 2);
  const strStorage = nameOffset + buf.readUInt16BE(nameOffset + 4);
  for (let i = 0; i < count && nameOffset + 6 + (i + 1) * 12 <= buf.length; i++) {
    const ro = nameOffset + 6 + i * 12;
    const platformId = buf.readUInt16BE(ro);
    const nameId = buf.readUInt16BE(ro + 6);
    const len = buf.readUInt16BE(ro + 8);
    const off = strStorage + buf.readUInt16BE(ro + 10);
    if (off + len > buf.length || len <= 0 || len > 256) continue;
    let val = '';
    if (platformId === 3 || platformId === 0) {
      // UTF-16BE
      const swapped = Buffer.allocUnsafe(len - (len % 2));
      for (let b = 0; b + 1 < swapped.length; b += 2) {
        swapped[b] = buf[off + b + 1];
        swapped[b + 1] = buf[off + b];
      }
      val = swapped.toString('utf16le').replace(/\0/g, '').trim();
    } else if (platformId === 1) {
      val = buf.subarray(off, off + len).toString('latin1').replace(/\0/g, '').trim();
    }
    if (!val) continue;
    if (nameId === 1 && (!info.family || platformId === 3)) info.family = val;
    else if (nameId === 2 && (!info.subfamily || platformId === 3)) info.subfamily = val;
    else if (nameId === 4 && (!info.fullName || platformId === 3)) info.fullName = val;
    else if (nameId === 5 && !info.version) info.version = val;
  }
  return info;
}

export function parseFontSpecimen(buf, filePath, stat, { snippetOnly = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = FONT_MIME[ext] || 'font/ttf';
  const names = extractOpenTypeNames(buf);
  const displayFamily = names.fullName || [names.family, names.subfamily].filter(Boolean).join(' ') || path.basename(filePath, ext);
  const badge = ext.slice(1).toUpperCase() || 'FONT';

  const statsLabel = [names.subfamily, formatBytes(stat.size)].filter(Boolean).join(' · ');
  const snippetLines = [
    `字体文件 (${badge}) · ${displayFamily}`,
    names.version ? `版本: ${names.version}` : '',
    `体积: ${formatBytes(stat.size)}`,
  ].filter(Boolean);

  let fontData = null;
  const warnings = [];
  if (!snippetOnly) {
    if (buf.length <= MAX_FONT_EMBED_BYTES) {
      fontData = {
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        displayFamily,
        subfamily: names.subfamily || 'Regular',
        version: names.version || '',
      };
    } else {
      warnings.push(`字体文件体积 ${formatBytes(stat.size)} 超过内嵌上限，请点击系统打开预览。`);
    }
  }

  return {
    ok: true,
    format: 'font',
    formatLabel: '字体样张',
    badge,
    path: filePath,
    title: displayFamily,
    ext: ext.slice(1),
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    fontData,
    meta: { statsLabel },
    outline: [],
    bodyHtml: '',
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings,
  };
}

// ── 8. Subtitle & Lyric Timeline (.srt / .ass / .ssa / .vtt / .lrc) ─────────

export function parseSubtitleTimeline(buf, filePath, stat, { snippetOnly = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const decoded = decodeBuffer(buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024)));
  const rawText = String(decoded.text || '').replace(/^\uFEFF/, '');
  const cues = [];
  const maxCues = snippetOnly ? 12 : 1200;

  if (ext === '.ass' || ext === '.ssa') {
    let formatCols = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    for (const line of rawText.split(/\r?\n/)) {
      if (cues.length >= maxCues) break;
      if (/^Format:/i.test(line)) {
        const cols = line
          .slice(7)
          .split(',')
          .map((c) => c.trim().toLowerCase());
        if (cols.includes('text') && cols.includes('start')) formatCols = cols;
      } else if (/^Dialogue:/i.test(line)) {
        const rest = line.slice(9).trimStart();
        const parts = [];
        let cur = 0;
        for (let k = 0; k < formatCols.length - 1; k++) {
          const comma = rest.indexOf(',', cur);
          if (comma === -1) break;
          parts.push(rest.slice(cur, comma).trim());
          cur = comma + 1;
        }
        parts.push(rest.slice(cur));
        const startIdx = formatCols.indexOf('start');
        const endIdx = formatCols.indexOf('end');
        const styleIdx = formatCols.indexOf('style');
        const textRaw = parts[formatCols.length - 1] || '';
        const cleanText = textRaw
          .replace(/\{[^}]*\}/g, '')
          .replace(/\\[Nn]/g, '\n')
          .replace(/\\h/g, ' ')
          .trim();
        if (cleanText) {
          cues.push({
            time: `${parts[startIdx] || ''} → ${parts[endIdx] || ''}`,
            style: parts[styleIdx] || '',
            text: cleanText,
          });
        }
      }
    }
  } else if (ext === '.lrc') {
    for (const line of rawText.split(/\r?\n/)) {
      if (cues.length >= maxCues) break;
      const m = /^\[(\d{1,3}:\d{2}(?:\.\d{1,3})?)\](.*)$/.exec(line.trim());
      if (m && m[2].trim()) {
        cues.push({ time: m[1], style: '', text: m[2].trim() });
      }
    }
  } else {
    // .srt & .vtt
    const blocks = rawText.replace(/\r\n/g, '\n').split(/\n{2,}/);
    for (const blk of blocks) {
      if (cues.length >= maxCues) break;
      const lines = blk.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length || /^WEBVTT/i.test(lines[0])) continue;
      const timeIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeIdx === -1) continue;
      const timeStr = lines[timeIdx].replace(/\s*-->\s*/, ' → ').split(/\s+(?:line:|position:|align:)/)[0];
      const body = lines
        .slice(timeIdx + 1)
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (body) cues.push({ time: timeStr, style: '', text: body });
    }
  }

  const hasStyle = cues.some((c) => c.style);
  const rowsHtml = cues
    .map(
      (c, idx) =>
        `<tr data-aw-row="${idx + 1}"><td class="aw-sheet-rn">${idx + 1}</td><td class="aw-sub-time">${escapeHtml(c.time)}</td>${
          hasStyle ? `<td class="aw-doc-muted">${escapeHtml(c.style)}</td>` : ''
        }<td>${escapeHtml(c.text).replace(/\n/g, '<br/>')}</td></tr>`
    )
    .join('');

  const html = cues.length
    ? `<div class="aw-sheet-wrap"><table class="aw-sheet-table"><thead><tr><th class="aw-sheet-corner">#</th><th style="width:185px">时间轴</th>${
        hasStyle ? '<th style="width:96px">样式</th>' : ''
      }<th>台词内容</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
    : '<p class="aw-doc-empty-msg">未解析到有效字幕时间轴条目。</p>';

  return {
    ok: true,
    format: 'csv',
    formatLabel: '字幕时间轴',
    badge: ext.slice(1).toUpperCase(),
    path: filePath,
    title: path.basename(filePath),
    ext: ext.slice(1),
    sizeBytes: stat.size,
    autoRender: false,
    optionalTable: true,
    supportsPaperMode: false,
    encoding: decoded.encoding,
    meta: {
      statsLabel: `${cues.length} 条字幕 · ${String(decoded.encoding || 'utf-8').toUpperCase()}`,
    },
    outline: [],
    bodyHtml: html,
    plainText: rawText.slice(0, MAX_PLAIN_CHARS),
    snippetLines: cues.slice(0, 10).map((c) => `[${c.time}] ${c.text.replace(/\n/g, ' / ')}`),
    warnings: [],
  };
}

// ── 9. Structured JSON Lines (.jsonl / .ndjson) Table View ──────────────────

export function parseJsonLinesTable(buf, filePath, stat, { snippetOnly = false } = {}) {
  const decoded = decodeBuffer(buf.subarray(0, Math.min(buf.length, snippetOnly ? 32768 : 4 * 1024 * 1024)), '', {
    truncated: buf.length > (snippetOnly ? 32768 : 4 * 1024 * 1024),
  });
  const lines = String(decoded.text || '').split(/\r?\n/).filter((l) => l.trim());
  const records = [];
  const keyCounts = new Map();
  const maxRows = snippetOnly ? 10 : 400;

  for (let i = 0; i < lines.length && records.length < maxRows; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        records.push(obj);
        for (const k of Object.keys(obj)) {
          keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
        }
      } else {
        records.push({ value: obj });
        keyCounts.set('value', (keyCounts.get('value') || 0) + 1);
      }
    } catch {}
  }

  const columns = Array.from(keyCounts.keys()).slice(0, snippetOnly ? 6 : 24);
  let html = '<p class="aw-doc-empty-msg">未解析到有效的 JSON Lines 记录。</p>';
  if (records.length && columns.length) {
    const thead = `<thead><tr><th class="aw-sheet-corner">#</th>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${records
      .map((rec, idx) => {
        const tds = [`<td class="aw-sheet-rn">${idx + 1}</td>`];
        for (const col of columns) {
          const v = rec[col];
          let str = '';
          let isNum = false;
          if (v === undefined || v === null) str = '';
          else if (typeof v === 'number' || typeof v === 'boolean') {
            str = String(v);
            isNum = typeof v === 'number';
          } else if (typeof v === 'string') {
            str = v.slice(0, 260);
          } else {
            str = JSON.stringify(v).slice(0, 260);
          }
          tds.push(`<td${isNum ? ' class="aw-sheet-num"' : ''}>${escapeHtml(str)}</td>`);
        }
        return `<tr data-aw-row="${idx + 1}">${tds.join('')}</tr>`;
      })
      .join('')}</tbody>`;
    html = `<div class="aw-sheet-wrap"><table class="aw-sheet-table">${thead}${tbody}</table></div>`;
  }

  return {
    ok: true,
    format: 'csv',
    formatLabel: 'JSONL 记录表',
    badge: path.extname(filePath).slice(1).toUpperCase() || 'JSONL',
    path: filePath,
    title: path.basename(filePath),
    ext: path.extname(filePath).slice(1).toLowerCase() || 'jsonl',
    sizeBytes: stat.size,
    autoRender: false,
    optionalTable: true,
    supportsPaperMode: false,
    meta: {
      statsLabel: `${records.length} 条记录 · ${columns.length} 字段`,
    },
    outline: [],
    bodyHtml: html,
    plainText: String(decoded.text || '').slice(0, MAX_PLAIN_CHARS),
    snippetLines: records.slice(0, 8).map((r) => JSON.stringify(r).slice(0, 90)),
    warnings: lines.length > records.length && !snippetOnly ? [`文件共约 ${lines.length} 行，当前展示前 ${records.length} 条记录。`] : [],
  };
}

// ── 10. RFC 5322 Saved Email (.eml) Viewer ──────────────────────────────────

function decodeRfc2047Word(str) {
  return String(str || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset, enc, body) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(body, 'base64');
      } else {
        const qp = body.replace(/_/g, ' ');
        const arr = [];
        for (let i = 0; i < qp.length; i++) {
          if (qp[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(qp.slice(i + 1, i + 3))) {
            arr.push(parseInt(qp.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            arr.push(qp.charCodeAt(i) & 0xff);
          }
        }
        bytes = Buffer.from(arr);
      }
      const cs = String(charset || 'utf-8').toLowerCase();
      const normCs = cs.includes('gb') ? 'gb18030' : cs;
      return new TextDecoder(normCs, { fatal: false }).decode(bytes);
    } catch {
      return body;
    }
  });
}

function decodeMimeTransfer(rawBodyStr, transferEnc, charset = 'utf-8') {
  const enc = String(transferEnc || '').trim().toLowerCase();
  let bytes;
  if (enc === 'base64') {
    bytes = Buffer.from(String(rawBodyStr || '').replace(/\s+/g, ''), 'base64');
  } else if (enc === 'quoted-printable') {
    const softCleaned = String(rawBodyStr || '').replace(/=\r?\n/g, '');
    const arr = [];
    for (let i = 0; i < softCleaned.length; i++) {
      if (softCleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(softCleaned.slice(i + 1, i + 3))) {
        arr.push(parseInt(softCleaned.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        arr.push(softCleaned.charCodeAt(i) & 0xff);
      }
    }
    bytes = Buffer.from(arr);
  } else {
    bytes = Buffer.from(String(rawBodyStr || ''), 'latin1');
  }
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(cs.includes('gb') ? 'gb18030' : cs, { fatal: false }).decode(bytes);
  } catch {
    return decodeBuffer(bytes).text;
  }
}

function splitHeadersAndBody(rawStr) {
  const sepMatch = /\r?\n\r?\n/.exec(rawStr);
  const headPart = sepMatch ? rawStr.slice(0, sepMatch.index) : rawStr;
  const bodyPart = sepMatch ? rawStr.slice(sepMatch.index + sepMatch[0].length) : '';
  const unfolded = headPart.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const k = line.slice(0, colon).trim().toLowerCase();
    const v = line.slice(colon + 1).trim();
    if (!headers.has(k)) headers.set(k, v);
  }
  return { headers, bodyPart };
}

export function parseEmlMessage(buf, filePath, stat, { sanitizeHtmlFn } = {}) {
  const raw = buf.toString('latin1');
  const { headers, bodyPart } = splitHeadersAndBody(raw);

  const subject = decodeRfc2047Word(headers.get('subject') || '') || path.basename(filePath);
  const from = decodeRfc2047Word(headers.get('from') || '');
  const to = decodeRfc2047Word(headers.get('to') || '');
  const date = headers.get('date') || '';

  let textBody = '';
  let htmlBody = '';
  const attachments = [];

  const visitPart = (hdrs, bStr, depth = 0) => {
    if (depth > 6) return;
    const ct = hdrs.get('content-type') || 'text/plain';
    const cte = hdrs.get('content-transfer-encoding') || '';
    const disp = hdrs.get('content-disposition') || '';
    const csMatch = /charset\s*=\s*("?[^";\s]+"?)/i.exec(ct);
    const charset = csMatch ? csMatch[1].replace(/"/g, '') : 'utf-8';
    const nameMatch = /(?:filename|name)\s*=\s*("[^"]+"|[^;\s]+)/i.exec(disp) || /name\s*=\s*("[^"]+"|[^;\s]+)/i.exec(ct);

    if (/^multipart\//i.test(ct)) {
      const bMatch = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
      const boundary = bMatch ? (bMatch[1] || bMatch[2]) : '';
      if (!boundary) return;
      const chunks = bStr.split(`--${boundary}`);
      for (let i = 1; i < chunks.length; i++) {
        const ch = chunks[i];
        if (ch.startsWith('--')) break;
        const sub = splitHeadersAndBody(ch.replace(/^\r?\n/, ''));
        visitPart(sub.headers, sub.bodyPart, depth + 1);
      }
      return;
    }

    if (/^attachment/i.test(disp) || (nameMatch && !/^text\/(?:plain|html)/i.test(ct))) {
      const fname = decodeRfc2047Word((nameMatch?.[1] || '附件').replace(/^"|"$/g, ''));
      attachments.push(fname);
      return;
    }

    const decoded = decodeMimeTransfer(bStr, cte, charset);
    if (/^text\/html/i.test(ct) && !htmlBody) {
      htmlBody = decoded;
    } else if (/^text\/plain/i.test(ct) && !textBody) {
      textBody = decoded;
    }
  };

  visitPart(headers, bodyPart, 0);

  let renderedBody = '';
  const plainOut = [];
  if (htmlBody && typeof sanitizeHtmlFn === 'function') {
    const root = pruneAlternateContent(parseXml(htmlBody));
    const bodyNode = findAll(root, 'body')[0] || root;
    renderedBody = sanitizeHtmlFn(bodyNode, plainOut);
  }
  if (!renderedBody && textBody) {
    plainOut.push(textBody);
    renderedBody = textBody
      .split(/\r?\n\r?\n/)
      .map((p) => `<p class="aw-doc-p">${escapeHtml(p).replace(/\r?\n/g, '<br/>')}</p>`)
      .join('\n');
  }

  const metaHeaderHtml = `
    <div class="aw-eml-headers">
      <div class="aw-eml-subject">${escapeHtml(subject)}</div>
      ${from ? `<div class="aw-eml-meta-row"><span>发件人</span><strong>${escapeHtml(from)}</strong></div>` : ''}
      ${to ? `<div class="aw-eml-meta-row"><span>收件人</span><span>${escapeHtml(to)}</span></div>` : ''}
      ${date ? `<div class="aw-eml-meta-row"><span>时间</span><span>${escapeHtml(date)}</span></div>` : ''}
      ${attachments.length ? `<div class="aw-eml-meta-row"><span>附件 (${attachments.length})</span><span>${escapeHtml(attachments.join('、'))}</span></div>` : ''}
    </div>
  `;

  const plainText = [subject, from ? `From: ${from}` : '', to ? `To: ${to}` : '', '', textBody || plainOut.join('\n')]
    .filter((x) => x !== undefined)
    .join('\n')
    .slice(0, MAX_PLAIN_CHARS);

  return {
    ok: true,
    format: 'eml',
    formatLabel: '电子邮件',
    badge: 'EML',
    path: filePath,
    title: subject,
    ext: 'eml',
    sizeBytes: stat.size,
    autoRender: true,
    preferWhenRawCode: true,
    supportsPaperMode: true,
    meta: {
      statsLabel: attachments.length ? `含 ${attachments.length} 个附件` : formatBytes(stat.size),
    },
    outline: [],
    bodyHtml: `${metaHeaderHtml}<div class="aw-eml-body">${renderedBody || '<p class="aw-doc-empty-msg">邮件正文为空。</p>'}</div>`,
    plainText,
    snippetLines: [subject, from ? `发件人: ${from}` : '', ...(textBody || plainOut.join('\n')).split(/\r?\n/).slice(0, 6)].filter(Boolean),
    warnings: [],
  };
}
