import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decodeBuffer } from './encoding.mjs';
import { escapeHtml, resolveSafeReadPath } from './security.mjs';
import {
  collectText,
  findAll,
  findChild,
  findChildren,
  getAttr,
  normalizeZipPath,
  parseRelsXml,
  parseXml,
  readZipArchive,
  resolveZipRelPath,
} from './zip_xml.mjs';

const MAX_DOC_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_MEDIA_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 14 * 1024 * 1024;
const MAX_XLSX_ROWS_PER_SHEET = 500;
const MAX_XLSX_COLS_PER_SHEET = 60;
const MAX_CSV_ROWS = 600;
const MAX_CSV_COLS = 60;
const MAX_PLAIN_TEXT_CHARS = 180000;
const MAX_DOC_CACHE_ITEMS = 24;

const IMAGE_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
});

export const RICH_DOC_TYPES = Object.freeze({
  '.docx': Object.freeze({ format: 'docx', label: 'Word 文档', badge: 'DOCX', autoRender: true, supportsPaperMode: true }),
  '.doc': Object.freeze({ format: 'doc', label: 'Word 旧版文档', badge: 'DOC', autoRender: true, supportsPaperMode: true }),
  '.xlsx': Object.freeze({ format: 'xlsx', label: 'Excel 表格', badge: 'XLSX', autoRender: true, supportsPaperMode: false }),
  '.xlsm': Object.freeze({ format: 'xlsx', label: 'Excel 表格', badge: 'XLSM', autoRender: true, supportsPaperMode: false }),
  '.pptx': Object.freeze({ format: 'pptx', label: 'PPT 演示文稿', badge: 'PPTX', autoRender: true, supportsPaperMode: false }),
  '.odt': Object.freeze({ format: 'odt', label: 'OpenDocument 文档', badge: 'ODT', autoRender: true, supportsPaperMode: true }),
  '.ods': Object.freeze({ format: 'ods', label: 'OpenDocument 表格', badge: 'ODS', autoRender: true, supportsPaperMode: false }),
  '.odp': Object.freeze({ format: 'odp', label: 'OpenDocument 演示', badge: 'ODP', autoRender: true, supportsPaperMode: false }),
  '.rtf': Object.freeze({ format: 'rtf', label: 'RTF 富文本', badge: 'RTF', autoRender: true, supportsPaperMode: true }),
  '.epub': Object.freeze({ format: 'epub', label: 'EPUB 电子书', badge: 'EPUB', autoRender: true, supportsPaperMode: true }),
  '.zip': Object.freeze({ format: 'zip', label: 'ZIP 压缩包', badge: 'ZIP', autoRender: true, supportsPaperMode: false }),
  '.csv': Object.freeze({ format: 'csv', label: 'CSV 数据表', badge: 'CSV', autoRender: false, supportsPaperMode: false }),
  '.tsv': Object.freeze({ format: 'tsv', label: 'TSV 数据表', badge: 'TSV', autoRender: false, supportsPaperMode: false }),
  '.pdf': Object.freeze({ format: 'pdf', label: 'PDF 文档', badge: 'PDF', autoRender: false, supportsPaperMode: false, mode2Only: true }),
});

export function getSupportedDocumentMeta(filePath) {
  if (!filePath) return null;
  const ext = path.extname(String(filePath).replace(/[\\/]+$/, '')).toLowerCase();
  return RICH_DOC_TYPES[ext] || null;
}

export function isBinaryOfficeFormat(filePath) {
  const meta = getSupportedDocumentMeta(filePath);
  if (!meta) return false;
  return !['csv', 'tsv', 'rtf'].includes(meta.format);
}

// ── Shared Formatting & Color Utilities ─────────────────────────────────────

function normalizeHexColor(raw) {
  const s = String(raw || '').trim().replace(/^#/, '');
  if (!s || /^auto$/i.test(s) || /^none$/i.test(s) || /^transparent$/i.test(s)) return '';
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toUpperCase();
  }
  return '';
}

function colorLuminance(hex) {
  if (!hex || hex.length !== 7) return 0.5;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function classifyInkTone(hex) {
  if (!hex || hex.length !== 7) return 'dark';
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma < 0.08) {
    if (luma < 0.28) return 'dark';
    if (luma <= 0.74) return 'muted';
    return 'light';
  }
  return luma < 0.42 ? 'accent-dark' : 'accent';
}

const WORD_HIGHLIGHT_MAP = Object.freeze({
  yellow: '#fff3a1',
  green: '#b7f5c4',
  cyan: '#b7f2ff',
  magenta: '#fbc4f0',
  blue: '#bfd8ff',
  red: '#ffc2c2',
  darkBlue: '#c4d4f5',
  darkCyan: '#bce5ea',
  darkGreen: '#c4e6cd',
  darkMagenta: '#e6c8e8',
  darkRed: '#f2c4c4',
  darkYellow: '#f2e4a8',
  darkGray: '#d4d6dc',
  lightGray: '#e6e8ee',
});

function sanitizeHref(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(?:https?:\/\/|mailto:)/i.test(s)) return s;
  if (s.startsWith('#')) return s;
  return '';
}

