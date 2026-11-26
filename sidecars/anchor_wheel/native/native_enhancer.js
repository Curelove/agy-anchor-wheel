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
  const DOC_OVERLAY_ID = 'aw-native-doc-overlay';
  const UPDATE_PUSH_ID = 'aw-native-update-push';
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
  let docOverlayVisible = false;
  let docOverlayDismissedKey = '';
  let docRenderSeq = 0;
  let docViewerInstance = null;
  let lastRenderedDocKey = '';
  let lastRenderedDocData = null;
  let lastHostPreviewState = 'unknown';
  let docProbeTimer = null;
  let docProbeCount = 0;
  let activePopoverName = '';
  let dragPayload = null;
  let domObserver = null;
  let obsThrottle = null;
  let syncTimer = null;
  let bgUpdateTimer = null;
  let suppressAuxTimer = null;
  let suppressCtxTimer = null;
  let menuEnhanceRaf = 0;
  let menuEnhanceTimers = [];
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
  let sessionDismissedUpdateVer = '';

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
    applyThemeAttr(D.getElementById(DOC_OVERLAY_ID));
    applyThemeAttr(D.getElementById(UPDATE_PUSH_ID));
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
    const awScroll = contentWrap.querySelector('[data-aw-scroll-host="1"]');
    if (awScroll) return awScroll;
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
    holdWheelActiveButton = -1;
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

  function getSystemExplorerLabels({ preferEnglish = false } = {}) {
    const plat = String(W.navigator?.platform || W.navigator?.userAgent || '');
    const isMac = /Mac|Darwin/i.test(plat);
    const isWin = /Win/i.test(plat);
    if (isMac) {
      return preferEnglish
        ? {
            openDir: 'Open in Finder',
            revealFile: 'Reveal in Finder',
            openParent: 'Open Containing Folder',
            copyPath: 'Copy Path',
            openTab: 'Open in New Side-Pane Tab',
            stripDir: 'Open Folder',
            stripTipDir: 'Open current folder in Finder',
            stripTipFile: 'Reveal current file in Finder',
            appName: 'Finder',
          }
        : {
            openDir: '在访达中打开',
            revealFile: '在访达中显示',
            openParent: '打开所在文件夹',
            copyPath: '复制路径',
            openTab: '在侧边栏新标签页打开',
            stripDir: '打开目录',
            stripTipDir: '在访达中打开当前文件夹',
            stripTipFile: '在访达中定位当前文件',
            appName: '访达',
          };
    }
    if (isWin) {
      return preferEnglish
        ? {
            openDir: 'Open in File Explorer',
            revealFile: 'Show in File Explorer',
            openParent: 'Open Containing Folder',
            copyPath: 'Copy Path',
            openTab: 'Open in New Side-Pane Tab',
            stripDir: 'Open Folder',
            stripTipDir: 'Open current folder in File Explorer',
            stripTipFile: 'Show current file in File Explorer',
            appName: 'File Explorer',
          }
        : {
            openDir: '在文件资源管理器中打开',
            revealFile: '在文件资源管理器中显示',
            openParent: '打开所在文件夹',
            copyPath: '复制路径',
            openTab: '在侧边栏新标签页打开',
            stripDir: '打开目录',
            stripTipDir: '在文件资源管理器中打开当前文件夹',
            stripTipFile: '在文件资源管理器中定位当前文件',
            appName: '文件资源管理器',
          };
    }
    return preferEnglish
      ? {
          openDir: 'Open in File Manager',
          revealFile: 'Show in File Manager',
          openParent: 'Open Containing Folder',
          copyPath: 'Copy Path',
          openTab: 'Open in New Side-Pane Tab',
          stripDir: 'Open Folder',
          stripTipDir: 'Open current folder in File Manager',
          stripTipFile: 'Show current file in File Manager',
          appName: 'File Manager',
        }
      : {
          openDir: '在文件管理器中打开',
          revealFile: '在文件管理器中显示',
          openParent: '打开所在文件夹',
          copyPath: '复制路径',
          openTab: '在侧边栏新标签页打开',
          stripDir: '打开目录',
          stripTipDir: '在文件管理器中打开当前文件夹',
          stripTipFile: '在文件管理器中定位当前文件',
          appName: '文件管理器',
        };
  }

  function isLocalAbsolutePath(p) {
    const s = String(p || '').trim();
    return Boolean(s && /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(s));
  }

  async function revealPathInExplorer(targetPath, { isDirectory = false, preferDirectory = false } = {}) {
    const clean = String(targetPath || '').trim();
    if (!isLocalAbsolutePath(clean)) {
      showToast('当前视图不是本地文件或文件夹');
      return false;
    }
    const labels = getSystemExplorerLabels({ preferEnglish: false });
    const res = await callRpc('revealInExplorer', { path: clean, preferDirectory: Boolean(preferDirectory) }, 6000);
    if (res?.ok) {
      const displayName = baseName(res.targetPath || clean);
      showToast(`已在${labels.appName}中打开：${displayName}`);
      return true;
    }
    if (res?.error && /Unknown action/i.test(String(res.error))) {
      showToast('请在左侧「自定义扩展」将锚点轮盘关闭再重开一次以启用新版后端');
      return false;
    }
    showToast(`打开系统文件夹失败：${res?.error || (isDirectory ? '无法访问目录' : '无法定位文件')}`);
    return false;
  }

  async function copyPathToClipboard(text, label = '') {
    const val = String(text || '');
    if (!val) return false;
    try {
      if (W.navigator?.clipboard?.writeText) {
        await W.navigator.clipboard.writeText(val);
        showToast(label ? `已复制路径：${label}` : '已复制路径');
        return true;
      }
    } catch {}
    try {
      const ta = markOwned(D.createElement('textarea'));
      ta.value = val;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      D.body.appendChild(ta);
      ta.select();
      D.execCommand('copy');
      ta.remove();
      showToast(label ? `已复制路径：${label}` : '已复制路径');
      return true;
    } catch {
      showToast('复制路径失败');
      return false;
    }
  }

  const NATIVE_EXPLORER_ITEM_RE =
    /(?:文件资源管理器|资源管理器|file\s*explorer|show\s+in\s+explorer|open\s+in\s+explorer|reveal\s+in\s+finder|show\s+in\s+finder|open\s+in\s+finder|访达|file\s*manager|文件管理器)/i;

  function resolveOverflowTargetPath(moreBtn) {
    if (isLocalAbsolutePath(activeFilePath)) {
      return { path: activeFilePath, isDirectory: Boolean(activeIsDirectory) };
    }
    const headerBar = moreBtn?.closest?.('.group\\/file-row') || moreBtn?.parentElement?.parentElement;
    if (headerBar) {
      const crumbs = Array.from(headerBar.querySelectorAll('[data-uri]'));
      const last = crumbs[crumbs.length - 1];
      const rawUri = last?.getAttribute?.('data-uri') || '';
      const p = uriToPath(rawUri).replace(/[\\/]+$/, '');
      if (isLocalAbsolutePath(p)) {
        return { path: p, isDirectory: Boolean(activeIsDirectory || /[\\/]$/.test(rawUri)) };
      }
    }
    return null;
  }

  function findOpenOverflowMenuForButton(moreBtn) {
    if (!moreBtn || !moreBtn.isConnected) return null;
    const ctrlId = moreBtn.getAttribute('aria-controls');
    if (ctrlId) {
      const ctrlEl = D.getElementById(ctrlId);
      if (ctrlEl && ctrlEl.getAttribute('data-aw-owned') !== '1') {
        const menu = ctrlEl.matches?.('[role="menu"]') ? ctrlEl : ctrlEl.querySelector?.('[role="menu"]');
        if (menu && menu.getAttribute('data-aw-owned') !== '1') return menu;
      }
    }
    const btnRect = moreBtn.getBoundingClientRect();
    const expanded = moreBtn.getAttribute('aria-expanded') === 'true';
    const candidates = Array.from(D.querySelectorAll('[role="menu"]')).filter(
      (el) => el.getAttribute('data-aw-owned') !== '1' && !el.closest?.('[data-aw-owned="1"]')
    );
    let best = null;
    let bestDist = Infinity;
    for (const menu of candidates) {
      const r = menu.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
        (it) => it.getAttribute('data-aw-owned') !== '1'
      );
      const hasCopyPath = items.some((it) => /(?:复制路径|copy\s+path)/i.test(it.textContent || ''));
      if (!expanded && !hasCopyPath) continue;
      const dx = Math.abs((r.right || 0) - (btnRect.right || 0));
      const dy = Math.abs((r.top || 0) - (btnRect.bottom || 0));
      const dist = dx + dy;
      if ((dx <= 320 && dy <= 180) || hasCopyPath) {
        if (dist < bestDist) {
          bestDist = dist;
          best = menu;
        }
      }
    }
    return best;
  }

  function dismissNativeOverflowMenu(menuEl, moreBtn) {
    try {
      const escEv = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      (menuEl || D.activeElement || D).dispatchEvent(escEv);
      D.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } catch {}
    if (moreBtn && moreBtn.isConnected) {
      setTimeout(() => {
        try {
          if (moreBtn.isConnected && moreBtn.getAttribute('aria-expanded') === 'true') {
            moreBtn.click();
          }
        } catch {}
      }, 15);
    }
  }

  function enhanceNativeOverflowMenus() {
    if (destroyed) return false;
    const col = getRightPaneColumn();
    if (!col) return false;
    const moreBtn = col.querySelector('[data-testid="more-actions-overflow"]');
    if (!moreBtn) return false;
    const menuEl = findOpenOverflowMenuForButton(moreBtn);
    if (!menuEl) return false;

    const target = resolveOverflowTargetPath(moreBtn);
    if (!target) return false;

    const nativeItems = Array.from(menuEl.querySelectorAll('[role="menuitem"]')).filter(
      (el) => el.getAttribute('data-aw-owned') !== '1'
    );
    const nativeTexts = nativeItems.map((el) => String(el.textContent || el.getAttribute('aria-label') || '').trim());
    if (nativeTexts.some((txt) => NATIVE_EXPLORER_ITEM_RE.test(txt))) {
      // Host natively provides Show/Open in File Explorer (e.g., standard fileView) — never duplicate!
      menuEl.querySelector('[data-aw-role="reveal-menu-item"]')?.remove();
      return false;
    }

    const preferEnglish = nativeTexts.length > 0 && !/[\u4e00-\u9fff]/.test(nativeTexts.join(' '));
    const labels = getSystemExplorerLabels({ preferEnglish });
    const labelText = target.isDirectory ? labels.openDir : labels.revealFile;

    let item = menuEl.querySelector('[data-aw-role="reveal-menu-item"]');
    if (item) {
      item.dataset.awPath = target.path;
      item.dataset.awDir = target.isDirectory ? '1' : '0';
      item.title = target.path;
      const lbl = item.querySelector('.aw-host-menuitem-label');
      if (lbl) lbl.textContent = labelText;
      return true;
    }

    item = markOwned(D.createElement('button'));
    item.type = 'button';
    item.className = 'aw-host-menuitem';
    item.setAttribute('data-aw-role', 'reveal-menu-item');
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    item.dataset.awPath = target.path;
    item.dataset.awDir = target.isDirectory ? '1' : '0';
    item.title = target.path;
    item.innerHTML = `${S.ICONS.folderOpen}<span class="aw-host-menuitem-label">${S?.esc ? S.esc(labelText) : labelText}</span>`;

    item.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
    });
    item.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const p = item.dataset.awPath || '';
      const isDir = item.dataset.awDir === '1';
      dismissNativeOverflowMenu(menuEl, moreBtn);
      void revealPathInExplorer(p, { isDirectory: isDir });
    });

    menuEl.appendChild(item);
    return true;
  }

  function scheduleOverflowMenuEnhance({ retries = false } = {}) {
    if (destroyed) return;
    if (!menuEnhanceRaf) {
      menuEnhanceRaf = requestAnimationFrame(() => {
        menuEnhanceRaf = 0;
        enhanceNativeOverflowMenus();
      });
    }
    if (retries) {
      for (const delay of [35, 110]) {
        const tid = setTimeout(() => {
          menuEnhanceTimers = menuEnhanceTimers.filter((x) => x !== tid);
          enhanceNativeOverflowMenus();
        }, delay);
        menuEnhanceTimers.push(tid);
      }
    }
  }

  function extractTreeItemMetaFromTarget(rawEl) {
    const el = rawEl && rawEl.nodeType === 1 ? rawEl : rawEl?.parentElement;
    if (!el || el.closest?.('[data-aw-owned="1"]')) return null;
    if (!el.closest?.('[data-testid="tab-file-tree-sidebar"]')) return null;
    const row = el.closest('[role="treeitem"]');
    if (!row) return null;
    try {
      const fk = Object.keys(row).find((k) => k.startsWith('__reactFiber'));
      let cur = fk ? row[fk] : null;
      for (let i = 0; i < 6 && cur; i++, cur = cur.return) {
        const entry = cur.memoizedProps?.entry;
        if (entry && typeof entry.uri === 'string' && entry.uri) {
          const cleanPath = uriToPath(entry.uri).replace(/[\\/]+$/, '');
          if (!isLocalAbsolutePath(cleanPath)) return null;
          const isDirectory = entry.fileType === 2 || /[\\/]$/.test(entry.uri);
          return {
            path: cleanPath,
            uri: entry.uri,
            title: baseName(cleanPath),
            isDirectory,
            source: 'tree',
          };
        }
      }
    } catch {}
    return null;
  }

  function extractBreadcrumbMetaFromTarget(rawEl) {
    const el = rawEl && rawEl.nodeType === 1 ? rawEl : rawEl?.parentElement;
    if (!el || !isInsideRightContent(el)) return null;
    if (el.closest?.('[data-aw-owned="1"], [role="treeitem"], button.inline-pill, [data-testid="entity-pill"]')) {
      return null;
    }
    const bc = el.closest?.('div[data-uri]');
    if (!bc) return null;
    const rawUri = bc.getAttribute('data-uri') || '';
    const cleanPath = uriToPath(rawUri).replace(/[\\/]+$/, '');
    if (!isLocalAbsolutePath(cleanPath)) return null;
    const isActiveMatch = normKey(cleanPath) === normKey(activeFilePath);
    const isDirectory = isActiveMatch ? Boolean(activeIsDirectory) : true;
    return {
      path: cleanPath,
      uri: rawUri,
      title: baseName(cleanPath),
      isDirectory,
      source: 'breadcrumb',
    };
  }

  function extractContextTargetFromEvent(rawEl) {
    return (
      extractTreeItemMetaFromTarget(rawEl) ||
      extractDirectoryRowMetaFromTarget(rawEl) ||
      extractBreadcrumbMetaFromTarget(rawEl) ||
      null
    );
  }

  function openExplorerContextMenu(target, x, y) {
    if (!target?.path) return false;
    closeAllNavigators();
    closePopover();
    activePopoverName = 'ctx-menu';

    const portal = getPortalRoot();
    const labels = getSystemExplorerLabels({ preferEnglish: false });
    const menu = markOwned(D.createElement('div'));
    menu.className = 'aw-ctx-menu';
    menu.setAttribute('data-aw-role', 'explorer-ctx-menu');
    menu.setAttribute('role', 'menu');
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
    menu.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });

    const esc = (s) => (S?.esc ? S.esc(s) : String(s || ''));
    const header = markOwned(D.createElement('div'));
    header.className = 'aw-ctx-header';
    header.title = target.path;
    header.innerHTML = `${S.pickIconForItem(target)}<span class="aw-ctx-header-name">${esc(target.title || baseName(target.path))}</span>`;
    menu.appendChild(header);

    const addItem = (role, iconHtml, text, onClick) => {
      const btn = markOwned(D.createElement('button'));
      btn.type = 'button';
      btn.className = 'aw-host-menuitem';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-aw-ctx-act', role);
      btn.innerHTML = `${iconHtml}<span class="aw-host-menuitem-label">${esc(text)}</span>`;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closePopover();
        void onClick();
      });
      menu.appendChild(btn);
    };

    addItem(
      'reveal',
      S.ICONS.folderOpen,
      target.isDirectory ? labels.openDir : labels.revealFile,
      () => revealPathInExplorer(target.path, { isDirectory: target.isDirectory })
    );

    if (!target.isDirectory) {
      addItem('open-parent', S.ICONS.folder, labels.openParent, () =>
        revealPathInExplorer(target.path, { isDirectory: true, preferDirectory: true })
      );
    }

    addItem('copy-path', S.ICONS.copy, labels.copyPath, () => copyPathToClipboard(target.path, target.title));

    if (normKey(target.path) !== normKey(activeFilePath)) {
      const sep = markOwned(D.createElement('div'));
      sep.className = 'aw-ctx-sep';
      menu.appendChild(sep);
      addItem('open-tab', S.ICONS.externalTab, labels.openTab, async () => {
        await handleLinkActivation(
          {
            path: target.path,
            title: target.title || baseName(target.path),
            isDirectory: Boolean(target.isDirectory),
          },
          { background: false }
        );
      });
    }

    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    portal.appendChild(menu);

    const r = menu.getBoundingClientRect();
    const vw = W.innerWidth || 1200;
    const vh = W.innerHeight || 800;
    const clampedLeft = Math.max(8, Math.min(vw - r.width - 8, x));
    const clampedTop = Math.max(8, Math.min(vh - r.height - 8, y));
    menu.style.left = `${clampedLeft}px`;
    menu.style.top = `${clampedTop}px`;
    return true;
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

  const UNSUPPORTED_HOST_TEXT_RE =
    /Preview is not available|Unable to display|Failed to read file|exceeds the \d+(?:\.\d+)?\s*(?:MB|KB|GB) display limit|此文件类型无法预览|无法预览此文件|无法预览该文件|无法显示|无法读取文件内容|超出.*显示上限/i;

  function getActiveRichDocMeta() {
    if (!activeFilePath || activeIsDirectory) return null;
    const meta = W.AnchorWheelDocViewer?.classifyDocPathClient?.(activeFilePath) || null;
    if (!meta || meta.mode2Only) return null;
    return meta;
  }

  function isNativeFileHeaderBar(el) {
    if (!el || el.nodeType !== 1 || el.getAttribute?.('data-aw-owned') === '1') return false;
    if (!el.querySelector?.('[data-testid="more-actions-overflow"]')) return false;
    if (
      el.querySelector?.(
        '[data-testid="binary-file-no-preview"], [data-testid="artifact-pdf-no-preview"], [data-testid*="no-preview"], [data-omni-aux-error], pre, code, iframe, canvas, table, .monaco-editor, .cm-editor, .markdown-body'
      )
    ) {
      return false;
    }
    const txt = (el.textContent || '').slice(0, 900);
    if (UNSUPPORTED_HOST_TEXT_RE.test(txt)) return false;
    return true;
  }

  function resolveDocMountLayout(contentWrap) {
    if (!contentWrap) return { mountParent: null, hasNativeHeader: false };
    const directChildren = Array.from(contentWrap.children).filter(
      (ch) => ch.getAttribute?.('data-aw-owned') !== '1'
    );
    if (directChildren.some((ch) => isNativeFileHeaderBar(ch))) {
      return { mountParent: contentWrap, hasNativeHeader: true };
    }
    if (directChildren.length === 1) {
      const inner = directChildren[0];
      const innerKids = Array.from(inner.children || []).filter(
        (ch) => ch.getAttribute?.('data-aw-owned') !== '1'
      );
      if (innerKids.some((ch) => isNativeFileHeaderBar(ch))) {
        return { mountParent: inner, hasNativeHeader: true };
      }
    }
    return { mountParent: contentWrap, hasNativeHeader: false };
  }

  function inspectHostFileViewState(contentWrap) {
    if (!contentWrap) return 'missing';
    if (
      contentWrap.querySelector?.(
        '[data-omni-aux-mounted="1"]:not([data-omni-aux-error]), [data-testid="ag-omni-aux-switcher"]'
      )
    ) {
      return 'companion_mounted';
    }
    if (
      contentWrap.querySelector?.(
        '[data-testid="binary-file-no-preview"], [data-testid="artifact-pdf-no-preview"], [data-testid*="no-preview"], [data-omni-aux-error]'
      )
    ) {
      return 'unsupported';
    }

    let hostBodyText = '';
    let hasRichVisual = false;
    let hasRawCode = false;
    let hasBrokenVideo = false;
    let hasPendingVideo = false;

    const inspectNode = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (el.getAttribute?.('data-aw-owned') === '1' || el.id === DOC_OVERLAY_ID || el.id === OVERLAY_ID) {
        return;
      }
      if (isNativeFileHeaderBar(el)) return;

      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'VIDEO') {
        const failed =
          Boolean(el.error) ||
          el.networkState === 3 ||
          (el.readyState >= 1 && el.videoWidth === 0 && el.videoHeight === 0);
        if (failed) {
          hasBrokenVideo = true;
        } else if (el.readyState >= 1 && el.videoWidth > 0) {
          hasRichVisual = true;
        } else {
          hasPendingVideo = true;
          if (!el.dataset?.awVidWatch) {
            try {
              el.dataset.awVidWatch = '1';
              el.addEventListener('error', () => scheduleSync(), { once: true });
              el.addEventListener('loadedmetadata', () => scheduleSync(), { once: true });
            } catch {}
          }
        }
      } else if (
        tag === 'IFRAME' ||
        tag === 'EMBED' ||
        tag === 'OBJECT' ||
        tag === 'AUDIO' ||
        tag === 'CANVAS' ||
        tag === 'TABLE'
      ) {
        hasRichVisual = true;
      } else if (tag === 'IMG' && !el.closest?.('button, [role="button"]')) {
        hasRichVisual = true;
      } else if (
        el.matches?.(
          '.markdown-body, article, [data-testid*="notebook"], [data-testid*="spreadsheet"], [data-testid*="slide"], [data-testid*="pdf-viewer"]'
        )
      ) {
        hasRichVisual = true;
      } else if (tag === 'PRE' || tag === 'CODE' || el.matches?.('.monaco-editor, .cm-editor, [data-line-number]')) {
        hasRawCode = true;
      }

      const kids = el.children;
      if (!kids || kids.length === 0) {
        if (hostBodyText.length < 4096) {
          hostBodyText += ' ' + (el.textContent || '');
        }
        return;
      }
      for (let i = 0; i < kids.length; i++) {
        inspectNode(kids[i]);
      }
      // Also capture direct text nodes on mixed elements
      for (let n = el.firstChild; n && hostBodyText.length < 4096; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
          hostBodyText += ' ' + n.nodeValue;
        }
      }
    };

    for (const ch of Array.from(contentWrap.children)) {
      inspectNode(ch);
    }

    if (hasBrokenVideo && !hasRichVisual) {
      return 'unsupported';
    }
    if (UNSUPPORTED_HOST_TEXT_RE.test(hostBodyText)) {
      return 'unsupported';
    }
    if (hasPendingVideo && !hasRichVisual) {
      return 'empty_loading';
    }
    if (!hostBodyText.trim() && !hasRichVisual && !hasRawCode) {
      return 'empty_loading';
    }
    if (hasRawCode && !hasRichVisual) {
      return 'raw_code_only';
    }
    return 'native_rich';
  }

  function shouldAutoOpenDocOverlay(meta, hostState) {
    if (!meta || !meta.autoRender || meta.optionalTable) return false;
    if (settings.richDocPreviewEnabled === false) return false;
    const strategy = settings.richDocAutoStrategy || 'auto_yield';
    if (strategy === 'manual_only') return false;
    if (hostState === 'companion_mounted') return false;
    if (strategy === 'always_plugin') return true;
    // Default 'auto_yield': auto-preview when Antigravity cannot preview, yield when official rich view exists!
    if (hostState === 'unsupported') return true;
    if (hostState === 'raw_code_only' && meta.preferWhenRawCode) return true;
    return false;
  }

  function hideNativeContentSiblings(mountParent, keepIds) {
    if (!mountParent) return;
    for (const ch of Array.from(mountParent.children)) {
      if (keepIds.has(ch.id) || isNativeFileHeaderBar(ch)) continue;
      if (!ch.hasAttribute('data-aw-orig-hidden')) {
        ch.setAttribute('data-aw-orig-hidden', '1');
        ch.setAttribute('data-aw-orig-disp', ch.style.display || '');
        ch.style.display = 'none';
      } else if (ch.style.display !== 'none') {
        ch.style.display = 'none';
      }
    }
  }

  function restoreNativeContentSiblings(rootEl) {
    if (!rootEl) return;
    const restoreEl = (el) => {
      if (!el || !el.hasAttribute?.('data-aw-orig-hidden')) return;
      el.style.display = el.getAttribute('data-aw-orig-disp') || '';
      el.removeAttribute('data-aw-orig-hidden');
      el.removeAttribute('data-aw-orig-disp');
    };
    for (const ch of Array.from(rootEl.children || [])) restoreEl(ch);
    for (const desc of Array.from(rootEl.querySelectorAll?.('[data-aw-orig-hidden="1"]') || [])) restoreEl(desc);
  }

  function closeDocOverlay({ dismiss = false } = {}) {
    docRenderSeq++;
    clearTimeout(docProbeTimer);
    docProbeTimer = null;
    try { docViewerInstance?.destroy?.(); } catch {}
    docViewerInstance = null;
    const existing = D.getElementById(DOC_OVERLAY_ID);
    if (existing) {
      try { existing.remove(); } catch {}
    }
    docOverlayVisible = false;
    if (dismiss && activeFilePath) {
      docOverlayDismissedKey = normKey(activeFilePath);
    }
    if (!encodingOverlayVisible) {
      restoreNativeContentSiblings(getContentContainer(getRightPaneColumn()));
    }
  }

  async function openDocOverlay({ force = false } = {}) {
    const meta = getActiveRichDocMeta();
    const col = getRightPaneColumn();
    const contentWrap = getContentContainer(col);
    if (!meta || !contentWrap || !W.AnchorWheelDocViewer) return false;

    const targetPath = activeFilePath;
    const targetKey = normKey(targetPath);
    if (!force && docOverlayDismissedKey === targetKey) return false;
    if (force) docOverlayDismissedKey = '';

    // Ensure encoding overlay isn't simultaneously active
    if (encodingOverlayVisible) {
      D.getElementById(OVERLAY_ID)?.remove();
      encodingOverlayVisible = false;
    }

    const mySeq = ++docRenderSeq;
    const { mountParent, hasNativeHeader } = resolveDocMountLayout(contentWrap);
    if (!mountParent) return false;

    let host = D.getElementById(DOC_OVERLAY_ID);
    if (!host || host.parentElement !== mountParent) {
      if (host) {
        try { host.remove(); } catch {}
      }
      host = markOwned(D.createElement('div'));
      host.id = DOC_OVERLAY_ID;
      host.className = 'aw-doc-overlay-host';
      mountParent.appendChild(host);
    }
    applyThemeAttr(host);
    hideNativeContentSiblings(mountParent, new Set([DOC_OVERLAY_ID]));
    docOverlayVisible = true;

    const hadPriorSameKey = lastRenderedDocKey === targetKey && Boolean(lastRenderedDocData);
    if (!hadPriorSameKey) {
      host.innerHTML = `<div class="aw-doc-loading-card">${meta.isVideo ? '正在检测并准备视频流' : '正在解析'} ${S?.esc ? S.esc(baseName(targetPath)) : baseName(targetPath)} ...</div>`;
    }
    const res = meta.isVideo
      ? await callRpc('prepareVideo', { path: targetPath }, 15000)
      : await callRpc('renderDocument', { path: targetPath }, 15000);
    if (destroyed || mySeq !== docRenderSeq || normKey(activeFilePath) !== targetKey) {
      return false;
    }
    if (!res || !res.ok) {
      host.innerHTML = `
        <div class="aw-doc-loading-card">
          <div style="margin-bottom:10px;color:var(--aw-fg);font-weight:600">无法在侧边栏直接渲染此文件</div>
          <div style="margin-bottom:12px">${S?.esc ? S.esc(res?.error || '格式暂不支持或文件受加密保护') : String(res?.error || '')}</div>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
            <button type="button" class="aw-primary-btn" id="aw-doc-err-ext">用系统软件打开</button>
            <button type="button" class="aw-ghost-btn" id="aw-doc-err-native">切回原生视图</button>
          </div>
        </div>
      `;
      host.querySelector('#aw-doc-err-ext')?.addEventListener('click', () => {
        void callRpc('openExternal', { path: targetPath }).then((r) => {
          if (!r?.ok) showToast(`外部打开失败：${r?.error || '未知错误'}`);
        });
      });
      host.querySelector('#aw-doc-err-native')?.addEventListener('click', () => {
        closeDocOverlay({ dismiss: true });
        renderStrip();
      });
      renderStrip();
      return false;
    }
    const docData = res;
    lastRenderedDocKey = targetKey;
    lastRenderedDocData = res;

    try { docViewerInstance?.destroy?.(); } catch {}
    docViewerInstance = W.AnchorWheelDocViewer.mountDocumentViewer(host, docData, {
      paperMode: Boolean(settings.richDocPaperMode),
      compactChrome: Boolean(hasNativeHeader),
      rawLabel: meta.optionalTable ? '源码视图' : '原生视图',
      onTogglePaperMode: (nextPaper) => {
        settings = { ...settings, richDocPaperMode: Boolean(nextPaper) };
        void callRpc('updateSettings', { settings: { richDocPaperMode: Boolean(nextPaper) } });
      },
      onRequestHiRes: (p) => callRpc('renderSlidesHiRes', { path: p || targetPath }, 32000),
      onPollVideoReady: meta.isVideo ? (p) => callRpc('prepareVideo', { path: p || targetPath }, 12000) : null,
      onReadMediaBlob: meta.isVideo ? (p, mode) => callRpc('readMediaBlob', { path: p || targetPath, mode: mode || '' }, 15000) : null,
      onNotify: (msg) => showToast(msg),
      onOpenExternal: async (p) => {
        const extRes = await callRpc('openExternal', { path: p || targetPath });
        if (extRes?.ok) showToast('已调用系统默认应用打开');
        else showToast(`外部打开失败：${extRes?.error || '未知错误'}`);
      },
      onSwitchToRaw: () => {
        closeDocOverlay({ dismiss: true });
        renderStrip();
      },
    });
    renderStrip();
    return true;
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

  function getEffectiveUpdateState() {
    const ignored = settings?.ignoredUpdateVersion || '';
    if (S?.computeUpdateStateClient) {
      return S.computeUpdateStateClient(latestUpdateInfo, ignored);
    }
    const avail = Boolean(latestUpdateInfo?.ok && latestUpdateInfo?.updateAvailable);
    const isIgnored = Boolean(avail && latestUpdateInfo?.isIgnored);
    return { updateAvailable: avail, ignoredVersion: ignored, isIgnored, shouldNotify: Boolean(avail && !isIgnored) };
  }

  function closeUpdatePushCard() {
    const existing = D.getElementById(UPDATE_PUSH_ID);
    if (existing) {
      try { existing.remove(); } catch {}
    }
  }

  async function ignoreUpdateVersionUi(version) {
    const cleanVer = String(version || '').trim().replace(/^v/i, '');
    settings = { ...settings, ignoredUpdateVersion: cleanVer };
    const res = await callRpc('ignoreUpdateVersion', { version: cleanVer }, 6000);
    if (res?.ok) {
      if (res.settings) settings = res.settings;
      if (res.updateInfo) latestUpdateInfo = res.updateInfo;
    } else if (latestUpdateInfo && latestUpdateInfo.ok) {
      latestUpdateInfo = {
        ...latestUpdateInfo,
        ...getEffectiveUpdateState(),
      };
    }
    if (cleanVer) {
      closeUpdatePushCard();
      showToast(`已忽略 v${cleanVer}，下个新版本发布时将再次提醒`);
    } else {
      showToast('已恢复新版本更新提醒');
    }
    renderStrip();
    syncUpdatePushCard();
    return { ok: true, settings, updateInfo: latestUpdateInfo };
  }

  function syncUpdatePushCard() {
    if (destroyed) return;
    const updState = getEffectiveUpdateState();
    const latestVer = String(latestUpdateInfo?.latestVersion || '');
    if (!updState.shouldNotify || !latestVer || latestVer === sessionDismissedUpdateVer || settingsModalInstance?.isOpen?.()) {
      closeUpdatePushCard();
      return;
    }
    const existing = D.getElementById(UPDATE_PUSH_ID);
    if (existing && existing.getAttribute('data-aw-ver') === latestVer) {
      applyThemeAttr(existing);
      return;
    }
    closeUpdatePushCard();

    const esc = (s) => (S?.esc ? S.esc(s) : String(s || ''));
    const curVer = latestUpdateInfo.currentVersion || bootMeta.version || '';
    const rawNotes = String(latestUpdateInfo.bodySnippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const summaryText = rawNotes || `当前 v${curVer} → 最新 v${latestVer}，可按需升级或跳过此版本。`;

    const card = markOwned(D.createElement('div'));
    card.id = UPDATE_PUSH_ID;
    card.className = 'aw-update-push-card';
    card.setAttribute('data-aw-ver', latestVer);
    applyThemeAttr(card);
    card.innerHTML = `
      <div class="aw-update-push-head">
        <div class="aw-update-push-title">
          <span class="aw-update-pill-dot"></span>
          <span>锚点轮盘发现新版本</span>
          <span class="aw-update-push-ver">v${esc(latestVer)}</span>
        </div>
        <button type="button" class="aw-tray-btn" data-aw-upd-act="later" title="稍后提醒">${S.ICONS.close}</button>
      </div>
      <div class="aw-update-push-body">${esc(summaryText)}</div>
      <div class="aw-update-push-actions">
        <button type="button" class="aw-ghost-btn" data-aw-upd-act="ignore">忽略此版本</button>
        <button type="button" class="aw-ghost-btn" data-aw-upd-act="later">稍后</button>
        <button type="button" class="aw-primary-btn" data-aw-upd-act="view">查看更新</button>
      </div>
    `;
    card.addEventListener('click', (e) => e.stopPropagation());
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    card.querySelectorAll('[data-aw-upd-act="later"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sessionDismissedUpdateVer = latestVer;
        closeUpdatePushCard();
      });
    });
    card.querySelector('[data-aw-upd-act="ignore"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void ignoreUpdateVersionUi(latestVer);
    });
    card.querySelector('[data-aw-upd-act="view"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionDismissedUpdateVer = latestVer;
      closeUpdatePushCard();
      openSettingsModal({ initialTab: 'storage', focusUpdateSection: true });
    });
    D.body.appendChild(card);
  }

  function openSettingsModal(opts = {}) {
    closePopover();
    closeAllNavigators();
    closeUpdatePushCard();
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
      initialTab: opts.initialTab || 'modes',
      focusUpdateSection: Boolean(opts.focusUpdateSection),
      onCheckUpdate: async (force = true) => {
        const res = await callRpc('checkUpdate', { force: Boolean(force) }, 10000);
        if (res && (res.ok || res.error)) {
          latestUpdateInfo = res;
          renderStrip();
          syncUpdatePushCard();
        }
        return res;
      },
      onIgnoreUpdate: (ver) => ignoreUpdateVersionUi(ver),
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
        if (docOverlayVisible && (settings.richDocPreviewEnabled === false || settings.richDocAutoStrategy === 'manual_only')) {
          closeDocOverlay({ dismiss: false });
        } else if (docOverlayVisible && docViewerInstance?.setPaperMode) {
          docViewerInstance.setPaperMode(Boolean(settings.richDocPaperMode));
          const contentWrap = getContentContainer(getRightPaneColumn());
          const hostState = inspectHostFileViewState(contentWrap);
          const meta = getActiveRichDocMeta();
          if (settings.richDocAutoStrategy === 'auto_yield' && hostState === 'native_rich' && !meta?.preferWhenRawCode) {
            closeDocOverlay({ dismiss: false });
          }
        } else if (!docOverlayVisible && settings.richDocPreviewEnabled !== false) {
          const meta = getActiveRichDocMeta();
          const contentWrap = getContentContainer(getRightPaneColumn());
          const hostState = inspectHostFileViewState(contentWrap);
          if (shouldAutoOpenDocOverlay(meta, hostState) && docOverlayDismissedKey !== normKey(activeFilePath)) {
            void openDocOverlay({ force: false });
          }
        }
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

    const activeRichMeta = getActiveRichDocMeta();
    if (activeRichMeta && !docOverlayVisible) {
      const docBtn = markOwned(D.createElement('button'));
      docBtn.className = 'aw-status-pill';
      docBtn.setAttribute('data-aw-role', 'doc-preview-btn');
      if (lastHostPreviewState !== 'native_rich' && lastHostPreviewState !== 'companion_mounted') {
        docBtn.setAttribute('data-has-links', '1');
      }
      const pillLabel =
        activeRichMeta.pillLabel || (activeRichMeta.optionalTable ? '表格预览' : `${activeRichMeta.badge} 预览`);
      docBtn.textContent = pillLabel;
      docBtn.title = activeRichMeta.optionalTable
        ? `以结构化表格方式查看此 ${activeRichMeta.badge} 文件`
        : lastHostPreviewState === 'native_rich'
        ? `宿主已提供原生预览；点击可切换至锚点轮盘 ${activeRichMeta.badge} 视图`
        : `在侧边栏直接渲染此 ${activeRichMeta.badge} 文件`;
      docBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void openDocOverlay({ force: true });
      });
      strip.appendChild(docBtn);
    }

    const domHasMojibake = (() => {
      if (!contentEl || activeIsDirectory || docOverlayVisible || activeRichMeta?.isBinaryDoc) return false;
      return (contentEl.textContent || '').slice(0, 2000).includes('\uFFFD');
    })();
    if (
      activeFilePath &&
      !activeIsDirectory &&
      !activeRichMeta?.isBinaryDoc &&
      (activeEncodingInfo?.isNonUtf8 || activeEncodingInfo?.mojibakeHint || domHasMojibake || encodingOverlayVisible)
    ) {
      const encBtn = markOwned(D.createElement('button'));
      encBtn.className = 'aw-status-pill';
      encBtn.setAttribute('data-warn', '1');
      encBtn.textContent = encodingOverlayVisible ? '恢复原生' : `修复乱码 (${String(activeEncodingInfo?.encoding || 'GBK').toUpperCase()})`;
      encBtn.addEventListener('click', () => void toggleEncodingRepairOverlay(''));
      strip.appendChild(encBtn);
    }

    if (isLocalAbsolutePath(activeFilePath)) {
      const expLabels = getSystemExplorerLabels({ preferEnglish: false });
      const revealBtn = markOwned(D.createElement('button'));
      revealBtn.setAttribute('data-aw-role', 'reveal-btn');
      if (activeIsDirectory) {
        revealBtn.className = 'aw-status-pill';
        revealBtn.title = `${expLabels.stripTipDir}\n${activeFilePath}`;
        revealBtn.innerHTML = `${S.ICONS.folderOpen}<span class="aw-strip-reveal-label">${S?.esc ? S.esc(expLabels.stripDir) : expLabels.stripDir}</span>`;
      } else {
        revealBtn.className = 'aw-tray-btn';
        revealBtn.title = `${expLabels.stripTipFile}\n${activeFilePath}`;
        revealBtn.innerHTML = S.ICONS.folderOpen;
      }
      revealBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void revealPathInExplorer(activeFilePath, { isDirectory: activeIsDirectory });
      });
      strip.appendChild(revealBtn);
    }

    const updState = getEffectiveUpdateState();
    if (updState.shouldNotify && latestUpdateInfo?.latestVersion) {
      const updPill = markOwned(D.createElement('button'));
      updPill.className = 'aw-update-pill';
      updPill.setAttribute('data-aw-role', 'update-pill');
      updPill.title = `发现新版本 v${latestUpdateInfo.latestVersion}（点击查看更新或忽略此版本）`;
      updPill.innerHTML = `<span class="aw-update-pill-dot"></span><span>新版 v${S?.esc ? S.esc(latestUpdateInfo.latestVersion) : latestUpdateInfo.latestVersion}</span>`;
      updPill.addEventListener('click', (e) => {
        e.stopPropagation();
        sessionDismissedUpdateVer = latestUpdateInfo.latestVersion;
        closeUpdatePushCard();
        openSettingsModal({ initialTab: 'storage', focusUpdateSection: true });
      });
      strip.appendChild(updPill);
    }

    const setBtn = markOwned(D.createElement('button'));
    setBtn.className = 'aw-tray-btn';
    setBtn.setAttribute('data-aw-role', 'settings-btn');
    if (updState.shouldNotify && latestUpdateInfo?.latestVersion) {
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
      closeDocOverlay({ dismiss: false });
      docOverlayDismissedKey = '';
      lastRenderedDocKey = '';
      lastRenderedDocData = null;
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
        if (bootRes.updateInfo) {
          latestUpdateInfo = bootRes.updateInfo;
          syncUpdatePushCard();
        }
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
              syncUpdatePushCard();
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
      closeDocOverlay({ dismiss: false });
      docOverlayDismissedKey = '';
      lastRenderedDocKey = '';
      lastRenderedDocData = null;
      lastHostPreviewState = 'unknown';
      docProbeCount = 0;
      clearTimeout(docProbeTimer);
      docProbeTimer = null;
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

    const activeDocMeta = getActiveRichDocMeta();
    if (activeFilePath && (changedFile || !activeFileLinks.path)) {
      const [linksRes, encRes] = await Promise.all([
        callRpc('getBacklinks', { path: activeFilePath, workspaceRoots: wsRoots }),
        !activeIsDirectory && !activeDocMeta?.isBinaryDoc && settings.encodingAutoDetect !== false
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

    // Native-First Auto-Yield rich document preview:
    // Auto-render when Antigravity shows an unsupported placeholder (or raw source for .ipynb/.eml/.obj/.stl);
    // automatically yield when Antigravity natively renders a real rich preview!
    const contentWrap = getContentContainer(getRightPaneColumn());
    lastHostPreviewState = activeDocMeta && contentWrap ? inspectHostFileViewState(contentWrap) : 'none';
    if (
      activeDocMeta &&
      activeDocMeta.autoRender &&
      settings.richDocPreviewEnabled !== false &&
      docOverlayDismissedKey !== normKey(activeFilePath)
    ) {
      if (shouldAutoOpenDocOverlay(activeDocMeta, lastHostPreviewState)) {
        clearTimeout(docProbeTimer);
        docProbeTimer = null;
        const { mountParent } = resolveDocMountLayout(contentWrap);
        const curOverlay = D.getElementById(DOC_OVERLAY_ID);
        if (!docOverlayVisible || !curOverlay || curOverlay.parentElement !== mountParent) {
          void openDocOverlay({ force: false });
        } else {
          hideNativeContentSiblings(mountParent, new Set([DOC_OVERLAY_ID]));
        }
      } else if (lastHostPreviewState === 'empty_loading' && !docOverlayVisible && docProbeCount < 4) {
        clearTimeout(docProbeTimer);
        docProbeTimer = setTimeout(() => {
          docProbeTimer = null;
          docProbeCount++;
          if (!destroyed) void refreshState();
        }, 130);
      } else if (
        docOverlayVisible &&
        (settings.richDocAutoStrategy || 'auto_yield') === 'auto_yield' &&
        (lastHostPreviewState === 'native_rich' || lastHostPreviewState === 'companion_mounted') &&
        !(lastHostPreviewState === 'raw_code_only' && activeDocMeta.preferWhenRawCode)
      ) {
        closeDocOverlay({ dismiss: false });
      }
    } else if (!activeDocMeta && docOverlayVisible) {
      closeDocOverlay({ dismiss: false });
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
    if (ev.target?.closest?.('[data-testid="more-actions-overflow"]')) {
      const col = getRightPaneColumn();
      if (col && col.contains(ev.target)) {
        scheduleOverflowMenuEnhance({ retries: true });
      }
      return;
    }
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

  function getWheelTriggerMeta() {
    if (S?.resolveWheelTriggerButton) return S.resolveWheelTriggerButton(settings);
    const id = settings?.wheelTriggerButton || (settings?.wheelTrigger === 'right_drag' ? 'right' : 'middle');
    if (id === 'right') return { id: 'right', button: 2, buttonsMask: 2, shortLabel: '右键', holdMs: 135, dragPx: 8 };
    if (id === 'side_back') return { id: 'side_back', button: 3, buttonsMask: 8, shortLabel: '后退侧键', holdMs: 65, dragPx: 5 };
    if (id === 'side_forward') return { id: 'side_forward', button: 4, buttonsMask: 16, shortLabel: '前进侧键', holdMs: 65, dragPx: 5 };
    return { id: 'middle', button: 1, buttonsMask: 4, shortLabel: '中键', holdMs: 115, dragPx: 8 };
  }

  function armSuppressAuxClick(ms = 220) {
    suppressNextAuxClick = true;
    clearTimeout(suppressAuxTimer);
    suppressAuxTimer = setTimeout(() => {
      suppressNextAuxClick = false;
      suppressAuxTimer = null;
    }, ms);
  }

  function armSuppressContextMenu(ms = 280) {
    suppressNextContextMenu = true;
    clearTimeout(suppressCtxTimer);
    suppressCtxTimer = setTimeout(() => {
      suppressNextContextMenu = false;
      suppressCtxTimer = null;
    }, ms);
  }

  function onCaptureMouseDown(ev) {
    if (destroyed) return;
    if (!isInsideRightContent(ev.target)) return;
    const midMode = settings.middleMode || 'bilateral_wheel';
    const trig = getWheelTriggerMeta();
    if (ev.button === 1) {
      if (
        extractLinkMetaFromTarget(ev.target) ||
        (activeIsDirectory && extractDirectoryRowMetaFromTarget(ev.target)) ||
        (midMode !== 'off' && trig.button === 1)
      ) {
        ev.preventDefault();
      }
      return;
    }
    if ((ev.button === 3 || ev.button === 4) && midMode !== 'off' && trig.button === ev.button) {
      ev.preventDefault();
    }
  }

  function onCaptureAuxClick(ev) {
    if (destroyed) return;
    if (suppressNextAuxClick && (ev.button === 1 || ev.button === 3 || ev.button === 4)) {
      suppressNextAuxClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      return;
    }
    const midMode = settings.middleMode || 'bilateral_wheel';
    const trig = getWheelTriggerMeta();
    if ((ev.button === 3 || ev.button === 4) && midMode !== 'off' && trig.button === ev.button && isInsideRightContent(ev.target)) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      return;
    }
    if (ev.button !== 1) return;
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
    if (destroyed) return;
    if (suppressNextContextMenu || holdWheelActiveButton === 2) {
      suppressNextContextMenu = false;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      return;
    }
    const ctxTarget = extractContextTargetFromEvent(ev.target);
    if (!ctxTarget) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    openExplorerContextMenu(ctxTarget, ev.clientX, ev.clientY);
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
  let holdWheelActiveButton = -1;

  function openHoldWheelAtOrigin(origin) {
    const midMode = settings.middleMode || 'bilateral_wheel';
    if (midMode === 'off') return false;
    let opened = false;
    if (midMode === 'classic_wheel') {
      const target = getWheelTargetGroup();
      opened = target ? openClassicWheelForTarget(target, origin.x, origin.y, { holdMode: true, holdButton: origin.button }) : false;
    } else {
      const syncCtx = getSyncNavContext(navScopeOverride);
      if (!syncCtx?.current) return false;
      const usedCache = syncCtx === cachedNavContext;
      opened = openBilateralForContext(syncCtx, origin.x, origin.y, { holdMode: true, holdButton: origin.button });
      if (opened && !usedCache) {
        void fetchNavContext(navScopeOverride).then((fresh) => {
          if (fresh && bilateralInstance?.isOpen?.()) bilateralInstance.updateContext(fresh);
        });
      }
    }
    if (opened) {
      holdWheelActiveButton = origin.button;
      if (origin.button === 1 || origin.button === 3 || origin.button === 4) {
        armSuppressAuxClick(260);
      } else if (origin.button === 2) {
        suppressNextContextMenu = true;
        clearTimeout(suppressCtxTimer);
        suppressCtxTimer = null;
      }
    }
    return opened;
  }

  function onPointerDown(ev) {
    if (destroyed || !isInsideRightContent(ev.target)) return;
    if (ev.target?.closest?.('[data-aw-owned="1"]')) {
      const allowPassthrough = Boolean(
        ev.target?.closest?.('[data-aw-wheel-passthrough="1"]') &&
        !ev.target?.closest?.('button, a, input, select, textarea, summary, label, .aw-doc-toolbar, .aw-doc-findbar, .aw-doc-sheetbar, .aw-doc-outline')
      );
      if (!allowPassthrough) return;
    }
    const midMode = settings.middleMode || 'bilateral_wheel';
    const trig = getWheelTriggerMeta();
    if (midMode === 'off' || ev.button !== trig.button) return;
    // Middle-click on links preserves background tab opening; right-click or side-button hold can still trigger wheel
    if (ev.button === 1 && extractLinkMetaFromTarget(ev.target)) return;
    if (ev.button !== 2) ev.preventDefault();

    const origin = {
      x: ev.clientX,
      y: ev.clientY,
      button: trig.button,
      dragPx: trig.dragPx,
      opened: false,
      inRightContent: true,
      downAt: Date.now(),
    };
    holdOrigin = origin;
    holdTimer = setTimeout(() => {
      if (holdOrigin === origin && !origin.opened) {
        origin.opened = true;
        openHoldWheelAtOrigin(origin);
      }
    }, trig.holdMs);
  }

  function onPointerMove(ev) {
    if (!holdOrigin || holdOrigin.opened) return;
    const threshold = Number(holdOrigin.dragPx || 8);
    if (Math.hypot(ev.clientX - holdOrigin.x, ev.clientY - holdOrigin.y) >= threshold) {
      clearTimeout(holdTimer);
      holdOrigin.opened = true;
      openHoldWheelAtOrigin(holdOrigin);
    }
  }

  function onPointerUp(ev) {
    const prevOrigin = holdOrigin;
    const wasHoldWheel = holdWheelActiveButton === ev.button || Boolean(prevOrigin && prevOrigin.opened && prevOrigin.button === ev.button);
    clearTimeout(holdTimer);
    holdOrigin = null;
    if (destroyed) return;

    if (wasHoldWheel) {
      holdWheelActiveButton = -1;
      if (ev.button === 2) {
        armSuppressContextMenu(280);
      } else if (ev.button === 1 || ev.button === 3 || ev.button === 4) {
        armSuppressAuxClick(220);
      }
      ev.preventDefault();
      return;
    }

    if (ev.button === 3 || ev.button === 4) {
      const midMode = settings.middleMode || 'bilateral_wheel';
      const trig = getWheelTriggerMeta();
      if (midMode !== 'off' && trig.button === ev.button && (prevOrigin?.inRightContent || isInsideRightContent(ev.target))) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      void stepHistory(ev.button === 3 ? 'back' : 'forward');
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
    if (ev.key === 'Escape' && activePopoverName) {
      closePopover();
      return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target?.closest?.('[data-testid="more-actions-overflow"]')) {
      scheduleOverflowMenuEnhance({ retries: true });
    }
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

    domObserver = new MutationObserver((mutations) => {
      if (destroyed) return;
      for (const m of mutations) {
        if (!m.addedNodes || !m.addedNodes.length) continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || node.getAttribute?.('data-aw-owned') === '1') continue;
          if (node.matches?.('[role="menu"]') || node.querySelector?.('[role="menu"]')) {
            scheduleOverflowMenuEnhance({ retries: false });
            break;
          }
        }
      }
      if (obsThrottle) return;
      obsThrottle = setTimeout(() => {
        obsThrottle = null;
        if (destroyed) return;
        ensureStoreSubscription();
        const tabKey = `${W.location?.pathname}|${W.location?.search}`;
        const col = getRightPaneColumn();
        const contentEl = getContentContainer(col);
        const strip = D.getElementById(STRIP_ID);
        if (col?.querySelector?.('[data-testid="more-actions-overflow"][aria-expanded="true"]')) {
          enhanceNativeOverflowMenus();
        }
        if (tabKey !== lastObservedTabKey) {
          lastObservedTabKey = tabKey;
          scheduleSync();
          return;
        }
        if (col && contentEl && (!strip || strip.parentElement !== col)) {
          scheduleSync();
          return;
        }
        if (docOverlayVisible && contentEl) {
          const { mountParent } = resolveDocMountLayout(contentEl);
          const docOv = D.getElementById(DOC_OVERLAY_ID);
          if (!docOv || docOv.parentElement !== mountParent) {
            scheduleSync();
          } else {
            hideNativeContentSiblings(mountParent, new Set([DOC_OVERLAY_ID]));
          }
        } else if (!docOverlayVisible && contentEl && getActiveRichDocMeta()?.autoRender) {
          const nextHostState = inspectHostFileViewState(contentEl);
          if (nextHostState !== lastHostPreviewState) {
            scheduleSync();
          }
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
      const contentWrap = getContentContainer(col);
      const updState = getEffectiveUpdateState();
      return {
        version: bootMeta.version || BOOT.version || '',
        conversationId: lastConversationId || resolveConversationId(),
        activeFilePath,
        activeIsDirectory,
        dirChildCount: activeIsDirectory ? (cachedNavContext?.current?.children?.length || 0) : 0,
        docOverlayVisible,
        activeDocFormat: lastRenderedDocData?.format || '',
        docOutlineCount: lastRenderedDocData?.outline?.length || 0,
        hostPreviewState: contentWrap ? inspectHostFileViewState(contentWrap) : 'missing',
        richDocAutoStrategy: settings.richDocAutoStrategy || 'auto_yield',
        wheelTriggerButton: settings.wheelTriggerButton || 'middle',
        updateShouldNotify: updState.shouldNotify,
        updateIgnored: updState.isIgnored,
        ignoredUpdateVersion: settings.ignoredUpdateVersion || '',
        updatePushVisible: Boolean(D.getElementById(UPDATE_PUSH_ID)),
        activePopoverName,
        outlinkCount: activeFileLinks.outlinks?.length || 0,
        backlinkCount: activeFileLinks.backlinks?.length || 0,
        hasContentContainer: Boolean(contentWrap),
        contentContainerIndex: col ? Array.from(col.children).indexOf(contentWrap) : -1,
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
        if (docOverlayVisible && (settings.richDocPreviewEnabled === false || settings.richDocAutoStrategy === 'manual_only')) {
          closeDocOverlay({ dismiss: false });
        } else if (docOverlayVisible && docViewerInstance?.setPaperMode) {
          docViewerInstance.setPaperMode(Boolean(settings.richDocPaperMode));
        }
      }
      if (payload.updateInfo !== undefined) {
        latestUpdateInfo = payload.updateInfo;
      }
      if (payload.session && (!payload.conversationId || payload.conversationId === resolveConversationId())) {
        session = payload.session;
      }
      applyNonDestructiveTabFolding();
      renderStrip();
      syncUpdatePushCard();
      void refreshPersistentNavigatorIfOpen();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(syncTimer);
      clearTimeout(holdTimer);
      clearTimeout(obsThrottle);
      clearTimeout(bgUpdateTimer);
      clearTimeout(docProbeTimer);
      clearTimeout(suppressAuxTimer);
      clearTimeout(suppressCtxTimer);
      if (menuEnhanceRaf) {
        cancelAnimationFrame(menuEnhanceRaf);
        menuEnhanceRaf = 0;
      }
      for (const tid of menuEnhanceTimers) clearTimeout(tid);
      menuEnhanceTimers = [];
      syncTimer = null;
      holdTimer = null;
      obsThrottle = null;
      bgUpdateTimer = null;
      docProbeTimer = null;
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
      closeDocOverlay({ dismiss: false });
      closeAllNavigators();
      closeUpdatePushCard();
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
