// Main-Chat 5-Direction Window Layout Wheel (Left/Right Sidebar + Overview Panel)
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CX = 172;
  const CY = 172;
  const R_INNER = 46;
  const R_OUTER = 144;
  const R_OUTSIDE = 178;

  // Monoline 1.75px icons with translucent filled target-pane block for instant left/right recognition at 15px
  const LAYOUT_ICONS = Object.freeze({
    hub: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="5" height="15" rx="1.2" fill="currentColor" fill-opacity="0.18" stroke="none"/><rect x="15.5" y="4.5" width="5" height="15" rx="1.2" fill="currentColor" fill-opacity="0.18" stroke="none"/><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="8.5" y1="4" x2="8.5" y2="20"/><line x1="15.5" y1="4" x2="15.5" y2="20"/></svg>',
    collapseLeft: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="5.5" height="15" rx="1.2" fill="currentColor" fill-opacity="0.28" stroke="none"/><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><polyline points="16 9 12.5 12 16 15"/></svg>',
    expandLeft: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="5.5" height="15" rx="1.2" fill="currentColor" fill-opacity="0.28" stroke="none"/><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><polyline points="13 9 16.5 12 13 15"/></svg>',
    expandRight: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="15" y="4.5" width="5.5" height="15" rx="1.2" fill="currentColor" fill-opacity="0.28" stroke="none"/><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/><polyline points="11 9 7.5 12 11 15"/></svg>',
    collapseRight: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="15" y="4.5" width="5.5" height="15" rx="1.2" fill="currentColor" fill-opacity="0.28" stroke="none"/><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/><polyline points="8 9 11.5 12 8 15"/></svg>',
    overview: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12.5" y="6.8" width="6.2" height="10.4" rx="1.3" fill="currentColor" fill-opacity="0.28" stroke="currentColor" stroke-width="1.4"/><line x1="6" y1="9.2" x2="9.6" y2="9.2"/><line x1="6" y1="13" x2="9.6" y2="13"/></svg>',
    empty: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="7" y1="12" x2="17" y2="12"/></svg>',
  });

  const DEFAULT_LAYOUT_SLOTS = Object.freeze({
    top_left: 'collapse_left',
    mid_left: 'expand_right',
    bottom_left: 'toggle_overview',
    top_right: 'expand_left',
    bottom_right: 'collapse_right',
  });

  const LAYOUT_ACTION_CATALOG = Object.freeze({
    collapse_left: Object.freeze({ id: 'collapse_left', label: '收起左栏', icon: LAYOUT_ICONS.collapseLeft }),
    expand_left: Object.freeze({ id: 'expand_left', label: '展开左栏', icon: LAYOUT_ICONS.expandLeft }),
    toggle_left: Object.freeze({ id: 'toggle_left', label: '切换左栏', icon: LAYOUT_ICONS.expandLeft }),
    expand_right: Object.freeze({ id: 'expand_right', label: '展开右栏', icon: LAYOUT_ICONS.expandRight }),
    collapse_right: Object.freeze({ id: 'collapse_right', label: '收起右栏', icon: LAYOUT_ICONS.collapseRight }),
    toggle_right: Object.freeze({ id: 'toggle_right', label: '切换右栏', icon: LAYOUT_ICONS.expandRight }),
    toggle_overview: Object.freeze({ id: 'toggle_overview', label: '概览面板', icon: LAYOUT_ICONS.overview }),
    none: Object.freeze({ id: 'none', label: '留空', icon: LAYOUT_ICONS.empty }),
  });

  // Gapless 360-deg 5-slot geometry (0 deg = 12 o'clock, clockwise):
  // Visual separation is handled purely by sectorPath(gap); zero dead-zones on ring.
  // Right half (2 x 90 deg): Top-Right, Bottom-Right
  // Left half (3 x 60 deg): Bottom-Left, Mid-Left, Top-Left
  const LAYOUT_SLOTS = Object.freeze([
    Object.freeze({ slot: 'top_right', a0: 0, a1: 90, mid: 45, dirLabel: '右上', defaultAction: 'expand_left' }),
    Object.freeze({ slot: 'bottom_right', a0: 90, a1: 180, mid: 135, dirLabel: '右下', defaultAction: 'collapse_right' }),
    Object.freeze({ slot: 'bottom_left', a0: 180, a1: 240, mid: 210, dirLabel: '左下', defaultAction: 'toggle_overview' }),
    Object.freeze({ slot: 'mid_left', a0: 240, a1: 300, mid: 270, dirLabel: '左中', defaultAction: 'expand_right' }),
    Object.freeze({ slot: 'top_left', a0: 300, a1: 360, mid: 330, dirLabel: '左上', defaultAction: 'collapse_left' }),
  ]);

  function resolveLayoutSectors(slotConfig = DEFAULT_LAYOUT_SLOTS) {
    const cfg = slotConfig && typeof slotConfig === 'object' ? slotConfig : DEFAULT_LAYOUT_SLOTS;
    return LAYOUT_SLOTS.map((sl) => {
      const rawAction = cfg[sl.slot];
      const actionId = Object.prototype.hasOwnProperty.call(LAYOUT_ACTION_CATALOG, rawAction)
        ? rawAction
        : sl.defaultAction;
      const spec = LAYOUT_ACTION_CATALOG[actionId] || LAYOUT_ACTION_CATALOG[sl.defaultAction];
      return {
        slot: sl.slot,
        id: spec.id,
        actionId: spec.id,
        a0: sl.a0,
        a1: sl.a1,
        mid: sl.mid,
        dirLabel: sl.dirLabel,
        icon: spec.icon,
        label: spec.label,
      };
    });
  }

  const LAYOUT_SECTORS = Object.freeze(resolveLayoutSectors(DEFAULT_LAYOUT_SLOTS).map((s) => Object.freeze(s)));

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function sectorPath(cx, cy, rIn, rOut, a0, a1, gap = 2.6) {
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

  function hitTestLayoutSlot(deg, sectors = LAYOUT_SECTORS) {
    const raw = Number(deg);
    if (!Number.isFinite(raw)) return null;
    const norm = ((raw % 360) + 360) % 360;
    const list = Array.isArray(sectors) && sectors.length ? sectors : LAYOUT_SECTORS;
    for (const s of list) {
      if (norm >= s.a0 && norm < s.a1) return s.slot;
    }
    return list[0]?.slot || null;
  }

  function hitTestLayoutAngle(deg, sectors = LAYOUT_SECTORS) {
    const raw = Number(deg);
    if (!Number.isFinite(raw)) return null;
    const norm = ((raw % 360) + 360) % 360;
    const list = Array.isArray(sectors) && sectors.length ? sectors : LAYOUT_SECTORS;
    for (const s of list) {
      if (norm >= s.a0 && norm < s.a1) return s.id;
    }
    return list[0]?.id || null;
  }

  function buildSectorRuntimeMeta(sector, layoutState = {}) {
    const leftOpen = Boolean(layoutState.leftOpen);
    const rightOpen = Boolean(layoutState.rightOpen);
    const overviewOpen = Boolean(layoutState.overviewOpen);
    const canOverview = layoutState.canOverview !== false;
    const actionId = sector.actionId || sector.id;

    if (actionId === 'none') {
      return {
        ...sector,
        actionId: 'none',
        icon: LAYOUT_ICONS.empty,
        title: '留空',
        meta: '无操作',
        disabled: true,
        redundant: false,
      };
    }
    if (actionId === 'collapse_left') {
      return {
        ...sector,
        actionId,
        icon: LAYOUT_ICONS.collapseLeft,
        title: '收起左栏',
        meta: leftOpen ? '左侧边栏' : '已收起',
        disabled: false,
        redundant: !leftOpen,
      };
    }
    if (actionId === 'expand_left') {
      return {
        ...sector,
        actionId,
        icon: LAYOUT_ICONS.expandLeft,
        title: '展开左栏',
        meta: leftOpen ? '已展开' : '左侧边栏',
        disabled: false,
        redundant: leftOpen,
      };
    }
    if (actionId === 'toggle_left') {
      return {
        ...sector,
        actionId,
        icon: leftOpen ? LAYOUT_ICONS.collapseLeft : LAYOUT_ICONS.expandLeft,
        title: leftOpen ? '收起左栏' : '展开左栏',
        meta: leftOpen ? '已展开' : '左侧边栏',
        disabled: false,
        redundant: false,
        activeDot: leftOpen,
      };
    }
    if (actionId === 'expand_right') {
      return {
        ...sector,
        actionId,
        icon: LAYOUT_ICONS.expandRight,
        title: '展开右栏',
        meta: overviewOpen ? '并关概览' : rightOpen ? '已展开' : '右侧边栏',
        disabled: false,
        redundant: rightOpen && !overviewOpen,
      };
    }
    if (actionId === 'collapse_right') {
      return {
        ...sector,
        actionId,
        icon: LAYOUT_ICONS.collapseRight,
        title: '收起右栏',
        meta: overviewOpen ? (rightOpen ? '并关概览' : '收起概览') : rightOpen ? '右侧边栏' : '已收起',
        disabled: false,
        redundant: !rightOpen && !overviewOpen,
      };
    }
    if (actionId === 'toggle_right') {
      const anyRightOpen = rightOpen || overviewOpen;
      return {
        ...sector,
        actionId,
        icon: anyRightOpen ? LAYOUT_ICONS.collapseRight : LAYOUT_ICONS.expandRight,
        title: anyRightOpen ? '收起右栏' : '展开右栏',
        meta: overviewOpen ? (rightOpen ? '并关概览' : '收起概览') : rightOpen ? '已展开' : '右侧边栏',
        disabled: false,
        redundant: false,
        activeDot: anyRightOpen,
      };
    }
    return {
      ...sector,
      actionId: 'toggle_overview',
      icon: LAYOUT_ICONS.overview,
      title: overviewOpen ? '收起概览' : '展开概览',
      meta: !canOverview ? '仅会话页' : overviewOpen ? '已展开' : '概览面板',
      disabled: !canOverview,
      redundant: false,
      activeDot: overviewOpen && canOverview,
    };
  }

  function createLayoutWheel(options = {}) {
    const doc = options.document || document;
    const mountRoot = options.mountRoot || doc.body;
    const S = Shared || globalThis.AnchorWheelNavShared;

    const markNode = (el) => {
      if (S?.markNode) return S.markNode(el);
      if (!el) return el;
      el.setAttribute('data-aw-owned', '1');
      el.setAttribute('data-omni-ignore', '1');
      el.setAttribute('data-prism-ignore', '1');
      return el;
    };

    let backdropEl = null;
    let activeState = null;

    function onWindowBlur() {
      close();
    }

    function close() {
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

    function commitSlot(slot) {
      if (!activeState || !slot) {
        close();
        return;
      }
      const meta = activeState.sectorMetaBySlot[slot];
      if (!meta || meta.disabled || !meta.actionId || meta.actionId === 'none') {
        close();
        return;
      }
      const st = activeState;
      close();
      st.onAction?.(meta.actionId, slot);
    }

    function hitTestPointer(clientX, clientY, { isCommit = false } = {}) {
      if (!activeState) return null;
      const st = activeState;
      const dragFromSpawn = Math.hypot(clientX - st.spawnX, clientY - st.spawnY);
      const effectiveDrag = Math.max(st.maxDragFromSpawn || 0, dragFromSpawn);
      if (st.clamped && effectiveDrag < 10) {
        return isCommit ? 'cancel' : 'center';
      }

      const scale = st.scale || 1;
      const dx = clientX - st.cx;
      const dy = clientY - st.cy;
      const dist = Math.hypot(dx, dy) / scale;
      if (dist <= R_INNER) return 'center';

      let exemptOutside = false;
      if (dist > R_OUTSIDE && st.clamped) {
        const EDGE = 12;
        const clampedLeft = st.cx > st.spawnX + 6;
        const clampedRight = st.cx < st.spawnX - 6;
        const clampedTop = st.cy > st.spawnY + 6;
        const clampedBottom = st.cy < st.spawnY - 6;
        const pinnedWall =
          (clampedLeft && clientX <= EDGE && dx < 0 && Math.abs(dy) / scale <= R_OUTSIDE) ||
          (clampedRight && clientX >= st.vw - EDGE && dx > 0 && Math.abs(dy) / scale <= R_OUTSIDE) ||
          (clampedTop && clientY <= EDGE && dy < 0 && Math.abs(dx) / scale <= R_OUTSIDE) ||
          (clampedBottom && clientY >= st.vh - EDGE && dy > 0 && Math.abs(dx) / scale <= R_OUTSIDE);
        const onClampedBand =
          dragFromSpawn <= R_OUTSIDE * scale &&
          dist <= R_OUTSIDE + 64 &&
          ((clampedLeft && dx < 0 && clientX <= st.spawnX + 12) ||
            (clampedRight && dx > 0 && clientX >= st.spawnX - 12) ||
            (clampedTop && dy < 0 && clientY <= st.spawnY + 12) ||
            (clampedBottom && dy > 0 && clientY >= st.spawnY - 12));
        exemptOutside = pinnedWall || onClampedBand;
      }

      if (dist > R_OUTSIDE && !exemptOutside) return 'cancel';
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;
      const hitSlot = hitTestLayoutSlot(deg, st.sectors);
      if (!hitSlot) return 'cancel';
      const meta = st.sectorMetaBySlot[hitSlot];
      return meta && !meta.disabled && meta.actionId !== 'none' ? hitSlot : 'cancel';
    }

    function updateVisual(hitSlot) {
      if (!activeState || !backdropEl) return;
      activeState.hoverHit = hitSlot;
      backdropEl.querySelectorAll('.aw-layout-sector').forEach((el) => {
        const slot = el.getAttribute('data-layout-slot');
        if (slot && slot === hitSlot) el.setAttribute('data-active', '1');
        else el.removeAttribute('data-active');
      });
      backdropEl.querySelectorAll('.aw-layout-node').forEach((el) => {
        const slot = el.getAttribute('data-layout-slot');
        if (slot && slot === hitSlot) el.setAttribute('data-active', '1');
        else el.removeAttribute('data-active');
      });
      const hub = backdropEl.querySelector('.aw-layout-hub');
      if (hub) {
        if (hitSlot === 'center') hub.setAttribute('data-active', '1');
        else hub.removeAttribute('data-active');
      }
      const cancelBanner = backdropEl.querySelector('.aw-wheel-cancel-banner');
      if (cancelBanner) {
        if (hitSlot === 'cancel') cancelBanner.setAttribute('data-visible', '1');
        else cancelBanner.removeAttribute('data-visible');
      }
    }

    function onPointerMove(ev) {
      if (!activeState || !backdropEl) return;
      const st = activeState;
      const holdMask = S?.buttonToButtonsMask ? S.buttonToButtonsMask(st.holdButton) : 0;
      if (st.holdMode && holdMask && ev.isTrusted && typeof ev.buttons === 'number' && (ev.buttons & holdMask) === 0) {
        close();
        return;
      }
      const dragFromSpawn = Math.hypot(ev.clientX - st.spawnX, ev.clientY - st.spawnY);
      if (dragFromSpawn > st.maxDragFromSpawn) st.maxDragFromSpawn = dragFromSpawn;
      const aimEl = backdropEl.querySelector('.aw-wheel-aim');
      if (aimEl) {
        if (st.clamped && st.maxDragFromSpawn < 10) {
          aimEl.setAttribute('data-visible', '0');
        } else {
          const dx = ev.clientX - st.cx;
          const dy = ev.clientY - st.cy;
          const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
          aimEl.style.transform = `rotate(${deg.toFixed(1)}deg)`;
          aimEl.setAttribute('data-visible', Math.hypot(dx, dy) > 20 ? '1' : '0');
        }
      }
      updateVisual(hitTestPointer(ev.clientX, ev.clientY));
    }

    function onPointerUp(ev) {
      if (!activeState || !activeState.holdMode) return;
      if (activeState.holdButton !== undefined && ev.button !== activeState.holdButton) return;
      ev.preventDefault();
      const hit = hitTestPointer(ev.clientX, ev.clientY, { isCommit: true });
      if (!hit || hit === 'center' || hit === 'cancel') {
        close();
        return;
      }
      commitSlot(hit);
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
      const ls = st.layoutState || {};

      const stage = markNode(doc.createElement('div'));
      stage.className = 'aw-bi-stage aw-layout-stage';
      stage.style.left = `${st.cx}px`;
      stage.style.top = `${st.cy}px`;
      stage.style.setProperty('--aw-wheel-scale', String(st.scale));
      stage.addEventListener('click', (e) => e.stopPropagation());
      stage.addEventListener('mousedown', (e) => e.stopPropagation());

      const cancelBanner = markNode(doc.createElement('div'));
      cancelBanner.className = 'aw-wheel-cancel-banner';
      cancelBanner.textContent = '圆心/圈外松手取消';
      stage.appendChild(cancelBanner);

      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 344 344');
      svg.setAttribute('class', 'aw-wheel-svg');

      const labelsWrap = doc.createElement('div');
      labelsWrap.className = 'aw-wheel-labels';

      st.sectorMetaBySlot = {};
      st.sectors.forEach((sec, idx) => {
        const meta = buildSectorRuntimeMeta(sec, ls);
        st.sectorMetaBySlot[sec.slot] = meta;

        const pathEl = doc.createElementNS(SVG_NS, 'path');
        pathEl.setAttribute('d', sectorPath(CX, CY, R_INNER + 6, R_OUTER, sec.a0, sec.a1, 2.6));
        pathEl.setAttribute('class', 'aw-wheel-sector aw-layout-sector');
        pathEl.setAttribute('data-layout-slot', sec.slot);
        pathEl.setAttribute('data-layout-action', meta.actionId);
        if (meta.disabled) pathEl.setAttribute('data-empty', '1');
        if (meta.redundant) pathEl.setAttribute('data-redundant', '1');
        if (!meta.disabled) {
          pathEl.addEventListener('mouseenter', () => updateVisual(sec.slot));
          pathEl.addEventListener('click', (e) => {
            e.stopPropagation();
            commitSlot(sec.slot);
          });
        }
        svg.appendChild(pathEl);

        const labelRadius = (R_INNER + R_OUTER) * 0.56;
        const [lx, ly] = polar(CX, CY, labelRadius, sec.mid);
        const node = markNode(doc.createElement('div'));
        node.className = 'aw-wheel-node aw-layout-node aw-stagger-in';
        node.setAttribute('data-layout-slot', sec.slot);
        node.setAttribute('data-layout-action', meta.actionId);
        node.style.setProperty('--aw-i', String(idx));
        node.style.left = `${lx.toFixed(1)}px`;
        node.style.top = `${ly.toFixed(1)}px`;
        if (meta.disabled) node.setAttribute('data-disabled', '1');
        else if (meta.redundant) node.setAttribute('data-redundant', '1');
        node.innerHTML = `${meta.icon}<span class="aw-wheel-node-title">${S?.esc ? S.esc(meta.title) : meta.title}${meta.activeDot ? ' <span class="aw-bi-dot" style="display:inline-block;vertical-align:middle"></span>' : ''}</span><span class="aw-wheel-node-meta">${S?.esc ? S.esc(meta.meta) : meta.meta}</span>`;
        labelsWrap.appendChild(node);
      });

      const centerCircle = doc.createElementNS(SVG_NS, 'circle');
      centerCircle.setAttribute('cx', String(CX));
      centerCircle.setAttribute('cy', String(CY));
      centerCircle.setAttribute('r', String(R_INNER));
      centerCircle.setAttribute('class', 'aw-wheel-hub aw-layout-hub');
      svg.appendChild(centerCircle);

      // Subtle dashed inner distinction ring so layout wheel is visually distinct from doc wheel
      const innerRing = doc.createElementNS(SVG_NS, 'circle');
      innerRing.setAttribute('cx', String(CX));
      innerRing.setAttribute('cy', String(CY));
      innerRing.setAttribute('r', String(R_INNER - 5));
      innerRing.setAttribute('class', 'aw-layout-hub-ring');
      svg.appendChild(innerRing);

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

      const statusText = `${ls.leftOpen ? '左开' : '左收'} · ${ls.overviewOpen ? '概览' : ls.rightOpen ? '右开' : '右收'}`;
      const centerLabel = markNode(doc.createElement('div'));
      centerLabel.className = 'aw-wheel-hub-label';
      centerLabel.innerHTML = `${LAYOUT_ICONS.hub}<span class="aw-wheel-hub-tag">窗口布局</span><span class="aw-wheel-hub-name">${statusText}</span>`;

      const hint = markNode(doc.createElement('div'));
      hint.className = 'aw-wheel-hold-hint';
      hint.style.top = 'calc(100% + 4px)';
      hint.textContent = '划向目标松手切换 · 圆心/圈外松手取消';

      stage.appendChild(svg);
      stage.appendChild(labelsWrap);
      stage.appendChild(centerLabel);
      stage.appendChild(hint);
      backdropEl.appendChild(stage);
    }

    function open({
      x,
      y,
      holdMode = true,
      holdButton = 1,
      layoutState = {},
      slotConfig = DEFAULT_LAYOUT_SLOTS,
      onAction,
      onClose,
    }) {
      close();
      const vw = doc.defaultView?.innerWidth || 1200;
      const vh = doc.defaultView?.innerHeight || 800;
      const rawX = Number.isFinite(Number(x)) ? Number(x) : vw / 2;
      const rawY = Number.isFinite(Number(y)) ? Number(y) : vh / 2;
      const scale = Math.min(1, Math.max(0.78, (Math.min(vw, vh) - 36) / 360));
      const half = 178 * scale;
      const cx = clamp(rawX, half + 8, vw - half - 8);
      const cy = clamp(rawY, half + 24, vh - half - 36);
      const clamped = Math.hypot(cx - rawX, cy - rawY) > 6;

      backdropEl = markNode(doc.createElement('div'));
      backdropEl.className = 'aw-wheel-backdrop';
      const resolvedTheme = options.getTheme ? options.getTheme() : options.theme;
      if (resolvedTheme && resolvedTheme !== 'auto') {
        backdropEl.setAttribute('data-aw-theme', resolvedTheme);
      }

      backdropEl.addEventListener('click', (e) => {
        if (e.target === backdropEl) close();
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
        cx,
        cy,
        vw,
        vh,
        spawnX: rawX,
        spawnY: rawY,
        clamped,
        maxDragFromSpawn: 0,
        scale,
        holdMode: Boolean(holdMode),
        holdButton,
        layoutState: { ...layoutState },
        sectors: resolveLayoutSectors(slotConfig),
        sectorMetaBySlot: {},
        hoverHit: null,
        onAction,
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

    return {
      open,
      close,
      isOpen: () => Boolean(backdropEl),
    };
  }

  return {
    DEFAULT_LAYOUT_SLOTS,
    LAYOUT_SLOTS,
    LAYOUT_SECTORS,
    resolveLayoutSectors,
    hitTestLayoutSlot,
    hitTestLayoutAngle,
    buildSectorRuntimeMeta,
    createLayoutWheel,
  };
});