function formatBytesShort(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

function toRoman(num, upper = true) {
  const n = Math.max(1, Math.min(3999, Math.floor(num)));
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let rem = n;
  let out = '';
  for (let i = 0; i < vals.length; i++) {
    while (rem >= vals[i]) {
      out += syms[i];
      rem -= vals[i];
    }
  }
  return upper ? out : out.toLowerCase();
}

function toAlpha(num, upper = true) {
  let n = Math.max(1, Math.floor(num));
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode((upper ? 65 : 97) + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function toChineseNum(num) {
  const n = Math.floor(num);
  if (n <= 0) return String(n);
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return digits[n];
  if (n < 20) return n === 10 ? '十' : `十${digits[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    if (rem === 0) return `${digits[h]}百`;
    if (rem < 10) return `${digits[h]}百零${digits[rem]}`;
    const tens = Math.floor(rem / 10);
    const ones = rem % 10;
    return `${digits[h]}百${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  return String(n);
}

function toCircledNum(num) {
  if (num >= 1 && num <= 20) return String.fromCodePoint(0x2460 + num - 1);
  return `(${num})`;
}

function formatListNumber(val, numFmt) {
  const fmt = String(numFmt || 'decimal');
  switch (fmt) {
    case 'bullet':
      return '•';
    case 'decimalZero':
      return val < 10 ? `0${val}` : String(val);
    case 'lowerLetter':
      return toAlpha(val, false);
    case 'upperLetter':
      return toAlpha(val, true);
    case 'lowerRoman':
      return toRoman(val, false);
    case 'upperRoman':
      return toRoman(val, true);
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'chineseLegalSimplified':
    case 'ideographTraditional':
    case 'japaneseCounting':
    case 'taiwaneseCounting':
      return toChineseNum(val);
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese':
      return toCircledNum(val);
    case 'none':
      return '';
    default:
      return String(val);
  }
}

function extractCoreProps(zip) {
  const meta = { title: '', author: '', modified: '', subject: '' };
  const coreXml = zip.getEntryText('docProps/core.xml');
  if (!coreXml) return meta;
  try {
    const root = parseXml(coreXml);
    meta.title = collectText(findAll(root, 'title')[0]).trim();
    meta.author = collectText(findAll(root, 'creator')[0]).trim();
    meta.subject = collectText(findAll(root, 'subject')[0]).trim();
    const mod = collectText(findAll(root, 'modified')[0]).trim();
    if (mod) meta.modified = mod.slice(0, 10);
  } catch {}
  return meta;
}

function createMediaLoader(zip, { snippetOnly = false } = {}) {
  let usedBytes = 0;
  const cache = new Map();
  let embeddedCount = 0;
  let skippedUnsupportedCount = 0;

  function loadImageDataUrl(archivePath) {
    if (snippetOnly) return { ok: false, skippedForSnippet: true };
    const norm = normalizeZipPath(archivePath);
    if (!norm) return { ok: false, error: 'Invalid media path' };
    if (cache.has(norm)) return cache.get(norm);

    const ext = path.extname(norm).toLowerCase();
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) {
      skippedUnsupportedCount++;
      const res = { ok: false, unsupportedFormat: ext.slice(1).toUpperCase() || 'IMG', name: path.basename(norm) };
      cache.set(norm, res);
      return res;
    }

    const meta = zip.getEntryMeta(norm);
    if (!meta) return { ok: false, error: 'Missing media entry' };
    if (meta.uncompressedSize > MAX_SINGLE_MEDIA_BYTES || usedBytes + meta.uncompressedSize > MAX_TOTAL_MEDIA_BYTES) {
      const res = { ok: false, tooLarge: true, name: path.basename(norm), sizeBytes: meta.uncompressedSize };
      cache.set(norm, res);
      return res;
    }

    try {
      const buf = zip.getEntryBuffer(norm);
      if (!buf || !buf.length) return { ok: false, error: 'Empty image' };
      usedBytes += buf.length;
      embeddedCount++;
      const res = {
        ok: true,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        name: path.basename(norm),
      };
      cache.set(norm, res);
      return res;
    } catch (err) {
      const res = { ok: false, error: String(err?.message || err), name: path.basename(norm) };
      cache.set(norm, res);
      return res;
    }
  }

  return {
    loadImageDataUrl,
    getStats: () => ({ embeddedCount, skippedUnsupportedCount, usedBytes }),
  };
}

// ── 1. DOCX Full-Fidelity Renderer ──────────────────────────────────────────

function parseWordBool(el) {
  if (!el) return null;
  const v = getAttr(el, 'val');
  if (!v) return true;
  return !/^(?:0|false|off|none)$/i.test(v);
}

function parseWordRPr(rPrNode) {
  const r = {};
  if (!rPrNode) return r;
  const rStyle = findChild(rPrNode, 'rStyle');
  if (rStyle) r.rStyle = getAttr(rStyle, 'val');
  const b = findChild(rPrNode, 'b');
  if (b) r.bold = parseWordBool(b);
  const i = findChild(rPrNode, 'i');
  if (i) r.italic = parseWordBool(i);
  const u = findChild(rPrNode, 'u');
  if (u) {
    const uv = getAttr(u, 'val');
    r.underline = uv ? !/^none$/i.test(uv) : true;
  }
  const strike = findChild(rPrNode, 'strike') || findChild(rPrNode, 'dstrike');
  if (strike) r.strike = parseWordBool(strike);
  const vert = findChild(rPrNode, 'vertAlign');
  if (vert) r.vertAlign = getAttr(vert, 'val');
  const sz = findChild(rPrNode, 'sz');
  if (sz) {
    const hp = Number(getAttr(sz, 'val'));
    if (Number.isFinite(hp) && hp > 0) r.fontPt = hp / 2;
  }
  const color = findChild(rPrNode, 'color');
  if (color) {
    const hex = normalizeHexColor(getAttr(color, 'val'));
    if (hex) r.color = hex;
  }
  const hl = findChild(rPrNode, 'highlight');
  if (hl) {
    const hv = getAttr(hl, 'val');
    if (hv && hv !== 'none') r.highlight = WORD_HIGHLIGHT_MAP[hv] || normalizeHexColor(hv) || '#fff3a1';
  }
  const shd = findChild(rPrNode, 'shd');
  if (shd) {
    const fill = normalizeHexColor(getAttr(shd, 'fill'));
    if (fill) r.shading = fill;
  }
  const rFonts = findChild(rPrNode, 'rFonts');
  if (rFonts) {
    const ea = getAttr(rFonts, 'eastAsia') || getAttr(rFonts, 'ascii') || getAttr(rFonts, 'hAnsi');
    if (ea) r.fontFamily = ea;
  }
  return r;
}

function parseWordPPr(pPrNode) {
  const p = {};
  if (!pPrNode) return p;
  const pStyle = findChild(pPrNode, 'pStyle');
  if (pStyle) p.pStyle = getAttr(pStyle, 'val');
  const jc = findChild(pPrNode, 'jc');
  if (jc) p.align = getAttr(jc, 'val');
  const outlineLvl = findChild(pPrNode, 'outlineLvl');
  if (outlineLvl) {
    const n = Number(getAttr(outlineLvl, 'val'));
    if (Number.isFinite(n) && n >= 0 && n <= 8) p.outlineLvl = n;
  }
  const ind = findChild(pPrNode, 'ind');
  if (ind) {
    const left = Number(getAttr(ind, 'left') || getAttr(ind, 'start') || 0);
    const firstLine = Number(getAttr(ind, 'firstLine') || 0);
    const firstLineChars = Number(getAttr(ind, 'firstLineChars') || 0);
    const hanging = Number(getAttr(ind, 'hanging') || 0);
    if (left > 0) p.indentLeftTwips = left;
    if (firstLine > 0) p.firstLineTwips = firstLine;
    if (firstLineChars > 0) p.firstLineChars = firstLineChars;
    if (hanging > 0) p.hangingTwips = hanging;
  }
  const spacing = findChild(pPrNode, 'spacing');
  if (spacing) {
    const before = Number(getAttr(spacing, 'before'));
    const after = Number(getAttr(spacing, 'after'));
    if (Number.isFinite(before) && before >= 0) p.spaceBeforeTwips = before;
    if (Number.isFinite(after) && after >= 0) p.spaceAfterTwips = after;
  }
  const numPr = findChild(pPrNode, 'numPr');
  if (numPr) {
    const numId = getAttr(findChild(numPr, 'numId'), 'val');
    const ilvl = Number(getAttr(findChild(numPr, 'ilvl'), 'val') || 0);
    if (numId && numId !== '0') p.numPr = { numId, ilvl: Number.isFinite(ilvl) ? ilvl : 0 };
  }
  const shd = findChild(pPrNode, 'shd');
  if (shd) {
    const fill = normalizeHexColor(getAttr(shd, 'fill'));
    if (fill) p.shading = fill;
  }
  const pBdr = findChild(pPrNode, 'pBdr');
  if (pBdr) {
    const leftB = findChild(pBdr, 'left');
    const botB = findChild(pBdr, 'bottom');
    if (leftB && getAttr(leftB, 'val') !== 'none' && getAttr(leftB, 'val') !== 'nil') p.hasLeftBorder = true;
    if (botB && getAttr(botB, 'val') !== 'none' && getAttr(botB, 'val') !== 'nil') p.hasBottomBorder = true;
  }
  const pbBefore = findChild(pPrNode, 'pageBreakBefore');
  if (pbBefore && parseWordBool(pbBefore)) p.pageBreakBefore = true;
  const rPr = findChild(pPrNode, 'rPr');
  if (rPr) p.pRPr = parseWordRPr(rPr);
  return p;
}

function parseDocxStyles(zip) {
  const styles = new Map();
  let defaultPPr = {};
  let defaultRPr = {};
  const xml = zip.getEntryText('word/styles.xml');
  if (!xml) return { styles, defaultPPr, defaultRPr, resolveParaStyle: () => ({}), resolveRunStyle: () => ({}) };

  const root = parseXml(xml);
  const docDefaults = findAll(root, 'docDefaults')[0];
  if (docDefaults) {
    const rDef = findChild(findChild(docDefaults, 'rPrDefault'), 'rPr');
    const pDef = findChild(findChild(docDefaults, 'pPrDefault'), 'pPr');
    if (rDef) defaultRPr = parseWordRPr(rDef);
    if (pDef) defaultPPr = parseWordPPr(pDef);
  }

  for (const st of findAll(root, 'style')) {
    const id = getAttr(st, 'styleId');
    if (!id) continue;
    const type = getAttr(st, 'type');
    const name = getAttr(findChild(st, 'name'), 'val');
    const basedOn = getAttr(findChild(st, 'basedOn'), 'val');
    const pPr = parseWordPPr(findChild(st, 'pPr'));
    const rPr = parseWordRPr(findChild(st, 'rPr'));
    styles.set(id, { id, type, name, basedOn, pPr, rPr });
  }

  const resolvedParaCache = new Map();
  const resolvedRunCache = new Map();

  function resolveParaStyle(styleId) {
    if (!styleId || !styles.has(styleId)) return { pPr: { ...defaultPPr }, rPr: { ...defaultRPr }, name: '' };
    if (resolvedParaCache.has(styleId)) return resolvedParaCache.get(styleId);
    const chain = [];
    const seen = new Set();
    let cur = styleId;
    while (cur && !seen.has(cur) && styles.has(cur)) {
      seen.add(cur);
      const st = styles.get(cur);
      chain.unshift(st);
      cur = st.basedOn;
    }
    const mergedP = { ...defaultPPr };
    const mergedR = { ...defaultRPr };
    let headingLevel = 0;
    let styleName = '';
    for (const st of chain) {
      Object.assign(mergedP, st.pPr);
      Object.assign(mergedR, st.rPr);
      if (st.name) styleName = st.name;
      const h = inferHeadingLevelFromStyle(st.id, st.name, st.pPr);
      if (h > 0) headingLevel = h;
    }
    const res = { pPr: mergedP, rPr: mergedR, name: styleName, headingLevel };
    resolvedParaCache.set(styleId, res);
    return res;
  }

  function resolveRunStyle(styleId) {
    if (!styleId || !styles.has(styleId)) return {};
    if (resolvedRunCache.has(styleId)) return resolvedRunCache.get(styleId);
    const chain = [];
    const seen = new Set();
    let cur = styleId;
    while (cur && !seen.has(cur) && styles.has(cur)) {
      seen.add(cur);
      const st = styles.get(cur);
      chain.unshift(st);
      cur = st.basedOn;
    }
    const mergedR = {};
    for (const st of chain) Object.assign(mergedR, st.rPr);
    resolvedRunCache.set(styleId, mergedR);
    return mergedR;
  }

  return { styles, defaultPPr, defaultRPr, resolveParaStyle, resolveRunStyle };
}

function inferHeadingLevelFromStyle(styleId, styleName, pPr) {
  if (pPr && Number.isFinite(pPr.outlineLvl) && pPr.outlineLvl >= 0 && pPr.outlineLvl <= 5) {
    return pPr.outlineLvl + 1;
  }
  const combined = `${styleId || ''} ${styleName || ''}`.trim();
  if (!combined) return 0;
  const m = /(?:^|\b)(?:heading|标题|head)\s*([1-6])(?:\b|$)/i.exec(combined);
  if (m) return Number(m[1]);
  if (/^(?:title|主标题|文档标题)$/i.test(String(styleName || '').trim()) || /^title$/i.test(String(styleId || '').trim())) {
    return 1;
  }
  if (/^(?:subtitle|副标题)$/i.test(String(styleName || '').trim()) || /^subtitle$/i.test(String(styleId || '').trim())) {
    return 2;
  }
  return 0;
}

function parseDocxNumbering(zip) {
  const abstractMap = new Map();
  const numMap = new Map();
  const xml = zip.getEntryText('word/numbering.xml');
  if (!xml) return { nextMarker: () => null };

  const root = parseXml(xml);
  for (const abs of findAll(root, 'abstractNum')) {
    const absId = getAttr(abs, 'abstractNumId');
    if (!absId) continue;
    const levels = new Map();
    for (const lvl of findChildren(abs, 'lvl')) {
      const ilvl = Number(getAttr(lvl, 'ilvl') || 0);
      const start = Number(getAttr(findChild(lvl, 'start'), 'val') || 1);
      const numFmt = getAttr(findChild(lvl, 'numFmt'), 'val') || 'decimal';
      const lvlText = getAttr(findChild(lvl, 'lvlText'), 'val') || '%1.';
      const lvlRestartRaw = getAttr(findChild(lvl, 'lvlRestart'), 'val');
      const lvlRestart = lvlRestartRaw === '' ? ilvl : Number(lvlRestartRaw);
      levels.set(ilvl, {
        ilvl,
        start: Number.isFinite(start) ? start : 1,
        numFmt,
        lvlText,
        lvlRestart: Number.isFinite(lvlRestart) ? lvlRestart : ilvl,
      });
    }
    abstractMap.set(absId, levels);
  }

  for (const num of findAll(root, 'num')) {
    const numId = getAttr(num, 'numId');
    const absId = getAttr(findChild(num, 'abstractNumId'), 'val');
    if (!numId || !absId) continue;
    const overrides = new Map();
    for (const ov of findChildren(num, 'lvlOverride')) {
      const ilvl = Number(getAttr(ov, 'ilvl') || 0);
      const startOv = getAttr(findChild(ov, 'startOverride'), 'val');
      if (startOv !== '') {
        const n = Number(startOv);
        if (Number.isFinite(n)) overrides.set(ilvl, n);
      }
    }
    numMap.set(numId, { absId, overrides });
  }

  const counters = new Map(); // numId -> Array<number>

  function nextMarker(numId, ilvl = 0) {
    const numDef = numMap.get(String(numId));
    if (!numDef) return null;
    const levels = abstractMap.get(numDef.absId);
    if (!levels) return null;
    const lvlDef = levels.get(ilvl) || levels.get(0);
    if (!lvlDef) return null;

    if (!counters.has(numId)) counters.set(numId, []);
    const arr = counters.get(numId);

    // Ensure parent levels exist
    for (let k = 0; k < ilvl; k++) {
      if (arr[k] === undefined) {
        const pDef = levels.get(k);
        arr[k] = numDef.overrides.has(k) ? numDef.overrides.get(k) : (pDef?.start ?? 1);
      }
    }

    if (arr[ilvl] === undefined) {
      arr[ilvl] = numDef.overrides.has(ilvl) ? numDef.overrides.get(ilvl) : lvlDef.start;
    } else {
      arr[ilvl] += 1;
    }

    // Reset deeper levels
    for (let k = ilvl + 1; k < arr.length; k++) {
      arr[k] = undefined;
    }

    if (lvlDef.numFmt === 'bullet') {
      const rawBullet = lvlDef.lvlText || '•';
      const cleaned = rawBullet.replace(/[\uF000-\uF0FF]/g, (ch) => {
        const code = ch.charCodeAt(0);
        if (code === 0xf0b7 || code === 0xf0a7 || code === 0xf0d8) return '•';
        if (code === 0xf06f) return '◦';
        return '▪';
      });
      return { text: cleaned || '•', isBullet: true, level: ilvl };
    }

    let label = lvlDef.lvlText || `%${ilvl + 1}.`;
    label = label.replace(/%([1-9])/g, (_m, d) => {
      const idx = Number(d) - 1;
      const dDef = levels.get(idx) || lvlDef;
      const val = arr[idx] !== undefined ? arr[idx] : (dDef.start ?? 1);
      return formatListNumber(val, dDef.numFmt);
    });
    return { text: label, isBullet: false, level: ilvl };
  }

  return { nextMarker };
}

function renderOmmlNode(node) {
  if (!node) return '';
  if (node.text !== undefined) return node.text;
  const loc = node.local;
  if (loc === 't') return collectText(node);
  if (loc === 'f') {
    const num = renderOmmlNode(findChild(node, 'num'));
    const den = renderOmmlNode(findChild(node, 'den'));
    return `(${num})/(${den})`;
  }
  if (loc === 'sSup') {
    const e = renderOmmlNode(findChild(node, 'e'));
    const sup = renderOmmlNode(findChild(node, 'sup'));
    return `${e}^(${sup})`;
  }
  if (loc === 'sSub') {
    const e = renderOmmlNode(findChild(node, 'e'));
    const sub = renderOmmlNode(findChild(node, 'sub'));
    return `${e}_(${sub})`;
  }
  if (loc === 'sSubSup') {
    const e = renderOmmlNode(findChild(node, 'e'));
    const sub = renderOmmlNode(findChild(node, 'sub'));
    const sup = renderOmmlNode(findChild(node, 'sup'));
    return `${e}_(${sub})^(${sup})`;
  }
  if (loc === 'rad') {
    const deg = renderOmmlNode(findChild(node, 'deg')).trim();
    const e = renderOmmlNode(findChild(node, 'e'));
    return deg ? `${deg}√(${e})` : `√(${e})`;
  }
  if (loc === 'd') {
    const dPr = findChild(node, 'dPr');
    const beg = getAttr(findChild(dPr, 'begChr'), 'val') || '(';
    const end = getAttr(findChild(dPr, 'endChr'), 'val') || ')';
    const parts = findChildren(node, 'e').map((e) => renderOmmlNode(e));
    return `${beg}${parts.join(', ')}${end}`;
  }
  if (loc === 'nary') {
    const nPr = findChild(node, 'naryPr');
    const chr = getAttr(findChild(nPr, 'chr'), 'val') || '∑';
    const sub = renderOmmlNode(findChild(node, 'sub')).trim();
    const sup = renderOmmlNode(findChild(node, 'sup')).trim();
    const e = renderOmmlNode(findChild(node, 'e'));
    return `${chr}${sub ? `_${sub}` : ''}${sup ? `^${sup}` : ''} ${e}`;
  }
  return (node.children || []).map(renderOmmlNode).join('');
}

function mapWingdingsSymbol(font, charHex) {
  const code = parseInt(String(charHex || ''), 16);
  if (!Number.isFinite(code)) return '';
  if (/wingdings/i.test(String(font || ''))) {
    if (code === 0xf0fe || code === 0x00fe) return '☑';
    if (code === 0xf0a8 || code === 0x00a8 || code === 0xf06f || code === 0x006f) return '☐';
    if (code === 0xf0fc || code === 0x00fc) return '✓';
    if (code === 0xf0fb || code === 0x00fb) return '✗';
    if (code === 0xf0e0 || code === 0xf0e8) return '→';
  }
  if (code >= 0x20 && code <= 0xfffd && !(code >= 0xf000 && code <= 0xf0ff)) {
    return String.fromCodePoint(code);
  }
  return '•';
}

function isSerifFontName(fontName) {
  return /(?:simsun|nsimsun|songti|fangsong|kaiti|stsong|stfangsong|stkaiti|宋体|仿宋|楷体|times new roman|georgia|cambria|garamond)/i.test(
    String(fontName || '')
  );
}

function renderDocxNotesMap(zip, entryPath) {
  const map = new Map();
  const xml = zip.getEntryText(entryPath);
  if (!xml) return map;
  const root = parseXml(xml);
  for (const note of [...findAll(root, 'footnote'), ...findAll(root, 'endnote')]) {
    const id = getAttr(note, 'id');
    const type = getAttr(note, 'type');
    if (!id || type === 'separator' || type === 'continuationSeparator') continue;
    const text = findAll(note, 'p')
      .map((p) => collectText(p).trim())
      .filter(Boolean)
      .join(' ');
    if (text) map.set(id, text);
  }
  return map;
}

function renderDocxComments(zip) {
  const list = [];
  const xml = zip.getEntryText('word/comments.xml');
  if (!xml) return list;
  const root = parseXml(xml);
  for (const c of findAll(root, 'comment')) {
    const id = getAttr(c, 'id');
    const author = getAttr(c, 'author') || '批注';
    const date = getAttr(c, 'date').slice(0, 10);
    const text = findAll(c, 'p')
      .map((p) => collectText(p).trim())
      .filter(Boolean)
      .join('\n');
    if (text) list.push({ id, author, date, text });
  }
  return list;
}

function renderDocxHeaderFooterSnippet(zip, rels, kindPrefix) {
  const texts = [];
  for (const rel of rels.values()) {
    if (!rel.external && String(rel.type || '').toLowerCase().includes(kindPrefix)) {
      const target = resolveZipRelPath('word/document.xml', rel.target);
      const xml = zip.getEntryText(target);
      if (!xml) continue;
      const root = parseXml(xml);
      const t = findAll(root, 'p')
        .map((p) => collectText(p).trim())
        .filter(Boolean)
        .join(' · ');
      if (t) texts.push(t);
    }
  }
  return Array.from(new Set(texts)).join(' | ').slice(0, 180);
}

function parseDocx(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const docXml = zip.getEntryText('word/document.xml');
  if (!docXml) {
    throw new Error('DOCX 文件缺少 word/document.xml（可能已损坏或受密码加密）');
  }

  const coreProps = extractCoreProps(zip);
  const stylesCtx = parseDocxStyles(zip);
  const numCtx = parseDocxNumbering(zip);
  const rels = parseRelsXml(zip.getEntryText('word/_rels/document.xml.rels'));
  const media = createMediaLoader(zip, { snippetOnly });
  const footnotes = snippetOnly ? new Map() : renderDocxNotesMap(zip, 'word/footnotes.xml');
  const endnotes = snippetOnly ? new Map() : renderDocxNotesMap(zip, 'word/endnotes.xml');
  const comments = snippetOnly ? [] : renderDocxComments(zip);

  const docRoot = parseXml(docXml);
  const body = findAll(docRoot, 'body')[0] || docRoot;

  const outline = [];
  const plainLines = [];
  const warnings = [];
  const usedNotes = [];
  let paraCount = 0;
  let tableCount = 0;
  let headingSeq = 0;

  function renderRunStyleAttrs(mergedRPr) {
    const styles = [];
    const dataAttrs = [];
    if (mergedRPr.bold) styles.push('font-weight:700');
    if (mergedRPr.italic) styles.push('font-style:italic');
    const dec = [];
    if (mergedRPr.underline) dec.push('underline');
    if (mergedRPr.strike) dec.push('line-through');
    if (dec.length) styles.push(`text-decoration:${dec.join(' ')}`);
    if (mergedRPr.fontPt && Math.abs(mergedRPr.fontPt - 10.5) >= 1.5 && Math.abs(mergedRPr.fontPt - 11) >= 1.2 && Math.abs(mergedRPr.fontPt - 12) >= 1.2) {
      const clampedEm = Math.max(0.78, Math.min(2.1, mergedRPr.fontPt / 11.5));
      styles.push(`font-size:${clampedEm.toFixed(2)}em`);
    }
    if (mergedRPr.color) {
      const tone = classifyInkTone(mergedRPr.color);
      styles.push(`--aw-doc-ink:${mergedRPr.color}`);
      dataAttrs.push(`data-aw-ink="${tone}"`);
    }
    if (mergedRPr.highlight) {
      styles.push(`--aw-doc-hl:${mergedRPr.highlight}`);
      dataAttrs.push('data-aw-hl="1"');
    } else if (mergedRPr.shading) {
      const bgLuma = colorLuminance(mergedRPr.shading);
      if (bgLuma <= 0.92) {
        styles.push(`--aw-doc-bg:${mergedRPr.shading}`);
        dataAttrs.push('data-aw-bg="shaded"');
      }
    }
    if (mergedRPr.fontFamily && isSerifFontName(mergedRPr.fontFamily)) {
      dataAttrs.push('data-aw-font="serif"');
    }
    return { styleAttr: styles.length ? ` style="${styles.join(';')}"` : '', dataAttr: dataAttrs.length ? ` ${dataAttrs.join(' ')}` : '' };
  }

  function renderDrawingNode(drawNode) {
    // Prefer mc:Choice if AlternateContent wraps drawing
    const blips = findAll(drawNode, 'blip');
    const imagedatas = findAll(drawNode, 'imagedata');
    const parts = [];
    const seenRids = new Set();

    // Estimate extent width (EMUs -> px: 1px = 9525 EMU)
    const extent = findAll(drawNode, 'extent')[0];
    let widthPx = 0;
    if (extent) {
      const cx = Number(getAttr(extent, 'cx'));
      if (Number.isFinite(cx) && cx > 0) {
        widthPx = Math.round(cx / 9525);
      }
    }
    const docPr = findAll(drawNode, 'docPr')[0];
    const altText = getAttr(docPr, 'descr') || getAttr(docPr, 'name') || '文档配图';

    for (const b of blips) {
      const rid = getAttr(b, 'embed') || getAttr(b, 'link');
      if (!rid || seenRids.has(rid)) continue;
      seenRids.add(rid);
      parts.push(emitImageByRelId(rid, altText, widthPx));
    }
    for (const im of imagedatas) {
      const rid = getAttr(im, 'id') || getAttr(im, 'relid');
      if (!rid || seenRids.has(rid)) continue;
      seenRids.add(rid);
      parts.push(emitImageByRelId(rid, altText, widthPx));
    }

    // Textboxes inside drawing shapes
    const txbxs = findAll(drawNode, 'txbxContent');
    for (const tb of txbxs) {
      const inner = renderBlockChildren(tb, { inCell: true });
      if (inner.trim()) {
        parts.push(`<div class="aw-doc-textbox">${inner}</div>`);
      }
    }
    return parts.filter(Boolean).join('');
  }

  function emitImageByRelId(rid, altText, widthPx) {
    const rel = rels.get(rid);
    if (!rel || rel.external) return '';
    const archivePath = resolveZipRelPath('word/document.xml', rel.target);
    const loaded = media.loadImageDataUrl(archivePath);
    if (loaded.ok) {
      const widthStyle = widthPx > 32 && widthPx < 960 ? ` style="width:min(${widthPx}px,100%)"` : '';
      return `<figure class="aw-doc-figure"><img src="${loaded.dataUrl}" alt="${escapeHtml(altText)}" loading="lazy"${widthStyle} /></figure>`;
    }
    if (loaded.skippedForSnippet) return '';
    if (loaded.unsupportedFormat) {
      return `<span class="aw-doc-media-chip">内嵌矢量图 ${escapeHtml(loaded.name || '')}（${escapeHtml(loaded.unsupportedFormat)}）· 点击「系统打开」查看原图</span>`;
    }
    if (loaded.tooLarge) {
      return `<span class="aw-doc-media-chip">大图已省略 ${escapeHtml(loaded.name || '')}（${formatBytesShort(loaded.sizeBytes)}）</span>`;
    }
    return '';
  }

  function renderRun(runNode, paraBaseRPr) {
    const directRPr = parseWordRPr(findChild(runNode, 'rPr'));
    const rStyleRPr = directRPr.rStyle ? stylesCtx.resolveRunStyle(directRPr.rStyle) : {};
    const mergedRPr = { ...paraBaseRPr, ...rStyleRPr, ...directRPr };

    let innerHtml = '';
    let plainChunk = '';
    let hasPageBreak = false;

    for (const ch of runNode.children || []) {
      if (!ch || ch.text !== undefined) continue;
      switch (ch.local) {
        case 't':
        case 'instrText': {
          if (ch.local === 'instrText') break;
          const txt = collectText(ch);
          if (txt) {
            innerHtml += escapeHtml(txt);
            plainChunk += txt;
          }
          break;
        }
        case 'tab':
          innerHtml += '<span class="aw-doc-tab">&emsp;</span>';
          plainChunk += '\t';
          break;
        case 'br': {
          const bType = getAttr(ch, 'type');
          if (bType === 'page') {
            hasPageBreak = true;
          } else {
            innerHtml += '<br/>';
            plainChunk += '\n';
          }
          break;
        }
        case 'cr':
          innerHtml += '<br/>';
          plainChunk += '\n';
          break;
        case 'noBreakHyphen':
          innerHtml += '&#8209;';
          plainChunk += '-';
          break;
        case 'sym': {
          const sym = mapWingdingsSymbol(getAttr(ch, 'font'), getAttr(ch, 'char'));
          innerHtml += escapeHtml(sym);
          plainChunk += sym;
          break;
        }
        case 'drawing':
        case 'pict': {
          const imgHtml = renderDrawingNode(ch);
          if (imgHtml) innerHtml += imgHtml;
          break;
        }
        case 'AlternateContent': {
          const choice = findChild(ch, 'Choice');
          const fallback = findChild(ch, 'Fallback');
          const branch = choice || fallback;
          if (branch) {
            for (const sub of branch.children || []) {
              if (sub.local === 'drawing' || sub.local === 'pict') {
                innerHtml += renderDrawingNode(sub);
              }
            }
          }
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference': {
          const nid = getAttr(ch, 'id');
          const isEnd = ch.local === 'endnoteReference';
          const noteText = isEnd ? endnotes.get(nid) : footnotes.get(nid);
          if (nid && noteText) {
            const refNo = usedNotes.length + 1;
            const anchorId = `aw-doc-note-${refNo}`;
            usedNotes.push({ num: refNo, id: anchorId, kind: isEnd ? '尾注' : '脚注', text: noteText });
            innerHtml += `<sup class="aw-doc-note-ref"><a href="#${anchorId}" title="${escapeHtml(noteText)}">[${refNo}]</a></sup>`;
            plainChunk += `[${refNo}]`;
          }
          break;
        }
        default:
          break;
      }
    }

    let html = innerHtml;
    if (html && !/^<figure\b/.test(html)) {
      const { styleAttr, dataAttr } = renderRunStyleAttrs(mergedRPr);
      if (mergedRPr.vertAlign === 'superscript') {
        html = `<sup${dataAttr}${styleAttr}>${html}</sup>`;
      } else if (mergedRPr.vertAlign === 'subscript') {
        html = `<sub${dataAttr}${styleAttr}>${html}</sub>`;
      } else if (styleAttr || dataAttr) {
        html = `<span${dataAttr}${styleAttr}>${html}</span>`;
      }
    }
    return {
      html,
      plain: plainChunk,
      hasPageBreak,
      bold: Boolean(mergedRPr.bold),
      fontPt: Number(mergedRPr.fontPt || 0),
    };
  }

  function renderParagraph(pNode, { inCell = false } = {}) {
    const directPPr = parseWordPPr(findChild(pNode, 'pPr'));
    const stResolved = stylesCtx.resolveParaStyle(directPPr.pStyle);
    const mergedPPr = { ...stResolved.pPr, ...directPPr };
    const paraBaseRPr = { ...stResolved.rPr, ...(mergedPPr.pRPr || {}) };

    let headingLevel = inferHeadingLevelFromStyle(directPPr.pStyle, stResolved.name, mergedPPr);
    if (!headingLevel && stResolved.headingLevel) headingLevel = stResolved.headingLevel;

    let innerHtml = '';
    let plainText = '';
    let hasPageBreakAfter = false;
    let maxRunPt = Number(paraBaseRPr.fontPt || 0);
    let visibleRuns = 0;
    let boldRuns = 0;

    const visitInlineChildren = (container) => {
      for (const ch of container.children || []) {
        if (!ch || ch.text !== undefined) continue;
        switch (ch.local) {
          case 'r': {
            const rr = renderRun(ch, paraBaseRPr);
            innerHtml += rr.html;
            plainText += rr.plain;
            if (rr.hasPageBreak) hasPageBreakAfter = true;
            if (rr.plain.trim()) {
              visibleRuns++;
              if (rr.bold) boldRuns++;
              if (rr.fontPt > maxRunPt) maxRunPt = rr.fontPt;
            }
            break;
          }
          case 'hyperlink': {
            const rid = getAttr(ch, 'id');
            const anchor = getAttr(ch, 'anchor');
            let href = '';
            if (rid && rels.has(rid)) href = sanitizeHref(rels.get(rid).target);
            else if (anchor) href = `#${encodeURIComponent(anchor)}`;
            const beforeLen = innerHtml.length;
            visitInlineChildren(ch);
            const linkBody = innerHtml.slice(beforeLen);
            if (href && linkBody) {
              const isExt = /^https?:\/\//i.test(href);
              const targetAttr = isExt ? ' target="_blank" rel="noopener noreferrer"' : '';
              innerHtml =
                innerHtml.slice(0, beforeLen) +
                `<a class="aw-doc-link" href="${escapeHtml(href)}"${targetAttr}>${linkBody}</a>`;
            }
            break;
          }
          case 'ins':
          case 'smartTag':
          case 'fldSimple':
            visitInlineChildren(ch);
            break;
          case 'sdt': {
            const content = findChild(ch, 'sdtContent');
            if (content) visitInlineChildren(content);
            break;
          }
          case 'oMath':
          case 'oMathPara': {
            const formula = renderOmmlNode(ch).trim();
            if (formula) {
              innerHtml += `<span class="aw-doc-math">${escapeHtml(formula)}</span>`;
              plainText += formula;
            }
            break;
          }
          case 'AlternateContent': {
            const branch = findChild(ch, 'Choice') || findChild(ch, 'Fallback');
            if (branch) visitInlineChildren(branch);
            break;
          }
          case 'del':
            // Skip deleted revision text
            break;
          default:
            break;
        }
      }
    };

    visitInlineChildren(pNode);

    const trimmedPlain = plainText.replace(/\s+/g, ' ').trim();
    const hasVisualContent = Boolean(trimmedPlain || innerHtml.includes('<img') || innerHtml.includes('aw-doc-media-chip') || innerHtml.includes('aw-doc-textbox'));

    let pageBreakHtml = '';
    if (mergedPPr.pageBreakBefore && !inCell) {
      pageBreakHtml = '<div class="aw-doc-pagebreak" role="separator"><span>分页符</span></div>';
    }
    const pageBreakAfterHtml = hasPageBreakAfter && !inCell
      ? '<div class="aw-doc-pagebreak" role="separator"><span>分页符</span></div>'
      : '';

    if (!hasVisualContent) {
      if (pageBreakHtml || pageBreakAfterHtml) return pageBreakHtml + pageBreakAfterHtml;
      return inCell ? '' : '<div class="aw-doc-spacer" aria-hidden="true"></div>';
    }

    paraCount++;

    // List numbering marker
    let listPrefixHtml = '';
    let listIndentLevel = 0;
    if (mergedPPr.numPr && !headingLevel) {
      const marker = numCtx.nextMarker(mergedPPr.numPr.numId, mergedPPr.numPr.ilvl);
      if (marker && marker.text) {
        listIndentLevel = Math.min(6, Math.max(0, marker.level));
        listPrefixHtml = `<span class="aw-doc-list-marker">${escapeHtml(marker.text)}</span>`;
        plainText = `${marker.text} ${plainText}`;
      }
    }

    if (trimmedPlain) {
      plainLines.push(plainText.trim());
    }

    // Heuristic heading promotion for manually styled Chinese/academic Word headings (run-level bold + size or structural numbering)
    if (!inCell && !headingLevel && trimmedPlain.length >= 2 && trimmedPlain.length <= 68 && !/[。？！；;]$/.test(trimmedPlain)) {
      const allBold = visibleRuns > 0 && boldRuns === visibleRuns;
      const isMajorCnHeading = /^(?:第[一二三四五六七八九十百0-9]+[章节部分]|(?:[一二三四五六七八九十]+、))/.test(trimmedPlain);
      const isSubCnHeading = /^(?:（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\)|\d+\.\d+(?:\.\d+)?\s+\S)/.test(trimmedPlain);
      if (allBold && maxRunPt >= 16) headingLevel = 1;
      else if (allBold && maxRunPt >= 14) headingLevel = 2;
      else if (allBold && isMajorCnHeading && trimmedPlain.length <= 42) headingLevel = 2;
      else if (allBold && isSubCnHeading && trimmedPlain.length <= 46) headingLevel = 3;
    }

    const pStyles = [];
    const pAttrs = [];
    if (mergedPPr.align === 'center') pStyles.push('text-align:center');
    else if (mergedPPr.align === 'right' || mergedPPr.align === 'end') pStyles.push('text-align:right');
    else if (mergedPPr.align === 'both' || mergedPPr.align === 'distribute') pStyles.push('text-align:justify');

    if (listPrefixHtml) {
      pAttrs.push('class="aw-doc-p aw-doc-list-item"');
      if (listIndentLevel > 0) pStyles.push(`padding-left:${(listIndentLevel * 1.4).toFixed(1)}em`);
    } else {
      const cls = ['aw-doc-p'];
      if (mergedPPr.hasLeftBorder) cls.push('aw-doc-quote');
      if (mergedPPr.hasBottomBorder) cls.push('aw-doc-ruled');
      pAttrs.push(`class="${cls.join(' ')}"`);
      if (!headingLevel && !inCell && mergedPPr.align !== 'center') {
        if (mergedPPr.firstLineChars >= 150 || mergedPPr.firstLineTwips >= 320) {
          pStyles.push('text-indent:2em');
        }
        if (mergedPPr.indentLeftTwips >= 360) {
          const emLeft = Math.min(5, mergedPPr.indentLeftTwips / 240);
          pStyles.push(`padding-left:${emLeft.toFixed(1)}em`);
        }
      }
    }

    if (mergedPPr.shading && colorLuminance(mergedPPr.shading) <= 0.92) {
      pStyles.push(`--aw-doc-bg:${mergedPPr.shading}`);
      pAttrs.push('data-aw-bg="shaded"');
    }

    const styleStr = pStyles.length ? ` style="${pStyles.join(';')}"` : '';

    if (headingLevel >= 1 && headingLevel <= 6 && !inCell) {
      const hTag = `h${headingLevel}`;
      const hid = `aw-h-${++headingSeq}`;
      const cleanHeading = trimmedPlain.slice(0, 90);
      if (cleanHeading) {
        outline.push({ id: hid, level: headingLevel, title: cleanHeading });
      }
      return `${pageBreakHtml}<${hTag} id="${hid}" class="aw-doc-h aw-doc-h${headingLevel}"${styleStr}>${listPrefixHtml}${innerHtml}</${hTag}>${pageBreakAfterHtml}`;
    }

    if (listPrefixHtml) {
      return `${pageBreakHtml}<p ${pAttrs.join(' ')}${styleStr}>${listPrefixHtml}<span class="aw-doc-list-body">${innerHtml}</span></p>${pageBreakAfterHtml}`;
    }

    return `${pageBreakHtml}<p ${pAttrs.join(' ')}${styleStr}>${innerHtml}</p>${pageBreakAfterHtml}`;
  }

  function renderTable(tblNode) {
    tableCount++;
    const trNodes = findChildren(tblNode, 'tr');
    if (!trNodes.length) return '';

    // Parse table grid widths for relative proportions
    const tblGrid = findChild(tblNode, 'tblGrid');
    const gridCols = tblGrid
      ? findChildren(tblGrid, 'gridCol').map((gc) => Number(getAttr(gc, 'w') || 0)).filter((n) => n > 0)
      : [];
    const totalGridW = gridCols.reduce((a, b) => a + b, 0);

    const parsedRows = [];
    const activeVMerge = []; // colIdx -> cell descriptor

    for (let rIdx = 0; rIdx < trNodes.length; rIdx++) {
      const tr = trNodes[rIdx];
      const trPr = findChild(tr, 'trPr');
      const isHeader = Boolean(findChild(trPr, 'tblHeader'));
      const cells = [];
      const rowPlain = [];
      let colCursor = 0;

      for (const tc of findChildren(tr, 'tc')) {
        const tcPr = findChild(tc, 'tcPr');
        const gridSpan = Math.max(1, Number(getAttr(findChild(tcPr, 'gridSpan'), 'val') || 1));
        const vMergeNode = findChild(tcPr, 'vMerge');
        const vMergeVal = vMergeNode ? getAttr(vMergeNode, 'val') : null;
        const shdFill = normalizeHexColor(getAttr(findChild(tcPr, 'shd'), 'fill'));
        const vAlign = getAttr(findChild(tcPr, 'vAlign'), 'val');

        if (vMergeNode && vMergeVal !== 'restart') {
          const anchor = activeVMerge[colCursor];
          if (anchor) {
            anchor.rowspan += 1;
            colCursor += gridSpan;
            continue;
          }
        }

        const cellHtml = renderBlockChildren(tc, { inCell: true }) || '&nbsp;';
        const cellPlain = collectText(tc).replace(/\s+/g, ' ').trim();
        if (cellPlain) rowPlain.push(cellPlain);

        const cellObj = {
          html: cellHtml,
          colspan: gridSpan,
          rowspan: 1,
          shdFill,
          vAlign,
          isHeader,
        };
        cells.push(cellObj);

        if (vMergeNode && vMergeVal === 'restart') {
          for (let k = 0; k < gridSpan; k++) activeVMerge[colCursor + k] = cellObj;
        } else {
          for (let k = 0; k < gridSpan; k++) activeVMerge[colCursor + k] = null;
        }
        colCursor += gridSpan;
      }

      if (rowPlain.length) plainLines.push(rowPlain.join(' | '));
      parsedRows.push({ isHeader, cells });
    }

    const colgroupHtml =
      totalGridW > 0 && gridCols.length >= 2 && gridCols.length <= 16
        ? `<colgroup>${gridCols.map((w) => `<col style="width:${((w / totalGridW) * 100).toFixed(1)}%" />`).join('')}</colgroup>`
        : '';

    const emitRow = (row, asHead) => {
      const tag = asHead ? 'th' : 'td';
      return `<tr>${row.cells
        .map((c) => {
          const attrs = [];
          const st = [];
          if (c.colspan > 1) attrs.push(`colspan="${c.colspan}"`);
          if (c.rowspan > 1) attrs.push(`rowspan="${c.rowspan}"`);
          if (c.vAlign === 'center') st.push('vertical-align:middle');
          else if (c.vAlign === 'bottom') st.push('vertical-align:bottom');
          if (c.shdFill && colorLuminance(c.shdFill) <= 0.93) {
            st.push(`--aw-doc-bg:${c.shdFill}`);
            attrs.push('data-aw-bg="shaded"');
          }
          if (st.length) attrs.push(`style="${st.join(';')}"`);
          return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${c.html}</${tag}>`;
        })
        .join('')}</tr>`;
    };

    const headRows = [];
    const bodyRows = [];
    let collectingHead = true;
    for (let i = 0; i < parsedRows.length; i++) {
      if (collectingHead && parsedRows[i].isHeader) {
        headRows.push(parsedRows[i]);
      } else {
        collectingHead = false;
        bodyRows.push(parsedRows[i]);
      }
    }

    const tblPr = findChild(tblNode, 'tblPr');
    const tblBorders = findChild(tblPr, 'tblBorders');
    const isBorderless = (() => {
      if (!tblBorders) return false;
      const sides = ['top', 'bottom', 'left', 'right', 'insideH', 'insideV']
        .map((s) => findChild(tblBorders, s))
        .filter(Boolean);
      if (!sides.length) return false;
      return sides.every(
        (s) => /^(?:none|nil)$/i.test(getAttr(s, 'val')) || getAttr(s, 'sz') === '0'
      );
    })();

    const theadHtml = headRows.length ? `<thead>${headRows.map((r) => emitRow(r, true)).join('')}</thead>` : '';
    const tbodyHtml = `<tbody>${bodyRows.map((r) => emitRow(r, false)).join('')}</tbody>`;
    return `<div class="aw-doc-table-wrap"><table class="aw-doc-table"${isBorderless ? ' data-aw-borderless="1"' : ''}>${colgroupHtml}${theadHtml}${tbodyHtml}</table></div>`;
  }

  function renderBlockChildren(container, opts = {}) {
    const out = [];
    let consecutiveSpacers = 0;
    for (const ch of container.children || []) {
      if (!ch || ch.text !== undefined) continue;
      if (snippetOnly && plainLines.length >= 24) break;
      let chunk = '';
      if (ch.local === 'p') {
        chunk = renderParagraph(ch, opts);
      } else if (ch.local === 'tbl') {
        chunk = renderTable(ch);
      } else if (ch.local === 'sdt') {
        const content = findChild(ch, 'sdtContent');
        if (content) chunk = renderBlockChildren(content, opts);
      } else if (ch.local === 'ins') {
        chunk = renderBlockChildren(ch, opts);
      } else if (ch.local === 'AlternateContent') {
        const branch = findChild(ch, 'Choice') || findChild(ch, 'Fallback');
        if (branch) chunk = renderBlockChildren(branch, opts);
      }
      if (!chunk) continue;
      if (chunk === '<div class="aw-doc-spacer" aria-hidden="true"></div>') {
        consecutiveSpacers++;
        if (consecutiveSpacers > 1) continue;
      } else {
        consecutiveSpacers = 0;
      }
      out.push(chunk);
    }
    return out.join('\n');
  }

  let bodyHtml = renderBlockChildren(body, { inCell: false });

  if (!snippetOnly) {
    const headerText = renderDocxHeaderFooterSnippet(zip, rels, '/header');
    const footerText = renderDocxHeaderFooterSnippet(zip, rels, '/footer');
    if (headerText) {
      bodyHtml = `<div class="aw-doc-running-note aw-doc-header-note">页眉 · ${escapeHtml(headerText)}</div>\n` + bodyHtml;
    }
    if (usedNotes.length) {
      bodyHtml += `\n<section class="aw-doc-footnotes"><h4>脚注与尾注</h4><ol>${usedNotes
        .map((n) => `<li id="${n.id}"><span class="aw-doc-note-tag">${escapeHtml(n.kind)} ${n.num}</span> ${escapeHtml(n.text)}</li>`)
        .join('')}</ol></section>`;
    }
    if (comments.length) {
      bodyHtml += `\n<section class="aw-doc-comments"><h4>文档批注 (${comments.length})</h4><ul>${comments
        .map(
          (c) =>
            `<li><strong>${escapeHtml(c.author)}</strong>${c.date ? ` <span class="aw-doc-muted">${escapeHtml(c.date)}</span>` : ''}：${escapeHtml(c.text)}</li>`
        )
        .join('')}</ul></section>`;
    }
    if (footerText) {
      bodyHtml += `\n<div class="aw-doc-running-note aw-doc-footer-note">页脚 · ${escapeHtml(footerText)}</div>`;
    }
  }

  const mediaStats = media.getStats();
  if (mediaStats.skippedUnsupportedCount > 0) {
    warnings.push(`文档包含 ${mediaStats.skippedUnsupportedCount} 张 Windows 矢量图（WMF/EMF），如需查看原图可点击「系统打开」。`);
  }

  const plainText = plainLines.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS);
  const charCount = plainText.replace(/\s+/g, '').length;
  const statParts = [`约 ${charCount.toLocaleString('en-US')} 字`];
  if (tableCount > 0) statParts.push(`${tableCount} 表格`);
  if (mediaStats.embeddedCount > 0) statParts.push(`${mediaStats.embeddedCount} 图`);
  if (comments.length > 0) statParts.push(`${comments.length} 批注`);

  return {
    ok: true,
    format: 'docx',
    formatLabel: 'Word 文档',
    badge: 'DOCX',
    path: filePath,
    title: coreProps.title || path.basename(filePath),
    ext: 'docx',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: true,
    meta: {
      ...coreProps,
      statsLabel: statParts.join(' · '),
      paragraphCount: paraCount,
      tableCount,
      imageCount: mediaStats.embeddedCount,
    },
    outline,
    bodyHtml: bodyHtml || '<p class="aw-doc-empty-msg">文档正文为空。</p>',
    plainText,
    snippetLines: plainLines.slice(0, 14),
    warnings,
  };
}

// ── 2. XLSX / XLSM Spreadsheet Renderer ─────────────────────────────────────

function colLettersToIndex(letters) {
  let idx = 0;
  const s = String(letters || '').toUpperCase();
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64);
  }
  return Math.max(0, idx - 1);
}

function indexToColLetters(idx) {
  let n = idx + 1;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function parseCellRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref || '').trim());
  if (!m) return null;
  return { col: colLettersToIndex(m[1]), row: Number(m[2]) - 1 };
}

function isExcelDateFormatCode(code) {
  const cleaned = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(cleaned) && !/[#0?]/.test(cleaned.replace(/\.0+/g, ''));
}

function parseXlsxDateStyleSet(zip) {
  const dateStyleIndices = new Set();
  const xml = zip.getEntryText('xl/styles.xml');
  if (!xml) return dateStyleIndices;
  const root = parseXml(xml);
  const customDateFmtIds = new Set();
  for (const nf of findAll(root, 'numFmt')) {
    const id = Number(getAttr(nf, 'numFmtId'));
    const code = getAttr(nf, 'formatCode');
    if (Number.isFinite(id) && isExcelDateFormatCode(code)) customDateFmtIds.add(id);
  }
  const cellXfs = findAll(root, 'cellXfs')[0];
  if (cellXfs) {
    const xfs = findChildren(cellXfs, 'xf');
    xfs.forEach((xf, idx) => {
      const fmtId = Number(getAttr(xf, 'numFmtId'));
      if (
        (fmtId >= 14 && fmtId <= 22) ||
        (fmtId >= 27 && fmtId <= 36) ||
        (fmtId >= 45 && fmtId <= 47) ||
        (fmtId >= 50 && fmtId <= 58) ||
        customDateFmtIds.has(fmtId)
      ) {
        dateStyleIndices.add(idx);
      }
    });
  }
  return dateStyleIndices;
}

function formatExcelDateSerial(serial, use1904 = false) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return String(serial);
  const epochMs = use1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = epochMs + Math.round(serial * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const frac = serial - Math.floor(serial);
  if (frac > 0.0005) {
    return `${ymd} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return ymd;
}

function parseXlsx(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const wbXml = zip.getEntryText('xl/workbook.xml');
  if (!wbXml) throw new Error('XLSX 文件缺少 xl/workbook.xml（可能已损坏或加密）');

  const coreProps = extractCoreProps(zip);
  const wbRoot = parseXml(wbXml);
  const wbPr = findAll(wbRoot, 'workbookPr')[0];
  const use1904 = getAttr(wbPr, 'date1904') === '1' || getAttr(wbPr, 'date1904') === 'true';
  const wbRels = parseRelsXml(zip.getEntryText('xl/_rels/workbook.xml.rels'));

  // Shared strings table
  const sharedStrings = [];
  const ssXml = zip.getEntryText('xl/sharedStrings.xml');
  if (ssXml) {
    const ssRoot = parseXml(ssXml);
    for (const si of findAll(ssRoot, 'si')) {
      const ts = findAll(si, 't');
      sharedStrings.push(ts.map((t) => collectText(t)).join(''));
    }
  }
  const dateStyleIndices = parseXlsxDateStyleSet(zip);

  const sheetNodes = findAll(wbRoot, 'sheet');
  const sections = [];
  const outline = [];
  const warnings = [];
  const snippetLines = [];
  const plainChunks = [];

  const sheetLimit = snippetOnly ? 1 : 30;
  for (let sIdx = 0; sIdx < sheetNodes.length && sIdx < sheetLimit; sIdx++) {
    const sh = sheetNodes[sIdx];
    const sheetName = getAttr(sh, 'name') || `Sheet${sIdx + 1}`;
    const rid = getAttr(sh, 'id');
    const rel = wbRels.get(rid);
    const targetPath = rel
      ? resolveZipRelPath('xl/workbook.xml', rel.target)
      : `xl/worksheets/sheet${sIdx + 1}.xml`;
    const shXml = zip.getEntryText(targetPath);
    if (!shXml) continue;

    const shRoot = parseXml(shXml);
    const maxRows = snippetOnly ? 14 : MAX_XLSX_ROWS_PER_SHEET;
    const maxCols = snippetOnly ? 8 : MAX_XLSX_COLS_PER_SHEET;

    // Parse merged cells
    const mergeMaster = new Map(); // "r,c" -> { colspan, rowspan }
    const mergeCovered = new Set(); // "r,c"
    for (const mc of findAll(shRoot, 'mergeCell')) {
      const ref = getAttr(mc, 'ref');
      const [startRef, endRef] = ref.split(':');
      const a = parseCellRef(startRef);
      const b = parseCellRef(endRef);
      if (!a || !b) continue;
      if (a.row >= maxRows || a.col >= maxCols) continue;
      const rSpan = Math.min(maxRows - 1, b.row) - a.row + 1;
      const cSpan = Math.min(maxCols - 1, b.col) - a.col + 1;
      if (rSpan > 1 || cSpan > 1) {
        mergeMaster.set(`${a.row},${a.col}`, { rowspan: rSpan, colspan: cSpan });
        for (let rr = a.row; rr < a.row + rSpan; rr++) {
          for (let cc = a.col; cc < a.col + cSpan; cc++) {
            if (rr !== a.row || cc !== a.col) mergeCovered.add(`${rr},${cc}`);
          }
        }
      }
    }

    const rowMap = new Map();
    let maxSeenRow = -1;
    let maxSeenCol = -1;
    let totalSheetRows = 0;

    for (const rowNode of findAll(shRoot, 'row')) {
      totalSheetRows++;
      const rAttr = Number(getAttr(rowNode, 'r'));
      const rIdx = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : totalSheetRows - 1;
      if (rIdx >= maxRows) continue;
      const cells = rowMap.get(rIdx) || new Map();
      let autoCol = 0;

      for (const cNode of findChildren(rowNode, 'c')) {
        const ref = getAttr(cNode, 'r');
        const parsed = ref ? parseCellRef(ref) : null;
        const cIdx = parsed ? parsed.col : autoCol;
        autoCol = cIdx + 1;
        if (cIdx >= maxCols) continue;

        const cType = getAttr(cNode, 't');
        const styleIdx = Number(getAttr(cNode, 's'));
        let val = '';
        if (cType === 's') {
          const idx = Number(collectText(findChild(cNode, 'v')));
          val = Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (cType === 'inlineStr') {
          const isNode = findChild(cNode, 'is');
          val = findAll(isNode, 't').map((t) => collectText(t)).join('');
        } else if (cType === 'b') {
          val = collectText(findChild(cNode, 'v')) === '1' ? 'TRUE' : 'FALSE';
        } else if (cType === 'str' || cType === 'e') {
          val = collectText(findChild(cNode, 'v'));
        } else {
          const rawV = collectText(findChild(cNode, 'v')).trim();
          if (rawV !== '') {
            const num = Number(rawV);
            if (Number.isFinite(num) && Number.isFinite(styleIdx) && dateStyleIndices.has(styleIdx)) {
              val = formatExcelDateSerial(num, use1904);
            } else if (Number.isFinite(num) && /\.\d{7,}/.test(rawV)) {
              val = String(Number(num.toFixed(4)));
            } else {
              val = rawV;
            }
          }
        }
        if (val !== '') {
          cells.set(cIdx, val);
          if (rIdx > maxSeenRow) maxSeenRow = rIdx;
          if (cIdx > maxSeenCol) maxSeenCol = cIdx;
        }
      }
      if (cells.size > 0) rowMap.set(rIdx, cells);
    }

    const rowCount = Math.max(0, maxSeenRow + 1);
    const colCount = Math.max(0, maxSeenCol + 1);
    const truncated = totalSheetRows > maxRows;
    if (truncated && !snippetOnly) {
      warnings.push(`工作表「${sheetName}」共 ${totalSheetRows} 行，当前展示前 ${maxRows} 行以保持流畅。`);
    }

    // Build HTML table
    let html = '';
    if (rowCount === 0 || colCount === 0) {
      html = '<p class="aw-doc-empty-msg">此工作表暂无数据。</p>';
    } else {
      const colHeaders = Array.from({ length: colCount }, (_, c) => `<th>${indexToColLetters(c)}</th>`).join('');
      const bodyRowsHtml = [];
      for (let r = 0; r < rowCount; r++) {
        const rowCells = rowMap.get(r);
        const tds = [`<td class="aw-sheet-rn">${r + 1}</td>`];
        const rowVals = [];
        for (let c = 0; c < colCount; c++) {
          const key = `${r},${c}`;
          if (mergeCovered.has(key)) continue;
          const v = rowCells?.get(c) ?? '';
          if (v !== '') rowVals.push(v);
          const span = mergeMaster.get(key);
          const attrs = [];
          if (span?.colspan > 1) attrs.push(`colspan="${span.colspan}"`);
          if (span?.rowspan > 1) attrs.push(`rowspan="${span.rowspan}"`);
          const isNumeric = v !== '' && /^-?\d+(?:\.\d+)?%?$/.test(v.trim());
          if (isNumeric) attrs.push('class="aw-sheet-num"');
          tds.push(`<td${attrs.length ? ` ${attrs.join(' ')}` : ''}>${escapeHtml(v)}</td>`);
        }
        if (rowVals.length) {
          if (sIdx === 0 && snippetLines.length < 12) snippetLines.push(rowVals.slice(0, 6).join(' | '));
          plainChunks.push(rowVals.join('\t'));
        }
        bodyRowsHtml.push(`<tr data-aw-row="${r + 1}">${tds.join('')}</tr>`);
      }
      html = `<div class="aw-sheet-wrap"><table class="aw-sheet-table"><thead><tr><th class="aw-sheet-corner">#</th>${colHeaders}</tr></thead><tbody>${bodyRowsHtml.join('')}</tbody></table></div>`;
    }

    const secId = `sheet-${sIdx}`;
    outline.push({ id: secId, level: 1, title: sheetName });
    sections.push({
      id: secId,
      title: sheetName,
      rowCount: totalSheetRows,
      colCount,
      truncated,
      html,
    });
  }

  return {
    ok: true,
    format: 'xlsx',
    formatLabel: 'Excel 表格',
    badge: path.extname(filePath).slice(1).toUpperCase() || 'XLSX',
    path: filePath,
    title: coreProps.title || path.basename(filePath),
    ext: path.extname(filePath).slice(1).toLowerCase() || 'xlsx',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: {
      ...coreProps,
      statsLabel: `${sheetNodes.length} 个工作表${sections[0] ? ` · 首表 ${sections[0].rowCount} 行` : ''}`,
      sheetCount: sheetNodes.length,
    },
    outline,
    sections,
    bodyHtml: sections[0]?.html || '<p class="aw-doc-empty-msg">工作簿为空。</p>',
    plainText: plainChunks.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines: [`[工作表: ${sections.map((s) => s.title).join(' / ')}]`, ...snippetLines].slice(0, 14),
    warnings,
  };
}

// ── 3. PPTX Presentation Renderer ───────────────────────────────────────────

function renderPptTextBody(txBodyNode) {
  const paras = [];
  const plain = [];
  for (const p of findChildren(txBodyNode, 'p')) {
    const pPr = findChild(p, 'pPr');
    const lvl = Math.min(5, Math.max(0, Number(getAttr(pPr, 'lvl') || 0)));
    const buNone = Boolean(findChild(pPr, 'buNone'));
    const buChar = getAttr(findChild(pPr, 'buChar'), 'char');
    const buAuto = Boolean(findChild(pPr, 'buAutoNum'));

    const runs = [];
    let rawLine = '';
    for (const ch of p.children || []) {
      if (ch.local === 'r') {
        const rPr = findChild(ch, 'rPr');
        const txt = collectText(findChild(ch, 't'));
        if (!txt) continue;
        rawLine += txt;
        const b = getAttr(rPr, 'b') === '1';
        const it = getAttr(rPr, 'i') === '1';
        let h = escapeHtml(txt);
        if (b) h = `<strong>${h}</strong>`;
        if (it) h = `<em>${h}</em>`;
        runs.push(h);
      } else if (ch.local === 'fld') {
        const txt = collectText(findChild(ch, 't'));
        if (txt) {
          rawLine += txt;
          runs.push(escapeHtml(txt));
        }
      } else if (ch.local === 'br') {
        runs.push('<br/>');
        rawLine += ' ';
      }
    }
    const clean = rawLine.trim();
    if (!clean) continue;
    plain.push(clean);
    const bullet = !buNone && (buChar || buAuto || lvl > 0) ? `<span class="aw-slide-bullet">${escapeHtml(buChar || '•')}</span>` : '';
    paras.push(`<p class="aw-slide-p" data-lvl="${lvl}">${bullet}<span>${runs.join('')}</span></p>`);
  }
  return { html: paras.join(''), plain };
}

function renderPptTable(tblNode) {
  const rows = findChildren(tblNode, 'tr');
  if (!rows.length) return '';
  const trHtml = rows
    .map((tr, rIdx) => {
      const cells = findChildren(tr, 'tc');
      const tag = rIdx === 0 ? 'th' : 'td';
      return `<tr>${cells
        .filter((tc) => getAttr(tc, 'hMerge') !== '1' && getAttr(tc, 'vMerge') !== '1')
        .map((tc) => {
          const cs = Number(getAttr(tc, 'gridSpan') || 1);
          const rs = Number(getAttr(tc, 'rowSpan') || 1);
          const attrs = [];
          if (cs > 1) attrs.push(`colspan="${cs}"`);
          if (rs > 1) attrs.push(`rowspan="${rs}"`);
          const txt = findAll(tc, 't').map((t) => collectText(t)).join('');
          return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${escapeHtml(txt)}</${tag}>`;
        })
        .join('')}</tr>`;
    })
    .join('');
  return `<div class="aw-doc-table-wrap"><table class="aw-doc-table">${trHtml}</table></div>`;
}

function parsePptx(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const presXml = zip.getEntryText('ppt/presentation.xml');
  if (!presXml) throw new Error('PPTX 文件缺少 ppt/presentation.xml（可能已损坏或加密）');

  const coreProps = extractCoreProps(zip);
  const presRoot = parseXml(presXml);
  const presRels = parseRelsXml(zip.getEntryText('ppt/_rels/presentation.xml.rels'));
  const media = createMediaLoader(zip, { snippetOnly });

  // Resolve slide order via p:sldIdLst
  const slidePaths = [];
  for (const sldId of findAll(presRoot, 'sldId')) {
    const rid = getAttr(sldId, 'id');
    const rel = presRels.get(rid);
    if (rel && !rel.external) {
      slidePaths.push(resolveZipRelPath('ppt/presentation.xml', rel.target));
    }
  }
  if (!slidePaths.length) {
    // Fallback natural order scan
    const collator = new Intl.Collator(undefined, { numeric: true });
    for (const ent of zip.entries) {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(ent.name)) slidePaths.push(ent.name);
    }
    slidePaths.sort((a, b) => collator.compare(a, b));
  }

  const outline = [];
  const slideCardsHtml = [];
  const plainChunks = [];
  const snippetLines = [];
  const warnings = [];
  const maxSlides = snippetOnly ? 6 : 120;

  for (let i = 0; i < slidePaths.length && i < maxSlides; i++) {
    const sp = slidePaths[i];
    const xml = zip.getEntryText(sp);
    if (!xml) continue;
    const slideRoot = parseXml(xml);
    const relsPath = sp.replace(/^ppt\/slides\//i, 'ppt/slides/_rels/') + '.rels';
    const slideRels = parseRelsXml(zip.getEntryText(relsPath));

    let slideTitle = '';
    const blocks = [];
    const slidePlain = [];

    for (const spNode of findAll(slideRoot, 'sp')) {
      const ph = findAll(spNode, 'ph')[0];
      const phType = getAttr(ph, 'type');
      const txBody = findChild(spNode, 'txBody');
      if (!txBody) continue;
      const rendered = renderPptTextBody(txBody);
      if (!rendered.plain.length) continue;
      if (!slideTitle && (phType === 'title' || phType === 'ctrTitle')) {
        slideTitle = rendered.plain.join(' ').slice(0, 90);
        blocks.unshift(`<h3 class="aw-slide-title">${escapeHtml(slideTitle)}</h3>`);
      } else if (phType === 'subTitle') {
        blocks.push(`<p class="aw-slide-subtitle">${escapeHtml(rendered.plain.join(' '))}</p>`);
      } else if (phType === 'sldNum' || phType === 'ftr' || phType === 'dt') {
        continue;
      } else {
        blocks.push(`<div class="aw-slide-textblock">${rendered.html}</div>`);
      }
      slidePlain.push(...rendered.plain);
    }

    // Tables on slide
    for (const tbl of findAll(slideRoot, 'tbl')) {
      const tHtml = renderPptTable(tbl);
      if (tHtml) blocks.push(tHtml);
    }

    // Embedded pictures on slide
    if (!snippetOnly) {
      const imgs = [];
      for (const pic of findAll(slideRoot, 'pic')) {
        const blip = findAll(pic, 'blip')[0];
        const rid = getAttr(blip, 'embed');
        const rel = rid ? slideRels.get(rid) : null;
        if (!rel || rel.external) continue;
        const imgPath = resolveZipRelPath(sp, rel.target);
        const loaded = media.loadImageDataUrl(imgPath);
        if (loaded.ok) {
          imgs.push(`<img src="${loaded.dataUrl}" alt="幻灯片 ${i + 1} 配图" loading="lazy" />`);
        }
      }
      if (imgs.length) {
        blocks.push(`<div class="aw-slide-media-grid">${imgs.join('')}</div>`);
      }
    }

    // Speaker notes
    let notesText = '';
    if (!snippetOnly) {
      for (const rel of slideRels.values()) {
        if (!rel.external && /notesslide/i.test(String(rel.type || rel.target || ''))) {
          const notePath = resolveZipRelPath(sp, rel.target);
          const noteXml = zip.getEntryText(notePath);
          if (noteXml) {
            const noteRoot = parseXml(noteXml);
            notesText = findAll(noteRoot, 'sp')
              .filter((n) => getAttr(findAll(n, 'ph')[0], 'type') !== 'sldNum')
              .map((n) => findAll(n, 'p').map((p) => collectText(p).trim()).filter(Boolean).join('\n'))
              .filter(Boolean)
              .join('\n')
              .trim();
          }
          break;
        }
      }
    }

    const displayTitle = slideTitle || slidePlain[0]?.slice(0, 60) || `第 ${i + 1} 页`;
    const anchorId = `aw-slide-${i + 1}`;
    outline.push({ id: anchorId, level: 1, title: `${i + 1}. ${displayTitle}` });
    snippetLines.push(`P${i + 1}: ${displayTitle}`);
    plainChunks.push(`--- 幻灯片 ${i + 1}: ${displayTitle} ---\n${slidePlain.join('\n')}${notesText ? `\n[备注] ${notesText}` : ''}`);

    const notesHtml = notesText
      ? `<details class="aw-slide-notes"><summary>演讲者备注</summary><div class="aw-slide-notes-body">${escapeHtml(notesText).replace(/\n/g, '<br/>')}</div></details>`
      : '';

    slideCardsHtml.push(`
      <section class="aw-slide-card" id="${anchorId}">
        <div class="aw-slide-head">
          <span class="aw-slide-num">P${String(i + 1).padStart(2, '0')} / ${String(slidePaths.length).padStart(2, '0')}</span>
          <span class="aw-slide-head-title">${escapeHtml(displayTitle)}</span>
        </div>
        <div class="aw-slide-body">${blocks.join('') || '<p class="aw-doc-empty-msg">本页仅含图形或空白内容</p>'}</div>
        ${notesHtml}
      </section>
    `);
  }

  if (slidePaths.length > maxSlides && !snippetOnly) {
    warnings.push(`演示文稿共 ${slidePaths.length} 页，已展示前 ${maxSlides} 页。`);
  }

  const mStats = media.getStats();
  return {
    ok: true,
    format: 'pptx',
    formatLabel: 'PPT 演示文稿',
    badge: 'PPTX',
    path: filePath,
    title: coreProps.title || path.basename(filePath),
    ext: 'pptx',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: {
      ...coreProps,
      statsLabel: `${slidePaths.length} 页幻灯片${mStats.embeddedCount ? ` · ${mStats.embeddedCount} 图` : ''}`,
      slideCount: slidePaths.length,
    },
    outline,
    bodyHtml: `<div class="aw-slides-deck">${slideCardsHtml.join('\n')}</div>`,
    plainText: plainChunks.join('\n\n').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines: snippetLines.slice(0, 14),
    warnings,
  };
}

// ── 4. CSV / TSV Delimited Table Renderer ───────────────────────────────────

export function parseDelimitedRows(text, delimiter = ',', maxRows = MAX_CSV_ROWS, maxCols = MAX_CSV_COLS) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let totalRows = 0;
  const s = String(text || '');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      if (row.length < maxCols) row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      if (row.length < maxCols) row.push(field);
      field = '';
      if (row.some((c) => c !== '')) {
        totalRows++;
        if (rows.length < maxRows) rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    if (row.length < maxCols) row.push(field);
    if (row.some((c) => c !== '')) {
      totalRows++;
      if (rows.length < maxRows) rows.push(row);
    }
  }
  return { rows, totalRows, truncated: totalRows > rows.length };
}

function parseCsvTsv(buf, filePath, stat, isTsv, { snippetOnly = false } = {}) {
  const decoded = decodeBuffer(buf.subarray(0, Math.min(buf.length, snippetOnly ? 32768 : 4 * 1024 * 1024)), '', {
    truncated: buf.length > (snippetOnly ? 32768 : 4 * 1024 * 1024),
  });
  let delimiter = isTsv ? '\t' : ',';
  if (!isTsv) {
    const firstLine = (decoded.text || '').split(/\r?\n/)[0] || '';
    const commas = (firstLine.match(/,/g) || []).length;
    const semis = (firstLine.match(/;/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;
    if (tabs > commas && tabs > 0) delimiter = '\t';
    else if (semis > commas && semis > 0) delimiter = ';';
  }

  const { rows, totalRows, truncated } = parseDelimitedRows(
    decoded.text,
    delimiter,
    snippetOnly ? 14 : MAX_CSV_ROWS,
    snippetOnly ? 8 : MAX_CSV_COLS
  );
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const warnings = [];
  if (truncated && !snippetOnly) {
    warnings.push(`数据表共 ${totalRows} 行，当前展示前 ${rows.length} 行。`);
  }

  let html = '<p class="aw-doc-empty-msg">数据表为空。</p>';
  if (rows.length > 0 && colCount > 0) {
    const header = rows[0];
    const bodyRows = rows.slice(1);
    const thead = `<thead><tr><th class="aw-sheet-corner">#</th>${Array.from({ length: colCount }, (_, c) => `<th>${escapeHtml(header[c] ?? indexToColLetters(c))}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${bodyRows
      .map(
        (r, idx) =>
          `<tr data-aw-row="${idx + 1}"><td class="aw-sheet-rn">${idx + 1}</td>${Array.from({ length: colCount }, (_, c) => {
            const v = r[c] ?? '';
            const numCls = v !== '' && /^-?\d+(?:\.\d+)?%?$/.test(v.trim()) ? ' class="aw-sheet-num"' : '';
            return `<td${numCls}>${escapeHtml(v)}</td>`;
          }).join('')}</tr>`
      )
      .join('')}</tbody>`;
    html = `<div class="aw-sheet-wrap"><table class="aw-sheet-table">${thead}${tbody}</table></div>`;
  }

  const snippetLines = rows.slice(0, 12).map((r) => r.slice(0, 6).join(' | '));
  return {
    ok: true,
    format: isTsv ? 'tsv' : 'csv',
    formatLabel: isTsv ? 'TSV 数据表' : 'CSV 数据表',
    badge: isTsv ? 'TSV' : 'CSV',
    path: filePath,
    title: path.basename(filePath),
    ext: isTsv ? 'tsv' : 'csv',
    sizeBytes: stat.size,
    autoRender: false,
    supportsPaperMode: false,
    encoding: decoded.encoding,
    meta: {
      statsLabel: `${Math.max(0, totalRows - 1)} 条记录 · ${colCount} 列 · ${String(decoded.encoding || 'utf-8').toUpperCase()}`,
    },
    outline: [],
    bodyHtml: html,
    plainText: String(decoded.text || '').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines,
    warnings,
  };
}

// ── 5. ODT / ODS / ODP OpenDocument Renderers ───────────────────────────────

function parseOdfMeta(zip) {
  const meta = { title: '', author: '', modified: '' };
  const xml = zip.getEntryText('meta.xml');
  if (!xml) return meta;
  const root = parseXml(xml);
  meta.title = collectText(findAll(root, 'title')[0]).trim();
  meta.author = collectText(findAll(root, 'initial-creator')[0] || findAll(root, 'creator')[0]).trim();
  const d = collectText(findAll(root, 'date')[0]).trim();
  if (d) meta.modified = d.slice(0, 10);
  return meta;
}

function renderOdfInline(node, media) {
  if (!node) return '';
  if (node.text !== undefined) return escapeHtml(node.text);
  const loc = node.local;
  if (loc === 's') {
    const c = Math.max(1, Math.min(20, Number(getAttr(node, 'c') || 1)));
    return '&nbsp;'.repeat(c);
  }
  if (loc === 'tab') return '<span class="aw-doc-tab">&emsp;</span>';
  if (loc === 'line-break') return '<br/>';
  if (loc === 'a') {
    const href = sanitizeHref(getAttr(node, 'href'));
    const inner = (node.children || []).map((c) => renderOdfInline(c, media)).join('');
    if (!href) return inner;
    const extAttr = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a class="aw-doc-link" href="${escapeHtml(href)}"${extAttr}>${inner}</a>`;
  }
  if (loc === 'image') {
    const href = getAttr(node, 'href');
    if (href && media) {
      const loaded = media.loadImageDataUrl(href);
      if (loaded.ok) return `<figure class="aw-doc-figure"><img src="${loaded.dataUrl}" alt="文档配图" loading="lazy" /></figure>`;
    }
    return '';
  }
  return (node.children || []).map((c) => renderOdfInline(c, media)).join('');
}

