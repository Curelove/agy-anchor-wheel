import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalKey,
  isSensitiveFilePath,
  normalizeFilePath,
  resolveSafeDirPath,
  resolveSafeReadPath,
} from './security.mjs';
import { DEFAULT_CATEGORY_RULES, resolveAncestors, sanitizeCategoryRules } from './state_store.mjs';

export const MAX_DIR_FILES = 200;

const NATURAL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const IGNORED_DIR_FILE_RE = /^(?:desktop\.ini|thumbs\.db|\$recycle\.bin|~\$.*)$/i;

function isIgnoredDirEntryName(name) {
  const s = String(name || '');
  if (!s) return true;
  if (s.startsWith('.')) return true;
  if (IGNORED_DIR_FILE_RE.test(s)) return true;
  return false;
}

export function isExistingDirectory(rawPath) {
  if (!rawPath) return false;
  return resolveSafeDirPath(rawPath).ok;
}

/**
 * Reads direct regular files inside a local directory (excluding subfolders, hidden/OS junk, and sensitive files).
 * Sorts by natural filename order (e.g. 01, 02, 10) before capping at `maxFiles` to keep large folders snappy.
 */
export function listDirectoryDirectFiles(rawDirPath, { maxFiles = MAX_DIR_FILES, includeStats = false } = {}) {
  const safe = resolveSafeDirPath(rawDirPath);
  if (!safe.ok) {
    return {
      ok: false,
      error: safe.error,
      dirPath: '',
      key: '',
      title: '',
      files: [],
      totalFiles: 0,
      skippedSubdirCount: 0,
      truncated: false,
      maxFiles,
    };
  }

  let dirents;
  try {
    dirents = fs.readdirSync(safe.dirPath, { withFileTypes: true });
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      dirPath: safe.dirPath,
      key: safe.key,
      title: path.basename(safe.dirPath) || safe.dirPath,
      files: [],
      totalFiles: 0,
      skippedSubdirCount: 0,
      truncated: false,
      maxFiles,
    };
  }

  const validFiles = [];
  let skippedSubdirCount = 0;

  for (const ent of dirents) {
    if (isIgnoredDirEntryName(ent.name)) continue;
    const full = path.join(safe.dirPath, ent.name);
    if (ent.isDirectory()) {
      skippedSubdirCount++;
      continue;
    }
    if (ent.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          skippedSubdirCount++;
          continue;
        }
        if (!st.isFile()) continue;
        if (!resolveSafeReadPath(full).ok) continue;
      } catch {
        continue;
      }
    } else if (!ent.isFile()) {
      continue;
    }
    if (isSensitiveFilePath(full)) continue;
    validFiles.push({ path: full, name: ent.name });
  }

  validFiles.sort((a, b) => NATURAL_COLLATOR.compare(a.name, b.name));

  const safeLimit = Math.max(1, Math.min(500, Math.round(Number(maxFiles) || MAX_DIR_FILES)));
  const totalFiles = validFiles.length;
  const truncated = totalFiles > safeLimit;
  const sliced = validFiles.slice(0, safeLimit);

  if (includeStats) {
    for (const f of sliced) {
      try {
        const st = fs.statSync(f.path);
        f.sizeBytes = st.size;
        f.mtimeMs = st.mtimeMs;
      } catch {
        f.sizeBytes = 0;
        f.mtimeMs = 0;
      }
    }
  }

  return {
    ok: true,
    dirPath: safe.dirPath,
    key: safe.key,
    title: path.basename(safe.dirPath) || safe.dirPath,
    files: sliced,
    totalFiles,
    skippedSubdirCount,
    truncated,
    maxFiles: safeLimit,
  };
}

/**
 * Classifies a file into a user-configured category or the mandatory '其他' fallback.
 */
export function classifyFile(filePath, categoryRules = DEFAULT_CATEGORY_RULES, isDirectory = false) {
  if (isDirectory) {
    return { id: 'other', label: '其他', ext: '' };
  }
  const clean = String(filePath || '').replace(/[\\/]+$/, '');
  const ext = path.extname(clean).replace(/^\./, '').toLowerCase();
  const rules = sanitizeCategoryRules(categoryRules, DEFAULT_CATEGORY_RULES);
  if (ext) {
    for (const rule of rules) {
      if (Array.isArray(rule.extensions) && rule.extensions.includes(ext)) {
        return { id: rule.id, label: rule.label, ext };
      }
    }
  }
  return { id: 'other', label: '其他', ext };
}

function readTitleQuick(filePath) {
  return path.basename(String(filePath || '').replace(/[\\/]+$/, '')) || '未命名';
}

