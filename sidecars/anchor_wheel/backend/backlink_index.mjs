import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeBuffer } from './encoding.mjs';
import { canonicalKey, isSensitiveFilePath, normalizeFilePath, splitPathAndLineRange } from './security.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'backups',
  '.venv',
  'venv',
  '__pycache__',
  '.obsidian',
  '.next',
  'target',
  '.system_generated',
  'scratch',
  'browser_sandbox',
]);

const MAX_MD_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 12000;
const AUTO_RESCAN_COOLDOWN_MS = 60000;
const KNOWN_FILE_EXT_RE =
  /\.(?:md|mdx|txt|log|rst|json|jsonc|yaml|yml|toml|ini|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|lua|sh|bash|ps1|bat|cmd|sql|css|scss|less|html|htm|xml|svg|png|jpg|jpeg|webp|gif|avif|bmp|ico|mp4|webm|mov|mkv|avi|mp3|wav|ogg|flac|m4a|aac|srt|ass|ssa|pdf|csv|tsv|jsonl|docx|xlsx|pptx)$/i;

const MD_LINK_RE = /!?\[([^\]]*)\]\(([^)\r\n]+)\)/g;
const WIKILINK_RE = /\[\[([^\]|\r\n#]+)(?:#([^\]|\r\n]+))?(?:\|([^\]\r\n]+))?\]\]/g;
const INLINE_CODE_RE = /`([^`\r\n]{2,320})`/g;
const BARE_WIN_OR_FILE_RE = /\b(file:\/\/\/[^\s<>"'`\)\]]+|[A-Za-z]:[\\/][^\s<>"'`|?*()\]]+\.[A-Za-z0-9]{1,8}(?:#L\d+(?:-L?\d+)?)?)/g;

function cleanSnippet(lineText) {
  let s = String(lineText || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '[$1]')
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 140);
}

function extractMarkdownTitle(text, fallbackPath) {
  const lines = String(text || '').split(/\r?\n/, 25);
  for (const line of lines) {
    const m = /^\s*#\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) return m[1].replace(/[*_`]/g, '').trim().slice(0, 80);
  }
  return path.basename(fallbackPath || 'Untitled.md');
}

function isRemoteOrAnchorTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (s.startsWith('#')) return true;
  if (/^(?:https?|mailto|tel|data|javascript|blob|customization|sidecar):/i.test(s)) return true;
  return false;
}

function looksLikeLocalFileCandidate(token) {
  const s = String(token || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s || isRemoteOrAnchorTarget(s)) return false;
  if (/\s{2,}|&&|\|\|/.test(s)) return false;
  const { pathPart } = splitPathAndLineRange(s);
  if (/^file:\/\//i.test(pathPart) || /^[A-Za-z]:[\\/]/.test(pathPart)) {
    return KNOWN_FILE_EXT_RE.test(pathPart);
  }
  if ((pathPart.includes('/') || pathPart.includes('\\')) && KNOWN_FILE_EXT_RE.test(pathPart)) {
    return true;
  }
  return KNOWN_FILE_EXT_RE.test(pathPart) && !pathPart.includes(' ');
}

function pathExistsFast(candidatePath, allFilesMap, existsCache) {
  const key = canonicalKey(candidatePath);
  if (allFilesMap && allFilesMap.has(key)) return true;
  if (existsCache && existsCache.has(key)) return existsCache.get(key);
  const ok = fs.existsSync(candidatePath);
  if (existsCache) existsCache.set(key, ok);
  return ok;
}