function renderOdfTable(tblNode, media, maxRows = 400, maxCols = 40) {
  const trs = findAll(tblNode, 'table-row');
  const htmlRows = [];
  const plainRows = [];
  for (let r = 0; r < trs.length && htmlRows.length < maxRows; r++) {
    const cellsHtml = [];
    const plainVals = [];
    let colCount = 0;
    for (const tc of findChildren(trs[r], 'table-cell')) {
      const rep = Math.max(1, Math.min(20, Number(getAttr(tc, 'number-columns-repeated') || 1)));
      const cs = Math.max(1, Number(getAttr(tc, 'number-columns-spanned') || 1));
      const rs = Math.max(1, Number(getAttr(tc, 'number-rows-spanned') || 1));
      const inner = findChildren(tc, 'p').map((p) => renderOdfInline(p, media)).join('<br/>') || escapeHtml(collectText(tc).trim());
      const plain = collectText(tc).replace(/\s+/g, ' ').trim();
      const effectiveRep = plain ? rep : Math.min(rep, 4);
      for (let k = 0; k < effectiveRep && colCount < maxCols; k++) {
        colCount += cs;
        if (plain) plainVals.push(plain);
        const attrs = [];
        if (cs > 1) attrs.push(`colspan="${cs}"`);
        if (rs > 1) attrs.push(`rowspan="${rs}"`);
        cellsHtml.push(`<td${attrs.length ? ` ${attrs.join(' ')}` : ''}>${inner || '&nbsp;'}</td>`);
      }
    }
    if (plainVals.length) plainRows.push(plainVals.join(' | '));
    if (cellsHtml.length) htmlRows.push(`<tr>${cellsHtml.join('')}</tr>`);
  }
  return {
    html: htmlRows.length ? `<div class="aw-doc-table-wrap"><table class="aw-doc-table"><tbody>${htmlRows.join('')}</tbody></table></div>` : '',
    plainRows,
  };
}

