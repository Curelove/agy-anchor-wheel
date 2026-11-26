// Shared Rich Document Viewer UI (DOCX, XLSX, PPTX, ODT/ODS/ODP, RTF, EPUB, CSV/TSV, ZIP, DOC, PDF)
// Used identically by Mode 1 (Native Side-Pane Overlay) and Mode 2 (Sidecar Workbench).
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelDocViewer = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  const VIEWER_ICONS = Object.freeze({
    outline:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
    search:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    paper:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
    copy:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    external:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    code:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    up:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    down:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    close:
      '<svg class="aw-icon" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  });

  const AUTO_RENDER_EXT_RE = /\.(?:docx|doc|xlsx|xlsm|pptx|odt|ods|odp|rtf|epub|zip)$/i;
  const OPTIONAL_TABLE_EXT_RE = /\.(?:csv|tsv)$/i;
  const BINARY_DOC_EXT_RE = /\.(?:docx|doc|xlsx|xlsm|pptx|odt|ods|odp|epub|zip|pdf)$/i;

  function classifyDocPathClient(filePath) {
    const p = String(filePath || '').trim().replace(/[\\/]+$/, '');
    if (!p) return null;
    const dot = p.lastIndexOf('.');
    if (dot === -1) return null;
    const ext = p.slice(dot + 1).toLowerCase();
    if (AUTO_RENDER_EXT_RE.test(p)) {
      return { ext, badge: ext.toUpperCase(), autoRender: true, optionalTable: false, isBinaryDoc: BINARY_DOC_EXT_RE.test(p) };
    }
    if (OPTIONAL_TABLE_EXT_RE.test(p)) {
      return { ext, badge: ext.toUpperCase(), autoRender: false, optionalTable: true, isBinaryDoc: false };
    }
    if (ext === 'pdf') {
      return { ext, badge: 'PDF', autoRender: false, optionalTable: false, mode2Only: true, isBinaryDoc: true };
    }
    return null;
  }

  function esc(str) {
    if (Shared?.esc) return Shared.esc(str);
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function mark(el) {
    if (Shared?.markNode) return Shared.markNode(el);
    return el;
  }

  function clearFindHighlights(rootEl) {
    if (!rootEl) return;
    const marks = rootEl.querySelectorAll('mark.aw-doc-hit');
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(rootEl.ownerDocument.createTextNode(m.textContent || ''), m);
      parent.normalize();
    }
  }

  function highlightMatchesInContainer(rootEl, rawQuery) {
    clearFindHighlights(rootEl);
    const q = String(rawQuery || '').trim();
    if (!rootEl || !q) return [];
    const qLower = q.toLowerCase();
    const doc = rootEl.ownerDocument;
    const NodeFilterRef = doc.defaultView?.NodeFilter || globalThis.NodeFilter;
    const walker = doc.createTreeWalker(rootEl, NodeFilterRef ? NodeFilterRef.SHOW_TEXT : 4);
    const textNodes = [];
    let cur;
    while ((cur = walker.nextNode())) {
      if (!cur.nodeValue || !cur.nodeValue.trim()) continue;
      const pTag = cur.parentElement?.tagName?.toUpperCase();
      if (pTag === 'SCRIPT' || pTag === 'STYLE' || pTag === 'MARK') continue;
      if (cur.nodeValue.toLowerCase().includes(qLower)) {
        textNodes.push(cur);
      }
    }

    const hitEls = [];
    const maxHits = 300;
    for (const node of textNodes) {
      if (hitEls.length >= maxHits) break;
      const val = node.nodeValue || '';
      const low = val.toLowerCase();
      let from = 0;
      let idx = low.indexOf(qLower, from);
      if (idx === -1) continue;
      const frag = doc.createDocumentFragment();
      while (idx !== -1 && hitEls.length < maxHits) {
        if (idx > from) frag.appendChild(doc.createTextNode(val.slice(from, idx)));
        const mk = doc.createElement('mark');
        mk.className = 'aw-doc-hit';
        mk.textContent = val.slice(idx, idx + q.length);
        frag.appendChild(mk);
        hitEls.push(mk);
        from = idx + q.length;
        idx = low.indexOf(qLower, from);
      }
      if (from < val.length) frag.appendChild(doc.createTextNode(val.slice(from)));
      node.parentNode?.replaceChild(frag, node);
    }
    return hitEls;
  }

  /**
   * Mounts a complete interactive rich document viewer into `mountEl`.
   * Returns `{ destroy(), getScrollEl() }`.
   */
  function mountDocumentViewer(mountEl, docData, opts = {}) {
    if (!mountEl || !docData) return { destroy() {}, getScrollEl: () => null };
    const doc = mountEl.ownerDocument || document;
    const format = String(docData.format || '');
    const isSpreadsheet = format === 'xlsx' || format === 'ods';
    const isCsvLike = format === 'csv' || format === 'tsv';
    const isEpub = format === 'epub';
    const isPdf = format === 'pdf';
    const hasSections = Array.isArray(docData.sections) && docData.sections.length > 0;
    const outline = Array.isArray(docData.outline) ? docData.outline : [];
    const warnings = Array.isArray(docData.warnings) ? docData.warnings : [];
    const supportsPaper = Boolean(docData.supportsPaperMode);

    let paperMode = supportsPaper && Boolean(opts.paperMode);
    let activeSectionIdx = 0;
    let outlineOpen = false;
    let findOpen = false;
    let findHits = [];
    let findIdx = -1;
    let sheetFilterText = '';

    mountEl.innerHTML = '';

    const shell = mark(doc.createElement('div'));
    shell.className = 'aw-doc-viewer';
    shell.setAttribute('data-aw-doc-format', format);
    shell.setAttribute('data-aw-paper', paperMode ? '1' : '0');

    const badge = esc(docData.badge || format.toUpperCase());
    const statsLabel = esc(docData.meta?.statsLabel || '');
    const titleStr = esc(docData.title || '');
    const canOutline = outline.length > 0 && !isSpreadsheet && !isEpub;
    const canCopy = Boolean(docData.plainText);
    const canFind = !isPdf;

    shell.innerHTML = `
      <div class="aw-doc-toolbar">
        <div class="aw-doc-toolbar-left">
          <span class="aw-doc-format-badge" data-fmt="${esc(format)}">${badge}</span>
          <span class="aw-doc-toolbar-title" title="${esc(docData.path || titleStr)}">${titleStr}</span>
          ${statsLabel ? `<span class="aw-doc-toolbar-stats">${statsLabel}</span>` : ''}
        </div>
        <div class="aw-tray aw-doc-toolbar-actions">
          ${canOutline ? `<button type="button" class="aw-tray-btn" data-aw-doc-act="outline" title="展开或收起文档目录">${VIEWER_ICONS.outline}<span class="aw-doc-btn-txt">目录</span></button>` : ''}
          ${canFind ? `<button type="button" class="aw-tray-btn" data-aw-doc-act="find" title="页内查找关键词">${VIEWER_ICONS.search}<span class="aw-doc-btn-txt">查找</span></button>` : ''}
          ${supportsPaper ? `<button type="button" class="aw-tray-btn" data-aw-doc-act="paper" data-active="${paperMode ? '1' : '0'}" title="切换跟随主题或白纸原稿外观">${VIEWER_ICONS.paper}<span class="aw-doc-btn-txt">${paperMode ? '纸面' : '主题'}</span></button>` : ''}
          ${canCopy ? `<button type="button" class="aw-tray-btn" data-aw-doc-act="copy" title="复制纯文本内容">${VIEWER_ICONS.copy}<span class="aw-doc-btn-txt">复制</span></button>` : ''}
          ${opts.onOpenExternal ? `<button type="button" class="aw-tray-btn" data-aw-doc-act="external" title="使用系统默认应用打开并编辑">${VIEWER_ICONS.external}<span class="aw-doc-btn-txt">系统打开</span></button>` : ''}
          ${opts.onSwitchToRaw ? `<button type="button" class="aw-tray-btn" data-aw-doc-act="raw" title="${esc(opts.rawLabel || '切换至原生/源码视图')}">${VIEWER_ICONS.code}<span class="aw-doc-btn-txt">${esc(opts.rawLabel || '原生视图')}</span></button>` : ''}
        </div>
      </div>

      <div class="aw-doc-findbar" hidden>
        <input type="text" class="aw-input aw-doc-find-input" placeholder="在当前文档中查找..." />
        <span class="aw-doc-find-count">0 / 0</span>
        <div class="aw-tray">
          <button type="button" class="aw-tray-btn" data-aw-find-nav="prev" title="上一处 (Shift+Enter)">${VIEWER_ICONS.up}</button>
          <button type="button" class="aw-tray-btn" data-aw-find-nav="next" title="下一处 (Enter)">${VIEWER_ICONS.down}</button>
          <button type="button" class="aw-tray-btn" data-aw-find-nav="close" title="关闭查找 (Esc)">${VIEWER_ICONS.close}</button>
        </div>
      </div>

      ${
        isSpreadsheet && hasSections
          ? `<div class="aw-doc-sheetbar">
              <div class="aw-doc-sheet-tabs" role="tablist">
                ${docData.sections
                  .map(
                    (sec, idx) =>
                      `<button type="button" role="tab" class="aw-doc-sheet-tab" data-aw-sec-idx="${idx}" data-active="${idx === 0 ? '1' : '0'}">${esc(sec.title)}</button>`
                  )
                  .join('')}
              </div>
              <input type="text" class="aw-input aw-doc-sheet-filter" placeholder="筛选当前表行..." />
            </div>`
          : isCsvLike
          ? `<div class="aw-doc-sheetbar">
              <span class="aw-doc-toolbar-stats">交互表格模式</span>
              <input type="text" class="aw-input aw-doc-sheet-filter" placeholder="筛选表格行..." />
            </div>`
          : isEpub && hasSections
          ? `<div class="aw-doc-sheetbar">
              <div class="aw-tray">
                <button type="button" class="aw-tray-btn" data-aw-epub-step="-1">上一章</button>
                <button type="button" class="aw-tray-btn" data-aw-epub-step="1">下一章</button>
              </div>
              <select class="aw-select aw-doc-epub-select">
                ${docData.sections
                  .map((sec, idx) => `<option value="${idx}">${esc(sec.title)}</option>`)
                  .join('')}
              </select>
            </div>`
          : ''
      }

      ${
        warnings.length
          ? `<div class="aw-doc-warning-bar">${warnings.map((w) => `<span>${esc(w)}</span>`).join('')}</div>`
          : ''
      }

      <div class="aw-doc-workspace">
        ${
          canOutline
            ? `<aside class="aw-doc-outline" hidden>
                <div class="aw-doc-outline-head">
                  <span>文档目录 (${outline.length})</span>
                  <button type="button" class="aw-tray-btn" data-aw-outline-close="1">${VIEWER_ICONS.close}</button>
                </div>
                <div class="aw-doc-outline-list">
                  ${outline
                    .map(
                      (item) =>
                        `<button type="button" class="aw-doc-outline-item" data-lvl="${Math.min(4, Math.max(1, Number(item.level || 1)))}" data-aw-jump-id="${esc(item.id)}" title="${esc(item.title)}">${esc(item.title)}</button>`
                    )
                    .join('')}
                </div>
              </aside>`
            : ''
        }
        <div class="aw-doc-scroll" data-aw-scroll-host="1" data-aw-wheel-passthrough="1">
          <article class="aw-doc-canvas" data-aw-wheel-passthrough="1"></article>
        </div>
      </div>
    `;

    mountEl.appendChild(shell);

    const scrollEl = shell.querySelector('.aw-doc-scroll');
    const canvasEl = shell.querySelector('.aw-doc-canvas');
    const outlineEl = shell.querySelector('.aw-doc-outline');
    const findBarEl = shell.querySelector('.aw-doc-findbar');
    const findInputEl = shell.querySelector('.aw-doc-find-input');
    const findCountEl = shell.querySelector('.aw-doc-find-count');
    const sheetFilterEl = shell.querySelector('.aw-doc-sheet-filter');
    const epubSelectEl = shell.querySelector('.aw-doc-epub-select');

    function renderActiveBody() {
      if (!canvasEl) return;
      if (isPdf && opts.pdfRawUrl) {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-pdf';
        canvasEl.innerHTML = `<iframe class="aw-doc-pdf-frame" src="${esc(opts.pdfRawUrl)}" title="${titleStr}"></iframe>`;
        return;
      }
      if (hasSections && (isSpreadsheet || isEpub)) {
        const sec = docData.sections[activeSectionIdx] || docData.sections[0];
        canvasEl.className = isSpreadsheet ? 'aw-doc-canvas aw-doc-canvas-sheet' : 'aw-doc-canvas aw-doc-canvas-article';
        canvasEl.innerHTML = sec?.html || '<p class="aw-doc-empty-msg">内容为空。</p>';
      } else if (isCsvLike || format === 'zip') {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-sheet';
        canvasEl.innerHTML = docData.bodyHtml || '<p class="aw-doc-empty-msg">内容为空。</p>';
      } else if (format === 'pptx' || format === 'odp') {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-slides';
        canvasEl.innerHTML = docData.bodyHtml || '<p class="aw-doc-empty-msg">演示文稿为空。</p>';
      } else {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-article';
        canvasEl.innerHTML = docData.bodyHtml || '<p class="aw-doc-empty-msg">文档正文为空。</p>';
      }

      // Bind internal anchor links (#aw-doc-note-1 etc.) safely inside the scroll container
      for (const a of canvasEl.querySelectorAll('a[href^="#"]')) {
        a.addEventListener('click', (ev) => {
          const hash = a.getAttribute('href') || '';
          const id = hash.slice(1);
          const target = id ? canvasEl.querySelector(`[id="${CSS?.escape ? CSS.escape(id) : id}"]`) : null;
          if (target) {
            ev.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('aw-doc-jump-pulse');
            setTimeout(() => target.classList.remove('aw-doc-jump-pulse'), 1400);
          }
        });
      }

      if (sheetFilterText && (isSpreadsheet || isCsvLike)) {
        applySheetRowFilter(sheetFilterText);
      }
      if (findOpen && findInputEl?.value) {
        runFind(findInputEl.value, false);
      }
    }

    function applySheetRowFilter(query) {
      const q = String(query || '').trim().toLowerCase();
      const rows = canvasEl?.querySelectorAll?.('tbody tr[data-aw-row]');
      if (!rows || !rows.length) return;
      for (const tr of rows) {
        if (!q) {
          tr.hidden = false;
        } else {
          const text = (tr.textContent || '').toLowerCase();
          tr.hidden = !text.includes(q);
        }
      }
    }

    function updateFindStatus() {
      if (!findCountEl) return;
      if (!findHits.length) {
        findCountEl.textContent = findInputEl?.value?.trim() ? '无匹配' : '0 / 0';
      } else {
        findCountEl.textContent = `${findIdx + 1} / ${findHits.length}`;
      }
    }

    function focusFindHit(nextIndex) {
      if (!findHits.length) {
        findIdx = -1;
        updateFindStatus();
        return;
      }
      if (findIdx >= 0 && findHits[findIdx]) {
        findHits[findIdx].removeAttribute('data-current');
      }
      findIdx = ((nextIndex % findHits.length) + findHits.length) % findHits.length;
      const curHit = findHits[findIdx];
      curHit.setAttribute('data-current', '1');
      curHit.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateFindStatus();
    }

    function runFind(query, jumpFirst = true) {
      findHits = highlightMatchesInContainer(canvasEl, query);
      findIdx = -1;
      if (findHits.length && jumpFirst) {
        focusFindHit(0);
      } else {
        updateFindStatus();
      }
    }

    function toggleFindBar(forceState) {
      if (!findBarEl) return;
      findOpen = typeof forceState === 'boolean' ? forceState : !findOpen;
      findBarEl.hidden = !findOpen;
      shell.querySelector('[data-aw-doc-act="find"]')?.setAttribute('data-active', findOpen ? '1' : '0');
      if (findOpen) {
        findInputEl?.focus();
        findInputEl?.select();
      } else {
        clearFindHighlights(canvasEl);
        findHits = [];
        findIdx = -1;
        updateFindStatus();
      }
    }

    function toggleOutline(forceState) {
      if (!outlineEl) return;
      outlineOpen = typeof forceState === 'boolean' ? forceState : !outlineOpen;
      outlineEl.hidden = !outlineOpen;
      shell.querySelector('[data-aw-doc-act="outline"]')?.setAttribute('data-active', outlineOpen ? '1' : '0');
    }

    // Toolbar actions
    shell.querySelector('[data-aw-doc-act="outline"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOutline();
    });
    shell.querySelector('[data-aw-outline-close]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOutline(false);
    });
    shell.querySelector('[data-aw-doc-act="find"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFindBar();
    });
    shell.querySelector('[data-aw-doc-act="paper"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      paperMode = !paperMode;
      shell.setAttribute('data-aw-paper', paperMode ? '1' : '0');
      const btn = e.currentTarget;
      btn.setAttribute('data-active', paperMode ? '1' : '0');
      const lbl = btn.querySelector('.aw-doc-btn-txt');
      if (lbl) lbl.textContent = paperMode ? '纸面' : '主题';
      opts.onTogglePaperMode?.(paperMode);
    });
    shell.querySelector('[data-aw-doc-act="copy"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const lbl = btn.querySelector('.aw-doc-btn-txt');
      const text = docData.plainText || '';
      if (text && doc.defaultView?.navigator?.clipboard?.writeText) {
        void doc.defaultView.navigator.clipboard.writeText(text).then(() => {
          if (lbl) lbl.textContent = '已复制';
          setTimeout(() => { if (lbl) lbl.textContent = '复制'; }, 1400);
        });
      }
    });
    shell.querySelector('[data-aw-doc-act="external"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onOpenExternal?.(docData.path);
    });
    shell.querySelector('[data-aw-doc-act="raw"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onSwitchToRaw?.();
    });

    // Outline item jump
    for (const itemBtn of shell.querySelectorAll('[data-aw-jump-id]')) {
      itemBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = itemBtn.getAttribute('data-aw-jump-id');
        const target = id ? canvasEl.querySelector(`[id="${CSS?.escape ? CSS.escape(id) : id}"]`) : null;
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.classList.add('aw-doc-jump-pulse');
          setTimeout(() => target.classList.remove('aw-doc-jump-pulse'), 1400);
          if ((mountEl.clientWidth || 600) < 620) toggleOutline(false);
        }
      });
    }

    // Spreadsheet tabs & filter
    for (const tabBtn of shell.querySelectorAll('[data-aw-sec-idx]')) {
      tabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextIdx = Number(tabBtn.getAttribute('data-aw-sec-idx'));
        if (!Number.isFinite(nextIdx) || nextIdx === activeSectionIdx) return;
        activeSectionIdx = nextIdx;
        for (const t2 of shell.querySelectorAll('[data-aw-sec-idx]')) {
          t2.setAttribute('data-active', Number(t2.getAttribute('data-aw-sec-idx')) === activeSectionIdx ? '1' : '0');
        }
        renderActiveBody();
        if (scrollEl) scrollEl.scrollTop = 0;
      });
    }

    sheetFilterEl?.addEventListener('input', (e) => {
      sheetFilterText = e.currentTarget.value || '';
      applySheetRowFilter(sheetFilterText);
    });

    // EPUB chapter navigation
    const updateEpubControls = () => {
      if (!isEpub || !hasSections) return;
      if (epubSelectEl) epubSelectEl.value = String(activeSectionIdx);
      const prevBtn = shell.querySelector('[data-aw-epub-step="-1"]');
      const nextBtn = shell.querySelector('[data-aw-epub-step="1"]');
      if (prevBtn) prevBtn.disabled = activeSectionIdx <= 0;
      if (nextBtn) nextBtn.disabled = activeSectionIdx >= docData.sections.length - 1;
    };
    for (const stepBtn of shell.querySelectorAll('[data-aw-epub-step]')) {
      stepBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const delta = Number(stepBtn.getAttribute('data-aw-epub-step') || 0);
        const nextIdx = Math.max(0, Math.min(docData.sections.length - 1, activeSectionIdx + delta));
        if (nextIdx !== activeSectionIdx) {
          activeSectionIdx = nextIdx;
          updateEpubControls();
          renderActiveBody();
          if (scrollEl) scrollEl.scrollTop = 0;
        }
      });
    }
    epubSelectEl?.addEventListener('change', (e) => {
      const nextIdx = Number(e.currentTarget.value);
      if (Number.isFinite(nextIdx) && nextIdx !== activeSectionIdx) {
        activeSectionIdx = nextIdx;
        updateEpubControls();
        renderActiveBody();
        if (scrollEl) scrollEl.scrollTop = 0;
      }
    });

    // Find bar interactions
    let findTimer = null;
    findInputEl?.addEventListener('input', (e) => {
      const val = e.currentTarget.value || '';
      clearTimeout(findTimer);
      findTimer = setTimeout(() => runFind(val, true), 110);
    });
    findInputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        focusFindHit(findIdx + (e.shiftKey ? -1 : 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        toggleFindBar(false);
      }
    });
    shell.querySelector('[data-aw-find-nav="prev"]')?.addEventListener('click', () => focusFindHit(findIdx - 1));
    shell.querySelector('[data-aw-find-nav="next"]')?.addEventListener('click', () => focusFindHit(findIdx + 1));
    shell.querySelector('[data-aw-find-nav="close"]')?.addEventListener('click', () => toggleFindBar(false));

    renderActiveBody();
    updateEpubControls();

    return {
      getScrollEl: () => scrollEl,
      setPaperMode: (next) => {
        if (!supportsPaper) return;
        paperMode = Boolean(next);
        shell.setAttribute('data-aw-paper', paperMode ? '1' : '0');
        const btn = shell.querySelector('[data-aw-doc-act="paper"]');
        if (btn) {
          btn.setAttribute('data-active', paperMode ? '1' : '0');
          const lbl = btn.querySelector('.aw-doc-btn-txt');
          if (lbl) lbl.textContent = paperMode ? '纸面' : '主题';
        }
      },
      destroy() {
        clearTimeout(findTimer);
        shell.remove();
      },
    };
  }

  return {
    classifyDocPathClient,
    mountDocumentViewer,
    VIEWER_ICONS,
  };
});
