import path from 'node:path';
import { canonicalKey, isSensitiveFilePath, normalizeFilePath } from './security.mjs';
import { DEFAULT_CATEGORY_RULES, resolveAncestors, sanitizeCategoryRules } from './state_store.mjs';

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
  openTabs = [],
  scopeOverride = '',
}) {
  const settings = stateStore.getSettings();
  const sess = stateStore.getSession(conversationId);
  const rules = sanitizeCategoryRules(settings.categoryRules, DEFAULT_CATEGORY_RULES);

  const requestedScope = scopeOverride || settings.childSourceScope || 'opened_and_outlinks';
  const childSourceScope = requestedScope === 'opened_only' ? 'opened_only' : 'opened_and_outlinks';

  const normActive = normalizeFilePath(activePath);
  const activeKey = normActive ? canonicalKey(normActive) : '';
  const activeIsDir = /[\\/]$/.test(String(activePath || ''));

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

  const { map: groupChildMap, activeGrp } = buildGroupChildLookup(sess);

  // Resolve ancestor chain (top-down: [grandparent?, parent?])
  let ancestors = normActive ? resolveAncestors(sess, normActive, 4) : [];
  if (!ancestors.length && activeKey && backlinkIndex) {
    const links = backlinkIndex.getLinksForFile(normActive);
    const preferredKeySet = new Set(openTabMap.keys());
    if (activeGrp?.anchorPath) preferredKeySet.add(canonicalKey(activeGrp.anchorPath));
    for (const g of sess.groups || []) {
      if (g.anchorPath) preferredKeySet.add(canonicalKey(g.anchorPath));
    }
    const inferred = (links?.backlinks || []).find(
      (b) => b?.sourceKey && b.sourceKey !== activeKey && preferredKeySet.has(b.sourceKey)
    );
    if (inferred) {
      ancestors = [
        {
          path: inferred.sourcePath,
          key: inferred.sourceKey,
          title: inferred.sourceTitle || readTitleQuick(inferred.sourcePath),
          inferred: true,
        },
      ];
    }
  }

  const resolveChildrenForNode = (nodePath, excludeKey = '') => {
    const cleanNode = normalizeFilePath(nodePath);
    if (!cleanNode) return [];
    const nodeKey = canonicalKey(cleanNode);
    const itemsMap = new Map();
    const hasOpenTabsSnap = openTabMap.size > 0;

    const upsertItem = (entry) => {
      if (!entry?.path || isSensitiveFilePath(entry.path)) return;
      const key = canonicalKey(entry.path);
      if (!key || key === nodeKey || (excludeKey && key === excludeKey)) return;
      const gMeta = groupChildMap.get(key);
      const tabMeta = openTabMap.get(key);
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

      const isDir = Boolean(entry.isDirectory || tabMeta?.isDirectory);
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
        upsertItem({
          path: rec.childPath,
          title: rec.childTitle,
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
        upsertItem({
          path: ch.path,
          title: ch.title,
          locked: Boolean(ch.locked),
          lastAccessedAt: ch.lastAccessedAt || ch.addedAt || 0,
          fromLineageOrGroup: true,
          source: 'group',
        });
      }
    }

    // 3. Markdown outlinks (always scan so currently-open tabs linked from this doc are still discovered under 'opened_only')
    if (backlinkIndex) {
      const links = backlinkIndex.getLinksForFile(cleanNode);
      for (const o of links?.outlinks || []) {
        if (!o?.exists || !o.resolvedPath) continue;
        upsertItem({
          path: o.resolvedPath,
          title: o.label || readTitleQuick(o.resolvedPath),
          lineStart: o.lineStart || o.line || null,
          isDirectory: Boolean(o.isDirectory || /[\\/]$/.test(o.rawTarget || '')),
          fromLineageOrGroup: false,
          source: 'outlink',
        });
      }
    }

    let list = Array.from(itemsMap.values());
    if (childSourceScope === 'opened_only') {
      list = list.filter((it) => it.isOpenedTab);
    }

    list.sort(
      (a, b) =>
        Number(b.isOpenedTab) - Number(a.isOpenedTab) ||
        Number(b.locked) - Number(a.locked) ||
        (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0) ||
        (a.lineStart || 999999) - (b.lineStart || 999999) ||
        a.title.localeCompare(b.title)
    );
    return list;
  };

  const currentChildren = normActive && !activeIsDir ? resolveChildrenForNode(normActive, '') : [];
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
    const siblings = resolveChildrenForNode(anc.path, trunkNextKey);
    const cachedMeta = backlinkIndex?.fileCache?.get?.(anc.key);
    const fallbackBase = readTitleQuick(anc.path);
    const resolvedTitle =
      cachedMeta?.title && (!anc.title || anc.title === fallbackBase) ? cachedMeta.title : anc.title || fallbackBase;
    return {
      path: anc.path,
      key: anc.key,
      title: resolvedTitle,
      inferred: Boolean(anc.inferred),
      siblings,
    };
  });

  let currentTitle = normActive ? readTitleQuick(normActive) : '';
  if (normActive && backlinkIndex && /\.(?:md|mdx)$/i.test(normActive)) {
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
          childCount: activeGrp.children?.length || 0,
        }
      : null,
    totalCurrentChildren: allCurrentChildrenCount,
    openedCurrentChildren: currentChildren.filter((c) => c.isOpenedTab).length,
    rules: rules.map((r) => ({ id: r.id, label: r.label, extensions: [...r.extensions] })),
  };
}
