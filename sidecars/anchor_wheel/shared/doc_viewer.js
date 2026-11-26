// Shared Native-Aligned Document & Media Viewer UI
// Supports Word (.docx/.doc/.odt/.rtf/.epub/.eml), Spreadsheets & SQLite (.xlsx/.xls/.ods/.sqlite/.csv/.tsv/.jsonl),
// 2D Visual Presentations (.pptx/.ppsx/.potx/.ppt/.odp + optional 1:1 local Office HiRes),
// Jupyter Notebooks (.ipynb), Interactive 3D Meshes (.glb/.stl/.obj), Font Specimens (.ttf/.otf/.woff/.woff2),
// Subtitle Timelines (.srt/.ass/.vtt/.lrc), Archives (.zip/.tar.gz/.7z/.rar), and PDF (.pdf).
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
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    hires:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    copy:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    external:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    code:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    wire:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    reset:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    up:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    down:
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    close:
      '<svg class="aw-icon" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  });

  const COMPOUND_ARCHIVE_RE = /\.(?:tar\.gz|tar\.xz|tar\.bz2|tar\.zst)$/i;
  const AUTO_BINARY_EXT_RE =
    /\.(?:docx|docm|dotx|doc|xlsx|xlsm|xltx|xls|pptx|ppsx|potx|ppt|odt|ods|odp|rtf|epub|sqlite|sqlite3|db|zip|tar|tgz|7z|rar|glb|ttf|otf|woff|woff2|pdf)$/i;
  const PREFER_WHEN_RAW_EXT_RE = /\.(?:ipynb|eml|stl|obj)$/i;
  const OPTIONAL_TABLE_EXT_RE = /\.(?:csv|tsv|jsonl|ndjson|srt|ass|ssa|vtt|lrc)$/i;

  function classifyDocPathClient(filePath) {
    const p = String(filePath || '').trim().replace(/[\\/]+$/, '');
    if (!p) return null;
    if (COMPOUND_ARCHIVE_RE.test(p)) {
      const m = COMPOUND_ARCHIVE_RE.exec(p);
      const badge = m[0].slice(1).toUpperCase();
      return {
        ext: badge.toLowerCase(),
        badge,
        autoRender: true,
        preferWhenRawCode: false,
        optionalTable: false,
        isBinaryDoc: true,
      };
    }
    const dot = p.lastIndexOf('.');
    if (dot === -1) return null;
    const ext = p.slice(dot + 1).toLowerCase();
    if (AUTO_BINARY_EXT_RE.test(p)) {
      return {
        ext,
        badge: ext.toUpperCase(),
        autoRender: true,
        preferWhenRawCode: false,
        optionalTable: false,
        isBinaryDoc: ext !== 'rtf',
      };
    }
    if (PREFER_WHEN_RAW_EXT_RE.test(p)) {
      return {
        ext,
        badge: ext.toUpperCase(),
        autoRender: true,
        preferWhenRawCode: true,
        optionalTable: false,
        isBinaryDoc: ext === 'stl',
      };
    }
    if (OPTIONAL_TABLE_EXT_RE.test(p)) {
      const isSubtitle = /^(?:srt|ass|ssa|vtt|lrc)$/.test(ext);
      return {
        ext,
        badge: ext.toUpperCase(),
        autoRender: false,
        preferWhenRawCode: false,
        optionalTable: true,
        pillLabel: isSubtitle ? '时间轴表' : '表格预览',
        isBinaryDoc: false,
      };
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
      if (pTag === 'SCRIPT' || pTag === 'STYLE' || pTag === 'MARK' || pTag === 'SVG' || cur.parentElement?.closest?.('svg')) {
        continue;
      }
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

  function base64ToBlobUrl(doc, b64, mime) {
    const win = doc.defaultView || window;
    if (!b64 || !win?.atob || !win?.URL?.createObjectURL) return '';
    try {
      const bin = win.atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new win.Blob([bytes], { type: mime });
      return win.URL.createObjectURL(blob);
    } catch {
      return '';
    }
  }

  // ── Zero-WebGL 60fps Studio Clay 3D Mesh Canvas ────────────────────────────
  function mountInteractive3dCanvas(hostEl, meshData, doc) {
    if (!hostEl || !meshData?.positions?.length || !meshData?.indices?.length) {
      hostEl.innerHTML = '<p class="aw-doc-empty-msg">三维网格为空。</p>';
      return { destroy() {}, resetView() {}, toggleWireframe() { return false; } };
    }
    const win = doc.defaultView || window;
    const wrap = mark(doc.createElement('div'));
    wrap.className = 'aw-3d-stage';
    const canvas = doc.createElement('canvas');
    canvas.className = 'aw-3d-canvas';
    const hud = doc.createElement('div');
    hud.className = 'aw-3d-hud';
    const bbox = meshData.bbox || [0, 0, 0];
    hud.textContent = `左键拖拽旋转 · 滚轮缩放 · 尺寸 ${bbox[0]} × ${bbox[1]} × ${bbox[2]}`;
    wrap.append(canvas, hud);
    hostEl.innerHTML = '';
    hostEl.appendChild(wrap);

    const pos = meshData.positions;
    const idx = meshData.indices;
    const vCount = Math.floor(pos.length / 3);
    const tCount = Math.floor(idx.length / 3);
    const projX = new Float32Array(vCount);
    const projY = new Float32Array(vCount);
    const projZ = new Float32Array(vCount);
    const triOrder = new Int32Array(tCount);
    const triDepth = new Float32Array(tCount);

    // Precompute face normals
    const faceNormals = new Float32Array(tCount * 3);
    for (let t = 0; t < tCount; t++) {
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const c = idx[t * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      faceNormals[t * 3] = nx / len;
      faceNormals[t * 3 + 1] = ny / len;
      faceNormals[t * 3 + 2] = nz / len;
    }

    let yaw = 0.62;
    let pitch = 0.38;
    let zoom = 1.0;
    let wireframe = false;
    let rafId = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const scheduleDraw = () => {
      if (rafId) return;
      rafId = (win.requestAnimationFrame || setTimeout)(() => {
        rafId = 0;
        draw();
      }, 16);
    };

    const draw = () => {
      if (!canvas.isConnected) return;
      const rect = wrap.getBoundingClientRect();
      const cssW = Math.max(240, Math.floor(rect.width || 560));
      const cssH = Math.max(240, Math.floor(rect.height || 420));
      const dpr = Math.min(2, win.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);

      const cs = win.getComputedStyle(wrap);
      const fgSample = cs.color || '#e2e8f0';
      const mRgb = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(fgSample);
      const isDarkUi = mRgb ? (Number(mRgb[1]) * 0.299 + Number(mRgb[2]) * 0.587 + Number(mRgb[3]) * 0.114) > 140 : true;

      // Subtle reference ground grid
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const scale = Math.min(cssW, cssH) * 0.36 * zoom;
      const halfW = cssW / 2;
      const halfH = cssH * 0.52;
      const camDist = 4.2;

      const projectPt = (x, y, z) => {
        const rx = x * cy + z * sy;
        const rz1 = -x * sy + z * cy;
        const ry = y * cp - rz1 * sp;
        const rz = y * sp + rz1 * cp;
        const persp = camDist / Math.max(0.6, camDist - rz);
        return { sx: halfW + rx * scale * persp, sy: halfH - ry * scale * persp, rz };
      };

      ctx.strokeStyle = isDarkUi ? 'rgba(148,163,184,0.14)' : 'rgba(71,85,105,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let g = -1; g <= 1; g += 0.5) {
        const p1 = projectPt(g, -1, -1);
        const p2 = projectPt(g, -1, 1);
        ctx.moveTo(p1.sx, p1.sy);
        ctx.lineTo(p2.sx, p2.sy);
        const q1 = projectPt(-1, -1, g);
        const q2 = projectPt(1, -1, g);
        ctx.moveTo(q1.sx, q1.sy);
        ctx.lineTo(q2.sx, q2.sy);
      }
      ctx.stroke();

      for (let v = 0; v < vCount; v++) {
        const p = projectPt(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        projX[v] = p.sx;
        projY[v] = p.sy;
        projZ[v] = p.rz;
      }

      for (let t = 0; t < tCount; t++) {
        triOrder[t] = t;
        const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
        triDepth[t] = (projZ[i0] + projZ[i1] + projZ[i2]) / 3;
      }
      // Painter's back-to-front sort
      const sorted = Array.from(triOrder).sort((a, b) => triDepth[a] - triDepth[b]);

      const lx = 0.45, ly = 0.72, lz = 0.53;
      ctx.lineJoin = 'round';
      for (let k = 0; k < sorted.length; k++) {
        const t = sorted[k];
        const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
        const x0 = projX[i0], y0 = projY[i0];
        const x1 = projX[i1], y1 = projY[i1];
        const x2 = projX[i2], y2 = projY[i2];

        // Rotate normal into view space for studio two-point lighting
        const nx = faceNormals[t * 3], ny = faceNormals[t * 3 + 1], nz = faceNormals[t * 3 + 2];
        const rnx = nx * cy + nz * sy;
        const rnz1 = -nx * sy + nz * cy;
        const rny = ny * cp - rnz1 * sp;
        const rnz = ny * sp + rnz1 * cp;
        const keyDiff = Math.max(0, Math.abs(rnx * lx + rny * ly + rnz * lz));
        const rim = Math.pow(1 - Math.min(1, Math.abs(rnz)), 2) * 0.16;
        const shade = Math.min(1, (isDarkUi ? 0.24 : 0.38) + keyDiff * 0.62 + rim);
        const lum = Math.round(shade * (isDarkUi ? 232 : 215));

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.closePath();

        if (!wireframe) {
          ctx.fillStyle = isDarkUi ? `rgb(${lum},${lum + 4},${Math.min(255, lum + 10)})` : `rgb(${lum},${lum - 2},${lum - 5})`;
          ctx.fill();
          ctx.strokeStyle = isDarkUi ? `rgb(${lum},${lum + 4},${Math.min(255, lum + 10)})` : `rgb(${lum},${lum - 2},${lum - 5})`;
          ctx.lineWidth = 0.55;
          ctx.stroke();
        } else {
          ctx.strokeStyle = isDarkUi ? 'rgba(148, 197, 255, 0.68)' : 'rgba(37, 99, 235, 0.62)';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      yaw += dx * 0.011;
      pitch = Math.max(-1.48, Math.min(1.48, pitch + dy * 0.011));
      scheduleDraw();
    });
    const endDrag = () => { dragging = false; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', () => {
      yaw = 0.62; pitch = 0.38; zoom = 1.0;
      scheduleDraw();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.max(0.35, Math.min(4.2, zoom * (e.deltaY < 0 ? 1.12 : 0.89)));
      scheduleDraw();
    }, { passive: false });

    let ro = null;
    if (win.ResizeObserver) {
      ro = new win.ResizeObserver(() => scheduleDraw());
      ro.observe(wrap);
    }
    scheduleDraw();

    return {
      resetView() {
        yaw = 0.62; pitch = 0.38; zoom = 1.0;
        scheduleDraw();
      },
      toggleWireframe() {
        wireframe = !wireframe;
        scheduleDraw();
        return wireframe;
      },
      destroy() {
        if (rafId && win.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
        ro?.disconnect?.();
      },
    };
  }

  // ── Font Specimen Waterfall (`format === 'font'`) ──────────────────────────
  function mountFontSpecimenView(hostEl, fontData, doc) {
    if (!hostEl || !fontData?.dataUrl) {
      hostEl.innerHTML = '<p class="aw-doc-empty-msg">无法预览该字体样张。</p>';
      return { destroy() {} };
    }
    const fontId = `AWFont_${Math.random().toString(36).slice(2, 9)}`;
    const styleEl = doc.createElement('style');
    styleEl.textContent = `@font-face { font-family: "${fontId}"; src: url("${fontData.dataUrl}"); font-display: block; }`;
    (doc.head || hostEl).appendChild(styleEl);

    const defaultSample = '天地玄黄 宇宙洪荒 日月盈昃 · The quick brown fox jumps over 0123456789';
    const sizes = [14, 18, 24, 36, 52];

    hostEl.innerHTML = `
      <div class="aw-font-specimen">
        <div class="aw-font-input-row">
          <input type="text" class="aw-input aw-font-sample-input" value="${esc(defaultSample)}" placeholder="输入任意中英文与数字实时预览字形..." />
        </div>
        <div class="aw-font-waterfall">
          ${sizes
            .map(
              (sz) => `
            <div class="aw-font-row">
              <span class="aw-font-size-tag">${sz}px</span>
              <div class="aw-font-line" style="font-family:'${fontId}',sans-serif;font-size:${sz}px">${esc(defaultSample)}</div>
            </div>`
            )
            .join('')}
        </div>
      </div>
    `;

    const inputEl = hostEl.querySelector('.aw-font-sample-input');
    inputEl?.addEventListener('input', (e) => {
      const txt = e.currentTarget.value || defaultSample;
      for (const ln of hostEl.querySelectorAll('.aw-font-line')) {
        ln.textContent = txt;
      }
    });

    return {
      destroy() {
        try { styleEl.remove(); } catch {}
      },
    };
  }

  /**
   * Mounts a complete native-aligned document viewer into `mountEl`.
   * Returns `{ destroy(), getScrollEl(), setPaperMode() }`.
   */
  function mountDocumentViewer(mountEl, docData, opts = {}) {
    if (!mountEl || !docData) return { destroy() {}, getScrollEl: () => null };
    const doc = mountEl.ownerDocument || document;
    const win = doc.defaultView || window;
    const format = String(docData.format || '');
    const isSpreadsheet = format === 'xlsx' || format === 'ods' || format === 'sqlite';
    const isCsvLike = format === 'csv' || format === 'tsv' || format === 'jsonl';
    const isPresentation = format === 'pptx' || format === 'odp' || format === 'ppt';
    const isEpub = format === 'epub';
    const isPdf = format === 'pdf';
    const isModel3d = format === 'model3d';
    const isFont = format === 'font';
    const hasSections = Array.isArray(docData.sections) && docData.sections.length > 0;
    const outline = Array.isArray(docData.outline) ? docData.outline : [];
    const warnings = Array.isArray(docData.warnings) ? docData.warnings : [];
    const supportsPaper = Boolean(docData.supportsPaperMode);
    const supportsHiRes = Boolean(docData.supportsLocalHiRes && typeof opts.onRequestHiRes === 'function');
    const compactChrome = Boolean(opts.compactChrome);

    let paperMode = supportsPaper && Boolean(opts.paperMode);
    let hiresActive = false;
    let hiresLoading = false;
    let hiresCache = null;
    let activeSectionIdx = 0;
    let outlineOpen = false;
    let findOpen = false;
    let findHits = [];
    let findIdx = -1;
    let sheetFilterText = '';
    const ownedBlobUrls = [];
    let meshController = null;
    let fontController = null;

    mountEl.innerHTML = '';

    const shell = mark(doc.createElement('div'));
    shell.className = 'aw-doc-viewer';
    shell.setAttribute('data-aw-doc-format', format);
    shell.setAttribute('data-aw-paper', paperMode ? '1' : '0');

    const statsLabel = esc(docData.meta?.statsLabel || '');
    const titleStr = esc(docData.title || '');
    const canOutline = outline.length > 0 && !isSpreadsheet && !isEpub;
    const canCopy = Boolean(docData.plainText) && !isModel3d && !isFont && !isPdf;
    const canFind = !isPdf && !isModel3d && !isFont;

    // Official Antigravity Chrome: flat hairline bar, zero colored pills, inline sheet tabs when applicable
    const leftMetaHtml = isSpreadsheet && hasSections
      ? `<div class="aw-doc-sheet-tabs" role="tablist">
          ${docData.sections
            .map(
              (sec, idx) =>
                `<button type="button" role="tab" class="aw-doc-sheet-tab" data-aw-sec-idx="${idx}" data-active="${idx === 0 ? '1' : '0'}">${esc(sec.title)}</button>`
            )
            .join('')}
        </div>`
      : isEpub && hasSections
      ? `<div class="aw-doc-epub-nav">
          <button type="button" class="aw-doc-act-btn" data-aw-epub-step="-1">上一章</button>
          <select class="aw-select aw-doc-epub-select">
            ${docData.sections.map((sec, idx) => `<option value="${idx}">${esc(sec.title)}</option>`).join('')}
          </select>
          <button type="button" class="aw-doc-act-btn" data-aw-epub-step="1">下一章</button>
        </div>`
      : compactChrome
      ? `<span class="aw-doc-quiet-meta">${statsLabel || esc(docData.formatLabel || '')}</span>`
      : `<span class="aw-doc-quiet-title" title="${esc(docData.path || titleStr)}">${titleStr}</span>${
          statsLabel ? `<span class="aw-doc-quiet-meta">· ${statsLabel}</span>` : ''
        }`;

    shell.innerHTML = `
      <div class="aw-doc-toolbar">
        <div class="aw-doc-toolbar-left">${leftMetaHtml}</div>
        <div class="aw-doc-toolbar-actions">
          ${
            isSpreadsheet || isCsvLike
              ? `<input type="text" class="aw-input aw-doc-sheet-filter" placeholder="筛选行..." />`
              : ''
          }
          ${canOutline ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="outline" title="展开或收起目录">${VIEWER_ICONS.outline}<span class="aw-doc-btn-txt">${isPresentation ? '页面' : '目录'}</span></button>` : ''}
          ${canFind ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="find" title="页内查找">${VIEWER_ICONS.search}<span class="aw-doc-btn-txt">查找</span></button>` : ''}
          ${supportsPaper ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="paper" data-active="${paperMode ? '1' : '0'}" title="切换平铺底色或 A4 白纸外观">${VIEWER_ICONS.paper}<span class="aw-doc-btn-txt">纸面</span></button>` : ''}
          ${supportsHiRes ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="hires" data-active="0" title="调用本机演示引擎在后台无窗生成 1:1 幻灯片画面">${VIEWER_ICONS.hires}<span class="aw-doc-btn-txt">本机精绘</span></button>` : ''}
          ${isModel3d ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="wire" data-active="0" title="切换实体光影或网格线框">${VIEWER_ICONS.wire}<span class="aw-doc-btn-txt">线框</span></button><button type="button" class="aw-doc-act-btn" data-aw-doc-act="reset3d" title="重置相机视角">${VIEWER_ICONS.reset}<span class="aw-doc-btn-txt">归位</span></button>` : ''}
          ${canCopy ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="copy" title="复制纯文本内容">${VIEWER_ICONS.copy}<span class="aw-doc-btn-txt">复制</span></button>` : ''}
          ${opts.onOpenExternal ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="external" title="使用系统默认应用打开">${VIEWER_ICONS.external}<span class="aw-doc-btn-txt">打开</span></button>` : ''}
          ${opts.onSwitchToRaw ? `<button type="button" class="aw-doc-act-btn" data-aw-doc-act="raw" title="${esc(opts.rawLabel || '切换至原生视图')}">${VIEWER_ICONS.code}<span class="aw-doc-btn-txt">${esc(opts.rawLabel || '原生视图')}</span></button>` : ''}
        </div>
      </div>

      <div class="aw-doc-findbar" hidden>
        <input type="text" class="aw-input aw-doc-find-input" placeholder="在当前文档中查找..." />
        <span class="aw-doc-find-count">0 / 0</span>
        <div class="aw-doc-find-btns">
          <button type="button" class="aw-doc-act-btn" data-aw-find-nav="prev" title="上一处 (Shift+Enter)">${VIEWER_ICONS.up}</button>
          <button type="button" class="aw-doc-act-btn" data-aw-find-nav="next" title="下一处 (Enter)">${VIEWER_ICONS.down}</button>
          <button type="button" class="aw-doc-act-btn" data-aw-find-nav="close" title="关闭查找 (Esc)">${VIEWER_ICONS.close}</button>
        </div>
      </div>

      <div class="aw-doc-workspace">
        ${
          canOutline
            ? `<aside class="aw-doc-outline" hidden>
                <div class="aw-doc-outline-head">
                  <span>${isPresentation ? '幻灯片导航' : '目录'} (${outline.length})</span>
                  <button type="button" class="aw-doc-act-btn" data-aw-outline-close="1">${VIEWER_ICONS.close}</button>
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
          ${
            warnings.length
              ? `<footer class="aw-doc-footnote-hint">${warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</footer>`
              : ''
          }
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

    function resolvePdfFrameSrc() {
      if (docData.pdfBase64) {
        const blobUrl = base64ToBlobUrl(doc, docData.pdfBase64, 'application/pdf');
        if (blobUrl) {
          ownedBlobUrls.push(blobUrl);
          return blobUrl;
        }
      }
      return opts.pdfRawUrl || '';
    }

    function renderActiveBody() {
      if (!canvasEl) return;
      meshController?.destroy?.();
      meshController = null;
      fontController?.destroy?.();
      fontController = null;

      if (isPdf) {
        const pdfUrl = resolvePdfFrameSrc();
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-pdf';
        canvasEl.innerHTML = pdfUrl
          ? `<iframe class="aw-doc-pdf-frame" src="${esc(pdfUrl)}" title="${titleStr}"></iframe>`
          : '<p class="aw-doc-empty-msg">当前 PDF 体积较大，请点击右上角「打开」在系统阅读器中查看。</p>';
        return;
      }

      if (isModel3d) {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-3d';
        meshController = mountInteractive3dCanvas(canvasEl, docData.meshData, doc);
        return;
      }

      if (isFont) {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-article';
        fontController = mountFontSpecimenView(canvasEl, docData.fontData, doc);
        return;
      }

      if (isPresentation && hiresActive && hiresCache) {
        if (hiresCache.mode === 'slides' && Array.isArray(hiresCache.slides)) {
          canvasEl.className = 'aw-doc-canvas aw-doc-canvas-slides';
          const cards = hiresCache.slides
            .map(
              (sl, idx) => `
              <section class="aw-slide-frame-wrap" id="aw-slide-${idx + 1}">
                <div class="aw-slide-meta-line">
                  <span class="aw-slide-idx">${String(idx + 1).padStart(2, '0')} / ${String(hiresCache.slides.length).padStart(2, '0')}</span>
                  <span class="aw-slide-caption">${esc(outline[idx]?.title?.replace(/^\d+\.\s*/, '') || `第 ${idx + 1} 页`)}</span>
                </div>
                <div class="aw-slide-stage aw-slide-stage-img">
                  <img src="${sl.dataUrl}" alt="幻灯片 ${idx + 1}" loading="lazy" />
                </div>
              </section>`
            )
            .join('\n');
          canvasEl.innerHTML = `<div class="aw-slides-deck">${cards}</div>`;
          return;
        }
        if (hiresCache.mode === 'pdf' && hiresCache.pdfBase64) {
          const blobUrl = base64ToBlobUrl(doc, hiresCache.pdfBase64, 'application/pdf');
          if (blobUrl) {
            ownedBlobUrls.push(blobUrl);
            canvasEl.className = 'aw-doc-canvas aw-doc-canvas-pdf';
            canvasEl.innerHTML = `<iframe class="aw-doc-pdf-frame" src="${esc(blobUrl)}" title="${titleStr}"></iframe>`;
            return;
          }
        }
      }

      if (hasSections && (isSpreadsheet || isEpub)) {
        const sec = docData.sections[activeSectionIdx] || docData.sections[0];
        canvasEl.className = isSpreadsheet ? 'aw-doc-canvas aw-doc-canvas-sheet' : 'aw-doc-canvas aw-doc-canvas-article';
        canvasEl.innerHTML = sec?.html || '<p class="aw-doc-empty-msg">内容为空。</p>';
      } else if (isCsvLike || format === 'zip') {
        canvasEl.className = 'aw-doc-canvas aw-doc-canvas-sheet';
        canvasEl.innerHTML = docData.bodyHtml || '<p class="aw-doc-empty-msg">内容为空。</p>';
      } else if (isPresentation) {
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
        tr.hidden = q ? !(tr.textContent || '').toLowerCase().includes(q) : false;
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
      opts.onTogglePaperMode?.(paperMode);
    });
    shell.querySelector('[data-aw-doc-act="hires"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (hiresLoading || !opts.onRequestHiRes) return;
      const btn = e.currentTarget;
      const lbl = btn.querySelector('.aw-doc-btn-txt');
      if (hiresActive) {
        hiresActive = false;
        btn.setAttribute('data-active', '0');
        if (lbl) lbl.textContent = '本机精绘';
        renderActiveBody();
        return;
      }
      if (hiresCache) {
        hiresActive = true;
        btn.setAttribute('data-active', '1');
        if (lbl) lbl.textContent = '矢量画布';
        renderActiveBody();
        return;
      }
      hiresLoading = true;
      btn.disabled = true;
      if (lbl) lbl.textContent = '渲染中...';
      try {
        const res = await opts.onRequestHiRes(docData.path);
        if (res && res.ok) {
          hiresCache = res;
          hiresActive = true;
          btn.setAttribute('data-active', '1');
          if (lbl) lbl.textContent = '矢量画布';
          renderActiveBody();
        } else {
          if (lbl) lbl.textContent = '本机精绘';
          opts.onNotify?.(res?.error || '本机未检测到可用演示引擎');
        }
      } finally {
        hiresLoading = false;
        btn.disabled = false;
      }
    });
    shell.querySelector('[data-aw-doc-act="wire"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!meshController) return;
      const nextWire = meshController.toggleWireframe();
      e.currentTarget.setAttribute('data-active', nextWire ? '1' : '0');
    });
    shell.querySelector('[data-aw-doc-act="reset3d"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      meshController?.resetView?.();
    });
    shell.querySelector('[data-aw-doc-act="copy"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const lbl = btn.querySelector('.aw-doc-btn-txt');
      const text = docData.plainText || '';
      if (text && win?.navigator?.clipboard?.writeText) {
        void win.navigator.clipboard.writeText(text).then(() => {
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

    // Spreadsheet / SQLite tabs & filter
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
        if (btn) btn.setAttribute('data-active', paperMode ? '1' : '0');
      },
      destroy() {
        clearTimeout(findTimer);
        meshController?.destroy?.();
        fontController?.destroy?.();
        for (const u of ownedBlobUrls) {
          try { win?.URL?.revokeObjectURL?.(u); } catch {}
        }
        ownedBlobUrls.length = 0;
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
