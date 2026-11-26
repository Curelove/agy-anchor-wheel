(function () {
  'use strict';

  const qs = new URLSearchParams(window.location.search);
  const conversationId = window.sidecar?.conversationId || qs.get('conversationId') || 'default';
  const apiFetch = (url, opts) => (window.sidecar?.fetch ? window.sidecar.fetch(url, opts) : fetch(url, opts));

  const state = {
    settings: null,
    session: null,
    status: null,
    updateInfo: null,
    workspaceRoots: [],
    tabs: [],
    activeTabPath: '',
    currentDoc: null,
    currentLinks: { backlinks: [], outlinks: [] },
    navContext: null,
    navScopeOverride: '',
    activeTabNavMode: false,
    activePopover: null,
    dragPayload: null,
    docViewerInstance: null,
  };

  const els = {
    topbar: document.getElementById('aw-topbar'),
    tabScroll: document.getElementById('aw-tab-scroll'),
    btnBack: document.getElementById('aw-btn-back'),
    btnForward: document.getElementById('aw-btn-forward'),
    btnUpdatePill: document.getElementById('aw-btn-update-pill'),
    updatePillLabel: document.getElementById('aw-update-pill-label'),
    btnFiles: document.getElementById('aw-btn-files'),
    btnSettings: document.getElementById('aw-btn-settings'),
    crumbText: document.getElementById('aw-crumb-text'),
    btnTree: document.getElementById('aw-btn-tree'),
    btnPinAnchor: document.getElementById('aw-btn-pin-anchor'),
    pinAnchorLabel: document.getElementById('aw-pin-anchor-label'),
    btnLinks: document.getElementById('aw-btn-links'),
    linksLabel: document.getElementById('aw-links-label'),
    btnReveal: document.getElementById('aw-btn-reveal'),
    revealLabel: document.getElementById('aw-reveal-label'),
    btnEncoding: document.getElementById('aw-btn-encoding'),
    encodingLabel: document.getElementById('aw-encoding-label'),
    encodingBanner: document.getElementById('aw-encoding-banner'),
    reader: document.getElementById('aw-reader'),
    popoverRoot: document.getElementById('aw-popover-root'),
  };

  const S = window.AnchorWheelNavShared;
  const ICONS = window.AnchorWheelUI.ICONS;
  let lastHostPrismTheme = '';
  const previewOpts = {
    document,
    mountRoot: document.body,
    fetchPreview: (p, o = {}) =>
      apiPost('/api/preview', { path: p, animated: o.animated ?? state.settings?.videoPreviewAnimated !== false }),
    getDelayMs: () => state.settings?.hoverPreviewDelayMs ?? 250,
    getAnimated: () => state.settings?.videoPreviewAnimated !== false,
    isPreviewEnabled: () => state.settings?.hoverPreviewEnabled !== false,
    getHotkey: () => state.settings?.tabCustomHotkey || 'Tab',
    standaloneRawUrl: (p) => `/api/file/raw?path=${encodeURIComponent(p)}`,
  };
  const wheel = window.AnchorWheelUI.createRadialWheel({ document, mountRoot: document.body });
  const bilateral = window.AnchorWheelBilateral.createBilateralWheel(previewOpts);
  const aeTree = window.AnchorWheelTree.createAeTree(previewOpts);
  const settingsModal = window.AnchorWheelSettingsModal.createSettingsModal({
    document,
    mountRoot: document.body,
    resolveHostTheme: () => lastHostPrismTheme,
  });

  function normKey(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function baseName(p) {
    const parts = String(p || '').split(/[\\/]/);
    return parts[parts.length - 1] || String(p || '');
  }

  function applyThemeFromSettings() {
    const t = state.settings?.theme || 'auto';
    if (t === 'auto') {
      if (lastHostPrismTheme) document.documentElement.setAttribute('data-aw-theme', lastHostPrismTheme);
      else document.documentElement.removeAttribute('data-aw-theme');
    } else {
      document.documentElement.setAttribute('data-aw-theme', t);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'ag-prism-workbench-sync') {
      const p = ev.data;
      const mapped = p.theme === 'light'
        ? (p.lightPreset === 'alabaster' ? 'alabaster' : 'crystal')
        : (p.palette === 'warm' || p.palette === 'claude' ? 'warm' : 'obsidian');
      lastHostPrismTheme = mapped;
      if (state.settings?.theme === 'auto') {
        document.documentElement.setAttribute('data-aw-theme', mapped);
      }
    }
  });

  async function apiGet(url) {
    const res = await apiFetch(url, { method: 'GET' });
    return res.json();
  }

  async function apiPost(url, body) {
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  function getActiveGroup() {
    const groups = state.session?.groups || [];
    if (!groups.length) return null;
    return groups.find((g) => g.id === state.session.activeGroupId) || groups[0];
  }

  function findGroupByChildOrAnchor(filePath) {
    const k = normKey(filePath);
    for (const g of state.session?.groups || []) {
      if (normKey(g.anchorPath) === k) return { group: g, role: 'anchor' };
      if (g.children?.some((c) => normKey(c.path) === k)) return { group: g, role: 'child' };
    }
    return null;
  }

  function resolveRelativeTarget(rawTarget, sourceFilePath) {
    const clean = String(rawTarget || '').trim();
    if (!clean) return '';
    const lineSplit = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/i.exec(clean);
    const pathPart = lineSplit ? lineSplit[1] : clean;
    const lineStart = lineSplit && lineSplit[2] ? Number(lineSplit[2]) : null;

    if (/^(?:file:\/\/\/|[A-Za-z]:[\\/]|\/(?!\/))/.test(pathPart)) {
      return { target: pathPart, lineStart };
    }
    // Try matching outlinks from currentLinks first (already resolved on backend!)
    const hit = (state.currentLinks?.outlinks || []).find(
      (o) => o.rawTarget === clean || o.rawTarget === pathPart
    );
    if (hit && hit.resolvedPath) {
      return { target: hit.resolvedPath, lineStart: lineStart || hit.lineStart || null };
    }
    // Fallback combine with source dir
    const sep = sourceFilePath.includes('\\') ? '\\' : '/';
    const dir = sourceFilePath.slice(0, Math.max(sourceFilePath.lastIndexOf('/'), sourceFilePath.lastIndexOf('\\')));
    const combined = dir ? `${dir}${sep}${pathPart}` : pathPart;
    return { target: combined, lineStart };
  }

  function syncHistoryButtons() {
    const hist = state.session?.history || { entries: [], index: -1 };
    els.btnBack.disabled = hist.index <= 0;
    els.btnForward.disabled = hist.index < 0 || hist.index >= hist.entries.length - 1;
  }

  function renderTabsBar() {
    const groups = state.session?.groups || [];
    const activeKey = normKey(state.activeTabPath);
    const foldedKeys = new Set();

    els.tabScroll.innerHTML = '';

    for (const grp of groups) {
      const aKey = normKey(grp.anchorPath);
      for (const ch of grp.children || []) foldedKeys.add(normKey(ch.path));

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'aw-anchor-pill';
      pill.title = `优先母页：${grp.anchorPath}\n点击名称切回母页，点击数字呼出轮盘；可拖入链接收编`;
      if (aKey === activeKey) pill.style.borderColor = 'var(--aw-accent)';

      const iconWrap = document.createElement('span');
      iconWrap.innerHTML = ICONS.anchor;
      iconWrap.style.color = 'var(--aw-accent)';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'aw-anchor-pill-name';
      nameSpan.textContent = baseName(grp.anchorTitle || grp.anchorPath);

      const badge = document.createElement('span');
      badge.className = 'aw-count-badge';
      badge.textContent = String(grp.children?.length || 0);
      badge.title = '打开锚点轮盘';

      pill.appendChild(iconWrap);
      pill.appendChild(nameSpan);
      pill.appendChild(badge);

      pill.addEventListener('click', (ev) => {
        if (ev.target === badge) {
          ev.stopPropagation();
          const rect = badge.getBoundingClientRect();
          openWheelForGroup(grp, rect.left + rect.width / 2, rect.bottom + 140, false);
          return;
        }
        // If already viewing anchor, clicking pill opens wheel; otherwise jump back to anchor
        if (aKey === activeKey) {
          const rect = pill.getBoundingClientRect();
          openWheelForGroup(grp, rect.left + rect.width / 2, rect.bottom + 140, false);
        } else {
          void openFile(grp.anchorPath, { inNewTab: true, isDirectory: Boolean(grp.anchorIsDirectory) });
        }
      });

      // Drag-and-drop onto Priority Anchor Pill to adopt into this group
      pill.addEventListener('dragover', (e) => {
        e.preventDefault();
        pill.setAttribute('data-dragover', '1');
      });
      pill.addEventListener('dragleave', () => pill.removeAttribute('data-dragover'));
      pill.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pill.removeAttribute('data-dragover');
        const linkPath = e.dataTransfer?.getData('text/aw-link') || state.dragPayload;
        if (linkPath) {
          const resolved = resolveRelativeTarget(linkPath, state.activeTabPath);
          void adoptAndOpen(resolved.target, grp.id, { openInForeground: true, lineStart: resolved.lineStart });
        }
      });

      els.tabScroll.appendChild(pill);
    }

    // Standalone ungrouped tabs (not folded inside an Anchor Group)
    for (const tab of state.tabs) {
      const k = normKey(tab.path);
      if (foldedKeys.has(k)) continue;
      if (groups.some((g) => normKey(g.anchorPath) === k)) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'aw-tab-btn';
      btn.setAttribute('data-active', k === activeKey ? '1' : '0');
      btn.title = tab.path;

      const label = document.createElement('span');
      label.className = 'aw-tab-name';
      label.textContent = baseName(tab.title || tab.path);
      if (tab.isDirectory) {
        const ico = document.createElement('span');
        ico.innerHTML = S.ICONS.folder;
        ico.style.display = 'inline-flex';
        ico.style.color = 'var(--aw-accent)';
        btn.appendChild(ico);
      }

      const closeBtn = document.createElement('span');
      closeBtn.className = 'aw-tab-close';
      closeBtn.innerHTML = ICONS.close;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeStandaloneTab(tab.path);
      });

      btn.appendChild(label);
      btn.appendChild(closeBtn);
      btn.addEventListener('click', () => void openFile(tab.path, { inNewTab: true, isDirectory: Boolean(tab.isDirectory) }));
      els.tabScroll.appendChild(btn);
    }

    // If current tab is a folded child of a group, show a compact active-child chip next to its group
    const activeRel = findGroupByChildOrAnchor(state.activeTabPath);
    if (activeRel && activeRel.role === 'child') {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'aw-tab-btn';
      chip.setAttribute('data-active', '1');
      chip.title = `当前在组内子页：${state.activeTabPath}`;
      chip.innerHTML = `<span class="aw-tab-name">${baseName(state.activeTabPath)}</span>`;
      chip.addEventListener('click', () => {
        const rect = chip.getBoundingClientRect();
        openWheelForGroup(activeRel.group, rect.left + rect.width / 2, rect.bottom + 140, false);
      });
      els.tabScroll.appendChild(chip);
    }

    syncHistoryButtons();
  }

  function closeStandaloneTab(filePath) {
    const k = normKey(filePath);
    state.tabs = state.tabs.filter((t) => normKey(t.path) !== k);
    if (normKey(state.activeTabPath) === k) {
      const next = state.tabs[state.tabs.length - 1] || state.session?.groups?.[0];
      if (next) {
        void openFile(next.path || next.anchorPath, { skipHistory: true });
      } else {
        state.activeTabPath = '';
        state.currentDoc = null;
        renderHomeDesk();
      }
    }
    renderTabsBar();
  }

  function buildLiveTabsGroup() {
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];
    const anchorPath = state.activeTabPath || tabs[0]?.path || '';
    if (!anchorPath) return null;
    const anchorKey = normKey(anchorPath);
    const children = tabs
      .filter((t) => normKey(t.path) !== anchorKey)
      .map((t) => ({ path: t.path, title: t.title || baseName(t.path) }));
    return {
      id: '__live_tabs__',
      anchorPath,
      anchorTitle: baseName(anchorPath),
      children,
    };
  }

  function getWheelTargetGroup() {
    const grp = getActiveGroup();
    if (grp) return { group: grp, isLiveFallback: false };
    const live = buildLiveTabsGroup();
    if (live) return { group: live, isLiveFallback: true };
    return null;
  }

  function openWheelForTarget(target, x, y, holdMode = false, holdButton = 1, extra = {}) {
    if (!target || !target.group) return;
    settingsModal.close();
    closePopover();
    bilateral.close();
    aeTree.close();
    const { group, isLiveFallback } = target;
    state.activeTabNavMode = Boolean(extra.fromTabMode && !holdMode);
    wheel.open({
      group,
      x,
      y,
      holdMode,
      holdButton,
      persistOnScroll: Boolean(extra.persistOnScroll),
      closeOnSelect: holdMode || !extra.fromTabMode || Boolean(state.settings?.tabCloseOnSelect),
      sectors: state.settings?.wheelSectors || 8,
      hubTag: isLiveFallback ? '当前页' : '母页',
      isLiveFallback,
      emptyHint: isLiveFallback
        ? (group.children?.length ? '当前已打开标签' : '点击下方设为母页或点 MD 链接')
        : '点击 MD 链接即收编进本组',
      onSelect: (picked) => {
        const keepNav = Boolean(extra.fromTabMode && !state.settings?.tabCloseOnSelect);
        void openFile(picked.path, {
          inNewTab: true,
          isDirectory: Boolean(picked.isDirectory),
          fromGroupId: isLiveFallback ? undefined : group.id,
          skipLineage: Boolean(picked.isAnchor),
          keepNavigator: keepNav,
        });
      },
      onToggleLock: isLiveFallback
        ? null
        : async (ch) => {
            const res = await apiPost('/api/session', { conversationId, op: 'toggleLock', groupId: group.id, path: ch.path });
            if (res.ok && res.session) {
              state.session = res.session;
              renderTabsBar();
              const refreshed = state.session.groups.find((g) => g.id === group.id);
              if (refreshed) wheel.updateGroup(refreshed);
            }
          },
      onRemoveChild: isLiveFallback
        ? null
        : async (ch) => {
            const res = await apiPost('/api/session', { conversationId, op: 'removeChild', groupId: group.id, path: ch.path });
            if (res.ok && res.session) {
              state.session = res.session;
              renderTabsBar();
              const refreshed = state.session.groups.find((g) => g.id === group.id);
              if (refreshed) wheel.updateGroup(refreshed);
            }
          },
      onPinCurrent: state.activeTabPath
        ? async () => {
            const isDir = Boolean(state.currentDoc?.isDirectory);
            const res = await apiPost('/api/session', {
              conversationId,
              op: 'pinAnchor',
              path: state.activeTabPath,
              title: (!isDir && state.currentLinks?.title) || baseName(state.activeTabPath),
              isDirectory: isDir,
            });
            if (res.ok && res.session) {
              state.session = res.session;
              updateSubbar();
              renderTabsBar();
              showToast(`已设为优先母页：${baseName(state.activeTabPath)}`);
            }
          }
        : null,
      onShowOutlinks: state.activeTabPath ? () => openLinksPopover(els.btnLinks, 'outlinks') : null,
    });
  }

  function openWheelForGroup(group, x, y, holdMode = false) {
    if (!group) return;
    openWheelForTarget({ group, isLiveFallback: false }, x, y, holdMode, 1);
  }

  function getSyncNavContext(scopeOverride = '') {
    const curIsDir = Boolean(state.currentDoc?.isDirectory);
    if (
      state.navContext &&
      normKey(state.navContext.activePath) === normKey(state.activeTabPath) &&
      Boolean(state.navContext.current?.isDirectory) === curIsDir &&
      (!scopeOverride || state.navContext.childSourceScope === scopeOverride)
    ) {
      return state.navContext;
    }
    return S.buildFallbackNavContext({
      session: state.session,
      settings: state.settings,
      activePath: state.activeTabPath,
      activeIsDirectory: curIsDir,
      activeLinks: state.currentLinks,
      openTabs: state.tabs,
      scopeOverride,
    });
  }

  async function refreshNavContext(scopeOverride = '') {
    if (!state.activeTabPath) return null;
    const res = await apiPost('/api/nav-context', {
      conversationId,
      path: state.activeTabPath,
      isDirectory: Boolean(state.currentDoc?.isDirectory),
      openTabs: state.tabs,
      scope: scopeOverride || state.navScopeOverride || '',
      workspaceRoots: state.workspaceRoots,
    });
    if (res && res.ok && res.current) {
      state.navContext = res;
      return res;
    }
    state.navContext = getSyncNavContext(scopeOverride);
    return state.navContext;
  }

  function openBilateralWheel(x, y, { holdMode = false, holdButton = 1, persistOnScroll = false, fromTabMode = false, forcedContext = null } = {}) {
    const ctx = forcedContext || getSyncNavContext(state.navScopeOverride);
    if (!ctx?.current) return false;
    settingsModal.close();
    closePopover();
    wheel.close();
    aeTree.close();
    state.activeTabNavMode = Boolean(fromTabMode && !holdMode);
    bilateral.open({
      context: ctx,
      x,
      y,
      holdMode,
      holdButton,
      persistOnScroll,
      closeOnSelect: fromTabMode ? Boolean(state.settings?.tabCloseOnSelect) : false,
      parentDirection: state.settings?.parentDirection || 'left',
      scope: state.navScopeOverride || ctx.childSourceScope || state.settings?.childSourceScope || 'opened_and_outlinks',
      onSelect: (picked) => {
        const keepNav = Boolean(fromTabMode && !state.settings?.tabCloseOnSelect);
        void openFile(picked.path, {
          inNewTab: true,
          isDirectory: Boolean(picked.isDirectory),
          lineStart: picked.lineStart || null,
          skipLineage: Boolean(picked.isParent || picked.isAnchor),
          keepNavigator: keepNav,
        });
      },
      onSwitchScope: async (nextScope) => {
        state.navScopeOverride = nextScope;
        const fresh = await refreshNavContext(nextScope);
        if (fresh) bilateral.updateContext(fresh);
      },
      onClose: () => {
        if (!aeTree.isOpen() && !wheel.isOpen()) state.activeTabNavMode = false;
      },
    });
    return true;
  }

  function openAeTree({ fromTabMode = true, forcedContext = null } = {}) {
    const ctx = forcedContext || getSyncNavContext(state.navScopeOverride);
    if (!ctx?.current) return false;
    settingsModal.close();
    closePopover();
    wheel.close();
    bilateral.close();
    state.activeTabNavMode = Boolean(fromTabMode);
    aeTree.open({
      context: ctx,
      anchorRect: els.reader?.getBoundingClientRect?.() || null,
      scope: state.navScopeOverride || ctx.childSourceScope || state.settings?.childSourceScope || 'opened_and_outlinks',
      closeOnSelect: Boolean(state.settings?.tabCloseOnSelect),
      onSelect: (picked) => {
        const keepNav = Boolean(fromTabMode && !state.settings?.tabCloseOnSelect);
        void openFile(picked.path, {
          inNewTab: true,
          isDirectory: Boolean(picked.isDirectory),
          lineStart: picked.lineStart || null,
          skipLineage: Boolean(picked.isParent || picked.isAnchor),
          keepNavigator: keepNav,
        });
      },
      onSwitchScope: async (nextScope) => {
        state.navScopeOverride = nextScope;
        const fresh = await refreshNavContext(nextScope);
        if (fresh) aeTree.updateContext(fresh);
      },
      onClose: () => {
        if (!bilateral.isOpen() && !wheel.isOpen()) state.activeTabNavMode = false;
      },
    });
    return true;
  }

  function isAnyTabNavigatorOpen() {
    return Boolean(state.activeTabNavMode && (aeTree.isOpen() || bilateral.isOpen() || wheel.isOpen()));
  }

  function triggerTabNavigator() {
    if (isAnyTabNavigatorOpen()) {
      closeOverlays();
      return true;
    }
    const mode = state.settings?.tabMode || 'ae_tree';
    if (mode === 'off') return false;
    if (mode === 'classic_wheel') {
      const t = getWheelTargetGroup();
      if (!t) return false;
      openWheelForTarget(t, window.innerWidth / 2, window.innerHeight / 2, false, 1, { persistOnScroll: true, fromTabMode: true });
      return true;
    }
    const ok =
      mode === 'bilateral_wheel'
        ? openBilateralWheel(window.innerWidth / 2, window.innerHeight / 2, { holdMode: false, persistOnScroll: true, fromTabMode: true })
        : openAeTree({ fromTabMode: true });
    void refreshNavContext(state.navScopeOverride).then((fresh) => {
      if (!fresh) return;
      if (aeTree.isOpen()) aeTree.updateContext(fresh);
      else if (bilateral.isOpen()) bilateral.updateContext(fresh);
    });
    return ok;
  }

  async function adoptAndOpen(targetPath, groupId, { openInForeground = true, lineStart = null, isDirectory = false } = {}) {
    if (!targetPath) return;
    const openerIsDir = Boolean(state.currentDoc?.isDirectory);
    const res = await apiPost('/api/session', {
      conversationId,
      op: 'adoptChild',
      groupId,
      anchorPath: state.activeTabPath,
      anchorIsDirectory: openerIsDir,
      directParentPath: state.activeTabPath,
      directParentTitle: (!openerIsDir && state.currentLinks?.title) || baseName(state.activeTabPath),
      directParentIsDirectory: openerIsDir,
      childPath: targetPath,
      childTitle: baseName(targetPath),
      childIsDirectory: Boolean(isDirectory),
    });
    if (res.ok && res.session) {
      state.session = res.session;
    }
    if (openInForeground) {
      await openFile(targetPath, { inNewTab: true, lineStart, isDirectory: Boolean(isDirectory), skipAdopt: true });
    } else {
      renderTabsBar();
      showToast(`已静默收入轮盘组：${baseName(targetPath)}`);
    }
  }

  function showToast(msg) {
    const existing = document.getElementById('aw-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = 'aw-toast';
    t.style.cssText =
      'position:fixed;bottom:14px;right:14px;z-index:99999;padding:7px 12px;border-radius:8px;background:var(--aw-popover);border:1px solid var(--aw-card-border);box-shadow:var(--aw-shadow);font-size:12.5px;color:var(--aw-fg);';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function closePopover() {
    els.popoverRoot.innerHTML = '';
    state.activePopover = null;
  }

  function closeOverlays({ keepTabNavigator = false } = {}) {
    closePopover();
    if (!keepTabNavigator || !state.activeTabNavMode) {
      state.activeTabNavMode = false;
      wheel.close();
      bilateral.close();
      aeTree.close();
    }
    settingsModal.close();
  }

  function updateSubbar() {
    if (!state.activeTabPath || !state.currentDoc) {
      els.crumbText.textContent = '未打开文件 · 请选择下方工作区文档或报告';
      els.crumbText.title = '';
      if (els.btnTree) els.btnTree.hidden = true;
      els.btnPinAnchor.hidden = true;
      els.btnLinks.hidden = true;
      if (els.btnReveal) els.btnReveal.hidden = true;
      els.btnEncoding.hidden = true;
      return;
    }

    els.crumbText.textContent = state.activeTabPath;
    els.crumbText.title = state.activeTabPath;
    if (els.btnTree) els.btnTree.hidden = false;

    const rel = findGroupByChildOrAnchor(state.activeTabPath);
    const isDir = Boolean(state.currentDoc?.isDirectory);
    const isMd = /\.(md|mdx|txt)$/i.test(state.activeTabPath);
    els.btnPinAnchor.hidden = !isMd && !isDir && !rel;
    if (rel && rel.role === 'anchor') {
      els.pinAnchorLabel.textContent = '取消优先母页';
      els.btnPinAnchor.setAttribute('data-has-links', '1');
    } else {
      els.pinAnchorLabel.textContent = '设为优先母页';
      els.btnPinAnchor.removeAttribute('data-has-links');
    }

    const backCount = state.currentLinks?.backlinks?.length || 0;
    const outCount = isDir ? (state.currentDoc?.files?.length || 0) : (state.currentLinks?.outlinks?.length || 0);
    els.btnLinks.hidden = false;
    if (isDir) {
      els.linksLabel.textContent = backCount > 0 ? `被 ${backCount} 引用 · ${outCount} 文件` : `目录 ${outCount} 文件`;
    } else {
      els.linksLabel.textContent = backCount > 0 ? `被 ${backCount} 份引用` : `引用链 ${outCount}`;
    }
    if (backCount > 0) els.btnLinks.setAttribute('data-has-links', '1');
    else els.btnLinks.removeAttribute('data-has-links');

    if (els.btnReveal) {
      els.btnReveal.hidden = false;
      if (els.revealLabel) els.revealLabel.textContent = isDir ? '打开目录' : '打开位置';
      els.btnReveal.title = isDir
        ? `在系统文件资源管理器中打开文件夹\n${state.activeTabPath}`
        : `在系统文件资源管理器中定位当前文件\n${state.activeTabPath}`;
    }

    const enc = state.currentDoc.encoding || 'utf-8';
    els.btnEncoding.hidden = Boolean(state.currentDoc.isBinary || isDir || state.currentDoc.isRichDoc);
    els.encodingLabel.textContent = enc.toUpperCase();
    if (state.currentDoc.isNonUtf8 || state.currentDoc.mojibakeHint) {
      els.btnEncoding.setAttribute('data-warn', '1');
    } else {
      els.btnEncoding.removeAttribute('data-warn');
    }
  }

  function renderEncodingBanner(doc) {
    if (!doc || doc.isBinary || (!doc.isNonUtf8 && !doc.mojibakeHint)) {
      els.encodingBanner.hidden = true;
      els.encodingBanner.innerHTML = '';
      return;
    }
    els.encodingBanner.hidden = false;
    els.encodingBanner.innerHTML = `
      <span>已自动识别非 UTF-8 编码（<strong>${doc.encoding.toUpperCase()}</strong>，置信度 ${Math.round((doc.confidence || 0.8) * 100)}%）并无损解码显示。</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" id="aw-banner-switch-enc" class="aw-ghost-btn">切换编码</button>
        <button type="button" id="aw-banner-convert-utf8" class="aw-primary-btn">转为 UTF-8 保存（保留原备份）</button>
      </div>
    `;
    document.getElementById('aw-banner-switch-enc')?.addEventListener('click', (e) => {
      openEncodingPopover(e.currentTarget);
    });
    document.getElementById('aw-banner-convert-utf8')?.addEventListener('click', async () => {
      const res = await apiPost('/api/file/convert-utf8', {
        path: state.activeTabPath,
        encoding: doc.encoding,
        confirm: true,
      });
      if (res.ok) {
        showToast(res.alreadyUtf8 ? '当前已是 UTF-8' : '已转为 UTF-8 并保留 .bak.encoding 备份');
        await openFile(state.activeTabPath, { skipHistory: true });
      } else {
        showToast(`转换失败：${res.error || '未知错误'}`);
      }
    });
  }

  function scrollToLine(lineNo) {
    if (!lineNo) return;
    const target =
      els.reader.querySelector(`[data-aw-line="${lineNo}"]`) ||
      Array.from(els.reader.querySelectorAll('[data-aw-line]')).find(
        (el) => Number(el.getAttribute('data-aw-line')) >= lineNo
      );
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('aw-line-highlight');
      setTimeout(() => target.classList.remove('aw-line-highlight'), 1800);
    }
  }

  async function openFile(rawPath, opts = {}) {
    closeOverlays({ keepTabNavigator: Boolean(opts.keepNavigator) });
    if (!rawPath) return;

    const prevPath = state.activeTabPath;
    const prevIsDir = Boolean(state.currentDoc?.isDirectory);
    const prevTitle = (!prevIsDir && state.currentLinks?.title) || baseName(prevPath);

    // Save current scrollTop before leaving
    if (prevPath && !opts.skipHistory) {
      const curScrollTop = state.docViewerInstance?.getScrollEl?.()?.scrollTop ?? els.reader.scrollTop;
      await apiPost('/api/session', {
        conversationId,
        op: 'history',
        action: 'updateScroll',
        scrollTop: curScrollTop,
      });
    }

    const wantDir = Boolean(opts.isDirectory || /[\\/]$/.test(String(rawPath || '')));
    const ext = wantDir ? '' : (rawPath.split('.').pop()?.toLowerCase() || '');
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif'].includes(ext);
    const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma', 'aiff', 'aif'].includes(ext);
    const richDocMeta = !wantDir ? window.AnchorWheelDocViewer?.classifyDocPathClient?.(rawPath) : null;
    const isVideo = Boolean(richDocMeta?.isVideo);
    const wantRichDoc = Boolean(
      richDocMeta &&
      !isVideo &&
      !opts.forceRawText &&
      (richDocMeta.autoRender || richDocMeta.mode2Only || (richDocMeta.optionalTable && !opts.overrideEncoding))
    );

    let doc;
    if (wantDir) {
      doc = await apiPost('/api/dir/list', { path: rawPath });
    } else if (isVideo) {
      const prepared = await apiPost('/api/media/prepare', { path: rawPath });
      if (prepared?.ok) {
        doc = { ...prepared, isRichDoc: true, isBinary: true };
      } else {
        doc = prepared;
      }
    } else if (isImage || isAudio) {
      doc = { ok: true, path: rawPath, isMedia: true, mediaKind: isImage ? 'image' : 'audio', isBinary: true };
    } else if (wantRichDoc) {
      const rendered = await apiPost('/api/doc/render', { path: rawPath });
      if (rendered?.ok) {
        doc = { ...rendered, isRichDoc: true, isBinary: Boolean(richDocMeta.isBinaryDoc) };
      } else if (richDocMeta.optionalTable) {
        doc = await apiPost('/api/file/read', { path: rawPath, encoding: opts.overrideEncoding || '' });
      } else {
        doc = rendered;
      }
    } else {
      doc = await apiPost('/api/file/read', {
        path: rawPath,
        encoding: opts.overrideEncoding || '',
      });
      if (!doc?.ok && /not a regular file/i.test(String(doc?.error || ''))) {
        const dirTry = await apiPost('/api/dir/list', { path: rawPath });
        if (dirTry?.ok) doc = dirTry;
      }
    }

    if (!doc || !doc.ok) {
      try { state.docViewerInstance?.destroy?.(); } catch {}
      state.docViewerInstance = null;
      els.reader.removeAttribute('data-aw-doc-mode');
      els.reader.innerHTML = `<div class="aw-hero-card"><h3>无法打开文件</h3><p class="aw-hero-sub">${window.AnchorWheelMarkdown.esc(doc?.error || rawPath)}</p></div>`;
      return;
    }

    const resolvedPath = doc.path || rawPath;
    const resolvedIsDir = Boolean(doc.isDirectory);
    state.activeTabPath = resolvedPath;
    state.currentDoc = doc;

    if (prevPath && !opts.skipLineage && !opts.skipHistory && normKey(prevPath) !== normKey(resolvedPath)) {
      const lRes = await apiPost('/api/session', {
        conversationId,
        op: 'recordLineage',
        parentPath: prevPath,
        parentTitle: prevTitle,
        parentIsDirectory: prevIsDir,
        childPath: resolvedPath,
        childTitle: baseName(resolvedPath),
        childIsDirectory: resolvedIsDir,
      });
      if (lRes.ok && lRes.session) state.session = lRes.session;
    }

    // Register in standalone tabs if not already present
    const k = normKey(resolvedPath);
    if (!state.tabs.some((t) => normKey(t.path) === k)) {
      state.tabs.push({ path: resolvedPath, title: baseName(resolvedPath), isDirectory: resolvedIsDir });
    }

    // Touch child if inside a group
    if (opts.fromGroupId || findGroupByChildOrAnchor(resolvedPath)) {
      const sRes = await apiPost('/api/session', {
        conversationId,
        op: 'touchChild',
        groupId: opts.fromGroupId,
        path: resolvedPath,
      });
      if (sRes.ok && sRes.session) state.session = sRes.session;
    }

    // Record history
    if (!opts.skipHistory) {
      const hRes = await apiPost('/api/session', {
        conversationId,
        op: 'history',
        action: 'push',
        entry: {
          path: resolvedPath,
          title: baseName(resolvedPath),
          scrollTop: opts.restoreScrollTop || 0,
          line: opts.lineStart || null,
          isDirectory: resolvedIsDir,
        },
      });
      if (hRes.ok && hRes.session) state.session = hRes.session;
    }

    // Fetch backlinks & outlinks
    const wsQuery = state.workspaceRoots.join('|');
    const linksRes = await apiGet(
      `/api/backlinks?path=${encodeURIComponent(resolvedPath)}${wsQuery ? `&workspace=${encodeURIComponent(wsQuery)}` : ''}`
    );
    state.currentLinks = linksRes.ok ? linksRes : { backlinks: [], outlinks: [] };

    // Auto-anchor summary MD if enabled and >= 3 outlinks and not yet in any group
    if (
      !resolvedIsDir &&
      state.settings?.autoAnchorSummaryMd &&
      /\.(md|mdx)$/i.test(resolvedPath) &&
      (state.currentLinks.outlinks?.length || 0) >= 3 &&
      !findGroupByChildOrAnchor(resolvedPath)
    ) {
      const pRes = await apiPost('/api/session', {
        conversationId,
        op: 'pinAnchor',
        path: resolvedPath,
        title: state.currentLinks.title || baseName(resolvedPath),
      });
      if (pRes.ok && pRes.session) state.session = pRes.session;
    }

    renderEncodingBanner(doc);
    renderDocumentBody(doc, opts);
    updateSubbar();
    renderTabsBar();
    const freshCtx = await refreshNavContext(state.navScopeOverride);
    if (opts.keepNavigator && freshCtx && state.activeTabNavMode) {
      if (aeTree.isOpen()) aeTree.updateContext(freshCtx);
      else if (bilateral.isOpen()) bilateral.updateContext(freshCtx);
    }
  }

  function renderDocumentBody(doc, opts = {}) {
    try { state.docViewerInstance?.destroy?.(); } catch {}
    state.docViewerInstance = null;
    els.reader.removeAttribute('data-aw-doc-mode');

    if (doc.isRichDoc && window.AnchorWheelDocViewer) {
      els.reader.setAttribute('data-aw-doc-mode', '1');
      const isRawSwitchable =
        doc.format === 'csv' ||
        doc.format === 'tsv' ||
        doc.format === 'jsonl' ||
        doc.format === 'ipynb' ||
        doc.format === 'eml' ||
        Boolean(doc.optionalTable) ||
        Boolean(doc.preferWhenRawCode);
      state.docViewerInstance = window.AnchorWheelDocViewer.mountDocumentViewer(els.reader, doc, {
        paperMode: Boolean(state.settings?.richDocPaperMode),
        pdfRawUrl: doc.format === 'pdf' ? `/api/file/raw?path=${encodeURIComponent(doc.path)}` : '',
        rawLabel: isRawSwitchable ? '源码视图' : '',
        onTogglePaperMode: (nextPaper) => {
          state.settings = { ...(state.settings || {}), richDocPaperMode: Boolean(nextPaper) };
          void apiPost('/api/settings', { settings: { richDocPaperMode: Boolean(nextPaper) } });
        },
        onRequestHiRes: (p) => apiPost('/api/doc/render-hires', { path: p || doc.path }),
        onPollVideoReady: doc.format === 'video' ? (p) => apiPost('/api/media/prepare', { path: p || doc.path }) : null,
        onReadMediaBlob: doc.format === 'video' ? (p, mode) => apiPost('/api/media/blob', { path: p || doc.path, mode: mode || '' }) : null,
        onNotify: (msg) => showToast(msg),
        onOpenExternal: async (p) => {
          const r = await apiPost('/api/file/open-external', { path: p || doc.path });
          if (r?.ok) showToast('已调用系统默认应用打开');
          else showToast(`外部打开失败：${r?.error || '未知错误'}`);
        },
        onSwitchToRaw: isRawSwitchable
          ? () => void openFile(doc.path, { skipHistory: true, forceRawText: true })
          : null,
      });
      if (opts.restoreScrollTop) {
        requestAnimationFrame(() => {
          const sc = state.docViewerInstance?.getScrollEl?.();
          if (sc) sc.scrollTop = opts.restoreScrollTop;
        });
      }
      return;
    }

    if (doc.isDirectory) {
      const files = Array.isArray(doc.files) ? doc.files : [];
      const esc = window.AnchorWheelMarkdown.esc;
      let activeCat = 'all';
      const catCounts = new Map();
      const catLabels = new Map();
      for (const f of files) {
        const cid = f.categoryId || 'other';
        catCounts.set(cid, (catCounts.get(cid) || 0) + 1);
        catLabels.set(cid, f.categoryLabel || '其他');
      }
      const metaBadges = [`直属 ${doc.totalFiles ?? files.length} 个文件`];
      if (doc.truncated) metaBadges.push(`仅展示前 ${doc.maxFiles} 项`);
      if (doc.skippedSubdirCount > 0) metaBadges.push(`已略过 ${doc.skippedSubdirCount} 个子文件夹`);

      const filterDefs = [{ id: 'all', label: `全部 (${files.length})` }];
      const orderedRuleIds = [
        ...(Array.isArray(state.settings?.categoryRules) ? state.settings.categoryRules.map((r) => r.id) : []),
        'other',
      ];
      const addedCats = new Set();
      for (const cid of orderedRuleIds) {
        if (catCounts.has(cid) && !addedCats.has(cid)) {
          addedCats.add(cid);
          filterDefs.push({ id: cid, label: `${catLabels.get(cid)} (${catCounts.get(cid)})` });
        }
      }
      for (const [cid, count] of catCounts.entries()) {
        if (!addedCats.has(cid)) {
          filterDefs.push({ id: cid, label: `${catLabels.get(cid)} (${count})` });
        }
      }

      const renderDirList = () => {
        const listEl = els.reader.querySelector('#aw-dir-file-rows');
        if (!listEl) return;
        const shown = activeCat === 'all' ? files : files.filter((f) => (f.categoryId || 'other') === activeCat);
        const openKeySet = new Set(state.tabs.map((t) => normKey(t.path)));
        listEl.innerHTML = shown.length
          ? shown
              .map((f) => {
                const opened = openKeySet.has(normKey(f.path));
                const sz = S.formatBytes(f.sizeBytes);
                return `
                  <button type="button" class="aw-dir-row" data-aw-dir-file="${esc(f.path)}">
                    <span class="aw-dir-row-main">
                      ${S.pickIconForItem(f)}
                      <span class="aw-dir-row-name">${esc(f.name || baseName(f.path))}</span>
                      ${opened ? '<span class="aw-bi-dot" title="已打开标签"></span>' : ''}
                    </span>
                    <span class="aw-dir-row-right">
                      <span class="aw-link-row-badge">${esc(f.categoryLabel || '其他')}</span>
                      ${sz ? `<span>${esc(sz)}</span>` : ''}
                    </span>
                  </button>`;
              })
              .join('')
          : `<div class="aw-hero-card"><p class="aw-hero-sub">${
              files.length ? '当前分类下暂无文件。' : `当前文件夹暂无直属文件${doc.skippedSubdirCount ? `（已略过 ${doc.skippedSubdirCount} 个子文件夹）` : ''}。`
            }</p></div>`;

        for (const rowBtn of listEl.querySelectorAll('[data-aw-dir-file]')) {
          rowBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const targetPath = rowBtn.getAttribute('data-aw-dir-file');
            if (!targetPath) return;
            const rel = findGroupByChildOrAnchor(state.activeTabPath);
            if (rel) {
              void adoptAndOpen(targetPath, rel.group.id, { openInForeground: true, isDirectory: false });
            } else {
              void openFile(targetPath, { inNewTab: true, isDirectory: false });
            }
          });
          rowBtn.addEventListener('auxclick', (ev) => {
            if (ev.button !== 1) return;
            ev.preventDefault();
            ev.stopPropagation();
            const targetPath = rowBtn.getAttribute('data-aw-dir-file');
            if (!targetPath) return;
            const rel = findGroupByChildOrAnchor(state.activeTabPath);
            const grpId = rel ? rel.group.id : getActiveGroup()?.id;
            if (grpId) {
              void adoptAndOpen(targetPath, grpId, { openInForeground: false, isDirectory: false });
            } else {
              const targetKey = normKey(targetPath);
              if (!state.tabs.some((t) => normKey(t.path) === targetKey)) {
                state.tabs.push({ path: targetPath, title: baseName(targetPath), isDirectory: false });
              }
              renderTabsBar();
              showToast(`已后台新建标签：${baseName(targetPath)}`);
            }
          });
        }
      };

      els.reader.innerHTML = `
        <div class="aw-dir-view">
          <div class="aw-dir-header">
            <div class="aw-dir-title-wrap">${S.ICONS.folder}<h2 title="${esc(doc.path)}">${esc(doc.title || baseName(doc.path))}</h2></div>
            <div class="aw-dir-header-actions">
              <div class="aw-dir-meta">${metaBadges.map((b) => `<span class="aw-link-row-badge">${esc(b)}</span>`).join('')}</div>
              <button type="button" class="aw-status-pill" id="aw-dir-open-explorer" title="在系统文件资源管理器中打开此文件夹">${S.ICONS.folderOpen}<span>在资源管理器中打开</span></button>
            </div>
          </div>
          ${
            filterDefs.length > 2
              ? `<div class="aw-dir-filter-bar">${filterDefs
                  .map(
                    (f) =>
                      `<button type="button" class="aw-dir-filter-pill" data-aw-dir-cat="${esc(f.id)}" data-active="${f.id === activeCat ? '1' : '0'}">${esc(f.label)}</button>`
                  )
                  .join('')}</div>`
              : ''
          }
          <div class="aw-file-list" id="aw-dir-file-rows"></div>
        </div>
      `;

      for (const pill of els.reader.querySelectorAll('[data-aw-dir-cat]')) {
        pill.addEventListener('click', () => {
          activeCat = pill.getAttribute('data-aw-dir-cat') || 'all';
          for (const p2 of els.reader.querySelectorAll('[data-aw-dir-cat]')) {
            p2.setAttribute('data-active', p2.getAttribute('data-aw-dir-cat') === activeCat ? '1' : '0');
          }
          renderDirList();
        });
      }
      els.reader.querySelector('#aw-dir-open-explorer')?.addEventListener('click', () => {
        void revealInSystemExplorerUi(doc.path);
      });
      renderDirList();
      els.reader.scrollTop = opts.restoreScrollTop || 0;
      return;
    }

    if (doc.isMedia) {
      const rawUrl = `/api/file/raw?path=${encodeURIComponent(doc.path)}`;
      if (doc.mediaKind === 'image') {
        els.reader.innerHTML = `<div class="aw-media-frame"><img src="${rawUrl}" alt="${window.AnchorWheelMarkdown.esc(baseName(doc.path))}" /></div>`;
      } else if (doc.mediaKind === 'video') {
        els.reader.innerHTML = `<div class="aw-media-frame"><video src="${rawUrl}" controls preload="metadata"></video></div>`;
      } else {
        els.reader.innerHTML = `<div class="aw-media-frame"><audio src="${rawUrl}" controls style="width:100%"></audio></div>`;
      }
      return;
    }

    const isMd = /\.(md|mdx)$/i.test(doc.path);
    if (isMd) {
      const deadSet = new Set(
        (state.currentLinks?.outlinks || []).filter((o) => !o.exists).map((o) => o.rawTarget)
      );
      els.reader.innerHTML = `<article class="aw-md-doc">${window.AnchorWheelMarkdown.renderMarkdown(doc.text, { deadSet })}</article>`;

      // Bind non-overwriting link click, middle-click background queue, and dragstart
      for (const linkEl of els.reader.querySelectorAll('[data-aw-link]')) {
        const rawRef = linkEl.getAttribute('data-aw-link');
        linkEl.addEventListener('dragstart', (ev) => {
          state.dragPayload = rawRef;
          ev.dataTransfer?.setData('text/aw-link', rawRef);
          ev.dataTransfer?.setData('text/plain', rawRef);
        });
        linkEl.addEventListener('click', (ev) => {
          ev.preventDefault();
          const resolved = resolveRelativeTarget(rawRef, state.activeTabPath);
          if (!resolved.target) return;
          if (ev.altKey) {
            // Alt+Click intentionally replaces in current view without adopting
            void openFile(resolved.target, { lineStart: resolved.lineStart });
            return;
          }
          const rel = findGroupByChildOrAnchor(state.activeTabPath);
          if (rel) {
            void adoptAndOpen(resolved.target, rel.group.id, {
              openInForeground: true,
              lineStart: resolved.lineStart,
            });
          } else {
            void openFile(resolved.target, { inNewTab: true, lineStart: resolved.lineStart });
          }
        });
        linkEl.addEventListener('auxclick', (ev) => {
          if (ev.button !== 1) return;
          ev.preventDefault();
          ev.stopPropagation();
          const resolved = resolveRelativeTarget(rawRef, state.activeTabPath);
          if (!resolved.target) return;
          const rel = findGroupByChildOrAnchor(state.activeTabPath);
          const grpId = rel ? rel.group.id : getActiveGroup()?.id;
          if (grpId) {
            void adoptAndOpen(resolved.target, grpId, { openInForeground: false });
          } else {
            const targetKey = normKey(resolved.target);
            if (!state.tabs.some((t) => normKey(t.path) === targetKey)) {
              state.tabs.push({ path: resolved.target, title: baseName(resolved.target) });
            }
            renderTabsBar();
            showToast(`已后台新建标签：${baseName(resolved.target)}`);
          }
        });
      }

      for (const copyBtn of els.reader.querySelectorAll('[data-aw-copy-code]')) {
        copyBtn.addEventListener('click', () => {
          const pre = copyBtn.closest('.aw-md-codewrap')?.querySelector('pre');
          if (pre && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(pre.textContent || '');
            copyBtn.textContent = '已复制';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
          }
        });
      }
    } else {
      els.reader.innerHTML = window.AnchorWheelMarkdown.renderCodeLines(doc.text, opts.lineStart, opts.lineEnd);
    }

    if (opts.lineStart) {
      requestAnimationFrame(() => scrollToLine(opts.lineStart));
    } else if (opts.restoreScrollTop) {
      requestAnimationFrame(() => { els.reader.scrollTop = opts.restoreScrollTop; });
    } else {
      els.reader.scrollTop = 0;
    }
  }

  async function renderHomeDesk() {
    try { state.docViewerInstance?.destroy?.(); } catch {}
    state.docViewerInstance = null;
    els.reader.removeAttribute('data-aw-doc-mode');
    updateSubbar();
    renderEncodingBanner(null);
    const wsQuery = state.workspaceRoots.join('|');
    const filesRes = await apiGet(`/api/files/tree?limit=30${wsQuery ? `&root=${encodeURIComponent(wsQuery)}` : ''}`);
    const files = filesRes.ok ? filesRes.files : [];
    const cdpOk = state.status?.cdp?.connected;

    const listHtml = files.length
      ? files
          .slice(0, 18)
          .map(
            (f) => `
          <button type="button" class="aw-link-row" data-open-path="${window.AnchorWheelMarkdown.esc(f.path)}">
            <div class="aw-link-row-top">
              <span class="aw-link-row-title" style="display:inline-flex;align-items:center;gap:6px">${S.pickIconForItem(f.path)}<span style="overflow:hidden;text-overflow:ellipsis">${window.AnchorWheelMarkdown.esc(f.title || f.name)}</span></span>
              <span class="aw-link-row-badge">${f.isArtifact ? '会话报告' : '工作区'}${f.outlinkCount ? ` · ${f.outlinkCount} 链` : ''}</span>
            </div>
            <div class="aw-link-row-snippet">${window.AnchorWheelMarkdown.esc(f.path)}</div>
          </button>`
          )
          .join('')
      : '<div class="aw-link-row-snippet">暂未扫描到 Markdown 或工程文件，请在上方直接输入路径打开，或在设置中添加额外目录。</div>';

    els.reader.innerHTML = `
      <div class="aw-home-desk">
        <section class="aw-hero-card">
          <div class="aw-hero-head">
            <img src="/logo.svg" alt="AnchorWheel Logo" />
            <div>
              <h1 class="aw-hero-title">锚点轮盘 · AnchorWheel</h1>
              <p class="aw-hero-sub">点击 MD 链接默认不覆盖原页，按住${S.resolveWheelTriggerButton(state.settings).shortLabel}或按 ${window.AnchorWheelMarkdown.esc(state.settings?.tabCustomHotkey || 'Tab')} 随时呼出导览（${cdpOk ? '原生侧栏增强已在线' : '独立工作台运行中'}）</p>
            </div>
          </div>
          <div class="aw-open-bar">
            <input type="text" id="aw-quick-path" class="aw-input" placeholder="输入或粘贴本地文件或文件夹绝对路径（如 C:\\...\\report.md）后按回车打开" />
            <button type="button" id="aw-quick-open-btn" class="aw-primary-btn">打开</button>
          </div>
        </section>
        <div class="aw-section-title">
          <span>近期文档与 AI 会话报告</span>
          <button type="button" id="aw-rescan-btn" class="aw-ghost-btn" style="height:24px;padding:0 8px">重新扫描</button>
        </div>
        <div class="aw-file-list">${listHtml}</div>
      </div>
    `;

    document.getElementById('aw-quick-open-btn')?.addEventListener('click', () => {
      const val = document.getElementById('aw-quick-path')?.value?.trim();
      if (val) void openFile(val, { inNewTab: true });
    });
    document.getElementById('aw-quick-path')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = e.currentTarget.value.trim();
        if (val) void openFile(val, { inNewTab: true });
      }
    });
    document.getElementById('aw-rescan-btn')?.addEventListener('click', async () => {
      await apiPost('/api/index/rescan', { force: true, workspaceRoots: state.workspaceRoots });
      await renderHomeDesk();
    });
    for (const btn of els.reader.querySelectorAll('[data-open-path]')) {
      btn.addEventListener('click', () => {
        void openFile(btn.getAttribute('data-open-path'), { inNewTab: true });
      });
    }
  }

  function positionPopover(pop, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(370, vw - 20);
    const left = Math.max(10, Math.min(vw - width - 10, rect.right - width));
    const top = Math.min(vh - 120, rect.bottom + 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function openLinksPopover(anchorEl, initialTab = '') {
    wheel.close();
    if (state.activePopover === 'links' && !initialTab) {
      closePopover();
      return;
    }
    closePopover();
    state.activePopover = 'links';

    const pop = document.createElement('div');
    pop.className = 'aw-popover';
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    pop.addEventListener('mousedown', (ev) => ev.stopPropagation());

    const isDirMode = Boolean(state.currentDoc?.isDirectory);
    const backInit = state.currentLinks?.backlinks || [];
    const dirInit = isDirMode && Array.isArray(state.currentDoc?.files) ? state.currentDoc.files : [];
    const outInit = isDirMode ? dirInit : (state.currentLinks?.outlinks || []);
    const secondLabel = isDirMode ? '目录文件' : '本文出链';
    let currentTab = initialTab || (isDirMode ? (dirInit.length > 0 ? 'outlinks' : 'backlinks') : backInit.length > 0 ? 'backlinks' : outInit.length > 0 ? 'outlinks' : 'backlinks');
    let filterText = '';

    pop.innerHTML = `
      <div class="aw-popover-head">
        <div class="aw-tabs-seg" style="flex:1">
          <button type="button" data-ltab="backlinks" data-active="${currentTab === 'backlinks' ? '1' : '0'}">反向引用 (${backInit.length})</button>
          <button type="button" data-ltab="outlinks" data-active="${currentTab === 'outlinks' ? '1' : '0'}">${secondLabel} (${outInit.length})</button>
        </div>
        <button type="button" class="aw-tray-btn" id="aw-pop-close">${ICONS.close}</button>
      </div>
      <div class="aw-popover-filter" hidden>
        <input type="text" class="aw-input" id="aw-pop-link-filter" placeholder="筛选文件名或路径..." />
      </div>
      <div class="aw-popover-body"></div>
    `;

    const filterWrap = pop.querySelector('.aw-popover-filter');
    const filterInput = pop.querySelector('#aw-pop-link-filter');
    const bodyEl = pop.querySelector('.aw-popover-body');

    const renderBody = () => {
      const back = state.currentLinks?.backlinks || [];
      const dirFiles = isDirMode && Array.isArray(state.currentDoc?.files) ? state.currentDoc.files : [];
      const out = isDirMode ? dirFiles : (state.currentLinks?.outlinks || []);
      for (const tabBtn of pop.querySelectorAll('[data-ltab]')) {
        const key = tabBtn.getAttribute('data-ltab');
        tabBtn.setAttribute('data-active', currentTab === key ? '1' : '0');
        tabBtn.textContent = key === 'backlinks' ? `反向引用 (${back.length})` : `${secondLabel} (${out.length})`;
      }
      const list = currentTab === 'backlinks' ? back : out;
      if (filterWrap) {
        filterWrap.hidden = list.length <= 8;
      }
      const q = filterText.trim().toLowerCase();

      if (currentTab === 'backlinks') {
        const filtered = q
          ? back.filter(
              (b) =>
                String(b.sourceTitle || '').toLowerCase().includes(q) ||
                String(b.sourcePath || '').toLowerCase().includes(q) ||
                String(b.snippet || '').toLowerCase().includes(q)
            )
          : back;
        bodyEl.innerHTML = filtered.length
          ? filtered
              .map(
                (b) => `
              <button type="button" class="aw-link-row" data-jump-path="${window.AnchorWheelMarkdown.esc(b.sourcePath)}" data-jump-line="${b.line}" data-jump-dir="0">
                <div class="aw-link-row-top">
                  <span class="aw-link-row-title">${window.AnchorWheelMarkdown.esc(b.sourceTitle)}</span>
                  <span class="aw-link-row-badge">${b.isArtifact ? '报告' : '工作区'} · L${b.line}</span>
                </div>
                <div class="aw-link-row-snippet">${window.AnchorWheelMarkdown.esc(b.snippet)}</div>
              </button>`
              )
              .join('')
          : `<div class="aw-link-row-snippet">${back.length ? '无匹配的反向引用记录。' : '暂未发现其他 Markdown 文档引用当前位置。'}</div>`;
      } else if (isDirMode) {
        const filtered = q
          ? dirFiles.filter(
              (f) =>
                String(f.name || f.title || '').toLowerCase().includes(q) ||
                String(f.categoryLabel || '').toLowerCase().includes(q) ||
                String(f.path || '').toLowerCase().includes(q)
            )
          : dirFiles;
        bodyEl.innerHTML = filtered.length
          ? filtered
              .map(
                (f) => `
              <button type="button" class="aw-link-row" data-jump-path="${window.AnchorWheelMarkdown.esc(f.path)}" data-jump-line="" data-jump-dir="0">
                <div class="aw-link-row-top">
                  <span class="aw-link-row-title">${window.AnchorWheelMarkdown.esc(f.name || baseName(f.path))}</span>
                  <span class="aw-link-row-badge">${window.AnchorWheelMarkdown.esc(f.categoryLabel || '其他')}</span>
                </div>
                <div class="aw-link-row-snippet">${window.AnchorWheelMarkdown.esc(f.path)}</div>
              </button>`
              )
              .join('')
          : `<div class="aw-link-row-snippet">${dirFiles.length ? '无匹配的直属文件。' : '当前文件夹暂无直属文件。'}</div>`;
      } else {
        const filtered = q
          ? out.filter(
              (o) =>
                String(o.label || '').toLowerCase().includes(q) ||
                String(o.resolvedPath || '').toLowerCase().includes(q)
            )
          : out;
        bodyEl.innerHTML = filtered.length
          ? filtered
              .map(
                (o) => `
              <button type="button" class="aw-link-row" data-jump-path="${window.AnchorWheelMarkdown.esc(o.resolvedPath)}" data-jump-line="${o.lineStart || ''}" data-jump-dir="${o.isDirectory ? '1' : '0'}" ${o.exists ? '' : 'disabled'}>
                <div class="aw-link-row-top">
                  <span class="aw-link-row-title">${window.AnchorWheelMarkdown.esc(o.label || baseName(o.resolvedPath))}</span>
                  <span class="aw-link-row-badge" data-dead="${o.exists ? '0' : '1'}">${o.exists ? `L${o.line}` : '路径不存在'}</span>
                </div>
                <div class="aw-link-row-snippet">${window.AnchorWheelMarkdown.esc(o.resolvedPath)}</div>
              </button>`
              )
              .join('')
          : `<div class="aw-link-row-snippet">${out.length ? '无匹配的出链记录。' : '当前文档内暂无本地文件出链。'}</div>`;
      }

      for (const rowBtn of bodyEl.querySelectorAll('[data-jump-path]')) {
        rowBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const p = rowBtn.getAttribute('data-jump-path');
          const ln = Number(rowBtn.getAttribute('data-jump-line')) || null;
          const isDirectory = rowBtn.getAttribute('data-jump-dir') === '1';
          closePopover();
          const rel = findGroupByChildOrAnchor(state.activeTabPath);
          if (rel) {
            void adoptAndOpen(p, rel.group.id, { openInForeground: true, lineStart: ln, isDirectory });
          } else {
            void openFile(p, { inNewTab: true, lineStart: ln, isDirectory });
          }
        });
      }
    };

    pop.querySelector('#aw-pop-close')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closePopover();
    });
    for (const tabBtn of pop.querySelectorAll('[data-ltab]')) {
      tabBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const nextTab = tabBtn.getAttribute('data-ltab');
        if (nextTab && nextTab !== currentTab) {
          currentTab = nextTab;
          renderBody();
        }
      });
    }
    filterInput?.addEventListener('input', (ev) => {
      filterText = ev.currentTarget.value || '';
      renderBody();
    });

    renderBody();
    els.popoverRoot.appendChild(pop);
    positionPopover(pop, anchorEl);
  }

  function openEncodingPopover(anchorEl) {
    wheel.close();
    if (state.activePopover === 'encoding') {
      closePopover();
      return;
    }
    closePopover();
    state.activePopover = 'encoding';

    const encodings = [
      ['', '自动识别（推荐）'],
      ['utf-8', 'UTF-8'],
      ['gb18030', 'GB18030 / GBK（中文 Windows）'],
      ['utf-16le', 'UTF-16 LE'],
      ['utf-16be', 'UTF-16 BE'],
      ['shift_jis', 'Shift-JIS（日文）'],
      ['big5', 'Big5（繁体）'],
      ['windows-1252', 'Windows-1252'],
    ];

    const pop = document.createElement('div');
    pop.className = 'aw-popover';
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    pop.addEventListener('mousedown', (ev) => ev.stopPropagation());
    pop.innerHTML = `
      <div class="aw-popover-head">
        <span class="aw-popover-title">编码检测与乱码修复</span>
        <button type="button" class="aw-tray-btn" id="aw-pop-close">${ICONS.close}</button>
      </div>
      <div class="aw-popover-body">
        ${encodings
          .map(
            ([val, label]) => `
          <button type="button" class="aw-link-row" data-enc="${val}">
            <div class="aw-link-row-top">
              <span class="aw-link-row-title">${label}</span>
              ${state.currentDoc?.encoding === val ? '<span class="aw-link-row-badge">当前</span>' : ''}
            </div>
          </button>`
          )
          .join('')}
      </div>
    `;
    pop.querySelector('#aw-pop-close')?.addEventListener('click', closePopover);
    for (const btn of pop.querySelectorAll('[data-enc]')) {
      btn.addEventListener('click', () => {
        const enc = btn.getAttribute('data-enc');
        closePopover();
        void openFile(state.activeTabPath, { overrideEncoding: enc, skipHistory: true });
      });
    }
    els.popoverRoot.appendChild(pop);
    positionPopover(pop, anchorEl);
  }

  async function openFilesPopover(anchorEl) {
    wheel.close();
    if (state.activePopover === 'files') {
      closePopover();
      return;
    }
    closePopover();
    state.activePopover = 'files';

    const pop = document.createElement('div');
    pop.className = 'aw-popover';
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    pop.addEventListener('mousedown', (ev) => ev.stopPropagation());
    pop.innerHTML = `
      <div class="aw-popover-head">
        <input type="text" id="aw-file-search" class="aw-input" style="flex:1;min-width:0" placeholder="筛选工作区文件或 AI 报告..." />
        <button type="button" class="aw-tray-btn" id="aw-pop-close">${ICONS.close}</button>
      </div>
      <div class="aw-popover-body" id="aw-file-pop-list">正在扫描...</div>
    `;
    els.popoverRoot.appendChild(pop);
    positionPopover(pop, anchorEl);
    pop.querySelector('#aw-pop-close')?.addEventListener('click', closePopover);

    const loadList = async (q = '') => {
      const wsQuery = state.workspaceRoots.join('|');
      const res = await apiGet(`/api/files/tree?limit=60&q=${encodeURIComponent(q)}${wsQuery ? `&root=${encodeURIComponent(wsQuery)}` : ''}`);
      const listEl = pop.querySelector('#aw-file-pop-list');
      if (!listEl) return;
      const items = res.ok ? res.files : [];
      listEl.innerHTML = items.length
        ? items
            .map(
              (f) => `
          <button type="button" class="aw-link-row" data-fpath="${window.AnchorWheelMarkdown.esc(f.path)}">
            <div class="aw-link-row-top">
              <span class="aw-link-row-title">${window.AnchorWheelMarkdown.esc(f.title || f.name)}</span>
              <span class="aw-link-row-badge">${f.isArtifact ? '报告' : '文件'}</span>
            </div>
            <div class="aw-link-row-snippet">${window.AnchorWheelMarkdown.esc(f.path)}</div>
          </button>`
            )
            .join('')
        : '<div class="aw-link-row-snippet">未匹配到文件。</div>';
      for (const b of listEl.querySelectorAll('[data-fpath]')) {
        b.addEventListener('click', () => {
          const p = b.getAttribute('data-fpath');
          closePopover();
          void openFile(p, { inNewTab: true });
        });
      }
    };

    await loadList('');
    pop.querySelector('#aw-file-search')?.addEventListener('input', (e) => {
      void loadList(e.currentTarget.value);
    });
  }

  const UPDATE_PUSH_ID = 'aw-wb-update-push';
  let sessionDismissedUpdateVer = '';

  function getEffectiveUpdateState() {
    const ignored = state.settings?.ignoredUpdateVersion || '';
    if (S?.computeUpdateStateClient) {
      return S.computeUpdateStateClient(state.updateInfo, ignored);
    }
    const avail = Boolean(state.updateInfo?.ok && state.updateInfo?.updateAvailable);
    const isIgnored = Boolean(avail && state.updateInfo?.isIgnored);
    return { updateAvailable: avail, ignoredVersion: ignored, isIgnored, shouldNotify: Boolean(avail && !isIgnored) };
  }

  function closeUpdatePushCard() {
    document.getElementById(UPDATE_PUSH_ID)?.remove();
  }

  async function ignoreUpdateVersionUi(version) {
    const cleanVer = String(version || '').trim().replace(/^v/i, '');
    const res = await apiPost('/api/update/ignore', { version: cleanVer });
    if (res?.ok) {
      if (res.settings) state.settings = res.settings;
      if (res.update) state.updateInfo = res.update;
    } else {
      state.settings = { ...(state.settings || {}), ignoredUpdateVersion: cleanVer };
    }
    if (cleanVer) {
      closeUpdatePushCard();
      showToast(`已忽略 v${cleanVer}，下个新版本发布时将再次提醒`);
    } else {
      showToast('已恢复新版本更新提醒');
    }
    syncUpdateBadge();
    return { ok: true, settings: state.settings, update: state.updateInfo };
  }

  function syncUpdatePushCard() {
    const updState = getEffectiveUpdateState();
    const latestVer = String(state.updateInfo?.latestVersion || '');
    if (!updState.shouldNotify || !latestVer || latestVer === sessionDismissedUpdateVer || settingsModal.isOpen()) {
      closeUpdatePushCard();
      return;
    }
    const existing = document.getElementById(UPDATE_PUSH_ID);
    if (existing && existing.getAttribute('data-aw-ver') === latestVer) return;
    closeUpdatePushCard();

    const curVer = state.updateInfo.currentVersion || state.status?.version || '';
    const rawNotes = String(state.updateInfo.bodySnippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const summaryText = rawNotes || `当前 v${curVer} → 最新 v${latestVer}，可按需升级或跳过此版本。`;

    const card = document.createElement('div');
    card.id = UPDATE_PUSH_ID;
    card.className = 'aw-update-push-card';
    card.setAttribute('data-aw-ver', latestVer);
    card.innerHTML = `
      <div class="aw-update-push-head">
        <div class="aw-update-push-title">
          <span class="aw-update-pill-dot"></span>
          <span>锚点轮盘发现新版本</span>
          <span class="aw-update-push-ver">v${S.esc(latestVer)}</span>
        </div>
        <button type="button" class="aw-tray-btn" data-aw-upd-act="later" title="稍后提醒">${S.ICONS.close}</button>
      </div>
      <div class="aw-update-push-body">${S.esc(summaryText)}</div>
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
      void openSettingsModalView('storage', { focusUpdateSection: true });
    });
    document.body.appendChild(card);
  }

  function syncUpdateBadge({ skipPushCard = false } = {}) {
    const updState = getEffectiveUpdateState();
    const show = Boolean(updState.shouldNotify && state.updateInfo?.latestVersion);
    if (els.btnSettings) {
      if (show) {
        els.btnSettings.setAttribute('data-has-update', '1');
        els.btnSettings.title = `锚点轮盘设置（发现新版 v${state.updateInfo.latestVersion}）`;
      } else {
        els.btnSettings.removeAttribute('data-has-update');
        els.btnSettings.title = '锚点轮盘设置';
      }
    }
    if (els.btnUpdatePill) {
      els.btnUpdatePill.hidden = !show;
      if (show && els.updatePillLabel) {
        els.updatePillLabel.textContent = `新版 v${state.updateInfo.latestVersion}`;
      }
    }
    if (!skipPushCard) syncUpdatePushCard();
  }

  async function openSettingsModalView(initialTab = 'modes', opts = {}) {
    closeOverlays();
    closeUpdatePushCard();
    const statusRes = await apiGet('/api/status');
    if (statusRes.ok) {
      state.status = statusRes;
      state.settings = statusRes.settings;
      if (statusRes.update) state.updateInfo = statusRes.update;
      syncUpdateBadge({ skipPushCard: true });
    }
    settingsModal.open({
      settings: state.settings,
      evicted: state.session?.recentlyEvicted || [],
      cdpStatus: state.status?.cdp || { connected: false },
      versionInfo: {
        version: state.status?.version || '',
        repoUrl: state.status?.repoUrl || 'https://github.com/Curelove/agy-anchor-wheel',
        releasesUrl: state.status?.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases',
      },
      compatInfo: state.status?.compatibility || null,
      updateInfo: state.updateInfo,
      initialTab,
      focusUpdateSection: Boolean(opts.focusUpdateSection),
      onCheckUpdate: async (force = true) => {
        const res = await apiGet(`/api/update/check${force ? '?force=1' : ''}`);
        if (res && (res.ok || res.error)) {
          state.updateInfo = res;
          syncUpdateBadge();
        }
        return res;
      },
      onIgnoreUpdate: (ver) => ignoreUpdateVersionUi(ver),
      onGenerateLauncher: async () => {
        const res = await apiPost('/api/launcher/generate', {});
        if (res.ok) showToast(`已生成调试启动器：${res.launcherPath}`);
      },
      onSave: async (next) => {
        const res = await apiPost('/api/settings', { settings: next });
        if (res.ok) {
          state.settings = res.settings;
          state.navScopeOverride = '';
          applyThemeFromSettings();
          if (state.docViewerInstance?.setPaperMode) {
            state.docViewerInstance.setPaperMode(Boolean(state.settings?.richDocPaperMode));
          }
          await refreshNavContext();
          showToast('设置已保存并刷新索引');
        }
      },
      onRestoreEvicted: async (p, gid) => {
        const res = await apiPost('/api/session', {
          conversationId,
          op: 'restoreEvicted',
          groupId: gid,
          path: p,
        });
        if (res.ok && res.session) {
          state.session = res.session;
          await openFile(p, { inNewTab: true, fromGroupId: gid });
        }
      },
    });
  }

  async function stepHistoryNav(direction) {
    await apiPost('/api/session', {
      conversationId,
      op: 'history',
      action: 'updateScroll',
      scrollTop: state.docViewerInstance?.getScrollEl?.()?.scrollTop ?? els.reader.scrollTop,
    });
    const res = await apiPost('/api/session', {
      conversationId,
      op: 'history',
      action: direction,
    });
    if (res.ok && res.session) {
      state.session = res.session;
      if (res.targetEntry?.path) {
        const keepNav = Boolean(state.activeTabNavMode && !state.settings?.tabCloseOnSelect);
        await openFile(res.targetEntry.path, {
          skipHistory: true,
          isDirectory: Boolean(res.targetEntry.isDirectory),
          restoreScrollTop: res.targetEntry.scrollTop || 0,
          keepNavigator: keepNav,
        });
      } else {
        syncHistoryButtons();
      }
    }
  }

  async function revealInSystemExplorerUi(targetPath, { preferDirectory = false } = {}) {
    if (!targetPath) return;
    const res = await apiPost('/api/file/reveal', { path: targetPath, preferDirectory: Boolean(preferDirectory) });
    if (res?.ok) {
      showToast(`已在系统资源管理器中打开：${baseName(res.targetPath || targetPath)}`);
    } else {
      showToast(`打开系统文件夹失败：${res?.error || '未知错误'}`);
    }
  }

  function bindGlobalInteractions() {
    els.btnBack.addEventListener('click', () => void stepHistoryNav('back'));
    els.btnForward.addEventListener('click', () => void stepHistoryNav('forward'));
    els.btnUpdatePill?.addEventListener('click', () => {
      if (state.updateInfo?.latestVersion) sessionDismissedUpdateVer = state.updateInfo.latestVersion;
      closeUpdatePushCard();
      void openSettingsModalView('storage', { focusUpdateSection: true });
    });
    els.btnFiles.addEventListener('click', (e) => void openFilesPopover(e.currentTarget));
    els.btnSettings.addEventListener('click', () => void openSettingsModalView('modes'));
    els.btnTree?.addEventListener('click', () => triggerTabNavigator());
    els.btnLinks.addEventListener('click', (e) => {
      e.stopPropagation();
      openLinksPopover(e.currentTarget, '');
    });
    els.btnReveal?.addEventListener('click', () => {
      if (state.activeTabPath) void revealInSystemExplorerUi(state.activeTabPath);
    });
    els.btnEncoding.addEventListener('click', (e) => openEncodingPopover(e.currentTarget));

    els.btnPinAnchor.addEventListener('click', async () => {
      if (!state.activeTabPath) return;
      const rel = findGroupByChildOrAnchor(state.activeTabPath);
      const op = rel && rel.role === 'anchor' ? 'unpinGroup' : 'pinAnchor';
      const isDir = Boolean(state.currentDoc?.isDirectory);
      const res = await apiPost('/api/session', {
        conversationId,
        op,
        groupId: rel?.group?.id,
        path: state.activeTabPath,
        title: (!isDir && state.currentLinks?.title) || baseName(state.activeTabPath),
        isDirectory: isDir,
      });
      if (res.ok && res.session) {
        state.session = res.session;
        updateSubbar();
        renderTabsBar();
      }
    });

    // Drop link onto top Tab Bar to open new independent tab
    els.tabScroll.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.tabScroll.setAttribute('data-aw-tabbar-dropzone', '1');
    });
    els.tabScroll.addEventListener('dragleave', () => {
      els.tabScroll.removeAttribute('data-aw-tabbar-dropzone');
    });
    els.tabScroll.addEventListener('drop', (e) => {
      e.preventDefault();
      els.tabScroll.removeAttribute('data-aw-tabbar-dropzone');
      const linkPath = e.dataTransfer?.getData('text/aw-link') || state.dragPayload;
      if (linkPath) {
        const resolved = resolveRelativeTarget(linkPath, state.activeTabPath);
        if (resolved.target) void openFile(resolved.target, { inNewTab: true, lineStart: resolved.lineStart });
      }
    });

    // Keyboard shortcuts: configurable Tab / Alt+Q / Alt+Left / Alt+Right
    window.addEventListener(
      'keydown',
      (ev) => {
        const tag = String(ev.target?.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.target?.isContentEditable || ev.target?.closest?.('.aw-settings-modal')) {
          return;
        }
        const tabEn = state.settings?.tabTriggerEnabled !== false && state.settings?.tabMode !== 'off';
        const hk = state.settings?.tabCustomHotkey || 'Tab';
        const matchedTabKey =
          (hk === 'Tab' && ev.key === 'Tab' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) ||
          (hk === 'Alt+Q' && ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'q') ||
          (hk === 'Alt+W' && ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'w') ||
          (hk === 'F2' && ev.key === 'F2' && !ev.altKey && !ev.ctrlKey && !ev.metaKey);

        if (tabEn && matchedTabKey && state.activeTabPath) {
          ev.preventDefault();
          ev.stopPropagation();
          triggerTabNavigator();
          return;
        }

        if (ev.altKey && ev.key === 'ArrowLeft') {
          ev.preventDefault();
          void stepHistoryNav('back');
        } else if (ev.altKey && ev.key === 'ArrowRight') {
          ev.preventDefault();
          void stepHistoryNav('forward');
        }
      },
      true
    );

    // Hold-Trigger Mouse Channel (supports Middle / Right / Side Back / Side Forward)
    let holdTimer = null;
    let downInfo = null;
    let holdWheelActiveButton = -1;
    let suppressNextAuxClick = false;
    let suppressNextContextMenu = false;
    let suppressAuxTimer = null;
    let suppressCtxTimer = null;

    const getTriggerMeta = () => S.resolveWheelTriggerButton(state.settings);
    const armSuppressAux = (ms = 220) => {
      suppressNextAuxClick = true;
      clearTimeout(suppressAuxTimer);
      suppressAuxTimer = setTimeout(() => { suppressNextAuxClick = false; suppressAuxTimer = null; }, ms);
    };
    const armSuppressCtx = (ms = 280) => {
      suppressNextContextMenu = true;
      clearTimeout(suppressCtxTimer);
      suppressCtxTimer = setTimeout(() => { suppressNextContextMenu = false; suppressCtxTimer = null; }, ms);
    };

    const openMouseHoldWheel = (info) => {
      const midMode = state.settings?.middleMode || 'bilateral_wheel';
      if (midMode === 'off') return false;
      let opened = false;
      if (midMode === 'classic_wheel') {
        const target = getWheelTargetGroup();
        if (target) {
          openWheelForTarget(target, info.x, info.y, true, info.button);
          opened = true;
        }
      } else {
        opened = openBilateralWheel(info.x, info.y, { holdMode: true, holdButton: info.button });
      }
      if (opened) {
        holdWheelActiveButton = info.button;
        if (info.button === 1 || info.button === 3 || info.button === 4) {
          armSuppressAux(260);
        } else if (info.button === 2) {
          suppressNextContextMenu = true;
          clearTimeout(suppressCtxTimer);
          suppressCtxTimer = null;
        }
      }
      return opened;
    };

    els.reader.addEventListener(
      'mousedown',
      (ev) => {
        const midMode = state.settings?.middleMode || 'bilateral_wheel';
        const trig = getTriggerMeta();
        if (ev.button === 1) {
          if (ev.target.closest('[data-aw-link]') || (midMode !== 'off' && trig.button === 1)) ev.preventDefault();
        } else if ((ev.button === 3 || ev.button === 4) && midMode !== 'off' && trig.button === ev.button) {
          ev.preventDefault();
        }
      },
      true
    );

    document.addEventListener(
      'auxclick',
      (ev) => {
        if (suppressNextAuxClick && (ev.button === 1 || ev.button === 3 || ev.button === 4)) {
          suppressNextAuxClick = false;
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        const midMode = state.settings?.middleMode || 'bilateral_wheel';
        const trig = getTriggerMeta();
        if ((ev.button === 3 || ev.button === 4) && midMode !== 'off' && trig.button === ev.button && els.reader.contains(ev.target)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );

    document.addEventListener(
      'contextmenu',
      (ev) => {
        if (suppressNextContextMenu || holdWheelActiveButton === 2) {
          suppressNextContextMenu = false;
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );

    els.reader.addEventListener('pointerdown', (ev) => {
      const midMode = state.settings?.middleMode || 'bilateral_wheel';
      const trig = getTriggerMeta();
      if (midMode === 'off' || ev.button !== trig.button) return;
      const skipSel =
        ev.button === 1
          ? '[data-aw-link], a, input, select, textarea, summary, label, button:not([data-aw-dir-file]), .aw-doc-toolbar, .aw-doc-findbar, .aw-doc-sheetbar, .aw-doc-outline'
          : 'input, select, textarea, summary, label, button:not([data-aw-dir-file]), .aw-doc-toolbar, .aw-doc-findbar, .aw-doc-sheetbar, .aw-doc-outline';
      if (ev.target.closest(skipSel)) return;
      if (ev.button !== 2) ev.preventDefault();
      const info = {
        x: ev.clientX,
        y: ev.clientY,
        button: trig.button,
        dragPx: trig.dragPx,
        opened: false,
        inReader: true,
        downAt: Date.now(),
      };
      downInfo = info;
      holdTimer = setTimeout(() => {
        if (downInfo === info && !info.opened) {
          info.opened = true;
          openMouseHoldWheel(info);
        }
      }, trig.holdMs);
    });
    document.addEventListener('pointermove', (ev) => {
      if (!downInfo || downInfo.opened) return;
      if (Math.hypot(ev.clientX - downInfo.x, ev.clientY - downInfo.y) >= Number(downInfo.dragPx || 8)) {
        clearTimeout(holdTimer);
        downInfo.opened = true;
        openMouseHoldWheel(downInfo);
      }
    });
    document.addEventListener('pointerup', (ev) => {
      const prev = downInfo;
      const wasHold = holdWheelActiveButton === ev.button || Boolean(prev && prev.opened && prev.button === ev.button);
      clearTimeout(holdTimer);
      downInfo = null;
      if (wasHold) {
        holdWheelActiveButton = -1;
        if (ev.button === 2) armSuppressCtx(280);
        else if (ev.button === 1 || ev.button === 3 || ev.button === 4) armSuppressAux(220);
        ev.preventDefault();
        return;
      }
      if (ev.button === 3 || ev.button === 4) {
        const midMode = state.settings?.middleMode || 'bilateral_wheel';
        const trig = getTriggerMeta();
        if (midMode !== 'off' && trig.button === ev.button && (prev?.inReader || els.reader.contains(ev.target))) {
          ev.preventDefault();
          return;
        }
        ev.preventDefault();
        void stepHistoryNav(ev.button === 3 ? 'back' : 'forward');
      }
    });

    document.addEventListener('click', (ev) => {
      if (!state.activePopover) return;
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      if (els.popoverRoot && (path.includes(els.popoverRoot) || els.popoverRoot.contains(ev.target))) return;
      if (ev.target && ev.target.isConnected === false) return;
      if (!ev.target.closest('.aw-popover, #aw-btn-links, #aw-btn-encoding, #aw-btn-files, #aw-btn-settings')) {
        closePopover();
      }
    });
  }

  async function boot() {
    bindGlobalInteractions();

    // Resolve workspaces if hosted inside Antigravity Sidecar
    try {
      const uris = await Promise.race([
        window.sidecar?.getWorkspaceUris?.() || Promise.resolve([]),
        new Promise((r) => setTimeout(() => r([]), 500)),
      ]);
      if (Array.isArray(uris) && uris.length) {
        state.workspaceRoots = uris.map((u) => u.replace(/^file:\/+/i, '').replace(/^\/([A-Za-z]:)/, '$1'));
      }
      window.sidecar?.onWorkspaceChange?.((nextUris) => {
        state.workspaceRoots = (nextUris || []).map((u) => u.replace(/^file:\/+/i, '').replace(/^\/([A-Za-z]:)/, '$1'));
        void apiPost('/api/index/rescan', { workspaceRoots: state.workspaceRoots });
      });
    } catch {}

    const [stRes, sessRes] = await Promise.all([
      apiGet('/api/status'),
      apiGet(`/api/session?conversationId=${encodeURIComponent(conversationId)}`),
    ]);
    if (stRes.ok) {
      state.status = stRes;
      state.settings = stRes.settings;
      if (stRes.update) state.updateInfo = stRes.update;
      syncUpdateBadge();
      if (!state.workspaceRoots.length && Array.isArray(stRes.index?.workspaceRoots)) {
        state.workspaceRoots = stRes.index.workspaceRoots;
      }
      if (state.settings?.autoCheckUpdates !== false) {
        setTimeout(() => {
          void apiGet('/api/update/check').then((res) => {
            if (res && (res.ok || res.error)) {
              state.updateInfo = res;
              syncUpdateBadge();
            }
          }).catch(() => {});
        }, 2000);
      }
    }
    if (sessRes.ok) {
      state.session = sessRes.session;
    }

    applyThemeFromSettings();
    renderTabsBar();

    const initialPath = qs.get('file');
    if (initialPath) {
      await openFile(initialPath, { inNewTab: true });
    } else if (state.session?.groups?.[0]?.anchorPath) {
      await openFile(state.session.groups[0].anchorPath, { skipHistory: true });
    } else {
      await renderHomeDesk();
    }

    // Expose safe test & debug handle
    window.__awWorkbench = {
      openFile,
      openWheelForGroup,
      openBilateralWheel,
      openAeTree,
      openLinksPopover,
      openEncodingPopover,
      openSettingsPopover: () => openSettingsModalView('modes'),
      openSettingsModal: openSettingsModalView,
      triggerTabNavigator,
      syncUpdateBadge,
      getState: () => state,
    };
  }

  void boot();
})();
