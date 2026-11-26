import path from 'node:path';
import { escapeHtml } from './security.mjs';
import {
  collectText,
  findAll,
  findChild,
  findChildren,
  getAttr,
  parseRelsXml,
  parseXml,
  pruneAlternateContent,
  resolveZipRelPath,
} from './zip_xml.mjs';

const DEFAULT_SLIDE_CX = 12192000; // 16:9 widescreen (13.333 in * 914400 EMU/in)
const DEFAULT_SLIDE_CY = 6858000;  // 7.5 in * 914400 EMU/in
const EMU_PER_PT = 12700;

const PRESET_COLOR_HEX = Object.freeze({
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  green: '#008000',
  blue: '#0000FF',
  yellow: '#FFFF00',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  gray: '#808080',
  grey: '#808080',
  lightgray: '#D3D3D3',
  lightgrey: '#D3D3D3',
  darkgray: '#A9A9A9',
  darkgrey: '#A9A9A9',
  orange: '#FFA500',
  purple: '#800080',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  silver: '#C0C0C0',
  gold: '#FFD700',
  coral: '#FF7F50',
  crimson: '#DC143C',
  indigo: '#4B0082',
  pink: '#FFC0CB',
  brown: '#A52A2A',
  skyblue: '#87CEEB',
  steelblue: '#4682B4',
  royalblue: '#4169E1',
  dodgerblue: '#1E90FF',
  seagreen: '#2E8B57',
  limegreen: '#32CD32',
  tomato: '#FF6347',
  slateblue: '#6A5ACD',
});

const DEFAULT_THEME_COLORS = Object.freeze({
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#1F497D',
  lt2: '#EEECE1',
  accent1: '#4F81BD',
  accent2: '#C0504D',
  accent3: '#9BBB59',
  accent4: '#8064A2',
  accent5: '#4BACC6',
  accent6: '#F79646',
  hlink: '#0000FF',
  folHlink: '#800080',
});

const DEFAULT_CLR_MAP = Object.freeze({
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
});

function cleanHex6(raw) {
  const s = String(raw || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toUpperCase();
  }
  return '';
}

function hexToRgb(hex) {
  const h = cleanHex6(hex);
  if (!h) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const to2 = (v) => clamp(v).toString(16).padStart(2, '0').toUpperCase();
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const hh = ((h % 1) + 1) % 1;
  const ss = clamp01(s);
  const ll = clamp01(l);
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  return {
    r: Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hh) * 255),
    b: Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
  };
}

function applyDrawingColorTransforms(baseHex, colorElem) {
  if (!baseHex) return null;
  let { r, g, b } = hexToRgb(baseHex);
  let alpha = 1;

  for (const ch of colorElem?.children || []) {
    if (!ch || ch.text !== undefined) continue;
    const rawVal = Number(getAttr(ch, 'val'));
    if (!Number.isFinite(rawVal)) continue;
    const ratio = rawVal / 100000;
    switch (ch.local) {
      case 'tint': {
        // OOXML tint mixes channel towards 255 in sRGB space
        const t = Math.max(0, Math.min(1, ratio));
        r = r * t + 255 * (1 - t);
        g = g * t + 255 * (1 - t);
        b = b * t + 255 * (1 - t);
        break;
      }
      case 'shade': {
        const s = Math.max(0, Math.min(1, ratio));
        r *= s;
        g *= s;
        b *= s;
        break;
      }
      case 'lumMod': {
        const hsl = rgbToHsl(r, g, b);
        hsl.l = Math.max(0, Math.min(1, hsl.l * ratio));
        ({ r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l));
        break;
      }
      case 'lumOff': {
        const hsl = rgbToHsl(r, g, b);
        hsl.l = Math.max(0, Math.min(1, hsl.l + ratio));
        ({ r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l));
        break;
      }
      case 'satMod': {
        const hsl = rgbToHsl(r, g, b);
        hsl.s = Math.max(0, Math.min(1, hsl.s * ratio));
        ({ r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l));
        break;
      }
      case 'satOff': {
        const hsl = rgbToHsl(r, g, b);
        hsl.s = Math.max(0, Math.min(1, hsl.s + ratio));
        ({ r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l));
        break;
      }
      case 'alpha': {
        alpha = Math.max(0, Math.min(1, ratio));
        break;
      }
      default:
        break;
    }
  }

  const hex = rgbToHex(r, g, b);
  const css =
    alpha < 0.995
      ? `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Number(alpha.toFixed(3))})`
      : hex;
  return { hex, alpha, css };
}

/**
 * Parses an OOXML `theme1.xml` (shared across PPTX, DOCX, and XLSX!).
 */
export function parseOoxmlTheme(zip, themePath = 'ppt/theme/theme1.xml') {
  const colors = { ...DEFAULT_THEME_COLORS };
  const fonts = { majorLatin: '', majorEa: '', minorLatin: '', minorEa: '' };
  const xml = zip.getEntryText(themePath);
  if (!xml) return { colors, fonts };

  const root = pruneAlternateContent(parseXml(xml));
  const clrScheme = findAll(root, 'clrScheme')[0];
  if (clrScheme) {
    for (const key of Object.keys(DEFAULT_THEME_COLORS)) {
      const slot = findChild(clrScheme, key);
      if (!slot) continue;
      const srgb = findChild(slot, 'srgbClr');
      const sys = findChild(slot, 'sysClr');
      const hex = cleanHex6(getAttr(srgb, 'val') || getAttr(sys, 'lastClr'));
      if (hex) colors[key] = hex;
    }
  }

  const fontScheme = findAll(root, 'fontScheme')[0];
  if (fontScheme) {
    const major = findChild(fontScheme, 'majorFont');
    const minor = findChild(fontScheme, 'minorFont');
    if (major) {
      fonts.majorLatin = getAttr(findChild(major, 'latin'), 'typeface');
      fonts.majorEa = getAttr(findChild(major, 'ea'), 'typeface');
    }
    if (minor) {
      fonts.minorLatin = getAttr(findChild(minor, 'latin'), 'typeface');
      fonts.minorEa = getAttr(findChild(minor, 'ea'), 'typeface');
    }
  }

  return { colors, fonts };
}

export function resolveDrawingColorFromContainer(containerNode, theme, clrMap = DEFAULT_CLR_MAP, phClrHex = '') {
  if (!containerNode || !Array.isArray(containerNode.children)) return null;
  for (const ch of containerNode.children) {
    if (!ch || ch.text !== undefined) continue;
    let baseHex = '';
    if (ch.local === 'srgbClr') {
      baseHex = cleanHex6(getAttr(ch, 'val'));
    } else if (ch.local === 'sysClr') {
      const last = cleanHex6(getAttr(ch, 'lastClr'));
      const sysName = String(getAttr(ch, 'val') || '').toLowerCase();
      baseHex = last || (sysName.includes('windowtext') ? '#000000' : sysName.includes('window') ? '#FFFFFF' : '#000000');
    } else if (ch.local === 'prstClr') {
      const pName = String(getAttr(ch, 'val') || '').toLowerCase();
      baseHex = PRESET_COLOR_HEX[pName] || '';
    } else if (ch.local === 'scrgbClr') {
      const r = Math.round((Number(getAttr(ch, 'r') || 0) / 100000) * 255);
      const g = Math.round((Number(getAttr(ch, 'g') || 0) / 100000) * 255);
      const b = Math.round((Number(getAttr(ch, 'b') || 0) / 100000) * 255);
      baseHex = rgbToHex(r, g, b);
    } else if (ch.local === 'schemeClr') {
      const rawKey = getAttr(ch, 'val');
      if (rawKey === 'phClr' && phClrHex) {
        baseHex = phClrHex;
      } else {
        const mapped = (clrMap && clrMap[rawKey]) || DEFAULT_CLR_MAP[rawKey] || rawKey;
        baseHex = theme?.colors?.[mapped] || DEFAULT_THEME_COLORS[mapped] || '';
      }
    }
    if (baseHex) {
      return applyDrawingColorTransforms(baseHex, ch);
    }
  }
  return null;
}

function parseClrMap(node, fallback = DEFAULT_CLR_MAP) {
  const out = { ...fallback };
  if (!node) return out;
  for (const k of Object.keys(DEFAULT_CLR_MAP)) {
    const v = getAttr(node, k);
    if (v) out[k] = v;
  }
  return out;
}

function resolveFillCss(propContainer, { theme, clrMap, rels, baseXmlPath, media, styleRefNode, phClrHex = '' } = {}) {
  if (propContainer) {
    if (findChild(propContainer, 'noFill')) {
      return { kind: 'none', css: 'transparent' };
    }
    const solid = findChild(propContainer, 'solidFill');
    if (solid) {
      const c = resolveDrawingColorFromContainer(solid, theme, clrMap, phClrHex);
      if (c) return { kind: 'solid', css: c.css, hex: c.hex, alpha: c.alpha };
    }
    const grad = findChild(propContainer, 'gradFill');
    if (grad) {
      const gsLst = findChild(grad, 'gsLst');
      const stops = [];
      for (const gs of findChildren(gsLst, 'gs')) {
        const pos = Math.max(0, Math.min(100, Number(getAttr(gs, 'pos') || 0) / 1000));
        const col = resolveDrawingColorFromContainer(gs, theme, clrMap, phClrHex);
        if (col) stops.push({ pos, css: col.css, hex: col.hex });
      }
      if (stops.length >= 2) {
        stops.sort((a, b) => a.pos - b.pos);
        const lin = findChild(grad, 'lin');
        const pathNode = findChild(grad, 'path');
        const stopStr = stops.map((s) => `${s.css} ${s.pos.toFixed(1)}%`).join(', ');
        if (pathNode) {
          return { kind: 'gradient', css: `radial-gradient(circle at center, ${stopStr})`, hex: stops[0].hex };
        }
        // OOXML angle: 0 = left-to-right (CSS 90deg), 5400000 (90deg) = top-to-bottom (CSS 180deg)
        const ooxmlDeg = lin ? Number(getAttr(lin, 'ang') || 0) / 60000 : 90;
        const cssDeg = (ooxmlDeg + 90) % 360;
        return { kind: 'gradient', css: `linear-gradient(${cssDeg.toFixed(1)}deg, ${stopStr})`, hex: stops[0].hex };
      } else if (stops.length === 1) {
        return { kind: 'solid', css: stops[0].css, hex: stops[0].hex };
      }
    }
    const blipFill = findChild(propContainer, 'blipFill');
    if (blipFill && rels && media && baseXmlPath) {
      const blip = findChild(blipFill, 'blip');
      const svgBlip = blip ? findAll(blip, 'svgBlip')[0] : null;
      const rid = getAttr(svgBlip, 'embed') || getAttr(blip, 'embed');
      const rel = rid ? rels.get(rid) : null;
      if (rel && !rel.external) {
        const imgPath = resolveZipRelPath(baseXmlPath, rel.target);
        const loaded = media.loadImageDataUrl(imgPath);
        if (loaded.ok) {
          return {
            kind: 'image',
            dataUrl: loaded.dataUrl,
            css: `url("${loaded.dataUrl}") center / cover no-repeat`,
          };
        }
      }
    }
  }

  // Fallback to `<p:style><a:fillRef idx="..."/>`
  if (styleRefNode) {
    const fillRef = findChild(styleRefNode, 'fillRef');
    const idx = Number(getAttr(fillRef, 'idx') || 0);
    if (idx > 0 && idx < 1000) {
      const c = resolveDrawingColorFromContainer(fillRef, theme, clrMap);
      if (c) return { kind: 'solid', css: c.css, hex: c.hex, alpha: c.alpha };
    }
  }

  return null;
}

