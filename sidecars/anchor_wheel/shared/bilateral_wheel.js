// Current-Page-Centered Bilateral Category Wheel with Reverse-Glide Overflow Rail
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelBilateral = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CX = 172;
  const CY = 172;
  const R_INNER = 46;
  const R_OUTER = 142;
  const R_OUTSIDE = 176;
  const DIR_DEG = { top: 0, right: 90, bottom: 180, left: 270 };

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function normAngleDiff(a, b) {
    return ((((a - b) % 360) + 540) % 360) - 180;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function sectorPath(cx, cy, rIn, rOut, a0, a1, gap = 2.4) {
    const start = a0 + gap / 2;
    const end = a1 - gap / 2;
    if (end <= start) return '';
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

  function createBilateralWheel(options = {}) {
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
      isOwnerOpen: () => Boolean(backdropEl && backdropEl.isConnected && activeState),
    });

    let backdropEl = null;
    let activeState = null;
    let closeHoverTimer = null;

    function onWindowBlur() {
      close();
    }

    function close() {
      previewCtrl.hide();
      clearTimeout(closeHoverTimer);
      closeHoverTimer = null;
      try { doc.defaultView?.removeEventListener?.('blur', onWindowBlur); } catch {}
      if (!backdropEl) return;
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      const cb = activeState?.onClose;
      try { backdropEl.remove(); } catch {}
      backdropEl = null;
      activeState = null;
      cb?.();
    }

    function commitTarget(target) {
      if (!activeState || !target || !target.path) return;
      const st = activeState;
      const shouldClose = st.holdMode || st.closeOnSelect !== false;
      previewCtrl.hide();
      clearTimeout(closeHoverTimer);
      closeHoverTimer = null;
      if (shouldClose) {
        try { doc.defaultView?.removeEventListener?.('blur', onWindowBlur); } catch {}
        backdropEl && doc.removeEventListener('pointermove', onPointerMove, true);
        backdropEl && doc.removeEventListener('pointerup', onPointerUp, true);
        backdropEl && doc.removeEventListener('keydown', onKeyDown, true);
        try { backdropEl?.remove(); } catch {}
        backdropEl = null;
        activeState = null;
      }
      st.onSelect?.(target);
    }

    function updateRailTransform(railEl, viewportEl, trackEl, dir, offsetPx) {
      if (!trackEl || !viewportEl) return;
      const overflow = Math.max(0, trackEl.scrollWidth - viewportEl.clientWidth);
      const clamped = clamp(offsetPx, 0, overflow);
      if (activeState) activeState.railOffsetPx = clamped;
      const shift = dir === 'left' ? clamped : -clamped;
      trackEl.style.transform = `translate3d(${shift.toFixed(1)}px, 0, 0)`;
    }

    function openRailForCategory(catIdx, anchorPillEl) {
      if (!activeState || !backdropEl) return;
      const st = activeState;
      const cat = st.categories[catIdx];
      if (!cat || !cat.items || cat.items.length <= 3) return;
      if (st.railCatIdx === catIdx && backdropEl.querySelector('.aw-bi-rail')) return;

      previewCtrl.hide();
      backdropEl.querySelector('.aw-bi-rail')?.remove();
      st.railCatIdx = catIdx;
      st.railOffsetPx = 0;

      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;
      const anchorRect = anchorPillEl.getBoundingClientRect();
      const railW = Math.min(310, vw - 24);
      const isNarrow = vw <= 520;
      const dir = isNarrow ? 'right' : st.expandDir || (vw - anchorRect.right >= Math.min(220, railW * 0.72) ? 'right' : 'left');
      st.railDir = dir;

      const rail = S.markNode(doc.createElement('div'));
      rail.className = 'aw-bi-rail';
      rail.setAttribute('data-dir', dir);
      rail.style.width = `${railW}px`;

      let left;
      let top;
      if (isNarrow) {
        left = clamp(Math.round((vw - railW) / 2), 10, vw - railW - 10);
        const spaceBelow = vh - anchorRect.bottom - 14;
        top = spaceBelow >= 50 ? anchorRect.bottom + 8 : clamp(anchorRect.top - 52, 10, vh - 58);
      } else {
        left = dir === 'right' ? anchorRect.right + 6 : anchorRect.left - railW - 6;
        left = clamp(left, 10, vw - railW - 10);
        top = clamp(anchorRect.top - 4, 10, vh - 58);
      }
      rail.style.left = `${left}px`;
      rail.style.top = `${top}px`;

      rail.innerHTML = `<div class="aw-bi-rail-viewport"><div class="aw-bi-rail-track"></div></div>`;
      const viewportEl = rail.querySelector('.aw-bi-rail-viewport');
      const trackEl = rail.querySelector('.aw-bi-rail-track');
      if (dir === 'left') {
        trackEl.setAttribute('data-dir', 'left');
      }

      cat.items.forEach((item, idx) => {
        const pill = S.markNode(doc.createElement('button'));
        pill.type = 'button';
        pill.className = 'aw-bi-rail-item';
        pill.setAttribute('data-rail-idx', String(idx));
        if (item.isOpenedTab) pill.setAttribute('data-opened', '1');
        pill.innerHTML = `${S.pickIconForItem(item)}<span>${S.esc(S.baseDisplayName(item.title || item.path))}</span>`;
        pill.addEventListener('mouseenter', () => {
          setHoveredItem(item, pill);
        });
        pill.addEventListener('mouseleave', () => {
          previewCtrl.hide();
        });
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          commitTarget(item);
        });
        trackEl.appendChild(pill);
      });

      rail.addEventListener('mouseenter', () => {
        clearTimeout(closeHoverTimer);
      });
      rail.addEventListener('mouseleave', () => {
        if (!st.holdMode) scheduleSubmenuCollapse();
      });
      rail.addEventListener(
        'wheel',
        (e) => {
          if (st.holdMode) return;
          e.preventDefault();
          e.stopPropagation();
          updateRailTransform(rail, viewportEl, trackEl, dir, (st.railOffsetPx || 0) + (e.deltaY > 0 ? 54 : -54));
        },
        { passive: false }
      );

      backdropEl.appendChild(rail);
    }

    function openSubFan(catIdx) {
      if (!activeState || !backdropEl) return;
      const st = activeState;
      const cat = st.categories[catIdx];
      if (!cat || !cat.items || !cat.items.length) {
        collapseSubFan();
        return;
      }
      if (st.activeCatIdx === catIdx && backdropEl.querySelector('.aw-bi-sublist')) return;

      collapseSubFan();
      st.activeCatIdx = catIdx;

      const stage = backdropEl.querySelector('.aw-bi-stage');
      if (!stage) return;

      const midDeg = st.catAngles[catIdx];
      const [ux, uy] = polar(0, 0, 1, midDeg);
      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;

      // On narrow side-panes, dock sub-list cleanly above or below wheel so sectors stay unobstructed
      const isNarrow = vw <= 520;
      const listW = isNarrow ? Math.min(264, vw - 24) : Math.min(204, vw - 24);
      const estH = Math.min(cat.items.length, 4) * 35 + 14;
      const stageAnchorX = st.cx + ux * (R_OUTER + 12) * st.scale;
      const stageAnchorY = st.cy + uy * (R_OUTER + 12) * st.scale;
      const roomRight = vw - stageAnchorX;
      const roomLeft = stageAnchorX;
      const dir = (ux >= -0.15 && roomRight >= 210) || roomRight > roomLeft + 70 ? 'right' : 'left';
      st.expandDir = dir;

      const sublist = S.markNode(doc.createElement('div'));
      sublist.className = 'aw-bi-sublist';
      sublist.setAttribute('data-dir', dir);

      let left;
      let top;
      if (isNarrow) {
        left = clamp(Math.round((vw - listW) / 2), 10, vw - listW - 10);
        const wheelTop = st.cy - R_OUTER * st.scale;
        const wheelBottom = st.cy + R_OUTER * st.scale;
        const spaceAbove = wheelTop - 16;
        const spaceBelow = vh - wheelBottom - 16;
        if (spaceBelow >= estH || spaceBelow >= spaceAbove) {
          top = clamp(wheelBottom + 10, 10, vh - estH - 10);
        } else {
          top = clamp(wheelTop - estH - 10, 10, vh - estH - 10);
        }
      } else {
        left = dir === 'right' ? stageAnchorX + 4 : stageAnchorX - listW - 4;
        left = clamp(left, 10, vw - listW - 10);
        top = clamp(stageAnchorY - estH / 2, 10, vh - estH - 12);
      }
      sublist.style.width = `${listW}px`;
      sublist.style.left = `${left}px`;
      sublist.style.top = `${top}px`;

      const directItems = cat.items.slice(0, 3);
      directItems.forEach((item, idx) => {
        const pill = S.markNode(doc.createElement('button'));
        pill.type = 'button';
        pill.className = 'aw-bi-subpill';
        pill.setAttribute('data-sub-idx', String(idx));
        if (item.isOpenedTab) pill.setAttribute('data-opened', '1');
        pill.innerHTML = `${S.pickIconForItem(item)}<span class="aw-bi-subpill-name">${S.esc(S.baseDisplayName(item.title || item.path))}</span>${item.isOpenedTab ? '<span class="aw-bi-dot" title="已打开标签"></span>' : ''}`;
        pill.addEventListener('mouseenter', () => {
          clearTimeout(closeHoverTimer);
          setHoveredItem(item, pill);
        });
        pill.addEventListener('mouseleave', () => {
          previewCtrl.hide();
        });
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          commitTarget(item);
        });
        sublist.appendChild(pill);
      });

      if (cat.items.length > 3) {
        const more = S.markNode(doc.createElement('button'));
        more.type = 'button';
        more.className = 'aw-bi-more-pill';
        more.innerHTML = `<span>展开其余 ${cat.items.length - 3} 项</span>${S.ICONS.chevronRight}`;
        more.addEventListener('mouseenter', () => {
          clearTimeout(closeHoverTimer);
          openRailForCategory(catIdx, more);
        });
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          openRailForCategory(catIdx, more);
        });
        sublist.appendChild(more);
      }

      sublist.addEventListener('mouseenter', () => clearTimeout(closeHoverTimer));
      sublist.addEventListener('mouseleave', () => {
        if (!st.holdMode) scheduleSubmenuCollapse();
      });

      backdropEl.appendChild(sublist);
    }

    function collapseSubFan() {
      if (!backdropEl || !activeState) return;
      previewCtrl.hide();
      activeState.activeCatIdx = -1;
      activeState.railCatIdx = -1;
      activeState.hoverCommitItem = null;
      backdropEl.querySelector('.aw-bi-sublist')?.remove();
      backdropEl.querySelector('.aw-bi-rail')?.remove();
    }

    function scheduleSubmenuCollapse() {
      clearTimeout(closeHoverTimer);
      closeHoverTimer = setTimeout(() => {
        collapseSubFan();
        updateSectorHighlight(null);
      }, 280);
    }

    function setHoveredItem(item, el) {
      if (!activeState) return;
      activeState.hoverCommitItem = item;
      for (const n of backdropEl?.querySelectorAll('.aw-bi-subpill[data-active="1"], .aw-bi-rail-item[data-active="1"]') || []) {
        n.removeAttribute('data-active');
      }
      if (el) {
        el.setAttribute('data-active', '1');
        const placement = el.classList?.contains?.('aw-bi-rail-item') ? 'below' : 'side';
        previewCtrl.scheduleShow(item, el.getBoundingClientRect(), placement);
      }
    }

    function updateSectorHighlight(hitType, catIdx = -1) {
      if (!backdropEl) return;
      const parentArc = backdropEl.querySelector('.aw-bi-parent-arc');
      if (parentArc) {
        if (hitType === 'parent') parentArc.setAttribute('data-active', '1');
        else parentArc.removeAttribute('data-active');
      }
      const center = backdropEl.querySelector('.aw-bi-center');
      if (center) {
        if (hitType === 'center') center.setAttribute('data-active', '1');
        else center.removeAttribute('data-active');
      }
      backdropEl.querySelectorAll('.aw-bi-cat-arc').forEach((arc, i) => {
        if ((hitType === 'cat' && i === catIdx) || i === activeState?.activeCatIdx) arc.setAttribute('data-active', '1');
        else arc.removeAttribute('data-active');
      });
      const cancelBanner = backdropEl.querySelector('.aw-wheel-cancel-banner');
      if (cancelBanner) {
        if (hitType === 'cancel') cancelBanner.setAttribute('data-visible', '1');
        else cancelBanner.removeAttribute('data-visible');
      }
    }

    function onPointerMove(ev) {
      if (!activeState || !backdropEl) return;
      const st = activeState;
      if (st.holdMode && st.holdButton === 1 && ev.isTrusted && typeof ev.buttons === 'number' && (ev.buttons & 4) === 0) {
        close();
        return;
      }
      const targetEl = doc.elementFromPoint(ev.clientX, ev.clientY);

      // Update magnetic aim ring on hub rim toward pointer angle
      const aimEl = backdropEl.querySelector('.aw-wheel-aim');
      if (aimEl) {
        const dx0 = ev.clientX - st.cx;
        const dy0 = ev.clientY - st.cy;
        const aimDeg = (Math.atan2(dy0, dx0) * 180) / Math.PI + 90;
        aimEl.style.transform = `rotate(${aimDeg.toFixed(1)}deg)`;
        aimEl.setAttribute('data-visible', Math.hypot(dx0, dy0) > 20 ? '1' : '0');
      }

      // 1. Check horizontal reverse-glide rail first
      const rail = backdropEl.querySelector('.aw-bi-rail');
      if (rail) {
        const railRect = rail.getBoundingClientRect();
        const inRailZone =
          ev.clientX >= railRect.left - 8 &&
          ev.clientX <= railRect.right + 8 &&
          ev.clientY >= railRect.top - 10 &&
          ev.clientY <= railRect.bottom + 10;
        if (inRailZone) {
          clearTimeout(closeHoverTimer);
          const viewportEl = rail.querySelector('.aw-bi-rail-viewport');
          const trackEl = rail.querySelector('.aw-bi-rail-track');
          if (st.holdMode && viewportEl && trackEl) {
            const u =
              st.railDir === 'left'
                ? clamp((railRect.right - ev.clientX) / Math.max(1, railRect.width), 0, 1)
                : clamp((ev.clientX - railRect.left) / Math.max(1, railRect.width), 0, 1);
            const overflow = Math.max(0, trackEl.scrollWidth - viewportEl.clientWidth);
            updateRailTransform(rail, viewportEl, trackEl, st.railDir, u * overflow);
          }
          // Find pill directly under cursor X (and closest Y)
          let pickedEl = null;
          let bestDist = Infinity;
          for (const itemEl of rail.querySelectorAll('.aw-bi-rail-item')) {
            const r = itemEl.getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right) {
              pickedEl = itemEl;
              break;
            }
            const cxDist = Math.abs(ev.clientX - (r.left + r.right) / 2);
            if (cxDist < bestDist) {
              bestDist = cxDist;
              pickedEl = itemEl;
            }
          }
          const idx = pickedEl ? Number(pickedEl.getAttribute('data-rail-idx')) : -1;
          const cat = st.categories[st.railCatIdx];
          if (cat && cat.items[idx]) {
            setHoveredItem(cat.items[idx], pickedEl);
          }
          updateSectorHighlight('sub', st.railCatIdx);
          return;
        }
      }

      // 2. Check sub-fan direct pills or '+N 更多' trigger
      const subPill = targetEl?.closest?.('.aw-bi-subpill');
      if (subPill && backdropEl.contains(subPill)) {
        clearTimeout(closeHoverTimer);
        const cat = st.categories[st.activeCatIdx];
        const idx = Number(subPill.getAttribute('data-sub-idx'));
        if (cat && cat.items[idx]) {
          setHoveredItem(cat.items[idx], subPill);
        }
        updateSectorHighlight('sub', st.activeCatIdx);
        return;
      }
      const morePill = targetEl?.closest?.('.aw-bi-more-pill');
      if (morePill && backdropEl.contains(morePill)) {
        clearTimeout(closeHoverTimer);
        previewCtrl.hide();
        st.hoverCommitItem = null;
        openRailForCategory(st.activeCatIdx, morePill);
        updateSectorHighlight('sub', st.activeCatIdx);
        return;
      }
      if (targetEl?.closest?.('.aw-bi-sublist')) {
        clearTimeout(closeHoverTimer);
        return;
      }

      // 3. Polar hit-testing against main wheel geometry
      st.hoverCommitItem = null;
      const dx = ev.clientX - st.cx;
      const dy = ev.clientY - st.cy;
      const dist = Math.hypot(dx, dy) / (st.scale || 1);

      if (dist <= R_INNER) {
        previewCtrl.hide();
        updateSectorHighlight('center');
        return;
      }
      if (dist > R_OUTSIDE) {
        previewCtrl.hide();
        updateSectorHighlight('cancel');
        if (st.activeCatIdx !== -1 && st.holdMode) {
          scheduleSubmenuCollapse();
        }
        return;
      }

      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;

      if (Math.abs(normAngleDiff(deg, st.parentCenterDeg)) <= 78) {
        if (st.activeCatIdx !== -1 || st.railCatIdx !== -1) {
          collapseSubFan();
        }
        if (st.parent?.path) {
          st.hoverCommitItem = { path: st.parent.path, title: st.parent.title, isParent: true };
          updateSectorHighlight('parent');
          const parentArc = backdropEl.querySelector('.aw-bi-parent-arc');
          if (parentArc) previewCtrl.scheduleShow(st.parent, parentArc.getBoundingClientRect());
        } else {
          previewCtrl.hide();
          updateSectorHighlight('cancel');
        }
        return;
      }

      previewCtrl.hide();
      const halfSpan = st.catStep / 2;
      let hitCat = -1;
      for (let i = 0; i < st.categories.length; i++) {
        if (Math.abs(normAngleDiff(deg, st.catAngles[i])) <= halfSpan) {
          hitCat = i;
          break;
        }
      }
      if (hitCat !== -1 && st.categories[hitCat]?.items?.length) {
        clearTimeout(closeHoverTimer);
        openSubFan(hitCat);
        updateSectorHighlight('cat', hitCat);
      } else {
        updateSectorHighlight('cancel');
      }
    }

    function onPointerUp(ev) {
      if (!activeState || !activeState.holdMode) return;
      if (activeState.holdButton !== undefined && ev.button !== activeState.holdButton) return;
      if (activeState.hoverCommitItem && activeState.hoverCommitItem.path) {
        commitTarget(activeState.hoverCommitItem);
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
      }
    }

    function renderWheel() {
      if (!activeState || !backdropEl) return;
      backdropEl.innerHTML = '';
      const st = activeState;
      const ctx = st.context || {};
      const cats = Array.isArray(ctx.categories) && ctx.categories.length ? ctx.categories : [];
      st.categories = cats;
      st.parent = ctx.parent || null;
      st.parentCenterDeg = DIR_DEG[st.parentDirection || ctx.parentDirection || 'left'] ?? 270;
      st.childCenterDeg = (st.parentCenterDeg + 180) % 360;
      const count = Math.max(1, cats.length);
      const catSpan = count >= 7 ? 168 : 164;
      st.catStep = catSpan / count;
      st.catAngles = cats.map((_, i) => st.childCenterDeg - catSpan / 2 + st.catStep * (i + 0.5));
      const density = count >= 7 ? 'dense' : count >= 5 ? 'compact' : 'normal';
      const sectorGap = count >= 7 ? 1.4 : count >= 5 ? 1.8 : 2.2;

      const stage = S.markNode(doc.createElement('div'));
      stage.className = 'aw-bi-stage';
      stage.setAttribute('data-density', density);
      stage.style.left = `${st.cx}px`;
      stage.style.top = `${st.cy}px`;
      stage.style.setProperty('--aw-wheel-scale', String(st.scale));
      stage.addEventListener('click', (e) => e.stopPropagation());
      stage.addEventListener('mousedown', (e) => e.stopPropagation());

      const cancelBanner = S.markNode(doc.createElement('div'));
      cancelBanner.className = 'aw-wheel-cancel-banner';
      cancelBanner.textContent = st.holdMode ? '空白/圈外松手取消' : '点击母页或分类展开子项';
      stage.appendChild(cancelBanner);

      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 344 344');
      svg.setAttribute('class', 'aw-wheel-svg');

      // Parent half-arc
      const parentArc = doc.createElementNS(SVG_NS, 'path');
      parentArc.setAttribute('d', sectorPath(CX, CY, R_INNER + 6, R_OUTER, st.parentCenterDeg - 78, st.parentCenterDeg + 78, 2));
      parentArc.setAttribute('class', 'aw-wheel-sector aw-bi-parent-arc');
      if (!st.parent?.path) parentArc.setAttribute('data-empty', '1');
      if (st.parent?.path) {
        parentArc.addEventListener('click', (e) => {
          e.stopPropagation();
          commitTarget({ path: st.parent.path, title: st.parent.title, isParent: true });
        });
      }
      svg.appendChild(parentArc);

      // Category half sectors
      const labelsWrap = doc.createElement('div');
      labelsWrap.className = 'aw-wheel-labels';

      const [px, py] = polar(CX, CY, (R_INNER + R_OUTER) * 0.56, st.parentCenterDeg);
      const pNode = S.markNode(doc.createElement('div'));
      pNode.className = 'aw-wheel-node';
      pNode.style.left = `${px.toFixed(1)}px`;
      pNode.style.top = `${py.toFixed(1)}px`;
      pNode.innerHTML = st.parent?.path
        ? `${S.ICONS.parentUp}<span class="aw-wheel-node-title">${S.esc(S.baseDisplayName(st.parent.title || st.parent.path))}</span><span class="aw-wheel-node-meta">母页</span>`
        : `${S.ICONS.parentUp}<span class="aw-wheel-node-meta">暂无母页</span>`;
      labelsWrap.appendChild(pNode);

      cats.forEach((cat, i) => {
        const a0 = st.childCenterDeg - catSpan / 2 + i * st.catStep;
        const a1 = a0 + st.catStep;
        const pathEl = doc.createElementNS(SVG_NS, 'path');
        pathEl.setAttribute('d', sectorPath(CX, CY, R_INNER + 6, R_OUTER, a0, a1, sectorGap));
        pathEl.setAttribute('class', 'aw-wheel-sector aw-bi-cat-arc');
        const nItems = cat.items?.length || 0;
        if (!nItems) pathEl.setAttribute('data-empty', '1');
        if (nItems) {
          pathEl.addEventListener('mouseenter', () => {
            clearTimeout(closeHoverTimer);
            openSubFan(i);
            updateSectorHighlight('cat', i);
          });
        }
        svg.appendChild(pathEl);

        // Adaptive radial placement prevents collisions even with 8 custom categories + '其他' (9 sectors)
        const labelRadius =
          density === 'dense'
            ? R_INNER + 6 + (R_OUTER - R_INNER - 6) * (i % 2 === 0 ? 0.36 : 0.72)
            : density === 'compact'
            ? (R_INNER + R_OUTER) * 0.58
            : (R_INNER + R_OUTER) * 0.56;
        const [lx, ly] = polar(CX, CY, labelRadius, st.catAngles[i]);
        const cNode = S.markNode(doc.createElement('div'));
        cNode.className = 'aw-wheel-node aw-stagger-in';
        cNode.setAttribute('data-density', density);
        cNode.style.setProperty('--aw-i', String(i));
        cNode.style.left = `${lx.toFixed(1)}px`;
        cNode.style.top = `${ly.toFixed(1)}px`;
        cNode.style.opacity = nItems ? '1' : '0.45';
        if (density === 'dense') {
          cNode.innerHTML = `<span class="aw-wheel-node-inline"><span class="aw-wheel-node-title">${S.esc(String(cat.label || '').slice(0, 3))}</span><span class="aw-wheel-node-meta">${nItems}</span></span>`;
        } else if (density === 'compact') {
          cNode.innerHTML = `${S.pickIconForCategory(cat)}<span class="aw-wheel-node-inline"><span class="aw-wheel-node-title">${S.esc(cat.label)}</span><span class="aw-wheel-node-meta">${nItems}</span></span>`;
        } else {
          cNode.innerHTML = `${S.pickIconForCategory(cat)}<span class="aw-wheel-node-title">${S.esc(cat.label)}</span><span class="aw-wheel-node-meta">${nItems}</span>`;
        }
        labelsWrap.appendChild(cNode);
      });

      // Center circle: ALWAYS current page
      const centerCircle = doc.createElementNS(SVG_NS, 'circle');
      centerCircle.setAttribute('cx', String(CX));
      centerCircle.setAttribute('cy', String(CY));
      centerCircle.setAttribute('r', String(R_INNER));
      centerCircle.setAttribute('class', 'aw-wheel-hub aw-bi-center');
      svg.appendChild(centerCircle);

      // Magnetic aim indicator rotating on center ring rim
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

      const centerLabel = S.markNode(doc.createElement('div'));
      centerLabel.className = 'aw-wheel-hub-label';
      const curTitle = ctx.current?.title ? S.baseDisplayName(ctx.current.title) : '未打开';
      const totalCh = Number(ctx.totalCurrentChildren || 0);
      centerLabel.innerHTML = `${S.ICONS.currentDot}<span class="aw-wheel-hub-tag">当前页</span><span class="aw-wheel-hub-name" title="${S.esc(curTitle)}">${S.esc(curTitle)}</span>`;

      stage.appendChild(svg);
      stage.appendChild(labelsWrap);
      stage.appendChild(centerLabel);

      if (totalCh === 0) {
        const emptySub = S.markNode(doc.createElement('div'));
        emptySub.className = 'aw-wheel-hold-hint';
        emptySub.style.top = 'calc(100% + 4px)';
        emptySub.textContent = st.holdMode ? '当前页暂无子页 · 划向母页可返回' : '当前页暂无子页';
        stage.appendChild(emptySub);
      }

      if (!st.holdMode) {
        const bar = S.markNode(doc.createElement('div'));
        bar.className = 'aw-wheel-toolbar';
        bar.addEventListener('click', (e) => e.stopPropagation());
        const scope = st.scope || ctx.childSourceScope || 'opened_and_outlinks';
        bar.innerHTML = `
          <div class="aw-tray" style="padding:1px">
            <button type="button" class="aw-tray-btn" data-aw-bi-scope="opened_and_outlinks" data-active="${scope !== 'opened_only' ? '1' : '0'}">全部出链</button>
            <button type="button" class="aw-tray-btn" data-aw-bi-scope="opened_only" data-active="${scope === 'opened_only' ? '1' : '0'}">仅已开</button>
          </div>
          <button type="button" class="aw-wheel-toolbar-btn" data-aw-bi-close="1">关闭</button>
        `;
        bar.querySelectorAll('[data-aw-bi-scope]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const nextScope = btn.getAttribute('data-aw-bi-scope');
            st.scope = nextScope;
            st.onSwitchScope?.(nextScope);
          });
        });
        bar.querySelector('[data-aw-bi-close]')?.addEventListener('click', close);
        stage.appendChild(bar);
      }

      backdropEl.appendChild(stage);
    }

    function open({
      context,
      x,
      y,
      holdMode = false,
      holdButton = 1,
      persistOnScroll = false,
      closeOnSelect = false,
      parentDirection = 'left',
      scope = 'opened_and_outlinks',
      onSelect,
      onSwitchScope,
      onClose,
    }) {
      close();
      if (!context || !context.current) return;

      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;
      const scale = Math.min(1, Math.max(0.76, (Math.min(vw, vh) - 36) / 360));
      const half = 176 * scale;
      const cx = clamp(Number(x) || vw / 2, half + 8, vw - half - 8);
      const cy = clamp(Number(y) || vh / 2, half + 24, vh - half - 36);

      backdropEl = S.markNode(doc.createElement('div'));
      backdropEl.className = 'aw-wheel-backdrop';
      if (persistOnScroll && !holdMode) {
        backdropEl.setAttribute('data-aw-nonmodal', '1');
      }
      const resolvedTheme = options.getTheme ? options.getTheme() : options.theme;
      if (resolvedTheme && resolvedTheme !== 'auto') {
        backdropEl.setAttribute('data-aw-theme', resolvedTheme);
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

      activeState = {
        context,
        cx,
        cy,
        scale,
        holdMode: Boolean(holdMode),
        holdButton,
        persistOnScroll: Boolean(persistOnScroll),
        closeOnSelect: Boolean(closeOnSelect),
        parentDirection,
        scope,
        activeCatIdx: -1,
        railCatIdx: -1,
        railDir: 'right',
        railOffsetPx: 0,
        hoverCommitItem: null,
        categories: [],
        catAngles: [],
        catStep: 40,
        parent: null,
        onSelect,
        onSwitchScope,
        onClose,
      };

      mountRoot.appendChild(backdropEl);
      renderWheel();

      requestAnimationFrame(() => {
        if (backdropEl) backdropEl.setAttribute('data-open', '1');
      });

      doc.addEventListener('pointermove', onPointerMove, true);
      doc.addEventListener('pointerup', onPointerUp, true);
      doc.addEventListener('keydown', onKeyDown, true);
      try { doc.defaultView?.addEventListener?.('blur', onWindowBlur); } catch {}
    }

    function updateContext(nextContext) {
      if (!activeState || !nextContext || !nextContext.current) return;
      previewCtrl.hide();
      activeState.context = nextContext;
      activeState.activeCatIdx = -1;
      activeState.railCatIdx = -1;
      renderWheel();
    }

    return {
      open,
      close,
      updateContext,
      isOpen: () => Boolean(backdropEl),
    };
  }

  return { createBilateralWheel };
});
