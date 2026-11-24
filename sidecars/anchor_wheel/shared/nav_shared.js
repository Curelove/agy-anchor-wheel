// Shared icons, classification helpers, hover quick-preview controller, and SVG mode guides
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelNavShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const ICONS = Object.freeze({
    anchor: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>',
    file: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    code: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    image: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    video: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    folder: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    audio: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    layers: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    tree: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="3" y="14" width="7" height="5" rx="1.5"/><rect x="14" y="14" width="7" height="5" rx="1.5"/><path d="M6.5 8v6"/><path d="M10 5.5h4"/><path d="M10 16.5h4"/></svg>',
    parentUp: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
    currentDot: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
    pin: '<svg class="aw-icon" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>',
    close: '<svg class="aw-icon" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    list: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    chevronRight: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    chevronDown: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    plus: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    wheel: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="9"/><line x1="12" y1="15" x2="12" y2="21"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>',
  });

  const DEFAULT_CATEGORY_RULES = Object.freeze([
    { id: 'image', label: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif', 'ico'] },
    { id: 'video', label: '视频', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] },
    { id: 'doc', label: '文档', extensions: ['md', 'mdx', 'txt', 'pdf', 'docx', 'doc', 'srt', 'ass', 'ssa', 'json', 'yaml', 'yml', 'csv'] },
  ]);

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normKey(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function baseDisplayName(name) {
    const clean = String(name || '').replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/);
    return parts[parts.length - 1] || clean;
  }

  function markNode(el) {
    if (!el || !el.setAttribute) return el;
    el.setAttribute('data-aw-owned', '1');
    el.setAttribute('data-omni-ignore', '1');
    el.setAttribute('data-prism-ignore', '1');
    el.setAttribute('translate', 'no');
    el.setAttribute('data-no-translate', 'true');
    el.setAttribute('data-ag-localization-skip', 'true');
    el.setAttribute('data-agy-no-translate', 'true');
    el.setAttribute('data-antigravity-zh-skip', '1');
    return el;
  }

  function pickIconForItem(itemOrPath) {
    const p = typeof itemOrPath === 'string' ? itemOrPath : itemOrPath?.path || itemOrPath?.title || '';
    const isDir = typeof itemOrPath === 'object' && Boolean(itemOrPath?.isDirectory);
    if (isDir) return ICONS.folder;
    const t = String(p).toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/.test(t)) return ICONS.image;
    if (/\.(mp4|mkv|mov|webm|avi|m4v)$/.test(t)) return ICONS.video;
    if (/\.(mp3|wav|ogg|m4a|flac|aac)$/.test(t)) return ICONS.audio;
    if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cpp|c|h|css|html|json|yaml|yml|sh|ps1)$/.test(t)) return ICONS.code;
    return ICONS.file;
  }

  function pickIconForCategory(cat) {
    const id = String(cat?.id || '').toLowerCase();
    const label = String(cat?.label || '');
    if (id === 'image' || /图|画|像/.test(label)) return ICONS.image;
    if (id === 'video' || /视|片|影/.test(label)) return ICONS.video;
    if (id === 'doc' || /文|档|稿|词/.test(label)) return ICONS.file;
    if (id === 'code' || /码|脚/.test(label)) return ICONS.code;
    return ICONS.layers;
  }

  function sanitizeRulesClient(rules) {
    const src = Array.isArray(rules) && rules.length ? rules : DEFAULT_CATEGORY_RULES;
    const out = [];
    const seen = new Set();
    for (let i = 0; i < src.length && out.length < 8; i++) {
      const r = src[i];
      if (!r || r.id === 'other' || r.label === '其他') continue;
      const id = String(r.id || `cat_${out.length + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '') || `cat_${out.length + 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const label = String(r.label || '').trim().slice(0, 12);
      if (!label) continue;
      const exts = (Array.isArray(r.extensions) ? r.extensions : [])
        .map((e) => String(e || '').replace(/^\.+/, '').trim().toLowerCase())
        .filter(Boolean);
      out.push({ id, label, extensions: exts });
    }
    return out.length ? out : DEFAULT_CATEGORY_RULES.map((c) => ({ ...c, extensions: [...c.extensions] }));
  }

  function classifyPathClient(filePath, rules, isDirectory = false) {
    if (isDirectory) return { id: 'other', label: '其他', ext: '' };
    const clean = String(filePath || '').replace(/[\\/]+$/, '');
    const dot = clean.lastIndexOf('.');
    const ext = dot !== -1 ? clean.slice(dot + 1).toLowerCase() : '';
    const safeRules = sanitizeRulesClient(rules);
    if (ext) {
      for (const r of safeRules) {
        if (r.extensions.includes(ext)) return { id: r.id, label: r.label, ext };
      }
    }
    return { id: 'other', label: '其他', ext };
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * Local fallback builder when Mode 1 talks to an older un-restarted sidecar or offline harness.
   */
  function buildFallbackNavContext({
    session,
    settings,
    activePath,
    activeIsDirectory = false,
    activeLinks,
    openTabs = [],
    scopeOverride = '',
  }) {
    const rules = sanitizeRulesClient(settings?.categoryRules);
    const scope = (scopeOverride || settings?.childSourceScope || 'opened_and_outlinks') === 'opened_only'
      ? 'opened_only'
      : 'opened_and_outlinks';
    const actKey = normKey(activePath);
    const openMap = new Map();
    for (const t of openTabs || []) {
      const p = typeof t === 'string' ? t : t?.path;
      if (p) openMap.set(normKey(p), { path: p, title: baseDisplayName(p), isDirectory: Boolean(t?.isDirectory) });
    }
    const isActDir = Boolean(activeIsDirectory || /[\\/]$/.test(String(activePath || '')) || openMap.get(actKey)?.isDirectory);

    // Ancestor resolution (session.lineage -> session.groups -> backlinks)
    const ancestors = [];
    const seen = new Set([actKey]);
    const parentByKey = session?.lineage?.parentByKey || {};
    let curK = actKey;
    for (let i = 0; i < 4 && curK; i++) {
      const rec = parentByKey[curK];
      let pPath = rec?.parentPath || '';
      let pTitle = rec?.parentTitle || '';
      let pKey = rec?.parentKey || (pPath ? normKey(pPath) : '');
      let pIsDir = Boolean(rec?.parentIsDirectory);
      if (!pKey) {
        const g = (session?.groups || []).find(
          (grp) => normKey(grp.anchorPath) !== curK && (grp.children || []).some((c) => normKey(c.path) === curK)
        );
        if (g?.anchorPath) {
          pPath = g.anchorPath;
          pTitle = g.anchorTitle || baseDisplayName(pPath);
          pKey = normKey(pPath);
          pIsDir = Boolean(g.anchorIsDirectory);
        }
      }
      if (!pKey || !pPath || seen.has(pKey)) break;
      seen.add(pKey);
      pIsDir = Boolean(pIsDir || openMap.get(pKey)?.isDirectory);
      ancestors.unshift({ path: pPath, key: pKey, title: pTitle || baseDisplayName(pPath), isDirectory: pIsDir, siblings: [] });
      curK = pKey;
    }
    if (!ancestors.length && activeLinks?.backlinks?.length) {
      const firstBack = activeLinks.backlinks.find((b) => b.sourcePath && normKey(b.sourcePath) !== actKey);
      if (firstBack) {
        ancestors.push({
          path: firstBack.sourcePath,
          key: normKey(firstBack.sourcePath),
          title: firstBack.sourceTitle || baseDisplayName(firstBack.sourcePath),
          inferred: true,
          siblings: [],
        });
      }
    }

    const resolveChildren = (nodePath, excludeKey = '') => {
      const nKey = normKey(nodePath);
      const map = new Map();
      const push = (it) => {
        if (!it?.path) return;
        const k = normKey(it.path);
        if (!k || k === nKey || (excludeKey && k === excludeKey)) return;
        const prev = map.get(k);
        const cls = classifyPathClient(it.path, rules, Boolean(it.isDirectory));
        if (prev) {
          prev.isOpenedTab = prev.isOpenedTab || Boolean(it.isOpenedTab);
          prev.locked = prev.locked || Boolean(it.locked);
          return;
        }
        map.set(k, {
          path: it.path,
          key: k,
          title: it.title || baseDisplayName(it.path),
          ext: cls.ext,
          isDirectory: Boolean(it.isDirectory),
          isOpenedTab: Boolean(it.isOpenedTab || openMap.has(k)),
          locked: Boolean(it.locked),
          lastAccessedAt: Number(it.lastAccessedAt || 0),
          lineStart: it.lineStart || null,
          categoryId: cls.id,
          categoryLabel: cls.label,
        });
      };
      for (const rec of Object.values(parentByKey)) {
        if (rec?.parentKey === nKey && rec?.childPath) {
          push({ path: rec.childPath, title: rec.childTitle, isOpenedTab: true, lastAccessedAt: rec.openedAt || 0 });
        }
      }
      for (const g of session?.groups || []) {
        if (normKey(g.anchorPath) !== nKey) continue;
        for (const ch of g.children || []) {
          push({ path: ch.path, title: ch.title, isOpenedTab: true, locked: ch.locked, lastAccessedAt: ch.lastAccessedAt });
        }
      }
      if (scope !== 'opened_only' && nKey === actKey) {
        for (const o of activeLinks?.outlinks || []) {
          if (o?.exists && o.resolvedPath) {
            push({ path: o.resolvedPath, title: o.label || baseDisplayName(o.resolvedPath), lineStart: o.lineStart || o.line, isDirectory: Boolean(o.isDirectory) });
          }
        }
      }
      let arr = Array.from(map.values());
      if (scope === 'opened_only') arr = arr.filter((x) => x.isOpenedTab);
      arr.sort((a, b) => Number(b.isOpenedTab) - Number(a.isOpenedTab) || (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0));
      return arr;
    };

    const currentChildren = activePath ? resolveChildren(activePath) : [];
    const categories = [...rules, { id: 'other', label: '其他', extensions: [] }].map((r) => ({
      id: r.id,
      label: r.label,
      extensions: [...(r.extensions || [])],
      items: currentChildren.filter((c) => c.categoryId === r.id),
    }));
    const enrichedAncestors = ancestors.map((anc, idx) => {
      const nextTrunk = idx + 1 < ancestors.length ? ancestors[idx + 1].key : actKey;
      return { ...anc, siblings: resolveChildren(anc.path, nextTrunk) };
    });

    return {
      activePath,
      childSourceScope: scope,
      parentDirection: settings?.parentDirection || 'left',
      current: activePath
        ? {
            path: activePath,
            key: actKey,
            title: (!isActDir && activeLinks?.title) || baseDisplayName(activePath),
            isDirectory: isActDir,
            children: currentChildren,
          }
        : null,
      ancestors: enrichedAncestors,
      parent: enrichedAncestors.length ? enrichedAncestors[enrichedAncestors.length - 1] : null,
      categories,
      totalCurrentChildren: currentChildren.length,
      openedCurrentChildren: currentChildren.filter((c) => c.isOpenedTab).length,
      rules,
    };
  }

  /**
   * Unified 0.25s debounced hover preview card (non-blocking pointer-events: none).
   * Enforces strict single-card ownership, same-item dedup, owner-alive checks, and global cleanup.
   */
  function createPreviewController(options = {}) {
    const doc = options.document || document;
    const mountRoot = options.mountRoot || doc.body;
    const isOwnerOpen = typeof options.isOwnerOpen === 'function' ? options.isOwnerOpen : null;
    let delayTimer = null;
    let animPollTimer = null;
    let watchdogTimer = null;
    let lifecycleBound = false;
    let cardEl = null;
    let hoveredKey = '';
    let seq = 0;

    function clearTimers() {
      clearTimeout(delayTimer);
      clearTimeout(animPollTimer);
      delayTimer = null;
      animPollTimer = null;
    }

    function removeAllCards() {
      if (cardEl) {
        try { cardEl.remove(); } catch {}
        cardEl = null;
      }
      try {
        for (const el of mountRoot?.querySelectorAll?.('.aw-preview-card') || []) {
          try { el.remove(); } catch {}
        }
      } catch {}
      try {
        if (doc && doc !== mountRoot) {
          for (const el of doc.querySelectorAll?.('.aw-preview-card') || []) {
            try { el.remove(); } catch {}
          }
        }
      } catch {}
    }

    function onGlobalBlur() {
      hide();
    }

    function onVisibilityChange() {
      if (doc.hidden) hide();
    }

    function onEscapeKey(ev) {
      if (ev.key === 'Escape') hide();
    }

    function attachLifecycle() {
      if (!lifecycleBound) {
        lifecycleBound = true;
        try { doc.defaultView?.addEventListener?.('blur', onGlobalBlur); } catch {}
        try { doc.addEventListener('visibilitychange', onVisibilityChange); } catch {}
        try { doc.addEventListener('keydown', onEscapeKey, true); } catch {}
      }
      if (!watchdogTimer) {
        watchdogTimer = setInterval(() => {
          if (isOwnerOpen && !isOwnerOpen()) {
            hide();
            return;
          }
          if (cardEl && !cardEl.isConnected) {
            hide();
          }
        }, 400);
      }
    }

    function detachLifecycle() {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (lifecycleBound) {
        lifecycleBound = false;
        try { doc.defaultView?.removeEventListener?.('blur', onGlobalBlur); } catch {}
        try { doc.removeEventListener('visibilitychange', onVisibilityChange); } catch {}
        try { doc.removeEventListener('keydown', onEscapeKey, true); } catch {}
      }
    }

    function hide() {
      clearTimers();
      hoveredKey = '';
      seq++;
      removeAllCards();
      detachLifecycle();
    }

    function positionCard(el, anchorRect, placement = 'side') {
      if (!el || !anchorRect) return;
      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;
      const cardW = Math.min(288, vw - 24);
      const cardH = Math.min(240, vh - 24);
      let effectivePlacement = placement;
      if (placement === 'side') {
        const roomRight = vw - anchorRect.right - 12;
        const roomLeft = anchorRect.left - 12;
        if (roomRight < cardW && roomLeft < cardW) {
          effectivePlacement = 'below';
        }
      }
      let left;
      let top;
      if (effectivePlacement === 'below') {
        left = Math.max(10, Math.min(vw - cardW - 10, anchorRect.left));
        top = anchorRect.bottom + 10;
        if (top + cardH > vh - 10) {
          top = Math.max(10, anchorRect.top - cardH - 10);
        }
      } else {
        left = anchorRect.right + 12;
        if (left + cardW > vw - 10) {
          left = Math.max(10, anchorRect.left - cardW - 12);
        }
        top = Math.max(10, Math.min(vh - cardH - 10, anchorRect.top - 12));
      }
      el.style.width = `${cardW}px`;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    function renderPreviewPayload(el, item, data) {
      if (!el) return;
      const title = esc(data?.title || item?.title || baseDisplayName(item?.path));
      const sizeStr = formatBytes(data?.sizeBytes);
      const badge = data?.kind === 'directory'
        ? `${data.itemCount || 0} 文件${data.subdirCount ? ` · ${data.subdirCount} 子目录` : ''}`
        : data?.ext
        ? `${String(data.ext).toUpperCase()}${sizeStr ? ` · ${sizeStr}` : ''}`
        : sizeStr;

      let bodyHtml = '';
      if (!data || !data.ok) {
        bodyHtml = `<div class="aw-preview-empty">${esc(data?.error || '无法读取预览内容')}</div>`;
      } else if (data.kind === 'image') {
        bodyHtml = data.dataUrl
          ? `<div class="aw-preview-media"><img src="${data.dataUrl}" alt="${title}" /></div>`
          : `<div class="aw-preview-empty">${data.tooLargeWithoutFfmpeg ? '大图需安装 ffmpeg 生成轻量缩略图，点击直接查看' : '图片预览不可用'}</div>`;
      } else if (data.kind === 'video') {
        const mediaSrc = data.animDataUrl || data.posterDataUrl;
        if (mediaSrc) {
          const hint = data.animDataUrl ? '3 秒动态预览' : data.animPending ? '已跳过黑帧 · 动态缓存中...' : '首段非黑帧快览';
          bodyHtml = `<div class="aw-preview-media"><img src="${mediaSrc}" alt="${title}" /><span class="aw-preview-media-tag">${hint}</span></div>`;
        } else if (options.standaloneRawUrl && item?.path) {
          bodyHtml = `<div class="aw-preview-media"><video src="${options.standaloneRawUrl(item.path)}" muted playsinline preload="metadata"></video><span class="aw-preview-media-tag">视频流预览</span></div>`;
        } else {
          bodyHtml = `<div class="aw-preview-empty">${data.noFfmpeg ? '未检测到本机 ffmpeg，无法抽取视频前段预览，点击直接打开' : '正在抽取视频非黑帧...'}</div>`;
        }
      } else if (data.kind === 'audio') {
        bodyHtml = `<div class="aw-preview-empty">${ICONS.audio}<span>音频文件 (${esc(badge)}) · 点击播放</span></div>`;
      } else if (data.kind === 'directory') {
        const rows = (data.entries || []).slice(0, 8)
          .map((e) => `<div class="aw-preview-dir-row">${e.isDirectory ? ICONS.folder : pickIconForItem(e.name)}<span>${esc(e.name)}</span></div>`)
          .join('');
        bodyHtml = rows
          ? `<div class="aw-preview-dir">${rows}</div>`
          : `<div class="aw-preview-empty">${data.subdirCount ? `暂无直属文件（含 ${data.subdirCount} 个子文件夹）` : '空文件夹'}</div>`;
      } else if (data.kind === 'binary') {
        bodyHtml = `<div class="aw-preview-empty">二进制资源 (${esc(badge)})</div>`;
      } else {
        const text = data.snippetText || '(空文档)';
        bodyHtml = `<pre class="aw-preview-code">${esc(text)}</pre>${data.truncated ? '<div class="aw-preview-more">仅截取开头部分 · 点击查看全文</div>' : ''}`;
      }

      el.innerHTML = `
        <div class="aw-preview-head">
          <span class="aw-preview-title">${title}</span>
          ${badge ? `<span class="aw-preview-badge">${esc(badge)}</span>` : ''}
        </div>
        <div class="aw-preview-body">${bodyHtml}</div>
      `;
    }

    function scheduleShow(item, anchorRect, placement = 'side') {
      if (options.isEnabled && !options.isEnabled()) return;
      if (isOwnerOpen && !isOwnerOpen()) return;
      if (!item?.path || !options.fetchPreview) return;
      const key = normKey(item.path);

      // Deduplicate continuous pointermove jitter over the exact same item
      if (hoveredKey === key && ((cardEl && cardEl.isConnected) || delayTimer !== null)) {
        if (cardEl && cardEl.isConnected) {
          positionCard(cardEl, anchorRect, placement);
        }
        return;
      }

      // Switching to a different item: immediately clear timers and remove any existing card
      clearTimers();
      removeAllCards();
      hoveredKey = key;
      const mySeq = ++seq;
      const delayMs = Math.max(0, Math.min(1500, Number(options.getDelayMs?.() ?? 250)));
      attachLifecycle();

      delayTimer = setTimeout(async () => {
        delayTimer = null;
        if (hoveredKey !== key || mySeq !== seq) return;
        if (isOwnerOpen && !isOwnerOpen()) {
          hide();
          return;
        }
        removeAllCards();
        cardEl = markNode(doc.createElement('div'));
        cardEl.className = 'aw-preview-card';
        cardEl.innerHTML = `<div class="aw-preview-head"><span class="aw-preview-title">${esc(baseDisplayName(item.title || item.path))}</span></div><div class="aw-preview-empty">加载开头预览...</div>`;
        mountRoot.appendChild(cardEl);
        positionCard(cardEl, anchorRect, placement);

        const animated = options.getAnimated ? Boolean(options.getAnimated()) : true;
        const data = await options.fetchPreview(item.path, { animated }).catch(() => null);
        if (isOwnerOpen && !isOwnerOpen()) {
          hide();
          return;
        }
        if (hoveredKey !== key || mySeq !== seq || !cardEl || !cardEl.isConnected) return;
        renderPreviewPayload(cardEl, item, data);
        positionCard(cardEl, anchorRect, placement);

        // Upgrade video poster to 3s animated clip once background encode finishes
        if (data?.kind === 'video' && data.animPending && animated) {
          animPollTimer = setTimeout(async () => {
            animPollTimer = null;
            if (hoveredKey !== key || mySeq !== seq || !cardEl) return;
            if (isOwnerOpen && !isOwnerOpen()) {
              hide();
              return;
            }
            const res2 = await options.fetchPreview(item.path, { animated: true }).catch(() => null);
            if (isOwnerOpen && !isOwnerOpen()) {
              hide();
              return;
            }
            if (hoveredKey === key && mySeq === seq && cardEl && cardEl.isConnected && res2?.animDataUrl) {
              renderPreviewPayload(cardEl, item, res2);
              positionCard(cardEl, anchorRect, placement);
            }
          }, 1150);
        }
      }, delayMs);
    }

    return { scheduleShow, hide };
  }

  let guideSvgSeq = 0;

  function guidePolar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function guideSectorPath(cx, cy, rIn, rOut, a0, a1, gap = 2.4) {
    const s = a0 + gap / 2;
    const e = a1 - gap / 2;
    if (e <= s) return '';
    const [x1, y1] = guidePolar(cx, cy, rOut, s);
    const [x2, y2] = guidePolar(cx, cy, rOut, e);
    const [x3, y3] = guidePolar(cx, cy, rIn, e);
    const [x4, y4] = guidePolar(cx, cy, rIn, s);
    const large = e - s > 180 ? 1 : 0;
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${rOut} ${rOut} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${rIn} ${rIn} 0 ${large} 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z`;
  }

  /**
   * Animated self-contained SVG guide cards driven live by Settings (`cfg`).
   */
  function renderModeGuideSvg(modeKey, cfg = {}) {
    const uid = `awg_${++guideSvgSeq}`;
    const pDir = cfg.parentDirection || 'left';
    const previewOn = cfg.hoverPreviewEnabled !== false;
    const delayMs = Math.max(0, Math.min(1500, Number(cfg.hoverPreviewDelayMs ?? 250)));
    const animVid = cfg.videoPreviewAnimated !== false;
    const onlyOpened = cfg.childSourceScope === 'opened_only';
    const closeOnSel = Boolean(cfg.tabCloseOnSelect);
    const hotkey = String(cfg.tabCustomHotkey || 'Tab');
    const sectors = [4, 6, 8].includes(Number(cfg.wheelSectors)) ? Number(cfg.wheelSectors) : 8;

    if (modeKey === 'bilateral_wheel') {
      const dirDeg = { top: 0, right: 90, bottom: 180, left: 270 }[pDir] ?? 270;
      const childDeg = (dirDeg + 180) % 360;
      const wheelOnRight = pDir === 'right';
      const cx = wheelOnRight ? 228 : 92;
      const cy = 80;
      const rIn = 24;
      const rOut = 70;
      const rMid = (rIn + rOut) * 0.53;

      const parentPath = guideSectorPath(cx, cy, rIn + 3, rOut, dirDeg - 76, dirDeg + 76, 2.8);
      const [plx, ply] = guidePolar(cx, cy, rMid, dirDeg);

      // Reflect ALL 1..8 user-defined categories + mandatory '其他' (2..9 total sectors)
      const customRules = sanitizeRulesClient(cfg.categoryRules);
      const catList = [...customRules, { id: 'other', label: '其他', extensions: [] }];
      const totalCats = catList.length;
      const span = totalCats >= 7 ? 168 : 162;
      const step = span / totalCats;
      const sectorGap = totalCats >= 7 ? 1.25 : totalCats >= 5 ? 1.8 : 2.4;
      const fontSize = totalCats >= 7 ? 7.4 : totalCats >= 5 ? 9.0 : 10.5;

      const catArcs = catList
        .map((c, idx) => {
          const a0 = childDeg - span / 2 + idx * step;
          const a1 = a0 + step;
          const mid = a0 + step / 2;
          // Stagger alternating inner/outer label radii at 7..9 sectors with clean clearance from center ring, rim & neighbors
          const labelR =
            totalCats >= 7
              ? rIn + (rOut - rIn) * (idx % 2 === 0 ? 0.43 : 0.77)
              : totalCats >= 5
              ? rIn + (rOut - rIn) * 0.58
              : rMid;
          const [tx, ty] = guidePolar(cx, cy, labelR, mid);
          const isFocus = idx === 0;
          const rawLabel = String(c.label || '').trim();
          const shortLabel = esc(rawLabel.length <= 3 ? rawLabel : rawLabel.slice(0, totalCats >= 7 ? 2 : 3));
          return `
            <path class="${isFocus ? 'aw-anim-bi-cat' : ''}" d="${guideSectorPath(cx, cy, rIn + 3, rOut, a0, a1, sectorGap)}" fill="${isFocus ? 'var(--aw-accent-soft)' : 'var(--aw-card)'}" stroke="${isFocus ? 'var(--aw-accent)' : 'var(--aw-card-border)'}" stroke-width="${isFocus ? '1.3' : '1.05'}"/>
            <text x="${tx.toFixed(1)}" y="${(ty + fontSize * 0.36).toFixed(1)}" fill="${isFocus ? 'var(--aw-fg)' : 'var(--aw-fg-muted)'}" font-size="${fontSize}" font-weight="${isFocus ? '600' : '500'}" text-anchor="middle">${shortLabel}</text>
          `;
        })
        .join('');

      const panelX = wheelOnRight ? 12 : 172;
      const panelW = 136;
      const railY = 18;
      const railH = 30;
      const clipX = panelX + 4;
      const clipW = panelW - 8;
      const firstCatShort = esc(String(catList[0]?.label || '图片').slice(0, 2));
      const firstExt = String(catList[0]?.extensions?.[0] || '').toUpperCase().slice(0, 5);
      const firstExtBadge = firstExt ? `.${esc(firstExt.toLowerCase())}` : '';
      const [aimX, aimY] = guidePolar(cx, cy, rMid, childDeg - span / 2 + step / 2);
      const cursorDx = aimX - cx;
      const cursorDy = aimY - cy;
      const railTargetX = (wheelOnRight ? panelX + panelW - 36 : panelX + 36) - cx;
      const railTargetY = railY + railH / 2 - cy;
      const dirCaption = { left: '母页在左', right: '母页在右', top: '母页在上', bottom: '母页在下' }[pDir] || '母页在左';

      // Align rail pills cleanly toward the wheel so reverse-glide animation reveals item D without empty gaps
      const railPillsHtml = wheelOnRight
        ? ['A', 'B', 'C', 'D']
            .map((ch, idx) => {
              const rx = clipX + clipW - 42 - idx * 44;
              const isAct = idx === 0;
              return `<rect x="${rx}" y="${railY + 5}" width="40" height="20" rx="10" fill="${isAct ? 'var(--aw-accent-soft)' : 'var(--aw-card)'}" stroke="${isAct ? 'var(--aw-accent)' : 'var(--aw-border)'}" stroke-width="1"/>
                <text x="${rx + 20}" y="${railY + 18.5}" fill="${isAct ? 'var(--aw-fg)' : 'var(--aw-fg-muted)'}" font-size="9.5" font-weight="${isAct ? '600' : '500'}" text-anchor="middle">${firstCatShort} ${ch}</text>`;
            })
            .join('')
        : ['A', 'B', 'C', 'D']
            .map((ch, idx) => {
              const rx = clipX + 2 + idx * 44;
              const isAct = idx === 0;
              return `<rect x="${rx}" y="${railY + 5}" width="40" height="20" rx="10" fill="${isAct ? 'var(--aw-accent-soft)' : 'var(--aw-card)'}" stroke="${isAct ? 'var(--aw-accent)' : 'var(--aw-border)'}" stroke-width="1"/>
                <text x="${rx + 20}" y="${railY + 18.5}" fill="${isAct ? 'var(--aw-fg)' : 'var(--aw-fg-muted)'}" font-size="9.5" font-weight="${isAct ? '600' : '500'}" text-anchor="middle">${firstCatShort} ${ch}</text>`;
            })
            .join('');

      return `
      <svg class="aw-guide-svg" viewBox="0 0 320 182" aria-hidden="true" style="--aw-cur-dx1:${cursorDx.toFixed(1)}px;--aw-cur-dy1:${cursorDy.toFixed(1)}px;--aw-cur-dx2:${railTargetX.toFixed(1)}px;--aw-cur-dy2:${railTargetY.toFixed(1)}px;--aw-rail-shift:${wheelOnRight ? '42px' : '-42px'}">
        <defs>
          <clipPath id="${uid}_clip">
            <rect x="${clipX}" y="${railY + 2}" width="${clipW}" height="${railH - 4}" rx="13"/>
          </clipPath>
          <linearGradient id="${uid}_thumb" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="var(--aw-accent)" stop-opacity="0.34"/>
            <stop offset="100%" stop-color="var(--aw-accent)" stop-opacity="0.1"/>
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="312" height="174" rx="12" fill="var(--aw-bg)" stroke="var(--aw-border)"/>
        <path d="${parentPath}" fill="var(--aw-card)" stroke="var(--aw-card-border)" stroke-width="1.2"/>
        <text x="${plx.toFixed(1)}" y="${(ply + 3.8).toFixed(1)}" fill="var(--aw-fg-muted)" font-size="11" font-weight="500" text-anchor="middle">母页</text>
        ${catArcs}
        <circle cx="${cx}" cy="${cy}" r="${rIn}" fill="var(--aw-card)" stroke="var(--aw-accent)" stroke-width="1.7"/>
        <text x="${cx}" y="${cy + 3.8}" fill="var(--aw-fg)" font-size="10.5" font-weight="600" text-anchor="middle">当前页</text>
        <!-- Clipped reverse-glide horizontal rail (zero text overflow or blank gap!) -->
        <rect x="${panelX}" y="${railY}" width="${panelW}" height="${railH}" rx="15" fill="var(--aw-popover)" stroke="var(--aw-accent)" stroke-width="1.25"/>
        <g clip-path="url(#${uid}_clip)">
          <g class="aw-anim-rail-track">${railPillsHtml}</g>
        </g>
        <!-- Luminous miniature preview card (never black!) -->
        <g class="aw-anim-bi-prev">
          <rect x="${panelX}" y="58" width="${panelW}" height="84" rx="9" fill="var(--aw-popover)" stroke="var(--aw-card-border)"/>
          <rect x="${panelX + 8}" y="66" width="${panelW - 16}" height="46" rx="6" fill="url(#${uid}_thumb)" stroke="var(--aw-accent)" stroke-opacity="0.3"/>
          ${
            previewOn
              ? `<circle cx="${panelX + 30}" cy="82" r="7" fill="var(--aw-accent)" fill-opacity="0.72"/>
                 <path d="M ${panelX + 18} 106 L ${panelX + 44} 88 L ${panelX + 66} 98 L ${panelX + 92} 78 L ${panelX + 114} 106 Z" fill="var(--aw-accent)" fill-opacity="0.45"/>
                 ${firstExtBadge ? `<rect x="${panelX + panelW - 46}" y="70" width="34" height="14" rx="4" fill="var(--aw-card)" stroke="var(--aw-border)"/><text x="${panelX + panelW - 29}" y="80" fill="var(--aw-accent)" font-size="8.5" font-weight="600" text-anchor="middle">${firstExtBadge}</text>` : ''}
                 <text x="${panelX + panelW / 2}" y="129" fill="var(--aw-fg)" font-size="10.5" font-weight="600" text-anchor="middle">${delayMs}ms 悬停快览</text>`
              : `<text x="${panelX + panelW / 2}" y="93" fill="var(--aw-fg-muted)" font-size="10.5" text-anchor="middle">快览已关闭</text>
                 <text x="${panelX + panelW / 2}" y="129" fill="var(--aw-fg-muted)" font-size="10" text-anchor="middle">松手中键即打开</text>`
          }
        </g>
        <!-- Animated cursor dot & release ripple -->
        <g class="aw-anim-cursor-bi">
          <circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="var(--aw-accent)" stroke-width="1.4" class="aw-anim-bi-ripple"/>
          <circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--aw-accent)"/>
        </g>
        <text x="160" y="166" fill="var(--aw-fg-muted)" font-size="10.5" text-anchor="middle">${dirCaption} · 共 ${totalCats} 分类扇区 · 滑轨反向平滑</text>
      </svg>`;
    }

    if (modeKey === 'ae_tree') {
      const keyW = hotkey.length > 3 ? 46 : 34;
      const scopeXAll = 198;
      const scopeXOpen = 248;
      return `
      <svg class="aw-guide-svg" viewBox="0 0 320 182" aria-hidden="true">
        <defs>
          <linearGradient id="${uid}_stage" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="var(--aw-accent)" stop-opacity="0.32"/>
            <stop offset="55%" stop-color="var(--aw-accent)" stop-opacity="0.16"/>
            <stop offset="100%" stop-color="var(--aw-success)" stop-opacity="0.22"/>
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="312" height="174" rx="12" fill="var(--aw-bg)" stroke="var(--aw-border)"/>
        <!-- Animated keycap & scope switch -->
        <g class="aw-anim-keycap">
          <rect x="14" y="12" width="${keyW}" height="19" rx="5" fill="var(--aw-card)" stroke="var(--aw-accent)" stroke-width="1.2"/>
          <text x="${14 + keyW / 2}" y="25" fill="var(--aw-accent)" font-size="10" font-weight="600" text-anchor="middle">${esc(hotkey)}</text>
        </g>
        <rect x="194" y="12" width="108" height="19" rx="6" fill="var(--aw-hover)" stroke="var(--aw-border)"/>
        <rect x="${onlyOpened ? scopeXOpen : scopeXAll}" y="14" width="${onlyOpened ? 50 : 48}" height="15" rx="4.5" fill="var(--aw-card)" stroke="var(--aw-border)"/>
        <text x="222" y="24.5" fill="${onlyOpened ? 'var(--aw-fg-muted)' : 'var(--aw-fg)'}" font-size="9" font-weight="${onlyOpened ? '500' : '600'}" text-anchor="middle">全部出链</text>
        <text x="273" y="24.5" fill="${onlyOpened ? 'var(--aw-fg)' : 'var(--aw-fg-muted)'}" font-size="9" font-weight="${onlyOpened ? '600' : '500'}" text-anchor="middle">仅已开</text>

        <!-- Vertical trunk spine -->
        <line x1="56" y1="62" x2="56" y2="96" stroke="var(--aw-card-border)" stroke-width="1.6"/>
        <!-- Parent row -->
        <rect x="16" y="40" width="80" height="23" rx="7" fill="var(--aw-card)" stroke="var(--aw-card-border)"/>
        <text x="56" y="55" fill="var(--aw-fg)" font-size="10.5" text-anchor="middle">母页</text>
        <path d="M 96 51.5 H 116" stroke="var(--aw-card-border)" stroke-width="1.3"/>
        <g class="aw-anim-tree-dim">
          <rect x="116" y="38" width="66" height="16" rx="5" fill="var(--aw-card)" stroke="var(--aw-border)"/>
          <text x="149" y="49" fill="var(--aw-fg-muted)" font-size="9" text-anchor="middle">同级页 A</text>
          ${onlyOpened ? '' : `<rect x="116" y="57" width="66" height="16" rx="5" fill="var(--aw-card)" stroke="var(--aw-border)"/><text x="149" y="68" fill="var(--aw-fg-muted)" font-size="9" text-anchor="middle">同级页 B</text>`}
        </g>

        <!-- Current row & illuminated branch -->
        <rect x="16" y="96" width="80" height="25" rx="7" fill="var(--aw-accent-soft)" stroke="var(--aw-accent)" stroke-width="1.5"/>
        <text x="56" y="112" fill="var(--aw-fg)" font-size="10.5" font-weight="600" text-anchor="middle">当前页</text>
        <path class="aw-anim-tree-wire" d="M 96 108.5 H 116" stroke="var(--aw-accent)" stroke-width="1.5"/>
        <g class="aw-anim-tree-lit">
          <rect x="116" y="90" width="66" height="20" rx="6" fill="var(--aw-card)" stroke="var(--aw-accent)"/>
          <text x="149" y="103.5" fill="var(--aw-fg)" font-size="10" font-weight="600" text-anchor="middle">子页 1</text>
          <rect class="aw-anim-tree-charge" x="119" y="108" width="60" height="2" rx="1" fill="var(--aw-accent)"/>
        </g>
        <!-- Stacked folded corner cards -->
        <g class="aw-anim-tree-stack">
          <rect x="120" y="121" width="64" height="19" rx="6" fill="var(--aw-card)" stroke="var(--aw-border)" opacity="0.55"/>
          <rect x="116" y="116" width="66" height="20" rx="6" fill="var(--aw-card)" stroke="var(--aw-card-border)"/>
          <text x="149" y="129.5" fill="var(--aw-fg-muted)" font-size="9.5" text-anchor="middle">+4 叠角展开</text>
        </g>

        <!-- Bright animated hover preview card (NO dark/black void!) -->
        <g class="aw-anim-tree-preview">
          <rect x="194" y="48" width="112" height="96" rx="9" fill="var(--aw-popover)" stroke="var(--aw-card-border)"/>
          <rect x="202" y="56" width="96" height="52" rx="6" fill="url(#${uid}_stage)" stroke="var(--aw-accent)" stroke-opacity="0.35"/>
          ${
            previewOn
              ? `<circle class="aw-anim-orb" cx="226" cy="78" r="10" fill="var(--aw-accent)" fill-opacity="0.72"/>
                 <rect class="aw-anim-wave1" x="246" y="70" width="8" height="20" rx="4" fill="var(--aw-accent)"/>
                 <rect class="aw-anim-wave2" x="259" y="65" width="8" height="28" rx="4" fill="var(--aw-fg)" fill-opacity="0.72"/>
                 <rect class="aw-anim-wave3" x="272" y="72" width="8" height="18" rx="4" fill="var(--aw-accent)"/>
                 <rect x="202" y="115" width="96" height="3" rx="1.5" fill="var(--aw-border)"/>
                 <rect class="aw-anim-scan" x="202" y="115" width="44" height="3" rx="1.5" fill="var(--aw-accent)"/>
                 <text x="250" y="133" fill="var(--aw-fg)" font-size="9.5" font-weight="600" text-anchor="middle">${animVid ? `${delayMs}ms 亮画预览` : `${delayMs}ms 静态快览`}</text>`
              : `<text x="250" y="85" fill="var(--aw-fg-muted)" font-size="10" text-anchor="middle">悬停快览已关闭</text>
                 <text x="250" y="133" fill="var(--aw-fg-muted)" font-size="9.5" text-anchor="middle">${closeOnSel ? '点选收起' : '常驻对比'}</text>`
          }
        </g>

        <circle class="aw-anim-cursor-tree" cx="148" cy="100" r="4.5" fill="var(--aw-accent)"/>
        <text x="160" y="166" fill="var(--aw-fg-muted)" font-size="10.5" text-anchor="middle">${esc(hotkey)} ${closeOnSel ? '跳转即收' : '常驻对比'} · 悬停点亮整支与快览</text>
      </svg>`;
    }

    // Card 3: classic_wheel with live sector count (4 / 6 / 8)
    const cx = 160;
    const cy = 80;
    const rIn = 27;
    const rOut = 64;
    const step = 360 / sectors;
    const activeIdx = 1 % sectors;
    const sectorPaths = Array.from({ length: sectors }, (_, i) => {
      const a0 = i * step - step / 2;
      const a1 = a0 + step;
      const mid = i * step;
      const [lx, ly] = guidePolar(cx, cy, (rIn + rOut) * 0.54, mid);
      const isAct = i === activeIdx;
      return `
        <path class="${isAct ? 'aw-anim-cl-sector' : ''}" d="${guideSectorPath(cx, cy, rIn + 3, rOut, a0, a1, 2.2)}" fill="${isAct ? 'var(--aw-accent-soft)' : 'var(--aw-card)'}" stroke="${isAct ? 'var(--aw-accent)' : 'var(--aw-card-border)'}" stroke-width="${isAct ? '1.3' : '1.1'}"/>
        <text x="${lx.toFixed(1)}" y="${(ly + 3.5).toFixed(1)}" fill="${isAct ? 'var(--aw-fg)' : 'var(--aw-fg-muted)'}" font-size="9.5" text-anchor="middle">${i + 1}</text>
      `;
    }).join('');
    const [targetX, targetY] = guidePolar(cx, cy, (rIn + rOut) * 0.54, activeIdx * step);

    return `
    <svg class="aw-guide-svg" viewBox="0 0 320 182" aria-hidden="true" style="--aw-cl-dx:${(targetX - cx).toFixed(1)}px;--aw-cl-dy:${(targetY - cy).toFixed(1)}px;--aw-cl-deg:${(activeIdx * step).toFixed(1)}deg">
      <rect x="4" y="4" width="312" height="174" rx="12" fill="var(--aw-bg)" stroke="var(--aw-border)"/>
      ${sectorPaths}
      <circle cx="${cx}" cy="${cy}" r="${rIn}" fill="var(--aw-card)" stroke="var(--aw-accent)" stroke-width="1.7"/>
      <text x="${cx}" y="${cy + 4}" fill="var(--aw-fg)" font-size="10.5" font-weight="600" text-anchor="middle">优先母页</text>
      <g class="aw-anim-cl-needle" style="transform-origin:${cx}px ${cy}px">
        <circle cx="${cx}" cy="${cy - rIn}" r="3.5" fill="var(--aw-accent)"/>
      </g>
      <circle class="aw-anim-cursor-cl" cx="${cx}" cy="${cy}" r="4.5" fill="var(--aw-accent)"/>
      <text x="160" y="166" fill="var(--aw-fg-muted)" font-size="10.5" text-anchor="middle">当前 ${sectors} 扇区分布 · 圆心固定母页，圈外松手取消</text>
    </svg>`;
  }

  return {
    ICONS,
    DEFAULT_CATEGORY_RULES,
    esc,
    normKey,
    baseDisplayName,
    markNode,
    pickIconForItem,
    pickIconForCategory,
    sanitizeRulesClient,
    classifyPathClient,
    formatBytes,
    buildFallbackNavContext,
    createPreviewController,
    renderModeGuideSvg,
  };
});