function parseOdt(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const contentXml = zip.getEntryText('content.xml');
  if (!contentXml) throw new Error('ODT 文件缺少 content.xml');
  const meta = parseOdfMeta(zip);
  const media = createMediaLoader(zip, { snippetOnly });
  const root = parseXml(contentXml);
  const textBody = findAll(root, 'text')[0] || root;

  const outline = [];
  const plainLines = [];
  const parts = [];
  let hSeq = 0;

  const visitBlock = (node) => {
    for (const ch of node.children || []) {
      if (!ch || ch.text !== undefined) continue;
      if (snippetOnly && plainLines.length >= 20) break;
      if (ch.local === 'h') {
        const lvl = Math.min(6, Math.max(1, Number(getAttr(ch, 'outline-level') || 1)));
        const inner = renderOdfInline(ch, media).trim();
        const plain = collectText(ch).trim();
        if (!plain) continue;
        const hid = `aw-h-${++hSeq}`;
        outline.push({ id: hid, level: lvl, title: plain.slice(0, 90) });
        plainLines.push(plain);
        parts.push(`<h${lvl} id="${hid}" class="aw-doc-h aw-doc-h${lvl}">${inner}</h${lvl}>`);
      } else if (ch.local === 'p') {
        const inner = renderOdfInline(ch, media).trim();
        const plain = collectText(ch).trim();
        if (!inner) continue;
        if (plain) plainLines.push(plain);
        parts.push(`<p class="aw-doc-p">${inner}</p>`);
      } else if (ch.local === 'list') {
        const lis = findChildren(ch, 'list-item')
          .map((li) => {
            const p = collectText(li).trim();
            if (p) plainLines.push(`• ${p}`);
            return `<li>${findChildren(li, 'p').map((pn) => renderOdfInline(pn, media)).join('<br/>')}</li>`;
          })
          .join('');
        if (lis) parts.push(`<ul class="aw-doc-ul">${lis}</ul>`);
      } else if (ch.local === 'table') {
        const t = renderOdfTable(ch, media);
        if (t.html) parts.push(t.html);
        plainLines.push(...t.plainRows);
      } else if (ch.local === 'section') {
        visitBlock(ch);
      }
    }
  };
  visitBlock(textBody);

  const plainText = plainLines.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS);
  return {
    ok: true,
    format: 'odt',
    formatLabel: 'OpenDocument 文档',
    badge: 'ODT',
    path: filePath,
    title: meta.title || path.basename(filePath),
    ext: 'odt',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: true,
    meta: { ...meta, statsLabel: `约 ${plainText.replace(/\s+/g, '').length.toLocaleString('en-US')} 字` },
    outline,
    bodyHtml: parts.join('\n') || '<p class="aw-doc-empty-msg">文档正文为空。</p>',
    plainText,
    snippetLines: plainLines.slice(0, 14),
    warnings: [],
  };
}

