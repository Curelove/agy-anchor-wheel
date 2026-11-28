import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeBuffer } from './encoding.mjs';
import { canonicalKey, isHostProtectedWritePath, isSensitiveFilePath, normalizeFilePath, resolveSafeReadPath, resolveSafeWritePath } from './security.mjs';

export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_LEDGER_RECORDS = 60;
const MAX_DIFF_CHARS = 12000;

export const EDITABLE_TEXT_EXT_SET = new Set([
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
  'txt', 'md', 'mdx', 'markdown',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties',
  'csv', 'tsv', 'xml', 'svg', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'vue', 'svelte', 'astro',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'sql', 'graphql', 'prisma', 'proto',
  'srt', 'ass', 'ssa', 'vtt', 'lrc', 'log', 'gitignore', 'gitattributes', 'editorconfig',
]);

const EDITABLE_BASENAME_SET = new Set([
  'license', 'makefile', 'dockerfile', 'procfile', 'readme', 'changelog',
]);

export function isEditablePathCandidate(rawPath) {
  const norm = normalizeFilePath(rawPath);
  if (!norm) return false;
  if (isSensitiveFilePath(norm) || isHostProtectedWritePath(norm)) return false;
  const base = path.basename(norm);
  const lowBase = base.toLowerCase();
  if (EDITABLE_BASENAME_SET.has(lowBase)) return true;
  const dot = lowBase.lastIndexOf('.');
  if (dot <= 0 && !lowBase.startsWith('.')) return false;
  const ext = lowBase.slice(dot + 1);
  return EDITABLE_TEXT_EXT_SET.has(ext);
}

export function detectSyntaxKind(filePath) {
  const ext = path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  return ext || 'text';
}

function offsetToLineCol(text, offset) {
  const safeOff = Math.max(0, Math.min(text.length, Number(offset) || 0));
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < safeOff; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: safeOff - lastNl };
}

export function validateEditableSyntax(filePath, content) {
  const kind = detectSyntaxKind(filePath);
  const str = String(content ?? '');
  if (kind === 'json') {
    if (!str.trim()) {
      return {
        valid: false,
        kind: 'json',
        line: 1,
        column: 1,
        message: 'JSON 内容为空，补充完整对象或数组后自动保存',
      };
    }
    try {
      JSON.parse(str);
      return { valid: true, kind: 'json' };
    } catch (err) {
      const rawMsg = String(err?.message || '');
      let line = null;
      let column = null;
      const lcMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(rawMsg);
      const posMatch = /position\s+(\d+)/i.exec(rawMsg);
      if (lcMatch) {
        line = Number(lcMatch[1]);
        column = Number(lcMatch[2]);
      } else if (posMatch) {
        const lc = offsetToLineCol(str, Number(posMatch[1]));
        line = lc.line;
        column = lc.column;
      } else if (/unexpected end of json/i.test(rawMsg)) {
        const lc = offsetToLineCol(str, str.length);
        line = lc.line;
        column = lc.column;
      }
      const locText = line ? `（第 ${line} 行附近）` : '';
      return {
        valid: false,
        kind: 'json',
        line,
        column,
        message: `JSON 格式尚未闭合${locText}，补全括号、引号或逗号后自动保存`,
      };
    }
  }

  if (kind === 'jsonl') {
    const lines = str.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      try {
        JSON.parse(ln);
      } catch {
        return {
          valid: false,
          kind: 'jsonl',
          line: i + 1,
          column: 1,
          message: `第 ${i + 1} 行 JSON 尚未闭合，补全后自动保存`,
        };
      }
    }
    return { valid: true, kind: 'jsonl' };
  }

  return { valid: true, kind };
}

function detectDominantLineEnding(rawBuffer, filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'crlf';
  const str = Buffer.isBuffer(rawBuffer) ? rawBuffer.toString('latin1', 0, Math.min(rawBuffer.length, 65536)) : String(rawBuffer || '');
  let crlf = 0;
  let bareLf = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) {
      if (i > 0 && str.charCodeAt(i - 1) === 13) crlf++;
      else bareLf++;
    }
  }
  if (crlf === 0 && bareLf === 0) {
    return process.platform === 'win32' && (ext === '.ps1' || ext === '.ini') ? 'crlf' : 'lf';
  }
  return crlf >= bareLf ? 'crlf' : 'lf';
}