function resolveStrokeSpec(spPr, styleRefNode, theme, clrMap) {
  const ln = findChild(spPr, 'ln');
  if (ln && findChild(ln, 'noFill')) return null;

  let widthEmu = ln ? Number(getAttr(ln, 'w') || 0) : 0;
  let colorObj = null;
  let dash = '';
  let headArrow = false;
  let tailArrow = false;

  if (ln) {
    const solid = findChild(ln, 'solidFill');
    if (solid) colorObj = resolveDrawingColorFromContainer(solid, theme, clrMap);
    const prstDash = getAttr(findChild(ln, 'prstDash'), 'val');
    if (prstDash && prstDash !== 'solid') dash = prstDash;
    const headEnd = findChild(ln, 'headEnd');
    const tailEnd = findChild(ln, 'tailEnd');
    if (headEnd && getAttr(headEnd, 'type') && getAttr(headEnd, 'type') !== 'none') headArrow = true;
    if (tailEnd && getAttr(tailEnd, 'type') && getAttr(tailEnd, 'type') !== 'none') tailArrow = true;
  }

  if (!colorObj && styleRefNode) {
    const lnRef = findChild(styleRefNode, 'lnRef');
    const idx = Number(getAttr(lnRef, 'idx') || 0);
    if (idx > 0) {
      colorObj = resolveDrawingColorFromContainer(lnRef, theme, clrMap);
      if (!widthEmu) widthEmu = idx * 9525;
    }
  }

  if (!colorObj) return null;
  const pt = Math.max(0.6, (widthEmu || 12700) / EMU_PER_PT);
  return {
    pt,
    css: colorObj.css,
    hex: colorObj.hex,
    dash,
    headArrow,
    tailArrow,
  };
}

function parseSlideBackground(rootNode, ctx) {
  const bg = findAll(rootNode, 'bg')[0];
  if (!bg) return null;
  const bgPr = findChild(bg, 'bgPr');
  if (bgPr) {
    const f = resolveFillCss(bgPr, ctx);
    if (f && f.kind !== 'none') return f;
  }
  const bgRef = findChild(bg, 'bgRef');
  if (bgRef) {
    const idx = Number(getAttr(bgRef, 'idx') || 0);
    if (idx > 0 && idx !== 1000) {
      const c = resolveDrawingColorFromContainer(bgRef, ctx.theme, ctx.clrMap);
      if (c) return { kind: 'solid', css: c.css, hex: c.hex };
    }
  }
  return null;
}

function parseLstStyleLevels(lstStyleNode, theme, clrMap) {
  const levels = {};
  if (!lstStyleNode) return levels;
  const defPPr = findChild(lstStyleNode, 'defPPr');
  if (defPPr) levels[0] = parsePptParaProps(defPPr, theme, clrMap);
  for (let l = 1; l <= 9; l++) {
    const lp = findChild(lstStyleNode, `lvl${l}pPr`);
    if (lp) levels[l - 1] = parsePptParaProps(lp, theme, clrMap);
  }
  return levels;
}

function parsePptRunProps(rPrNode, theme, clrMap) {
  const out = {};
  if (!rPrNode) return out;
  const sz = Number(getAttr(rPrNode, 'sz'));
  if (Number.isFinite(sz) && sz > 0) out.fontPt = sz / 100;
  if (getAttr(rPrNode, 'b') === '1' || getAttr(rPrNode, 'b') === 'true') out.bold = true;
  else if (getAttr(rPrNode, 'b') === '0' || getAttr(rPrNode, 'b') === 'false') out.bold = false;
  if (getAttr(rPrNode, 'i') === '1' || getAttr(rPrNode, 'i') === 'true') out.italic = true;
  const u = getAttr(rPrNode, 'u');
  if (u && u !== 'none') out.underline = true;
  const strike = getAttr(rPrNode, 'strike');
  if (strike && strike !== 'noStrike') out.strike = true;
  const baseline = Number(getAttr(rPrNode, 'baseline'));
  if (Number.isFinite(baseline) && baseline !== 0) out.baseline = baseline;

  const solid = findChild(rPrNode, 'solidFill');
  if (solid) {
    const col = resolveDrawingColorFromContainer(solid, theme, clrMap);
    if (col) out.color = col.css;
  }
  const hl = findChild(rPrNode, 'highlight');
  if (hl) {
    const col = resolveDrawingColorFromContainer(hl, theme, clrMap);
    if (col) out.highlight = col.css;
  }
  const ea = getAttr(findChild(rPrNode, 'ea'), 'typeface');
  const latin = getAttr(findChild(rPrNode, 'latin'), 'typeface');
  const rawFont = ea || latin;
  if (rawFont) {
    if (rawFont === '+mj-ea' || rawFont === '+mj-lt') {
      out.fontFamily = theme?.fonts?.majorEa || theme?.fonts?.majorLatin || '';
    } else if (rawFont === '+mn-ea' || rawFont === '+mn-lt') {
      out.fontFamily = theme?.fonts?.minorEa || theme?.fonts?.minorLatin || '';
    } else {
      out.fontFamily = rawFont;
    }
  }
  return out;
}

function parsePptParaProps(pPrNode, theme, clrMap) {
  const out = {};
  if (!pPrNode) return out;
  const lvl = Number(getAttr(pPrNode, 'lvl'));
  if (Number.isFinite(lvl) && lvl >= 0 && lvl <= 8) out.lvl = lvl;
  const algn = getAttr(pPrNode, 'algn');
  if (algn) out.algn = algn; // l, ctr, r, just, dist
  if (findChild(pPrNode, 'buNone')) out.buNone = true;
  const buChar = getAttr(findChild(pPrNode, 'buChar'), 'char');
  if (buChar) out.buChar = buChar;
  const buAuto = findChild(pPrNode, 'buAutoNum');
  if (buAuto) out.buAutoType = getAttr(buAuto, 'type') || 'arabicPeriod';

  const spcBef = findChild(pPrNode, 'spcBef');
  if (spcBef) {
    const pts = Number(getAttr(findChild(spcBef, 'spcPts'), 'val'));
    if (Number.isFinite(pts) && pts >= 0) out.spaceBeforePt = pts / 100;
  }
  const spcAft = findChild(pPrNode, 'spcAft');
  if (spcAft) {
    const pts = Number(getAttr(findChild(spcAft, 'spcPts'), 'val'));
    if (Number.isFinite(pts) && pts >= 0) out.spaceAfterPt = pts / 100;
  }
  const lnSpc = findChild(pPrNode, 'lnSpc');
  if (lnSpc) {
    const pct = Number(getAttr(findChild(lnSpc, 'spcPct'), 'val'));
    if (Number.isFinite(pct) && pct > 40000 && pct < 400000) out.lineHeight = pct / 100000;
  }

  const defRPr = findChild(pPrNode, 'defRPr');
  if (defRPr) out.defRPr = parsePptRunProps(defRPr, theme, clrMap);
  return out;
}

function parseXfrmBox(xfrmNode) {
  if (!xfrmNode) return null;
  const off = findChild(xfrmNode, 'off');
  const ext = findChild(xfrmNode, 'ext');
  if (!off || !ext) return null;
  const x = Number(getAttr(off, 'x'));
  const y = Number(getAttr(off, 'y'));
  const cx = Number(getAttr(ext, 'cx'));
  const cy = Number(getAttr(ext, 'cy'));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const rotRaw = Number(getAttr(xfrmNode, 'rot') || 0);
  const rotDeg = Number.isFinite(rotRaw) ? rotRaw / 60000 : 0;
  const flipH = getAttr(xfrmNode, 'flipH') === '1' || getAttr(xfrmNode, 'flipH') === 'true';
  const flipV = getAttr(xfrmNode, 'flipV') === '1' || getAttr(xfrmNode, 'flipV') === 'true';
  return { x, y, cx, cy, rotDeg, flipH, flipV };
}

function mapBoxThroughGroup(box, groupMap) {
  if (!box || !groupMap) return box;
  const scaleX = groupMap.chExtCx > 0 ? groupMap.gcx / groupMap.chExtCx : 1;
  const scaleY = groupMap.chExtCy > 0 ? groupMap.gcy / groupMap.chExtCy : 1;
  return {
    x: groupMap.gx + (box.x - groupMap.chOffX) * scaleX,
    y: groupMap.gy + (box.y - groupMap.chOffY) * scaleY,
    cx: box.cx * scaleX,
    cy: box.cy * scaleY,
    rotDeg: (box.rotDeg || 0) + (groupMap.rotDeg || 0),
    flipH: Boolean(box.flipH !== groupMap.flipH),
    flipV: Boolean(box.flipV !== groupMap.flipV),
  };
}