function parseOds(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const contentXml = zip.getEntryText('content.xml');
  if (!contentXml) throw new Error('ODS 文件缺少 content.xml');
  const meta = parseOdfMeta(zip);
  const root = parseXml(contentXml);
  const tables = findAll(root, 'table');
  const sections = [];
  const outline = [];
  const plainLines = [];

  for (let i = 0; i < tables.length && i < (snippetOnly ? 1 : 25); i++) {
    const tbl = tables[i];
    const name = getAttr(tbl, 'name') || `Sheet${i + 1}`;
    const res = renderOdfTable(tbl, null, snippetOnly ? 12 : 400, snippetOnly ? 8 : 50);
    const id = `sheet-${i}`;
    outline.push({ id, level: 1, title: name });
    sections.push({ id, title: name, rowCount: res.plainRows.length, html: res.html || '<p class="aw-doc-empty-msg">空工作表</p>' });
    if (i === 0) plainLines.push(...res.plainRows);
  }

  return {
    ok: true,
    format: 'ods',
    formatLabel: 'OpenDocument 表格',
    badge: 'ODS',
    path: filePath,
    title: meta.title || path.basename(filePath),
    ext: 'ods',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: { ...meta, statsLabel: `${tables.length} 个工作表` },
    outline,
    sections,
    bodyHtml: sections[0]?.html || '<p class="aw-doc-empty-msg">表格为空。</p>',
    plainText: plainLines.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines: plainLines.slice(0, 14),
    warnings: [],
  };
}