function normalizeToLf(str) {
  return String(str ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Fast, zero-dependency line-level unified diff with 2-line context & bounded size.
 */
export function computeCompactUnifiedDiff(beforeText, afterText, contextLines = 2) {
  const a = normalizeToLf(beforeText).split('\n');
  const b = normalizeToLf(afterText).split('\n');

  if (a.length === b.length && a.every((v, idx) => v === b[idx])) {
    return { changed: false, addedLines: 0, removedLines: 0, diffText: '', summary: '无改动' };
  }

  // Trim identical prefix & suffix first so large files diff in sub-millisecond time
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  // Bounded LCS on middle window; fallback to clean block replacement when window is huge
  let ops = [];
  if (midA.length * midB.length <= 160000) {
    const n = midA.length;
    const m = midB.length;
    const dp = new Int32Array((n + 1) * (m + 1));
    const stride = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * stride + j];
          const right = dp[i * stride + (j + 1)];
          dp[i * stride + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'equal', lineA: prefix + i + 1, lineB: prefix + j + 1, text: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        ops.push({ type: 'del', lineA: prefix + i + 1, text: midA[i] });
        i++;
      } else {
        ops.push({ type: 'add', lineB: prefix + j + 1, text: midB[j] });
        j++;
      }
    }
    while (i < n) {
      ops.push({ type: 'del', lineA: prefix + i + 1, text: midA[i++] });
    }
    while (j < m) {
      ops.push({ type: 'add', lineB: prefix + j + 1, text: midB[j++] });
    }
  } else {
    for (let i = 0; i < midA.length; i++) ops.push({ type: 'del', lineA: prefix + i + 1, text: midA[i] });
    for (let j = 0; j < midB.length; j++) ops.push({ type: 'add', lineB: prefix + j + 1, text: midB[j] });
  }

  let addedLines = 0;
  let removedLines = 0;
  for (const op of ops) {
    if (op.type === 'add') addedLines++;
    else if (op.type === 'del') removedLines++;
  }

  // Prepend/append up to `contextLines` from prefix/suffix for clear hunk context
  const leadStart = Math.max(0, prefix - contextLines);
  const leadOps = [];
  for (let k = leadStart; k < prefix; k++) {
    leadOps.push({ type: 'equal', lineA: k + 1, lineB: k + 1, text: a[k] });
  }
  const tailOps = [];
  const tailStartA = a.length - suffix;
  const tailStartB = b.length - suffix;
  const tailCount = Math.min(suffix, contextLines);
  for (let k = 0; k < tailCount; k++) {
    tailOps.push({ type: 'equal', lineA: tailStartA + k + 1, lineB: tailStartB + k + 1, text: a[tailStartA + k] });
  }

  const allOps = [...leadOps, ...ops, ...tailOps];
  // Group into hunks separated by > contextLines * 2 equal lines
  const hunks = [];
  let curHunk = null;
  for (let idx = 0; idx < allOps.length; idx++) {
    const op = allOps[idx];
    if (op.type !== 'equal') {
      if (!curHunk) {
        const ctxBefore = allOps.slice(Math.max(0, idx - contextLines), idx).filter((x) => x.type === 'equal');
        curHunk = [...ctxBefore, op];
      } else {
        curHunk.push(op);
      }
    } else if (curHunk) {
      // Check if another change appears within contextLines * 2
      let hasNearChange = false;
      for (let look = idx + 1; look <= Math.min(allOps.length - 1, idx + contextLines * 2); look++) {
        if (allOps[look].type !== 'equal') {
          hasNearChange = true;
          break;
        }
      }
      if (hasNearChange) {
        curHunk.push(op);
      } else {
        const ctxAfter = allOps.slice(idx, Math.min(allOps.length, idx + contextLines)).filter((x) => x.type === 'equal');
        curHunk.push(...ctxAfter);
        hunks.push(curHunk);
        curHunk = null;
        idx += Math.max(0, ctxAfter.length - 1);
      }
    }
  }
  if (curHunk) hunks.push(curHunk);

  const outLines = [];
  for (const hunk of hunks) {
    const firstA = hunk.find((x) => x.lineA !== undefined)?.lineA ?? prefix + 1;
    const firstB = hunk.find((x) => x.lineB !== undefined)?.lineB ?? prefix + 1;
    const countA = hunk.filter((x) => x.type !== 'add').length;
    const countB = hunk.filter((x) => x.type !== 'del').length;
    outLines.push(`@@ -${firstA},${countA} +${firstB},${countB} @@`);
    for (const item of hunk) {
      const prefixChar = item.type === 'add' ? '+' : item.type === 'del' ? '-' : ' ';
      outLines.push(`${prefixChar}${item.text}`);
    }
  }

  let diffText = outLines.join('\n');
  if (diffText.length > MAX_DIFF_CHARS) {
    diffText = diffText.slice(0, MAX_DIFF_CHARS) + '\n... (后续差异已省略)';
  }

  return {
    changed: true,
    addedLines,
    removedLines,
    firstChangedLine: prefix + 1,
    diffText,
    summary: `+${addedLines} / -${removedLines} 行`,
  };
}