function buildGroupChildLookup(sess) {
  const map = new Map();
  const activeGrp = (sess?.groups || []).find((g) => g.id === sess.activeGroupId) || sess?.groups?.[0] || null;
  for (const g of sess?.groups || []) {
    const aKey = canonicalKey(g.anchorPath || '');
    for (const ch of g.children || []) {
      const k = canonicalKey(ch.path || '');
      if (!k) continue;
      map.set(k, {
        ...ch,
        groupAnchorKey: aKey,
        inActiveGroup: Boolean(activeGrp && activeGrp.id === g.id),
      });
    }
  }
  return { map, activeGrp };
}

/**
 * Builds unified parent-ancestor & categorized-children navigation context for a file.
 * Used identically by Mode 1 (Native CDP), Mode 2 (Workbench), Bilateral Wheel, and AE Tree.
 */
export function buildNavContext({
  stateStore,
  backlinkIndex,
  conversationId = 'default',
  activePath = '',
  activeIsDirectory = false,
  openTabs = [],
  scopeOverride = '',
  maxDirFiles = MAX_DIR_FILES,
}) {
  const settings = stateStore.getSettings();
  const sess = stateStore.getSession(conversationId);
  const rules = sanitizeCategoryRules(settings.categoryRules, DEFAULT_CATEGORY_RULES);

  const requestedScope = scopeOverride || settings.childSourceScope || 'opened_and_outlinks';
  const childSourceScope = requestedScope === 'opened_only' ? 'opened_only' : 'opened_and_outlinks';

  const normActive = normalizeFilePath(activePath);
  const activeKey = normActive ? canonicalKey(normActive) : '';

  const openTabMap = new Map();
  for (const t of Array.isArray(openTabs) ? openTabs : []) {
    const raw = typeof t === 'string' ? t : t?.path || '';
    const p = normalizeFilePath(raw);
    if (!p) continue;
    openTabMap.set(canonicalKey(p), {
      path: p,
      title: (typeof t === 'object' && t?.title) || readTitleQuick(p),
      isDirectory: Boolean(typeof t === 'object' && t?.isDirectory),
    });
  }

  const activeIsDir = Boolean(
    activeIsDirectory ||
      /[\\/]$/.test(String(activePath || '')) ||
      openTabMap.get(activeKey)?.isDirectory ||
      (normActive && isExistingDirectory(normActive))
  );

  const { map: groupChildMap, activeGrp } = buildGroupChildLookup(sess);

  const preferredKeySet = new Set(openTabMap.keys());
  if (activeGrp?.anchorPath) preferredKeySet.add(canonicalKey(activeGrp.anchorPath));
  for (const g of sess.groups || []) {
    if (g.anchorPath) preferredKeySet.add(canonicalKey(g.anchorPath));
  }

  // Resolve ancestor chain (top-down: [grandparent?, parent?])
  let ancestors = normActive ? resolveAncestors(sess, normActive, 4) : [];
  if (!ancestors.length && activeKey && backlinkIndex) {
    const links = backlinkIndex.getLinksForFile(normActive);
    const inferred = (links?.backlinks || []).find(
      (b) => b?.sourceKey && b.sourceKey !== activeKey && preferredKeySet.has(b.sourceKey)
    );
    if (inferred) {
      ancestors = [
        {
          path: inferred.sourcePath,
          key: inferred.sourceKey,
          title: inferred.sourceTitle || readTitleQuick(inferred.sourcePath),
          isDirectory: false,
          inferred: true,
        },
      ];
    }
  }
  // If current node is a regular file with no recorded/backlink parent, infer enclosing folder ONLY when that folder is open or pinned
  if (!ancestors.length && activeKey && !activeIsDir) {
    const parentDir = path.dirname(normActive);
    const parentDirKey = parentDir ? canonicalKey(parentDir) : '';
    if (
      parentDirKey &&
      parentDirKey !== activeKey &&
      preferredKeySet.has(parentDirKey) &&
      (openTabMap.get(parentDirKey)?.isDirectory || isExistingDirectory(parentDir))
    ) {
      const resolvedDirPath = openTabMap.get(parentDirKey)?.path || parentDir;
      const upperAncestors = resolveAncestors(sess, resolvedDirPath, 3);
      ancestors = [
        ...upperAncestors,
        {
          path: resolvedDirPath,
          key: parentDirKey,
          title: readTitleQuick(resolvedDirPath),
          isDirectory: true,
          inferred: true,
        },
      ];
    }
  }

  ancestors = ancestors.map((anc) => ({
    ...anc,
    isDirectory: Boolean(anc.isDirectory || openTabMap.get(anc.key)?.isDirectory || isExistingDirectory(anc.path)),
  }));

  const resolveChildrenForNode = (nodePath, excludeKey = '', { isDirHint = false } = {}) => {
    const cleanNode = normalizeFilePath(nodePath);
    if (!cleanNode) return { items: [], dirMeta: null };
    const nodeKey = canonicalKey(cleanNode);
    const nodeIsDir = Boolean(isDirHint || openTabMap.get(nodeKey)?.isDirectory || isExistingDirectory(cleanNode));
    const itemsMap = new Map();
    const hasOpenTabsSnap = openTabMap.size > 0;
    let dirMeta = null;

    const upsertItem = (entry) => {
      if (!entry?.path || isSensitiveFilePath(entry.path)) return;
      const key = canonicalKey(entry.path);
      if (!key || key === nodeKey || (excludeKey && key === excludeKey)) return;
      const gMeta = groupChildMap.get(key);
      const tabMeta = openTabMap.get(key);
      const isDir = Boolean(entry.isDirectory || tabMeta?.isDirectory);
      if (nodeIsDir && isDir) return; // Directories expose direct files only (subfolders intentionally skipped)

      const isOpened = Boolean(
        tabMeta ||
          (gMeta && (!hasOpenTabsSnap || gMeta.inActiveGroup || tabMeta)) ||
          (!hasOpenTabsSnap && entry.fromLineageOrGroup)
      );

      const prev = itemsMap.get(key);
      if (prev) {
        prev.isOpenedTab = prev.isOpenedTab || isOpened;
        prev.locked = prev.locked || Boolean(entry.locked || gMeta?.locked);
        prev.lastAccessedAt = Math.max(prev.lastAccessedAt || 0, entry.lastAccessedAt || 0, gMeta?.lastAccessedAt || 0);
        if (!prev.lineStart && entry.lineStart) prev.lineStart = entry.lineStart;
        return;
      }

      const cls = classifyFile(entry.path, rules, isDir);
      itemsMap.set(key, {
        path: entry.path,
        key,
        title: entry.title || readTitleQuick(entry.path),
        ext: cls.ext,
        isDirectory: isDir,
        isOpenedTab: isOpened,
        locked: Boolean(entry.locked || gMeta?.locked),
        lastAccessedAt: Number(entry.lastAccessedAt || gMeta?.lastAccessedAt || 0),
        lineStart: entry.lineStart || null,
        categoryId: cls.id,
        categoryLabel: cls.label,
        source: entry.source || 'outlink',
      });
    };

    // 1. Direct lineage edges from session
    for (const rec of Object.values(sess.lineage?.parentByKey || {})) {
      if (rec?.parentKey === nodeKey && rec?.childPath) {
        const childIsDir = Boolean(rec.childIsDirectory || openTabMap.get(canonicalKey(rec.childPath))?.isDirectory || isExistingDirectory(rec.childPath));
        upsertItem({
          path: rec.childPath,
          title: rec.childTitle,
          isDirectory: childIsDir,
          lastAccessedAt: rec.openedAt || 0,
          fromLineageOrGroup: true,
          source: 'lineage',
        });
      }
    }

    // 2. Group children if this node is a Priority Anchor
    for (const g of sess.groups || []) {
      if (canonicalKey(g.anchorPath || '') !== nodeKey) continue;
      for (const ch of g.children || []) {
        const chIsDir = Boolean(ch.isDirectory || openTabMap.get(canonicalKey(ch.path))?.isDirectory || isExistingDirectory(ch.path));
        upsertItem({
          path: ch.path,
          title: ch.title,
          isDirectory: chIsDir,
          locked: Boolean(ch.locked),
          lastAccessedAt: ch.lastAccessedAt || ch.addedAt || 0,
          fromLineageOrGroup: true,
          source: 'group',
        });
      }
    }

    // 3. Direct files for directories OR Markdown outlinks for documents
    if (nodeIsDir) {
      const dirListing = listDirectoryDirectFiles(cleanNode, { maxFiles: maxDirFiles });
      if (dirListing.ok) {
        dirMeta = {
          totalFiles: dirListing.totalFiles,
          skippedSubdirCount: dirListing.skippedSubdirCount,
          truncated: dirListing.truncated,
          maxFiles: dirListing.maxFiles,
        };
        for (const f of dirListing.files) {
          upsertItem({
            path: f.path,
            title: f.name,
            isDirectory: false,
            fromLineageOrGroup: false,
            source: 'directory',
          });
        }
      }
    } else if (backlinkIndex) {
      const links = backlinkIndex.getLinksForFile(cleanNode);
      for (const o of links?.outlinks || []) {
        if (!o?.exists || !o.resolvedPath) continue;
        upsertItem({
          path: o.resolvedPath,
          title: o.label || readTitleQuick(o.resolvedPath),
          lineStart: o.lineStart || o.line || null,
          isDirectory: Boolean(o.isDirectory || /[\\/]$/.test(o.rawTarget || '') || isExistingDirectory(o.resolvedPath)),
          fromLineageOrGroup: false,
          source: 'outlink',
        });
      }
    }

    let list = Array.from(itemsMap.values());
    if (childSourceScope === 'opened_only') {
      list = list.filter((it) => it.isOpenedTab);
    }

    if (nodeIsDir) {
      // Natural filename order (01, 02, 10...); opened tabs keep dot badge without reordering sequence
      list.sort((a, b) => NATURAL_COLLATOR.compare(a.title, b.title));
    } else {
      list.sort(
        (a, b) =>
          Number(b.isOpenedTab) - Number(a.isOpenedTab) ||
          Number(b.locked) - Number(a.locked) ||
          (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0) ||
          (a.lineStart || 999999) - (b.lineStart || 999999) ||
          NATURAL_COLLATOR.compare(a.title, b.title)
      );
    }
    return { items: list, dirMeta };
  };

  const currentRes = normActive ? resolveChildrenForNode(normActive, '', { isDirHint: activeIsDir }) : { items: [], dirMeta: null };
  const currentChildren = currentRes.items;
  const allCurrentChildrenCount = currentChildren.length;

  // Build ordered category buckets (configured rules + locked '其他')
  const categories = [...rules, { id: 'other', label: '其他', extensions: [] }].map((rule) => ({
    id: rule.id,
    label: rule.label,
    extensions: [...(rule.extensions || [])],
    items: currentChildren.filter((c) => c.categoryId === rule.id),
  }));

  // Enrich ancestors with sibling children and resolved Markdown H1 titles when available
  const ancestorRows = ancestors.map((anc, idx) => {
    const trunkNextKey = idx + 1 < ancestors.length ? ancestors[idx + 1].key : activeKey;
    const sibRes = resolveChildrenForNode(anc.path, trunkNextKey, { isDirHint: anc.isDirectory });
    const cachedMeta = !anc.isDirectory ? backlinkIndex?.fileCache?.get?.(anc.key) : null;
    const fallbackBase = readTitleQuick(anc.path);
    const resolvedTitle =
      cachedMeta?.title && (!anc.title || anc.title === fallbackBase) ? cachedMeta.title : anc.title || fallbackBase;
    return {
      path: anc.path,
      key: anc.key,
      title: resolvedTitle,
      isDirectory: Boolean(anc.isDirectory),
      inferred: Boolean(anc.inferred),
      siblings: sibRes.items,
      dirMeta: sibRes.dirMeta,
    };
  });

  let currentTitle = normActive ? readTitleQuick(normActive) : '';
  if (normActive && !activeIsDir && backlinkIndex && /\.(?:md|mdx)$/i.test(normActive)) {
    const linksInfo = backlinkIndex.getLinksForFile(normActive);
    if (linksInfo?.title) currentTitle = linksInfo.title;
  }

  return {
    activePath: normActive,
    childSourceScope,
    parentDirection: settings.parentDirection || 'left',
    current: normActive
      ? {
          path: normActive,
          key: activeKey,
          title: currentTitle || readTitleQuick(normActive),
          isDirectory: activeIsDir,
          dirMeta: currentRes.dirMeta,
          children: currentChildren,
        }
      : null,
    ancestors: ancestorRows,
    parent: ancestorRows.length ? ancestorRows[ancestorRows.length - 1] : null,
    categories,
    activeGroup: activeGrp
      ? {
          id: activeGrp.id,
          anchorPath: activeGrp.anchorPath,
          anchorTitle: activeGrp.anchorTitle,
          anchorIsDirectory: Boolean(activeGrp.anchorIsDirectory || isExistingDirectory(activeGrp.anchorPath)),
          childCount: activeGrp.children?.length || 0,
        }
      : null,
    totalCurrentChildren: allCurrentChildrenCount,
    openedCurrentChildren: currentChildren.filter((c) => c.isOpenedTab).length,
    rules: rules.map((r) => ({ id: r.id, label: r.label, extensions: [...r.extensions] })),
  };
}