function parseOdp(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const contentXml = zip.getEntryText('content.xml');
  if (!contentXml) throw new Error('ODP 文件缺少 content.xml');
  const meta = parseOdfMeta(zip);
  const media = createMediaLoader(zip, { snippetOnly });
  const root = parseXml(contentXml);
  const pages = findAll(root, 'page');
  const cards = [];
  const outline = [];
  const snippetLines = [];
  const plainChunks = [];

  for (let i = 0; i < pages.length && i < (snippetOnly ? 6 : 100); i++) {
    const pg = pages[i];
    const pageName = getAttr(pg, 'name') || `第 ${i + 1} 页`;
    const ps = findAll(pg, 'p').map((p) => collectText(p).trim()).filter(Boolean);
    const title = ps[0]?.slice(0, 60) || pageName;
    const anchorId = `aw-slide-${i + 1}`;
    outline.push({ id: anchorId, level: 1, title: `${i + 1}. ${title}` });
    snippetLines.push(`P${i + 1}: ${title}`);
    plainChunks.push(`--- ${pageName} ---\n${ps.join('\n')}`);
    const bodyInner = ps.map((line, idx) => (idx === 0 ? `<h3 class="aw-slide-title">${escapeHtml(line)}</h3>` : `<p class="aw-slide-p">${escapeHtml(line)}</p>`)).join('');
    const imgs = snippetOnly
      ? []
      : findAll(pg, 'image')
          .map((im) => {
            const loaded = media.loadImageDataUrl(getAttr(im, 'href'));
            return loaded.ok ? `<img src="${loaded.dataUrl}" alt="配图" loading="lazy" />` : '';
          })
          .filter(Boolean);
    cards.push(`
      <section class="aw-slide-card" id="${anchorId}">
        <div class="aw-slide-head"><span class="aw-slide-num">P${String(i + 1).padStart(2, '0')} / ${String(pages.length).padStart(2, '0')}</span><span class="aw-slide-head-title">${escapeHtml(title)}</span></div>
        <div class="aw-slide-body">${bodyInner}${imgs.length ? `<div class="aw-slide-media-grid">${imgs.join('')}</div>` : ''}</div>
      </section>
    `);
  }

  return {
    ok: true,
    format: 'odp',
    formatLabel: 'OpenDocument 演示',
    badge: 'ODP',
    path: filePath,
    title: meta.title || path.basename(filePath),
    ext: 'odp',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: { ...meta, statsLabel: `${pages.length} 页幻灯片` },
    outline,
    bodyHtml: `<div class="aw-slides-deck">${cards.join('\n')}</div>`,
    plainText: plainChunks.join('\n\n').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines: snippetLines.slice(0, 14),
    warnings: [],
  };
}

