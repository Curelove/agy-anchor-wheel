// Integrated Morphing Acoustic Sphere Renderer for AnchorWheel (Zero Hit-Test Coupling)
// Physically morphs the wheel's own SVG sector contours in lockstep with zero-anchored braided
// liquid acoustic ribbons, directional musical spectrum crests, sector-clipped internal ripples,
// and a convex resonant center core — with high contrast on both light and dark host panes.
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelSoundwave = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STAGE_SIZE = 344;
  const PAD = 48;
  const CANVAS_SIZE = STAGE_SIZE + PAD * 2; // 440px logical canvas centered on 344px stage
  const CENTER = CANVAS_SIZE / 2;           // 220px
  const SVG_CENTER = STAGE_SIZE / 2;        // 172px
  const MAX_OUTER_CREST_PX = 20;            // Strict upper bound so waves never obstruct UI reading
  const MAX_INNER_CREST_PX = 5.0;           // Stays cleanly inside the hub-to-sector ring channel

  let mountSeq = 1;

  const PALETTES = Object.freeze({
    soundwave: {
      isLight: false,
      baseRgb: [32, 208, 192],      // Luminous mineral sea-jade
      midRgb: [86, 232, 218],       // Bright aqua-mint harmonic
      peakRgb: [242, 166, 48],      // Rich burnished acoustic amber (crisp even on light gray!)
      specRgb: [255, 240, 200],     // Warm pearl specular peak
      chassisRgb: [6, 15, 23],      // Deep obsidian grounding shadow
      underWaveRgb: [10, 74, 82],   // Deep jewel-teal wave shadow bed
      domeStops: ['#1f3545', '#12212e', '#0a141d'],
      emptyDomeStops: ['#182835', '#101c26', '#0a131c'],
      activeDomeStops: ['#235a64', '#163d48', '#0e2833'],
      hubStops: ['#284b5d', '#11212f', '#07111a'],
      hubActiveStops: ['#2f6975', '#163844', '#0b1e29'],
      idleAlpha: 0.74,
      activeAlpha: 0.98,
      hubAlpha: 0.92,
      rimStrokeAlpha: 0.9,
    },
    obsidian: {
      isLight: false,
      baseRgb: [82, 152, 255],
      midRgb: [138, 198, 255],
      peakRgb: [204, 232, 255],
      specRgb: [246, 251, 255],
      chassisRgb: [8, 12, 24],
      underWaveRgb: [24, 58, 122],
      domeStops: ['#1e2538', '#141926', '#0d111a'],
      emptyDomeStops: ['#181d2c', '#121621', '#0c0f17'],
      activeDomeStops: ['#284375', '#1b2d52', '#121e38'],
      hubStops: ['#26324d', '#141926', '#0b0e17'],
      hubActiveStops: ['#335592', '#1d325a', '#111d36'],
      idleAlpha: 0.7,
      activeAlpha: 0.96,
      hubAlpha: 0.88,
      rimStrokeAlpha: 0.86,
    },
    warm: {
      isLight: false,
      baseRgb: [224, 120, 82],
      midRgb: [240, 160, 88],
      peakRgb: [248, 198, 86],
      specRgb: [255, 242, 210],
      chassisRgb: [18, 13, 10],
      underWaveRgb: [96, 42, 22],
      domeStops: ['#2d2520', '#1e1a17', '#14110f'],
      emptyDomeStops: ['#241f1b', '#1a1714', '#12100e'],
      activeDomeStops: ['#5c3626', '#3d251b', '#261812'],
      hubStops: ['#3b2d24', '#1f1916', '#13100e'],
      hubActiveStops: ['#6d3f2b', '#41261b', '#241610'],
      idleAlpha: 0.7,
      activeAlpha: 0.96,
      hubAlpha: 0.88,
      rimStrokeAlpha: 0.86,
    },
    crystal: {
      isLight: true,
      baseRgb: [37, 99, 235],
      midRgb: [14, 148, 224],
      peakRgb: [14, 84, 194],
      specRgb: [255, 255, 255],
      chassisRgb: [20, 48, 108],
      underWaveRgb: [30, 88, 218],
      domeStops: ['#ffffff', '#f2f7fe', '#e3eefb'],
      emptyDomeStops: ['#fafcff', '#eff5fc', '#e4eef9'],
      activeDomeStops: ['#dcebff', '#e7f2ff', '#cee3ff'],
      hubStops: ['#ffffff', '#eff5fd', '#dfebfa'],
      hubActiveStops: ['#d7e9ff', '#e4f0ff', '#c5dfff'],
      idleAlpha: 0.66,
      activeAlpha: 0.94,
      hubAlpha: 0.86,
      rimStrokeAlpha: 0.84,
    },
    alabaster: {
      isLight: true,
      baseRgb: [198, 80, 40],
      midRgb: [222, 126, 44],
      peakRgb: [158, 48, 20],
      specRgb: [255, 246, 228],
      chassisRgb: [68, 42, 22],
      underWaveRgb: [182, 68, 32],
      domeStops: ['#fffefb', '#f9f3ea', '#efe7da'],
      emptyDomeStops: ['#fdfaf5', '#f4ede2', '#ebe2d4'],
      activeDomeStops: ['#fbe6d8', '#f6ded0', '#eed0bc'],
      hubStops: ['#ffffff', '#f8f2e8', '#ede3d4'],
      hubActiveStops: ['#f9e1d1', '#f3d6c2', '#e9c4ab'],
      idleAlpha: 0.68,
      activeAlpha: 0.95,
      hubAlpha: 0.88,
      rimStrokeAlpha: 0.84,
    },
  });

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function mixRgb(a, b, t) {
    const k = clamp(t, 0, 1);
    const r = Math.round(a[0] + (b[0] - a[0]) * k);
    const g = Math.round(a[1] + (b[1] - a[1]) * k);
    const bl = Math.round(a[2] + (b[2] - a[2]) * k);
    return `${r}, ${g}, ${bl}`;
  }

  function mixRgb3(a, b, c, t) {
    const k = clamp(t, 0, 1);
    if (k < 0.5) return mixRgb(a, b, k * 2);
    return mixRgb(b, c, (k - 0.5) * 2);
  }

  function degToRad(deg) {
    return ((deg - 90) * Math.PI) / 180;
  }

  function isSoundwaveActiveForSettings(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const t = settings.theme || 'auto';
    if (t === 'soundwave') return true;
    if (
      settings.wheelSoundwaveByTheme &&
      typeof settings.wheelSoundwaveByTheme === 'object' &&
      Object.prototype.hasOwnProperty.call(settings.wheelSoundwaveByTheme, t)
    ) {
      return Boolean(settings.wheelSoundwaveByTheme[t]);
    }
    return Boolean(settings.wheelSoundwaveEnabled);
  }

  function resolvePaletteKey(doc, backdropEl, explicitTheme) {
    const attr =
      explicitTheme && explicitTheme !== 'auto'
        ? explicitTheme
        : backdropEl?.getAttribute?.('data-aw-theme') ||
          doc?.documentElement?.getAttribute?.('data-aw-theme') ||
          '';
    if (attr && PALETTES[attr]) return attr;
    const prefersLight = Boolean(doc?.defaultView?.matchMedia?.('(prefers-color-scheme: light)')?.matches);
    return prefersLight ? 'crystal' : 'soundwave';
  }

  function corridorDuckFactor(angleRad, mutedCorridorRad, minFloor = 0.36) {
    if (typeof mutedCorridorRad !== 'number' || !Number.isFinite(mutedCorridorRad)) return 1;
    const subCos = Math.cos(angleRad - mutedCorridorRad);
    if (subCos <= 0.74) return 1;
    const duck = 1 - (1 - minFloor) * ((subCos - 0.74) / 0.26);
    return clamp(duck, minFloor, 1);
  }

  /**
   * Pure math evaluator exposed for both 60fps acoustic sphere rendering and deterministic unit tests.
   * Calm & steady when pointer rests inside center (<= 4.2px); surges strongly on leaned hemisphere
   * while strictly capped below MAX_OUTER_CREST_PX and smoothly ducking behind open submenus.
   */
  function computeBarHeight(angleRad, bias, targetAngleRad, timeSec, mutedCorridorRad = null) {
    const baseIdle =
      2.55 +
      0.72 * Math.sin(angleRad * 3 + timeSec * 2.05) +
      0.48 * Math.cos(angleRad * 5 - timeSec * 2.85) +
      0.24 * Math.sin(angleRad * 9 + timeSec * 3.6);

    if (bias <= 0.01) {
      return {
        height: clamp(baseIdle, 1.2, 4.05),
        energy: 0,
        lobe: 0,
      };
    }

    const cosDiff = Math.cos(angleRad - targetAngleRad);
    const broadLobe = cosDiff > 0 ? Math.pow(cosDiff, 1.95) : 0;
    const focusPeak = cosDiff > 0 ? Math.pow(cosDiff, 5.2) : 0;
    const directionalWeight = 0.56 * broadLobe + 0.7 * focusPeak;

    const harmonic =
      0.56 +
      0.24 * Math.sin(angleRad * 6 - timeSec * 5.0) +
      0.21 * Math.sin(angleRad * 13 + timeSec * 7.6) +
      0.15 * Math.cos(angleRad * 21 - timeSec * 10.4) +
      0.08 * Math.sin(angleRad * 31 + timeSec * 13.0);

    const rawDrive = 1.72 * bias * directionalWeight * Math.max(0.2, harmonic);
    const maxExtra = MAX_OUTER_CREST_PX - 2.4;
    let extra = maxExtra * Math.tanh(rawDrive);
    extra *= corridorDuckFactor(angleRad, mutedCorridorRad, 0.36);

    const dampOpposite = cosDiff < 0 ? 1 - 0.3 * Math.abs(cosDiff) * bias : 1;
    const total = clamp(baseIdle * dampOpposite * (1 - 0.34 * broadLobe * bias) + extra, 1.1, MAX_OUTER_CREST_PX);
    return {
      height: total,
      energy: clamp(extra / maxExtra, 0, 1),
      lobe: broadLobe,
    };
  }

  /**
   * Smooth muscular low-mid harmonic contour morphing applied directly to the wheel's SVG sector
   * outer edges so the wheel body itself organically breathes and surges toward the cursor,
   * leaving dramatic headroom for the braided fluid soundwave ribbons rising above it.
   */
  function computeBodyMorph(angleRad, bias, targetAngleRad, timeSec, mutedCorridorRad = null) {
    const idleWave =
      1.9 * Math.sin(angleRad * 3 + timeSec * 1.85) +
      1.1 * Math.cos(angleRad * 5 - timeSec * 2.55) +
      0.45 * Math.sin(angleRad * 7 + timeSec * 3.2);

    if (bias <= 0.01) {
      return clamp(idleWave, -2.5, 3.4);
    }

    const cosDiff = Math.cos(angleRad - targetAngleRad);
    const broadLobe = cosDiff > 0 ? Math.pow(cosDiff, 1.8) : 0;
    const focusLobe = cosDiff > 0 ? Math.pow(cosDiff, 4.2) : 0;
    const backTuck = cosDiff < 0 ? -1.45 * Math.pow(Math.abs(cosDiff), 1.45) * bias : 0;

    const liquidRipple =
      0.78 +
      0.22 * Math.sin(angleRad * 5 - timeSec * 4.6) +
      0.14 * Math.cos(angleRad * 9 + timeSec * 6.8);

    let surge = (4.4 * broadLobe + 4.8 * focusLobe) * bias * Math.max(0.35, liquidRipple);
    surge *= corridorDuckFactor(angleRad, mutedCorridorRad, 0.34);

    return clamp(idleWave * (1 - 0.25 * bias) + surge + backTuck, -2.3, 9.2);
  }

  function computeInnerMorph(angleRad, bias, targetAngleRad, timeSec) {
    const idle =
      0.62 * Math.sin(angleRad * 3 - timeSec * 2.05) +
      0.38 * Math.cos(angleRad * 5 + timeSec * 2.8);
    const dirPull = bias > 0.01 ? Math.max(0, Math.cos(angleRad - targetAngleRad)) : 0;
    const pull = bias * Math.pow(dirPull, 2.0) * (1.1 + 0.5 * Math.sin(angleRad * 8 - timeSec * 5.8));
    return clamp(idle + pull, -1.0, 2.1);
  }

  function traceClosedSmoothPath(ctx, points, reverse = false) {
    const n = points.length;
    if (n < 3) return;
    if (!reverse) {
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];
        ctx.bezierCurveTo(
          p1.x + (p2.x - p0.x) / 6,
          p1.y + (p2.y - p0.y) / 6,
          p2.x - (p3.x - p1.x) / 6,
          p2.y - (p3.y - p1.y) / 6,
          p2.x,
          p2.y
        );
      }
    } else {
      ctx.moveTo(points[n - 1].x, points[n - 1].y);
      for (let i = n - 1; i >= 0; i--) {
        const p0 = points[(i + 1) % n];
        const p1 = points[i];
        const p2 = points[(i - 1 + n) % n];
        const p3 = points[(i - 2 + n) % n];
        ctx.bezierCurveTo(
          p1.x + (p2.x - p0.x) / 6,
          p1.y + (p2.y - p0.y) / 6,
          p2.x - (p3.x - p1.x) / 6,
          p2.y - (p3.y - p1.y) / 6,
          p2.x,
          p2.y
        );
      }
    }
    ctx.closePath();
  }

  function traceOpenSmoothCanvas(ctx, pts, moveFirst = true) {
    const n = pts.length;
    if (n < 2) return;
    if (moveFirst) ctx.moveTo(pts[0].x, pts[0].y);
    else ctx.lineTo(pts[0].x, pts[0].y);
    for (let i = 0; i < n - 1; i++) {
      const p0 = i > 0 ? pts[i - 1] : pts[0];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i + 2 < n ? pts[i + 2] : pts[n - 1];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6,
        p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6,
        p2.y - (p3.y - p1.y) / 6,
        p2.x,
        p2.y
      );
    }
  }

  function appendOpenCatmullSvg(cmds, pts) {
    const n = pts.length;
    if (n < 2) return;
    for (let i = 0; i < n - 1; i++) {
      const p0 = i > 0 ? pts[i - 1] : pts[0];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i + 2 < n ? pts[i + 2] : pts[n - 1];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      cmds.push(
        `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
      );
    }
  }

  /**
   * Computes both SVG-space and Canvas-space morphed geometry for a single sector in one pass
   * so SVG fill, grounding shadow, internal ripples, and welded rim specular line share exact coordinates.
   */
  function evaluateSectorGeometry(meta, bias, targetAngleRad, timeSec, mutedCorridorRad, activeBoost) {
    const startDeg = meta.a0 + meta.gap / 2;
    const endDeg = meta.a1 - meta.gap / 2;
    const span = endDeg - startDeg;
    if (span <= 0.5) return null;

    const outerSteps = clamp(Math.ceil(span / 5.5), 10, 32);
    const innerSteps = clamp(Math.ceil(span / 12), 6, 16);

    const svgOuter = [];
    const canvasOuter = [];
    for (let i = 0; i <= outerSteps; i++) {
      const deg = startDeg + (span * i) / outerSteps;
      const rad = degToRad(deg);
      const morph = computeBodyMorph(rad, bias, targetAngleRad, timeSec, mutedCorridorRad);
      const edgeTaper = Math.sin((i / outerSteps) * Math.PI);
      const r = meta.rOut + morph + activeBoost * (1.6 + 1.4 * edgeTaper);
      const cx = Math.cos(rad) * r;
      const cy = Math.sin(rad) * r;
      svgOuter.push({ x: SVG_CENTER + cx, y: SVG_CENTER + cy });
      canvasOuter.push({ x: CENTER + cx, y: CENTER + cy });
    }

    const svgInner = [];
    const canvasInner = [];
    for (let i = innerSteps; i >= 0; i--) {
      const deg = startDeg + (span * i) / innerSteps;
      const rad = degToRad(deg);
      const inMorph = computeInnerMorph(rad, bias, targetAngleRad, timeSec);
      const r = meta.rIn + inMorph;
      const cx = Math.cos(rad) * r;
      const cy = Math.sin(rad) * r;
      svgInner.push({ x: SVG_CENTER + cx, y: SVG_CENTER + cy });
      canvasInner.push({ x: CENTER + cx, y: CENTER + cy });
    }

    const cmds = [`M ${svgOuter[0].x.toFixed(2)} ${svgOuter[0].y.toFixed(2)}`];
    appendOpenCatmullSvg(cmds, svgOuter);
    cmds.push(`L ${svgInner[0].x.toFixed(2)} ${svgInner[0].y.toFixed(2)}`);
    appendOpenCatmullSvg(cmds, svgInner);
    cmds.push('Z');

    return {
      d: cmds.join(' '),
      canvasOuter,
      canvasInner,
      isActive: activeBoost > 0,
      startDeg,
      endDeg,
    };
  }

  function isAngleCoveredBySectors(degNorm, sectorSpecs) {
    if (!sectorSpecs.length) return true;
    for (const s of sectorSpecs) {
      const a0 = ((s.a0 + s.gap / 2) % 360 + 360) % 360;
      const a1 = ((s.a1 - s.gap / 2) % 360 + 360) % 360;
      if (a0 <= a1) {
        if (degNorm >= a0 && degNorm <= a1) return true;
      } else {
        if (degNorm >= a0 || degNorm <= a1) return true;
      }
    }
    return false;
  }

  function createGradientEl(doc, id, attrs, stops) {
    const g = doc.createElementNS(SVG_NS, 'radialGradient');
    g.setAttribute('id', id);
    for (const [k, v] of Object.entries(attrs)) {
      g.setAttribute(k, v);
    }
    for (const st of stops) {
      const s = doc.createElementNS(SVG_NS, 'stop');
      s.setAttribute('offset', st.offset);
      s.setAttribute('stop-color', st.color);
      if (st.opacity !== undefined) s.setAttribute('stop-opacity', String(st.opacity));
      g.appendChild(s);
    }
    return g;
  }

  function syncSvgMaterialDefs(doc, svg, stageEl, uid, palKey, pal) {
    if (!svg) return;
    if (svg.getAttribute('data-aw-sw-pal') === palKey && svg.querySelector('.aw-sw-defs')) return;
    svg.setAttribute('data-aw-sw-pal', palKey);
    svg.querySelector('.aw-sw-defs')?.remove();

    const defs = doc.createElementNS(SVG_NS, 'defs');
    defs.setAttribute('class', 'aw-sw-defs');

    const ids = {
      dome: `aw-sw-dome-${uid}`,
      empty: `aw-sw-empty-${uid}`,
      active: `aw-sw-active-${uid}`,
      hub: `aw-sw-hub-${uid}`,
      hubActive: `aw-sw-hub-act-${uid}`,
    };

    const domeAttrs = {
      gradientUnits: 'userSpaceOnUse',
      cx: String(SVG_CENTER),
      cy: String(SVG_CENTER),
      r: '158',
      fx: String(SVG_CENTER - 26),
      fy: String(SVG_CENTER - 30),
    };
    const hubAttrs = {
      cx: '50%',
      cy: '50%',
      r: '56%',
      fx: '34%',
      fy: '28%',
    };

    defs.appendChild(
      createGradientEl(doc, ids.dome, domeAttrs, [
        { offset: '18%', color: pal.domeStops[0] },
        { offset: '64%', color: pal.domeStops[1] },
        { offset: '100%', color: pal.domeStops[2] },
      ])
    );
    defs.appendChild(
      createGradientEl(doc, ids.empty, domeAttrs, [
        { offset: '18%', color: pal.emptyDomeStops[0] },
        { offset: '66%', color: pal.emptyDomeStops[1] },
        { offset: '100%', color: pal.emptyDomeStops[2] },
      ])
    );
    defs.appendChild(
      createGradientEl(doc, ids.active, domeAttrs, [
        { offset: '16%', color: pal.activeDomeStops[0] },
        { offset: '62%', color: pal.activeDomeStops[1] },
        { offset: '100%', color: pal.activeDomeStops[2] },
      ])
    );
    defs.appendChild(
      createGradientEl(doc, ids.hub, hubAttrs, [
        { offset: '0%', color: pal.hubStops[0] },
        { offset: '62%', color: pal.hubStops[1] },
        { offset: '100%', color: pal.hubStops[2] },
      ])
    );
    defs.appendChild(
      createGradientEl(doc, ids.hubActive, hubAttrs, [
        { offset: '0%', color: pal.hubActiveStops[0] },
        { offset: '60%', color: pal.hubActiveStops[1] },
        { offset: '100%', color: pal.hubActiveStops[2] },
      ])
    );

    if (svg.firstChild) svg.insertBefore(defs, svg.firstChild);
    else svg.appendChild(defs);

    stageEl.style.setProperty('--aw-sw-sector-fill', `url(#${ids.dome})`);
    stageEl.style.setProperty('--aw-sw-sector-empty-fill', `url(#${ids.empty})`);
    stageEl.style.setProperty('--aw-sw-sector-active-fill', `url(#${ids.active})`);
    stageEl.style.setProperty('--aw-sw-hub-fill', `url(#${ids.hub})`);
    stageEl.style.setProperty('--aw-sw-hub-active-fill', `url(#${ids.hubActive})`);
  }

  function collectSectorSpecs(svg, fallbackInner, fallbackOuter) {
    if (!svg) return [];
    const list = [];
    const nodes = svg.querySelectorAll('.aw-wheel-sector');
    for (const el of nodes) {
      const a0 = Number(el.getAttribute('data-aw-a0'));
      const a1 = Number(el.getAttribute('data-aw-a1'));
      if (!Number.isFinite(a0) || !Number.isFinite(a1) || a1 <= a0) continue;
      const gap = Number(el.getAttribute('data-aw-gap'));
      const rIn = Number(el.getAttribute('data-aw-rin'));
      const rOut = Number(el.getAttribute('data-aw-rout'));
      list.push({
        el,
        a0,
        a1,
        gap: Number.isFinite(gap) ? gap : 2.0,
        rIn: Number.isFinite(rIn) ? rIn : fallbackInner + 6,
        rOut: Number.isFinite(rOut) ? rOut : fallbackOuter,
        origD: el.getAttribute('d') || '',
      });
    }
    return list;
  }

  function mountWheelSoundwave(stageEl, options = {}) {
    if (!stageEl) return null;
    const doc = options.document || stageEl.ownerDocument || document;
    const win = doc.defaultView || globalThis;
    const S = Shared || globalThis.AnchorWheelNavShared;

    const uid = mountSeq++;
    const rInner = Number(options.rInner) || 46;
    const rOuter = Number(options.rOuter) || 142;
    const svg = options.svgEl || stageEl.querySelector('.aw-wheel-svg');
    const sectorSpecs = collectSectorSpecs(svg, rInner, rOuter);

    stageEl.querySelector('.aw-soundwave-canvas')?.remove();
    stageEl.querySelector('.aw-soundwave-fx-canvas')?.remove();

    const makeCanvas = (className, zIndex) => {
      const c = S?.markNode ? S.markNode(doc.createElement('canvas')) : doc.createElement('canvas');
      c.className = className;
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = `position:absolute;left:50%;top:50%;width:${CANVAS_SIZE}px;height:${CANVAS_SIZE}px;transform:translate(-50%,-50%);pointer-events:none;z-index:${zIndex};`;
      return c;
    };

    const canvas = makeCanvas('aw-soundwave-canvas', 0);
    if (stageEl.firstChild) {
      stageEl.insertBefore(canvas, stageEl.firstChild);
    } else {
      stageEl.appendChild(canvas);
    }

    const fxCanvas = makeCanvas('aw-soundwave-fx-canvas', 2);
    const labelsEl = stageEl.querySelector('.aw-wheel-labels');
    if (labelsEl && labelsEl.parentNode === stageEl) {
      stageEl.insertBefore(fxCanvas, labelsEl);
    } else if (svg && svg.nextSibling) {
      stageEl.insertBefore(fxCanvas, svg.nextSibling);
    } else {
      stageEl.appendChild(fxCanvas);
    }

    let destroyed = false;
    let rafId = 0;
    let targetDx = 0;
    let targetDy = 0;
    let smoothDx = 0;
    let smoothDy = 0;
    let mutedDeg = null;
    const startMs = Date.now();

    const prefersReducedMotion = Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

    function syncCanvasResolution(c, dpr) {
      const pxSize = Math.round(CANVAS_SIZE * dpr);
      if (c.width !== pxSize || c.height !== pxSize) {
        c.width = pxSize;
        c.height = pxSize;
      }
    }

    function drawFrame(explicitTimeSec = null, instantFollow = false) {
      if (destroyed || !canvas.isConnected) return null;
      const dpr = Math.min(2, Number(win?.devicePixelRatio) || 1);
      syncCanvasResolution(canvas, dpr);
      syncCanvasResolution(fxCanvas, dpr);
      const ctx = canvas.getContext('2d');
      const fxCtx = fxCanvas.getContext('2d');
      if (!ctx) return null;

      if (instantFollow) {
        smoothDx = targetDx;
        smoothDy = targetDy;
      } else {
        smoothDx += (targetDx - smoothDx) * 0.22;
        smoothDy += (targetDy - smoothDy) * 0.22;
      }

      const dist = Math.hypot(smoothDx, smoothDy);
      const bias = clamp((dist - rInner * 0.55) / Math.max(24, rOuter - rInner * 0.45), 0, 1);
      const targetAngleRad = Math.atan2(smoothDy, smoothDx);
      const timeSec =
        typeof explicitTimeSec === 'number'
          ? explicitTimeSec
          : prefersReducedMotion
          ? 0.5
          : (Date.now() - startMs) / 1000;

      const backdropEl = stageEl.closest?.('.aw-wheel-backdrop') || null;
      const palKey = resolvePaletteKey(doc, backdropEl, options.getTheme?.());
      const pal = PALETTES[palKey] || PALETTES.soundwave;

      syncSvgMaterialDefs(doc, svg, stageEl, uid, palKey, pal);

      const mutedCorridorRad =
        typeof mutedDeg === 'number' && Number.isFinite(mutedDeg)
          ? degToRad(mutedDeg)
          : null;

      // ── Step 1: Morph every actual SVG sector & cache exact Canvas coordinates ──
      const morphedSectors = [];
      for (const spec of sectorSpecs) {
        const isActive = spec.el.getAttribute('data-active') === '1';
        const geom = evaluateSectorGeometry(
          spec,
          bias,
          targetAngleRad,
          timeSec,
          mutedCorridorRad,
          isActive ? 1 : 0
        );
        if (geom) {
          spec.el.setAttribute('d', geom.d);
          morphedSectors.push(geom);
        }
      }

      // ── Step 2: Sample unified 96-point polar field for zero-anchored braided liquid ribbons ──
      // Key anti-railroad-tie rule: wave ribbons dip all the way down to the sector rim in troughs
      // and sweep gracefully outward into dramatic sinusoidal crests (up to MAX_OUTER_CREST_PX),
      // punched cleanly outside the inner wheel radius via evenodd hole so bilateral notches stay open!
      const ringSamples = 96;
      const innerCutoutPts = [];
      const ribbon1Pts = []; // Deep primary sweeping wave sheet
      const ribbon2Pts = []; // Counter-phase braiding luminous wave sheet
      const ribbon3Pts = []; // High-frequency energized shimmer crest

      for (let i = 0; i < ringSamples; i++) {
        const rad = (i / ringSamples) * Math.PI * 2;
        const ux = Math.cos(rad);
        const uy = Math.sin(rad);
        const bodyMorph = computeBodyMorph(rad, bias, targetAngleRad, timeSec, mutedCorridorRad);
        const barRes = computeBarHeight(rad, bias, targetAngleRad, timeSec, mutedCorridorRad);
        const duck = corridorDuckFactor(rad, mutedCorridorRad, 0.36);

        const rCut = rOuter + bodyMorph - 1.6;
        innerCutoutPts.push({ x: CENTER + ux * rCut, y: CENTER + uy * rCut });

        const cosDiff = bias > 0.01 ? Math.cos(rad - targetAngleRad) : 0;
        const dirLobe = cosDiff > 0 ? Math.pow(cosDiff, 1.85) : 0;
        const dirFocus = cosDiff > 0 ? Math.pow(cosDiff, 4.4) : 0;
        const headroom = Math.max(2.0, MAX_OUTER_CREST_PX - bodyMorph);

        // Ribbon 1: Sweeping organic 3-lobe fluid crest — soft-saturated via tanh so full lean
        // NEVER flat-clips into a plateau and always keeps musical peaks & valleys!
        const s1 = Math.sin(rad * 1.5 + timeSec * 1.05);
        const s1b = Math.sin(rad * 2.5 - timeSec * 1.45 + 0.6);
        const idleR1 = 1.1 + 5.0 * (s1 * s1) + 2.0 * (s1b * s1b);
        const osc1 = 0.56 + 0.28 * Math.sin(rad * 6 - timeSec * 4.6) + 0.16 * Math.cos(rad * 11 + timeSec * 6.4);
        const drive1 = bias * (0.72 * dirLobe + 0.96 * dirFocus) * Math.max(0.28, osc1) * duck;
        const rawR1 = idleR1 * (1 - 0.58 * bias * (cosDiff < 0 ? 1 : 0.35)) + headroom * 1.08 * Math.tanh(drive1 * 1.35);
        const r1Off = bodyMorph + clamp(headroom * Math.tanh(rawR1 / Math.max(4, headroom * 0.92)), 0.4, headroom);
        ribbon1Pts.push({ x: CENTER + ux * (rOuter + r1Off), y: CENTER + uy * (rOuter + r1Off) });

        // Ribbon 2: Counter-phase braiding wave with distinct secondary peaks
        const s2 = Math.sin(rad * 2.0 - timeSec * 1.35 + 1.15);
        const s2b = Math.cos(rad * 3.5 + timeSec * 1.95);
        const idleR2 = 0.8 + 4.3 * (s2 * s2) + 1.7 * (s2b * s2b);
        const osc2 = 0.5 + 0.32 * Math.cos(rad * 8 + timeSec * 6.0) + 0.18 * Math.sin(rad * 14 - timeSec * 8.4);
        const drive2 = bias * (0.64 * dirLobe + 1.05 * dirFocus) * Math.max(0.22, osc2) * duck;
        const rawR2 = idleR2 * (1 - 0.52 * bias * (cosDiff < 0 ? 1 : 0.3)) + headroom * 1.04 * Math.tanh(drive2 * 1.3);
        const r2Off = bodyMorph + clamp(headroom * Math.tanh(rawR2 / Math.max(4, headroom * 0.94)), 0.3, headroom - 0.3);
        ribbon2Pts.push({ x: CENTER + ux * (rOuter + r2Off), y: CENTER + uy * (rOuter + r2Off) });

        // Ribbon 3: High-harmonic crest ribbon dancing in sharp musical peaks on the aimed hemisphere
        const s3 = Math.sin(rad * 3.0 + timeSec * 2.1 + 2.0);
        const idleR3 = 0.45 + 2.7 * (s3 * s3);
        const osc3 = 0.44 + 0.36 * Math.sin(rad * 12 - timeSec * 7.8) + 0.2 * Math.cos(rad * 19 + timeSec * 10.6);
        const drive3 = bias * (0.5 * dirLobe + 1.12 * dirFocus) * Math.max(0.16, osc3) * duck;
        const rawR3 = idleR3 * (1 - 0.45 * bias) + Math.max(headroom * Math.tanh(drive3 * 1.28), barRes.energy * headroom * 0.86 * duck);
        const r3Off = bodyMorph + clamp(headroom * Math.tanh(rawR3 / Math.max(4, headroom * 0.96)), 0.2, headroom - 0.4);
        ribbon3Pts.push({ x: CENTER + ux * (rOuter + r3Off), y: CENTER + uy * (rOuter + r3Off) });
      }

      // ── Step 3: Render Back Canvas (Sector-Only Shadow + Annular Braided Wave Ribbons + Musical Crests) ──
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // B0. Grounding shadow strictly behind the ACTUAL morphed sectors (bilateral notches remain 100% open!)
      ctx.save();
      ctx.beginPath();
      if (morphedSectors.length) {
        for (const ms of morphedSectors) {
          traceOpenSmoothCanvas(ctx, ms.canvasOuter, true);
          traceOpenSmoothCanvas(ctx, ms.canvasInner, false);
          ctx.closePath();
        }
      } else {
        traceClosedSmoothPath(ctx, innerCutoutPts);
      }
      ctx.shadowColor = pal.isLight
        ? `rgba(${pal.chassisRgb.join(', ')}, 0.24)`
        : `rgba(${pal.chassisRgb.join(', ')}, 0.72)`;
      ctx.shadowBlur = pal.isLight ? 20 : 28;
      ctx.shadowOffsetY = 7;
      ctx.fillStyle = pal.isLight
        ? `rgba(${pal.chassisRgb.join(', ')}, 0.06)`
        : `rgba(${pal.chassisRgb.join(', ')}, 0.58)`;
      ctx.fill();
      ctx.restore();

      const gradDirX = Math.cos(bias > 0.02 ? targetAngleRad : -Math.PI * 0.28);
      const gradDirY = Math.sin(bias > 0.02 ? targetAngleRad : -Math.PI * 0.28);

      // Helper: draw one annular fluid wave ribbon punched cleanly OUTSIDE the wheel body (ZERO notch/seam bleed!)
      function drawAnnularRibbon(outerPts, fillGrad, strokeStyle, strokeWidth, shadowAlpha) {
        ctx.save();
        ctx.beginPath();
        traceClosedSmoothPath(ctx, outerPts, false);
        traceClosedSmoothPath(ctx, innerCutoutPts, true);
        if (shadowAlpha > 0) {
          ctx.shadowColor = pal.isLight
            ? `rgba(${pal.chassisRgb.join(', ')}, ${(shadowAlpha * 0.48).toFixed(3)})`
            : `rgba(${pal.chassisRgb.join(', ')}, ${shadowAlpha.toFixed(3)})`;
          ctx.shadowBlur = pal.isLight ? 8 : 11;
          ctx.shadowOffsetY = 1;
        }
        ctx.fillStyle = fillGrad;
        ctx.fill('evenodd');
        ctx.restore();

        // Crisp luminous outer wave crest line (drawn ONLY on outer curve, never double-boxing the inner seam)
        ctx.save();
        ctx.beginPath();
        traceClosedSmoothPath(ctx, outerPts, false);
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
        ctx.restore();
      }

      // B1. Deep Primary Liquid Wave Sheet (gives rich silhouette contrast over bright white/gray code editors)
      const g1 = ctx.createLinearGradient(
        CENTER - gradDirX * (rOuter + 18),
        CENTER - gradDirY * (rOuter + 18),
        CENTER + gradDirX * (rOuter + 20),
        CENTER + gradDirY * (rOuter + 20)
      );
      if (pal.isLight) {
        g1.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, ${(0.24 + bias * 0.06).toFixed(3)})`);
        g1.addColorStop(0.55, `rgba(${pal.midRgb.join(', ')}, ${(0.38 + bias * 0.14).toFixed(3)})`);
        g1.addColorStop(1, `rgba(${pal.peakRgb.join(', ')}, ${(0.52 + bias * 0.26).toFixed(3)})`);
      } else {
        g1.addColorStop(0, `rgba(${pal.underWaveRgb.join(', ')}, ${(0.76 + bias * 0.1).toFixed(3)})`);
        g1.addColorStop(0.55, `rgba(${mixRgb(pal.underWaveRgb, pal.baseRgb, 0.56)}, ${(0.84 + bias * 0.1).toFixed(3)})`);
        g1.addColorStop(1, `rgba(${mixRgb(pal.baseRgb, pal.peakRgb, 0.25 + bias * 0.72)}, ${(0.9 + bias * 0.08).toFixed(3)})`);
      }
      const s1Grad = ctx.createLinearGradient(
        CENTER - gradDirX * (rOuter + 20),
        CENTER - gradDirY * (rOuter + 20),
        CENTER + gradDirX * (rOuter + 20),
        CENTER + gradDirY * (rOuter + 20)
      );
      s1Grad.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, ${(pal.idleAlpha * 0.78).toFixed(3)})`);
      s1Grad.addColorStop(0.58, `rgba(${pal.midRgb.join(', ')}, ${(0.8 + bias * 0.14).toFixed(3)})`);
      s1Grad.addColorStop(1, `rgba(${mixRgb(pal.peakRgb, pal.specRgb, 0.16 + bias * 0.42)}, ${(0.9 + bias * 0.08).toFixed(3)})`);
      drawAnnularRibbon(ribbon1Pts, g1, s1Grad, 1.55 + bias * 0.45, 0.68);

      // B2. Counter-Phase Braiding Liquid Ribbon
      const g2 = ctx.createLinearGradient(
        CENTER - gradDirX * (rOuter + 14),
        CENTER - gradDirY * (rOuter + 14),
        CENTER + gradDirX * (rOuter + 20),
        CENTER + gradDirY * (rOuter + 20)
      );
      if (pal.isLight) {
        g2.addColorStop(0, `rgba(${pal.midRgb.join(', ')}, 0.22)`);
        g2.addColorStop(1, `rgba(${pal.peakRgb.join(', ')}, ${(0.38 + bias * 0.28).toFixed(3)})`);
      } else {
        g2.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, ${(0.42 + bias * 0.12).toFixed(3)})`);
        g2.addColorStop(0.55, `rgba(${pal.midRgb.join(', ')}, ${(0.48 + bias * 0.16).toFixed(3)})`);
        g2.addColorStop(1, `rgba(${mixRgb(pal.peakRgb, pal.specRgb, 0.22 + bias * 0.35)}, ${(0.64 + bias * 0.26).toFixed(3)})`);
      }
      drawAnnularRibbon(
        ribbon2Pts,
        g2,
        `rgba(${mixRgb(pal.midRgb, pal.peakRgb, 0.2 + bias * 0.68)}, ${(0.66 + bias * 0.26).toFixed(3)})`,
        1.25 + bias * 0.35,
        0.38
      );

      // B3. High-Harmonic Energized Shimmer Crest (pops dramatically on leaned hemisphere)
      const g3 = ctx.createLinearGradient(
        CENTER - gradDirX * (rOuter + 10),
        CENTER - gradDirY * (rOuter + 10),
        CENTER + gradDirX * (rOuter + 20),
        CENTER + gradDirY * (rOuter + 20)
      );
      g3.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, 0.08)`);
      g3.addColorStop(0.6, `rgba(${pal.midRgb.join(', ')}, ${(0.22 + bias * 0.22).toFixed(3)})`);
      g3.addColorStop(1, `rgba(${mixRgb(pal.peakRgb, pal.specRgb, 0.45)}, ${(0.36 + bias * 0.44).toFixed(3)})`);
      drawAnnularRibbon(
        ribbon3Pts,
        g3,
        `rgba(${mixRgb(pal.midRgb, pal.specRgb, 0.32 + bias * 0.45)}, ${(0.44 + bias * 0.44).toFixed(3)})`,
        1.05 + bias * 0.35,
        0
      );

      // B4. Musical Directional Spectrum Peaks (uncaged! Serene on back side, dense & surging on leaned side!)
      const totalSlots = 144;
      ctx.lineCap = 'round';
      let maxRenderedHeight = 0;
      let leanedSideCount = 0;
      let oppositeSideMax = 0;

      for (let s = 0; s < totalSlots; s++) {
        const isSubBar = (s & 1) === 1;
        const angleRad = (s / totalSlots) * Math.PI * 2;
        const evalRes = computeBarHeight(angleRad, bias, targetAngleRad, timeSec + (isSubBar ? 0.14 : 0), mutedCorridorRad);

        if (isSubBar && evalRes.lobe * bias < 0.14) {
          continue;
        }

        const heightScale = isSubBar ? clamp((evalRes.lobe * bias - 0.1) * 1.4, 0, 0.9) : 1;
        const barH = clamp(evalRes.height * heightScale, 1.1, MAX_OUTER_CREST_PX);
        if (barH > maxRenderedHeight) maxRenderedHeight = barH;

        const cosSide = Math.cos(angleRad - targetAngleRad);
        if (cosSide > 0.5) leanedSideCount++;
        if (cosSide < -0.5 && barH > oppositeSideMax) oppositeSideMax = barH;

        // Only draw sculpted spectrum needles where there is real directional energy (or soft rhythmic crests at center),
        // eliminating monotonous "railroad ties" on the calm resting perimeter!
        const degNorm = ((((angleRad * 180) / Math.PI + 90) % 360) + 360) % 360;
        const onSector = isAngleCoveredBySectors(degNorm, sectorSpecs);
        if (!onSector && evalRes.energy < 0.25) continue;

        const bodyM = computeBodyMorph(angleRad, bias, targetAngleRad, timeSec, mutedCorridorRad);
        const crestProjection = barH - bodyM;
        if (bias < 0.08 && crestProjection < 1.35) continue;
        if (bias >= 0.08 && evalRes.energy < 0.12) continue;

        const ux = Math.cos(angleRad);
        const uy = Math.sin(angleRad);
        const rStart = rOuter + bodyM - 0.6;
        const rTip = rOuter + clamp(Math.max(bodyM + 2.2, barH), bodyM + 1.5, MAX_OUTER_CREST_PX);

        const x0 = CENTER + ux * rStart;
        const y0 = CENTER + uy * rStart;
        const x1 = CENTER + ux * rTip;
        const y1 = CENTER + uy * rTip;

        const barGrad = ctx.createLinearGradient(x0, y0, x1, y1);
        const alpha = clamp(0.42 + evalRes.energy * 0.56, 0.38, 0.98) * (isSubBar ? 0.84 : 1);
        barGrad.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, ${(alpha * 0.42).toFixed(3)})`);
        barGrad.addColorStop(0.55, `rgba(${mixRgb3(pal.baseRgb, pal.midRgb, pal.peakRgb, evalRes.energy)}, ${alpha.toFixed(3)})`);
        barGrad.addColorStop(1, `rgba(${mixRgb(pal.peakRgb, pal.specRgb, clamp(evalRes.energy * 1.1, 0, 1))}, ${Math.min(1, alpha + 0.08).toFixed(3)})`);

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = barGrad;
        ctx.lineWidth = isSubBar ? 1.7 : 2.25 + evalRes.energy * 0.7;
        ctx.stroke();

        // Crisp glowing peak droplet floating off high-energy acoustic peaks
        if (!isSubBar && evalRes.energy > 0.34) {
          const beadR = 1.2 + evalRes.energy * 0.85;
          ctx.beginPath();
          ctx.arc(CENTER + ux * (rTip + 2.3), CENTER + uy * (rTip + 2.3), beadR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${mixRgb(pal.peakRgb, pal.specRgb, 0.58)}, ${(0.76 + evalRes.energy * 0.22).toFixed(3)})`;
          ctx.fill();
        }
      }

      ctx.restore();

      // ── Step 4: Render Front FX Canvas (Sector-Clipped Ripples + Welded Sector Rims + Liquid Core Hub) ──
      if (fxCtx) {
        fxCtx.save();
        fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fxCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        // F1. Internal directional acoustic bloom & concentric pulse ripples CLIPPED STRICTLY TO ACTUAL SECTORS!
        // Never leaks across bilateral 12/6 o'clock notches!
        fxCtx.save();
        fxCtx.beginPath();
        if (morphedSectors.length) {
          for (const ms of morphedSectors) {
            traceOpenSmoothCanvas(fxCtx, ms.canvasOuter, true);
            traceOpenSmoothCanvas(fxCtx, ms.canvasInner, false);
            fxCtx.closePath();
          }
          fxCtx.clip();
        } else {
          traceClosedSmoothPath(fxCtx, innerCutoutPts, false);
          fxCtx.arc(CENTER, CENTER, rInner + 5, 0, Math.PI * 2, true);
          fxCtx.clip('evenodd');
        }

        // Directional acoustic energy wash radiating across the leaned sectors
        if (bias > 0.03) {
          const bloomX = CENTER + Math.cos(targetAngleRad) * (rOuter * 0.62);
          const bloomY = CENTER + Math.sin(targetAngleRad) * (rOuter * 0.62);
          const bloomGrad = fxCtx.createRadialGradient(bloomX, bloomY, 4, bloomX, bloomY, rOuter * 0.9);
          bloomGrad.addColorStop(0, `rgba(${mixRgb(pal.baseRgb, pal.peakRgb, 0.6)}, ${(0.3 * bias).toFixed(3)})`);
          bloomGrad.addColorStop(0.52, `rgba(${pal.baseRgb.join(', ')}, ${(0.14 * bias).toFixed(3)})`);
          bloomGrad.addColorStop(1, `rgba(${pal.baseRgb.join(', ')}, 0)`);
          fxCtx.fillStyle = bloomGrad;
          fxCtx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        }

        // 3 gentle concentric acoustic pulse rings propagating outward inside the obsidian dome
        for (let w = 0; w < 3; w++) {
          const phase = (timeSec * 0.4 + w / 3) % 1;
          const waveR = rInner + 11 + phase * (rOuter - rInner - 15);
          const fade = Math.sin(phase * Math.PI);
          const ringAlpha = fade * (pal.isLight ? 0.24 + bias * 0.14 : 0.22 + bias * 0.2);
          fxCtx.beginPath();
          for (let i = 0; i <= 72; i++) {
            const rad = (i / 72) * Math.PI * 2;
            const localPull = bias > 0.02 ? Math.max(0, Math.cos(rad - targetAngleRad)) : 0;
            const rr = waveR + 1.5 * Math.sin(rad * 4 - timeSec * 2.4 + w) + bias * localPull * 3.6;
            const x = CENTER + Math.cos(rad) * rr;
            const y = CENTER + Math.sin(rad) * rr;
            if (i === 0) fxCtx.moveTo(x, y);
            else fxCtx.lineTo(x, y);
          }
          fxCtx.closePath();
          fxCtx.strokeStyle = `rgba(${mixRgb(pal.baseRgb, pal.peakRgb, bias * 0.5)}, ${ringAlpha.toFixed(3)})`;
          fxCtx.lineWidth = 1.15;
          fxCtx.stroke();
        }
        fxCtx.restore();

        // F2. Welded Luminous Specular Rim Contour traced ONLY along each sector's morphed outer edge!
        // Seamlessly fuses the SVG sectors into the outer fluid wave ribbons without spanning empty notches.
        fxCtx.save();
        const rimGrad = fxCtx.createLinearGradient(
          CENTER - gradDirX * rOuter,
          CENTER - gradDirY * rOuter,
          CENTER + gradDirX * rOuter,
          CENTER + gradDirY * rOuter
        );
        rimGrad.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, ${(pal.rimStrokeAlpha * 0.65).toFixed(3)})`);
        rimGrad.addColorStop(0.55, `rgba(${pal.midRgb.join(', ')}, ${pal.rimStrokeAlpha.toFixed(3)})`);
        rimGrad.addColorStop(1, `rgba(${mixRgb(pal.peakRgb, pal.specRgb, 0.25 + bias * 0.45)}, ${Math.min(1, pal.rimStrokeAlpha + 0.08).toFixed(3)})`);
        fxCtx.strokeStyle = rimGrad;
        fxCtx.lineCap = 'round';
        if (morphedSectors.length) {
          for (const ms of morphedSectors) {
            fxCtx.beginPath();
            traceOpenSmoothCanvas(fxCtx, ms.canvasOuter, true);
            fxCtx.lineWidth = (ms.isActive ? 2.5 : 1.85) + bias * 0.55;
            fxCtx.stroke();
          }
        } else {
          fxCtx.beginPath();
          traceClosedSmoothPath(fxCtx, innerCutoutPts, false);
          fxCtx.lineWidth = 1.85 + bias * 0.55;
          fxCtx.stroke();
        }
        fxCtx.restore();

        // F3. Center Hub Liquid-Glass Acoustic Core & Standing-Wave Channel Ring
        const hubPts = [];
        const hubSteps = 84;
        for (let i = 0; i < hubSteps; i++) {
          const u = (i / hubSteps) * Math.PI * 2;
          const dirPull = bias > 0.01 ? Math.max(0, Math.cos(u - targetAngleRad)) : 0;
          const idleWave =
            1.45 * Math.sin(u * 3 + timeSec * 2.25) +
            0.9 * Math.sin(u * 5 - timeSec * 3.1) +
            0.48 * Math.cos(u * 8 + timeSec * 4.0);
          const pullWave =
            bias * Math.pow(dirPull, 2.0) * (1.75 + 1.05 * Math.sin(u * 10 - timeSec * 6.2));
          const r = rInner + 2.3 + clamp(idleWave * 0.62 + pullWave, -1.2, MAX_INNER_CREST_PX - 1.5);
          hubPts.push({ x: CENTER + Math.cos(u) * r, y: CENTER + Math.sin(u) * r });
        }
        fxCtx.save();
        fxCtx.beginPath();
        traceClosedSmoothPath(fxCtx, hubPts, false);
        const hubStrokeGrad = fxCtx.createLinearGradient(
          CENTER - gradDirX * rInner,
          CENTER - gradDirY * rInner,
          CENTER + gradDirX * rInner,
          CENTER + gradDirY * rInner
        );
        hubStrokeGrad.addColorStop(0, `rgba(${pal.baseRgb.join(', ')}, ${(pal.hubAlpha * 0.72).toFixed(3)})`);
        hubStrokeGrad.addColorStop(1, `rgba(${mixRgb(pal.midRgb, pal.peakRgb, 0.26 + bias * 0.68)}, ${pal.hubAlpha.toFixed(3)})`);
        fxCtx.strokeStyle = hubStrokeGrad;
        fxCtx.lineWidth = 1.85;
        fxCtx.stroke();

        // Delicate top-left convex glass specular crescent inside hub rim for spherical depth
        fxCtx.beginPath();
        fxCtx.arc(CENTER, CENTER, rInner - 2.6, -Math.PI * 0.82, -Math.PI * 0.22);
        fxCtx.strokeStyle = `rgba(${pal.specRgb.join(', ')}, ${pal.isLight ? '0.68' : '0.26'})`;
        fxCtx.lineWidth = 1.3;
        fxCtx.lineCap = 'round';
        fxCtx.stroke();

        // Directional acoustic emitter arc on hub rim channeling energy toward aimed hemisphere
        if (bias > 0.06) {
          const arcSpan = 0.52 + bias * 0.42;
          fxCtx.beginPath();
          fxCtx.arc(CENTER, CENTER, rInner + 0.6, targetAngleRad - arcSpan, targetAngleRad + arcSpan);
          fxCtx.strokeStyle = `rgba(${mixRgb(pal.peakRgb, pal.specRgb, 0.42)}, ${(0.72 + bias * 0.26).toFixed(3)})`;
          fxCtx.lineWidth = 2.6;
          fxCtx.lineCap = 'round';
          fxCtx.stroke();
        }
        fxCtx.restore();

        fxCtx.restore();
      }

      return {
        bias,
        maxRenderedHeight,
        leanedSideCount,
        oppositeSideMax,
        ceilingPx: MAX_OUTER_CREST_PX,
        morphedSectorCount: sectorSpecs.length,
      };
    }

    function tick() {
      rafId = 0;
      if (destroyed || !canvas.isConnected) return;
      drawFrame();
      if (!prefersReducedMotion && typeof win?.requestAnimationFrame === 'function') {
        rafId = win.requestAnimationFrame(tick);
      }
    }

    drawFrame(0, true);
    if (!prefersReducedMotion && typeof win?.requestAnimationFrame === 'function') {
      rafId = win.requestAnimationFrame(tick);
    }

    return {
      setPointerOffset(dx, dy) {
        const scale = Number(options.getScale?.()) || 1;
        targetDx = (Number(dx) || 0) / scale;
        targetDy = (Number(dy) || 0) / scale;
        if (prefersReducedMotion) drawFrame(0.5, true);
      },
      setSubmenuAngle(degOrNull) {
        mutedDeg = typeof degOrNull === 'number' && Number.isFinite(degOrNull) ? degOrNull : null;
      },
      renderAtForTest({ dx = 0, dy = 0, timeSec = 0.6 } = {}) {
        const scale = Number(options.getScale?.()) || 1;
        targetDx = dx / scale;
        targetDy = dy / scale;
        return drawFrame(timeSec, true);
      },
      destroy() {
        destroyed = true;
        if (rafId && typeof win?.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(rafId);
        }
        rafId = 0;
        for (const spec of sectorSpecs) {
          try {
            if (spec.origD) spec.el.setAttribute('d', spec.origD);
          } catch {}
        }
        try { svg?.querySelector?.('.aw-sw-defs')?.remove(); } catch {}
        try { svg?.removeAttribute?.('data-aw-sw-pal'); } catch {}
        try {
          stageEl.style.removeProperty('--aw-sw-sector-fill');
          stageEl.style.removeProperty('--aw-sw-sector-empty-fill');
          stageEl.style.removeProperty('--aw-sw-sector-active-fill');
          stageEl.style.removeProperty('--aw-sw-hub-fill');
          stageEl.style.removeProperty('--aw-sw-hub-active-fill');
        } catch {}
        try { canvas.remove(); } catch {}
        try { fxCanvas.remove(); } catch {}
      },
    };
  }

  return {
    MAX_OUTER_CREST_PX,
    MAX_INNER_CREST_PX,
    isSoundwaveActiveForSettings,
    computeBarHeight,
    computeBodyMorph,
    mountWheelSoundwave,
  };
});