function extractPlaceholderKey(spNode) {
  const nvPr = findAll(spNode, 'nvPr')[0];
  const ph = nvPr ? findChild(nvPr, 'ph') : null;
  if (!ph) return null;
  const type = getAttr(ph, 'type') || '';
  const idx = getAttr(ph, 'idx') || '';
  return { type, idx };
}

function indexSlidePlaceholders(rootNode, theme, clrMap) {
  const byTypeIdx = new Map();
  const byIdx = new Map();
  const byType = new Map();
  const spTree = findAll(rootNode, 'spTree')[0];
  if (!spTree) return { byTypeIdx, byIdx, byType };

  for (const ch of spTree.children || []) {
    if (!ch || ch.local !== 'sp') continue;
    const ph = extractPlaceholderKey(ch);
    if (!ph) continue;
    const spPr = findChild(ch, 'spPr');
    const xfrm = parseXfrmBox(findChild(spPr, 'xfrm'));
    const txBody = findChild(ch, 'txBody');
    const bodyPr = findChild(txBody, 'bodyPr');
    const lstLevels = parseLstStyleLevels(findChild(txBody, 'lstStyle'), theme, clrMap);
    const rec = { ph, xfrm, spPr, bodyPr, lstLevels, spNode: ch };
    if (ph.type && ph.idx) byTypeIdx.set(`${ph.type}:${ph.idx}`, rec);
    if (ph.idx && !byIdx.has(ph.idx)) byIdx.set(ph.idx, rec);
    if (ph.type && !byType.has(ph.type)) byType.set(ph.type, rec);
  }
  return { byTypeIdx, byIdx, byType };
}

function lookupInheritedPlaceholder(ph, layoutPhMap, masterPhMap) {
  if (!ph) return { layoutRec: null, masterRec: null };
  const findIn = (m) => {
    if (!m) return null;
    if (ph.type && ph.idx && m.byTypeIdx.has(`${ph.type}:${ph.idx}`)) return m.byTypeIdx.get(`${ph.type}:${ph.idx}`);
    if (ph.idx && m.byIdx.has(ph.idx)) return m.byIdx.get(ph.idx);
    if (ph.type && m.byType.has(ph.type)) return m.byType.get(ph.type);
    if (ph.type === 'ctrTitle' && m.byType.has('title')) return m.byType.get('title');
    if (ph.type === 'subTitle' && m.byType.has('body')) return m.byType.get('body');
    if (!ph.type && m.byType.has('body')) return m.byType.get('body');
    return null;
  };
  return {
    layoutRec: findIn(layoutPhMap),
    masterRec: findIn(masterPhMap),
  };
}

function fallbackPlaceholderBox(ph, slideCx, slideCy) {
  if (!ph) return null;
  if (ph.type === 'ctrTitle') {
    return { x: slideCx * 0.08, y: slideCy * 0.28, cx: slideCx * 0.84, cy: slideCy * 0.24, rotDeg: 0 };
  }
  if (ph.type === 'title') {
    return { x: slideCx * 0.06, y: slideCy * 0.06, cx: slideCx * 0.88, cy: slideCy * 0.16, rotDeg: 0 };
  }
  if (ph.type === 'subTitle') {
    return { x: slideCx * 0.1, y: slideCy * 0.54, cx: slideCx * 0.8, cy: slideCy * 0.18, rotDeg: 0 };
  }
  if (ph.type === 'sldNum') {
    return { x: slideCx * 0.86, y: slideCy * 0.91, cx: slideCx * 0.09, cy: slideCy * 0.05, rotDeg: 0 };
  }
  if (ph.type === 'ftr') {
    return { x: slideCx * 0.3, y: slideCy * 0.91, cx: slideCx * 0.4, cy: slideCy * 0.05, rotDeg: 0 };
  }
  if (ph.type === 'dt') {
    return { x: slideCx * 0.05, y: slideCy * 0.91, cx: slideCx * 0.2, cy: slideCy * 0.05, rotDeg: 0 };
  }
  return { x: slideCx * 0.06, y: slideCy * 0.24, cx: slideCx * 0.88, cy: slideCy * 0.64, rotDeg: 0 };
}

function buildPresetGeometrySvg(prst, spPr, fillSpec, strokeSpec, uid) {
  const geom = String(prst || 'rect');
  const hasFill = Boolean(fillSpec && fillSpec.kind !== 'none');
  const hasStroke = Boolean(strokeSpec);
  if (!hasFill && !hasStroke && geom === 'rect') return '';

  // Simple rect / roundRect without complex SVG paths can use pure CSS unless gradient/arrow/non-rect
  const isLine = geom === 'line' || geom.includes('Connector') || geom === 'straightConnector1';

  let defs = '';
  let fillAttr = 'none';
  if (fillSpec?.kind === 'solid') {
    fillAttr = fillSpec.css;
  } else if (fillSpec?.kind === 'gradient' && spPr) {
    const grad = findChild(spPr, 'gradFill');
    const gsLst = findChild(grad, 'gsLst');
    const stops = findChildren(gsLst, 'gs');
    if (stops.length >= 2) {
      const gradId = `aw-sg-${uid}`;
      const lin = findChild(grad, 'lin');
      const ang = lin ? (Number(getAttr(lin, 'ang') || 0) / 60000) * (Math.PI / 180) : Math.PI / 2;
      const x1 = (50 - Math.cos(ang) * 50).toFixed(1);
      const y1 = (50 - Math.sin(ang) * 50).toFixed(1);
      const x2 = (50 + Math.cos(ang) * 50).toFixed(1);
      const y2 = (50 + Math.sin(ang) * 50).toFixed(1);
      // Re-extract stop colors via CSS fallback if simple; for SVG, CSS background on wrapper handles rect/roundRect/ellipse cleanly!
      defs += `<linearGradient id="${gradId}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"></linearGradient>`;
    }
    fillAttr = fillSpec.hex || '#4F81BD';
  }

  const strokeAttr = hasStroke ? strokeSpec.css : 'none';
  const sw = hasStroke ? Math.max(1.2, Math.min(18, strokeSpec.pt * 1.35)).toFixed(2) : '0';
  const dashAttr =
    hasStroke && strokeSpec.dash
      ? strokeSpec.dash.includes('dot')
        ? ' stroke-dasharray="3,4"'
        : ' stroke-dasharray="8,5"'
      : '';

  let markerStart = '';
  let markerEnd = '';
  if (hasStroke && (strokeSpec.headArrow || strokeSpec.tailArrow)) {
    if (strokeSpec.headArrow) {
      const mid = `aw-mh-${uid}`;
      defs += `<marker id="${mid}" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="${escapeHtml(strokeSpec.css)}"/></marker>`;
      markerStart = ` marker-start="url(#${mid})"`;
    }
    if (strokeSpec.tailArrow) {
      const mid = `aw-mt-${uid}`;
      defs += `<marker id="${mid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 1 L 10 5 L 0 9 z" fill="${escapeHtml(strokeSpec.css)}"/></marker>`;
      markerEnd = ` marker-end="url(#${mid})"`;
    }
  }

  let shapeEl = '';
  switch (geom) {
    case 'line':
    case 'straightConnector1':
    case 'bentConnector2':
    case 'bentConnector3':
    case 'curvedConnector3':
      shapeEl = `<line x1="0" y1="0" x2="1000" y2="1000" stroke="${escapeHtml(strokeAttr === 'none' ? '#64748B' : strokeAttr)}" stroke-width="${sw || '2'}" vector-effect="non-scaling-stroke"${dashAttr}${markerStart}${markerEnd}/>`;
      break;
    case 'ellipse':
      shapeEl = `<ellipse cx="500" cy="500" rx="496" ry="496" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'triangle':
    case 'isoscelesTriangle':
      shapeEl = `<polygon points="500,8 992,992 8,992" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'rtTriangle':
      shapeEl = `<polygon points="8,8 992,992 8,992" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'diamond':
      shapeEl = `<polygon points="500,8 992,500 500,992 8,500" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'parallelogram':
      shapeEl = `<polygon points="180,8 992,8 820,992 8,992" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'trapezoid':
      shapeEl = `<polygon points="180,8 820,8 992,992 8,992" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'pentagon':
      shapeEl = `<polygon points="500,8 992,380 805,992 195,992 8,380" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'hexagon':
      shapeEl = `<polygon points="220,8 780,8 992,500 780,992 220,992 8,500" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'chevron':
      shapeEl = `<polygon points="8,8 760,8 992,500 760,992 8,992 240,500" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'homePlate':
      shapeEl = `<polygon points="8,8 780,8 992,500 780,992 8,992" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'rightArrow':
      shapeEl = `<polygon points="8,260 680,260 680,40 992,500 680,960 680,740 8,740" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'leftArrow':
      shapeEl = `<polygon points="992,260 320,260 320,40 8,500 320,960 320,740 992,740" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'upArrow':
      shapeEl = `<polygon points="260,992 260,320 40,320 500,8 960,320 740,320 740,992" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'downArrow':
      shapeEl = `<polygon points="260,8 260,680 40,680 500,992 960,680 740,680 740,8" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    case 'star5':
      shapeEl = `<polygon points="500,10 618,360 985,360 688,576 800,940 500,715 200,940 312,576 15,360 382,360" fill="${escapeHtml(fillAttr)}" stroke="${escapeHtml(strokeAttr)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${dashAttr}/>`;
      break;
    default:
      return isLine
        ? `<svg class="aw-ppt-geom-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ''}<line x1="0" y1="0" x2="1000" y2="1000" stroke="${escapeHtml(strokeAttr === 'none' ? '#64748B' : strokeAttr)}" stroke-width="${sw || '2'}" vector-effect="non-scaling-stroke"${markerStart}${markerEnd}/></svg>`
        : '';
  }

  return `<svg class="aw-ppt-geom-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ''}${shapeEl}</svg>`;
}

function formatCqwFromPt(pt, slideWidthPt) {
  const pct = (pt / Math.max(100, slideWidthPt)) * 100;
  return `${pct.toFixed(4)}cqw`;
}

