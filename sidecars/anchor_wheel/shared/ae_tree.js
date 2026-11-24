// AE-Tab-Inspired Vertical Ancestor Trunk × Horizontal Child Rounded-Rectangle Tree
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function createAeTree(options = {}) {
    const doc = options.document || document;
    const mountRoot = options.mountRoot || doc.body;
    const S = Shared || globalThis.AnchorWheelNavShared;

    const previewCtrl = S.createPreviewController({
      document: doc,
      mountRoot,
      fetchPreview: options.fetchPreview,
      getDelayMs: options.getDelayMs,
      getAnimated: options.getAnimated,
      isEnabled: options.isPreviewEnabled,
      standaloneRawUrl: options.standaloneRawUrl,
      isOwnerOpen: () => Boolean(wrapperEl && wrapperEl.isConnected && state),
    });

    let wrapperEl = null;
    let state = null;

    function onWindowBlur() {
      previewCtrl.hide();
    }

    function close() {
      previewCtrl.hide();
      try { doc.defaultView?.removeEventListener?.('blur', onWindowBlur); } catch {}
      if (!wrapperEl) return;
      doc.removeEventListener('keydown', onKeyDown, true);
      const cb = state?.onClose;
      try { wrapperEl.remove(); } catch {}
      wrapperEl = null;
      state = null;
      cb?.();
    }

    function onKeyDown(ev) {
      if (!state) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    }

    function handlePick(item) {
      if (!state || !item?.path) return;
      const st = state;
      previewCtrl.hide();
      if (st.closeOnSelect) close();
      st.onSelect?.(item);
    }

    function buildRowsFromContext(ctx) {
      const ancestors = Array.isArray(ctx?.ancestors) ? ctx.ancestors : [];
      const rows = [];
      ancestors.forEach((anc, idx) => {
        const isDirectParent = idx === ancestors.length - 1;
        const depthFromParent = ancestors.length - 1 - idx;
        const isDir = Boolean(anc.isDirectory);
        const roleLabel = isDirectParent
          ? (isDir ? '母文件夹' : '母页')
          : depthFromParent === 1
          ? (isDir ? '上级目录' : '祖父页')
          : `上级 ${idx + 1}`;
        rows.push({
          key: anc.key || S.normKey(anc.path),
          path: anc.path,
          title: anc.title || S.baseDisplayName(anc.path),
          roleLabel,
          isCurrent: false,
          isParent: true,
          isDirectory: isDir,
          dirMeta: anc.dirMeta || null,
          inferred: Boolean(anc.inferred),
          items: Array.isArray(anc.siblings) ? anc.siblings : [],
        });
      });
      if (ctx?.current) {
        const curIsDir = Boolean(ctx.current.isDirectory);
        rows.push({
          key: ctx.current.key || S.normKey(ctx.current.path),
          path: ctx.current.path,
          title: ctx.current.title || S.baseDisplayName(ctx.current.path),
          roleLabel: curIsDir ? '当前文件夹' : '当前页',
          isCurrent: true,
          isDirectory: curIsDir,
          dirMeta: ctx.current.dirMeta || null,
          items: Array.isArray(ctx.current.children) ? ctx.current.children : [],
        });
      }
      return rows;
    }

    function renderPanel() {
      previewCtrl.hide();
      if (!wrapperEl || !state) return;
      const panel = wrapperEl.querySelector('.aw-tree-panel');
      if (!panel) return;
      panel.innerHTML = '';

      const ctx = state.context || {};
      const curIsDir = Boolean(ctx.current?.isDirectory);
      const curDirMeta = ctx.current?.dirMeta || null;
      const scope = state.scope || ctx.childSourceScope || 'opened_and_outlinks';
      const rows = buildRowsFromContext(ctx);

      const head = S.markNode(doc.createElement('div'));
      head.className = 'aw-tree-head';
      head.innerHTML = `
        <div class="aw-tree-head-title">${S.ICONS.tree}<span>层级导览</span></div>
        <div class="aw-tray" style="padding:2px">
          <button type="button" class="aw-tray-btn" data-aw-tree-scope="opened_and_outlinks" data-active="${scope !== 'opened_only' ? '1' : '0'}">${curIsDir ? '全部文件' : '全部出链'}</button>
          <button type="button" class="aw-tray-btn" data-aw-tree-scope="opened_only" data-active="${scope === 'opened_only' ? '1' : '0'}">仅已开</button>
        </div>
        <button type="button" class="aw-tray-btn" data-aw-tree-close="1" title="关闭 (Tab / Esc)">${S.ICONS.close}</button>
      `;
      head.querySelectorAll('[data-aw-tree-scope]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          previewCtrl.hide();
          const nextScope = btn.getAttribute('data-aw-tree-scope');
          if (nextScope && nextScope !== state.scope) {
            state.scope = nextScope;
            state.onSwitchScope?.(nextScope);
          }
        });
      });
      head.querySelector('[data-aw-tree-close]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
      panel.appendChild(head);

      const scrollBody = S.markNode(doc.createElement('div'));
      scrollBody.className = 'aw-tree-scroll';

      if (!ctx.ancestors?.length) {
        const emptyTop = S.markNode(doc.createElement('div'));
        emptyTop.className = 'aw-tree-empty-parent';
        emptyTop.textContent = curIsDir
          ? '上级母页：暂未从其他文档跳转进入当前文件夹'
          : '上级母页：暂未从其他文档或文件夹跳转进入当前页';
        scrollBody.appendChild(emptyTop);
      }

      const listWrap = S.markNode(doc.createElement('div'));
      listWrap.className = 'aw-tree-rows';

      rows.forEach((row, rowIdx) => {
        const rowEl = S.markNode(doc.createElement('div'));
        rowEl.className = 'aw-tree-row';
        if (row.isCurrent) rowEl.setAttribute('data-current', '1');
        if (rowIdx < rows.length - 1) rowEl.setAttribute('data-has-next', '1');

        // Left vertical trunk node
        const trunkCol = S.markNode(doc.createElement('div'));
        trunkCol.className = 'aw-tree-trunk-col';

        const nodeCard = S.markNode(doc.createElement('button'));
        nodeCard.type = 'button';
        nodeCard.className = 'aw-tree-node';
        if (row.isCurrent) {
          nodeCard.setAttribute('data-current', '1');
          if (state.justUpdated) nodeCard.setAttribute('data-pulse', '1');
        }
        nodeCard.innerHTML = `
          <span class="aw-tree-role">${S.esc(row.roleLabel)}${row.inferred ? ' · 推' : ''}</span>
          <span class="aw-tree-node-label">${S.pickIconForItem(row)}<span>${S.esc(S.baseDisplayName(row.title))}</span></span>
        `;
        nodeCard.title = row.path;
        if (!row.isCurrent) {
          nodeCard.addEventListener('mouseenter', () => {
            previewCtrl.scheduleShow(row, nodeCard.getBoundingClientRect());
          });
          nodeCard.addEventListener('mouseleave', () => previewCtrl.hide());
          nodeCard.addEventListener('click', (e) => {
            e.stopPropagation();
            handlePick(row);
          });
        }
        trunkCol.appendChild(nodeCard);
        rowEl.appendChild(trunkCol);

        // Right branch: horizontal/stacked children rounded rects (dimmed until row hover)
        const branchCol = S.markNode(doc.createElement('div'));
        branchCol.className = 'aw-tree-branch';
        const items = row.items;
        if (items.length) {
          const connector = S.markNode(doc.createElement('div'));
          connector.className = 'aw-tree-connector';
          branchCol.appendChild(connector);

          const childrenCol = S.markNode(doc.createElement('div'));
          childrenCol.className = 'aw-tree-children';

          const limit = Math.max(3, Number(state.expandedCounts[row.key] || 3));
          const visible = items.slice(0, limit);
          const hiddenCount = Math.max(0, items.length - visible.length);

          visible.forEach((child, cIdx) => {
            const cardWrap = S.markNode(doc.createElement('div'));
            cardWrap.className = 'aw-tree-child-wrap';
            const isLastStacked = hiddenCount > 0 && cIdx === visible.length - 1;
            if (isLastStacked) cardWrap.setAttribute('data-stacked', '1');

            const card = S.markNode(doc.createElement('button'));
            card.type = 'button';
            card.className = 'aw-tree-child aw-stagger-in';
            card.style.setProperty('--aw-i', String(cIdx));
            const delayMs = Math.max(40, Math.min(1500, Number(options.getDelayMs?.() ?? 250)));
            card.style.setProperty('--aw-charge-ms', `${delayMs}ms`);
            if (child.isOpenedTab) card.setAttribute('data-opened', '1');
            card.innerHTML = `
              ${S.pickIconForItem(child)}
              <span class="aw-tree-child-title">${S.esc(S.baseDisplayName(child.title || child.path))}</span>
              ${child.isOpenedTab ? '<span class="aw-bi-dot" title="已打开标签"></span>' : ''}
              <span class="aw-tree-charge-bar" aria-hidden="true"></span>
            `;
            card.title = child.path;
            card.addEventListener('mouseenter', () => {
              previewCtrl.scheduleShow(child, card.getBoundingClientRect());
            });
            card.addEventListener('mouseleave', () => previewCtrl.hide());
            card.addEventListener('click', (e) => {
              e.stopPropagation();
              handlePick(child);
            });
            cardWrap.appendChild(card);

            if (isLastStacked) {
              const stackBtn = S.markNode(doc.createElement('button'));
              stackBtn.type = 'button';
              stackBtn.className = 'aw-tree-stack-corner';
              stackBtn.innerHTML = `<span>+${hiddenCount} 条</span>${S.ICONS.chevronDown}`;
              stackBtn.title = '展开更多子页（下方条目将自动下移避让）';
              stackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                previewCtrl.hide();
                const nextLimit = limit + 6;
                // Avoid leaving 1..3 straggler items behind an extra click
                state.expandedCounts[row.key] = items.length - nextLimit <= 3 ? items.length : nextLimit;
                renderPanel();
              });
              cardWrap.appendChild(stackBtn);
            }

            childrenCol.appendChild(cardWrap);
          });

          if (hiddenCount === 0 && items.length > 3) {
            const collapseBtn = S.markNode(doc.createElement('button'));
            collapseBtn.type = 'button';
            collapseBtn.className = 'aw-tree-collapse-btn';
            collapseBtn.textContent = '收起折叠';
            collapseBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              delete state.expandedCounts[row.key];
              renderPanel();
            });
            childrenCol.appendChild(collapseBtn);
          }

          branchCol.appendChild(childrenCol);
        } else {
          const noneHint = S.markNode(doc.createElement('div'));
          noneHint.className = 'aw-tree-branch-empty';
          if (row.isCurrent && row.isDirectory) {
            const sk = row.dirMeta?.skippedSubdirCount ? `（已略过 ${row.dirMeta.skippedSubdirCount} 个子文件夹）` : '';
            noneHint.textContent = `暂无直属文件${sk}`;
          } else {
            noneHint.textContent = row.isCurrent ? '无子页' : '无其他同级子页';
          }
          branchCol.appendChild(noneHint);
        }

        rowEl.appendChild(branchCol);
        listWrap.appendChild(rowEl);
      });

      scrollBody.appendChild(listWrap);
      panel.appendChild(scrollBody);

      const foot = S.markNode(doc.createElement('div'));
      foot.className = 'aw-tree-foot';
      const previewOn = options.isPreviewEnabled ? Boolean(options.isPreviewEnabled()) : true;
      const delayMs = Math.max(0, Math.min(1500, Number(options.getDelayMs?.() ?? 250)));
      const hotkeyLabel = String(options.getHotkey?.() || 'Tab');
      const prevHint = previewOn ? `悬停 ${delayMs}ms 看开头预览` : '悬停快览已关闭';
      const dirFootParts = [];
      if (curIsDir && curDirMeta) {
        if (curDirMeta.truncated) dirFootParts.push(`已展示前 ${curDirMeta.maxFiles}/${curDirMeta.totalFiles} 文件`);
        if (curDirMeta.skippedSubdirCount > 0) dirFootParts.push(`已略过 ${curDirMeta.skippedSubdirCount} 个子文件夹`);
      }
      const dirFootSuffix = dirFootParts.length ? ` · ${dirFootParts.join(' · ')}` : '';
      foot.textContent = state.closeOnSelect
        ? `${prevHint} · 点击跳转并收起${dirFootSuffix}`
        : `${prevHint} · 点击跳转保持常驻 · 按 ${hotkeyLabel} 关闭${dirFootSuffix}`;
      panel.appendChild(foot);
    }

    function open({
      context,
      anchorRect = null,
      scope = 'opened_and_outlinks',
      closeOnSelect = false,
      onSelect,
      onSwitchScope,
      onClose,
    }) {
      close();
      if (!context || !context.current) return;

      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;
      const panelW = Math.min(430, vw - 24);
      const baseLeft = anchorRect
        ? clamp(anchorRect.left + 12, 12, vw - panelW - 12)
        : clamp(Math.round((vw - panelW) / 2), 12, vw - panelW - 12);
      const baseTop = anchorRect ? clamp(anchorRect.top + 48, 44, vh - 220) : 64;

      wrapperEl = S.markNode(doc.createElement('div'));
      wrapperEl.className = 'aw-tree-backdrop';
      const resolvedTheme = options.getTheme ? options.getTheme() : options.theme;
      if (resolvedTheme && resolvedTheme !== 'auto') {
        wrapperEl.setAttribute('data-aw-theme', resolvedTheme);
      }

      const panel = S.markNode(doc.createElement('div'));
      panel.className = 'aw-tree-panel';
      panel.style.width = `${panelW}px`;
      panel.style.left = `${baseLeft}px`;
      panel.style.top = `${baseTop}px`;
      panel.addEventListener('click', (e) => e.stopPropagation());
      panel.addEventListener('mousedown', (e) => e.stopPropagation());
      wrapperEl.appendChild(panel);

      state = {
        context,
        scope,
        closeOnSelect: Boolean(closeOnSelect),
        expandedCounts: {},
        onSelect,
        onSwitchScope,
        onClose,
      };

      mountRoot.appendChild(wrapperEl);
      renderPanel();
      requestAnimationFrame(() => {
        if (wrapperEl) wrapperEl.setAttribute('data-open', '1');
      });
      doc.addEventListener('keydown', onKeyDown, true);
      try { doc.defaultView?.addEventListener?.('blur', onWindowBlur); } catch {}
    }

    function updateContext(nextContext) {
      if (!state || !nextContext || !nextContext.current) return;
      previewCtrl.hide();
      state.context = nextContext;
      state.justUpdated = true;
      renderPanel();
      state.justUpdated = false;
    }

    return {
      open,
      close,
      updateContext,
      isOpen: () => Boolean(wrapperEl),
    };
  }

  return { createAeTree };
});