function resolveCandidateTarget(rawTarget, sourceDir, searchRoots, basenameMap, allFilesMap = null, existsCache = null) {
  let clean = String(rawTarget || '').trim();
  if (clean.startsWith('<') && clean.endsWith('>')) clean = clean.slice(1, -1).trim();
  // Strip optional markdown link title: foo.md "Title"
  const titleMatch = /^([^\s"]+(?:\\ [^\s"]+)*)\s+["'][^"']*["']$/.exec(clean);
  if (titleMatch) clean = titleMatch[1];

  const { pathPart, lineStart, lineEnd } = splitPathAndLineRange(clean);
  let targetPath = normalizeFilePath(pathPart);
  if (!targetPath) return null;

  // Absolute path
  if (path.isAbsolute(targetPath)) {
    const exists = pathExistsFast(targetPath, allFilesMap, existsCache);
    return {
      resolvedPath: targetPath,
      resolvedKey: canonicalKey(targetPath),
      exists,
      lineStart,
      lineEnd,
    };
  }

  // Relative to source markdown directory
  const relCandidate = path.resolve(sourceDir, targetPath);
  if (pathExistsFast(relCandidate, allFilesMap, existsCache)) {
    return {
      resolvedPath: relCandidate,
      resolvedKey: canonicalKey(relCandidate),
      exists: true,
      lineStart,
      lineEnd,
    };
  }

  // Relative to workspace / extra scan roots
  const trimmedRel = targetPath.replace(/^[\\/]+/, '');
  for (const root of searchRoots) {
    if (!root) continue;
    const rootCand = path.resolve(root, trimmedRel);
    if (pathExistsFast(rootCand, allFilesMap, existsCache)) {
      return {
        resolvedPath: rootCand,
        resolvedKey: canonicalKey(rootCand),
        exists: true,
        lineStart,
        lineEnd,
      };
    }
  }

  // Fallback wikilink / basename match
  const baseLower = path.basename(targetPath).toLowerCase();
  if (basenameMap && basenameMap.has(baseLower)) {
    const hit = basenameMap.get(baseLower);
    return {
      resolvedPath: hit,
      resolvedKey: canonicalKey(hit),
      exists: true,
      lineStart,
      lineEnd,
    };
  }
  if (!path.extname(baseLower) && basenameMap && basenameMap.has(`${baseLower}.md`)) {
    const hit = basenameMap.get(`${baseLower}.md`);
    return {
      resolvedPath: hit,
      resolvedKey: canonicalKey(hit),
      exists: true,
      lineStart,
      lineEnd,
    };
  }

  return {
    resolvedPath: relCandidate,
    resolvedKey: canonicalKey(relCandidate),
    exists: false,
    lineStart,
    lineEnd,
  };
}

export class BacklinkIndex {
  constructor(options = {}) {
    this.workspaceRoots = Array.isArray(options.workspaceRoots) ? options.workspaceRoots : [];
    this.extraScanDirs = Array.isArray(options.extraScanDirs) ? options.extraScanDirs : [];
    this.scanWorkspace = options.scanWorkspace !== false;
    this.scanArtifacts = options.scanArtifacts !== false;
    this.brainDir = options.brainDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

    this.fileCache = new Map(); // canonicalKey -> { mtimeMs, size, path, title, isArtifact, convId, rawRefs }
    this.outlinksBySource = new Map(); // canonicalKey -> array
    this.backlinksByTarget = new Map(); // canonicalKey -> array
    this.allFiles = new Map(); // canonicalKey -> { path, name, ext, isArtifact, convId, mtimeMs }
    this.lastScanMs = 0;
    this.scanning = false;
    this.configDirty = false;
    this.scanCapped = false;
    this._bgRescanTimer = null;
  }

  dispose() {
    if (this._bgRescanTimer) {
      clearTimeout(this._bgRescanTimer);
      this._bgRescanTimer = null;
    }
  }

  updateConfig({ workspaceRoots, extraScanDirs, scanWorkspace, scanArtifacts, brainDir } = {}) {
    let changed = false;
    if (Array.isArray(workspaceRoots)) {
      const next = workspaceRoots.map((r) => normalizeFilePath(r)).filter(Boolean);
      if (next.join('|') !== this.workspaceRoots.join('|')) {
        this.workspaceRoots = next;
        changed = true;
      }
    }
    if (Array.isArray(extraScanDirs)) {
      const next = extraScanDirs.map((r) => normalizeFilePath(r)).filter(Boolean);
      if (next.join('|') !== this.extraScanDirs.join('|')) {
        this.extraScanDirs = next;
        changed = true;
      }
    }
    if (typeof scanWorkspace === 'boolean' && scanWorkspace !== this.scanWorkspace) {
      this.scanWorkspace = scanWorkspace;
      changed = true;
    }
    if (typeof scanArtifacts === 'boolean' && scanArtifacts !== this.scanArtifacts) {
      this.scanArtifacts = scanArtifacts;
      changed = true;
    }
    if (typeof brainDir === 'string' && brainDir) {
      const next = normalizeFilePath(brainDir);
      if (next !== this.brainDir) {
        this.brainDir = next;
        changed = true;
      }
    }
    if (changed) this.configDirty = true;
    return changed;
  }

  scheduleBackgroundRescan({ cooldownMs = AUTO_RESCAN_COOLDOWN_MS, force = false } = {}) {
    if (this.lastScanMs === 0) {
      this.rescan({ force: false });
      return;
    }
    const stale = force || this.configDirty || Date.now() - this.lastScanMs > cooldownMs;
    if (!stale || this.scanning || this._bgRescanTimer) return;
    this._bgRescanTimer = setTimeout(() => {
      this._bgRescanTimer = null;
      try {
        this.rescan({ force });
      } catch {}
    }, 15);
    this._bgRescanTimer.unref?.();
  }