function estimateColorLuma(cssColor) {
  const mHex = /^#([0-9a-fA-F]{6})$/.exec(String(cssColor || '').trim());
  if (mHex) {
    const r = parseInt(mHex[1].slice(0, 2), 16) / 255;
    const g = parseInt(mHex[1].slice(2, 4), 16) / 255;
    const b = parseInt(mHex[1].slice(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const mRgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(cssColor || ''));
  if (mRgba) {
    return (0.299 * Number(mRgba[1]) + 0.587 * Number(mRgba[2]) + 0.114 * Number(mRgba[3])) / 255;
  }
  return 1;
}

function renderRichTxBody(txBodyNode, {
  slideWidthPt,
  theme,
  clrMap,
  inheritedLevels = {},
  masterLevels = {},
  defaultFontPt = 18,
  defaultAlign = 'l',
  defaultTextColor = '#111827',
  slideIndex = 1,
} = {}) {
  if (!txBodyNode) return { html: '', plain: [] };
  const shapeLevels = parseLstStyleLevels(findChild(txBodyNode, 'lstStyle'), theme, clrMap);
  const parasHtml = [];
  const plainLines = [];
  let autoNumCounter = 0;

  for (const p of findChildren(txBodyNode, 'p')) {
    const directPPr = parsePptParaProps(findChild(p, 'pPr'), theme, clrMap);
    const lvl = directPPr.lvl ?? 0;
    const mLvl = masterLevels[lvl] || masterLevels[0] || {};
    const iLvl = inheritedLevels[lvl] || inheritedLevels[0] || {};
    const sLvl = shapeLevels[lvl] || shapeLevels[0] || {};
    const mergedP = { ...mLvl, ...iLvl, ...sLvl, ...directPPr };
    const baseRPr = {
      ...(mLvl.defRPr || {}),
      ...(iLvl.defRPr || {}),
      ...(sLvl.defRPr || {}),
      ...(directPPr.defRPr || {}),
    };

    const runSpans = [];
    let rawLine = '';
    for (const ch of p.children || []) {
      if (!ch || ch.text !== undefined) continue;
      if (ch.local === 'r' || ch.local === 'fld') {
        const rPr = parsePptRunProps(findChild(ch, 'rPr'), theme, clrMap);
        let txt = collectText(findChild(ch, 't'));
        if (ch.local === 'fld' && /slidenum/i.test(getAttr(ch, 'type')) && !txt.trim()) {
          txt = String(slideIndex);
        }
        if (!txt) continue;
        rawLine += txt;
        const rMerged = { ...baseRPr, ...rPr };
        const pt = Math.max(7, Math.min(120, Number(rMerged.fontPt || defaultFontPt)));
        const styles = [`font-size:${formatCqwFromPt(pt, slideWidthPt)}`];
        if (rMerged.bold) styles.push('font-weight:700');
        if (rMerged.italic) styles.push('font-style:italic');
        const decs = [];
        if (rMerged.underline) decs.push('underline');
        if (rMerged.strike) decs.push('line-through');
        if (decs.length) styles.push(`text-decoration:${decs.join(' ')}`);
        styles.push(`color:${rMerged.color || defaultTextColor}`);
        if (rMerged.highlight) styles.push(`background:${rMerged.highlight}`);
        if (rMerged.fontFamily) {
          const cleanFf = rMerged.fontFamily.replace(/["<>]/g, '');
          if (cleanFf) styles.push(`font-family:"${cleanFf}",var(--aw-font-sans)`);
        }
        let inner = escapeHtml(txt);
        if (rMerged.baseline > 0) inner = `<sup>${inner}</sup>`;
        else if (rMerged.baseline < 0) inner = `<sub>${inner}</sub>`;
        runSpans.push(`<span style="${styles.join(';')}">${inner}</span>`);
      } else if (ch.local === 'br') {
        runSpans.push('<br/>');
        rawLine += '\n';
      }
    }

    const clean = rawLine.trim();
    if (!clean) {
      // Preserve intentional vertical blank spacer line inside textboxes proportionally
      const spPt = Math.max(6, Number(baseRPr.fontPt || defaultFontPt) * 0.55);
      parasHtml.push(`<div class="aw-ppt-empty-p" style="height:${formatCqwFromPt(spPt, slideWidthPt)}"></div>`);
      continue;
    }

    plainLines.push(clean);

    const pStyles = [];
    const algn = mergedP.algn || defaultAlign;
    if (algn === 'ctr') pStyles.push('text-align:center;justify-content:center');
    else if (algn === 'r') pStyles.push('text-align:right;justify-content:flex-end');
    else if (algn === 'just' || algn === 'dist') pStyles.push('text-align:justify');
    if (mergedP.lineHeight) pStyles.push(`line-height:${mergedP.lineHeight.toFixed(2)}`);
    if (mergedP.spaceBeforePt) pStyles.push(`margin-top:${formatCqwFromPt(mergedP.spaceBeforePt, slideWidthPt)}`);
    if (mergedP.spaceAfterPt) pStyles.push(`margin-bottom:${formatCqwFromPt(mergedP.spaceAfterPt, slideWidthPt)}`);
    if (lvl > 0) pStyles.push(`padding-left:${formatCqwFromPt(lvl * 14, slideWidthPt)}`);

    let bulletHtml = '';
    if (!mergedP.buNone && (mergedP.buChar || mergedP.buAutoType)) {
      autoNumCounter++;
      const buPt = Math.max(7, Number(baseRPr.fontPt || defaultFontPt));
      const buColor = baseRPr.color || defaultTextColor;
      const markerText = mergedP.buAutoType ? `${autoNumCounter}.` : mergedP.buChar;
      bulletHtml = `<span class="aw-ppt-bu" style="font-size:${formatCqwFromPt(buPt, slideWidthPt)};color:${buColor}">${escapeHtml(markerText)}</span>`;
    } else {
      autoNumCounter = 0;
    }

    parasHtml.push(
      `<div class="aw-ppt-p" style="${pStyles.join(';')}">${bulletHtml}<span class="aw-ppt-runs">${runSpans.join('')}</span></div>`
    );
  }

  return { html: parasHtml.join(''), plain: plainLines };
}

// ── Native OOXML Chart (`ppt/charts/chart*.xml`) SVG Renderer ───────────────

const CHART_FALLBACK_PALETTE = ['#4F81BD', '#C0504D', '#9BBB59', '#8064A2', '#4BACC6', '#F79646'];

function extractChartPoints(cacheParent, tagLocal = 'numCache') {
  const cache = findAll(cacheParent, tagLocal)[0] || findAll(cacheParent, 'strCache')[0];
  if (!cache) return [];
  const pts = [];
  for (const pt of findChildren(cache, 'pt')) {
    const idx = Number(getAttr(pt, 'idx') || pts.length);
    const v = collectText(findChild(pt, 'v')).trim();
    pts[idx] = v;
  }
  return pts;
}

function renderOoxmlChartSvg(chartXmlStr, theme, clrMap) {
  if (!chartXmlStr) return { html: '', plain: [] };
  const root = pruneAlternateContent(parseXml(chartXmlStr));
  const titleNode = findAll(root, 'title')[0];
  const chartTitle = titleNode
    ? findAll(titleNode, 't')
        .map((t) => collectText(t))
        .join('')
        .trim()
    : '';

  const plotArea = findAll(root, 'plotArea')[0];
  if (!plotArea) return { html: '', plain: chartTitle ? [chartTitle] : [] };

  let chartKind = 'bar';
  let barDir = 'col';
  let chartEl =
    findChild(plotArea, 'barChart') ||
    findChild(plotArea, 'bar3DChart') ||
    findChild(plotArea, 'lineChart') ||
    findChild(plotArea, 'line3DChart') ||
    findChild(plotArea, 'areaChart') ||
    findChild(plotArea, 'pieChart') ||
    findChild(plotArea, 'pie3DChart') ||
    findChild(plotArea, 'doughnutChart') ||
    findChild(plotArea, 'scatterChart');

  if (!chartEl) return { html: '', plain: chartTitle ? [chartTitle] : [] };
  if (chartEl.local.startsWith('pie')) chartKind = 'pie';
  else if (chartEl.local.startsWith('doughnut')) chartKind = 'doughnut';
  else if (chartEl.local.startsWith('line') || chartEl.local.startsWith('scatter')) chartKind = 'line';
  else if (chartEl.local.startsWith('area')) chartKind = 'area';
  else {
    chartKind = 'bar';
    barDir = getAttr(findChild(chartEl, 'barDir'), 'val') === 'bar' ? 'bar' : 'col';
  }

  const series = [];
  let categories = [];
  const plain = chartTitle ? [`[图表] ${chartTitle}`] : [];

  const serNodes = findChildren(chartEl, 'ser');
  serNodes.forEach((ser, sIdx) => {
    const txNode = findChild(ser, 'tx');
    const name = txNode ? findAll(txNode, 'v').map((v) => collectText(v)).join('').trim() : `系列 ${sIdx + 1}`;
    const catNode = findChild(ser, 'cat') || findChild(ser, 'xVal');
    if (catNode && !categories.length) {
      categories = extractChartPoints(catNode, 'strCache');
    }
    const valNode = findChild(ser, 'val') || findChild(ser, 'yVal');
    const rawVals = valNode ? extractChartPoints(valNode, 'numCache') : [];
    const nums = rawVals.map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    });
    const spPr = findChild(ser, 'spPr');
    const solid = spPr ? findChild(spPr, 'solidFill') : null;
    const customCol = solid ? resolveDrawingColorFromContainer(solid, theme, clrMap) : null;
    const accentKey = `accent${(sIdx % 6) + 1}`;
    const color = customCol?.hex || theme?.colors?.[accentKey] || CHART_FALLBACK_PALETTE[sIdx % CHART_FALLBACK_PALETTE.length];
    if (nums.length) {
      series.push({ name, nums, color });
      plain.push(`${name}: ${nums.slice(0, 8).join(', ')}`);
    }
  });

  if (!series.length) return { html: '', plain };

  const W = 520;
  const H = 300;
  const parts = [];
  if (chartTitle) {
    parts.push(`<text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="#1E293B">${escapeHtml(chartTitle.slice(0, 48))}</text>`);
  }

  if (chartKind === 'pie' || chartKind === 'doughnut') {
    const first = series[0];
    const total = first.nums.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = 190;
    const cy = 162;
    const r = 92;
    let angle = -Math.PI / 2;
    first.nums.forEach((v, idx) => {
      const val = Math.max(0, v);
      const slice = (val / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + slice);
      const y2 = cy + r * Math.sin(angle + slice);
      const large = slice > Math.PI ? 1 : 0;
      const col = theme?.colors?.[`accent${(idx % 6) + 1}`] || CHART_FALLBACK_PALETTE[idx % CHART_FALLBACK_PALETTE.length];
      if (first.nums.length === 1) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>`);
      } else if (slice > 0.002) {
        parts.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${col}" stroke="#FFFFFF" stroke-width="1.5"/>`);
      }
      const label = categories[idx] || `${idx + 1}`;
      if (idx < 7) {
        const ly = 68 + idx * 26;
        parts.push(`<rect x="325" y="${ly - 9}" width="11" height="11" rx="2" fill="${col}"/>`);
        parts.push(`<text x="342" y="${ly}" font-size="11.5" fill="#334155">${escapeHtml(String(label).slice(0, 14))} (${Math.round((val / total) * 100)}%)</text>`);
      }
      angle += slice;
    });
    if (chartKind === 'doughnut') {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="46" fill="#FFFFFF"/>`);
    }
  } else {
    const padL = 50;
    const padR = 20;
    const padT = chartTitle ? 40 : 22;
    const padB = 54;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const allVals = series.flatMap((s) => s.nums);
    const maxVal = Math.max(1, ...allVals);
    const minVal = Math.min(0, ...allVals);
    const span = maxVal - minVal || 1;
    const count = Math.max(...series.map((s) => s.nums.length), 1);

    // Subtle horizontal gridlines
    for (let g = 0; g <= 4; g++) {
      const gy = padT + (plotH * g) / 4;
      const gv = maxVal - (span * g) / 4;
      parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="#E2E8F0" stroke-width="1"/>`);
      parts.push(`<text x="${padL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748B">${Math.abs(gv) >= 1000 ? `${(gv / 1000).toFixed(1)}k` : Number(gv.toFixed(1))}</text>`);
    }

    const zeroY = padT + ((maxVal - 0) / span) * plotH;
    const groupW = plotW / count;

    if (chartKind === 'bar' && barDir === 'col') {
      const barW = Math.min(34, (groupW * 0.72) / series.length);
      series.forEach((s, sIdx) => {
        s.nums.forEach((v, idx) => {
          const x = padL + idx * groupW + (groupW - barW * series.length) / 2 + sIdx * barW;
          const yVal = padT + ((maxVal - v) / span) * plotH;
          const top = Math.min(zeroY, yVal);
          const h = Math.max(1.5, Math.abs(zeroY - yVal));
          parts.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(2, barW - 1.5).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"/>`);
        });
      });
    } else if (chartKind === 'bar' && barDir === 'bar') {
      const rowH = plotH / count;
      const barH = Math.min(22, (rowH * 0.72) / series.length);
      series.forEach((s, sIdx) => {
        s.nums.forEach((v, idx) => {
          const y = padT + idx * rowH + (rowH - barH * series.length) / 2 + sIdx * barH;
          const w = Math.max(2, (Math.max(0, v) / Math.max(1, maxVal)) * plotW);
          parts.push(`<rect x="${padL}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(2, barH - 1.5).toFixed(1)}" rx="2" fill="${s.color}"/>`);
        });
      });
    } else {
      series.forEach((s) => {
        const pts = s.nums.map((v, idx) => {
          const x = padL + (count === 1 ? plotW / 2 : (idx / (count - 1)) * plotW);
          const y = padT + ((maxVal - v) / span) * plotH;
          return { x, y };
        });
        if (chartKind === 'area' && pts.length >= 2) {
          const areaD = `M ${pts[0].x.toFixed(1)} ${zeroY.toFixed(1)} ` + pts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ` L ${pts[pts.length - 1].x.toFixed(1)} ${zeroY.toFixed(1)} Z`;
          parts.push(`<path d="${areaD}" fill="${s.color}" fill-opacity="0.2"/>`);
        }
        const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        parts.push(`<polyline points="${poly}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
        for (const p of pts) {
          parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="#FFFFFF" stroke="${s.color}" stroke-width="2"/>`);
        }
      });
    }

    // Category labels
    for (let idx = 0; idx < count && idx < 16; idx++) {
      const lbl = String(categories[idx] ?? idx + 1).slice(0, 10);
      const cx = chartKind === 'bar' ? padL + (idx + 0.5) * groupW : padL + (count === 1 ? plotW / 2 : (idx / (count - 1)) * plotW);
      parts.push(`<text x="${cx.toFixed(1)}" y="${H - 34}" text-anchor="middle" font-size="10.5" fill="#475569">${escapeHtml(lbl)}</text>`);
    }

    // Legend
    series.slice(0, 5).forEach((s, idx) => {
      const lx = padL + idx * 92;
      parts.push(`<rect x="${lx}" y="${H - 17}" width="10" height="10" rx="2" fill="${s.color}"/>`);
      parts.push(`<text x="${lx + 14}" y="${H - 8}" font-size="10.5" fill="#334155">${escapeHtml(s.name.slice(0, 9))}</text>`);
    });
  }

  return {
    html: `<svg class="aw-ppt-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`,
    plain,
  };
}