function encodeTextForWrite(textWithLineEndings, originalEncoding, hasBom) {
  if (originalEncoding === 'utf-16le') {
    const contentBuf = Buffer.from(textWithLineEndings, 'utf16le');
    if (hasBom) {
      return {
        buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), contentBuf]),
        encodingWritten: 'utf-16le',
        convertedToUtf8: false,
      };
    }
    return { buffer: contentBuf, encodingWritten: 'utf-16le', convertedToUtf8: false };
  }
  const utf8Buf = Buffer.from(textWithLineEndings, 'utf8');
  if (originalEncoding === 'utf-8-bom' || (originalEncoding === 'utf-8' && hasBom)) {
    return {
      buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8Buf]),
      encodingWritten: 'utf-8-bom',
      convertedToUtf8: false,
    };
  }
  const converted = originalEncoding !== 'utf-8' && originalEncoding !== 'utf-8-bom';
  return {
    buffer: utf8Buf,
    encodingWritten: 'utf-8',
    convertedToUtf8: converted,
  };
}

function formatIsoLocal(ts) {
  const d = new Date(ts || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class EditService {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historyDir = path.join(dataDir, 'edit_history');
    this.ledgerPath = path.join(this.historyDir, 'ledger.json');
    this.markdownReportPath = path.join(this.historyDir, 'RECENT_USER_EDITS.md');
    this.sessions = new Map(); // sessionId -> sessionMeta
    this._records = null;
  }

  _loadRecords() {
    if (Array.isArray(this._records)) return this._records;
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'));
        if (Array.isArray(parsed?.records)) {
          this._records = parsed.records;
          return this._records;
        }
      }
    } catch {}
    this._records = [];
    return this._records;
  }

  _persistRecords() {
    const records = this._loadRecords();
    fs.mkdirSync(this.historyDir, { recursive: true });
    const tmpJson = `${this.ledgerPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpJson, JSON.stringify({ updatedAt: Date.now(), records }, null, 2), 'utf8');
    try {
      fs.renameSync(tmpJson, this.ledgerPath);
    } catch {
      fs.writeFileSync(this.ledgerPath, JSON.stringify({ updatedAt: Date.now(), records }, null, 2), 'utf8');
      try { fs.unlinkSync(tmpJson); } catch {}
    }

    // Write clean Markdown report so Antigravity AI agents can read recent user edits directly via read_file
    const recent = records.slice(0, 15);
    const mdLines = [
      '# 锚点轮盘侧边栏 · 用户文档编辑记录',
      '',
      `> 最近更新：${formatIsoLocal(Date.now())}（仅记录用户在侧边栏主动编辑保存的普通文档，自动排除敏感配置）`,
      '',
    ];
    if (!recent.length) {
      mdLines.push('暂无用户编辑记录。');
    } else {
      for (const r of recent) {
        mdLines.push(`## ${r.title || path.basename(r.path)}（${r.summary || '已修改'}）`);
        mdLines.push(`- 文件路径：\`${r.path}\``);
        mdLines.push(`- 保存时间：${formatIsoLocal(r.updatedAt)}（首次打开：${formatIsoLocal(r.startedAt)}）`);
        if (r.firstChangedLine) {
          mdLines.push(`- 起始改动行：第 ${r.firstChangedLine} 行`);
        }
        mdLines.push('');
        mdLines.push('```diff');
        mdLines.push(String(r.diffText || '').trimEnd());
        mdLines.push('```');
        mdLines.push('');
      }
    }
    const mdBody = mdLines.join('\n');
    const tmpMd = `${this.markdownReportPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpMd, mdBody, 'utf8');
    try {
      fs.renameSync(tmpMd, this.markdownReportPath);
    } catch {
      fs.writeFileSync(this.markdownReportPath, mdBody, 'utf8');
      try { fs.unlinkSync(tmpMd); } catch {}
    }
  }

  openForEdit(rawPath) {
    const safe = resolveSafeWritePath(rawPath);
    if (!safe.ok) {
      return { ok: false, error: safe.error };
    }
    if (!isEditablePathCandidate(safe.filePath)) {
      return { ok: false, error: '该文件格式暂不支持在侧边栏直接作为文本编辑' };
    }
    if (safe.stat.size > MAX_EDITABLE_BYTES) {
      return { ok: false, error: '文件体积超过 2 MB，请使用外部编辑器打开' };
    }
    try {
      fs.accessSync(safe.filePath, fs.constants.W_OK);
    } catch {
      return { ok: false, error: '文件当前处于只读状态，无法写入保存' };
    }

    let rawBuf;
    try {
      rawBuf = fs.readFileSync(safe.filePath);
    } catch (err) {
      return { ok: false, error: `读取文件失败：${err?.message || err}` };
    }

    const decoded = decodeBuffer(rawBuf);
    if (decoded.isBinary) {
      return { ok: false, error: '检测到二进制内容，无法作为纯文本编辑' };
    }

    const lineEnding = detectDominantLineEnding(rawBuf, safe.filePath);
    const normalizedText = normalizeToLf(decoded.text);
    const syntax = validateEditableSyntax(safe.filePath, normalizedText);
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    this.sessions.set(sessionId, {
      sessionId,
      filePath: safe.filePath,
      key: safe.key,
      baselineText: normalizedText,
      lastSavedText: normalizedText,
      rawBackupBuffer: decoded.isNonUtf8 && decoded.encoding !== 'utf-16le' ? rawBuf : null,
      originalEncoding: decoded.encoding,
      hasBom: Boolean(decoded.hasBom),
      lineEnding,
      startedAt: now,
      lastSavedMtimeMs: safe.stat.mtimeMs,
    });

    // Bound in-memory sessions map
    if (this.sessions.size > 80) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    return {
      ok: true,
      sessionId,
      path: safe.filePath,
      title: path.basename(safe.filePath),
      ext: path.extname(safe.filePath).replace(/^\./, '').toLowerCase(),
      syntaxKind: syntax.kind,
      syntax,
      encoding: decoded.encoding,
      isNonUtf8: Boolean(decoded.isNonUtf8),
      lineEnding,
      mtimeMs: safe.stat.mtimeMs,
      sizeBytes: safe.stat.size,
      text: normalizedText,
      history: this.getEditHistory({ path: safe.filePath, limit: 12 }).records,
      reportPath: this.markdownReportPath,
    };
  }

  saveEditedFile({
    path: rawPath,
    sessionId = '',
    content = '',
    baseMtimeMs = null,
    forceSave = false,
    forceOverwrite = false,
  } = {}) {
    const safe = resolveSafeWritePath(rawPath);
    if (!safe.ok) return { ok: false, error: safe.error };
    if (!isEditablePathCandidate(safe.filePath)) {
      return { ok: false, error: '该文件格式不支持侧边栏写入' };
    }

    const textLf = normalizeToLf(content);
    if (Buffer.byteLength(textLf, 'utf8') > MAX_EDITABLE_BYTES + 256 * 1024) {
      return { ok: false, error: '编辑内容超过侧边栏安全保存上限（2 MB）' };
    }

    const sess = (sessionId && this.sessions.get(sessionId)) || null;
    const syntax = validateEditableSyntax(safe.filePath, textLf);
    if (!syntax.valid && !forceSave) {
      return {
        ok: false,
        syntaxPaused: true,
        syntax,
        error: syntax.message,
      };
    }

    // Check external / AI concurrent modification before overwriting
    const expectedMtime = Number.isFinite(Number(baseMtimeMs))
      ? Number(baseMtimeMs)
      : sess?.lastSavedMtimeMs ?? null;
    if (!forceOverwrite && expectedMtime !== null && Math.abs(safe.stat.mtimeMs - expectedMtime) > 25) {
      try {
        const currentDiskRaw = fs.readFileSync(safe.filePath);
        const currentDiskLf = normalizeToLf(decodeBuffer(currentDiskRaw).text);
        const knownText = sess ? sess.lastSavedText : null;
        if (knownText === null || currentDiskLf !== knownText) {
          return {
            ok: false,
            conflict: true,
            diskMtimeMs: safe.stat.mtimeMs,
            error: '该文件刚刚被 AI 或外部程序更新，请先选择重新加载或覆盖保存',
          };
        }
      } catch {}
    }

    let baselineText = sess?.baselineText;
    let originalEncoding = sess?.originalEncoding || 'utf-8';
    let hasBom = Boolean(sess?.hasBom);
    let lineEnding = sess?.lineEnding || detectDominantLineEnding('', safe.filePath);
    let rawBackupBuffer = sess?.rawBackupBuffer || null;

    if (!sess) {
      try {
        const prevBuf = fs.readFileSync(safe.filePath);
        const prevDec = decodeBuffer(prevBuf);
        if (!prevDec.isBinary) {
          baselineText = normalizeToLf(prevDec.text);
          originalEncoding = prevDec.encoding;
          hasBom = Boolean(prevDec.hasBom);
          lineEnding = detectDominantLineEnding(prevBuf, safe.filePath);
          if (prevDec.isNonUtf8 && prevDec.encoding !== 'utf-16le') {
            rawBackupBuffer = prevBuf;
          }
        }
      } catch {}
    }

    if (rawBackupBuffer) {
      const bakPath = `${safe.filePath}.bak.encoding`;
      try {
        if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, rawBackupBuffer);
      } catch {}
    }

    const finalString = lineEnding === 'crlf' ? textLf.replace(/\n/g, '\r\n') : textLf;
    const encoded = encodeTextForWrite(finalString, originalEncoding, hasBom);

    const dir = path.dirname(safe.filePath);
    const base = path.basename(safe.filePath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmpPath, encoded.buffer);
      try {
        fs.renameSync(tmpPath, safe.filePath);
      } catch {
        fs.writeFileSync(safe.filePath, encoded.buffer);
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return { ok: false, error: `写入保存失败：${err?.message || err}` };
    }

    const newStat = fs.statSync(safe.filePath);
    const now = Date.now();
    const effectiveSessionId = sess?.sessionId || sessionId || `adhoc_${now}`;

    if (sess) {
      sess.lastSavedText = textLf;
      sess.lastSavedMtimeMs = newStat.mtimeMs;
      if (encoded.convertedToUtf8) {
        sess.originalEncoding = 'utf-8';
        sess.hasBom = false;
        sess.rawBackupBuffer = null;
      }
    }

    let latestRecord = null;
    if (typeof baselineText === 'string') {
      const diff = computeCompactUnifiedDiff(baselineText, textLf);
      const records = this._loadRecords();
      const existingIdx = records.findIndex((r) => r.sessionId === effectiveSessionId);
      if (diff.changed) {
        latestRecord = {
          id: existingIdx >= 0 ? records[existingIdx].id : `ed_${crypto.randomBytes(6).toString('hex')}`,
          sessionId: effectiveSessionId,
          path: safe.filePath,
          key: safe.key,
          title: base,
          startedAt: sess?.startedAt || (existingIdx >= 0 ? records[existingIdx].startedAt : now),
          updatedAt: now,
          addedLines: diff.addedLines,
          removedLines: diff.removedLines,
          firstChangedLine: diff.firstChangedLine || 1,
          summary: diff.summary,
          diffText: diff.diffText,
        };
        if (existingIdx >= 0) records.splice(existingIdx, 1);
        records.unshift(latestRecord);
        if (records.length > MAX_LEDGER_RECORDS) {
          records.length = MAX_LEDGER_RECORDS;
        }
        try { this._persistRecords(); } catch {}
      } else if (existingIdx >= 0) {
        // User reverted edits back to initial state -> clean up no-op record
        records.splice(existingIdx, 1);
        try { this._persistRecords(); } catch {}
      }
    }

    return {
      ok: true,
      path: safe.filePath,
      mtimeMs: newStat.mtimeMs,
      sizeBytes: newStat.size,
      savedAt: now,
      encodingWritten: encoded.encodingWritten,
      convertedToUtf8: encoded.convertedToUtf8,
      syntax,
      latestRecord,
      history: this.getEditHistory({ path: safe.filePath, limit: 12 }).records,
      reportPath: this.markdownReportPath,
    };
  }

  getEditHistory({ path: rawPath = '', limit = 20 } = {}) {
    const records = this._loadRecords();
    const maxItems = Math.max(1, Math.min(50, Number(limit) || 20));
    if (!rawPath) {
      return {
        ok: true,
        records: records.slice(0, maxItems),
        reportPath: this.markdownReportPath,
      };
    }
    const check = resolveSafeReadPath(rawPath);
    const targetKey = check.ok ? check.key : canonicalKey(rawPath);
    const filtered = targetKey ? records.filter((r) => r.key === targetKey) : [];
    return {
      ok: true,
      path: check.ok ? check.filePath : normalizeFilePath(rawPath),
      records: filtered.slice(0, maxItems),
      reportPath: this.markdownReportPath,
    };
  }
}