  #walkDir(dirPath, { isArtifact = false, convId = '', maxDepth = 8, depth = 0, outFiles = [] } = {}) {
    if (depth > maxDepth || !dirPath || this.allFiles.size >= MAX_SCAN_FILES) {
      if (this.allFiles.size >= MAX_SCAN_FILES) this.scanCapped = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (this.allFiles.size >= MAX_SCAN_FILES) {
        this.scanCapped = true;
        return;
      }
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && ent.name !== '.agents') continue;
      const full = path.join(dirPath, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        this.#walkDir(full, { isArtifact, convId, maxDepth, depth: depth + 1, outFiles });
      } else if (ent.isFile()) {
        if (isSensitiveFilePath(full)) continue;
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        const key = canonicalKey(full);
        const ext = path.extname(ent.name).toLowerCase();
        this.allFiles.set(key, {
          path: full,
          key,
          name: ent.name,
          ext,
          isArtifact,
          convId,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
        if ((ext === '.md' || ext === '.mdx') && st.size <= MAX_MD_BYTES) {
          outFiles.push({ path: full, key, mtimeMs: st.mtimeMs, size: st.size, isArtifact, convId });
        }
      }
    }
  }

  #collectMarkdownTargets() {
    this.allFiles.clear();
    this.scanCapped = false;
    const mdFiles = [];
    const seenKeys = new Set();

    const pushUnique = (item) => {
      if (!seenKeys.has(item.key)) {
        seenKeys.add(item.key);
        mdFiles.push(item);
      }
    };

    const roots = [];
    if (this.scanWorkspace) {
      for (const r of this.workspaceRoots) roots.push(r);
    }
    for (const r of this.extraScanDirs) roots.push(r);

    for (const root of roots) {
      if (!root || !fs.existsSync(root)) continue;
      const batch = [];
      this.#walkDir(root, { isArtifact: false, maxDepth: 8, outFiles: batch });
      batch.forEach(pushUnique);
    }

    if (this.scanArtifacts && this.brainDir && fs.existsSync(this.brainDir)) {
      let convDirs = [];
      try {
        convDirs = fs.readdirSync(this.brainDir, { withFileTypes: true });
      } catch {}
      for (const d of convDirs) {
        if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
        const convPath = path.join(this.brainDir, d.name);
        const batch = [];
        this.#walkDir(convPath, { isArtifact: true, convId: d.name, maxDepth: 3, outFiles: batch });
        batch.forEach(pushUnique);
      }
    }