function renderPptPositionedTable(tblNode, { slideWidthPt, theme, clrMap }) {
  const rows = findChildren(tblNode, 'tr');
  if (!rows.length) return { html: '', plain: [] };
  const tblPr = findChild(tblNode, 'tblPr');
  const firstRowHeader = getAttr(tblPr, 'firstRow') !== '0';

  const tblGrid = findChild(tblNode, 'tblGrid');
  const gridCols = tblGrid ? findChildren(tblGrid, 'gridCol').map((c) => Number(getAttr(c, 'w') || 0)) : [];
  const totalW = gridCols.reduce((a, b) => a + b, 0);
  const colgroup =
    totalW > 0
      ? `<colgroup>${gridCols.map((w) => `<col style="width:${((w / totalW) * 100).toFixed(2)}%"/>`).join('')}</colgroup>`
      : '';

  const plain = [];
  const accentHex = theme?.colors?.accent1 || '#4F81BD';
  const trsHtml = rows
    .map((tr, rIdx) => {
      const cells = findChildren(tr, 'tc');
      const isHead = firstRowHeader && rIdx === 0;
      const rowTexts = [];
      const tds = cells
        .filter((tc) => getAttr(tc, 'hMerge') !== '1' && getAttr(tc, 'vMerge') !== '1')
        .map((tc) => {
          const cs = Number(getAttr(tc, 'gridSpan') || 1);
          const rs = Number(getAttr(tc, 'rowSpan') || 1);
          const tcPr = findChild(tc, 'tcPr');
          const cellFill = resolveFillCss(tcPr, { theme, clrMap });
          const bgCss = cellFill?.kind === 'solid'
            ? cellFill.css
            : isHead
            ? accentHex
            : rIdx % 2 === 1
            ? 'rgba(148, 163, 184, 0.12)'
            : 'rgba(255, 255, 255, 0.88)';
          const darkCell = estimateColorLuma(bgCss) < 0.48;
          const defaultCellInk = darkCell ? '#FFFFFF' : '#1E293B';
          const tx = renderRichTxBody(findChild(tc, 'txBody'), {
            slideWidthPt,
            theme,
            clrMap,
            defaultFontPt: 13,
            defaultAlign: isHead ? 'ctr' : 'l',
            defaultTextColor: defaultCellInk,
          });
          if (tx.plain.length) rowTexts.push(tx.plain.join(' '));
          const attrs = [];
          if (cs > 1) attrs.push(`colspan="${cs}"`);
          if (rs > 1) attrs.push(`rowspan="${rs}"`);
          const padCss = `${formatCqwFromPt(4, slideWidthPt)} ${formatCqwFromPt(6, slideWidthPt)}`;
          attrs.push(`style="background:${bgCss};padding:${padCss}"`);
          const tag = isHead ? 'th' : 'td';
          return `<${tag} ${attrs.join(' ')}>${tx.html || '&nbsp;'}</${tag}>`;
        })
        .join('');
      if (rowTexts.length) plain.push(rowTexts.join(' | '));
      return `<tr>${tds}</tr>`;
    })
    .join('');

  return {
    html: `<table class="aw-ppt-table">${colgroup}<tbody>${trsHtml}</tbody></table>`,
    plain,
  };
}

/**
 * Full OOXML / DrawingML 2D Spatial Presentation Renderer for `.pptx` / `.ppsx` / `.potx`.
 */