// ── 6. RTF Rich Text Renderer (with full CJK GB18030/Big5/Shift-JIS hex support) ─

const RTF_CODEPAGE_MAP = Object.freeze({
  936: 'gb18030',
  950: 'big5',
  932: 'shift_jis',
  1252: 'windows-1252',
  65001: 'utf-8',
});

const RTF_SKIP_DESTS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'header',
  'footer',
  'headerl',
  'headerr',
  'headerf',
  'footerl',
  'footerr',
  'footerf',
  'fldinst',
  'datafield',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'generator',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'xmlnstbl',
]);

export function parseRtfToTextAndHtml(rawBuf) {
  const src = Buffer.isBuffer(rawBuf) ? rawBuf.toString('latin1') : String(rawBuf || '');
  let codepage = 'gb18030';
  const cpMatch = /\\ansicpg(\d+)/.exec(src.slice(0, 2048));
  if (cpMatch && RTF_CODEPAGE_MAP[Number(cpMatch[1])]) {
    codepage = RTF_CODEPAGE_MAP[Number(cpMatch[1])];
  }
  const hexDecoder = new TextDecoder(codepage, { fatal: false });

  const stack = [{ uc: 1, skip: false, b: false, i: false, u: false }];
  let hexBytes = [];
  let currentRuns = [];
  const paragraphs = [];

  const flushHex = () => {
    if (!hexBytes.length) return;
    const text = hexDecoder.decode(Uint8Array.from(hexBytes));
    hexBytes = [];
    if (text) pushText(text);
  };

  const pushText = (txt) => {
    const st = stack[stack.length - 1];
    if (!st || st.skip || !txt) return;
    const prev = currentRuns[currentRuns.length - 1];
    if (prev && prev.b === st.b && prev.i === st.i && prev.u === st.u) {
      prev.text += txt;
    } else {
      currentRuns.push({ text: txt, b: st.b, i: st.i, u: st.u });
    }
  };

  const commitParagraph = () => {
    flushHex();
    if (currentRuns.length) {
      paragraphs.push(currentRuns);
      currentRuns = [];
    }
  };

  let idx = 0;
  const len = src.length;
  while (idx < len) {
    const ch = src[idx];
    const st = stack[stack.length - 1];

    if (ch === '{') {
      flushHex();
      stack.push({ ...st });
      idx++;
      continue;
    }
    if (ch === '}') {
      flushHex();
      if (stack.length > 1) stack.pop();
      idx++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      idx++;
      continue;
    }
    if (ch !== '\\') {
      flushHex();
      pushText(ch);
      idx++;
      continue;
    }

    // Backslash escape
    idx++;
    if (idx >= len) break;
    const next = src[idx];

    if (next === "'" && idx + 2 < len) {
      const hex = src.slice(idx + 1, idx + 3);
      const byteVal = parseInt(hex, 16);
      if (Number.isFinite(byteVal)) hexBytes.push(byteVal);
      idx += 3;
      continue;
    }

    flushHex();

    if (next === '*' ) {
      st.skip = true;
      idx++;
      continue;
    }
    if (next === '\\' || next === '{' || next === '}') {
      pushText(next);
      idx++;
      continue;
    }
    if (next === '~') {
      pushText('\u00A0');
      idx++;
      continue;
    }
    if (next === '-' || next === '_') {
      pushText('-');
      idx++;
      continue;
    }
    if (next === '\r' || next === '\n') {
      commitParagraph();
      idx++;
      continue;
    }

    // Control word: letters + optional signed integer + optional single space delimiter
    let wStart = idx;
    while (idx < len && /[a-zA-Z]/.test(src[idx])) idx++;
    const word = src.slice(wStart, idx);
    let paramStr = '';
    if (idx < len && (src[idx] === '-' || /[0-9]/.test(src[idx]))) {
      const pStart = idx;
      if (src[idx] === '-') idx++;
      while (idx < len && /[0-9]/.test(src[idx])) idx++;
      paramStr = src.slice(pStart, idx);
    }
    if (idx < len && src[idx] === ' ') idx++;

    if (!word) {
      idx++;
      continue;
    }

    const param = paramStr !== '' ? Number(paramStr) : null;
    if (RTF_SKIP_DESTS.has(word)) {
      st.skip = true;
      continue;
    }
    if (st.skip) continue;

    if (word === 'par' || word === 'line' || word === 'row') {
      commitParagraph();
    } else if (word === 'cell') {
      pushText('  |  ');
    } else if (word === 'tab') {
      pushText('\t');
    } else if (word === 'b') {
      st.b = param !== 0;
    } else if (word === 'i') {
      st.i = param !== 0;
    } else if (word === 'ul') {
      st.u = param !== 0;
    } else if (word === 'ulnone') {
      st.u = false;
    } else if (word === 'plain') {
      st.b = false;
      st.i = false;
      st.u = false;
    } else if (word === 'uc' && param !== null && param >= 0) {
      st.uc = param;
    } else if (word === 'u' && param !== null) {
      const cp = param < 0 ? param + 65536 : param;
      if (cp > 0 && cp <= 0x10ffff) {
        try { pushText(String.fromCodePoint(cp)); } catch {}
      }
      // Skip `st.uc` replacement fallback characters (either \'xx or literal chars)
      let skipped = 0;
      while (skipped < st.uc && idx < len) {
        if (src[idx] === '\\' && src[idx + 1] === "'" && idx + 3 < len) {
          idx += 4;
        } else if (src[idx] === '{' || src[idx] === '}') {
          break;
        } else {
          idx++;
        }
        skipped++;
      }
    }
  }
  commitParagraph();

  const plainLines = [];
  const htmlParas = [];
  for (const runs of paragraphs) {
    const plain = runs.map((r) => r.text).join('').trim();
    if (!plain) continue;
    plainLines.push(plain);
    const inner = runs
      .map((r) => {
        let h = escapeHtml(r.text).replace(/\t/g, '<span class="aw-doc-tab">&emsp;</span>');
        if (r.b) h = `<strong>${h}</strong>`;
        if (r.i) h = `<em>${h}</em>`;
        if (r.u) h = `<u>${h}</u>`;
        return h;
      })
      .join('');
    htmlParas.push(`<p class="aw-doc-p">${inner}</p>`);
  }

  return {
    codepage,
    plainLines,
    html: htmlParas.join('\n') || '<p class="aw-doc-empty-msg">RTF 文档无可读正文。</p>',
  };
}

function parseRtf(buf, filePath, stat) {
  const res = parseRtfToTextAndHtml(buf);
  const plainText = res.plainLines.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS);
  return {
    ok: true,
    format: 'rtf',
    formatLabel: 'RTF 富文本',
    badge: 'RTF',
    path: filePath,
    title: path.basename(filePath),
    ext: 'rtf',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: true,
    meta: { statsLabel: `约 ${plainText.replace(/\s+/g, '').length.toLocaleString('en-US')} 字 · ${res.codepage.toUpperCase()}` },
    outline: [],
    bodyHtml: res.html,
    plainText,
    snippetLines: res.plainLines.slice(0, 14),
    warnings: [],
  };
}

// ── 7. EPUB E-Book Renderer ─────────────────────────────────────────────────

const SAFE_XHTML_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'article', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sup', 'sub', 'code', 'pre', 'hr', 'br',
  'figure', 'figcaption', 'span', 'small', 'mark', 'a', 'img',
]);

