// AnchorWheel Native Mode 1 Enhancer (injected via Zero-ASAR CDP)
// Zero React DOM mutation: mounts independent `[data-aw-owned="1"]` Companion Strip & Portals,
// provides dual-channel navigation (Hold Middle -> Bilateral Wheel; Tab -> Persistent AE Tree),
// built-in GitHub Release update checker + AGY compatibility diagnostics,
// and harmonizes completely with `obsidian-prism` (`data-omni-ignore="1"` / `data-prism-ignore="1"`).
(function () {
  'use strict';
  const W = window;
  const D = document;
  if (!W || !D) return;

  try {
    W.__agAnchorWheel?.destroy?.();
  } catch {}

  const BOOT = W.__agAnchorWheelBoot || { settings: {}, wheelCss: '' };
  const S = W.AnchorWheelNavShared;
  const STYLE_ID = 'aw-native-styles';
  const STRIP_ID = 'aw-companion-strip';
  const PORTAL_ID = 'aw-native-portal';
  const OVERLAY_ID = 'aw-native-encoding-overlay';
  const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  let destroyed = false;
  let rpcSeq = 0;
  const pendingRpc = new Map();
  let settings = BOOT.settings || {};
  let session = null;
  let lastConversationId = '';
  let localHistory = { entries: [], index: -1 };
  let activeFilePath = '';
  let activeIsDirectory = false;
  let activeFileLinks = { backlinks: [], outlinks: [] };
  let activeEncodingInfo = null;
  let cachedNavContext = null;
  let navScopeOverride = '';
  let activeTabTriggerMode = false;
  let encodingOverlayVisible = false;
  let activePopoverName = '';
  let dragPayload = null;
  let domObserver = null;
  let obsThrottle = null;
  let syncTimer = null;
  let bgUpdateTimer = null;
  let suppressAuxTimer = null;
  let suppressCtxTimer = null;
  let lastObservedTabKey = '';
  let wheelInstance = null;
  let bilateralInstance = null;
  let aeTreeInstance = null;
  let settingsModalInstance = null;
  let storeUnsubscribe = null;
  let suppressNextAuxClick = false;
  let suppressNextContextMenu = false;
  let bootMeta = {
    version: BOOT.version || '',
    repoUrl: BOOT.repoUrl || 'https://github.com/Curelove/agy-anchor-wheel',
    releasesUrl: BOOT.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases',
    compatibility: BOOT.compatibility || null,
  };
  let latestUpdateInfo = null;
  let bgUpdateAttempted = false;

  function applyThemeAttr(el) {
    if (!el || !el.setAttribute) return;
    const t = settings?.theme || 'auto';
    if (t && t !== 'auto') el.setAttribute('data-aw-theme', t);
    else el.removeAttribute('data-aw-theme');
  }

  function applyThemeToNativeNodes() {
    applyThemeAttr(D.getElementById(STRIP_ID));
    applyThemeAttr(D.getElementById(PORTAL_ID));
    applyThemeAttr(D.getElementById(OVERLAY_ID));
  }

  function markOwned(el) {
    return S ? S.markNode(el) : el;
  }

  function normKey(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function baseName(p) {
    const clean = String(p || '').replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/);
    return parts[parts.length - 1] || clean;
  }

  function parentDirPath(p) {
    const clean = String(p || '').replace(/[\\/]+$/, '');
    const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
    if (idx <= 0) return '';
    return clean.slice(0, idx);
  }

  function safeDecodeUri(str) {
    let out = String(str || '');
    const hadDouble = /%25[0-9A-Fa-f]{2}/.test(out);
    try { out = decodeURIComponent(out); } catch {}
    if (hadDouble || /(?:%[C-Fc-f][0-9A-Fa-f](?:%[89ABab][0-9A-Fa-f]){1,3})/.test(out)) {
      try { out = decodeURIComponent(out); } catch {}
    }
    return out;
  }

  function uriToPath(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const nulIdx = s.lastIndexOf('\u0000');
    if (nulIdx !== -1) s = s.slice(nulIdx + 1).trim();
    if (!s) return '';
    s = s.replace(/#L\d+(?:-L?\d+)?$/i, '');
    if (/^antigravity-ide:\/\/file/i.test(s)) s = 'file://' + s.replace(/^antigravity-ide:\/\/file/i, '');
    if (/^vscode-file:\/\/vscode-app/i.test(s)) s = 'file://' + s.replace(/^vscode-file:\/\/vscode-app/i, '');
    if (/^file:\/\//i.test(s)) {
      s = pStripScheme(s);
    } else if (/%[0-9A-Fa-f]{2}/.test(s)) {
      s = safeDecodeUri(s);
    }
    return s;
  }

  function pStripScheme(rawFileUrl) {
    let s = rawFileUrl.replace(/^file:\/\//i, '');
    if (/^localhost\//i.test(s)) s = s.slice('localhost'.length);
    s = safeDecodeUri(s);
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    return s.replace(/\//g, '\\');
  }

  function pathToHostFileUri(absPath) {
    const s = String(absPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!s) return '';
    if (/^file:\/\//i.test(s)) return s;
    const winMatch = /^([A-Za-z]):\/?(.*)$/.exec(s);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const rest = winMatch[2]
        ? winMatch[2].split('/').filter((seg) => seg.length > 0).map((seg) => encodeURIComponent(seg)).join('/')
        : '';
      return `file:///${drive}%3A/${rest}`;
    }
    return `file://${encodeURI(s)}`;
  }

  // ── RPC Bridge ──────────────────────────────────────────────────────────
  W.__agAnchorWheelResolve = (id, res) => {
    const rec = pendingRpc.get(id);
    if (!rec) return;
    clearTimeout(rec.timer);
    pendingRpc.delete(id);
    rec.resolve(res);
  };

  function callRpc(action, params = {}, timeoutMs = 5000) {
    if (destroyed || typeof W.__agAnchorWheelCall !== 'function') {
      return Promise.resolve({ ok: false, offline: true });
    }
    const id = ++rpcSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        resolve({ ok: false, timeout: true });
      }, timeoutMs);
      pendingRpc.set(id, { resolve, timer });
      try {
        W.__agAnchorWheelCall(JSON.stringify({ ...params, id, action, conversationId: resolveConversationId() }));
      } catch (err) {
        clearTimeout(timer);
        pendingRpc.delete(id);
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  // ── Host React Fiber, Redux & TanStack Router Discovery ─────────────────
  function discoverHostBridge() {
    let browserCtx = null;
    let reduxStore = null;
    let router = null;
    try {
      const candidates = [D.getElementById('root'), D.body].filter(Boolean);
      const q = [];
      for (const node of candidates) {
        for (const k of Object.keys(node)) {
          if ((k.startsWith('__reactContainer') || k.startsWith('__reactFiber')) && node[k]) {
            q.push(node[k]);
          }
        }
      }
      const seen = new Set();
      let steps = 0;
      while (q.length && steps++ < 2600 && (!browserCtx || !reduxStore || !router)) {
        const n = q.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        const mp = n.memoizedProps;
        if (mp && typeof mp === 'object') {
          if (!reduxStore && mp.store && typeof mp.store.getState === 'function' && typeof mp.store.dispatch === 'function') {
            reduxStore = mp.store;
          }
          const cv = typeof mp.openUrlInBrowserPane === 'function'
            ? mp
            : mp.value && typeof mp.value.openUrlInBrowserPane === 'function'
            ? mp.value
            : null;
          if (!browserCtx && cv) browserCtx = cv;
          const rt = mp.router || mp.value?.router || mp.value;
          if (!router && rt && typeof rt === 'object' && typeof rt.navigate === 'function' && typeof rt.buildLocation === 'function') {
            router = rt;
          }
        }
        if (n.child) q.push(n.child);
        if (n.sibling) q.push(n.sibling);
      }
    } catch {}
    return { browserCtx, reduxStore, router };
  }

  function setHostRouterTab(router, tabId) {
    if (!router || typeof router.navigate !== 'function') return false;
    try {
      void router.navigate({
        search: (prev) => {
          const next = { ...(prev || {}) };
          if (tabId) next.tab = tabId;
          else delete next.tab;
          return next;
        },
        replace: true,
        unsafeRelative: 'path',
      });
      return true;
    } catch {
      return false;
    }
  }

  function resolveHostTreeId(reduxStore, browserCtx) {
    if (browserCtx && typeof browserCtx.getTargetTreeId === 'function') {
      try {
        const t = browserCtx.getTargetTreeId();
        if (t && typeof t.kind === 'string') return t;
      } catch {}
    }
    const m = String(W.location?.pathname || '').match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m?.[1]) return { kind: 'cascadeId', cascadeId: m[1] };
    try {
      const qs = new URLSearchParams(W.location?.search || '');
      const proj = qs.get('project');
      if (proj) return { kind: 'newConversation', projectId: proj };
    } catch {}
    return { kind: 'home' };
  }

  function resolveConversationId() {
    const m = String(W.location?.pathname || '').match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m?.[1]) return m[1];
    const domCid = D.querySelector('[data-cascade-id]')?.getAttribute('data-cascade-id') || '';
    if (GUID_RE.test(domCid)) return domCid;
    return 'default';
  }

  function discoverWorkspaceRoots(reduxStore) {
    const roots = [];
    const pushRoot = (raw) => {
      const p = uriToPath(raw);
      if (p && !p.includes('\u0000') && /^(?:[A-Za-z]:[\\/]|\/)/.test(p) && !roots.includes(p)) {
        roots.push(p);
      }
    };
    try {
      const st = reduxStore?.getState?.();
      const byWs = st?.vcsWorkspaceState?.byWorkspaceUri;
      if (byWs && typeof byWs === 'object') {
        for (const u of Object.keys(byWs)) pushRoot(u);
      }
      const sel = st?.settingsScreen?.selectedWorkspaceUri;
      if (sel) pushRoot(sel);
    } catch {}
    return roots;
  }

  function getPaneSlice(reduxStore, browserCtx) {
    const st = reduxStore?.getState?.();
    if (!st) return { st: null, hasV2: false, treeId: null, pane: null };
    const treeId = resolveHostTreeId(reduxStore, browserCtx);
    const hasV2 = Boolean(st.sidePanelV2);
    const slice = hasV2 ? st.sidePanelV2 : st.sidePanel;
    let pane = null;
    if (slice && treeId) {
      if (treeId.kind === 'cascadeId') pane = slice.conversationPanes?.[treeId.cascadeId] || null;
      else if (treeId.kind === 'newConversation') pane = slice.newConversationPanes?.[treeId.projectId] || null;
      else if (treeId.kind === 'customView') pane = slice.customViewPanes?.[treeId.viewId] || null;
      else pane = slice.homePane || null;
    }
    return { st, hasV2, treeId, pane };
  }

  function extractUriFromTab(tab) {
    if (!tab || !tab.content) return '';
    return (
      tab.content.fileView?.fileUri ||
      tab.content.artifactView?.artifact?.sourceUri ||
      tab.content.directoryView?.directoryUri ||
      ''
    );
  }

  function collectNativeOpenTabs(pane) {
    const tabs = Array.isArray(pane?.tabs) ? pane.tabs : [];
    const out = [];
    for (const t of tabs) {
      const uri = extractUriFromTab(t);
      const p = uri ? uriToPath(uri).replace(/[\\/]+$/, '') : '';
      if (p) out.push({ path: p, title: baseName(p), isDirectory: t.content?.type === 'directoryView' });
    }
    return out;
  }

  function getActiveNativeTabInfo(pane) {
    if (!pane || !Array.isArray(pane.tabs)) return { path: '', isDirectory: false, tab: null };
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId) || null;
    const uri = extractUriFromTab(tab);
    const cleanPath = uri ? uriToPath(uri).replace(/[\\/]+$/, '') : '';
    const isDirectory = Boolean(tab?.content?.type === 'directoryView' || (uri && /[\\/]$/.test(uri)));
    return { path: cleanPath, isDirectory, tab };
  }

  function inferKnownDirectoryFlag(targetPath, explicitFlag = false) {
    if (explicitFlag) return true;
    const k = normKey(targetPath);
    if (!k) return false;
    if (cachedNavContext?.parent && normKey(cachedNavContext.parent.path) === k && cachedNavContext.parent.isDirectory) {
      return true;
    }
    if (Array.isArray(cachedNavContext?.ancestors)) {
      const hitAnc = cachedNavContext.ancestors.find((a) => normKey(a.path) === k);
      if (hitAnc?.isDirectory) return true;
    }
    for (const g of session?.groups || []) {
      if (normKey(g.anchorPath) === k && g.anchorIsDirectory) return true;
    }
    const linRec = session?.lineage?.parentByKey?.[normKey(activeFilePath)];
    if (linRec && linRec.parentKey === k && linRec.parentIsDirectory) return true;
    return false;
  }

  function getRightPaneColumn() {
    const aux = D.querySelector('[data-testid="aux-pane-split"], [data-testid="side-panel-split"]');
    if (aux && aux.lastElementChild) {
      const hit =
        aux.lastElementChild.querySelector('.flex.flex-col.browser-hole-ancestor') ||
        aux.lastElementChild.querySelector('[data-testid="side-panel-column"]') ||
        (aux.lastElementChild.querySelector('.agy-aux-tab')?.closest?.('.flex.flex-col') || null);
      if (hit) return hit;
    }
    const anyTab = D.querySelector('.agy-aux-tab');
    return anyTab ? anyTab.closest('.flex.flex-col.browser-hole-ancestor') || anyTab.closest('.flex.flex-col') : null;
  }

  function getNativeTabBar(col) {
    if (!col) return null;
    return Array.from(col.children).find((el) => el.getAttribute('data-aw-owned') !== '1') || null;
  }

  function getContentContainer(col) {
    if (!col) return null;
    const nativeKids = Array.from(col.children).filter((el) => el.getAttribute('data-aw-owned') !== '1');
    return nativeKids[1] || null;
  }

  function findScrollContainer(col) {
    const contentWrap = getContentContainer(col);
    if (!contentWrap) return null;
    for (const el of contentWrap.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 20) {
        const cls = String(el.className || '');
        if (cls.includes('overflow-y-auto') || cls.includes('overflow-auto')) return el;
      }
    }
    return null;
  }

  function openPathInNativeTab(targetPath, { background = false, lineStart = null, isDirectory = false } = {}) {
    const { browserCtx, reduxStore, router } = discoverHostBridge();
    const { hasV2, treeId, pane } = getPaneSlice(reduxStore, browserCtx);
    if (!reduxStore || !treeId) return false;

    const cleanTargetPath = String(targetPath || '').replace(/[\\/]+$/, '');
    const targetKey = normKey(cleanTargetPath);
    const existingTab = Array.isArray(pane?.tabs)
      ? pane.tabs.find((t) => {
          const uri = extractUriFromTab(t);
          return uri && normKey(uriToPath(uri)) === targetKey;
        })
      : null;

    reduxStore.dispatch({
      type: 'sidePanel/setSidePanelOpen',
      payload: { panelScope: treeId, treeId, isOpen: true },
    });

    if (hasV2 && treeId.kind === 'cascadeId') {
      const st = reduxStore.getState();
      if (st.sidePanelV2?.overviewPanelOpen?.[treeId.cascadeId]) {
        reduxStore.dispatch({
          type: 'sidePanelV2/setOverviewPanelOpen',
          payload: { cascadeId: treeId.cascadeId, open: false },
        });
      }
    }

    if (existingTab) {
      if (hasV2 && existingTab.isPreview) {
        reduxStore.dispatch({
          type: 'sidePanelV2/promoteTab',
          payload: { panelScope: treeId, tabId: existingTab.id },
        });
      }
      if (!background) {
        setHostRouterTab(router, existingTab.id);
        reduxStore.dispatch({
          type: hasV2 ? 'sidePanelV2/setActiveTab' : 'sidePanel/setActiveTab',
          payload: { panelScope: treeId, treeId, tabId: existingTab.id },
        });
      }
      return true;
    }

    if (hasV2 && pane?.activeTabId) {
      const activeTabObj = Array.isArray(pane.tabs) ? pane.tabs.find((t) => t.id === pane.activeTabId) : null;
      if (!activeTabObj || activeTabObj.isPreview) {
        reduxStore.dispatch({
          type: 'sidePanelV2/promoteTab',
          payload: { panelScope: treeId, tabId: pane.activeTabId },
        });
      }
    }

    const resolvedIsDir = inferKnownDirectoryFlag(cleanTargetPath, isDirectory);
    const fileUri = pathToHostFileUri(cleanTargetPath);
    const content = resolvedIsDir
      ? { type: 'directoryView', directoryView: { directoryUri: fileUri, ...(treeId.kind === 'cascadeId' ? { cascadeId: treeId.cascadeId } : {}) } }
      : { type: 'fileView', fileView: { fileUri, ...(treeId.kind === 'cascadeId' ? { cascadeId: treeId.cascadeId } : {}), ...(lineStart ? { line: lineStart } : {}) } };

    const setPayload = {
      panelScope: treeId,
      treeId,
      keepOpen: true,
      background: Boolean(background),
      content,
    };
    if (!hasV2) setPayload.tabId = `${resolvedIsDir ? 'directory' : 'file'}__${fileUri}`;

    reduxStore.dispatch({
      type: hasV2 ? 'sidePanelV2/setContent' : 'sidePanel/setContent',
      payload: setPayload,
    });

    const paneAfter = getPaneSlice(reduxStore, browserCtx).pane;
    const matchedNewTab = paneAfter?.tabs?.find((t) => {
      const u = extractUriFromTab(t);
      return u && normKey(uriToPath(u)) === targetKey;
    });
    const newTabId = matchedNewTab?.id || (!background ? paneAfter?.activeTabId : '') || setPayload.tabId || '';

    if (!background && newTabId) {
      setHostRouterTab(router, newTabId);
      if (!hasV2) {
        reduxStore.dispatch({
          type: 'sidePanel/setActiveTab',
          payload: { panelScope: treeId, treeId, tabId: newTabId },
        });
      }
    }
    return true;
  }

  function readTabMetaFromElement(tabEl) {
    try {
      const fk = Object.keys(tabEl).find((k) => k.startsWith('__reactFiber'));
      let cur = fk ? tabEl[fk] : null;
      for (let i = 0; i < 6 && cur; i++, cur = cur.return) {
        const tab = cur.memoizedProps?.tab;
        if (tab && typeof tab === 'object' && tab.id) return tab;
      }
    } catch {}
    return null;
  }

  function closeNativeTabsByKeys(keysToClose) {
    if (!keysToClose || !keysToClose.length) return;
    const set = new Set(keysToClose.map(normKey));
    const { browserCtx, reduxStore } = discoverHostBridge();
    const { hasV2, treeId, pane } = getPaneSlice(reduxStore, browserCtx);
    if (hasV2 && reduxStore && treeId && Array.isArray(pane?.tabs)) {
      for (const t of pane.tabs) {
        const uri = extractUriFromTab(t);
        if (uri && set.has(normKey(uriToPath(uri)))) {
          reduxStore.dispatch({
            type: 'sidePanelV2/clearContent',
            payload: { panelScope: treeId, tabId: t.id, recordClosed: true },
          });
        }
      }
      return;
    }
    const tabBar = getNativeTabBar(getRightPaneColumn());
    if (!tabBar) return;
    for (const tabEl of tabBar.querySelectorAll('.agy-aux-tab')) {
      const uri = extractUriFromTab(readTabMetaFromElement(tabEl));
      if (uri && set.has(normKey(uriToPath(uri)))) {
        tabEl.querySelector('button[aria-label^="Close "], button[aria-label*="关闭"]')?.click?.();
      }
    }
  }

  function applyNonDestructiveTabFolding() {
    const tabBar = getNativeTabBar(getRightPaneColumn());
    if (!tabBar) return;
    const shouldFold = settings.foldChildTabsInNativeBar !== false;
    const foldedKeys = new Set();
    if (shouldFold && session?.groups) {
      for (const g of session.groups) {
        for (const c of g.children || []) foldedKeys.add(normKey(c.path));
      }
    }
    for (const tabEl of tabBar.querySelectorAll('.agy-aux-tab')) {
      const uri = extractUriFromTab(readTabMetaFromElement(tabEl));
      const pKey = uri ? normKey(uriToPath(uri)) : '';
      const isCurActive = pKey && pKey === normKey(activeFilePath);
      if (pKey && foldedKeys.has(pKey) && !isCurActive) tabEl.setAttribute('data-aw-hidden-tab', '1');
      else tabEl.removeAttribute('data-aw-hidden-tab');
    }
  }

  function isKnownOutlinkDirectory(absPath) {
    const k = normKey(absPath);
    if (!k) return false;
    return Boolean((activeFileLinks?.outlinks || []).some((o) => o?.isDirectory && normKey(o.resolvedPath) === k));
  }

  // ── Extract Link Meta (Scoped strictly away from breadcrumb div[data-uri]) ──
  function extractLinkMetaFromTarget(rawEl) {
    const el = rawEl && rawEl.nodeType === 1 ? rawEl : rawEl?.parentElement;
    if (!el || el.closest?.('[data-aw-owned="1"], [data-testid="agent-input-box"], .ag-omni-menu, .ag-prism-thought-overlay')) {
      return null;
    }
    const pill = el.closest?.('button.inline-pill, [data-testid="entity-pill"], button[data-file-uri]');
    if (pill) {
      const rawUri = pill.getAttribute('data-uri') || pill.getAttribute('data-file-uri') || pill.getAttribute('title') || '';
      const p = uriToPath(rawUri).replace(/[\\/]+$/, '');
      if (p) {
        const isDirectory = /[\\/]$/.test(rawUri) || /[\\/]$/.test(pill.getAttribute('title') || '') || isKnownOutlinkDirectory(p);
        return { path: p, uri: rawUri, title: baseName(p), lineStart: Number(pill.getAttribute('data-line-start')) || null, isDirectory };
      }
      try {
        const fk = Object.keys(pill).find((k) => k.startsWith('__reactFiber'));
        let cur = fk ? pill[fk] : null;
        for (let i = 0; i < 6 && cur; i++, cur = cur.return) {
          const u = cur.memoizedProps?.fileUri || cur.memoizedProps?.href;
          if (typeof u === 'string' && u) {
            const fp = uriToPath(u).replace(/[\\/]+$/, '');
            const isDir = /[\\/]$/.test(u) || isKnownOutlinkDirectory(fp);
            return { path: fp, uri: u, title: baseName(fp), lineStart: Number(cur.memoizedProps?.['data-line-start']) || null, isDirectory: isDir };
          }
        }
      } catch {}
    }

    const anchor = el.closest?.('a[href]');
    if (anchor) {
      const href = String(anchor.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#') || /^(?:https?:|mailto:|tel:|javascript:|customization:|sidecar:)/i.test(href)) return null;
      const resolved = resolvePathRelativeToActive(href);
      if (resolved) {
        const cleanP = String(resolved.path || '').replace(/[\\/]+$/, '');
        const isDirectory = /[\\/]$/.test(href) || isKnownOutlinkDirectory(cleanP);
        return { path: cleanP, uri: href, title: baseName(cleanP), lineStart: resolved.lineStart, isDirectory };
      }
    }
    return null;
  }

  /**
   * Detects clickable file/folder rows inside Antigravity's native `directoryView` (`YYc`) component
   * via read-only React fiber inspection, strictly scoped away from breadcrumbs and sidebar trees.
   */
  function extractDirectoryRowMetaFromTarget(rawEl) {
    if (!activeIsDirectory || !activeFilePath) return null;
    const el = rawEl && rawEl.nodeType === 1 ? rawEl : rawEl?.parentElement;
    if (!el || !isInsideRightContent(el)) return null;
    if (el.closest?.('[data-aw-owned="1"], [role="treeitem"], button, a[href], [data-uri], [data-file-uri]')) {
      return null;
    }

    const contentEl = getContentContainer(getRightPaneColumn());
    let curEl = el;
    for (let depth = 0; depth < 6 && curEl && curEl !== contentEl; depth++, curEl = curEl.parentElement) {
      try {
        const fk = Object.keys(curEl).find((k) => k.startsWith('__reactFiber'));
        const fiber = fk ? curEl[fk] : null;
        if (!fiber) continue;
        const rowKey = typeof fiber.key === 'string' ? fiber.key : '';
        const mp = fiber.memoizedProps;
        const looksLikeFileUri = /^(?:file:\/\/|antigravity-ide:\/\/|vscode-file:\/\/)/i.test(rowKey);
        if (!looksLikeFileUri || (typeof mp?.onClick !== 'function' && typeof mp?.onDoubleClick !== 'function')) {
          continue;
        }
        // Verify we are genuinely inside Antigravity's DirectoryView (`directoryUri` ancestor prop)
        let insideDirView = false;
        let anc = fiber.return;
        for (let up = 0; up < 18 && anc; up++, anc = anc.return) {
          if (typeof anc.memoizedProps?.directoryUri === 'string' && anc.memoizedProps.directoryUri) {
            insideDirView = true;
            break;
          }
        }
        if (!insideDirView) continue;

        const cleanPath = uriToPath(rowKey).replace(/[\\/]+$/, '');
        if (!cleanPath || normKey(cleanPath) === normKey(activeFilePath)) continue;

        // Inspect child icon fiber (`<ZI uri={w.uri} isDirectory={x} />`) for exact directory flag
        let detectedDir = null;
        const queue = fiber.child ? [fiber.child] : [];
        let steps = 0;
        while (queue.length && steps++ < 16) {
          const cf = queue.shift();
          if (!cf) continue;
          const cmp = cf.memoizedProps;
          if (cmp && typeof cmp === 'object' && typeof cmp.isDirectory === 'boolean' && (!cmp.uri || cmp.uri === rowKey)) {
            detectedDir = cmp.isDirectory;
            break;
          }
          if (cf.child) queue.push(cf.child);
          if (cf.sibling) queue.push(cf.sibling);
        }
        if (detectedDir === null) {
          const cleanKey = normKey(cleanPath);
          const knownDirectFile = Boolean(
            (cachedNavContext?.current?.children || []).some((ch) => !ch.isDirectory && normKey(ch.path) === cleanKey)
          );
          detectedDir = knownDirectFile ? false : /[\\/]$/.test(rowKey);
        }

        return {
          path: cleanPath,
          uri: rowKey,
          title: baseName(cleanPath),
          lineStart: null,
          isDirectory: Boolean(detectedDir),
          fromDirectoryRow: true,
        };
      } catch {}
    }
    return null;
  }

  function resolvePathRelativeToActive(rawHref) {
    const clean = String(rawHref || '').trim();
    const lm = /^(.*?)(?:#L(\d+)(?:-L?\d+)?)?$/i.exec(clean);
    const part = lm ? lm[1] : clean;
    const lineStart = lm?.[2] ? Number(lm[2]) : null;
    if (/^(?:file:\/|[A-Za-z]:[\\/])/i.test(part)) return { path: uriToPath(part), lineStart };
    if (!activeFilePath) return null;
    const dir = activeFilePath.slice(0, Math.max(activeFilePath.lastIndexOf('\\'), activeFilePath.lastIndexOf('/')));
    if (!dir) return null;
    const stack = [];
    for (const s of (dir.replace(/\\/g, '/') + '/' + part).split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') stack.pop();
      else stack.push(s);
    }
    return { path: stack.join('\\'), lineStart };
  }

  // ── NavContext, Previews & Navigator Controllers ────────────────────────
  async function fetchPreview(targetPath, opts = {}) {
    const animated = opts.animated !== undefined ? opts.animated : settings.videoPreviewAnimated !== false;
    const res = await callRpc('getPreview', { path: targetPath, animated }, 6500);
    if (res && res.ok) return res;
    // Graceful fallback if un-restarted older sidecar is running
    const fb = await callRpc('readFile', { path: targetPath }, 3500);
    if (fb && fb.ok) {
      const txt = String(fb.text || '');
      const snippetText = txt.split(/\r?\n/).slice(0, 18).join('\n').trimEnd();
      return {
        ok: true,
        kind: 'text',
        path: targetPath,
        title: baseName(targetPath),
        ext: (baseName(targetPath).split('.').pop() || '').toLowerCase(),
        encoding: fb.encoding,
        snippetText,
        truncated: txt.length > snippetText.length,
      };
    }
    return { ok: false, error: res?.error || '无法加载预览' };
  }

  function getSyncNavContext(scopeOverride = '') {
    const { browserCtx, reduxStore } = discoverHostBridge();
    const { pane } = getPaneSlice(reduxStore, browserCtx);
    const openTabs = collectNativeOpenTabs(pane);
    if (
      cachedNavContext &&
      normKey(cachedNavContext.activePath) === normKey(activeFilePath) &&
      Boolean(cachedNavContext.current?.isDirectory) === Boolean(activeIsDirectory) &&
      (!scopeOverride || cachedNavContext.childSourceScope === scopeOverride)
    ) {
      return cachedNavContext;
    }
    if (!S) return null;
    return S.buildFallbackNavContext({
      session,
      settings,
      activePath: activeFilePath,
      activeIsDirectory,
      activeLinks: activeFileLinks,
      openTabs,
      scopeOverride,
    });
  }

  async function fetchNavContext(scopeOverride = '') {
    if (!activeFilePath) return null;
    const { browserCtx, reduxStore } = discoverHostBridge();
    const { pane } = getPaneSlice(reduxStore, browserCtx);
    const openTabs = collectNativeOpenTabs(pane);
    const wsRoots = discoverWorkspaceRoots(reduxStore);
    const res = await callRpc('getNavContext', {
      path: activeFilePath,
      isDirectory: activeIsDirectory,
      openTabs,
      scope: scopeOverride || navScopeOverride || '',
      workspaceRoots: wsRoots,
    });
    if (res && res.ok && res.current) {
      cachedNavContext = res;
      return res;
    }
    const fb = getSyncNavContext(scopeOverride || navScopeOverride);
    cachedNavContext = fb;
    return fb;
  }

  function ensureSharedInstances() {
    const getTheme = () => settings?.theme || 'auto';
    const getHotkey = () => settings?.tabCustomHotkey || 'Tab';
    if (!wheelInstance && W.AnchorWheelUI) {
      wheelInstance = W.AnchorWheelUI.createRadialWheel({ document: D, mountRoot: D.body, getTheme });
    }
    if (!bilateralInstance && W.AnchorWheelBilateral) {
      bilateralInstance = W.AnchorWheelBilateral.createBilateralWheel({
        document: D,
        mountRoot: D.body,
        fetchPreview,
        getTheme,
        getDelayMs: () => settings.hoverPreviewDelayMs ?? 250,
        getAnimated: () => settings.videoPreviewAnimated !== false,
        isPreviewEnabled: () => settings.hoverPreviewEnabled !== false,
      });
    }
    if (!aeTreeInstance && W.AnchorWheelTree) {
      aeTreeInstance = W.AnchorWheelTree.createAeTree({
        document: D,
        mountRoot: D.body,
        fetchPreview,
        getTheme,
        getHotkey,
        getDelayMs: () => settings.hoverPreviewDelayMs ?? 250,
        getAnimated: () => settings.videoPreviewAnimated !== false,
        isPreviewEnabled: () => settings.hoverPreviewEnabled !== false,
      });
    }
    if (!settingsModalInstance && W.AnchorWheelSettingsModal) {
      settingsModalInstance = W.AnchorWheelSettingsModal.createSettingsModal({ document: D, mountRoot: D.body });
    }
  }

  function isAnyTabNavigatorOpen() {
    return Boolean(
      activeTabTriggerMode && (aeTreeInstance?.isOpen?.() || bilateralInstance?.isOpen?.() || wheelInstance?.isOpen?.())
    );
  }

  function sweepOrphanPreviewCards() {
    try {
      for (const el of D.querySelectorAll('.aw-preview-card')) {
        try { el.remove(); } catch {}
      }
    } catch {}
  }

  function closeAllNavigators() {
    activeTabTriggerMode = false;
    wheelInstance?.close?.();
    bilateralInstance?.close?.();
    aeTreeInstance?.close?.();
    sweepOrphanPreviewCards();
  }

  async function refreshPersistentNavigatorIfOpen() {
    if (!isAnyTabNavigatorOpen() || !activeFilePath) return;
    const ctx = await fetchNavContext(navScopeOverride);
    if (!ctx) return;
    if (aeTreeInstance?.isOpen?.()) aeTreeInstance.updateContext(ctx);
    else if (bilateralInstance?.isOpen?.()) bilateralInstance.updateContext(ctx);
    else if (wheelInstance?.isOpen?.()) {
      const target = getWheelTargetGroup();
      if (target) wheelInstance.updateGroup(target.group);
    }
  }

  async function onNavigatorSelect(picked, fromTabMode = false) {
    if (!picked?.path) return;
    const isGoingUp = Boolean(picked.isParent || picked.isAnchor);
    await handleLinkActivation(
      {
        path: picked.path,
        title: picked.title || baseName(picked.path),
        lineStart: picked.lineStart || null,
        isDirectory: Boolean(picked.isDirectory),
        skipLineage: isGoingUp,
      },
      { background: false }
    );
    if (fromTabMode && !settings.tabCloseOnSelect) {
      await refreshPersistentNavigatorIfOpen();
    } else if (fromTabMode && settings.tabCloseOnSelect) {
      closeAllNavigators();
    }
  }

  function openBilateralForContext(ctx, x, y, { holdMode = false, holdButton = 1, persistOnScroll = false, fromTabMode = false } = {}) {
    if (!ctx?.current) return false;
    ensureSharedInstances();
    if (!bilateralInstance) return false;
    settingsModalInstance?.close?.();
    closePopover();
    wheelInstance?.close?.();
    aeTreeInstance?.close?.();
    activeTabTriggerMode = Boolean(fromTabMode && !holdMode);
    bilateralInstance.open({
      context: ctx,
      x,
      y,
      holdMode,
      holdButton,
      persistOnScroll,
      closeOnSelect: fromTabMode ? Boolean(settings.tabCloseOnSelect) : false,
      parentDirection: settings.parentDirection || 'left',
      scope: navScopeOverride || ctx.childSourceScope || settings.childSourceScope || 'opened_and_outlinks',
      onSelect: (picked) => void onNavigatorSelect(picked, fromTabMode),
      onSwitchScope: async (nextScope) => {
        navScopeOverride = nextScope;
        const fresh = await fetchNavContext(nextScope);
        if (fresh) bilateralInstance.updateContext(fresh);
      },
      onClose: () => {
        if (!aeTreeInstance?.isOpen?.() && !wheelInstance?.isOpen?.()) activeTabTriggerMode = false;
      },
    });
    return true;
  }

  function openAeTreeForContext(ctx, { fromTabMode = true } = {}) {
    if (!ctx?.current) return false;
    ensureSharedInstances();
    if (!aeTreeInstance) return false;
    settingsModalInstance?.close?.();
    closePopover();
    wheelInstance?.close?.();
    bilateralInstance?.close?.();
    const col = getRightPaneColumn();
    const anchorRect = col ? col.getBoundingClientRect() : null;
    activeTabTriggerMode = Boolean(fromTabMode);
    aeTreeInstance.open({
      context: ctx,
      anchorRect,
      scope: navScopeOverride || ctx.childSourceScope || settings.childSourceScope || 'opened_and_outlinks',
      closeOnSelect: Boolean(settings.tabCloseOnSelect),
      onSelect: (picked) => void onNavigatorSelect(picked, fromTabMode),
      onSwitchScope: async (nextScope) => {
        navScopeOverride = nextScope;
        const fresh = await fetchNavContext(nextScope);
        if (fresh) aeTreeInstance.updateContext(fresh);
      },
      onClose: () => {
        if (!bilateralInstance?.isOpen?.() && !wheelInstance?.isOpen?.()) activeTabTriggerMode = false;
      },
    });
    return true;
  }

  function openClassicWheelForTarget(target, x, y, { holdMode = false, holdButton = 1, persistOnScroll = false, fromTabMode = false } = {}) {
    if (!target || !target.group) return false;
    ensureSharedInstances();
    if (!wheelInstance) return false;
    settingsModalInstance?.close?.();
    closePopover();
    bilateralInstance?.close?.();
    aeTreeInstance?.close?.();
    const { group, isLiveFallback } = target;
    activeTabTriggerMode = Boolean(fromTabMode && !holdMode);
    wheelInstance.open({
      group,
      x,
      y,
      holdMode,
      holdButton,
      persistOnScroll,
      closeOnSelect: holdMode || !fromTabMode || Boolean(settings.tabCloseOnSelect),
      sectors: settings.wheelSectors || 8,
      hubTag: isLiveFallback ? '当前页' : '母页',
      isLiveFallback,
      emptyHint: isLiveFallback
        ? (group.children?.length ? '当前已打开标签' : '点击下方设为母页或点 MD 链接')
        : '点击 MD 链接即收编进本组',
      onSelect: async (picked) => {
        if (!isLiveFallback) {
          await callRpc('sessionOp', { op: 'touchChild', groupId: group.id, path: picked.path });
        }
        await onNavigatorSelect({ ...picked, isParent: Boolean(picked.isAnchor) }, fromTabMode);
      },
      onToggleLock: isLiveFallback
        ? null
        : async (ch) => {
            const res = await callRpc('sessionOp', { op: 'toggleLock', groupId: group.id, path: ch.path });
            if (res.ok && res.session) {
              session = res.session;
              const updated = session.groups.find((g) => g.id === group.id);
              if (updated) wheelInstance.updateGroup(updated);
              renderStrip();
            }
          },
      onRemoveChild: isLiveFallback
        ? null
        : async (ch) => {
            const res = await callRpc('sessionOp', { op: 'removeChild', groupId: group.id, path: ch.path });
            if (res.ok && res.session) {
              session = res.session;
              const updated = session.groups.find((g) => g.id === group.id);
              if (updated) wheelInstance.updateGroup(updated);
              applyNonDestructiveTabFolding();
              renderStrip();
            }
          },
      onPinCurrent: activeFilePath
        ? async () => {
            const res = await callRpc('sessionOp', {
              op: 'pinAnchor',
              path: activeFilePath,
              title: baseName(activeFilePath),
              isDirectory: activeIsDirectory,
            });
            if (res.ok && res.session) session = res.session;
            applyNonDestructiveTabFolding();
            renderStrip();
            showToast(`已设为优先母页：${baseName(activeFilePath)}`);
          }
        : null,
      onShowOutlinks: activeFilePath
        ? () => {
            const linksBtn = D.querySelector(`#${STRIP_ID} [data-aw-role="links-btn"]`);
            if (linksBtn) openBacklinksPopover(linksBtn, 'outlinks');
          }
        : null,
    });
    return true;
  }

  function triggerTabNavigator(forcedMode = '') {
    if (isAnyTabNavigatorOpen()) {
      closeAllNavigators();
      return true;
    }
    const mode = forcedMode || settings.tabMode || 'ae_tree';
    if (mode === 'off') return false;
    const col = getRightPaneColumn();
    const rect = col ? col.getBoundingClientRect() : { left: W.innerWidth - 240, top: 180, width: 360, height: 420 };
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + Math.min(240, rect.height / 2);

    if (mode === 'classic_wheel') {
      const target = getWheelTargetGroup();
      if (!target) return false;
      return openClassicWheelForTarget(target, cx, cy, { holdMode: false, persistOnScroll: true, fromTabMode: true });
    }
    const syncCtx = getSyncNavContext(navScopeOverride);
    if (!syncCtx?.current) return false;
    const opened = mode === 'bilateral_wheel'
      ? openBilateralForContext(syncCtx, cx, cy, { holdMode: false, persistOnScroll: true, fromTabMode: true })
      : openAeTreeForContext(syncCtx, { fromTabMode: true });

    // Background refresh to ensure full backend lineage + categorized outlinks are up-to-date
    void fetchNavContext(navScopeOverride).then((fresh) => {
      if (!fresh) return;
      if (aeTreeInstance?.isOpen?.()) aeTreeInstance.updateContext(fresh);
      else if (bilateralInstance?.isOpen?.()) bilateralInstance.updateContext(fresh);
    });
    return opened;
  }

  // ── UI Mounting: Styles, Strip, Popovers ────────────────────────────────
  function ensureStyleTag() {
    let st = D.getElementById(STYLE_ID);
    if (!st) {
      st = markOwned(D.createElement('style'));
      st.id = STYLE_ID;
      st.textContent =
        (BOOT.wheelCss || '') +
        '\n.aw-native-strip{width:100%;min-height:36px;padding:4px 10px;background:var(--background,#0e0e11);border-bottom:1px solid var(--border,rgba(255,255,255,.08));color:var(--foreground,#f2f2f5);display:flex;align-items:center;gap:6px;flex-shrink:0;overflow:hidden;box-sizing:border-box;}\n';
      (D.head || D.documentElement).appendChild(st);
    }
  }

  function getPortalRoot() {
    let portal = D.getElementById(PORTAL_ID);
    if (!portal) {
      portal = markOwned(D.createElement('div'));
      portal.id = PORTAL_ID;
      D.body.appendChild(portal);
    }
    applyThemeAttr(portal);
    return portal;
  }

  function closePopover() {
    const portal = D.getElementById(PORTAL_ID);
    if (portal) portal.innerHTML = '';
    activePopoverName = '';
  }

  function getActiveGroup() {
    const groups = session?.groups || [];
    if (!groups.length) return null;
    return groups.find((g) => g.id === session.activeGroupId) || groups[0];
  }

  function findGroupRole(filePath) {
    const k = normKey(filePath);
    for (const g of session?.groups || []) {
      if (normKey(g.anchorPath) === k) return { group: g, role: 'anchor' };
      if (g.children?.some((c) => normKey(c.path) === k)) return { group: g, role: 'child' };
    }
    return null;
  }

  function buildLiveTabsGroup() {
    const { browserCtx, reduxStore } = discoverHostBridge();
    const { pane } = getPaneSlice(reduxStore, browserCtx);
    const openItems = collectNativeOpenTabs(pane);
    const anchorPath = activeFilePath || openItems[0]?.path || '';
    if (!anchorPath) return null;
    const anchorKey = normKey(anchorPath);
    return {
      id: '__live_tabs__',
      anchorPath,
      anchorTitle: baseName(anchorPath),
      children: openItems.filter((item) => normKey(item.path) !== anchorKey),
    };
  }

  function getWheelTargetGroup() {
    const activeGrp = getActiveGroup();
    if (activeGrp) return { group: activeGrp, isLiveFallback: false };
    const live = buildLiveTabsGroup();
    if (live) return { group: live, isLiveFallback: true };
    return null;
  }

  function getEffectiveHistory() {
    if (session?.history?.entries?.length) return session.history;
    return localHistory;
  }

  function pushLocalHistory(entry) {
    if (!entry?.path) return;
    const key = normKey(entry.path);
    const cur = localHistory.index >= 0 ? localHistory.entries[localHistory.index] : null;
    if (cur && normKey(cur.path) === key) {
      localHistory.entries[localHistory.index] = { ...cur, ...entry };
      return;
    }
    const branch = localHistory.index >= 0 ? localHistory.entries.slice(0, localHistory.index + 1) : [];
    branch.push({ scrollTop: 0, ...entry });
    if (branch.length > 60) branch.splice(0, branch.length - 60);
    localHistory = { entries: branch, index: branch.length - 1 };
  }

  async function recordHistoryPush(entry) {
    pushLocalHistory(entry);
    const res = await callRpc('sessionOp', { op: 'history', historyAction: 'push', entry });
    if (res.ok && res.session) session = res.session;
  }

  async function pushCurrentScroll() {
    const sc = findScrollContainer(getRightPaneColumn());
    if (sc && activeFilePath) {
      if (localHistory.index >= 0 && localHistory.entries[localHistory.index]) {
        localHistory.entries[localHistory.index].scrollTop = sc.scrollTop;
      }
      await callRpc('sessionOp', { op: 'history', historyAction: 'updateScroll', scrollTop: sc.scrollTop });
    }
  }

  async function stepHistory(dir) {
    await pushCurrentScroll();
    const res = await callRpc('sessionOp', { op: 'history', historyAction: dir });
    let targetEntry = null;
    if (res.ok && res.session) {
      session = res.session;
      targetEntry = res.targetEntry || null;
    }
    if (!targetEntry) {
      const delta = dir === 'back' ? -1 : 1;
      const nextIdx = localHistory.index + delta;
      if (nextIdx >= 0 && nextIdx < localHistory.entries.length) {
        localHistory.index = nextIdx;
        targetEntry = localHistory.entries[nextIdx];
      }
    } else if (session?.history?.entries?.length) {
      localHistory = {
        entries: session.history.entries.map((e) => ({ ...e })),
        index: Number(session.history.index ?? -1),
      };
    }

    if (targetEntry?.path) {
      activeFilePath = targetEntry.path;
      activeIsDirectory = Boolean(targetEntry.isDirectory);
      openPathInNativeTab(targetEntry.path, { isDirectory: activeIsDirectory });
      const targetScroll = targetEntry.scrollTop || 0;
      setTimeout(() => {
        const sc = findScrollContainer(getRightPaneColumn());
        if (sc) sc.scrollTop = targetScroll;
      }, 120);
      await refreshState();
      await refreshPersistentNavigatorIfOpen();
    } else {
      renderStrip();
    }
  }

  function showToast(msg) {
    const old = D.getElementById('aw-native-toast');
    if (old) old.remove();
    const t = markOwned(D.createElement('div'));
    t.id = 'aw-native-toast';
    t.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483100;padding:8px 12px;border-radius:8px;background:var(--ag-cs-popover-bg,rgba(22,23,30,.96));border:1px solid var(--card-border,rgba(255,255,255,.14));color:var(--foreground,#f2f2f5);font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.35);';
    t.textContent = msg;
    D.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function positionPortalPopover(pop, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const vw = W.innerWidth || 1200;
    const vh = W.innerHeight || 800;
    const w = Math.min(370, vw - 20);
    pop.style.left = `${Math.max(10, Math.min(vw - w - 10, rect.right - w))}px`;
    pop.style.top = `${Math.min(vh - 140, rect.bottom + 6)}px`;
  }

  function openBacklinksPopover(anchorEl, forcedTab = '') {
    closeAllNavigators();
    if (activePopoverName === 'links' && !forcedTab) {
      closePopover();
      return;
    }
    closePopover();
    activePopoverName = 'links';

    const portal = getPortalRoot();
    const pop = markOwned(D.createElement('div'));
    pop.className = 'aw-popover';
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    pop.addEventListener('mousedown', (ev) => ev.stopPropagation());

    const isDirMode = activeIsDirectory;
    const backInit = activeFileLinks.backlinks || [];
    const dirInit = isDirMode && Array.isArray(cachedNavContext?.current?.children) ? cachedNavContext.current.children : [];
    const outInit = isDirMode ? dirInit : activeFileLinks.outlinks || [];
    const secondTabLabel = isDirMode ? '目录文件' : '本文出链';
    let tab = forcedTab || (isDirMode ? (dirInit.length > 0 ? 'outlinks' : 'backlinks') : backInit.length > 0 ? 'backlinks' : outInit.length > 0 ? 'outlinks' : 'backlinks');
    let filterText = '';
    const esc = (s) => (S?.esc ? S.esc(s) : String(s || ''));

    pop.innerHTML = `
      <div class="aw-popover-head">
        <div class="aw-tray" style="flex:1">
          <button type="button" class="aw-tray-btn" style="flex:1" data-aw-ltab="backlinks" data-active="${tab === 'backlinks' ? '1' : '0'}">反向引用 (${backInit.length})</button>
          <button type="button" class="aw-tray-btn" style="flex:1" data-aw-ltab="outlinks" data-active="${tab === 'outlinks' ? '1' : '0'}">${secondTabLabel} (${outInit.length})</button>
        </div>
        <button type="button" class="aw-tray-btn" id="aw-np-close">${S.ICONS.close}</button>
      </div>
      <div class="aw-popover-filter" hidden>
        <input type="text" class="aw-input" id="aw-np-filter" placeholder="筛选文件名或路径..." />
      </div>
      <div class="aw-popover-body"></div>
    `;

    const filterWrap = pop.querySelector('.aw-popover-filter');
    const filterInput = pop.querySelector('#aw-np-filter');
    const bodyEl = pop.querySelector('.aw-popover-body');

    const renderBody = () => {
      const back = activeFileLinks.backlinks || [];
      const dirFiles = isDirMode && Array.isArray(cachedNavContext?.current?.children) ? cachedNavContext.current.children : [];
      const out = isDirMode ? dirFiles : activeFileLinks.outlinks || [];
      for (const tBtn of pop.querySelectorAll('[data-aw-ltab]')) {
        const key = tBtn.getAttribute('data-aw-ltab');
        tBtn.setAttribute('data-active', tab === key ? '1' : '0');
        tBtn.textContent = key === 'backlinks' ? `反向引用 (${back.length})` : `${secondTabLabel} (${out.length})`;
      }
      const activeList = tab === 'backlinks' ? back : out;
      if (filterWrap) filterWrap.hidden = activeList.length <= 8;
      const q = filterText.trim().toLowerCase();

      if (tab === 'backlinks') {
        const filtered = q
          ? back.filter((b) => String(b.sourceTitle || '').toLowerCase().includes(q) || String(b.sourcePath || '').toLowerCase().includes(q) || String(b.snippet || '').toLowerCase().includes(q))
          : back;
        bodyEl.innerHTML = filtered.length
          ? filtered
              .map(
                (b) => `
              <button type="button" class="aw-link-row" data-aw-jump="${esc(b.sourcePath)}" data-aw-line="${b.line}" data-aw-dir="0">
                <div class="aw-link-row-top"><span class="aw-link-row-title">${esc(b.sourceTitle)}</span><span class="aw-link-row-badge">${b.isArtifact ? '报告' : '工作区'} · L${b.line}</span></div>
                <div class="aw-link-row-snippet">${esc(b.snippet)}</div>
              </button>`
              )
              .join('')
          : `<div class="aw-link-row-snippet">${back.length ? '无匹配的反向引用记录。' : isDirMode ? '暂无 Markdown 文档引用当前文件夹。' : '暂无其他 Markdown 文档引用当前文件。'}</div>`;
      } else if (isDirMode) {
        const filtered = q
          ? dirFiles.filter(
              (f) =>
                String(f.title || '').toLowerCase().includes(q) ||
                String(f.categoryLabel || '').toLowerCase().includes(q) ||
                String(f.path || '').toLowerCase().includes(q)
            )
          : dirFiles;
        bodyEl.innerHTML = filtered.length
          ? filtered
              .map(
                (f) => `
              <button type="button" class="aw-link-row" data-aw-jump="${esc(f.path)}" data-aw-line="" data-aw-dir="0">
                <div class="aw-link-row-top">
                  <span class="aw-link-row-title" style="display:inline-flex;align-items:center;gap:6px">${S.pickIconForItem(f)}<span>${esc(f.title || baseName(f.path))}</span></span>
                  <span class="aw-link-row-badge">${esc(f.categoryLabel || '其他')}${f.isOpenedTab ? ' · 已开' : ''}</span>
                </div>
                <div class="aw-link-row-snippet">${esc(f.path)}</div>
              </button>`
              )
              .join('')
          : `<div class="aw-link-row-snippet">${dirFiles.length ? '无匹配的直属文件。' : '当前文件夹暂无直属文件。'}</div>`;
      } else {
        const filtered = q
          ? out.filter((o) => String(o.label || '').toLowerCase().includes(q) || String(o.resolvedPath || '').toLowerCase().includes(q))
          : out;
        bodyEl.innerHTML = filtered.length
          ? filtered
              .map((o) => {
                const isDir = Boolean(o.isDirectory || /[\\/]$/.test(o.rawTarget || ''));
                return `
              <button type="button" class="aw-link-row" data-aw-jump="${esc(o.resolvedPath)}" data-aw-line="${o.lineStart || ''}" data-aw-dir="${isDir ? '1' : '0'}" ${o.exists ? '' : 'disabled'}>
                <div class="aw-link-row-top"><span class="aw-link-row-title">${esc(o.label || baseName(o.resolvedPath))}</span><span class="aw-link-row-badge" data-dead="${o.exists ? '0' : '1'}">${o.exists ? `L${o.line}` : '路径不存在'}</span></div>
                <div class="aw-link-row-snippet">${esc(o.resolvedPath)}</div>
              </button>`;
              })
              .join('')
          : `<div class="aw-link-row-snippet">${out.length ? '无匹配的出链记录。' : '当前文档暂无本地出链。'}</div>`;
      }

      for (const jBtn of bodyEl.querySelectorAll('[data-aw-jump]')) {
        jBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const p = jBtn.getAttribute('data-aw-jump');
          const ln = Number(jBtn.getAttribute('data-aw-line')) || null;
          const isDirectory = jBtn.getAttribute('data-aw-dir') === '1';
          closePopover();
          await handleLinkActivation({ path: p, title: baseName(p), lineStart: ln, isDirectory }, { background: false });
        });
      }
    };

    pop.querySelector('#aw-np-close')?.addEventListener('click', (ev) => { ev.stopPropagation(); closePopover(); });
    for (const tBtn of pop.querySelectorAll('[data-aw-ltab]')) {
      tBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const nextTab = tBtn.getAttribute('data-aw-ltab');
        if (nextTab && nextTab !== tab) { tab = nextTab; renderBody(); }
      });
    }
    filterInput?.addEventListener('input', (ev) => { filterText = ev.currentTarget.value || ''; renderBody(); });

    renderBody();
    portal.appendChild(pop);
    positionPortalPopover(pop, anchorEl);
  }

  async function toggleEncodingRepairOverlay(overrideEncoding = '') {
    const col = getRightPaneColumn();
    const contentWrap = getContentContainer(col);
    if (!contentWrap || !activeFilePath) return;

    const existing = D.getElementById(OVERLAY_ID);
    if (existing && !overrideEncoding) {
      existing.remove();
      for (const ch of Array.from(contentWrap.children)) {
        if (ch.hasAttribute('data-aw-orig-hidden')) {
          ch.style.display = ch.getAttribute('data-aw-orig-disp') || '';
          ch.removeAttribute('data-aw-orig-hidden');
          ch.removeAttribute('data-aw-orig-disp');
        }
      }
      encodingOverlayVisible = false;
      renderStrip();
      return;
    }

    const res = await callRpc('readFile', { path: activeFilePath, encoding: overrideEncoding });
    if (!res.ok) {
      showToast(`读取失败：${res.error || '未知错误'}`);
      return;
    }

    for (const ch of Array.from(contentWrap.children)) {
      if (ch.id === OVERLAY_ID) continue;
      if (!ch.hasAttribute('data-aw-orig-hidden')) {
        ch.setAttribute('data-aw-orig-hidden', '1');
        ch.setAttribute('data-aw-orig-disp', ch.style.display || '');
        ch.style.display = 'none';
      }
    }

    const overlay = existing || markOwned(D.createElement('div'));
    overlay.id = OVERLAY_ID;
    overlay.className = 'aw-encoding-overlay';
    applyThemeAttr(overlay);
    const isMd = /\.(md|mdx)$/i.test(activeFilePath);
    const bodyHtml = isMd
      ? `<article class="aw-md-doc">${W.AnchorWheelMarkdown.renderMarkdown(res.text)}</article>`
      : W.AnchorWheelMarkdown.renderCodeLines(res.text);

    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:8px 12px;margin-bottom:12px;border-radius:8px;background:var(--card,#141418);border:1px solid var(--card-border,rgba(255,255,255,.12));">
        <span>编码重解码视图 · <strong>${String(res.encoding || 'utf-8').toUpperCase()}</strong></span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <select id="aw-ov-enc-sel" class="aw-select">
            ${['utf-8', 'gb18030', 'gbk', 'utf-16le', 'utf-16be', 'shift_jis', 'big5', 'windows-1252']
              .map((e) => `<option value="${e}" ${res.encoding === e ? 'selected' : ''}>${e.toUpperCase()}</option>`)
              .join('')}
          </select>
          <button type="button" id="aw-ov-conv" class="aw-primary-btn">转为 UTF-8 保存</button>
          <button type="button" id="aw-ov-close" class="aw-ghost-btn">恢复原生视图</button>
        </div>
      </div>
      ${bodyHtml}
    `;
    if (!existing) contentWrap.appendChild(overlay);
    encodingOverlayVisible = true;

    overlay.querySelector('#aw-ov-enc-sel')?.addEventListener('change', (e) => void toggleEncodingRepairOverlay(e.currentTarget.value));
    overlay.querySelector('#aw-ov-conv')?.addEventListener('click', async () => {
      const conv = await callRpc('convertUtf8', { path: activeFilePath, encoding: res.encoding, confirm: true });
      if (conv.ok) {
        showToast(conv.alreadyUtf8 ? '已是 UTF-8' : '已安全转为 UTF-8 并留存 .bak.encoding 备份');
        await toggleEncodingRepairOverlay('');
        await refreshState();
      } else {
        showToast(`转换失败：${conv.error}`);
      }
    });
    overlay.querySelector('#aw-ov-close')?.addEventListener('click', () => void toggleEncodingRepairOverlay(''));
    renderStrip();
  }

  function getHostCompatibilityDiag() {
    const { browserCtx, reduxStore, router } = discoverHostBridge();
    const col = getRightPaneColumn();
    return {
      hasRedux: Boolean(reduxStore),
      hasBrowserCtx: Boolean(browserCtx),
      hasRouter: Boolean(router),
      hasRightPane: Boolean(col),
      hasContentWrap: Boolean(getContentContainer(col)),
    };
  }

  function openSettingsModal() {
    closePopover();
    closeAllNavigators();
    ensureSharedInstances();
    if (!settingsModalInstance) return;
    settingsModalInstance.open({
      settings,
      evicted: session?.recentlyEvicted || [],
      versionInfo: {
        version: bootMeta.version || '',
        repoUrl: bootMeta.repoUrl,
        releasesUrl: bootMeta.releasesUrl,
      },
      compatInfo: bootMeta.compatibility,
      hostDiag: getHostCompatibilityDiag(),
      updateInfo: latestUpdateInfo,
      onCheckUpdate: async (force = true) => {
        const res = await callRpc('checkUpdate', { force: Boolean(force) }, 10000);
        if (res && (res.ok || res.error)) {
          latestUpdateInfo = res;
          renderStrip();
        }
        return res;
      },
      onSave: async (next) => {
        const res = await callRpc('updateSettings', { settings: next });
        if (res.ok && res.settings) {
          settings = res.settings;
        } else {
          settings = { ...settings, ...next };
        }
        navScopeOverride = '';
        applyThemeToNativeNodes();
        applyNonDestructiveTabFolding();
        cachedNavContext = await fetchNavContext();
        renderStrip();
        showToast('锚点轮盘设置已生效');
      },
      onRestoreEvicted: async (p, gid) => {
        const res = await callRpc('sessionOp', { op: 'restoreEvicted', groupId: gid, path: p });
        if (res.ok && res.session) session = res.session;
        openPathInNativeTab(p);
        await refreshState();
      },
    });
  }

  function renderStrip() {
    const col = getRightPaneColumn();
    const contentEl = getContentContainer(col);
    if (!col || !contentEl) return;

    let strip = D.getElementById(STRIP_ID);
    if (!strip || !strip.isConnected) {
      strip = markOwned(D.createElement('div'));
      strip.id = STRIP_ID;
      strip.className = 'aw-native-strip';
      col.insertBefore(strip, contentEl);
    }
    applyThemeAttr(strip);

    const hist = getEffectiveHistory();
    const canBack = hist.index > 0;
    const canFwd = hist.index >= 0 && hist.index < hist.entries.length - 1;
    const activeGrp = getActiveGroup();
    const roleInfo = findGroupRole(activeFilePath);
    const backCount = activeFileLinks.backlinks?.length || 0;
    const outCount = activeFileLinks.outlinks?.length || 0;

    strip.innerHTML = '';

    const navTray = markOwned(D.createElement('div'));
    navTray.className = 'aw-tray';
    const bBack = markOwned(D.createElement('button'));
    bBack.className = 'aw-tray-btn';
    bBack.disabled = !canBack;
    bBack.title = '回到上一页 (Alt+← / 鼠标侧键)';
    bBack.innerHTML = '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="15 18 9 12 15 6"/></svg>';
    bBack.addEventListener('click', () => void stepHistory('back'));

    const bFwd = markOwned(D.createElement('button'));
    bFwd.className = 'aw-tray-btn';
    bFwd.disabled = !canFwd;
    bFwd.title = '前进 (Alt+→)';
    bFwd.innerHTML = '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="9 18 15 12 9 6"/></svg>';
    bFwd.addEventListener('click', () => void stepHistory('forward'));
    navTray.appendChild(bBack);
    navTray.appendChild(bFwd);
    strip.appendChild(navTray);

    if (activeGrp) {
      const pill = markOwned(D.createElement('button'));
      pill.className = 'aw-anchor-pill';
      pill.title = `优先母页：${activeGrp.anchorPath}\n点击回母页，点数字呼出轮盘；支持直接拖入文件链接`;
      pill.innerHTML = `${S.ICONS.anchor}<span class="aw-anchor-pill-name"></span><span class="aw-count-badge">${activeGrp.children?.length || 0}</span>`;
      pill.querySelector('.aw-anchor-pill-name').textContent = baseName(activeGrp.anchorTitle || activeGrp.anchorPath);

      const badge = pill.querySelector('.aw-count-badge');
      pill.addEventListener('click', (ev) => {
        if (ev.target === badge || normKey(activeFilePath) === normKey(activeGrp.anchorPath)) {
          const rect = pill.getBoundingClientRect();
          openClassicWheelForTarget({ group: activeGrp, isLiveFallback: false }, rect.left + rect.width / 2, rect.bottom + 145, { holdMode: false });
        } else {
          void pushCurrentScroll().then(() => {
            openPathInNativeTab(activeGrp.anchorPath, { isDirectory: Boolean(activeGrp.anchorIsDirectory) });
            void refreshState();
          });
        }
      });

      pill.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        pill.setAttribute('data-dragover', '1');
      });
      pill.addEventListener('dragleave', () => pill.removeAttribute('data-dragover'));
      pill.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        pill.removeAttribute('data-dragover');
        if (dragPayload?.path) {
          const dropped = dragPayload;
          dragPayload = null;
          const res = await callRpc('sessionOp', {
            op: 'adoptChild',
            groupId: activeGrp.id,
            directParentPath: activeFilePath || activeGrp.anchorPath,
            directParentTitle: baseName(activeFilePath || activeGrp.anchorPath),
            childPath: dropped.path,
            childTitle: dropped.title,
          });
          if (res.ok && res.session) session = res.session;
          if (res.evicted?.length) closeNativeTabsByKeys(res.evicted.map((x) => x.path));
          openPathInNativeTab(dropped.path, { lineStart: dropped.lineStart, isDirectory: Boolean(dropped.isDirectory) });
          await refreshState();
        }
      });
      strip.appendChild(pill);
    }

    if (activeFilePath && (activeIsDirectory || /\.(md|mdx|txt)$/i.test(activeFilePath)) && (!roleInfo || roleInfo.role !== 'anchor')) {
      const pinBtn = markOwned(D.createElement('button'));
      pinBtn.className = 'aw-status-pill';
      pinBtn.textContent = '设为母页';
      pinBtn.title = activeIsDirectory ? '把当前文件夹钉为优先母页，折叠收编打开的子文件' : '把当前文档钉为优先母页，折叠收编关联子标签';
      pinBtn.addEventListener('click', async () => {
        const res = await callRpc('sessionOp', {
          op: 'pinAnchor',
          path: activeFilePath,
          title: baseName(activeFilePath),
          isDirectory: activeIsDirectory,
        });
        if (res.ok && res.session) session = res.session;
        applyNonDestructiveTabFolding();
        renderStrip();
      });
      strip.appendChild(pinBtn);
    } else if (roleInfo && roleInfo.role === 'anchor') {
      const unpinBtn = markOwned(D.createElement('button'));
      unpinBtn.className = 'aw-status-pill';
      unpinBtn.textContent = '解绑';
      unpinBtn.title = '取消当前优先母页分组，释放全部折叠标签';
      unpinBtn.addEventListener('click', async () => {
        const res = await callRpc('sessionOp', { op: 'unpinGroup', groupId: roleInfo.group.id });
        if (res.ok && res.session) session = res.session;
        applyNonDestructiveTabFolding();
        renderStrip();
      });
      strip.appendChild(unpinBtn);
    }

    const spacer = markOwned(D.createElement('div'));
    spacer.className = 'aw-strip-spacer';
    strip.appendChild(spacer);

    if (activeFilePath) {
      const treeBtn = markOwned(D.createElement('button'));
      treeBtn.className = 'aw-status-pill';
      treeBtn.setAttribute('data-aw-role', 'tree-btn');
      treeBtn.title = `常驻层级导览 (默认按 ${settings.tabCustomHotkey || 'Tab'} 呼出与关闭)`;
      treeBtn.innerHTML = `${S.ICONS.tree}<span>层级</span>`;
      treeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerTabNavigator();
      });
      strip.appendChild(treeBtn);

      const linksBtn = markOwned(D.createElement('button'));
      linksBtn.className = 'aw-status-pill';
      linksBtn.setAttribute('data-aw-role', 'links-btn');
      if (backCount > 0) linksBtn.setAttribute('data-has-links', '1');
      if (activeIsDirectory) {
        const dirCount = cachedNavContext?.current?.children?.length || 0;
        linksBtn.textContent = backCount > 0 ? `被 ${backCount} 引用 · ${dirCount} 文件` : `目录 ${dirCount} 文件`;
        linksBtn.title = '查看文件夹直属文件与反向引用';
      } else {
        linksBtn.textContent = backCount > 0 ? `被 ${backCount} 引用` : `出链 ${outCount}`;
        linksBtn.title = '查看反向引用与文档出链';
      }
      linksBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBacklinksPopover(e.currentTarget);
      });
      strip.appendChild(linksBtn);
    }

    const domHasMojibake = (() => {
      if (!contentEl || activeIsDirectory) return false;
      return (contentEl.textContent || '').slice(0, 2000).includes('\uFFFD');
    })();
    if (activeFilePath && !activeIsDirectory && (activeEncodingInfo?.isNonUtf8 || activeEncodingInfo?.mojibakeHint || domHasMojibake || encodingOverlayVisible)) {
      const encBtn = markOwned(D.createElement('button'));
      encBtn.className = 'aw-status-pill';
      encBtn.setAttribute('data-warn', '1');
      encBtn.textContent = encodingOverlayVisible ? '恢复原生' : `修复乱码 (${String(activeEncodingInfo?.encoding || 'GBK').toUpperCase()})`;
      encBtn.addEventListener('click', () => void toggleEncodingRepairOverlay(''));
      strip.appendChild(encBtn);
    }

    const setBtn = markOwned(D.createElement('button'));
    setBtn.className = 'aw-tray-btn';
    setBtn.setAttribute('data-aw-role', 'settings-btn');
    if (latestUpdateInfo?.ok && latestUpdateInfo?.updateAvailable) {
      setBtn.setAttribute('data-has-update', '1');
      setBtn.title = `锚点轮盘设置（发现新版 v${latestUpdateInfo.latestVersion}）`;
    } else {
      setBtn.title = '锚点轮盘设置与交互图解';
    }
    setBtn.innerHTML = '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    setBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsModal();
    });
    strip.appendChild(setBtn);
  }

  async function refreshState() {
    if (destroyed) return;
    const curCid = resolveConversationId();
    const switchedConv = Boolean(lastConversationId && curCid !== lastConversationId);
    if (switchedConv) {
      // Isolate session state cleanly when user switches Antigravity conversations
      session = null;
      cachedNavContext = null;
      activeFilePath = '';
      activeIsDirectory = false;
      activeFileLinks = { backlinks: [], outlinks: [] };
      activeEncodingInfo = null;
      localHistory = { entries: [], index: -1 };
      closeAllNavigators();
      closePopover();
    }
    lastConversationId = curCid;

    const { browserCtx, reduxStore } = discoverHostBridge();
    const { pane } = getPaneSlice(reduxStore, browserCtx);
    const activeInfo = getActiveNativeTabInfo(pane);
    const curFile = activeInfo.path;
    const curIsDir = activeInfo.isDirectory;
    const wsRoots = discoverWorkspaceRoots(reduxStore);

    if (!session) {
      const bootRes = await callRpc('getBoot');
      if (bootRes.ok) {
        settings = bootRes.settings || settings;
        session = bootRes.session;
        bootMeta = {
          version: bootRes.version || bootMeta.version,
          repoUrl: bootRes.repoUrl || bootMeta.repoUrl,
          releasesUrl: bootRes.releasesUrl || bootMeta.releasesUrl,
          compatibility: bootRes.compatibility || bootMeta.compatibility,
        };
        applyThemeToNativeNodes();
        if (bootRes.updateInfo) latestUpdateInfo = bootRes.updateInfo;
        if (settings.autoCheckUpdates !== false && !bgUpdateAttempted) {
          bgUpdateAttempted = true;
          clearTimeout(bgUpdateTimer);
          bgUpdateTimer = setTimeout(async () => {
            bgUpdateTimer = null;
            if (destroyed) return;
            const u = await callRpc('checkUpdate', { force: false }, 9000);
            if (!destroyed && u && (u.ok || u.error)) {
              latestUpdateInfo = u;
              renderStrip();
            }
          }, 2200);
        }
      }
    }

    const prevPath = activeFilePath;
    const prevIsDir = activeIsDirectory;
    const changedFile = curFile !== activeFilePath || curIsDir !== activeIsDirectory;
    if (changedFile) {
      const oldOv = D.getElementById(OVERLAY_ID);
      if (oldOv) void toggleEncodingRepairOverlay('');
      activeFilePath = curFile;
      activeIsDirectory = curIsDir;
    }

    if (!D.getElementById(STRIP_ID) && getContentContainer(getRightPaneColumn())) {
      renderStrip();
    }

    if (changedFile && curFile) {
      await recordHistoryPush({ path: curFile, title: baseName(curFile), isDirectory: curIsDir });
      // Fallback lineage safety net: if user navigated directly from a folder view into one of its direct files
      if (
        prevPath &&
        prevIsDir &&
        !curIsDir &&
        normKey(parentDirPath(curFile)) === normKey(prevPath) &&
        !session?.lineage?.parentByKey?.[normKey(curFile)]
      ) {
        recordLocalLineageMirror(prevPath, baseName(prevPath), curFile, baseName(curFile), {
          parentIsDirectory: true,
          childIsDirectory: false,
        });
        const lRes = await callRpc('sessionOp', {
          op: 'recordLineage',
          parentPath: prevPath,
          parentTitle: baseName(prevPath),
          parentIsDirectory: true,
          childPath: curFile,
          childTitle: baseName(curFile),
          childIsDirectory: false,
        });
        if (lRes?.ok && lRes.session) session = lRes.session;
      }
    }

    if (activeFilePath && (changedFile || !activeFileLinks.path)) {
      const [linksRes, encRes] = await Promise.all([
        callRpc('getBacklinks', { path: activeFilePath, workspaceRoots: wsRoots }),
        !activeIsDirectory && settings.encodingAutoDetect !== false
          ? callRpc('inspectEncoding', { path: activeFilePath })
          : Promise.resolve({ ok: false }),
      ]);
      if (linksRes.ok) activeFileLinks = linksRes;
      activeEncodingInfo = encRes.ok ? encRes : null;
    } else if (!activeFilePath) {
      activeFileLinks = { backlinks: [], outlinks: [] };
      activeEncodingInfo = null;
      cachedNavContext = null;
    }

    if (activeFilePath) {
      cachedNavContext = await fetchNavContext(navScopeOverride);
    }

    applyNonDestructiveTabFolding();
    renderStrip();
    await refreshPersistentNavigatorIfOpen();
  }

  function scheduleSync() {
    if (destroyed || syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void refreshState();
    }, 90);
  }

  // ── Event Interception ──────────────────────────────────────────────────
  function isInsideRightContent(target) {
    const col = getRightPaneColumn();
    const contentEl = getContentContainer(col);
    return Boolean(contentEl && contentEl.contains(target));
  }

  function isInsideNativeTabBar(target) {
    const tabBar = getNativeTabBar(getRightPaneColumn());
    return Boolean(tabBar && tabBar.contains(target));
  }

  function recordLocalLineageMirror(
    parentPath,
    parentTitle,
    childPath,
    childTitle,
    { parentIsDirectory = false, childIsDirectory = false } = {}
  ) {
    if (!parentPath || !childPath) return;
    const pKey = normKey(parentPath);
    const cKey = normKey(childPath);
    if (!pKey || !cKey || pKey === cKey) return;
    if (!session) session = { groups: [], history: { entries: [], index: -1 }, recentlyEvicted: [], lineage: { parentByKey: {} } };
    if (!session.lineage) session.lineage = { parentByKey: {} };
    const map = session.lineage.parentByKey;
    // Prevent cycle locally too
    let cur = pKey;
    for (let i = 0; i < 12 && cur; i++) {
      if (cur === cKey) return;
      cur = map[cur]?.parentKey || '';
    }
    map[cKey] = {
      parentPath,
      parentKey: pKey,
      parentTitle: parentTitle || baseName(parentPath),
      parentIsDirectory: Boolean(parentIsDirectory),
      childPath,
      childKey: cKey,
      childTitle: childTitle || baseName(childPath),
      childIsDirectory: Boolean(childIsDirectory),
      openedAt: Date.now(),
    };
  }

  async function handleLinkActivation(meta, { background = false } = {}) {
    const openerPath = activeFilePath;
    const openerIsDir = activeIsDirectory;
    const openerTitle = (!openerIsDir && activeFileLinks.title) || baseName(openerPath);
    const targetIsDir = inferKnownDirectoryFlag(meta?.path, Boolean(meta?.isDirectory));
    await pushCurrentScroll();

    if (openerPath && meta?.path && !meta.skipLineage && normKey(openerPath) !== normKey(meta.path)) {
      recordLocalLineageMirror(openerPath, openerTitle, meta.path, meta.title, {
        parentIsDirectory: openerIsDir,
        childIsDirectory: targetIsDir,
      });
      void callRpc('sessionOp', {
        op: 'recordLineage',
        parentPath: openerPath,
        parentTitle: openerTitle,
        parentIsDirectory: openerIsDir,
        childPath: meta.path,
        childTitle: meta.title,
        childIsDirectory: targetIsDir,
      }).then((res) => {
        if (res?.ok && res.session) session = res.session;
      });
    }

    let targetGroupId = null;
    const role = findGroupRole(openerPath);
    if (role) {
      targetGroupId = role.group.id;
    } else if (settings.autoAnchorSummaryMd && openerPath && !openerIsDir && /\.(md|mdx)$/i.test(openerPath) && (activeFileLinks.outlinks?.length || 0) >= 3) {
      const pinRes = await callRpc('sessionOp', { op: 'pinAnchor', path: openerPath, title: openerTitle, isDirectory: false });
      if (pinRes.ok && pinRes.session) {
        session = pinRes.session;
        targetGroupId = findGroupRole(openerPath)?.group?.id || null;
      }
    }

    if (targetGroupId) {
      const adoptRes = await callRpc('sessionOp', {
        op: 'adoptChild',
        groupId: targetGroupId,
        directParentPath: meta.skipLineage ? '' : openerPath,
        directParentTitle: meta.skipLineage ? '' : openerTitle,
        directParentIsDirectory: meta.skipLineage ? false : openerIsDir,
        childPath: meta.path,
        childTitle: meta.title,
        childIsDirectory: targetIsDir,
      });
      if (adoptRes.ok && adoptRes.session) session = adoptRes.session;
      if (adoptRes.evicted?.length) closeNativeTabsByKeys(adoptRes.evicted.map((x) => x.path));
    }

    openPathInNativeTab(meta.path, {
      background,
      lineStart: meta.lineStart,
      isDirectory: targetIsDir,
    });

    if (background) {
      showToast(`已后台收入组：${meta.title}`);
      applyNonDestructiveTabFolding();
      renderStrip();
    } else {
      activeFilePath = meta.path;
      activeIsDirectory = targetIsDir;
      await recordHistoryPush({
        path: meta.path,
        title: meta.title,
        line: meta.lineStart,
        isDirectory: targetIsDir,
      });
      await refreshState();
    }
  }

  function onCaptureClick(ev) {
    if (destroyed || ev.button !== 0 || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (!isInsideRightContent(ev.target)) return;
    let meta = extractLinkMetaFromTarget(ev.target);
    if (!meta && activeIsDirectory) {
      const rowMeta = extractDirectoryRowMetaFromTarget(ev.target);
      // Intercept direct file clicks inside directoryView so the parent folder tab is preserved;
      // leave subfolder clicks untouched so native folder browsing continues normally.
      if (rowMeta && !rowMeta.isDirectory) meta = rowMeta;
    }
    if (!meta) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    void handleLinkActivation(meta, { background: false });
  }

  function onCaptureMouseDown(ev) {
    if (destroyed || ev.button !== 1) return;
    if (!isInsideRightContent(ev.target)) return;
    const midMode = settings.middleMode || 'bilateral_wheel';
    if (extractLinkMetaFromTarget(ev.target) || (activeIsDirectory && extractDirectoryRowMetaFromTarget(ev.target)) || midMode !== 'off') {
      ev.preventDefault();
    }
  }

  function onCaptureAuxClick(ev) {
    if (destroyed || ev.button !== 1) return;
    if (suppressNextAuxClick) {
      suppressNextAuxClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      return;
    }
    if (!isInsideRightContent(ev.target)) return;
    let meta = extractLinkMetaFromTarget(ev.target);
    if (!meta && activeIsDirectory) {
      const rowMeta = extractDirectoryRowMetaFromTarget(ev.target);
      if (rowMeta && !rowMeta.isDirectory) meta = rowMeta;
    }
    if (!meta) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    void handleLinkActivation(meta, { background: true });
  }

  function onCaptureContextMenu(ev) {
    if (destroyed || !suppressNextContextMenu) return;
    suppressNextContextMenu = false;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
  }

  function onCaptureDragStart(ev) {
    if (destroyed || !isInsideRightContent(ev.target)) return;
    let meta = extractLinkMetaFromTarget(ev.target);
    if (!meta && activeIsDirectory) {
      const rowMeta = extractDirectoryRowMetaFromTarget(ev.target);
      if (rowMeta && !rowMeta.isDirectory) meta = rowMeta;
    }
    if (!meta) return;
    dragPayload = meta;
    try {
      ev.dataTransfer?.setData('text/aw-link', meta.path);
      ev.dataTransfer?.setData('text/plain', meta.path);
    } catch {}
  }

  function onCaptureDragOver(ev) {
    if (destroyed || !dragPayload) return;
    if (isInsideNativeTabBar(ev.target) || ev.target?.closest?.(`#${STRIP_ID}`)) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      getNativeTabBar(getRightPaneColumn())?.setAttribute('data-aw-tabbar-dropzone', '1');
    }
  }

  function onCaptureDragLeave(ev) {
    const tabBar = getNativeTabBar(getRightPaneColumn());
    if (tabBar && !tabBar.contains(ev.relatedTarget)) tabBar.removeAttribute('data-aw-tabbar-dropzone');
  }

  function onCaptureDrop(ev) {
    const tabBar = getNativeTabBar(getRightPaneColumn());
    tabBar?.removeAttribute('data-aw-tabbar-dropzone');
    if (destroyed || !dragPayload || !isInsideNativeTabBar(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const dropped = dragPayload;
    dragPayload = null;
    openPathInNativeTab(dropped.path, { background: false, lineStart: dropped.lineStart, isDirectory: Boolean(dropped.isDirectory) });
    activeFilePath = dropped.path;
    activeIsDirectory = Boolean(dropped.isDirectory);
    void recordHistoryPush({ path: dropped.path, title: dropped.title, line: dropped.lineStart, isDirectory: Boolean(dropped.isDirectory) }).then(() => refreshState());
  }

  function onCaptureDragEnd() {
    getNativeTabBar(getRightPaneColumn())?.removeAttribute('data-aw-tabbar-dropzone');
    dragPayload = null;
  }

  let holdTimer = null;
  let holdOrigin = null;

  function openHoldWheelAtOrigin(origin) {
    const midMode = settings.middleMode || 'bilateral_wheel';
    if (midMode === 'off') return false;
    if (origin.button === 1) {
      suppressNextAuxClick = true;
      clearTimeout(suppressAuxTimer);
      suppressAuxTimer = setTimeout(() => { suppressNextAuxClick = false; suppressAuxTimer = null; }, 160);
    } else if (origin.button === 2) {
      suppressNextContextMenu = true;
      clearTimeout(suppressCtxTimer);
      suppressCtxTimer = setTimeout(() => { suppressNextContextMenu = false; suppressCtxTimer = null; }, 160);
    }
    if (midMode === 'classic_wheel') {
      const target = getWheelTargetGroup();
      return target ? openClassicWheelForTarget(target, origin.x, origin.y, { holdMode: true, holdButton: origin.button }) : false;
    }
    const syncCtx = getSyncNavContext(navScopeOverride);
    if (!syncCtx?.current) return false;
    const usedCache = syncCtx === cachedNavContext;
    const opened = openBilateralForContext(syncCtx, origin.x, origin.y, { holdMode: true, holdButton: origin.button });
    if (opened && !usedCache) {
      void fetchNavContext(navScopeOverride).then((fresh) => {
        if (fresh && bilateralInstance?.isOpen?.()) bilateralInstance.updateContext(fresh);
      });
    }
    return opened;
  }

  function onPointerDown(ev) {
    if (destroyed || !isInsideRightContent(ev.target)) return;
    if (ev.target?.closest?.('[data-aw-owned="1"]')) return;
    if (extractLinkMetaFromTarget(ev.target)) return;
    const midMode = settings.middleMode || 'bilateral_wheel';
    if (midMode === 'off' || ev.button !== 1) return;
    ev.preventDefault();

    const origin = { x: ev.clientX, y: ev.clientY, button: 1, opened: false, downAt: Date.now() };
    holdOrigin = origin;
    holdTimer = setTimeout(() => {
      if (holdOrigin === origin && !origin.opened) {
        origin.opened = true;
        openHoldWheelAtOrigin(origin);
      }
    }, 115);
  }

  function onPointerMove(ev) {
    if (!holdOrigin || holdOrigin.opened) return;
    if (Math.hypot(ev.clientX - holdOrigin.x, ev.clientY - holdOrigin.y) >= 8) {
      clearTimeout(holdTimer);
      holdOrigin.opened = true;
      openHoldWheelAtOrigin(holdOrigin);
    }
  }

  function onPointerUp(ev) {
    clearTimeout(holdTimer);
    holdOrigin = null;
    if (destroyed) return;
    if (ev.button === 3) {
      ev.preventDefault();
      void stepHistory('back');
    } else if (ev.button === 4) {
      ev.preventDefault();
      void stepHistory('forward');
    }
  }

  function isEditableElement(rawEl) {
    const check = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      if (el.closest?.('[contenteditable="true"], [role="textbox"], [data-testid="agent-input-box"], .monaco-editor, .cm-editor, .ProseMirror, .aw-settings-modal')) {
        return true;
      }
      return false;
    };
    return check(rawEl) || check(D.activeElement);
  }

  function matchesTabHotkey(ev) {
    if (settings.tabTriggerEnabled === false || settings.tabMode === 'off') return false;
    const hk = settings.tabCustomHotkey || 'Tab';
    if (hk === 'Tab') {
      return ev.key === 'Tab' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
    }
    if (hk === 'Alt+Q') {
      return ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'q';
    }
    if (hk === 'Alt+W') {
      return ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'w';
    }
    if (hk === 'F2') {
      return ev.key === 'F2' && !ev.altKey && !ev.ctrlKey && !ev.metaKey;
    }
    return false;
  }

  function onCaptureKeyDown(ev) {
    if (destroyed) return;
    if (isEditableElement(ev.target)) return;

    if (matchesTabHotkey(ev)) {
      const col = getRightPaneColumn();
      const colRect = col ? col.getBoundingClientRect() : null;
      const rightPaneActive = Boolean(col && colRect && colRect.width > 80 && activeFilePath);
      if (isAnyTabNavigatorOpen() || rightPaneActive) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        triggerTabNavigator();
        return;
      }
    }

    if (ev.altKey && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      void stepHistory('back');
    } else if (ev.altKey && ev.key === 'ArrowRight') {
      ev.preventDefault();
      void stepHistory('forward');
    } else if (ev.altKey && ev.key.toLowerCase() === 'q' && (settings.tabCustomHotkey || 'Tab') !== 'Alt+Q') {
      const target = getWheelTargetGroup();
      if (target) {
        ev.preventDefault();
        const col = getRightPaneColumn();
        const rect = col ? col.getBoundingClientRect() : { left: W.innerWidth - 220, top: 200, width: 320 };
        openClassicWheelForTarget(target, rect.left + rect.width / 2, rect.top + 180, { holdMode: false });
      }
    }
  }

  function onDocClickClosePopover(ev) {
    if (!activePopoverName) return;
    const portal = D.getElementById(PORTAL_ID);
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    if (portal && (path.includes(portal) || portal.contains(ev.target))) return;
    if (ev.target && ev.target.isConnected === false) return;
    if (ev.target?.closest?.('.aw-popover, [data-aw-owned="1"]')) return;
    closePopover();
  }

  function ensureStoreSubscription() {
    if (storeUnsubscribe || destroyed) return;
    try {
      const { browserCtx, reduxStore } = discoverHostBridge();
      if (reduxStore && typeof reduxStore.subscribe === 'function') {
        let lastPaneSnap = '';
        storeUnsubscribe = reduxStore.subscribe(() => {
          if (destroyed) return;
          const { pane } = getPaneSlice(reduxStore, browserCtx);
          const curTab = Array.isArray(pane?.tabs) ? pane.tabs.find((t) => t.id === pane.activeTabId) : null;
          const snap = `${pane?.activeTabId || ''}|${pane?.tabs?.length || 0}|${curTab?.content?.type || ''}|${extractUriFromTab(curTab)}`;
          if (snap !== lastPaneSnap) {
            lastPaneSnap = snap;
            scheduleSync();
          }
        });
      }
    } catch {}
  }

  function boot() {
    sweepOrphanPreviewCards();
    ensureStyleTag();
    ensureSharedInstances();

    D.addEventListener('click', onCaptureClick, true);
    D.addEventListener('mousedown', onCaptureMouseDown, true);
    D.addEventListener('auxclick', onCaptureAuxClick, true);
    D.addEventListener('contextmenu', onCaptureContextMenu, true);
    D.addEventListener('dragstart', onCaptureDragStart, true);
    D.addEventListener('dragover', onCaptureDragOver, true);
    D.addEventListener('dragleave', onCaptureDragLeave, true);
    D.addEventListener('drop', onCaptureDrop, true);
    D.addEventListener('dragend', onCaptureDragEnd, true);
    D.addEventListener('pointerdown', onPointerDown, true);
    D.addEventListener('pointermove', onPointerMove, true);
    D.addEventListener('pointerup', onPointerUp, true);
    W.addEventListener('keydown', onCaptureKeyDown, true);
    D.addEventListener('click', onDocClickClosePopover, false);

    ensureStoreSubscription();

    domObserver = new MutationObserver(() => {
      if (destroyed || obsThrottle) return;
      obsThrottle = setTimeout(() => {
        obsThrottle = null;
        if (destroyed) return;
        ensureStoreSubscription();
        const tabKey = `${W.location?.pathname}|${W.location?.search}`;
        const col = getRightPaneColumn();
        const contentEl = getContentContainer(col);
        const strip = D.getElementById(STRIP_ID);
        if (tabKey !== lastObservedTabKey) {
          lastObservedTabKey = tabKey;
          scheduleSync();
          return;
        }
        if (col && contentEl && (!strip || strip.parentElement !== col)) {
          scheduleSync();
        }
      }, 150);
    });
    domObserver.observe(D.body || D.documentElement, { childList: true, subtree: true });

    void refreshState();
  }

  W.__agAnchorWheel = {
    get version() {
      return bootMeta.version || BOOT.version || '';
    },
    getDebugState() {
      const col = getRightPaneColumn();
      return {
        version: bootMeta.version || BOOT.version || '',
        conversationId: lastConversationId || resolveConversationId(),
        activeFilePath,
        activeIsDirectory,
        dirChildCount: activeIsDirectory ? (cachedNavContext?.current?.children?.length || 0) : 0,
        activePopoverName,
        outlinkCount: activeFileLinks.outlinks?.length || 0,
        backlinkCount: activeFileLinks.backlinks?.length || 0,
        hasContentContainer: Boolean(getContentContainer(col)),
        contentContainerIndex: col ? Array.from(col.children).indexOf(getContentContainer(col)) : -1,
        wheelOpen: Boolean(wheelInstance?.isOpen?.()),
        bilateralOpen: Boolean(bilateralInstance?.isOpen?.()),
        aeTreeOpen: Boolean(aeTreeInstance?.isOpen?.()),
        settingsOpen: Boolean(settingsModalInstance?.isOpen?.()),
      };
    },
    onBackendSync(payload) {
      if (destroyed || !payload) return;
      if (payload.settings) {
        settings = payload.settings;
        applyThemeToNativeNodes();
      }
      if (payload.session && (!payload.conversationId || payload.conversationId === resolveConversationId())) {
        session = payload.session;
      }
      applyNonDestructiveTabFolding();
      renderStrip();
      void refreshPersistentNavigatorIfOpen();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(syncTimer);
      clearTimeout(holdTimer);
      clearTimeout(obsThrottle);
      clearTimeout(bgUpdateTimer);
      clearTimeout(suppressAuxTimer);
      clearTimeout(suppressCtxTimer);
      syncTimer = null;
      holdTimer = null;
      obsThrottle = null;
      bgUpdateTimer = null;
      suppressAuxTimer = null;
      suppressCtxTimer = null;
      for (const rec of pendingRpc.values()) {
        clearTimeout(rec.timer);
        try { rec.resolve({ ok: false, destroyed: true }); } catch {}
      }
      pendingRpc.clear();
      try { delete W.__agAnchorWheelResolve; } catch {}
      try { storeUnsubscribe?.(); } catch {}
      storeUnsubscribe = null;
      domObserver?.disconnect?.();
      closeAllNavigators();
      settingsModalInstance?.close?.();
      closePopover();
      D.removeEventListener('click', onCaptureClick, true);
      D.removeEventListener('mousedown', onCaptureMouseDown, true);
      D.removeEventListener('auxclick', onCaptureAuxClick, true);
      D.removeEventListener('contextmenu', onCaptureContextMenu, true);
      D.removeEventListener('dragstart', onCaptureDragStart, true);
      D.removeEventListener('dragover', onCaptureDragOver, true);
      D.removeEventListener('dragleave', onCaptureDragLeave, true);
      D.removeEventListener('drop', onCaptureDrop, true);
      D.removeEventListener('dragend', onCaptureDragEnd, true);
      D.removeEventListener('pointerdown', onPointerDown, true);
      D.removeEventListener('pointermove', onPointerMove, true);
      D.removeEventListener('pointerup', onPointerUp, true);
      W.removeEventListener('keydown', onCaptureKeyDown, true);
      D.removeEventListener('click', onDocClickClosePopover, false);
      for (const el of D.querySelectorAll('[data-aw-hidden-tab="1"]')) el.removeAttribute('data-aw-hidden-tab');
      for (const el of D.querySelectorAll('[data-aw-orig-hidden="1"]')) {
        el.style.display = el.getAttribute('data-aw-orig-disp') || '';
        el.removeAttribute('data-aw-orig-hidden');
        el.removeAttribute('data-aw-orig-disp');
      }
      for (const el of D.querySelectorAll('[data-aw-owned="1"]')) {
        try { el.remove(); } catch {}
      }
      sweepOrphanPreviewCards();
      try { D.getElementById(STYLE_ID)?.remove(); } catch {}
    },
  };

  boot();
})();
