import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSafeReadPath, resolveSafeWritePath } from './security.mjs';

export const SUPPORTED_ENCODINGS = Object.freeze([
  'utf-8',
  'utf-8-bom',
  'gb18030',
  'gbk',
  'utf-16le',
  'utf-16be',
  'shift_jis',
  'big5',
  'windows-1252',
]);

const TEXT_ENCODER_DEC_MAP = Object.freeze({
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  gb18030: 'gb18030',
  gbk: 'gbk',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  shift_jis: 'shift_jis',
  big5: 'big5',
  'windows-1252': 'windows-1252',
});

// High-frequency Chinese characters used to disambiguate GBK/GB18030 vs Big5/Shift_JIS
const COMMON_ZH_RE = /[的了一是在不了有人和这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严]/g;
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/g;
const CJK_RE = /[\u4E00-\u9FFF]/g;
const CJK_PUNCT_RE = /[，。、；：？！“”‘’（）《》【】—…]/g;

function normalizeEncodingName(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (key === 'utf8') return 'utf-8';
  if (key === 'utf8-bom' || key === 'utf-8-bom') return 'utf-8-bom';
  if (key === 'shift-jis' || key === 'sjis' || key === 'shiftjis') return 'shift_jis';
  if (key === 'utf16le' || key === 'utf-16le') return 'utf-16le';
  if (key === 'utf16be' || key === 'utf-16be') return 'utf-16be';
  if (key === 'cp936') return 'gbk';
  if (key === 'cp950') return 'big5';
  if (key === 'latin1' || key === 'cp1252' || key === 'ansi') return 'windows-1252';
  if (TEXT_ENCODER_DEC_MAP[key]) return key;
  return 'utf-8';
}

function detectUtf16NoBom(buf) {
  const sampleLen = Math.min(buf.length, 4096);
  if (sampleLen < 4 || sampleLen % 2 !== 0) return null;
  let evenZero = 0;
  let oddZero = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < sampleLen; i += 2) {
    pairs++;
    if (buf[i] === 0) evenZero++;
    if (buf[i + 1] === 0) oddZero++;
  }
  if (oddZero / pairs > 0.35 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.35 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

function checkMostlyBinary(buf) {
  const sampleLen = Math.min(buf.length, 8192);
  if (sampleLen === 0) return false;
  let controlCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) {
      controlCount++;
    }
  }
  return controlCount / sampleLen > 0.08;
}

function scoreDecodedText(text, enc) {
  let score = 0;
  const repCount = (text.match(/\uFFFD/g) || []).length;
  score -= repCount * 25;

  let badCtrl = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) badCtrl++;
    if (code >= 0xe000 && code <= 0xf8ff) badCtrl += 2; // PUA
  }
  score -= badCtrl * 12;

  const commonZh = (text.match(COMMON_ZH_RE) || []).length;
  const totalCjk = (text.match(CJK_RE) || []).length;
  const kana = (text.match(KANA_RE) || []).length;
  const cjkPunct = (text.match(CJK_PUNCT_RE) || []).length;

  score += commonZh * 5;
  score += cjkPunct * 4;
  score += Math.min(totalCjk, 500) * 1.5;

  if (enc === 'shift_jis') {
    score += kana * 7;
    if (kana === 0 && commonZh > 0) score -= commonZh * 2;
  } else if (enc === 'gb18030' || enc === 'gbk') {
    if (commonZh > 0) score += 8;
    // Penalize stray katakana/hiragana if common Chinese dominates
    if (kana > commonZh && commonZh < 2) score -= 5;
  } else if (enc === 'big5') {
    if (totalCjk > 0 && commonZh > 0) score += 2;
  } else if (enc === 'windows-1252') {
    const latinAccent = (text.match(/[\u00C0-\u024F\u2013-\u2026]/g) || []).length;
    score += latinAccent * 2;
  }

  return { score, repCount, commonZh, totalCjk, kana };
}