export function renderVisualPptx(zip, filePath, stat, { snippetOnly = false, media } = {}) {
  const presXml = zip.getEntryText('ppt/presentation.xml');
  if (!presXml) throw new Error('PPTX 文件缺少 ppt/presentation.xml（可能已损坏或受密码加密）');

  const presRoot = pruneAlternateContent(parseXml(presXml));
  const presRels = parseRelsXml(zip.getEntryText('ppt/_rels/presentation.xml.rels'));

  // Slide dimensions (EMUs)
  const sldSz = findAll(presRoot, 'sldSz')[0];
  const slideCx = Math.max(914400, Number(getAttr(sldSz, 'cx') || DEFAULT_SLIDE_CX));
  const slideCy = Math.max(914400, Number(getAttr(sldSz, 'cy') || DEFAULT_SLIDE_CY));
  const slideWidthPt = slideCx / EMU_PER_PT;
  const aspectLabel = Math.abs(slideCx / slideCy - 16 / 9) < 0.08 ? '16:9' : Math.abs(slideCx / slideCy - 4 / 3) < 0.08 ? '4:3' : `${(slideCx / slideCy).toFixed(2)}:1`;

  // Resolve slide order via p:sldIdLst
  const slidePaths = [];
  for (const sldId of findAll(presRoot, 'sldId')) {
    const rid = getAttr(sldId, 'id');
    const rel = presRels.get(rid);
    if (rel && !rel.external) {
      slidePaths.push(resolveZipRelPath('ppt/presentation.xml', rel.target));
    }
  }
  if (!slidePaths.length) {
    const collator = new Intl.Collator(undefined, { numeric: true });
    for (const ent of zip.entries) {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(ent.name)) slidePaths.push(ent.name);
    }
    slidePaths.sort((a, b) => collator.compare(a, b));
  }

  const masterCache = new Map();
  const layoutCache = new Map();
  const themeCache = new Map();

  function loadThemeCached(themePath) {
    const p = themePath || 'ppt/theme/theme1.xml';
    if (themeCache.has(p)) return themeCache.get(p);
    const t = parseOoxmlTheme(zip, p);
    themeCache.set(p, t);
    return t;
  }

  function loadMasterCached(masterPath) {
    if (!masterPath) {
      return {
        theme: loadThemeCached('ppt/theme/theme1.xml'),
        clrMap: { ...DEFAULT_CLR_MAP },
        bg: null,
        phMap: { byTypeIdx: new Map(), byIdx: new Map(), byType: new Map() },
        txStyles: { title: {}, body: {}, other: {} },
        masterRoot: null,
        masterRels: new Map(),
      };
    }
    if (masterCache.has(masterPath)) return masterCache.get(masterPath);
    const xml = zip.getEntryText(masterPath);
    const relsPath = masterPath.replace(/^ppt\/slideMasters\//i, 'ppt/slideMasters/_rels/') + '.rels';
    const masterRels = parseRelsXml(zip.getEntryText(relsPath));
    let themePath = 'ppt/theme/theme1.xml';
    for (const r of masterRels.values()) {
      if (!r.external && /\/theme$/i.test(String(r.type || ''))) {
        themePath = resolveZipRelPath(masterPath, r.target);
        break;
      }
    }
    const theme = loadThemeCached(themePath);
    const masterRoot = xml ? pruneAlternateContent(parseXml(xml)) : null;
    const clrMap = parseClrMap(masterRoot ? findAll(masterRoot, 'clrMap')[0] : null);
    const bg = masterRoot
      ? parseSlideBackground(masterRoot, { theme, clrMap, rels: masterRels, baseXmlPath: masterPath, media })
      : null;
    const phMap = masterRoot ? indexSlidePlaceholders(masterRoot, theme, clrMap) : { byTypeIdx: new Map(), byIdx: new Map(), byType: new Map() };
    const txStylesNode = masterRoot ? findAll(masterRoot, 'txStyles')[0] : null;
    const txStyles = {
      title: txStylesNode ? parseLstStyleLevels(findChild(txStylesNode, 'titleStyle'), theme, clrMap) : {},
      body: txStylesNode ? parseLstStyleLevels(findChild(txStylesNode, 'bodyStyle'), theme, clrMap) : {},
      other: txStylesNode ? parseLstStyleLevels(findChild(txStylesNode, 'otherStyle'), theme, clrMap) : {},
    };
    const res = { theme, clrMap, bg, phMap, txStyles, masterRoot, masterRels, masterPath };
    masterCache.set(masterPath, res);
    return res;
  }

  function loadLayoutCached(layoutPath) {
    if (!layoutPath) return { master: loadMasterCached(''), bg: null, phMap: null, showMasterSp: true, layoutRoot: null, layoutRels: new Map() };
    if (layoutCache.has(layoutPath)) return layoutCache.get(layoutPath);
    const xml = zip.getEntryText(layoutPath);
    const relsPath = layoutPath.replace(/^ppt\/slideLayouts\//i, 'ppt/slideLayouts/_rels/') + '.rels';
    const layoutRels = parseRelsXml(zip.getEntryText(relsPath));
    let masterPath = '';
    for (const r of layoutRels.values()) {
      if (!r.external && /slidemaster/i.test(String(r.type || r.target || ''))) {
        masterPath = resolveZipRelPath(layoutPath, r.target);
        break;
      }
    }
    const master = loadMasterCached(masterPath);
    const layoutRoot = xml ? pruneAlternateContent(parseXml(xml)) : null;
    const sldLayoutEl = layoutRoot ? findAll(layoutRoot, 'sldLayout')[0] || layoutRoot : null;
    const showMasterSp = sldLayoutEl ? getAttr(sldLayoutEl, 'showMasterSp') !== '0' : true;
    const ovrMapNode = layoutRoot ? findAll(findAll(layoutRoot, 'clrMapOvr')[0], 'overrideClrMapping')[0] : null;
    const clrMap = ovrMapNode ? parseClrMap(ovrMapNode, master.clrMap) : master.clrMap;
    const bg = layoutRoot
      ? parseSlideBackground(layoutRoot, { theme: master.theme, clrMap, rels: layoutRels, baseXmlPath: layoutPath, media })
      : null;
    const phMap = layoutRoot ? indexSlidePlaceholders(layoutRoot, master.theme, clrMap) : null;
    const res = { master, clrMap, bg, phMap, showMasterSp, layoutRoot, layoutRels, layoutPath };
    layoutCache.set(layoutPath, res);
    return res;
  }

  let uidCounter = 0;
  const outline = [];
  const slideCardsHtml = [];
  const plainChunks = [];
  const snippetLines = [];
  const warnings = [];
  const maxSlides = snippetOnly ? 6 : 120;

  for (let i = 0; i < slidePaths.length && i < maxSlides; i++) {
    const sp = slidePaths[i];
    const xml = zip.getEntryText(sp);
    if (!xml) continue;
    const slideRoot = pruneAlternateContent(parseXml(xml));
    const relsPath = sp.replace(/^ppt\/slides\//i, 'ppt/slides/_rels/') + '.rels';
    const slideRels = parseRelsXml(zip.getEntryText(relsPath));

    let layoutPath = '';
    for (const r of slideRels.values()) {
      if (!r.external && /slidelayout/i.test(String(r.type || r.target || ''))) {
        layoutPath = resolveZipRelPath(sp, r.target);
        break;
      }
    }
    const layout = loadLayoutCached(layoutPath);
    const master = layout.master;
    const theme = master.theme;
    const sldEl = findAll(slideRoot, 'sld')[0] || slideRoot;
    const showMasterSp = getAttr(sldEl, 'showMasterSp') !== '0' && layout.showMasterSp;
    const slideOvrMap = findAll(findAll(slideRoot, 'clrMapOvr')[0], 'overrideClrMapping')[0];
    const clrMap = slideOvrMap ? parseClrMap(slideOvrMap, layout.clrMap || master.clrMap) : (layout.clrMap || master.clrMap);

    // Resolve background cascade: Slide -> Layout -> Master -> lt1/bg1 (#FFFFFF)
    const slideBg =
      parseSlideBackground(slideRoot, { theme, clrMap, rels: slideRels, baseXmlPath: sp, media }) ||
      layout.bg ||
      master.bg || {
        kind: 'solid',
        css: theme.colors[clrMap.bg1 || 'lt1'] || '#FFFFFF',
        hex: theme.colors[clrMap.bg1 || 'lt1'] || '#FFFFFF',
      };

    const isDarkSlideBg = estimateColorLuma(slideBg.hex || slideBg.css || '#FFFFFF') < 0.42;
    const defaultSlideInk = theme.colors[clrMap.tx1 || 'dk1'] || (isDarkSlideBg ? '#F8FAFC' : '#111827');

    let slideTitle = '';
    const slidePlain = [];
    const stageElementsHtml = [];

    const boxToPosStyle = (box) => {
      const left = ((box.x / slideCx) * 100).toFixed(3);
      const top = ((box.y / slideCy) * 100).toFixed(3);
      const width = (Math.max(0, box.cx / slideCx) * 100).toFixed(3);
      const height = (Math.max(0, box.cy / slideCy) * 100).toFixed(3);
      const transforms = [];
      if (box.rotDeg && Math.abs(box.rotDeg) > 0.05) transforms.push(`rotate(${box.rotDeg.toFixed(2)}deg)`);
      if (box.flipH) transforms.push('scaleX(-1)');
      if (box.flipV) transforms.push('scaleY(-1)');
      return `left:${left}%;top:${top}%;width:${width}%;height:${height}%${transforms.length ? `;transform:${transforms.join(' ')}` : ''}`;
    };

    const renderSpTreeChildren = (treeNode, layerCtx, groupMap = null) => {
      if (!treeNode || !Array.isArray(treeNode.children)) return;
      for (const node of treeNode.children) {
        if (!node || node.text !== undefined) continue;
        const nvPr = findAll(node, 'cNvPr')[0];
        if (nvPr && (getAttr(nvPr, 'hidden') === '1' || getAttr(nvPr, 'hidden') === 'true')) continue;

        if (node.local === 'grpSp') {
          const grpSpPr = findChild(node, 'grpSpPr');
          const xfrm = findChild(grpSpPr, 'xfrm');
          const parentBox = parseXfrmBox(xfrm);
          const chOff = findChild(xfrm, 'chOff');
          const chExt = findChild(xfrm, 'chExt');
          if (parentBox && chOff && chExt) {
            const mappedParent = mapBoxThroughGroup(parentBox, groupMap);
            const nextGroupMap = {
              gx: mappedParent.x,
              gy: mappedParent.y,
              gcx: mappedParent.cx,
              gcy: mappedParent.cy,
              chOffX: Number(getAttr(chOff, 'x') || 0),
              chOffY: Number(getAttr(chOff, 'y') || 0),
              chExtCx: Number(getAttr(chExt, 'cx') || mappedParent.cx || 1),
              chExtCy: Number(getAttr(chExt, 'cy') || mappedParent.cy || 1),
              rotDeg: mappedParent.rotDeg || 0,
              flipH: Boolean(mappedParent.flipH),
              flipV: Boolean(mappedParent.flipV),
            };
            renderSpTreeChildren(node, layerCtx, nextGroupMap);
          } else {
            renderSpTreeChildren(node, layerCtx, groupMap);
          }
          continue;
        }

        if (node.local === 'sp' || node.local === 'cxnSp') {
          const ph = extractPlaceholderKey(node);
          if (layerCtx.isBackdrop && ph) {
            // Never render empty master/layout prompt placeholders ("Click to edit Master title style")
            continue;
          }

          const { layoutRec, masterRec } = ph
            ? lookupInheritedPlaceholder(ph, layout.phMap, master.phMap)
            : { layoutRec: null, masterRec: null };

          const spPr = findChild(node, 'spPr');
          const styleNode = findChild(node, 'style');
          let box = parseXfrmBox(findChild(spPr, 'xfrm'));
          if (!box && layoutRec?.xfrm) box = { ...layoutRec.xfrm };
          if (!box && masterRec?.xfrm) box = { ...masterRec.xfrm };
          if (!box && ph) box = fallbackPlaceholderBox(ph, slideCx, slideCy);
          if (!box && !layerCtx.isBackdrop && findChild(node, 'txBody')) {
            box = { x: slideCx * 0.08, y: slideCy * 0.24, cx: slideCx * 0.84, cy: slideCy * 0.62, rotDeg: 0 };
          }
          if (!box) continue;
          box = mapBoxThroughGroup(box, groupMap);

          // Skip completely off-canvas invisible shapes
          if (box.cx <= 0 && box.cy <= 0) continue;

          const fillSpec =
            resolveFillCss(spPr, {
              theme,
              clrMap,
              rels: layerCtx.rels,
              baseXmlPath: layerCtx.baseXmlPath,
              media,
              styleRefNode: styleNode,
            }) ||
            (layoutRec?.spPr
              ? resolveFillCss(layoutRec.spPr, {
                  theme,
                  clrMap,
                  rels: layout.layoutRels,
                  baseXmlPath: layout.layoutPath,
                  media,
                })
              : null);

          const strokeSpec = resolveStrokeSpec(spPr, styleNode, theme, clrMap);
          const prstGeom = findChild(spPr, 'prstGeom') || (layoutRec?.spPr ? findChild(layoutRec.spPr, 'prstGeom') : null);
          const prst = getAttr(prstGeom, 'prst') || (node.local === 'cxnSp' ? 'line' : 'rect');

          // Determine default text role (title vs subtitle vs body vs shape)
          const isTitle = ph?.type === 'title' || ph?.type === 'ctrTitle';
          const isSubTitle = ph?.type === 'subTitle';
          const isFooterMeta = ph?.type === 'sldNum' || ph?.type === 'dt' || ph?.type === 'ftr';
          const masterRoleLevels = isTitle
            ? master.txStyles.title
            : ph
            ? master.txStyles.body
            : master.txStyles.other;
          const inheritedLevels = { ...(masterRec?.lstLevels || {}), ...(layoutRec?.lstLevels || {}) };

          // Font Ref color inside `<p:style><a:fontRef>` (e.g. white text inside colored shape!)
          const fontRef = styleNode ? findChild(styleNode, 'fontRef') : null;
          const fontRefCol = fontRef ? resolveDrawingColorFromContainer(fontRef, theme, clrMap) : null;
          const hasSolidDarkFill = fillSpec?.kind === 'solid' && estimateColorLuma(fillSpec.hex || fillSpec.css) < 0.46;
          const shapeDefaultInk =
            fontRefCol?.css ||
            (hasSolidDarkFill ? '#FFFFFF' : isFooterMeta ? '#64748B' : defaultSlideInk);

          const txBody = findChild(node, 'txBody');
          const shapeParaCount = txBody ? findChildren(txBody, 'p').length : 0;
          const isSingleLineFilledBadge = Boolean(!ph && fillSpec && fillSpec.kind !== 'none' && shapeParaCount <= 1);
          const bodyPr = findChild(txBody, 'bodyPr') || layoutRec?.bodyPr || masterRec?.bodyPr;
          const anchor = getAttr(bodyPr, 'anchor') || (isTitle && ph?.type === 'ctrTitle' ? 'ctr' : isSingleLineFilledBadge ? 'ctr' : 't');
          const defaultAlign =
            ph?.type === 'ctrTitle' || (isSingleLineFilledBadge && prst !== 'rect')
              ? 'ctr'
              : isFooterMeta && ph?.type === 'sldNum'
              ? 'r'
              : 'l';
          const defaultFontPt = isTitle ? 32 : isSubTitle ? 20 : isFooterMeta ? 11 : 18;

          const txRendered = !layerCtx.isBackdrop
            ? renderRichTxBody(txBody, {
                slideWidthPt,
                theme,
                clrMap,
                inheritedLevels,
                masterLevels: masterRoleLevels,
                defaultFontPt,
                defaultAlign,
                defaultTextColor: shapeDefaultInk,
                slideIndex: i + 1,
              })
            : { html: '', plain: [] };

          if (!layerCtx.isBackdrop && txRendered.plain.length) {
            if (!slideTitle && isTitle) {
              slideTitle = txRendered.plain.join(' ').slice(0, 90);
            }
            if (!isFooterMeta) {
              slidePlain.push(...txRendered.plain);
            }
          }

          if (snippetOnly) continue;

          const uid = ++uidCounter;
          const geomSvg = buildPresetGeometrySvg(prst, spPr, fillSpec, strokeSpec, uid);
          const wrapperStyles = [boxToPosStyle(box)];
          if (!geomSvg) {
            if (fillSpec && fillSpec.kind !== 'none') {
              wrapperStyles.push(`background:${fillSpec.css}`);
            }
            if (strokeSpec) {
              const bStyle = strokeSpec.dash?.includes('dot') ? 'dotted' : strokeSpec.dash ? 'dashed' : 'solid';
              wrapperStyles.push(`border:${formatCqwFromPt(strokeSpec.pt, slideWidthPt)} ${bStyle} ${strokeSpec.css}`);
            }
            if (prst === 'roundRect' || prst === 'snipRoundRect') {
              const adjVal = Number(getAttr(findChild(findChild(prstGeom, 'avLst'), 'gd'), 'fmla')?.replace(/^val\s+/, '') || 16667);
              const rPt = Math.min(box.cx, box.cy) / EMU_PER_PT * Math.min(0.5, Math.max(0.04, adjVal / 100000));
              wrapperStyles.push(`border-radius:${formatCqwFromPt(rPt, slideWidthPt)}`);
            } else if (prst === 'ellipse') {
              wrapperStyles.push('border-radius:50%');
            }
          }

          // Textbox internal padding (default OOXML insets: l/r=91440 EMU=7.2pt, t/b=45720 EMU=3.6pt)
          let txBoxHtml = '';
          if (txRendered.html) {
            const lInsPt = Number(getAttr(bodyPr, 'lIns') ?? 91440) / EMU_PER_PT;
            const rInsPt = Number(getAttr(bodyPr, 'rIns') ?? 91440) / EMU_PER_PT;
            const tInsPt = Number(getAttr(bodyPr, 'tIns') ?? 45720) / EMU_PER_PT;
            const bInsPt = Number(getAttr(bodyPr, 'bIns') ?? 45720) / EMU_PER_PT;
            const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
            txBoxHtml = `<div class="aw-ppt-tx" style="justify-content:${justify};padding:${formatCqwFromPt(tInsPt, slideWidthPt)} ${formatCqwFromPt(rInsPt, slideWidthPt)} ${formatCqwFromPt(bInsPt, slideWidthPt)} ${formatCqwFromPt(lInsPt, slideWidthPt)}">${txRendered.html}</div>`;
          }

          if (geomSvg || txBoxHtml || (fillSpec && fillSpec.kind !== 'none') || strokeSpec) {
            stageElementsHtml.push(
              `<div class="aw-ppt-el aw-ppt-sp"${layerCtx.isBackdrop ? ' data-backdrop="1"' : ''} style="${wrapperStyles.join(';')}">${geomSvg}${txBoxHtml}</div>`
            );
          }
          continue;
        }

        if (node.local === 'pic' && !snippetOnly) {
          const spPr = findChild(node, 'spPr');
          let box = parseXfrmBox(findChild(spPr, 'xfrm'));
          const ph = extractPlaceholderKey(node);
          if (!box && ph) {
            const { layoutRec, masterRec } = lookupInheritedPlaceholder(ph, layout.phMap, master.phMap);
            box = layoutRec?.xfrm || masterRec?.xfrm || fallbackPlaceholderBox(ph, slideCx, slideCy);
          }
          if (!box && !layerCtx.isBackdrop) {
            box = { x: slideCx * 0.16, y: slideCy * 0.28, cx: slideCx * 0.68, cy: slideCy * 0.58, rotDeg: 0 };
          }
          if (!box) continue;
          box = mapBoxThroughGroup(box, groupMap);

          const blipFill = findChild(node, 'blipFill');
          const blip = findChild(blipFill, 'blip');
          const svgBlip = blip ? findAll(blip, 'svgBlip')[0] : null;
          const rid = getAttr(svgBlip, 'embed') || getAttr(blip, 'embed');
          const rel = rid ? layerCtx.rels.get(rid) : null;
          if (!rel || rel.external || !media) continue;
          const imgPath = resolveZipRelPath(layerCtx.baseXmlPath, rel.target);
          const loaded = media.loadImageDataUrl(imgPath);
          if (!loaded.ok) continue;

          const prst = getAttr(findChild(spPr, 'prstGeom'), 'prst');
          const strokeSpec = resolveStrokeSpec(spPr, findChild(node, 'style'), theme, clrMap);
          const alphaNode = blip ? findChild(blip, 'alphaModFix') : null;
          const opacity = alphaNode ? Math.max(0, Math.min(1, Number(getAttr(alphaNode, 'amt') || 100000) / 100000)) : 1;

          const picStyles = [boxToPosStyle(box), 'overflow:hidden'];
          if (prst === 'ellipse') picStyles.push('border-radius:50%');
          else if (prst === 'roundRect') picStyles.push(`border-radius:${formatCqwFromPt(10, slideWidthPt)}`);
          if (opacity < 0.995) picStyles.push(`opacity:${opacity.toFixed(2)}`);
          if (strokeSpec) {
            picStyles.push(`border:${formatCqwFromPt(strokeSpec.pt, slideWidthPt)} solid ${strokeSpec.css}`);
          }

          // Crop support (`a:srcRect l t r b` in 1/1000th percent)
          const srcRect = findChild(blipFill, 'srcRect');
          let imgStyle = 'width:100%;height:100%;object-fit:fill;display:block';
          if (srcRect) {
            const cl = Math.max(0, Number(getAttr(srcRect, 'l') || 0) / 1000);
            const ct = Math.max(0, Number(getAttr(srcRect, 't') || 0) / 1000);
            const cr = Math.max(0, Number(getAttr(srcRect, 'r') || 0) / 1000);
            const cb = Math.max(0, Number(getAttr(srcRect, 'b') || 0) / 1000);
            const visW = Math.max(5, 100 - cl - cr);
            const visH = Math.max(5, 100 - ct - cb);
            if (cl > 0.2 || ct > 0.2 || cr > 0.2 || cb > 0.2) {
              const scaleW = (100 / visW) * 100;
              const scaleH = (100 / visH) * 100;
              const offLeft = -(cl / visW) * 100;
              const offTop = -(ct / visH) * 100;
              imgStyle = `position:absolute;max-width:none;width:${scaleW.toFixed(2)}%;height:${scaleH.toFixed(2)}%;left:${offLeft.toFixed(2)}%;top:${offTop.toFixed(2)}%`;
            }
          }

          stageElementsHtml.push(
            `<div class="aw-ppt-el aw-ppt-pic" style="${picStyles.join(';')}"><img src="${loaded.dataUrl}" alt="" loading="lazy" style="${imgStyle}" /></div>`
          );
          continue;
        }

        if (node.local === 'graphicFrame') {
          let box = parseXfrmBox(findChild(node, 'xfrm'));
          if (!box) box = { x: slideCx * 0.06, y: slideCy * 0.22, cx: slideCx * 0.88, cy: slideCy * 0.65, rotDeg: 0 };
          box = mapBoxThroughGroup(box, groupMap);

          // 1. Table `<a:tbl>`
          const tbl = findAll(node, 'tbl')[0];
          if (tbl) {
            const renderedTbl = renderPptPositionedTable(tbl, { slideWidthPt, theme, clrMap });
            slidePlain.push(...renderedTbl.plain);
            if (!snippetOnly && renderedTbl.html) {
              stageElementsHtml.push(
                `<div class="aw-ppt-el aw-ppt-frame-tbl" style="${boxToPosStyle(box)}">${renderedTbl.html}</div>`
              );
            }
            continue;
          }

          // 2. Native Chart `<c:chart r:id="..."/>`
          const chartRef = findAll(node, 'chart')[0];
          if (chartRef) {
            const rid = getAttr(chartRef, 'id');
            const rel = rid ? layerCtx.rels.get(rid) : null;
            if (rel && !rel.external) {
              const chartPath = resolveZipRelPath(layerCtx.baseXmlPath, rel.target);
              const chartRes = renderOoxmlChartSvg(zip.getEntryText(chartPath), theme, clrMap);
              slidePlain.push(...chartRes.plain);
              if (!snippetOnly && chartRes.html) {
                stageElementsHtml.push(
                  `<div class="aw-ppt-el aw-ppt-frame-chart" style="${boxToPosStyle(box)}">${chartRes.html}</div>`
                );
              }
            }
            continue;
          }

          // 3. SmartArt Diagram (`dgm:relIds` -> `ppt/diagrams/drawing*.xml` pre-computed shapes OR `data*.xml`)
          const relIds = findAll(node, 'relIds')[0];
          if (relIds) {
            let renderedSmartArt = false;
            // Look for diagramDrawing relationship on slideRels or matching drawingN.xml
            const dmRid = getAttr(relIds, 'dm');
            const dmRel = dmRid ? layerCtx.rels.get(dmRid) : null;
            const dataPath = dmRel && !dmRel.external ? resolveZipRelPath(layerCtx.baseXmlPath, dmRel.target) : '';
            let drawingPath = '';
            for (const r of layerCtx.rels.values()) {
              if (!r.external && /diagramdrawing/i.test(String(r.type || ''))) {
                drawingPath = resolveZipRelPath(layerCtx.baseXmlPath, r.target);
                break;
              }
            }
            if (!drawingPath && dataPath) {
              const candidate = dataPath.replace(/\/data(\d+\.xml)$/i, '/drawing$1');
              if (zip.hasEntry(candidate)) drawingPath = candidate;
            }
            if (drawingPath) {
              const drawXml = zip.getEntryText(drawingPath);
              if (drawXml) {
                const drawRoot = pruneAlternateContent(parseXml(drawXml));
                const dspTree = findAll(drawRoot, 'spTree')[0];
                const drawRelsPath = drawingPath.replace(/^ppt\/diagrams\//i, 'ppt/diagrams/_rels/') + '.rels';
                const drawRels = parseRelsXml(zip.getEntryText(drawRelsPath));
                if (dspTree) {
                  renderSpTreeChildren(dspTree, { isBackdrop: false, rels: drawRels, baseXmlPath: drawingPath }, groupMap);
                  renderedSmartArt = true;
                }
              }
            }
            if (!renderedSmartArt && dataPath) {
              const dataXml = zip.getEntryText(dataPath);
              if (dataXml) {
                const dRoot = pruneAlternateContent(parseXml(dataXml));
                const items = findAll(dRoot, 't').map((t) => collectText(t).trim()).filter(Boolean);
                if (items.length) {
                  slidePlain.push(...items);
                  if (!snippetOnly) {
                    const cards = items
                      .slice(0, 12)
                      .map(
                        (txt) =>
                          `<div class="aw-ppt-smartart-node" style="font-size:${formatCqwFromPt(13, slideWidthPt)}">${escapeHtml(txt)}</div>`
                      )
                      .join('');
                    stageElementsHtml.push(
                      `<div class="aw-ppt-el aw-ppt-smartart-grid" style="${boxToPosStyle(box)}">${cards}</div>`
                    );
                  }
                }
              }
            }
          }
        }
      }
    };

    // 1. Render Master & Layout decorative backdrop shapes (when enabled)
    if (!snippetOnly && showMasterSp && master.masterRoot) {
      renderSpTreeChildren(findAll(master.masterRoot, 'spTree')[0], {
        isBackdrop: true,
        rels: master.masterRels,
        baseXmlPath: master.masterPath,
      });
    }
    if (!snippetOnly && layout.layoutRoot) {
      renderSpTreeChildren(findAll(layout.layoutRoot, 'spTree')[0], {
        isBackdrop: true,
        rels: layout.layoutRels,
        baseXmlPath: layout.layoutPath,
      });
    }

    // 2. Render Slide foreground shapes in exact z-order
    renderSpTreeChildren(findAll(slideRoot, 'spTree')[0], {
      isBackdrop: false,
      rels: slideRels,
      baseXmlPath: sp,
    });

    // 3. Speaker notes
    let notesText = '';
    if (!snippetOnly) {
      for (const rel of slideRels.values()) {
        if (!rel.external && /notesslide/i.test(String(rel.type || rel.target || ''))) {
          const notePath = resolveZipRelPath(sp, rel.target);
          const noteXml = zip.getEntryText(notePath);
          if (noteXml) {
            const noteRoot = pruneAlternateContent(parseXml(noteXml));
            notesText = findAll(noteRoot, 'sp')
              .filter((n) => {
                const t = getAttr(findAll(n, 'ph')[0], 'type');
                return t !== 'sldNum' && t !== 'SlideImage' && t !== 'sldImg';
              })
              .map((n) => findAll(n, 'p').map((p) => collectText(p).trim()).filter(Boolean).join('\n'))
              .filter(Boolean)
              .join('\n')
              .trim();
          }
          break;
        }
      }
    }

    const displayTitle = slideTitle || slidePlain[0]?.slice(0, 60) || `第 ${i + 1} 页`;
    const anchorId = `aw-slide-${i + 1}`;
    outline.push({ id: anchorId, level: 1, title: `${i + 1}. ${displayTitle}` });
    snippetLines.push(`${i + 1}. ${displayTitle}`);
    plainChunks.push(`--- 第 ${i + 1} 页: ${displayTitle} ---\n${slidePlain.join('\n')}${notesText ? `\n[备注] ${notesText}` : ''}`);

    if (!snippetOnly) {
      const notesHtml = notesText
        ? `<details class="aw-slide-notes"><summary>演讲者备注</summary><div class="aw-slide-notes-body">${escapeHtml(notesText).replace(/\n/g, '<br/>')}</div></details>`
        : '';

      const bgStyle = `aspect-ratio:${slideCx} / ${slideCy};background:${slideBg.css}`;
      slideCardsHtml.push(`
        <section class="aw-slide-frame-wrap" id="${anchorId}" data-slide-no="${i + 1}">
          <div class="aw-slide-meta-line">
            <span class="aw-slide-idx">${String(i + 1).padStart(2, '0')} / ${String(slidePaths.length).padStart(2, '0')}</span>
            <span class="aw-slide-caption">${escapeHtml(displayTitle)}</span>
          </div>
          <div class="aw-slide-stage" style="${bgStyle}">
            ${stageElementsHtml.join('\n')}
          </div>
          ${notesHtml}
        </section>
      `);
    }
  }

  if (slidePaths.length > maxSlides && !snippetOnly) {
    warnings.push(`演示文稿共 ${slidePaths.length} 页，当前展示前 ${maxSlides} 页。`);
  }

  const extUpper = path.extname(filePath).slice(1).toUpperCase() || 'PPTX';
  return {
    ok: true,
    format: 'pptx',
    formatLabel: '演示文稿',
    badge: extUpper,
    path: filePath,
    ext: extUpper.toLowerCase(),
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    supportsLocalHiRes: true,
    slideAspect: `${slideCx}/${slideCy}`,
    meta: {
      statsLabel: `${slidePaths.length} 页 · ${aspectLabel}`,
      slideCount: slidePaths.length,
      aspectLabel,
    },
    outline,
    bodyHtml: `<div class="aw-slides-deck">${slideCardsHtml.join('\n')}</div>`,
    plainText: plainChunks.join('\n\n'),
    snippetLines: snippetLines.slice(0, 14),
    warnings,
  };
}