    return mdFiles;
  }

  #extractRawRefs(text) {
    const refs = [];
    const lines = String(text || '').split(/\r?\n/);
    let inFence = false;
    let fenceChar = '';

    for (let idx = 0; idx < lines.length; idx++) {
      const lineText = lines[idx];
      const lineNum = idx + 1;
      const trimmed = lineText.trim();

      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!inFence) {
          inFence = true;
          fenceChar = marker;
        } else if (marker === fenceChar) {
          inFence = false;
          fenceChar = '';
        }
        continue;
      }
      if (inFence) continue;

      const snippet = cleanSnippet(lineText);
      const seenOnLine = new Set();

      // 1. Standard Markdown links: [label](target)
      MD_LINK_RE.lastIndex = 0;
      let m;
      while ((m = MD_LINK_RE.exec(lineText)) !== null) {
        const label = String(m[1] || '').trim();
        const rawTarget = String(m[2] || '').trim();
        if (isRemoteOrAnchorTarget(rawTarget)) continue;
        const dedup = `${rawTarget}|${lineNum}`;
        if (!seenOnLine.has(dedup)) {
          seenOnLine.add(dedup);
          refs.push({ kind: 'markdown', label, rawTarget, line: lineNum, snippet });
        }
      }

      // 2. Obsidian [[wikilink#heading|alias]]
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(lineText)) !== null) {
        const target = String(m[1] || '').trim();
        const alias = String(m[3] || target).trim();
        if (!target) continue;
        const dedup = `wiki:${target}|${lineNum}`;
        if (!seenOnLine.has(dedup)) {
          seenOnLine.add(dedup);
          refs.push({ kind: 'wikilink', label: alias, rawTarget: target, line: lineNum, snippet });
        }
      }

      // Mask standard Markdown link spans before scanning inline code & bare paths
      // so backticked labels like [`file.md`](../file.md) don't emit duplicate dead entries.
      const strippedLine = lineText.replace(MD_LINK_RE, ' ');

      // 3. Inline code path references `path/to/file.ext`
      INLINE_CODE_RE.lastIndex = 0;
      while ((m = INLINE_CODE_RE.exec(strippedLine)) !== null) {
        const tok = String(m[1] || '').trim();
        if (!looksLikeLocalFileCandidate(tok)) continue;
        const dedup = `${tok}|${lineNum}`;
        if (!seenOnLine.has(dedup)) {
          seenOnLine.add(dedup);
          refs.push({ kind: 'inline_path', label: path.basename(tok), rawTarget: tok, line: lineNum, snippet });
        }
      }

      // 4. Bare file:/// or Windows C:\... paths outside markdown links
      BARE_WIN_OR_FILE_RE.lastIndex = 0;
      while ((m = BARE_WIN_OR_FILE_RE.exec(strippedLine)) !== null) {
        const tok = String(m[1] || '').trim().replace(/[.,;:!?。，；：！？）】》]+$/, '');
        if (!looksLikeLocalFileCandidate(tok)) continue;
        const dedup = `${tok}|${lineNum}`;
        if (!seenOnLine.has(dedup)) {
          seenOnLine.add(dedup);
          refs.push({ kind: 'bare_path', label: path.basename(tok), rawTarget: tok, line: lineNum, snippet });
        }
      }
    }

    return refs;
  }

  #buildBasenameMap() {
    const basenameMap = new Map();
    for (const f of this.allFiles.values()) {
      const lower = f.name.toLowerCase();
      if (!basenameMap.has(lower)) basenameMap.set(lower, f.path);
    }
    return basenameMap;
  }

  #resolveOutlinksForRefs(mdPath, rawRefs, basenameMap, existsCache = null, dirCache = null) {
    const sourceDir = path.dirname(mdPath);
    const searchRoots = [...this.workspaceRoots, ...this.extraScanDirs];
    const outlinks = [];
    const dedupOut = new Set();

    for (const ref of rawRefs) {
      const resolved = resolveCandidateTarget(ref.rawTarget, sourceDir, searchRoots, basenameMap, this.allFiles, existsCache);
      if (!resolved) continue;
      const outKey = `${resolved.resolvedKey}|${ref.line}`;
      if (dedupOut.has(outKey)) continue;
      dedupOut.add(outKey);

      let isDirectory = /[\\/]$/.test(ref.rawTarget || '');
      if (!isDirectory && resolved.exists && !this.allFiles.has(resolved.resolvedKey)) {
        if (dirCache && dirCache.has(resolved.resolvedKey)) {
          isDirectory = dirCache.get(resolved.resolvedKey);
        } else {
          try {
            isDirectory = fs.statSync(resolved.resolvedPath).isDirectory();
          } catch {
            isDirectory = false;
          }
          if (dirCache) dirCache.set(resolved.resolvedKey, isDirectory);
        }
      }

      outlinks.push({
        kind: ref.kind,
        label: ref.label || path.basename(resolved.resolvedPath),
        rawTarget: ref.rawTarget,
        resolvedPath: resolved.resolvedPath,
        resolvedKey: resolved.resolvedKey,
        exists: resolved.exists,
        isDirectory,
        line: ref.line,
        lineStart: resolved.lineStart || ref.line,
        lineEnd: resolved.lineEnd || null,
        snippet: ref.snippet,
      });
    }
    return outlinks;
  }

  rescan({ force = false } = {}) {
    if (this.scanning) return this.getStats();
    this.scanning = true;
    try {
      const mdFiles = this.#collectMarkdownTargets();
      const activeKeys = new Set(mdFiles.map((f) => f.key));

      // Prune deleted files from cache
      for (const cachedKey of Array.from(this.fileCache.keys())) {
        if (!activeKeys.has(cachedKey)) this.fileCache.delete(cachedKey);
      }

      const basenameMap = this.#buildBasenameMap();
      const existsCache = new Map();
      const dirCache = new Map();

      for (const f of mdFiles) {
        const cached = this.fileCache.get(f.key);
        if (!force && cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
          continue;
        }
        let rawBuf;
        try {
          rawBuf = fs.readFileSync(f.path);
        } catch {
          continue;
        }
        const decoded = decodeBuffer(rawBuf);
        if (decoded.isBinary) continue;
        const title = extractMarkdownTitle(decoded.text, f.path);
        const rawRefs = this.#extractRawRefs(decoded.text);
        this.fileCache.set(f.key, {
          mtimeMs: f.mtimeMs,
          size: f.size,
          path: f.path,
          key: f.key,
          title,
          isArtifact: f.isArtifact,
          convId: f.convId,
          rawRefs,
        });
      }

      this.outlinksBySource.clear();
      this.backlinksByTarget.clear();

      for (const entry of this.fileCache.values()) {
        const outlinks = this.#resolveOutlinksForRefs(entry.path, entry.rawRefs, basenameMap, existsCache, dirCache);
        for (const outItem of outlinks) {
          if (!this.backlinksByTarget.has(outItem.resolvedKey)) {
            this.backlinksByTarget.set(outItem.resolvedKey, []);
          }
          this.backlinksByTarget.get(outItem.resolvedKey).push({
            sourcePath: entry.path,
            sourceKey: entry.key,
            sourceTitle: entry.title,
            isArtifact: entry.isArtifact,
            convId: entry.convId,
            line: outItem.line,
            label: outItem.label,
            snippet: outItem.snippet,
          });
        }

        this.outlinksBySource.set(entry.key, outlinks);
      }

      this.lastScanMs = Date.now();
      this.configDirty = false;
      return this.getStats();
    } finally {
      this.scanning = false;
    }
  }

  getStats() {
    let totalBacklinks = 0;
    for (const arr of this.backlinksByTarget.values()) totalBacklinks += arr.length;
    return {
      markdownFiles: this.fileCache.size,
      totalIndexedFiles: this.allFiles.size,
      totalLinks: totalBacklinks,
      lastScanMs: this.lastScanMs,
      scanCapped: this.scanCapped,
      workspaceRoots: [...this.workspaceRoots],
      extraScanDirs: [...this.extraScanDirs],
    };
  }

  getLinksForFile(rawFilePath) {
    const norm = normalizeFilePath(rawFilePath);
    const key = canonicalKey(norm);
    const backlinks = this.backlinksByTarget.get(key) || [];
    let outlinks = this.outlinksBySource.get(key);
    const meta = this.fileCache.get(key);
    let title = meta?.title || path.basename(norm || '');
    const exists = norm ? fs.existsSync(norm) : false;

    // On-demand outlink parsing for Markdown files opened outside workspace/brain roots
    if (!outlinks) {
      outlinks = [];
      if (exists && /\.(?:md|mdx)$/i.test(norm) && !isSensitiveFilePath(norm)) {
        try {
          const st = fs.statSync(norm);
          if (st.isFile() && st.size <= MAX_MD_BYTES) {
            const decoded = decodeBuffer(fs.readFileSync(norm));
            if (!decoded.isBinary) {
              title = extractMarkdownTitle(decoded.text, norm);
              const rawRefs = this.#extractRawRefs(decoded.text);
              outlinks = this.#resolveOutlinksForRefs(norm, rawRefs, this.#buildBasenameMap());
            }
          }
        } catch {}
      }
    }

    const sortedOutlinks = [...outlinks].sort(
      (a, b) => Number(Boolean(b.exists)) - Number(Boolean(a.exists)) || (a.line || 0) - (b.line || 0)
    );

    return {
      path: norm,
      key,
      title,
      exists,
      backlinks: [...backlinks].sort((a, b) => Number(b.isArtifact) - Number(a.isArtifact) || a.sourceTitle.localeCompare(b.sourceTitle)),
      outlinks: sortedOutlinks,
      stats: this.getStats(),
    };
  }

  listFiles({ filter = 'all', query = '', limit = 120 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const items = [];
    for (const f of this.allFiles.values()) {
      const isMd = f.ext === '.md' || f.ext === '.mdx';
      if (filter === 'md' && !isMd) continue;
      if (filter === 'artifact' && !f.isArtifact) continue;
      const meta = this.fileCache.get(f.key);
      const backCount = (this.backlinksByTarget.get(f.key) || []).length;
      const outCount = (this.outlinksBySource.get(f.key) || []).length;
      const title = meta?.title || f.name;
      if (q && !title.toLowerCase().includes(q) && !f.path.toLowerCase().includes(q)) {
        continue;
      }
      items.push({
        path: f.path,
        name: f.name,
        title,
        ext: f.ext,
        isArtifact: f.isArtifact,
        convId: f.convId,
        mtimeMs: f.mtimeMs,
        size: f.size,
        backlinkCount: backCount,
        outlinkCount: outCount,
      });
    }
    items.sort((a, b) => {
      if (a.isArtifact !== b.isArtifact) return a.isArtifact ? -1 : 1;
      if (b.outlinkCount !== a.outlinkCount) return b.outlinkCount - a.outlinkCount;
      return b.mtimeMs - a.mtimeMs;
    });
    return items.slice(0, Math.max(1, Math.min(500, Number(limit) || 120)));
  }
}