export function detectEncoding(rawBuffer) {
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer || '');
  if (buf.length === 0) {
    return { encoding: 'utf-8', confidence: 1, hasBom: false, isBinary: false, hasReplacementChars: false };
  }

  // 1. BOM checks
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8-bom', confidence: 1, hasBom: true, isBinary: false, hasReplacementChars: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe && !(buf.length >= 4 && buf[2] === 0x00 && buf[3] === 0x00)) {
    return { encoding: 'utf-16le', confidence: 0.99, hasBom: true, isBinary: false, hasReplacementChars: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', confidence: 0.99, hasBom: true, isBinary: false, hasReplacementChars: false };
  }

  // 2. Heuristic UTF-16 without BOM
  const utf16Guess = detectUtf16NoBom(buf);
  if (utf16Guess) {
    return { encoding: utf16Guess, confidence: 0.92, hasBom: false, isBinary: false, hasReplacementChars: false };
  }

  // 3. Binary check
  if (checkMostlyBinary(buf)) {
    return { encoding: 'binary', confidence: 0.95, hasBom: false, isBinary: true, hasReplacementChars: false };
  }

  // 4. Strict UTF-8 check
  let hasHighBytes = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) {
      hasHighBytes = true;
      break;
    }
  }
  if (!hasHighBytes) {
    return { encoding: 'utf-8', confidence: 0.98, hasBom: false, isBinary: false, hasReplacementChars: false };
  }

  try {
    const strictText = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    const hasRep = strictText.includes('\uFFFD');
    return {
      encoding: 'utf-8',
      confidence: hasRep ? 0.65 : 0.99,
      hasBom: false,
      isBinary: false,
      hasReplacementChars: hasRep,
    };
  } catch {
    // Invalid UTF-8 byte sequence: rank legacy CJK/Western encodings
  }

  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  const candidates = ['gb18030', 'big5', 'shift_jis', 'windows-1252'];
  let bestEnc = 'gb18030';
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (const enc of candidates) {
    try {
      const dec = new TextDecoder(TEXT_ENCODER_DEC_MAP[enc], { fatal: false });
      const text = dec.decode(sample);
      const res = scoreDecodedText(text, enc);
      if (res.score > bestScore) {
        secondScore = bestScore;
        bestScore = res.score;
        bestEnc = enc;
      } else if (res.score > secondScore) {
        secondScore = res.score;
      }
    } catch {}
  }

  const margin = Math.max(0, bestScore - (Number.isFinite(secondScore) ? secondScore : 0));
  const confidence = Math.min(0.97, Math.max(0.58, 0.72 + margin / 40));
  return {
    encoding: bestEnc,
    confidence: Number(confidence.toFixed(2)),
    hasBom: false,
    isBinary: false,
    hasReplacementChars: false,
  };
}

export function decodeBuffer(rawBuffer, overrideEncoding = '') {
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer || '');
  const detected = detectEncoding(buf);
  const requested = overrideEncoding ? normalizeEncodingName(overrideEncoding) : detected.encoding;

  if (requested === 'binary' || detected.isBinary) {
    return {
      encoding: 'binary',
      detectedEncoding: detected.encoding,
      confidence: detected.confidence,
      hasBom: detected.hasBom,
      isBinary: true,
      isNonUtf8: false,
      mojibakeHint: false,
      sizeBytes: buf.length,
      lineCount: 0,
      text: '',
    };
  }

  let decodeTarget = buf;
  if (requested === 'utf-8-bom' || (requested === 'utf-8' && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) {
    decodeTarget = buf.subarray(3);
  }
  const decName = TEXT_ENCODER_DEC_MAP[requested] || 'utf-8';
  let text = '';
  try {
    text = new TextDecoder(decName, { fatal: false }).decode(decodeTarget);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(decodeTarget);
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);

  const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
  const isNonUtf8 = detected.encoding !== 'utf-8' && detected.encoding !== 'utf-8-bom';
  const mojibakeHint = isNonUtf8 || detected.hasReplacementChars || text.includes('\uFFFD');

  return {
    encoding: requested,
    detectedEncoding: detected.encoding,
    confidence: detected.confidence,
    hasBom: detected.hasBom,
    isBinary: false,
    isNonUtf8,
    mojibakeHint,
    sizeBytes: buf.length,
    lineCount,
    text,
  };
}

export function inspectFileEncoding(rawPath, { maxBytes = 4 * 1024 * 1024, overrideEncoding = '' } = {}) {
  const safe = resolveSafeReadPath(rawPath);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (safe.stat.size > maxBytes) {
    // Still inspect head 256KB for encoding metadata without choking memory
    const fd = fs.openSync(safe.filePath, 'r');
    try {
      const headLen = Math.min(safe.stat.size, 256 * 1024);
      const headBuf = Buffer.allocUnsafe(headLen);
      const bytesRead = fs.readSync(fd, headBuf, 0, headLen, 0);
      const decoded = decodeBuffer(headBuf.subarray(0, bytesRead), overrideEncoding);
      return {
        ok: true,
        path: safe.filePath,
        truncated: true,
        ...decoded,
        sizeBytes: safe.stat.size,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  const buf = fs.readFileSync(safe.filePath);
  const decoded = decodeBuffer(buf, overrideEncoding);
  return {
    ok: true,
    path: safe.filePath,
    truncated: false,
    ...decoded,
  };
}

export function convertFileToUtf8(rawPath, sourceEncoding = '') {
  const safe = resolveSafeWritePath(rawPath);
  if (!safe.ok) return { ok: false, error: safe.error };
  const rawBuf = fs.readFileSync(safe.filePath);
  const decoded = decodeBuffer(rawBuf, sourceEncoding);
  if (decoded.isBinary) {
    return { ok: false, error: 'Cannot convert binary file to UTF-8' };
  }
  if (decoded.encoding === 'utf-8' && !decoded.hasBom) {
    return { ok: true, path: safe.filePath, alreadyUtf8: true, backupPath: '', encoding: 'utf-8' };
  }

  const backupPath = `${safe.filePath}.bak.encoding`;
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, rawBuf);
  }

  const dir = path.dirname(safe.filePath);
  const base = path.basename(safe.filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, decoded.text, 'utf8');
    fs.renameSync(tmpPath, safe.filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    if (process.platform === 'win32') {
      fs.writeFileSync(safe.filePath, decoded.text, 'utf8');
    } else {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  return {
    ok: true,
    path: safe.filePath,
    alreadyUtf8: false,
    previousEncoding: decoded.encoding,
    encoding: 'utf-8',
    backupPath,
  };
}
