// StarPie-inspired Radial Optical Wheel & Compact Group Switcher (shared by Mode 1 Native & Mode 2 Workbench)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CX = 172;
  const CY = 172;
  const R_INNER = 46;
  const R_OUTER = 152;
  const R_CANCEL_MARGIN = 34;

  const ICONS = {
    anchor: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>',
    file: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    code: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    image: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    pin: '<svg class="aw-icon" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>',
    close: '<svg class="aw-icon" style="width:12px;height:12px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    list: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  };

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function sectorPath(cx, cy, rIn, rOut, a0, a1) {
    const gap = 1.6;
    const start = a0 + gap / 2;
    const end = a1 - gap / 2;
    const [x1, y1] = polar(cx, cy, rOut, start);
    const [x2, y2] = polar(cx, cy, rOut, end);
    const [x3, y3] = polar(cx, cy, rIn, end);
    const [x4, y4] = polar(cx, cy, rIn, start);
    const large = end - start > 180 ? 1 : 0;
    return [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${rOut} ${rOut} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      `A ${rIn} ${rIn} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  function pickIconForTitle(title) {
    const t = String(title || '').toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/.test(t)) return ICONS.image;
    if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cpp|c|h|css|html|json|yaml|yml|sh|ps1)$/.test(t)) return ICONS.code;
    return ICONS.file;
  }

  function baseDisplayName(name) {
    const s = String(name || '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  }

  function createRadialWheel(options = {}) {
    const doc = options.document || document;
    const mountRoot = options.mountRoot || doc.body;
    const markNode = (el) => {
      if (!el) return el;
      el.setAttribute('data-aw-owned', '1');
      el.setAttribute('data-omni-ignore', '1');
      el.setAttribute('data-prism-ignore', '1');
      el.setAttribute('translate', 'no');
      el.setAttribute('data-no-translate', 'true');
      el.setAttribute('data-ag-localization-skip', 'true');
      return el;
    };

    let activeState = null;
    let backdropEl = null;

    function close() {
      if (!backdropEl) return;
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      try { backdropEl.remove(); } catch {}
      backdropEl = null;
      activeState = null;
    }

    function selectIndex(idx) {
      if (!activeState) return;
      const st = activeState;
      const shouldClose = st.holdMode || st.closeOnSelect !== false;
      if (idx === 'hub') {
        const anchor = { path: st.group.anchorPath, title: st.group.anchorTitle, isAnchor: true };
        if (shouldClose) close();
        st.onSelect?.(anchor);
        return;
      }
      if (typeof idx === 'number' && st.pageItems[idx]) {
        const picked = st.pageItems[idx];
        if (shouldClose) close();
        st.onSelect?.(picked);
      }
    }

    function hitTestPointer(clientX, clientY) {
      if (!activeState || activeState.listMode) return null;
      const dx = clientX - activeState.cx;
      const dy = clientY - activeState.cy;
      const scale = activeState.scale || 1;
      const dist = Math.hypot(dx, dy) / scale;
      if (dist <= R_INNER) return 'hub';
      if (dist > R_OUTER + R_CANCEL_MARGIN) return 'cancel';
      if (dist > R_OUTER + 6) return null;
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;
      const step = 360 / activeState.sectorCount;
      const shifted = (deg + step / 2) % 360;
      const idx = Math.floor(shifted / step);
      return idx >= 0 && idx < activeState.sectorCount ? idx : null;
    }

    function updateHoverVisual(hit) {
      if (!activeState || !backdropEl) return;
      activeState.hoverHit = hit;
      const sectors = backdropEl.querySelectorAll('.aw-wheel-sector');
      sectors.forEach((s, i) => {
        if (hit === i && activeState.pageItems[i]) s.setAttribute('data-active', '1');
        else s.removeAttribute('data-active');
      });
      const hub = backdropEl.querySelector('.aw-wheel-hub');
      if (hub) {
        if (hit === 'hub') hub.setAttribute('data-active', '1');
        else hub.removeAttribute('data-active');
      }
      const cancelBanner = backdropEl.querySelector('.aw-wheel-cancel-banner');
      if (cancelBanner) {
        if (hit === 'cancel') cancelBanner.setAttribute('data-visible', '1');
        else cancelBanner.removeAttribute('data-visible');
      }
    }

    function onPointerMove(ev) {
      if (!activeState || activeState.listMode) return;
      const aimEl = backdropEl?.querySelector('.aw-wheel-aim');
      if (aimEl) {
        const dx = ev.clientX - activeState.cx;
        const dy = ev.clientY - activeState.cy;
        const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        aimEl.style.transform = `rotate(${deg.toFixed(1)}deg)`;
        aimEl.setAttribute('data-visible', Math.hypot(dx, dy) > 20 ? '1' : '0');
      }
      const hit = hitTestPointer(ev.clientX, ev.clientY);
      updateHoverVisual(hit);
    }

    function onPointerUp(ev) {
      if (!activeState || !activeState.holdMode || activeState.listMode) return;
      if (activeState.holdButton !== undefined && ev.button !== activeState.holdButton) return;
      const hit = hitTestPointer(ev.clientX, ev.clientY);
      if (hit === 'cancel' || hit === null) {
        close();
        return;
      }
      if (hit === 'hub') {
        selectIndex('hub');
        return;
      }
      if (typeof hit === 'number' && activeState.pageItems[hit]) {
        selectIndex(hit);
      } else {
        close();
      }
    }

    function onKeyDown(ev) {
      if (!activeState) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      } else if (ev.key === '0') {
        ev.preventDefault();
        selectIndex('hub');
      } else if (/^[1-8]$/.test(ev.key)) {
        const idx = Number(ev.key) - 1;
        if (activeState.pageItems[idx]) {
          ev.preventDefault();
          selectIndex(idx);
        }
      }
    }

    function renderContent() {
      if (!activeState || !backdropEl) return;
      backdropEl.innerHTML = '';

      const st = activeState;
      const children = Array.isArray(st.group.children) ? [...st.group.children] : [];
      // Sort most recently accessed first so top sectors hold freshest files
      children.sort((a, b) => Number(Boolean(b.locked)) - Number(Boolean(a.locked)) || (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0));

      const maxSectors = Math.min(8, Math.max(4, Number(st.sectors || 8)));
      const sectorCount = st.listMode ? maxSectors : Math.min(maxSectors, Math.max(4, children.length <= 4 ? 4 : children.length <= 6 ? 6 : 8));
      const totalPages = Math.max(1, Math.ceil(children.length / sectorCount));
      st.page = Math.max(0, Math.min(totalPages - 1, st.page));
      st.sectorCount = sectorCount;
      st.pageItems = children.slice(st.page * sectorCount, (st.page + 1) * sectorCount);

      if (st.listMode) {
        const card = markNode(doc.createElement('div'));
        card.className = 'aw-wheel-list-card';
        card.addEventListener('click', (e) => e.stopPropagation());
        card.addEventListener('mousedown', (e) => e.stopPropagation());
        const vw = doc.defaultView?.innerWidth || 1200;
        const vh = doc.defaultView?.innerHeight || 800;
        const left = Math.max(12, Math.min(vw - 332, st.cx - 160));
        const top = Math.max(12, Math.min(vh - 380, st.cy - 40));
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;

        const hubTagText = st.hubTag || '母页';
        const head = doc.createElement('div');
        head.className = 'aw-popover-head';
        head.innerHTML = `<span class="aw-popover-title">${hubTagText} · ${baseDisplayName(st.group.anchorTitle)}</span>`;
        if (st.isLiveFallback && st.onPinCurrent) {
          const pinCurBtn = markNode(doc.createElement('button'));
          pinCurBtn.className = 'aw-tray-btn';
          pinCurBtn.textContent = '设为母页';
          pinCurBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
            st.onPinCurrent?.();
          });
          head.appendChild(pinCurBtn);
        }
        const switchBtn = markNode(doc.createElement('button'));
        switchBtn.className = 'aw-tray-btn';
        switchBtn.textContent = '切回轮盘';
        switchBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          st.listMode = false;
          renderContent();
        });
        head.appendChild(switchBtn);
        card.appendChild(head);

        const body = doc.createElement('div');
        body.className = 'aw-popover-body';

        const hubRow = markNode(doc.createElement('button'));
        hubRow.className = 'aw-link-row';
        hubRow.innerHTML = `<div class="aw-link-row-top"><span class="aw-link-row-title">${ICONS.anchor} ${baseDisplayName(st.group.anchorTitle)}</span><span class="aw-link-row-badge">${hubTagText}</span></div>`;
        hubRow.addEventListener('click', () => selectIndex('hub'));
        body.appendChild(hubRow);

        for (const ch of children) {
          const row = markNode(doc.createElement('div'));
          row.className = 'aw-link-row';
          row.style.cursor = 'pointer';
          const top = doc.createElement('div');
          top.className = 'aw-link-row-top';
          const titleBtn = markNode(doc.createElement('button'));
          titleBtn.className = 'aw-link-row-title';
          titleBtn.style.textAlign = 'left';
          titleBtn.style.flex = '1';
          titleBtn.innerHTML = `${pickIconForTitle(ch.title || ch.path)} ${baseDisplayName(ch.title || ch.path)}`;
          titleBtn.addEventListener('click', () => {
            close();
            st.onSelect?.(ch);
          });
          top.appendChild(titleBtn);

          if (!st.isLiveFallback && st.onToggleLock) {
            const pinBtn = markNode(doc.createElement('button'));
            pinBtn.className = 'aw-wheel-mini-btn';
            pinBtn.title = ch.locked ? '取消常驻保护' : '常驻保护（不自动清理）';
            if (ch.locked) pinBtn.setAttribute('data-locked', '1');
            pinBtn.innerHTML = ICONS.pin;
            pinBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              st.onToggleLock?.(ch);
            });
            top.appendChild(pinBtn);
          }

          if (!st.isLiveFallback && st.onRemoveChild) {
            const rmBtn = markNode(doc.createElement('button'));
            rmBtn.className = 'aw-wheel-mini-btn';
            rmBtn.title = '移出分组';
            rmBtn.innerHTML = ICONS.close;
            rmBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              st.onRemoveChild?.(ch);
            });
            top.appendChild(rmBtn);
          }

          row.appendChild(top);
          body.appendChild(row);
        }

        if (!children.length) {
          const empty = doc.createElement('div');
          empty.className = 'aw-link-row-snippet';
          empty.textContent = st.emptyHint || '当前母页下暂无子标签，左键或中键点击 MD 内链接即可收编。';
          body.appendChild(empty);
        }

        card.appendChild(body);
        backdropEl.appendChild(card);
        return;
      }

      const stage = markNode(doc.createElement('div'));
      stage.className = 'aw-wheel-stage';
      stage.addEventListener('click', (e) => e.stopPropagation());
      stage.addEventListener('mousedown', (e) => e.stopPropagation());
      stage.style.left = `${st.cx}px`;
      stage.style.top = `${st.cy}px`;
      stage.style.setProperty('--aw-wheel-scale', String(st.scale));

      const cancelBanner = markNode(doc.createElement('div'));
      cancelBanner.className = 'aw-wheel-cancel-banner';
      cancelBanner.textContent = '松手取消';
      stage.appendChild(cancelBanner);

      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 344 344');
      svg.setAttribute('class', 'aw-wheel-svg');

      const step = 360 / sectorCount;
      const labelsWrap = doc.createElement('div');
      labelsWrap.className = 'aw-wheel-labels';

      for (let i = 0; i < sectorCount; i++) {
        const a0 = i * step - step / 2;
        const a1 = a0 + step;
        const midAngle = i * step;
        const item = st.pageItems[i] || null;

        const pathEl = doc.createElementNS(SVG_NS, 'path');
        pathEl.setAttribute('d', sectorPath(CX, CY, R_INNER + 4, R_OUTER, a0, a1));
        pathEl.setAttribute('class', 'aw-wheel-sector');
        if (!item) pathEl.setAttribute('data-empty', '1');
        if (item) {
          pathEl.addEventListener('mouseenter', () => updateHoverVisual(i));
          pathEl.addEventListener('click', (e) => {
            e.stopPropagation();
            selectIndex(i);
          });
        }
        svg.appendChild(pathEl);

        if (item) {
          const [lx, ly] = polar(CX, CY, (R_INNER + R_OUTER) * 0.54, midAngle);
          const node = markNode(doc.createElement('div'));
          node.className = 'aw-wheel-node aw-stagger-in';
          node.style.setProperty('--aw-i', String(i));
          node.style.left = `${lx.toFixed(1)}px`;
          node.style.top = `${ly.toFixed(1)}px`;

          const iconSpan = doc.createElement('span');
          iconSpan.innerHTML = pickIconForTitle(item.title || item.path);
          iconSpan.style.color = item.locked ? 'var(--aw-accent)' : 'var(--aw-fg-muted)';

          const titleSpan = doc.createElement('span');
          titleSpan.className = 'aw-wheel-node-title';
          titleSpan.textContent = baseDisplayName(item.title || item.path);
          titleSpan.title = item.path;

          const idxSpan = doc.createElement('span');
          idxSpan.style.cssText = 'font-size:12px;color:var(--aw-fg-muted);opacity:0.75;line-height:1;';
          idxSpan.textContent = `${i + 1}${item.locked ? ' · 锁' : ''}`;

          node.appendChild(iconSpan);
          node.appendChild(titleSpan);
          node.appendChild(idxSpan);

          if (!st.holdMode && !st.isLiveFallback && st.onToggleLock && st.onRemoveChild) {
            const actRow = doc.createElement('div');
            actRow.className = 'aw-wheel-node-actions';

            const pinBtn = markNode(doc.createElement('button'));
            pinBtn.className = 'aw-wheel-mini-btn';
            pinBtn.title = item.locked ? '取消常驻' : '锁定常驻';
            if (item.locked) pinBtn.setAttribute('data-locked', '1');
            pinBtn.innerHTML = ICONS.pin;
            pinBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              st.onToggleLock?.(item);
            });

            const closeBtn = markNode(doc.createElement('button'));
            closeBtn.className = 'aw-wheel-mini-btn';
            closeBtn.title = '移出组';
            closeBtn.innerHTML = ICONS.close;
            closeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              st.onRemoveChild?.(item);
            });

            actRow.appendChild(pinBtn);
            actRow.appendChild(closeBtn);
            node.appendChild(actRow);
          }

          labelsWrap.appendChild(node);
        }
      }

      const hubCircle = doc.createElementNS(SVG_NS, 'circle');
      hubCircle.setAttribute('cx', String(CX));
      hubCircle.setAttribute('cy', String(CY));
      hubCircle.setAttribute('r', String(R_INNER));
      hubCircle.setAttribute('class', 'aw-wheel-hub');
      hubCircle.addEventListener('mouseenter', () => updateHoverVisual('hub'));
      hubCircle.addEventListener('click', (e) => {
        e.stopPropagation();
        selectIndex('hub');
      });
      svg.appendChild(hubCircle);

      const aimGroup = doc.createElementNS(SVG_NS, 'g');
      aimGroup.setAttribute('class', 'aw-wheel-aim');
      aimGroup.style.transformOrigin = `${CX}px ${CY}px`;
      const aimDot = doc.createElementNS(SVG_NS, 'circle');
      aimDot.setAttribute('cx', String(CX));
      aimDot.setAttribute('cy', String(CY - R_INNER));
      aimDot.setAttribute('r', '4');
      aimDot.setAttribute('class', 'aw-wheel-aim-dot');
      aimGroup.appendChild(aimDot);
      svg.appendChild(aimGroup);

      const hubLabel = markNode(doc.createElement('div'));
      hubLabel.className = 'aw-wheel-hub-label';
      const hubTagText = st.hubTag || '母页';
      hubLabel.innerHTML = `${ICONS.anchor}<span class="aw-wheel-hub-tag">${hubTagText}</span><span class="aw-wheel-hub-name">${baseDisplayName(st.group.anchorTitle)}</span>`;

      stage.appendChild(svg);
      stage.appendChild(labelsWrap);
      stage.appendChild(hubLabel);

      if (st.holdMode) {
        // Hold-release pure mode: NEVER render click-only toolbar buttons inside the wheel
        const whisper = markNode(doc.createElement('div'));
        whisper.className = 'aw-wheel-hold-hint';
        whisper.textContent = '划向目标扇区或中心松手打开 · 空白/圈外松手取消';
        stage.appendChild(whisper);
      } else {
        const toolbar = markNode(doc.createElement('div'));
        toolbar.className = 'aw-wheel-toolbar';
        toolbar.addEventListener('click', (e) => e.stopPropagation());
        toolbar.addEventListener('mousedown', (e) => e.stopPropagation());

        const countSpan = doc.createElement('span');
        countSpan.style.color = 'var(--aw-fg-muted)';
        countSpan.textContent = children.length
          ? `${children.length} 项${totalPages > 1 ? ` · ${st.page + 1}/${totalPages} 页` : ''}`
          : st.emptyHint || '点击 MD 链接即收编';
        toolbar.appendChild(countSpan);

        if (st.isLiveFallback && st.onPinCurrent) {
          const pinCurBtn = markNode(doc.createElement('button'));
          pinCurBtn.className = 'aw-wheel-toolbar-btn';
          pinCurBtn.textContent = '设为母页';
          pinCurBtn.addEventListener('click', () => {
            close();
            st.onPinCurrent?.();
          });
          toolbar.appendChild(pinCurBtn);
        }

        if (st.onShowOutlinks) {
          const outBtn = markNode(doc.createElement('button'));
          outBtn.className = 'aw-wheel-toolbar-btn';
          outBtn.textContent = '本文出链';
          outBtn.addEventListener('click', () => {
            close();
            st.onShowOutlinks?.();
          });
          toolbar.appendChild(outBtn);
        }

        if (totalPages > 1) {
          const nextBtn = markNode(doc.createElement('button'));
          nextBtn.className = 'aw-wheel-toolbar-btn';
          nextBtn.textContent = '下一页';
          nextBtn.addEventListener('click', () => {
            st.page = (st.page + 1) % totalPages;
            renderContent();
          });
          toolbar.appendChild(nextBtn);
        }

        const listBtn = markNode(doc.createElement('button'));
        listBtn.className = 'aw-wheel-toolbar-btn';
        listBtn.innerHTML = `${ICONS.list} 列表`;
        listBtn.addEventListener('click', () => {
          st.listMode = true;
          renderContent();
        });
        toolbar.appendChild(listBtn);

        stage.appendChild(toolbar);
      }
      backdropEl.appendChild(stage);
    }

    function open({
      group,
      x,
      y,
      holdMode = false,
      holdButton = 1,
      persistOnScroll = false,
      closeOnSelect = true,
      sectors = 8,
      listMode = false,
      hubTag = '母页',
      isLiveFallback = false,
      emptyHint = '',
      onSelect,
      onToggleLock,
      onRemoveChild,
      onPinCurrent,
      onShowOutlinks,
    }) {
      close();
      if (!group) return;

      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;
      const scale = Math.min(1, Math.max(0.76, (Math.min(vw, vh) - 36) / 360));
      const half = 178 * scale;
      const cx = Math.max(half + 8, Math.min(vw - half - 8, Number(x) || vw / 2));
      const cy = Math.max(half + 24, Math.min(vh - half - 36, Number(y) || vh / 2));

      backdropEl = markNode(doc.createElement('div'));
      backdropEl.className = 'aw-wheel-backdrop';
      if (persistOnScroll && !holdMode) {
        backdropEl.setAttribute('data-aw-nonmodal', '1');
      }
      if (options.theme && options.theme !== 'auto') {
        backdropEl.setAttribute('data-aw-theme', options.theme);
      }

      backdropEl.addEventListener('click', (e) => {
        if (!persistOnScroll && e.target === backdropEl) close();
      });
      backdropEl.addEventListener('auxclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      backdropEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      backdropEl.addEventListener(
        'wheel',
        (e) => {
          if (!activeState || activeState.listMode) return;
          if (persistOnScroll && !e.target?.closest?.('.aw-wheel-stage')) return;
          const total = activeState.group.children?.length || 0;
          const sc = activeState.sectorCount || 8;
          const pages = Math.max(1, Math.ceil(total / sc));
          if (pages <= 1) return;
          e.preventDefault();
          activeState.page = (activeState.page + (e.deltaY > 0 ? 1 : pages - 1)) % pages;
          renderContent();
        },
        { passive: false }
      );

      activeState = {
        group,
        cx,
        cy,
        scale,
        holdMode: Boolean(holdMode),
        holdButton,
        persistOnScroll: Boolean(persistOnScroll),
        closeOnSelect: closeOnSelect !== false,
        sectors,
        listMode: Boolean(listMode),
        hubTag,
        isLiveFallback: Boolean(isLiveFallback),
        emptyHint,
        page: 0,
        sectorCount: 8,
        pageItems: [],
        hoverHit: null,
        onSelect,
        onToggleLock,
        onRemoveChild,
        onPinCurrent,
        onShowOutlinks,
      };

      mountRoot.appendChild(backdropEl);
      renderContent();

      requestAnimationFrame(() => {
        if (backdropEl) backdropEl.setAttribute('data-open', '1');
      });

      doc.addEventListener('pointermove', onPointerMove, true);
      doc.addEventListener('pointerup', onPointerUp, true);
      doc.addEventListener('keydown', onKeyDown, true);
    }

    function updateGroup(nextGroup) {
      if (!activeState || !nextGroup) return;
      activeState.group = nextGroup;
      renderContent();
    }

    return {
      open,
      close,
      updateGroup,
      isOpen: () => Boolean(backdropEl),
    };
  }

  return { createRadialWheel, ICONS };
});