function sanitizeXhtmlNode(node, baseZipPath, media, plainOut) {
  if (!node) return '';
  if (node.text !== undefined) {
    const t = node.text;
    if (plainOut && t.trim()) plainOut.push(t.trim());
    return escapeHtml(t);
  }
  const tag = String(node.local || '').toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'head') {
    return '';
  }
  if (tag === 'br') return '<br/>';
  if (tag === 'hr') return '<hr/>';
  if (tag === 'img' || tag === 'image') {
    const src = getAttr(node, 'src') || getAttr(node, 'href');
    if (src && media && baseZipPath) {
      const resolved = resolveZipRelPath(baseZipPath, src);
      const loaded = media.loadImageDataUrl(resolved);
      if (loaded.ok) {
        const alt = getAttr(node, 'alt') || '插图';
        return `<figure class="aw-doc-figure"><img src="${loaded.dataUrl}" alt="${escapeHtml(alt)}" loading="lazy" /></figure>`;
      }
    }
    return '';
  }

  const childrenHtml = (node.children || []).map((c) => sanitizeXhtmlNode(c, baseZipPath, media, plainOut)).join('');
  if (!SAFE_XHTML_TAGS.has(tag)) return childrenHtml;

  if (tag === 'a') {
    const href = sanitizeHref(getAttr(node, 'href'));
    if (!href) return childrenHtml;
    const ext = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a class="aw-doc-link" href="${escapeHtml(href)}"${ext}>${childrenHtml}</a>`;
  }
  if (tag === 'table') {
    return `<div class="aw-doc-table-wrap"><table class="aw-doc-table">${childrenHtml}</table></div>`;
  }
  return `<${tag}>${childrenHtml}</${tag}>`;
}

function parseEpub(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const containerXml = zip.getEntryText('META-INF/container.xml');
  if (!containerXml) throw new Error('EPUB 文件缺少 META-INF/container.xml');
  const cRoot = parseXml(containerXml);
  const rootfile = findAll(cRoot, 'rootfile')[0];
  const opfPath = normalizeZipPath(getAttr(rootfile, 'full-path'));
  const opfXml = opfPath ? zip.getEntryText(opfPath) : '';
  if (!opfXml) throw new Error('EPUB 文件缺少 OPF 元数据清单');

  const opfRoot = parseXml(opfXml);
  const bookTitle = collectText(findAll(opfRoot, 'title')[0]).trim() || path.basename(filePath);
  const author = collectText(findAll(opfRoot, 'creator')[0]).trim();
  const manifest = new Map();
  for (const item of findAll(opfRoot, 'item')) {
    const id = getAttr(item, 'id');
    const href = getAttr(item, 'href');
    const mt = getAttr(item, 'media-type');
    if (id && href) manifest.set(id, { href: resolveZipRelPath(opfPath, href), mediaType: mt });
  }

  const spineIds = findAll(opfRoot, 'itemref').map((ir) => getAttr(ir, 'idref')).filter(Boolean);
  const media = createMediaLoader(zip, { snippetOnly });
  const sections = [];
  const outline = [];
  const plainChunks = [];
  const snippetLines = [];
  const maxChapters = snippetOnly ? 2 : 60;

  for (let i = 0; i < spineIds.length && sections.length < maxChapters; i++) {
    const item = manifest.get(spineIds[i]);
    if (!item || !/html|xml/i.test(item.mediaType || item.href)) continue;
    const xhtml = zip.getEntryText(item.href);
    if (!xhtml) continue;
    const xRoot = parseXml(xhtml);
    const body = findAll(xRoot, 'body')[0] || xRoot;
    const chapPlain = [];
    const chapHtml = sanitizeXhtmlNode(body, item.href, media, chapPlain);
    const textJoined = chapPlain.join('\n').trim();
    if (!textJoined && !chapHtml.includes('<img')) continue;

    const firstHeading = collectText(findAll(body, 'h1')[0] || findAll(body, 'h2')[0] || findAll(body, 'h3')[0]).trim();
    const chapTitle = firstHeading || textJoined.split('\n')[0]?.slice(0, 48) || `第 ${sections.length + 1} 章`;
    const secId = `chap-${sections.length}`;
    outline.push({ id: secId, level: 1, title: chapTitle });
    sections.push({ id: secId, title: chapTitle, html: `<div class="aw-epub-chapter">${chapHtml}</div>` });
    plainChunks.push(`=== ${chapTitle} ===\n${textJoined}`);
    if (snippetLines.length < 12) snippetLines.push(...chapPlain.slice(0, 6));
  }

  return {
    ok: true,
    format: 'epub',
    formatLabel: 'EPUB 电子书',
    badge: 'EPUB',
    path: filePath,
    title: bookTitle,
    ext: 'epub',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: true,
    meta: { title: bookTitle, author, statsLabel: `${spineIds.length} 章节${author ? ` · ${author}` : ''}` },
    outline,
    sections,
    bodyHtml: sections[0]?.html || '<p class="aw-doc-empty-msg">未提取到可读章节。</p>',
    plainText: plainChunks.join('\n\n').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines: snippetLines.slice(0, 14),
    warnings: spineIds.length > maxChapters && !snippetOnly ? [`全书共 ${spineIds.length} 章，当前加载前 ${maxChapters} 章。`] : [],
  };
}

// ── 8. Legacy .doc (Smart Magic-Byte Sniffer + Safe OLE2 Fallback) ──────────

function extractOle2ReadableLines(buf) {
  const lines = [];
  // Scan UTF-16LE readable runs (typical Word 97-2003 Fib Unicode body)
  const utf16Runs = [];
  let cur = '';
  for (let i = 0; i + 1 < buf.length && utf16Runs.length < 600; i += 2) {
    const code = buf.readUInt16LE(i);
    const printable =
      code === 0x000d ||
      code === 0x000a ||
      code === 0x0009 ||
      (code >= 0x0020 && code <= 0x007e) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xff01 && code <= 0xff5e);
    if (printable) {
      cur += code === 0x000d ? '\n' : String.fromCharCode(code);
    } else {
      if (cur.trim().length >= 8) utf16Runs.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim().length >= 8) utf16Runs.push(cur.trim());

  const noiseRe = /^(?:Root Entry|WordDocument|1Table|0Table|SummaryInformation|DocumentSummaryInformation|CompObj|Microsoft|Normal\.dotm?|Times New Roman|Calibri|SimSun|宋体|黑体|Cambria|Heading \d+)$/i;
  for (const run of utf16Runs) {
    for (const ln of run.split(/\r?\n/)) {
      const clean = ln.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
      if (clean.length < 2 || noiseRe.test(clean)) continue;
      // Filter gibberish ASCII noise without CJK or word structure
      const hasCjk = /[\u4e00-\u9fff]/.test(clean);
      const hasWords = /[a-zA-Z]{3,}/.test(clean);
      if (hasCjk || (hasWords && clean.length >= 6)) {
        lines.push(clean);
      }
    }
  }
  return Array.from(new Set(lines)).slice(0, 400);
}

function parseLegacyDoc(buf, filePath, stat, opts = {}) {
  // Magic-byte sniffing: many Chinese .doc downloads are secretly DOCX, RTF, or HTML!
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const asDocx = parseDocx(buf, filePath, stat, opts);
    asDocx.warnings = ['此 .doc 文件实为标准 DOCX 压缩包，已按高清 Word 模式渲染。', ...(asDocx.warnings || [])];
    return asDocx;
  }
  const headStr = buf.subarray(0, Math.min(buf.length, 256)).toString('latin1').trimStart();
  if (headStr.startsWith('{\\rtf')) {
    const asRtf = parseRtf(buf, filePath, stat);
    asRtf.warnings = ['此 .doc 文件实为 RTF 富文本，已自动解析。'];
    return asRtf;
  }
  if (/^(?:<!doctype\s+html|<html|<meta|<table|MIME-Version:)/i.test(headStr)) {
    const decoded = decodeBuffer(buf);
    const root = parseXml(decoded.text);
    const body = findAll(root, 'body')[0] || root;
    const plainOut = [];
    const html = sanitizeXhtmlNode(body, '', null, plainOut);
    return {
      ok: true,
      format: 'doc',
      formatLabel: 'Word 网页版文档',
      badge: 'DOC',
      path: filePath,
      title: path.basename(filePath),
      ext: 'doc',
      sizeBytes: stat.size,
      autoRender: true,
      supportsPaperMode: true,
      meta: { statsLabel: 'HTML 封装 DOC' },
      outline: [],
      bodyHtml: html || '<p class="aw-doc-empty-msg">未提取到正文。</p>',
      plainText: plainOut.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS),
      snippetLines: plainOut.slice(0, 14),
      warnings: ['此 .doc 文件实为 HTML 封装文档，已安全净化渲染。'],
    };
  }

  // True OLE2 binary .doc
  const lines = extractOle2ReadableLines(buf);
  const html = lines.length
    ? lines.map((l) => `<p class="aw-doc-p">${escapeHtml(l)}</p>`).join('\n')
    : '<p class="aw-doc-empty-msg">未能从旧版二进制 .doc 提取可读正文，请点击上方「系统打开」在 Word / WPS 中查看。</p>';
  return {
    ok: true,
    format: 'doc',
    formatLabel: 'Word 97-2003 文档',
    badge: 'DOC',
    path: filePath,
    title: path.basename(filePath),
    ext: 'doc',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: true,
    meta: { statsLabel: `旧版二进制格式 · 已提取 ${lines.length} 段` },
    outline: [],
    bodyHtml: html,
    plainText: lines.join('\n').slice(0, MAX_PLAIN_TEXT_CHARS),
    snippetLines: lines.slice(0, 14),
    warnings: ['旧版二进制 .doc 格式仅支持纯文本提取预览；如需完整排版与图表，请点击「系统打开」或另存为 .docx。'],
  };
}

// ── 9. ZIP Archive Inventory Preview (Zero Extraction!) ─────────────────────

function parseZipListing(buf, filePath, stat, { snippetOnly = false } = {}) {
  const zip = readZipArchive(buf);
  const list = zip.listEntries();
  const files = list.filter((e) => !e.isDirectory);
  const totalUncomp = files.reduce((s, e) => s + (e.uncompressedSize || 0), 0);
  const shown = list.slice(0, snippetOnly ? 12 : 400);

  const rowsHtml = shown
    .map((e) => {
      const icon = e.isDirectory ? '目录' : (path.extname(e.name).slice(1).toUpperCase() || '文件');
      const ratio =
        !e.isDirectory && e.uncompressedSize > 0
          ? `${Math.max(0, Math.round((1 - e.compressedSize / e.uncompressedSize) * 100))}%`
          : '—';
      return `<tr><td><span class="aw-doc-zip-tag">${escapeHtml(icon)}</span> ${escapeHtml(e.name)}${e.encrypted ? ' <span class="aw-doc-muted">[加密]</span>' : ''}</td><td class="aw-sheet-num">${e.isDirectory ? '—' : formatBytesShort(e.uncompressedSize)}</td><td class="aw-sheet-num">${ratio}</td></tr>`;
    })
    .join('');

  const html = `<div class="aw-doc-table-wrap"><table class="aw-doc-table"><thead><tr><th>压缩包内路径</th><th style="width:100px">原始大小</th><th style="width:80px">压缩率</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
  const snippetLines = shown.map((e) => `${e.isDirectory ? '[目录]' : ''} ${e.name} (${formatBytesShort(e.uncompressedSize)})`.trim());

  return {
    ok: true,
    format: 'zip',
    formatLabel: 'ZIP 压缩包',
    badge: 'ZIP',
    path: filePath,
    title: path.basename(filePath),
    ext: 'zip',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: { statsLabel: `${files.length} 个文件 · 解压后约 ${formatBytesShort(totalUncomp)}` },
    outline: [],
    bodyHtml: html,
    plainText: snippetLines.join('\n'),
    snippetLines: snippetLines.slice(0, 14),
    warnings: list.length > shown.length && !snippetOnly ? [`压缩包共 ${list.length} 项，当前展示前 ${shown.length} 项。`] : [],
  };
}

// ── 10. PDF Lightweight Metadata Inspector (Hover Preview + Mode 2 Embed) ───

function parsePdfMeta(buf, filePath, stat) {
  const sample = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString('latin1');
  const pageMatches = sample.match(/\/Type\s*\/Page\b(?!s)/g);
  const countMatch = /\/Type\s*\/Pages[\s\S]{0,160}?\/Count\s+(\d+)/.exec(sample);
  const pageCount = countMatch ? Number(countMatch[1]) : (pageMatches ? pageMatches.length : 0);
  const titleMatch = /\/Title\s*\(([^)]{1,120})\)/.exec(sample);
  const pdfTitle = titleMatch ? titleMatch[1].replace(/\\([()\\])/g, '$1').trim() : '';

  const statsLabel = pageCount > 0 ? `约 ${pageCount} 页 · ${formatBytesShort(stat.size)}` : formatBytesShort(stat.size);
  return {
    ok: true,
    format: 'pdf',
    formatLabel: 'PDF 文档',
    badge: 'PDF',
    path: filePath,
    title: pdfTitle || path.basename(filePath),
    ext: 'pdf',
    sizeBytes: stat.size,
    autoRender: false,
    supportsPaperMode: false,
    mode2Only: true,
    meta: { title: pdfTitle, pageCount, statsLabel },
    outline: [],
    bodyHtml: '',
    plainText: '',
    snippetLines: [
      `PDF 文档 · ${path.basename(filePath)}`,
      pageCount > 0 ? `页数：约 ${pageCount} 页` : '',
      `大小：${formatBytesShort(stat.size)}`,
    ].filter(Boolean),
    warnings: [],
  };
}

// ── Main Cached Document Service ────────────────────────────────────────────

const docRenderCache = new Map();

function getCachedDoc(cacheKey) {
  if (!docRenderCache.has(cacheKey)) return null;
  const val = docRenderCache.get(cacheKey);
  docRenderCache.delete(cacheKey);
  docRenderCache.set(cacheKey, val);
  return val;
}

function setCachedDoc(cacheKey, val) {
  if (docRenderCache.has(cacheKey)) docRenderCache.delete(cacheKey);
  docRenderCache.set(cacheKey, val);
  if (docRenderCache.size > MAX_DOC_CACHE_ITEMS) {
    const oldest = docRenderCache.keys().next().value;
    if (oldest) docRenderCache.delete(oldest);
  }
}

export function clearDocumentCache() {
  docRenderCache.clear();
}

export function renderDocument(rawPath, { snippetOnly = false } = {}) {
  const safe = resolveSafeReadPath(rawPath);
  if (!safe.ok) return { ok: false, error: safe.error };

  const { filePath, key, stat } = safe;
  const meta = getSupportedDocumentMeta(filePath);
  if (!meta) {
    return { ok: false, unsupported: true, error: `暂不支持该文件格式：${path.extname(filePath) || '未知'}` };
  }
  if (stat.size > MAX_DOC_FILE_BYTES) {
    return {
      ok: false,
      tooLarge: true,
      error: `文件体积 ${formatBytesShort(stat.size)} 超过侧边栏直览上限（${formatBytesShort(MAX_DOC_FILE_BYTES)}），建议点击「系统打开」查看。`,
    };
  }

  const cacheKey = `${key}|${stat.mtimeMs}|${stat.size}|${snippetOnly ? 'snip' : 'full'}`;
  const hit = getCachedDoc(cacheKey);
  if (hit) return hit;

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  try {
    let result;
    switch (meta.format) {
      case 'docx':
        result = parseDocx(buf, filePath, stat, { snippetOnly });
        break;
      case 'xlsx':
        result = parseXlsx(buf, filePath, stat, { snippetOnly });
        break;
      case 'pptx':
        result = parsePptx(buf, filePath, stat, { snippetOnly });
        break;
      case 'csv':
        result = parseCsvTsv(buf, filePath, stat, false, { snippetOnly });
        break;
      case 'tsv':
        result = parseCsvTsv(buf, filePath, stat, true, { snippetOnly });
        break;
      case 'odt':
        result = parseOdt(buf, filePath, stat, { snippetOnly });
        break;
      case 'ods':
        result = parseOds(buf, filePath, stat, { snippetOnly });
        break;
      case 'odp':
        result = parseOdp(buf, filePath, stat, { snippetOnly });
        break;
      case 'rtf':
        result = parseRtf(buf, filePath, stat);
        break;
      case 'epub':
        result = parseEpub(buf, filePath, stat, { snippetOnly });
        break;
      case 'doc':
        result = parseLegacyDoc(buf, filePath, stat, { snippetOnly });
        break;
      case 'zip':
        result = parseZipListing(buf, filePath, stat, { snippetOnly });
        break;
      case 'pdf':
        result = parsePdfMeta(buf, filePath, stat);
        break;
      default:
        return { ok: false, unsupported: true, error: `Unsupported format: ${meta.format}` };
    }
    setCachedDoc(cacheKey, result);
    return result;
  } catch (err) {
    return {
      ok: false,
      format: meta.format,
      formatLabel: meta.label,
      path: filePath,
      error: `解析 ${meta.badge} 失败：${err?.message || err}`,
    };
  }
}

const SAFE_EXTERNAL_OPEN_EXTS = new Set([
  '.docx', '.doc', '.xlsx', '.xlsm', '.xls', '.pptx', '.ppt',
  '.odt', '.ods', '.odp', '.rtf', '.epub', '.pdf', '.csv', '.tsv',
  '.txt', '.md', '.mdx', '.zip',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
  '.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.m4a',
]);

/**
 * Safely opens a local document/media file in the OS default application.
 * Blocks UNC paths, sensitive credentials, and any executable/script extensions.
 */
export function openExternalDocument(rawPath, { dryRun = false } = {}) {
  const safe = resolveSafeReadPath(rawPath);
  if (!safe.ok) return { ok: false, error: safe.error };
  const ext = path.extname(safe.filePath).toLowerCase();
  if (!SAFE_EXTERNAL_OPEN_EXTS.has(ext)) {
    return { ok: false, error: `出于安全限制，不允许外部启动该扩展名：${ext || '无扩展名'}` };
  }
  if (dryRun) {
    return { ok: true, path: safe.filePath, ext, dryRun: true };
  }
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $env:AW_OPEN_PATH'],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, AW_OPEN_PATH: safe.filePath },
        }
      );
    } else if (process.platform === 'darwin') {
      child = spawn('open', [safe.filePath], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [safe.filePath], { detached: true, stdio: 'ignore' });
    }
    child.unref();
    return { ok: true, path: safe.filePath, ext };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
