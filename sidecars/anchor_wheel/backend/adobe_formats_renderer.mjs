import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { escapeHtml } from './security.mjs';
import { readZipArchive } from './zip_xml.mjs';

const MAX_PLAIN_CHARS = 120000;
const MAX_PSD_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PSD_LAYER_BYTES = 4 * 1024 * 1024;
const MAX_PSD_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_AEP_HEAD_BYTES = 12 * 1024 * 1024;
const MAX_AEP_TAIL_BYTES = 256 * 1024;
const MAX_PRPROJ_COMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_PRPROJ_XML_BYTES = 18 * 1024 * 1024;
const MAX_AI_PDF_INLINE_BYTES = 24 * 1024 * 1024;
const MAX_INDD_HEAD_BYTES = 4 * 1024 * 1024;
const MAX_INDD_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MOGRT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_ADOBE_BYTES = 8 * 1024 * 1024;

function formatBytes(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return `${n.toFixed(n < 10 ? 2 : 1)}s`;
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function readFileSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const safeStart = Math.max(0, Math.min(st.size, start));
    const safeLen = Math.max(0, Math.min(length, st.size - safeStart));
    if (safeLen === 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(safeLen);
    let offset = 0;
    while (offset < safeLen) {
      const n = fs.readSync(fd, buf, offset, safeLen - offset, safeStart + offset);
      if (n <= 0) break;
      offset += n;
    }
    return offset === safeLen ? buf : buf.subarray(0, offset);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractXmpFields(text) {
  const src = String(text || '');
  const pickTag = (tag) => {
    const m = new RegExp(`<${tag}[^>]*>([^<]{1,240})</${tag}>`, 'i').exec(src);
    if (m?.[1]) return decodeXmlEntities(m[1]).trim();
    const attrM = new RegExp(`${tag}=["']([^"']{1,240})["']`, 'i').exec(src);
    return attrM?.[1] ? decodeXmlEntities(attrM[1]).trim() : '';
  };

  const creatorTool = pickTag('xmp:CreatorTool');
  const createDate = pickTag('xmp:CreateDate');
  const modifyDate = pickTag('xmp:ModifyDate');
  const colorProfile = pickTag('photoshop:ICCProfile');
  const pageCountRaw = pickTag('xmpTPg:NPages');
  const pageCount = /^\d+$/.test(pageCountRaw) ? Number(pageCountRaw) : 0;

  let pageSize = '';
  const sizeW = /<stDim:w>([^<]+)<\/stDim:w>/i.exec(src);
  const sizeH = /<stDim:h>([^<]+)<\/stDim:h>/i.exec(src);
  const sizeUnit = /<stDim:unit>([^<]+)<\/stDim:unit>/i.exec(src);
  if (sizeW?.[1] && sizeH?.[1]) {
    pageSize = `${Number(sizeW[1]).toFixed(1).replace(/\.0$/, '')} × ${Number(sizeH[1]).toFixed(1).replace(/\.0$/, '')} ${sizeUnit?.[1] || ''}`.trim();
  }

  // Embedded XMP JPEG thumbnail (`xmpGImg:image`)
  let thumbDataUrl = '';
  const imgM = /<xmpGImg:image>([\s\S]{80,600000}?)<\/xmpGImg:image>/i.exec(src);
  if (imgM?.[1]) {
    const cleanB64 = imgM[1].replace(/&#xA;|&#10;|\s+/gi, '');
    if (/^[A-Za-z0-9+/=]{80,}$/.test(cleanB64)) {
      thumbDataUrl = `data:image/jpeg;base64,${cleanB64}`;
    }
  }

  // Fonts referenced in XMP
  const fonts = [];
  const seenFonts = new Set();
  for (const fm of src.matchAll(/<stFnt:fontName>([^<]{1,120})<\/stFnt:fontName>/gi)) {
    const name = decodeXmlEntities(fm[1]).trim();
    if (name && !seenFonts.has(name) && fonts.length < 24) {
      seenFonts.add(name);
      fonts.push(name);
    }
  }

  return {
    creatorTool,
    createDate: createDate ? createDate.replace('T', ' ').slice(0, 19) : '',
    modifyDate: modifyDate ? modifyDate.replace('T', ' ').slice(0, 19) : '',
    colorProfile,
    pageCount,
    pageSize,
    thumbDataUrl,
    fonts,
  };
}

function renderKvGrid(items) {
  const valid = items.filter((it) => it && it.value !== undefined && it.value !== null && String(it.value).trim() !== '');
  if (!valid.length) return '';
  return `<div class="aw-adobe-kv-grid">${valid
    .map(
      (it) =>
        `<div class="aw-adobe-kv-card"><div class="aw-adobe-kv-label">${escapeHtml(it.label)}</div><div class="aw-adobe-kv-val" title="${escapeHtml(String(it.value))}">${escapeHtml(String(it.value))}</div></div>`
    )
    .join('')}</div>`;
}

// ── 1. Photoshop .psd / .psb (Header + Embedded JPEG Preview + Layer Tree) ──

const PSD_COLOR_MODES = Object.freeze({
  0: 'Bitmap 位图',
  1: 'Grayscale 灰度',
  2: 'Indexed 索引色',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel 多通道',
  8: 'Duotone 双色调',
  9: 'Lab',
});

const PSD_BLEND_MODES = Object.freeze({
  pass: '穿透 (Pass Through)',
  norm: '正常 (Normal)',
  diss: '溶解 (Dissolve)',
  dark: '变暗 (Darken)',
  mul: '正片叠底 (Multiply)',
  idiv: '颜色加深 (Color Burn)',
  lbrn: '线性加深 (Linear Burn)',
  dkCl: '深色 (Darker Color)',
  lite: '变亮 (Lighten)',
  scrn: '滤色 (Screen)',
  div: '颜色减淡 (Color Dodge)',
  lddg: '线性减淡 (Linear Dodge)',
  lgCl: '浅色 (Lighter Color)',
  over: '叠加 (Overlay)',
  sLit: '柔光 (Soft Light)',
  hLit: '强光 (Hard Light)',
  vLit: '亮光 (Vivid Light)',
  lLit: '线性光 (Linear Light)',
  pLit: '点光 (Pin Light)',
  hMix: '实色混合 (Hard Mix)',
  diff: '差值 (Difference)',
  smud: '排除 (Exclusion)',
  fsub: '减去 (Subtract)',
  fdiv: '划分 (Divide)',
  hue: '色相 (Hue)',
  sat: '饱和度 (Saturation)',
  colr: '颜色 (Color)',
  lum: '明度 (Luminosity)',
});

function readUint64Safe(buf, offset) {
  if (offset + 8 > buf.length) return 0;
  const hi = buf.readUInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  return hi * 0x100000000 + lo;
}

function decodeUtf16Be(buf) {
  if (!buf || buf.length < 2) return '';
  const evenLen = buf.length - (buf.length % 2);
  const swapped = Buffer.allocUnsafe(evenLen);
  for (let i = 0; i < evenLen; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le').replace(/\u0000+$/g, '');
}

function parsePsdImageResources(resBuf) {
  let pos = 0;
  let thumbDataUrl = '';
  let thumbWidth = 0;
  let thumbHeight = 0;
  let hDpi = 0;
  let vDpi = 0;
  let xmpText = '';
  let iccName = '';
  let guideCount = 0;

  while (pos + 12 <= resBuf.length) {
    const sig = resBuf.subarray(pos, pos + 4).toString('latin1');
    if (sig !== '8BIM' && sig !== 'MeSa') break;
    const resId = resBuf.readUInt16BE(pos + 4);
    const nameLen = resBuf[pos + 6];
    const namePadded = 1 + nameLen + ((1 + nameLen) % 2);
    const sizeOff = pos + 6 + namePadded;
    if (sizeOff + 4 > resBuf.length) break;
    const dataLen = resBuf.readUInt32BE(sizeOff);
    const dataStart = sizeOff + 4;
    const dataEnd = Math.min(resBuf.length, dataStart + dataLen);
    const payload = resBuf.subarray(dataStart, dataEnd);

    if ((resId === 0x040c || resId === 0x0409) && payload.length > 28 && !thumbDataUrl) {
      const format = payload.readUInt32BE(0);
      const w = payload.readUInt32BE(4);
      const h = payload.readUInt32BE(8);
      const jpegData = payload.subarray(28);
      if (format === 1 && jpegData.length > 32 && jpegData.length <= MAX_PSD_THUMB_BYTES && jpegData[0] === 0xff && jpegData[1] === 0xd8) {
        thumbDataUrl = `data:image/jpeg;base64,${jpegData.toString('base64')}`;
        thumbWidth = w;
        thumbHeight = h;
      }
    } else if (resId === 0x03ed && payload.length >= 16) {
      hDpi = Math.round((payload.readUInt32BE(0) / 65536) * 10) / 10;
      vDpi = Math.round((payload.readUInt32BE(8) / 65536) * 10) / 10;
    } else if (resId === 0x0424 && payload.length > 16) {
      xmpText = payload.toString('utf8');
    } else if (resId === 0x040f && payload.length >= 132) {
      // Extract ICC profile description ASCII if present
      const descIdx = payload.indexOf(Buffer.from('desc'));
      if (descIdx !== -1 && descIdx + 24 < payload.length) {
        const txt = payload.subarray(descIdx, Math.min(payload.length, descIdx + 120)).toString('latin1');
        const m = /([A-Za-z0-9][A-Za-z0-9 ._\-/()]{2,48})/.exec(txt.slice(12));
        if (m?.[1]) iccName = m[1].trim();
      }
    } else if (resId === 0x0408 && payload.length >= 16) {
      guideCount = payload.readUInt32BE(12);
    }

    pos = dataStart + dataLen + (dataLen % 2);
  }

  return { thumbDataUrl, thumbWidth, thumbHeight, hDpi, vDpi, xmpText, iccName, guideCount };
}

function decodeLegacyPsdPascalName(nameBytes) {
  if (!nameBytes || !nameBytes.length) return '';
  let hasHighByte = false;
  for (let i = 0; i < nameBytes.length; i++) {
    if (nameBytes[i] >= 0x80) {
      hasHighByte = true;
      break;
    }
  }
  if (!hasHighByte) return nameBytes.toString('ascii').replace(/\u0000/g, '').trim();
  try {
    const utf8Strict = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes).replace(/\u0000/g, '').trim();
    if (utf8Strict) return utf8Strict;
  } catch {}
  try {
    const gb = new TextDecoder('gb18030', { fatal: false }).decode(nameBytes).replace(/\u0000/g, '').trim();
    if (gb && !gb.includes('\uFFFD')) return gb;
  } catch {}
  return nameBytes.toString('utf8').replace(/\u0000/g, '').trim();
}

function parsePsdLayerTableBody(layerBuf, startPos, isPsb) {
  const layers = [];
  let pos = startPos;
  if (pos + 2 > layerBuf.length) return { totalCount: 0, layers, truncated: false };
  const rawCount = layerBuf.readInt16BE(pos);
  const totalCount = Math.abs(rawCount);
  pos += 2;

  const chEntryBytes = isPsb ? 10 : 6;
  const maxInspect = Math.min(totalCount, 240);
  let truncated = totalCount > maxInspect;

  for (let i = 0; i < maxInspect; i++) {
    if (pos + 18 > layerBuf.length) {
      truncated = true;
      break;
    }
    const top = layerBuf.readInt32BE(pos);
    const left = layerBuf.readInt32BE(pos + 4);
    const bottom = layerBuf.readInt32BE(pos + 8);
    const right = layerBuf.readInt32BE(pos + 12);
    const chCount = layerBuf.readUInt16BE(pos + 16);
    pos += 18 + chCount * chEntryBytes;
    if (pos + 16 > layerBuf.length) {
      truncated = true;
      break;
    }
    const sig = layerBuf.subarray(pos, pos + 4).toString('latin1');
    if (sig !== '8BIM') {
      truncated = true;
      break;
    }
    const blendKey = layerBuf.subarray(pos + 4, pos + 8).toString('latin1').trim();
    const opacity = Math.round((layerBuf[pos + 8] / 255) * 100);
    const flags = layerBuf[pos + 10];
    const hidden = Boolean(flags & 0x02);
    const extraLen = layerBuf.readUInt32BE(pos + 12);
    pos += 16;
    const extraEnd = pos + extraLen;
    if (extraEnd > layerBuf.length) {
      truncated = true;
      break;
    }

    let p = pos;
    // Skip Layer mask data + blending ranges
    if (p + 4 > extraEnd) { pos = extraEnd; continue; }
    const maskLen = layerBuf.readUInt32BE(p);
    p += 4 + maskLen;
    if (p + 4 > extraEnd) { pos = extraEnd; continue; }
    const rangesLen = layerBuf.readUInt32BE(p);
    p += 4 + rangesLen;

    let name = '';
    if (p < extraEnd) {
      const nameLen = layerBuf[p];
      const nameBytes = layerBuf.subarray(p + 1, Math.min(extraEnd, p + 1 + nameLen));
      name = decodeLegacyPsdPascalName(nameBytes);
      const paddedLen = Math.ceil((1 + nameLen) / 4) * 4;
      p += paddedLen;
    }

    let kind = 'pixel';
    let folderDivider = 0; // 1=open folder, 2=closed folder, 3=divider end
    while (p + 12 <= extraEnd) {
      const bSig = layerBuf.subarray(p, p + 4).toString('latin1');
      if (bSig !== '8BIM' && bSig !== '8B64') break;
      const key = layerBuf.subarray(p + 4, p + 8).toString('latin1');
      const isLongBlock =
        isPsb &&
        ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(key);
      const bLen = isLongBlock ? readUint64Safe(layerBuf, p + 8) : layerBuf.readUInt32BE(p + 8);
      const bDataStart = p + (isLongBlock ? 16 : 12);
      const bDataEnd = Math.min(extraEnd, bDataStart + bLen);
      const block = layerBuf.subarray(bDataStart, bDataEnd);

      if (key === 'luni' && block.length >= 4) {
        const charCount = block.readUInt32BE(0);
        const uniStr = decodeUtf16Be(block.subarray(4, Math.min(block.length, 4 + charCount * 2))).trim();
        if (uniStr) name = uniStr;
      } else if ((key === 'lsct' || key === 'lsdk') && block.length >= 4) {
        folderDivider = block.readUInt32BE(0);
        if (folderDivider === 1 || folderDivider === 2) kind = 'group';
        else if (folderDivider === 3) kind = 'divider';
      } else if (key === 'TySh') {
        kind = 'text';
      } else if (key === 'SoCo' || key === 'GdFl' || key === 'PtFl' || key === 'vmsk' || key === 'vsms') {
        if (kind === 'pixel') kind = 'shape';
      } else if (key === 'placedLayer' || key === 'PlLd' || key === 'SoLd') {
        kind = 'smart';
      }

      p = bDataStart + bLen + (bLen % 2);
    }

    layers.push({
      name: name || `图层 ${i + 1}`,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      blendKey,
      blendLabel: PSD_BLEND_MODES[blendKey] || blendKey || 'Normal',
      opacity,
      hidden,
      kind,
      folderDivider,
    });
    pos = extraEnd;
  }

  // Photoshop stores layers bottom-to-top; reverse to match Photoshop's top-to-bottom panel order
  const ordered = [];
  let depth = 0;
  for (let i = layers.length - 1; i >= 0; i--) {
    const lyr = layers[i];
    if (lyr.kind === 'divider') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    ordered.push({ ...lyr, depth });
    if (lyr.kind === 'group') {
      depth = Math.min(8, depth + 1);
    }
  }

  return { totalCount, layers: ordered, truncated };
}

function parsePsdLayerRecords(layerBuf, isPsb) {
  let pos = 0;
  const lenSize = isPsb ? 8 : 4;
  if (layerBuf.length < lenSize + 2) return { totalCount: 0, layers: [], truncated: false };
  const layerInfoLen = isPsb ? readUint64Safe(layerBuf, 0) : layerBuf.readUInt32BE(0);
  pos += lenSize;
  if (layerInfoLen > 0 && pos + 2 <= layerBuf.length) {
    return parsePsdLayerTableBody(layerBuf, pos, isPsb);
  }
  // 16-bit and 32-bit PSD/PSB files leave layerInfoLen === 0 and store layers inside Global Additional Layer Info (Lr16 / Lr32)
  if (pos + 4 > layerBuf.length) return { totalCount: 0, layers: [], truncated: false };
  const globalMaskLen = layerBuf.readUInt32BE(pos);
  pos += 4 + globalMaskLen;
  const longKeys = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']);
  while (pos + 12 <= layerBuf.length) {
    const sig = layerBuf.subarray(pos, pos + 4).toString('latin1');
    if (sig !== '8BIM' && sig !== '8B64') break;
    const key = layerBuf.subarray(pos + 4, pos + 8).toString('latin1');
    const isLong = isPsb && longKeys.has(key);
    const hdrBytes = isLong ? 16 : 12;
    if (pos + hdrBytes > layerBuf.length) break;
    const bLen = isLong ? readUint64Safe(layerBuf, pos + 8) : layerBuf.readUInt32BE(pos + 8);
    const dataStart = pos + hdrBytes;
    const dataEnd = Math.min(layerBuf.length, dataStart + bLen);
    if (key === 'Lr16' || key === 'Lr32') {
      return parsePsdLayerTableBody(layerBuf.subarray(dataStart, dataEnd), 0, isPsb);
    }
    const padded = bLen + (bLen % 4 === 0 ? 0 : 4 - (bLen % 4));
    const nextPos = dataStart + (bLen % 2 ? bLen + 1 : bLen);
    pos = nextPos > pos ? nextPos : dataStart + padded;
  }
  return { totalCount: 0, layers: [], truncated: false };
}

export function parsePsdDocument(filePath, stat, { snippetOnly = false } = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(26);
    const hdrRead = fs.readSync(fd, header, 0, 26, 0);
    if (hdrRead < 26 || header.subarray(0, 4).toString('latin1') !== '8BPS') {
      throw new Error('文件头不是有效的 Photoshop PSD/PSB（缺少 8BPS 标识）');
    }
    const version = header.readUInt16BE(4);
    if (version !== 1 && version !== 2) {
      throw new Error(`不支持的 Photoshop 文件版本号：${version}`);
    }
    const isPsb = version === 2;
    const channels = header.readUInt16BE(12);
    const height = header.readUInt32BE(14);
    const width = header.readUInt32BE(18);
    const bitDepth = header.readUInt16BE(22);
    const colorModeId = header.readUInt16BE(24);
    const colorMode = PSD_COLOR_MODES[colorModeId] || `Mode ${colorModeId}`;

    // Section 2: Color Mode Data
    const len4 = Buffer.alloc(4);
    let offset = 26;
    fs.readSync(fd, len4, 0, 4, offset);
    const colorDataLen = len4.readUInt32BE(0);
    offset += 4 + colorDataLen;

    // Section 3: Image Resources (bounded read)
    let resInfo = { thumbDataUrl: '', thumbWidth: 0, thumbHeight: 0, hDpi: 0, vDpi: 0, xmpText: '', iccName: '', guideCount: 0 };
    if (offset + 4 <= stat.size) {
      fs.readSync(fd, len4, 0, 4, offset);
      const resLen = len4.readUInt32BE(0);
      offset += 4;
      const toRead = Math.min(resLen, MAX_PSD_RESOURCE_BYTES, Math.max(0, stat.size - offset));
      if (toRead > 0) {
        const resBuf = Buffer.allocUnsafe(toRead);
        fs.readSync(fd, resBuf, 0, toRead, offset);
        resInfo = parsePsdImageResources(resBuf);
      }
      offset += resLen;
    }

    // Section 4: Layer & Mask Information (bounded header read)
    let layerInfo = { totalCount: 0, layers: [], truncated: false };
    const layerLenSize = isPsb ? 8 : 4;
    if (offset + layerLenSize <= stat.size) {
      const lenBuf = Buffer.alloc(layerLenSize);
      fs.readSync(fd, lenBuf, 0, layerLenSize, offset);
      const layerMaskLen = isPsb ? readUint64Safe(lenBuf, 0) : lenBuf.readUInt32BE(0);
      offset += layerLenSize;
      const toRead = Math.min(layerMaskLen, MAX_PSD_LAYER_BYTES, Math.max(0, stat.size - offset));
      if (toRead > 0) {
        const layerBuf = Buffer.allocUnsafe(toRead);
        fs.readSync(fd, layerBuf, 0, toRead, offset);
        layerInfo = parsePsdLayerRecords(layerBuf, isPsb);
      }
    }

    const xmp = extractXmpFields(resInfo.xmpText);
    const finalThumb = resInfo.thumbDataUrl || xmp.thumbDataUrl || '';
    const dpiStr = resInfo.hDpi ? `${resInfo.hDpi} DPI` : '';
    const statsLabel = [
      `${width}×${height}`,
      `${bitDepth}-bit ${colorMode}`,
      dpiStr,
      layerInfo.totalCount ? `${layerInfo.totalCount} 图层` : '',
      formatBytes(stat.size),
    ]
      .filter(Boolean)
      .join(' · ');

    const kindBadges = {
      group: '组',
      text: '文字',
      shape: '形状',
      smart: '智能对象',
      pixel: '图层',
    };

    const previewHtml = finalThumb
      ? `<div class="aw-adobe-preview-stage">
          <img class="aw-adobe-preview-img" src="${finalThumb}" alt="${escapeHtml(path.basename(filePath))}" />
          <div class="aw-adobe-preview-cap">内嵌合成缩略图${resInfo.thumbWidth ? ` (${resInfo.thumbWidth}×${resInfo.thumbHeight})` : ''}</div>
        </div>`
      : `<div class="aw-adobe-preview-empty">此文件未内嵌合并预览缩略图（保存时未勾选「最大化兼容」），以下为解析出的画布规格与图层结构。</div>`;

    const kvHtml = renderKvGrid([
      { label: '画布尺寸', value: `${width} × ${height} px` },
      { label: '色彩与位深', value: `${colorMode} · ${bitDepth}-bit (${channels} 通道)` },
      { label: '分辨率', value: dpiStr || '—' },
      { label: '图层总数', value: `${layerInfo.totalCount} 个` },
      { label: 'ICC 配置文件', value: xmp.colorProfile || resInfo.iccName || '—' },
      { label: '创建软件', value: xmp.creatorTool || (isPsb ? 'Adobe Photoshop (PSB)' : 'Adobe Photoshop') },
      { label: '参考线 / 大小', value: `${resInfo.guideCount ? `${resInfo.guideCount} 条参考线 · ` : ''}${formatBytes(stat.size)}` },
      { label: '修改时间', value: xmp.modifyDate || xmp.createDate || '—' },
    ]);

    const layersHtml = layerInfo.layers.length
      ? `<section class="aw-adobe-section" id="aw-adobe-layers">
          <h3 class="aw-adobe-sec-title">图层结构（${layerInfo.layers.length}${layerInfo.truncated ? ` / ${layerInfo.totalCount}` : ''}）</h3>
          <div class="aw-doc-table-wrap">
            <table class="aw-doc-table">
              <thead><tr><th>图层名称</th><th style="width:74px">类型</th><th style="width:130px">混合模式</th><th style="width:66px">不透明</th><th style="width:94px">尺寸</th></tr></thead>
              <tbody>
                ${layerInfo.layers
                  .slice(0, snippetOnly ? 8 : 200)
                  .map(
                    (l) => `<tr${l.hidden ? ' class="aw-adobe-row-dim"' : ''}>
                      <td style="padding-left:${10 + l.depth * 16}px">
                        <span class="aw-adobe-vis" title="${l.hidden ? '已隐藏' : '可见'}">${l.hidden ? '○' : '●'}</span>
                        <span>${escapeHtml(l.name)}</span>
                      </td>
                      <td><span class="aw-doc-zip-tag">${escapeHtml(kindBadges[l.kind] || '图层')}</span></td>
                      <td>${escapeHtml(l.blendLabel)}</td>
                      <td class="aw-sheet-num">${l.opacity}%</td>
                      <td class="aw-sheet-num">${l.width && l.height ? `${l.width}×${l.height}` : '—'}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>`
      : '';

    const fontsHtml = xmp.fonts.length
      ? `<section class="aw-adobe-section" id="aw-adobe-fonts">
          <h3 class="aw-adobe-sec-title">引用的字体 (${xmp.fonts.length})</h3>
          <div class="aw-adobe-chip-list">${xmp.fonts.map((f) => `<span class="aw-adobe-chip">${escapeHtml(f)}</span>`).join('')}</div>
        </section>`
      : '';

    const outline = [];
    if (layerInfo.layers.length) outline.push({ id: 'aw-adobe-layers', title: `图层结构 (${layerInfo.totalCount})`, level: 1 });
    if (xmp.fonts.length) outline.push({ id: 'aw-adobe-fonts', title: `字体 (${xmp.fonts.length})`, level: 1 });

    const snippetLines = [
      `${isPsb ? 'PSB 大型文档' : 'PSD 图像'} · ${width}×${height} · ${bitDepth}-bit ${colorMode}`,
      dpiStr ? `分辨率：${dpiStr}` : '',
      `图层数：${layerInfo.totalCount} 个${layerInfo.layers.length ? `（${layerInfo.layers.slice(0, 4).map((l) => l.name).join('、')}）` : ''}`,
      xmp.creatorTool ? `软件：${xmp.creatorTool}` : '',
    ].filter(Boolean);

    const warnings = [];
    if (layerInfo.truncated) {
      warnings.push(`文件图层较多（共 ${layerInfo.totalCount} 个），为保证流畅已仅展示前 ${layerInfo.layers.length} 个图层记录。`);
    }

    return {
      ok: true,
      format: 'adobe',
      formatLabel: isPsb ? 'Photoshop 大型文档 (PSB)' : 'Photoshop 文档 (PSD)',
      badge: isPsb ? 'PSB' : 'PSD',
      path: filePath,
      title: path.basename(filePath),
      ext: isPsb ? 'psb' : 'psd',
      sizeBytes: stat.size,
      autoRender: true,
      supportsPaperMode: false,
      previewThumbDataUrl: finalThumb,
      meta: { statsLabel, width, height, bitDepth, colorMode, layerCount: layerInfo.totalCount },
      outline,
      bodyHtml: `<div class="aw-adobe-view">${previewHtml}${kvHtml}${layersHtml}${fontsHtml}</div>`,
      plainText: [...snippetLines, ...layerInfo.layers.map((l) => `${l.hidden ? '[隐]' : '[显]'} ${l.name} (${l.blendLabel} ${l.opacity}%)`)].join('\n').slice(0, MAX_PLAIN_CHARS),
      snippetLines,
      warnings,
    };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// ── 2. After Effects .aep / .aepx (RIFX Binary Chunk + Tail XMP / XML) ──────

const AEP_WALK_CONTAINERS = new Set(['Egg!', 'Fold', 'Item', 'Layr', 'Pin ', 'Als2', 'expr', 'tdbs', 'tdgp', 'otda']);
const MAX_AEP_VISITED_CHUNKS = 30000;

class BufferedFdReader {
  constructor(fd, fileSize, pageBytes = 256 * 1024) {
    this.fd = fd;
    this.fileSize = fileSize;
    this.pageBytes = pageBytes;
    this.buf = Buffer.allocUnsafe(Math.min(pageBytes, Math.max(4096, fileSize)));
    this.winStart = -1;
    this.winLen = 0;
  }
  readInto(target, offset, len, pos) {
    if (pos < 0 || pos >= this.fileSize || len <= 0) return 0;
    const avail = Math.min(len, this.fileSize - pos);
    if (avail > this.buf.length) {
      return fs.readSync(this.fd, target, offset, avail, pos);
    }
    if (this.winStart < 0 || pos < this.winStart || pos + avail > this.winStart + this.winLen) {
      const toRead = Math.min(this.buf.length, this.fileSize - pos);
      this.winLen = fs.readSync(this.fd, this.buf, 0, toRead, pos);
      this.winStart = pos;
    }
    const rel = pos - this.winStart;
    const copyLen = Math.min(avail, Math.max(0, this.winLen - rel));
    if (copyLen > 0) this.buf.copy(target, offset, rel, rel + copyLen);
    return copyLen;
  }
}

function walkAepRifxFromFd(reader, start, end, state, ctx = '', depth = 0) {
  if (depth > 16 || state.visited >= MAX_AEP_VISITED_CHUNKS) return;
  const hdr = Buffer.allocUnsafe(8);
  const subBuf = Buffer.allocUnsafe(4);
  let pos = start;
  while (pos + 8 <= end && state.visited < MAX_AEP_VISITED_CHUNKS) {
    state.visited++;
    const n = reader.readInto(hdr, 0, 8, pos);
    if (n < 8) break;
    const tag = hdr.subarray(0, 4).toString('latin1');
    const size = hdr.readUInt32BE(4);
    const p0 = pos + 8;
    const p1 = Math.min(end, p0 + size);
    if (size > 0x7fffffff || p1 < p0) break;

    if (tag === 'RIFX' || tag === 'LIST') {
      if (p0 + 4 > p1) break;
      reader.readInto(subBuf, 0, 4, p0);
      const sub = subBuf.toString('latin1');
      if (AEP_WALK_CONTAINERS.has(sub)) {
        let nextCtx = ctx;
        if (sub === 'Item') {
          nextCtx = 'Item';
          if (state.items.length < 400) {
            state.items.push({ name: '', type: 0, width: 0, height: 0, fps: 0, duration: 0, layerCount: 0 });
          }
        } else if (sub === 'Layr') {
          nextCtx = 'Layr';
          const curItem = state.items[state.items.length - 1];
          if (curItem && curItem.type === 4) curItem.layerCount++;
          if (state.layers.length < 300) {
            state.layers.push({ name: '', compName: curItem?.type === 4 ? curItem.name : '' });
          }
        } else if (sub === 'expr' || sub === 'Als2' || sub === 'Pin ' || sub === 'Fold') {
          nextCtx = sub;
        }
        walkAepRifxFromFd(reader, p0 + 4, p1, state, nextCtx, depth + 1);
      }
    } else if (size > 0 && size <= 65536 && p1 <= end) {
      if (tag === 'Utf8') {
        const b = Buffer.allocUnsafe(size);
        const rn = reader.readInto(b, 0, size, p0);
        const text = b.subarray(0, rn).toString('utf8').replace(/\u0000+$/g, '').trim();
        if (text) {
          if (ctx === 'Item' && state.items.length && !state.items[state.items.length - 1].name) {
            state.items[state.items.length - 1].name = text;
          } else if (ctx === 'Layr' && state.layers.length && !state.layers[state.layers.length - 1].name) {
            state.layers[state.layers.length - 1].name = text;
          } else if (
            text.length >= 12 &&
            text.length <= 2000 &&
            /(?:thisComp|thisLayer|valueAtTime|linear\(|ease\(|wiggle\(|createPath\(|effect\(|time\s*[*+\-/])/i.test(text)
          ) {
            if (state.expressions.length < 40) {
              const curLyr = state.layers[state.layers.length - 1];
              state.expressions.push({
                layer: curLyr?.name || '图层表达式',
                comp: curLyr?.compName || '',
                code: text.slice(0, 320),
              });
            }
          } else if (text.startsWith('{') && text.includes('colorProfile')) {
            try {
              const parsed = JSON.parse(text);
              if (parsed.workingColorSpace) state.colorSpace = String(parsed.workingColorSpace);
            } catch {}
          }
        }
      } else if (tag === 'idta' && ctx === 'Item' && state.items.length && size >= 2) {
        const b = Buffer.allocUnsafe(2);
        if (reader.readInto(b, 0, 2, p0) === 2) {
          state.items[state.items.length - 1].type = b.readUInt16BE(0);
        }
      } else if (tag === 'cdta' && ctx === 'Item' && state.items.length && size >= 160) {
        const b = Buffer.allocUnsafe(164);
        if (reader.readInto(b, 0, 164, p0) >= 160) {
          const it = state.items[state.items.length - 1];
          const w = b.readUInt16BE(140);
          const h = b.readUInt16BE(142);
          const fpsFixed = b.readUInt32BE(156);
          const fps = fpsFixed > 0 ? Math.round((fpsFixed / 65536) * 100) / 100 : 0;
          const durNum = b.readUInt32BE(44);
          const durDen = b.readUInt32BE(48);
          const dur = durDen > 0 && durNum > 0 ? Math.round((durNum / durDen) * 100) / 100 : 0;
          if (w > 0 && w <= 32768 && h > 0 && h <= 32768) {
            it.width = w;
            it.height = h;
          }
          if (fps > 0 && fps <= 240) it.fps = fps;
          if (dur > 0 && dur <= 86400) it.duration = dur;
        }
      } else if ((tag === 'alas' || tag === 'Alas') && size <= 8192) {
        const b = Buffer.allocUnsafe(size);
        const rn = reader.readInto(b, 0, size, p0);
        const txt = b.subarray(0, rn).toString('utf8');
        const m = /"fullpath"\s*:\s*"([^"]+)"/.exec(txt);
        if (m?.[1]) {
          const cleanPath = m[1].replace(/\\\\/g, '\\');
          if (!state.footageSet.has(cleanPath) && state.footage.length < 200) {
            state.footageSet.add(cleanPath);
            state.footage.push(cleanPath);
          }
        }
      } else if (tag === 'head' && size >= 16 && !state.bitDepth) {
        const b = Buffer.allocUnsafe(16);
        if (reader.readInto(b, 0, 16, p0) === 16) {
          const rawBpc = b[15];
          if (rawBpc === 0) state.bitDepth = '8 bpc';
          else if (rawBpc === 1) state.bitDepth = '16 bpc';
          else if (rawBpc === 2) state.bitDepth = '32 bpc (浮点)';
        }
      }
    }

    const padded = size + (size % 2);
    if (p0 + padded <= pos) break;
    pos = p0 + padded;
  }
}

export function parseAepDocument(filePath, stat, { snippetOnly = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (stat.size === 0) {
    throw new Error('该 After Effects 项目为空文件（0 字节，可能是未保存完成的临时锁文件）');
  }

  let xmp = extractXmpFields('');
  const state = {
    items: [],
    layers: [],
    footage: [],
    footageSet: new Set(),
    expressions: [],
    colorSpace: '',
    bitDepth: '',
    visited: 0,
  };
  let partialRead = false;

  if (ext === '.aepx') {
    const xmlBuf = readFileSlice(filePath, 0, Math.min(stat.size, MAX_AEP_HEAD_BYTES));
    partialRead = stat.size > MAX_AEP_HEAD_BYTES;
    const xml = xmlBuf.toString('utf8');
    if (!/<AfterEffectsProject\b/i.test(xml)) {
      throw new Error('未检测到有效的 After Effects XML (.aepx) 工程头');
    }
    xmp = extractXmpFields(xml);
    for (const m of xml.matchAll(/<Item\b[^>]*>[\s\S]{0,1200}?<string[^>]*>([^<]{1,120})<\/string>/gi)) {
      const name = decodeXmlEntities(m[1]).trim();
      if (name && state.items.length < 200) {
        state.items.push({ name, type: 4, width: 0, height: 0, fps: 0, duration: 0, layerCount: 0 });
      }
    }
    for (const m of xml.matchAll(/fullpath="([^"]+)"/gi)) {
      const fp = decodeXmlEntities(m[1]);
      if (fp && !state.footageSet.has(fp) && state.footage.length < 200) {
        state.footageSet.add(fp);
        state.footage.push(fp);
      }
    }
  } else {
    const fd = fs.openSync(filePath, 'r');
    try {
      const sigBuf = Buffer.alloc(12);
      if (fs.readSync(fd, sigBuf, 0, 12, 0) < 12 || sigBuf.subarray(0, 4).toString('latin1') !== 'RIFX') {
        throw new Error('文件头不是有效的 After Effects RIFX 工程格式');
      }
      const rifxLen = sigBuf.readUInt32BE(4);
      const reader = new BufferedFdReader(fd, stat.size, 256 * 1024);
      walkAepRifxFromFd(reader, 0, Math.min(stat.size, 8 + rifxLen), state);
      partialRead = state.visited >= MAX_AEP_VISITED_CHUNKS;

      // Read trailing XMP packet even on huge 300MB+ .aep files!
      const tailStart = Math.max(0, stat.size - MAX_AEP_TAIL_BYTES);
      const tailLen = stat.size - tailStart;
      if (tailLen > 0) {
        const tailBuf = Buffer.allocUnsafe(tailLen);
        const rn = fs.readSync(fd, tailBuf, 0, tailLen, tailStart);
        const xmpIdx = tailBuf.subarray(0, rn).indexOf(Buffer.from('<?xpacket'));
        if (xmpIdx !== -1) {
          xmp = extractXmpFields(tailBuf.subarray(xmpIdx, rn).toString('utf8'));
        }
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const comps = state.items.filter((i) => i.type === 4 && i.name);
  const footageItems = state.items.filter((i) => i.type === 7 && i.name);
  const folders = state.items.filter((i) => i.type === 1 && i.name);

  const statsLabel = [
    `${comps.length} 个合成`,
    state.footage.length || footageItems.length ? `${Math.max(state.footage.length, footageItems.length)} 个素材` : '',
    state.expressions.length ? `${state.expressions.length} 条表达式` : '',
    formatBytes(stat.size),
  ]
    .filter(Boolean)
    .join(' · ');

  const kvHtml = renderKvGrid([
    { label: '软件版本', value: xmp.creatorTool || 'Adobe After Effects' },
    { label: '合成数量', value: `${comps.length} 个` },
    { label: '导入素材', value: `${Math.max(state.footage.length, footageItems.length)} 项` },
    { label: '文件夹 / 图层', value: `${folders.length} 目录 · ${state.layers.filter((l) => l.name).length} 图层` },
    { label: '表达式数量', value: `${state.expressions.length} 条` },
    { label: '工程体积', value: `${formatBytes(stat.size)}${partialRead ? ' (头部摘要)' : ''}` },
    { label: '修改时间', value: xmp.modifyDate || xmp.createDate || '—' },
  ]);

  const compsHtml = comps.length
    ? `<section class="aw-adobe-section" id="aw-adobe-comps">
        <h3 class="aw-adobe-sec-title">合成列表 (${comps.length})</h3>
        <div class="aw-doc-table-wrap">
          <table class="aw-doc-table">
            <thead><tr><th>合成名称</th><th style="width:108px">分辨率</th><th style="width:74px">帧率</th><th style="width:78px">时长</th><th style="width:66px">图层</th></tr></thead>
            <tbody>
              ${comps
                .slice(0, snippetOnly ? 8 : 120)
                .map(
                  (c) => `<tr>
                    <td><strong>${escapeHtml(c.name)}</strong></td>
                    <td class="aw-sheet-num">${c.width && c.height ? `${c.width}×${c.height}` : '—'}</td>
                    <td class="aw-sheet-num">${c.fps ? `${c.fps} fps` : '—'}</td>
                    <td class="aw-sheet-num">${c.duration ? formatDuration(c.duration) : '—'}</td>
                    <td class="aw-sheet-num">${c.layerCount || '—'}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>`
    : '<p class="aw-doc-empty-msg">未在扫描范围内检测到合成记录（可能是空工程模板）。</p>';

  const footageList = state.footage.length ? state.footage : footageItems.map((f) => f.name);
  const footageHtml = footageList.length
    ? `<section class="aw-adobe-section" id="aw-adobe-footage">
        <h3 class="aw-adobe-sec-title">导入素材 (${footageList.length})</h3>
        <div class="aw-doc-table-wrap">
          <table class="aw-doc-table">
            <thead><tr><th>素材名称</th><th>原始引用路径</th></tr></thead>
            <tbody>
              ${footageList
                .slice(0, snippetOnly ? 6 : 120)
                .map((fp) => {
                  const base = fp.split(/[\\/]/).pop() || fp;
                  return `<tr><td>${escapeHtml(base)}</td><td class="aw-adobe-path-cell" title="${escapeHtml(fp)}">${escapeHtml(fp)}</td></tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </section>`
    : '';

  const exprHtml = state.expressions.length
    ? `<section class="aw-adobe-section" id="aw-adobe-exprs">
        <h3 class="aw-adobe-sec-title">脚本表达式摘录 (${state.expressions.length})</h3>
        <div class="aw-adobe-expr-list">
          ${state.expressions
            .slice(0, snippetOnly ? 3 : 20)
            .map(
              (ex) => `<div class="aw-adobe-expr-card">
                <div class="aw-adobe-expr-head">${escapeHtml(ex.comp ? `${ex.comp} / ${ex.layer}` : ex.layer)}</div>
                <pre class="aw-adobe-code">${escapeHtml(ex.code)}</pre>
              </div>`
            )
            .join('')}
        </div>
      </section>`
    : '';

  const outline = [];
  if (comps.length) outline.push({ id: 'aw-adobe-comps', title: `合成列表 (${comps.length})`, level: 1 });
  if (footageList.length) outline.push({ id: 'aw-adobe-footage', title: `导入素材 (${footageList.length})`, level: 1 });
  if (state.expressions.length) outline.push({ id: 'aw-adobe-exprs', title: `表达式 (${state.expressions.length})`, level: 1 });

  const snippetLines = [
    `After Effects 工程 · ${comps.length} 个合成 · ${footageList.length} 个素材`,
    ...comps.slice(0, 5).map((c) => `合成：${c.name}${c.width ? ` (${c.width}×${c.height} @ ${c.fps || '?'}fps)` : ''}`),
    xmp.creatorTool ? `版本：${xmp.creatorTool}` : '',
  ].filter(Boolean);

  const warnings = [];
  if (partialRead) {
    warnings.push(`工程体积较大（${formatBytes(stat.size)}），为防止侧边栏卡顿已仅快速扫描前 ${formatBytes(MAX_AEP_HEAD_BYTES)} 区块与尾部 XMP 信息。`);
  }

  return {
    ok: true,
    format: 'adobe',
    formatLabel: ext === '.aepx' ? 'After Effects XML 工程' : 'After Effects 工程 (AEP)',
    badge: ext === '.aepx' ? 'AEPX' : 'AEP',
    path: filePath,
    title: path.basename(filePath),
    ext: ext.slice(1),
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: { statsLabel, compCount: comps.length, footageCount: footageList.length },
    outline,
    bodyHtml: `<div class="aw-adobe-view">${kvHtml}${compsHtml}${footageHtml}${exprHtml}</div>`,
    plainText: [
      ...snippetLines,
      ...footageList.slice(0, 60).map((f) => `素材：${f}`),
    ]
      .join('\n')
      .slice(0, MAX_PLAIN_CHARS),
    snippetLines,
    warnings,
  };
}

// ── 3. Premiere Pro .prproj (Capped GZIP XML Project Inspector) ─────────────

function gunzipCapped(compressedBuf, maxOutputBytes) {
  if (compressedBuf.length < 2 || compressedBuf[0] !== 0x1f || compressedBuf[1] !== 0x8b) {
    return { buf: compressedBuf.subarray(0, maxOutputBytes), truncated: compressedBuf.length > maxOutputBytes };
  }
  try {
    const out = zlib.gunzipSync(compressedBuf, { maxOutputLength: maxOutputBytes });
    return { buf: out, truncated: false };
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /Cannot create a Buffer larger|maxOutputLength/i.test(String(err?.message || ''))) {
      // Binary-search largest compressed prefix that inflates cleanly via public Node zlib API with Z_SYNC_FLUSH
      let lo = Math.min(compressedBuf.length, 4096);
      let hi = compressedBuf.length;
      let bestBuf = Buffer.alloc(0);
      for (let iter = 0; iter < 8 && lo <= hi; iter++) {
        const mid = Math.floor((lo + hi) / 2);
        if (mid <= 0) break;
        try {
          const out = zlib.gunzipSync(compressedBuf.subarray(0, mid), {
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
            maxOutputLength: maxOutputBytes,
          });
          if (out.length > bestBuf.length) bestBuf = out;
          if (out.length >= maxOutputBytes * 0.82) break;
          lo = mid + 1;
        } catch (subErr) {
          if (subErr?.code === 'ERR_BUFFER_TOO_LARGE' || /Cannot create a Buffer larger|maxOutputLength/i.test(String(subErr?.message || ''))) {
            hi = mid - 1;
          } else {
            hi = mid - 1;
          }
        }
      }
      if (!bestBuf.length) {
        // Final minimal 64KB prefix probe
        bestBuf = zlib.gunzipSync(compressedBuf.subarray(0, Math.min(compressedBuf.length, 65536)), {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
          maxOutputLength: maxOutputBytes,
        });
      }
      return { buf: bestBuf, truncated: true };
    }
    throw err;
  }
}

const PR_VERSION_LABELS = Object.freeze({
  43: 'Premiere Pro 2025 (Schema v43)',
  42: 'Premiere Pro 2024 (Schema v42)',
  41: 'Premiere Pro 2023 (Schema v41)',
  40: 'Premiere Pro 2022 (Schema v40)',
  39: 'Premiere Pro 2021 (Schema v39)',
  38: 'Premiere Pro 2020 (Schema v38)',
});

function ticksToFps(ticks) {
  const n = Number(ticks);
  if (!Number.isFinite(n) || n <= 0) return '';
  const val = 254016000000 / n;
  if (val >= 10 && val <= 240) {
    const rounded = Math.round(val * 100) / 100;
    return `${rounded} fps`;
  }
  return '';
}

function classifyMediaAsset(filePathStr) {
  const ext = path.extname(filePathStr).toLowerCase();
  if (/\.(?:mp4|mov|mkv|avi|mxf|mts|m2ts|ts|webm|flv|wmv|m4v)$/.test(ext)) return '视频';
  if (/\.(?:mp3|wav|flac|aac|m4a|ogg|aif|aiff|wma)$/.test(ext)) return '音频';
  if (/\.(?:png|jpg|jpeg|webp|gif|psd|psb|ai|tif|tiff|bmp|svg|exr|tga)$/.test(ext)) return '图像';
  if (/\.(?:srt|ass|ssa|vtt|xml|prtextstyle|mogrt|aep)$/.test(ext)) return '字幕/工程';
  return '素材';
}

export function parsePrprojDocument(filePath, stat, { snippetOnly = false } = {}) {
  if (stat.size === 0) throw new Error('该 Premiere Pro 工程为空文件（0 字节）');
  const rawBuf = readFileSlice(filePath, 0, Math.min(stat.size, MAX_PRPROJ_COMPRESSED_BYTES));
  const { buf: xmlBuf, truncated } = gunzipCapped(rawBuf, MAX_PRPROJ_XML_BYTES);
  const xml = xmlBuf.toString('utf8');
  if (!xml.includes('<PremiereData')) {
    throw new Error('未检测到标准 PremiereData XML 结构');
  }

  const projVerMatch = /<Project\b[^>]*Version="(\d+)"/i.exec(xml);
  const schemaVer = projVerMatch ? Number(projVerMatch[1]) : 0;
  const prVersionLabel = PR_VERSION_LABELS[schemaVer] || (schemaVer ? `Premiere Pro (Schema v${schemaVer})` : 'Adobe Premiere Pro');

  // Pre-index top-level <VideoTrackGroup ObjectUID="..."> blocks so Sequence nodes can resolve FrameRect / FrameRate accurately
  const vtgMap = new Map();
  let vtgPos = 0;
  while (vtgMap.size < 300) {
    const oIdx = xml.indexOf('<VideoTrackGroup ', vtgPos);
    if (oIdx === -1) break;
    const tEnd = xml.indexOf('>', oIdx);
    if (tEnd === -1) break;
    if (xml[tEnd - 1] === '/') {
      vtgPos = tEnd + 1;
      continue;
    }
    const cIdx = xml.indexOf('</VideoTrackGroup>', tEnd);
    if (cIdx === -1) break;
    const headerTag = xml.slice(oIdx, tEnd + 1);
    const uidM = /ObjectUID="([^"]+)"/.exec(headerTag) || /ObjectID="([^"]+)"/.exec(headerTag);
    const slice = xml.slice(oIdx, cIdx + 18);
    vtgPos = cIdx + 18;
    if (uidM?.[1]) {
      const rM = /<FrameRect>0,0,(\d+),(\d+)<\/FrameRect>/.exec(slice);
      let fStr = '';
      for (const fm of slice.matchAll(/<(?:FrameRate|Timebase)>(\d+)<\/(?:FrameRate|Timebase)>/g)) {
        const f = ticksToFps(fm[1]);
        if (f) { fStr = f; break; }
      }
      vtgMap.set(uidM[1], {
        size: rM ? `${rM[1]}×${rM[2]}` : '',
        fps: fStr,
      });
    }
  }

  // Extract sequences using safe indexOf scanning, skipping self-closing <Sequence ObjectURef="..."/> references!
  const sequences = [];
  let searchPos = 0;
  while (sequences.length < 80) {
    const openIdx = xml.indexOf('<Sequence ', searchPos);
    if (openIdx === -1) break;
    const tagEnd = xml.indexOf('>', openIdx);
    if (tagEnd === -1) break;
    if (xml[tagEnd - 1] === '/') {
      searchPos = tagEnd + 1;
      continue;
    }
    const closeIdx = xml.indexOf('</Sequence>', tagEnd);
    if (closeIdx === -1) break;
    const seqSlice = xml.slice(openIdx, closeIdx + 11);
    searchPos = closeIdx + 11;

    // Sequence <Name> typically sits near the end of the block
    const tailPart = seqSlice.slice(Math.max(0, seqSlice.length - 1600));
    const nmMatch = /<Name>([^<]{1,160})<\/Name>/.exec(tailPart) || /<Name>([^<]{1,160})<\/Name>/.exec(seqSlice);
    const name = nmMatch ? decodeXmlEntities(nmMatch[1]).trim() : `序列 ${sequences.length + 1}`;
    const rectMatch = /<FrameRect>0,0,(\d+),(\d+)<\/FrameRect>/.exec(seqSlice);
    let size = rectMatch ? `${rectMatch[1]}×${rectMatch[2]}` : '';
    let fps = '';
    for (const fm of seqSlice.matchAll(/<(?:FrameRate|Timebase)>(\d+)<\/(?:FrameRate|Timebase)>/g)) {
      const f = ticksToFps(fm[1]);
      if (f) {
        fps = f;
        break;
      }
    }
    if ((!size || !fps) && vtgMap.size > 0) {
      for (const refM of seqSlice.matchAll(/ObjectURef="([^"]+)"/g)) {
        const hit = vtgMap.get(refM[1]);
        if (hit) {
          if (!size && hit.size) size = hit.size;
          if (!fps && hit.fps) fps = hit.fps;
          if (size && fps) break;
        }
      }
    }
    sequences.push({ name, size, fps });
  }

  // Fallback global FrameRects if Sequence blocks stored geometry in separate VideoTrackGroup objects
  const globalRects = Array.from(new Set(Array.from(xml.matchAll(/<FrameRect>0,0,(\d+),(\d+)<\/FrameRect>/g)).map((m) => `${m[1]}×${m[2]}`)));
  const videoTrackCount = (xml.match(/<VideoClipTrack\b/g) || []).length;
  const audioTrackCount = (xml.match(/<AudioClipTrack\b/g) || []).length;

  const mediaSet = new Set();
  const mediaList = [];
  for (const m of xml.matchAll(/<ActualMediaFilePath>([^<]{2,500})<\/ActualMediaFilePath>/g)) {
    const p = decodeXmlEntities(m[1]).trim();
    if (!p || /^\d+$/.test(p) || (!p.includes('\\') && !p.includes('/') && !p.includes('.'))) continue;
    if (!mediaSet.has(p) && mediaList.length < 300) {
      mediaSet.add(p);
      mediaList.push({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        kind: classifyMediaAsset(p),
      });
    }
  }

  const statsLabel = [
    `${sequences.length} 个序列`,
    `${mediaList.length} 个素材`,
    `${videoTrackCount}V / ${audioTrackCount}A 轨`,
    formatBytes(stat.size),
  ].join(' · ');

  const kvHtml = renderKvGrid([
    { label: '工程版本', value: prVersionLabel },
    { label: '时间线序列', value: `${sequences.length} 个` },
    { label: '轨道总计', value: `${videoTrackCount} 视频轨 · ${audioTrackCount} 音频轨` },
    { label: '关联素材', value: `${mediaList.length} 项` },
    { label: '常见画幅', value: globalRects.slice(0, 3).join(' / ') || '—' },
    { label: '工程体积', value: `${formatBytes(stat.size)} (解压约 ${formatBytes(xmlBuf.length)})` },
  ]);

  const seqHtml = sequences.length
    ? `<section class="aw-adobe-section" id="aw-adobe-seqs">
        <h3 class="aw-adobe-sec-title">时间线序列 (${sequences.length})</h3>
        <div class="aw-doc-table-wrap">
          <table class="aw-doc-table">
            <thead><tr><th>序列名称</th><th style="width:120px">分辨率</th><th style="width:90px">帧率</th></tr></thead>
            <tbody>
              ${sequences
                .slice(0, snippetOnly ? 6 : 80)
                .map(
                  (s) => `<tr><td><strong>${escapeHtml(s.name)}</strong></td><td class="aw-sheet-num">${escapeHtml(s.size || '—')}</td><td class="aw-sheet-num">${escapeHtml(s.fps || '—')}</td></tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>`
    : '';

  const mediaHtml = mediaList.length
    ? `<section class="aw-adobe-section" id="aw-adobe-media">
        <h3 class="aw-adobe-sec-title">关联媒体素材 (${mediaList.length})</h3>
        <div class="aw-doc-table-wrap">
          <table class="aw-doc-table">
            <thead><tr><th style="width:74px">类型</th><th>文件名</th><th>路径</th></tr></thead>
            <tbody>
              ${mediaList
                .slice(0, snippetOnly ? 6 : 180)
                .map(
                  (m) => `<tr>
                    <td><span class="aw-doc-zip-tag">${escapeHtml(m.kind)}</span></td>
                    <td>${escapeHtml(m.name)}</td>
                    <td class="aw-adobe-path-cell" title="${escapeHtml(m.path)}">${escapeHtml(m.path)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>`
    : '';

  const outline = [];
  if (sequences.length) outline.push({ id: 'aw-adobe-seqs', title: `时间线序列 (${sequences.length})`, level: 1 });
  if (mediaList.length) outline.push({ id: 'aw-adobe-media', title: `关联素材 (${mediaList.length})`, level: 1 });

  const snippetLines = [
    `${prVersionLabel} · ${sequences.length} 个序列 · ${mediaList.length} 个素材`,
    ...sequences.slice(0, 5).map((s) => `序列：${s.name}${s.size ? ` (${s.size})` : ''}`),
  ];

  const warnings = [];
  if (truncated || stat.size > MAX_PRPROJ_COMPRESSED_BYTES) {
    warnings.push('工程解压后 XML 体积较大，为保证侧边栏瞬开仅扫描了前 18 MB 内容。');
  }

  return {
    ok: true,
    format: 'adobe',
    formatLabel: 'Premiere Pro 工程',
    badge: 'PRPROJ',
    path: filePath,
    title: path.basename(filePath),
    ext: 'prproj',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    meta: { statsLabel, sequenceCount: sequences.length, mediaCount: mediaList.length },
    outline,
    bodyHtml: `<div class="aw-adobe-view">${kvHtml}${seqHtml}${mediaHtml}</div>`,
    plainText: [...snippetLines, ...mediaList.slice(0, 80).map((m) => `[${m.kind}] ${m.path}`)].join('\n').slice(0, MAX_PLAIN_CHARS),
    snippetLines,
    warnings,
  };
}

// ── 4. Adobe Illustrator .ai (PDF-Compatible Visual Preview + XMP/DSC Meta) ─

export function parseAiDocument(filePath, stat, { snippetOnly = false } = {}) {
  if (stat.size === 0) throw new Error('该 Illustrator 文件为空文件（0 字节）');
  const headBuf = readFileSlice(filePath, 0, Math.min(stat.size, 512 * 1024));
  const headText = headBuf.toString('latin1');
  const isPdfCompatible = headText.startsWith('%PDF-');
  const isPostScriptAi = headText.startsWith('%!PS-Adobe');
  const isBinaryEps =
    headBuf.length >= 4 && headBuf[0] === 0xc5 && headBuf[1] === 0xd0 && headBuf[2] === 0xd3 && headBuf[3] === 0xc6;
  if (!isPdfCompatible && !isPostScriptAi && !isBinaryEps) {
    throw new Error('文件头不是有效的 Adobe Illustrator (.ai) 或 PostScript/EPS 格式');
  }
  const tailStart = Math.max(0, stat.size - 512 * 1024);
  const tailBuf = tailStart === 0 ? headBuf : readFileSlice(filePath, tailStart, 512 * 1024);
  const xmp = extractXmpFields(headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8'));

  // Modern .ai files saved with PDF compatibility render 1:1 as native vector PDF directly in sidebar!
  if (isPdfCompatible && !snippetOnly && stat.size <= MAX_AI_PDF_INLINE_BYTES) {
    const fullBuf = fs.readFileSync(filePath);
    const statsLabel = [
      xmp.pageCount ? `${xmp.pageCount} 画板` : 'PDF 兼容矢量',
      xmp.pageSize || '',
      formatBytes(stat.size),
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      ok: true,
      format: 'pdf',
      formatLabel: 'Illustrator 矢量图',
      badge: 'AI',
      path: filePath,
      title: path.basename(filePath),
      ext: 'ai',
      sizeBytes: stat.size,
      autoRender: true,
      supportsPaperMode: false,
      pdfBase64: fullBuf.toString('base64'),
      meta: { statsLabel, pageCount: xmp.pageCount },
      outline: [],
      bodyHtml: '',
      plainText: '',
      snippetLines: [
        `Illustrator 矢量图（PDF 兼容直览）`,
        xmp.pageCount ? `画板数：${xmp.pageCount}` : '',
        xmp.pageSize ? `画板尺寸：${xmp.pageSize}` : '',
        xmp.creatorTool ? `创建软件：${xmp.creatorTool}` : '',
      ].filter(Boolean),
      warnings: [],
    };
  }

  // Fallback for >24MB .ai or non-PDF PostScript .ai
  const creatorDsc = /^%%Creator:\s*(.+)$/m.exec(headText)?.[1]?.trim() || '';
  const bboxDsc = /^%%(?:HiRes)?BoundingBox:\s*(.+)$/m.exec(headText)?.[1]?.trim() || '';
  const colorsDsc = /^%%DocumentProcessColors:\s*(.+)$/m.exec(headText)?.[1]?.trim() || '';

  const previewHtml = xmp.thumbDataUrl
    ? `<div class="aw-adobe-preview-stage"><img class="aw-adobe-preview-img" src="${xmp.thumbDataUrl}" alt="${escapeHtml(path.basename(filePath))}" /><div class="aw-adobe-preview-cap">XMP 内嵌画板缩略图</div></div>`
    : '';
  const kvHtml = renderKvGrid([
    { label: '文件格式', value: isPdfCompatible ? 'Illustrator (PDF 兼容)' : 'Illustrator (PostScript/EPS)' },
    { label: '创建软件', value: xmp.creatorTool || creatorDsc || 'Adobe Illustrator' },
    { label: '画板数量', value: xmp.pageCount ? `${xmp.pageCount} 个` : '—' },
    { label: '画板尺寸', value: xmp.pageSize || bboxDsc || '—' },
    { label: '色彩通道', value: colorsDsc || xmp.colorProfile || '—' },
    { label: '文件体积', value: formatBytes(stat.size) },
  ]);
  const fontsHtml = xmp.fonts.length
    ? `<section class="aw-adobe-section"><h3 class="aw-adobe-sec-title">引用字体 (${xmp.fonts.length})</h3><div class="aw-adobe-chip-list">${xmp.fonts.map((f) => `<span class="aw-adobe-chip">${escapeHtml(f)}</span>`).join('')}</div></section>`
    : '';

  const statsLabel = [
    xmp.pageCount ? `${xmp.pageCount} 画板` : isPdfCompatible ? 'PDF 兼容' : 'PostScript',
    formatBytes(stat.size),
  ].join(' · ');

  const snippetLines = [
    `Illustrator 文件 · ${statsLabel}`,
    xmp.creatorTool || creatorDsc ? `软件：${xmp.creatorTool || creatorDsc}` : '',
    xmp.pageSize || bboxDsc ? `尺寸：${xmp.pageSize || bboxDsc}` : '',
  ].filter(Boolean);

  const warnings = [];
  if (isPdfCompatible && stat.size > MAX_AI_PDF_INLINE_BYTES) {
    warnings.push(`文件体积 ${formatBytes(stat.size)} 超过内嵌矢量预览上限（24 MB），已展示概要元数据；点击「打开」可在 Illustrator 中查看完整画板。`);
  } else if (!isPdfCompatible) {
    warnings.push('此 .ai 文件保存时未启用「创建 PDF 兼容文件」，已提取 PostScript / XMP 概要信息。');
  }

  return {
    ok: true,
    format: 'adobe',
    formatLabel: 'Illustrator 矢量图',
    badge: 'AI',
    path: filePath,
    title: path.basename(filePath),
    ext: 'ai',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    previewThumbDataUrl: xmp.thumbDataUrl || '',
    meta: { statsLabel },
    outline: [],
    bodyHtml: `<div class="aw-adobe-view">${previewHtml}${kvHtml}${fontsHtml}</div>`,
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings,
  };
}

// ── 5. Motion Graphics Template .mogrt (Bounded FD ZIP + v1.7 Schema) ───────

const MOGRT_CONTROL_TYPES = Object.freeze({
  1: '滑块',
  2: '角度',
  3: '复选框',
  4: '颜色',
  5: '下拉菜单',
  6: '媒体替换',
  7: '点控',
  8: '源文本',
  9: '字体',
  10: '参数组',
  11: '响应式时间',
  12: '文件引用',
  13: '下拉菜单',
  14: '分组容器',
});

const MOGRT_AUTHOR_APPS = Object.freeze({
  aefx: 'After Effects',
  ppro: 'Premiere Pro',
  ae: 'After Effects',
  pr: 'Premiere Pro',
});

function pickMogrtText(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    const first = val.map((v) => pickMogrtText(v)).find(Boolean);
    return first || '';
  }
  if (typeof val === 'object') {
    if (Array.isArray(val.strDB)) {
      const zh = val.strDB.find((x) => /zh/i.test(String(x?.localeString || x?.locale || '')) && x?.str);
      const en = val.strDB.find((x) => /en/i.test(String(x?.localeString || x?.locale || '')) && x?.str);
      const any = val.strDB.find((x) => typeof x?.str === 'string' && x.str.trim());
      return String((zh || en || any)?.str || '').trim();
    }
    for (const k of ['zh_CN', 'en_US', 'name', 'fontName', 'postScriptName', 'displayName', 'str', 'text', 'value']) {
      if (val[k] !== undefined && val[k] !== null) {
        const s = pickMogrtText(val[k]);
        if (s) return s;
      }
    }
    for (const v of Object.values(val)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

function formatMogrtControlValue(c) {
  const val = c?.value;
  if (val === null || val === undefined) return '—';
  if (Array.isArray(val)) {
    const allUuidLike = val.length > 0 && val.every((x) => typeof x === 'string' && /^[0-9a-f-]{16,}$/i.test(x));
    if (allUuidLike) return `含 ${val.length} 个子控件`;
    return val.map((x) => pickMogrtText(x) || String(x)).slice(0, 6).join(', ') || '—';
  }
  if (typeof val === 'object') {
    const txt = pickMogrtText(val);
    if (txt) return txt.slice(0, 100);
    if (typeof val.r === 'number' && typeof val.g === 'number' && typeof val.b === 'number') {
      return rgbToHex(val.r, val.g, val.b);
    }
    if (typeof val.x === 'number' && typeof val.y === 'number') {
      return `(${Math.round(val.x * 100) / 100}, ${Math.round(val.y * 100) / 100})`;
    }
    return '复合参数';
  }
  if (typeof val === 'boolean') return val ? '开启' : '关闭';
  return String(val).slice(0, 100);
}

function readZipDirectoryFromFd(fd, fileSize) {
  const tailLen = Math.min(fileSize, 65557);
  if (tailLen < 22) throw new Error('文件体积过小，不是有效的 ZIP/MOGRT 归档');
  const tailBuf = Buffer.allocUnsafe(tailLen);
  const rn = fs.readSync(fd, tailBuf, 0, tailLen, fileSize - tailLen);
  let eocdOff = -1;
  for (let i = rn - 22; i >= 0; i--) {
    if (tailBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff === -1) throw new Error('未找到 ZIP 结尾目录记录（EOCD）');
  const cdSize = tailBuf.readUInt32LE(eocdOff + 12);
  const cdOffset = tailBuf.readUInt32LE(eocdOff + 16);
  if (cdSize > 16 * 1024 * 1024 || cdOffset + cdSize > fileSize) {
    throw new Error('ZIP 中央目录偏移越界或体积异常');
  }
  const cdBuf = Buffer.allocUnsafe(cdSize);
  const cdRead = fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  while (p + 46 <= cdRead && entries.length < 4000) {
    if (cdBuf.readUInt32LE(p) !== 0x02014b50) break;
    const method = cdBuf.readUInt16LE(p + 10);
    const compressedSize = cdBuf.readUInt32LE(p + 20);
    const uncompressedSize = cdBuf.readUInt32LE(p + 24);
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commentLen = cdBuf.readUInt16LE(p + 32);
    const localHeaderOffset = cdBuf.readUInt32LE(p + 42);
    const name = cdBuf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZipEntryFromFd(fd, fileSize, entry, maxBytes = 4 * 1024 * 1024) {
  if (!entry || entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    throw new Error('归档条目体积超出安全上限');
  }
  const lfh = Buffer.allocUnsafe(30);
  if (fs.readSync(fd, lfh, 0, 30, entry.localHeaderOffset) < 30 || lfh.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('无效的 ZIP 局部文件头');
  }
  const nLen = lfh.readUInt16LE(26);
  const eLen = lfh.readUInt16LE(28);
  const dataPos = entry.localHeaderOffset + 30 + nLen + eLen;
  if (dataPos + entry.compressedSize > fileSize) throw new Error('ZIP 条目数据越界');
  const compBuf = Buffer.allocUnsafe(entry.compressedSize);
  fs.readSync(fd, compBuf, 0, entry.compressedSize, dataPos);
  if (entry.method === 0) return compBuf;
  if (entry.method === 8) return zlib.inflateRawSync(compBuf, { maxOutputLength: maxBytes });
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}

export function parseMogrtDocument(filePath, stat, { snippetOnly = false } = {}) {
  if (stat.size === 0) throw new Error('该 MOGRT 模板为空文件（0 字节）');
  const fd = fs.openSync(filePath, 'r');
  let entries = [];
  let def = null;
  let thumbDataUrl = '';
  try {
    entries = readZipDirectoryFromFd(fd, stat.size);
    const defEntry = entries.find((e) => /(?:^|\/)definition\.json$/i.test(e.name));
    if (defEntry) {
      try {
        const defBuf = extractZipEntryFromFd(fd, stat.size, defEntry, 4 * 1024 * 1024);
        def = JSON.parse(defBuf.toString('utf8'));
      } catch {}
    }
    const thumbEntry = entries.find((e) => /(?:^|\/)thumb(?:nail)?\.(?:png|jpg|jpeg|webp)$/i.test(e.name));
    if (thumbEntry && thumbEntry.uncompressedSize <= MAX_PSD_THUMB_BYTES) {
      try {
        const tBuf = extractZipEntryFromFd(fd, stat.size, thumbEntry, MAX_PSD_THUMB_BYTES);
        const tExt = path.extname(thumbEntry.name).toLowerCase();
        const mime = tExt === '.png' ? 'image/png' : tExt === '.webp' ? 'image/webp' : 'image/jpeg';
        thumbDataUrl = `data:${mime};base64,${tBuf.toString('base64')}`;
      } catch {}
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }

  const tplName = pickMogrtText(def?.capsuleName) || pickMogrtText(def?.name) || path.basename(filePath, '.mogrt');
  const rawAuthor = pickMogrtText(def?.authorApp) || pickMogrtText(def?.author) || '';
  const authorLabel =
    MOGRT_AUTHOR_APPS[rawAuthor.toLowerCase()] ||
    rawAuthor ||
    (entries.some((e) => /\.aegraphic$/i.test(e.name)) ? 'After Effects (.aegraphic)' : 'Premiere Pro');

  // Extract framesize / framerate / duration from real Adobe MOGRT v1.7 sourceInfo & sourceInfoLocalized (ignoring author temp parentprojectfile)
  let resW = Number(def?.capsuleWidth || def?.sourceInfoLocalized?.width || 0);
  let resH = Number(def?.capsuleHeight || def?.sourceInfoLocalized?.height || 0);
  let fpsVal = 0;
  let durVal = 0;
  const infoBlocks = [];
  if (def?.sourceInfo && typeof def.sourceInfo === 'object') infoBlocks.push(def.sourceInfo);
  if (def?.sourceInfoLocalized && typeof def.sourceInfoLocalized === 'object') {
    infoBlocks.push(def.sourceInfoLocalized, ...Object.values(def.sourceInfoLocalized));
  }
  for (const block of infoBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (!resW || !resH) {
      const fsObj = block.framesize || block.frameSize;
      if (Array.isArray(fsObj) && fsObj.length >= 2) {
        resW = Number(fsObj[0]) || resW;
        resH = Number(fsObj[1]) || resH;
      } else if (fsObj && typeof fsObj === 'object') {
        const inner = fsObj.size && typeof fsObj.size === 'object' ? fsObj.size : fsObj;
        resW = Number(inner.width || inner.x) || resW;
        resH = Number(inner.height || inner.y) || resH;
      } else if (block.width && block.height) {
        resW = Number(block.width) || resW;
        resH = Number(block.height) || resH;
      }
    }
    if (!fpsVal) {
      const fr = block.framerate ?? block.frameRate;
      if (typeof fr === 'number' && fr > 0) {
        fpsVal = Math.round(fr * 100) / 100;
      } else if (fr && typeof fr === 'object' && Number(fr.ticksperframe) > 0) {
        const calc = 254016000000 / Number(fr.ticksperframe);
        if (calc >= 1 && calc <= 240) fpsVal = Math.round(calc * 100) / 100;
      }
    }
    if (!durVal) {
      const dur = block.duration;
      if (typeof dur === 'number' && dur > 0) {
        durVal = dur;
      } else if (dur && typeof dur === 'object' && Number(dur.value) > 0 && Number(dur.scale) > 0) {
        durVal = Number(dur.value) / Number(dur.scale);
      }
    }
  }

  // Extract fonts from usedFontsLocalized + usedFonts safely (never [object Object])
  const fontSet = new Set();
  const collectFonts = (node) => {
    if (!node || fontSet.size >= 30) return;
    if (typeof node === 'string') {
      const s = node.trim();
      if (s && s.length <= 120) fontSet.add(s);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) collectFonts(item);
      return;
    }
    if (typeof node === 'object') {
      const direct = pickMogrtText(node.fontName || node.postScriptName || node.name || node.strDB);
      if (direct) {
        fontSet.add(direct);
        return;
      }
      for (const v of Object.values(node)) collectFonts(v);
    }
  };
  collectFonts(def?.usedFontsLocalized);
  collectFonts(def?.usedFonts);
  const usedFonts = Array.from(fontSet);

  const controls = Array.isArray(def?.clientControls) ? def.clientControls : [];

  const statsLabel = [
    resW && resH ? `${resW}×${resH}` : '',
    fpsVal ? `${fpsVal} fps` : '',
    `${controls.length} 个可编辑控件`,
    `${entries.length} 个包内文件`,
    formatBytes(stat.size),
  ]
    .filter(Boolean)
    .join(' · ');

  const previewHtml = thumbDataUrl
    ? `<div class="aw-adobe-preview-stage"><img class="aw-adobe-preview-img" src="${thumbDataUrl}" alt="${escapeHtml(tplName)}" /><div class="aw-adobe-preview-cap">MOGRT 内嵌模板封面</div></div>`
    : '';

  const kvHtml = renderKvGrid([
    { label: '模板名称', value: tplName },
    { label: '来源引擎', value: authorLabel },
    { label: '画幅 / 帧率', value: resW && resH ? `${resW} × ${resH}${fpsVal ? ` · ${fpsVal} fps` : ''}` : fpsVal ? `${fpsVal} fps` : '—' },
    { label: '模板时长', value: durVal > 0 ? formatDuration(durVal) : '—' },
    { label: '可调参数', value: `${controls.length} 项` },
    { label: '模板体积', value: `${formatBytes(stat.size)} (${entries.length} 文件)` },
  ]);

  const controlsHtml = controls.length
    ? `<section class="aw-adobe-section" id="aw-adobe-controls">
        <h3 class="aw-adobe-sec-title">基本图形可编辑控件 (${controls.length})</h3>
        <div class="aw-doc-table-wrap">
          <table class="aw-doc-table">
            <thead><tr><th>控件名称</th><th style="width:110px">类型</th><th>默认值 / 说明</th></tr></thead>
            <tbody>
              ${controls
                .slice(0, snippetOnly ? 6 : 100)
                .map((c) => {
                  const cname = pickMogrtText(c?.uiName) || pickMogrtText(c?.name) || pickMogrtText(c?.id) || '未命名控件';
                  const rawType = c?.type;
                  const ctype =
                    (typeof rawType === 'number' || /^\d+$/.test(String(rawType ?? ''))) && MOGRT_CONTROL_TYPES[Number(rawType)]
                      ? MOGRT_CONTROL_TYPES[Number(rawType)]
                      : rawType !== undefined
                      ? String(rawType)
                      : '参数';
                  const cval = formatMogrtControlValue(c);
                  return `<tr><td><strong>${escapeHtml(cname)}</strong></td><td><span class="aw-doc-zip-tag">${escapeHtml(ctype)}</span></td><td>${escapeHtml(cval)}</td></tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </section>`
    : '';

  const fontsHtml = usedFonts.length
    ? `<section class="aw-adobe-section"><h3 class="aw-adobe-sec-title">模板字体 (${usedFonts.length})</h3><div class="aw-adobe-chip-list">${usedFonts.slice(0, 24).map((f) => `<span class="aw-adobe-chip">${escapeHtml(f)}</span>`).join('')}</div></section>`
    : '';

  const snippetLines = [
    `MOGRT 动态图形模板 · ${tplName}`,
    `${resW && resH ? `${resW}×${resH} · ` : ''}${controls.length} 个可编辑控件 · ${entries.length} 个包内文件`,
  ];

  return {
    ok: true,
    format: 'adobe',
    formatLabel: '动态图形模板 (MOGRT)',
    badge: 'MOGRT',
    path: filePath,
    title: path.basename(filePath),
    ext: 'mogrt',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    previewThumbDataUrl: thumbDataUrl,
    meta: { statsLabel },
    outline: controls.length ? [{ id: 'aw-adobe-controls', title: `可编辑控件 (${controls.length})`, level: 1 }] : [],
    bodyHtml: `<div class="aw-adobe-view">${previewHtml}${kvHtml}${controlsHtml}${fontsHtml}</div>`,
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings: [],
  };
}

// ── 6. Premiere Text Style .prtextstyle ─────────────────────────────────────

export function parsePrTextStyleDocument(filePath, stat) {
  if (stat.size === 0) throw new Error('该 Premiere 字幕样式文件为空文件（0 字节）');
  let buf = readFileSlice(filePath, 0, Math.min(stat.size, MAX_TEXT_ADOBE_BYTES));
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_TEXT_ADOBE_BYTES });
  }
  const xml = buf.toString('utf8');
  if (!xml.includes('<PremiereData')) {
    throw new Error('未检测到有效的 Premiere Pro 文本样式 XML（缺少 <PremiereData>）');
  }
  const names = Array.from(xml.matchAll(/<Name>([^<]{1,120})<\/Name>/g))
    .map((m) => decodeXmlEntities(m[1]).trim())
    .filter((n) => n && n !== 'Root Bin' && n !== '源文本' && n !== 'Source Text');
  const styleName = names[0] || path.basename(filePath, '.prtextstyle');
  const frameSizeM = /<FrameSize>0,0,(\d+),(\d+)<\/FrameSize>/.exec(xml);
  const frameSize = frameSizeM ? `${frameSizeM[1]} × ${frameSizeM[2]}` : '—';
  const verM = /<Project\b[^>]*Version="(\d+)"/.exec(xml);
  const schemaVer = verM ? Number(verM[1]) : 0;

  // Scan base64 StartKeyframeValue for embedded font PostScript names
  const fonts = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<StartKeyframeValue[^>]*Encoding="base64"[^>]*>([\s\S]{16,120000}?)<\/StartKeyframeValue>/gi)) {
    try {
      const decoded = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
      const asciiMatches = decoded.toString('latin1').match(/[A-Za-z][A-Za-z0-9_-]{3,48}(?:Sans|Serif|Hei|Song|Kai|Mono|Bold|Regular|Medium|Light|Heavy|Black|CN|SC|TC|JP|Pro|Std|UI|Gothic|Mincho)[A-Za-z0-9_-]{0,20}/g);
      for (const f of asciiMatches || []) {
        if (!seen.has(f) && fonts.length < 12) {
          seen.add(f);
          fonts.push(f);
        }
      }
      const utf16Str = decoded.toString('utf16le');
      const uMatches = utf16Str.match(/[A-Za-z][A-Za-z0-9_-]{3,42}(?:Sans|Serif|Hei|Song|Bold|Regular|Medium|Light|Heavy|CN|SC|JP|Pro|Std)[A-Za-z0-9_-]{0,16}/g);
      for (const f of uMatches || []) {
        if (!seen.has(f) && fonts.length < 12) {
          seen.add(f);
          fonts.push(f);
        }
      }
    } catch {}
  }

  const statsLabel = [
    styleName,
    fonts[0] || '',
    formatBytes(stat.size),
  ]
    .filter(Boolean)
    .join(' · ');

  const kvHtml = renderKvGrid([
    { label: '样式名称', value: styleName },
    { label: '识别字体', value: fonts.join(', ') || '内嵌二进制样式定义' },
    { label: '基准画幅', value: frameSize },
    { label: 'Premiere 格式', value: PR_VERSION_LABELS[schemaVer] || (schemaVer ? `Schema v${schemaVer}` : 'Premiere Pro') },
    { label: '文件大小', value: formatBytes(stat.size) },
  ]);

  const snippetLines = [
    `Premiere Pro 文本样式 · ${styleName}`,
    fonts.length ? `字体：${fonts.join(', ')}` : '',
    `基准画幅：${frameSize}`,
  ].filter(Boolean);

  return {
    ok: true,
    format: 'adobe',
    formatLabel: 'Premiere 字幕样式 (.prtextstyle)',
    badge: 'PRTEXTSTYLE',
    path: filePath,
    title: path.basename(filePath),
    ext: 'prtextstyle',
    sizeBytes: stat.size,
    autoRender: true,
    preferWhenRawCode: true,
    supportsPaperMode: false,
    meta: { statsLabel },
    outline: [],
    bodyHtml: `<div class="aw-adobe-view">${kvHtml}</div>`,
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings: [],
  };
}

// ── 7. Adobe Audition Session .sesx (XML Multitrack Summary) ────────────────

export function parseSesxDocument(filePath, stat) {
  if (stat.size === 0) throw new Error('该 Audition 工程文件为空文件（0 字节）');
  const buf = readFileSlice(filePath, 0, Math.min(stat.size, MAX_TEXT_ADOBE_BYTES));
  const xml = buf.toString('utf8');
  if (!/<sesx\b|<session\b/i.test(xml)) {
    throw new Error('未检测到标准 Adobe Audition .sesx XML 结构');
  }
  const sessTag = /<session\b([^>]*)>/i.exec(xml)?.[1] || '';
  const sampleRate = /sampleRate="(\d+)"/i.exec(sessTag)?.[1] || '';
  const bitDepth = /bitDepth="(\d+)"/i.exec(sessTag)?.[1] || '';
  const durSamples = Number(/duration="(\d+)"/i.exec(sessTag)?.[1] || 0);
  const durSec = durSamples && Number(sampleRate) > 0 ? durSamples / Number(sampleRate) : 0;

  const tracks = [];
  for (const m of xml.matchAll(/<audioTrack\b[^>]*>[\s\S]{0,2500}?<title>([^<]{1,120})<\/title>/gi)) {
    if (tracks.length < 100) tracks.push(decodeXmlEntities(m[1]).trim());
  }
  const files = [];
  for (const m of xml.matchAll(/<file\b[^>]*absolutePath="([^"]+)"/gi)) {
    const p = decodeXmlEntities(m[1]).trim();
    if (p && files.length < 150) files.push(p);
  }

  const statsLabel = [
    sampleRate ? `${sampleRate} Hz` : '',
    bitDepth ? `${bitDepth}-bit` : '',
    durSec ? formatDuration(durSec) : '',
    `${tracks.length} 音轨`,
  ]
    .filter(Boolean)
    .join(' · ');

  const kvHtml = renderKvGrid([
    { label: '采样率 / 位深', value: `${sampleRate || '—'} Hz · ${bitDepth || '—'}-bit` },
    { label: '工程时长', value: durSec ? formatDuration(durSec) : '—' },
    { label: '多轨数量', value: `${tracks.length} 条音频轨` },
    { label: '引用音频素材', value: `${files.length} 个` },
  ]);

  const tracksHtml = tracks.length
    ? `<section class="aw-adobe-section"><h3 class="aw-adobe-sec-title">音频轨道 (${tracks.length})</h3><div class="aw-adobe-chip-list">${tracks.map((t, i) => `<span class="aw-adobe-chip">#${i + 1} ${escapeHtml(t)}</span>`).join('')}</div></section>`
    : '';
  const filesHtml = files.length
    ? `<section class="aw-adobe-section"><h3 class="aw-adobe-sec-title">引用音频文件 (${files.length})</h3><div class="aw-doc-table-wrap"><table class="aw-doc-table"><thead><tr><th>文件名</th><th>路径</th></tr></thead><tbody>${files
        .slice(0, 120)
        .map((f) => `<tr><td>${escapeHtml(f.split(/[\\/]/).pop() || f)}</td><td class="aw-adobe-path-cell">${escapeHtml(f)}</td></tr>`)
        .join('')}</tbody></table></div></section>`
    : '';

  const snippetLines = [`Adobe Audition 多轨工程 · ${statsLabel}`, ...tracks.slice(0, 6).map((t) => `音轨：${t}`)];

  return {
    ok: true,
    format: 'adobe',
    formatLabel: 'Audition 多轨工程',
    badge: 'SESX',
    path: filePath,
    title: path.basename(filePath),
    ext: 'sesx',
    sizeBytes: stat.size,
    autoRender: true,
    preferWhenRawCode: true,
    supportsPaperMode: false,
    meta: { statsLabel },
    outline: [],
    bodyHtml: `<div class="aw-adobe-view">${kvHtml}${tracksHtml}${filesHtml}</div>`,
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings: [],
  };
}

// ── 8. Adobe InDesign .indd (Bounded XMP + Embedded Page-1 Preview) ─────────

const INDD_GUID_MAGIC = Buffer.from([
  0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d,
]);

export function parseInddDocument(filePath, stat) {
  if (stat.size === 0) throw new Error('该 InDesign 文档为空文件（0 字节）');
  const headBuf = readFileSlice(filePath, 0, Math.min(stat.size, MAX_INDD_HEAD_BYTES));
  if (headBuf.length < 16 || !headBuf.subarray(0, 16).equals(INDD_GUID_MAGIC)) {
    throw new Error('文件头不是有效的 Adobe InDesign (.indd) 格式');
  }
  const tailStart = Math.max(0, stat.size - MAX_INDD_TAIL_BYTES);
  const tailBuf = tailStart === 0 ? Buffer.alloc(0) : readFileSlice(filePath, tailStart, MAX_INDD_TAIL_BYTES);
  const xmp = extractXmpFields(headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8'));

  const statsLabel = [
    xmp.pageCount ? `${xmp.pageCount} 页` : 'InDesign 排版',
    xmp.pageSize || '',
    formatBytes(stat.size),
  ]
    .filter(Boolean)
    .join(' · ');

  const previewHtml = xmp.thumbDataUrl
    ? `<div class="aw-adobe-preview-stage"><img class="aw-adobe-preview-img" src="${xmp.thumbDataUrl}" alt="${escapeHtml(path.basename(filePath))}" /><div class="aw-adobe-preview-cap">InDesign 内嵌首页缩略图</div></div>`
    : '<div class="aw-adobe-preview-empty">未在文件 XMP 中检测到首页缩略图，以下为文档排版概要信息。</div>';

  const kvHtml = renderKvGrid([
    { label: '创建软件', value: xmp.creatorTool || 'Adobe InDesign' },
    { label: '页数', value: xmp.pageCount ? `${xmp.pageCount} 页` : '—' },
    { label: '页面尺寸', value: xmp.pageSize || '—' },
    { label: '字体数量', value: xmp.fonts.length ? `${xmp.fonts.length} 种` : '—' },
    { label: '修改时间', value: xmp.modifyDate || xmp.createDate || '—' },
    { label: '文件大小', value: formatBytes(stat.size) },
  ]);

  const fontsHtml = xmp.fonts.length
    ? `<section class="aw-adobe-section"><h3 class="aw-adobe-sec-title">引用字体 (${xmp.fonts.length})</h3><div class="aw-adobe-chip-list">${xmp.fonts.map((f) => `<span class="aw-adobe-chip">${escapeHtml(f)}</span>`).join('')}</div></section>`
    : '';

  const snippetLines = [
    `InDesign 文档 · ${statsLabel}`,
    xmp.creatorTool ? `软件：${xmp.creatorTool}` : '',
    xmp.fonts.length ? `字体：${xmp.fonts.slice(0, 4).join('、')}` : '',
  ].filter(Boolean);

  return {
    ok: true,
    format: 'adobe',
    formatLabel: 'InDesign 排版文档',
    badge: 'INDD',
    path: filePath,
    title: path.basename(filePath),
    ext: 'indd',
    sizeBytes: stat.size,
    autoRender: true,
    supportsPaperMode: false,
    previewThumbDataUrl: xmp.thumbDataUrl || '',
    meta: { statsLabel },
    outline: [],
    bodyHtml: `<div class="aw-adobe-view">${previewHtml}${kvHtml}${fontsHtml}</div>`,
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings: [],
  };
}

// ── 9. Adobe / Iridas 3D LUT .cube (Color Grading Swatch Preview) ───────────

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function rgbToHex(r, g, b) {
  const h = (x) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function sampleCubeLut3d(table, n, r, g, b) {
  if (!n || table.length < n * n * n * 3) return [r, g, b];
  const x = clamp01(r) * (n - 1);
  const y = clamp01(g) * (n - 1);
  const z = clamp01(b) * (n - 1);
  const x0 = Math.floor(x), x1 = Math.min(n - 1, x0 + 1), fx = x - x0;
  const y0 = Math.floor(y), y1 = Math.min(n - 1, y0 + 1), fy = y - y0;
  const z0 = Math.floor(z), z1 = Math.min(n - 1, z0 + 1), fz = z - z0;
  const get = (xi, yi, zi, c) => table[((zi * n + yi) * n + xi) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = get(x0, y0, z0, c), c100 = get(x1, y0, z0, c);
    const c010 = get(x0, y1, z0, c), c110 = get(x1, y1, z0, c);
    const c001 = get(x0, y0, z1, c), c101 = get(x1, y0, z1, c);
    const c011 = get(x0, y1, z1, c), c111 = get(x1, y1, z1, c);
    const c00 = c000 + (c100 - c000) * fx;
    const c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx;
    const c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    out[c] = clamp01(c0 + (c1 - c0) * fz);
  }
  return out;
}

export function parseCubeLutDocument(filePath, stat) {
  if (stat.size === 0) throw new Error('该 LUT 文件为空文件（0 字节）');
  const buf = readFileSlice(filePath, 0, Math.min(stat.size, MAX_TEXT_ADOBE_BYTES));
  const lines = buf.toString('utf8').split(/\r?\n/);
  let title = '';
  let size3d = 0;
  let size1d = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE\b/i.test(line)) {
      title = line.replace(/^TITLE\s*/i, '').replace(/^["']|["']$/g, '').trim();
    } else if (/^LUT_3D_SIZE\b/i.test(line)) {
      size3d = parseInt(line.split(/\s+/)[1], 10) || 0;
    } else if (/^LUT_1D_SIZE\b/i.test(line)) {
      size1d = parseInt(line.split(/\s+/)[1], 10) || 0;
    } else if (/^DOMAIN_MIN\b/i.test(line)) {
      const p = line.split(/\s+/).slice(1, 4).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) domainMin = p;
    } else if (/^DOMAIN_MAX\b/i.test(line)) {
      const p = line.split(/\s+/).slice(1, 4).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) domainMax = p;
    } else {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const r = Number(parts[0]);
        const g = Number(parts[1]);
        const b = Number(parts[2]);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          values.push(r, g, b);
        }
      }
    }
  }

  if ((size3d < 2 && size1d < 2) || values.length < 6) {
    throw new Error('未检测到有效的 .cube LUT 维度声明或 RGB 采样数据');
  }

  const swatches = [
    { name: '暗部 Shadow', rgb: [0.12, 0.14, 0.18] },
    { name: '中灰 Mid', rgb: [0.5, 0.5, 0.5] },
    { name: '高光 High', rgb: [0.88, 0.88, 0.86] },
    { name: '暖肤 Skin', rgb: [0.82, 0.64, 0.55] },
    { name: '晴空 Sky', rgb: [0.32, 0.62, 0.92] },
    { name: '青绿 Foliage', rgb: [0.32, 0.65, 0.36] },
    { name: '落日 Warm', rgb: [0.92, 0.48, 0.25] },
    { name: '洋红 Accent', rgb: [0.78, 0.28, 0.54] },
  ];

  const lutArr = new Float32Array(values);
  const normCh = (v, c) => {
    const span = domainMax[c] - domainMin[c];
    if (!Number.isFinite(span) || Math.abs(span) < 1e-6) return clamp01(v);
    return clamp01((v - domainMin[c]) / span);
  };
  const apply1d = (arr, n1, r, g, b) => {
    const pick = (v, c) => {
      const pos = clamp01(v) * (n1 - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(n1 - 1, i0 + 1);
      const t = pos - i0;
      return clamp01(arr[i0 * 3 + c] + (arr[i1 * 3 + c] - arr[i0 * 3 + c]) * t);
    };
    return [pick(r, 0), pick(g, 1), pick(b, 2)];
  };
  const sampleFn = (r, g, b) => {
    let nr = normCh(r, 0);
    let ng = normCh(g, 1);
    let nb = normCh(b, 2);
    const has1d = size1d >= 2 && lutArr.length >= size1d * 3;
    const need3d = size3d >= 2 ? size3d * size3d * size3d * 3 : 0;
    if (has1d && need3d && lutArr.length >= size1d * 3 + need3d) {
      [nr, ng, nb] = apply1d(lutArr, size1d, nr, ng, nb);
      return sampleCubeLut3d(lutArr.subarray(size1d * 3), size3d, nr, ng, nb);
    }
    if (need3d && lutArr.length >= need3d) {
      return sampleCubeLut3d(lutArr, size3d, nr, ng, nb);
    }
    if (has1d) {
      return apply1d(lutArr, size1d, nr, ng, nb);
    }
    return [r, g, b];
  };

  const swatchHtml = `<section class="aw-adobe-section">
    <h3 class="aw-adobe-sec-title">标准色卡调色前后对比（左：原色 / 右：套用 LUT 后）</h3>
    <div class="aw-lut-grid">
      ${swatches
        .map((sw) => {
          const beforeHex = rgbToHex(...sw.rgb);
          const afterHex = rgbToHex(...sampleFn(...sw.rgb));
          return `<div class="aw-lut-card">
            <div class="aw-lut-split">
              <span style="background:${beforeHex}" title="原色 ${beforeHex}"></span>
              <span style="background:${afterHex}" title="LUT 后 ${afterHex}"></span>
            </div>
            <div class="aw-lut-label"><strong>${escapeHtml(sw.name)}</strong><span>${beforeHex} → ${afterHex}</span></div>
          </div>`;
        })
        .join('')}
    </div>
  </section>`;

  const statsLabel = [
    size3d ? `3D LUT ${size3d}³` : size1d ? `1D LUT ${size1d}` : 'LUT',
    title || '',
    formatBytes(stat.size),
  ]
    .filter(Boolean)
    .join(' · ');

  const kvHtml = renderKvGrid([
    { label: 'LUT 标题', value: title || path.basename(filePath, '.cube') },
    { label: '查找表维度', value: size3d ? `3D (${size3d} × ${size3d} × ${size3d} = ${size3d ** 3} 点)` : size1d ? `1D (${size1d} 点)` : '未知' },
    { label: '输入域', value: `[${domainMin.join(', ')}] → [${domainMax.join(', ')}]` },
    { label: '解析采样点', value: `${Math.floor(values.length / 3)} 条 RGB` },
  ]);

  const snippetLines = [
    `Adobe 调色查找表 (.cube) · ${statsLabel}`,
    `输入域：[${domainMin.join(', ')}] → [${domainMax.join(', ')}]`,
  ];

  return {
    ok: true,
    format: 'adobe',
    formatLabel: '3D LUT 调色预设 (.cube)',
    badge: 'CUBE',
    path: filePath,
    title: title || path.basename(filePath),
    ext: 'cube',
    sizeBytes: stat.size,
    autoRender: false,
    optionalTable: true,
    supportsPaperMode: false,
    meta: { statsLabel },
    outline: [],
    bodyHtml: `<div class="aw-adobe-view">${kvHtml}${swatchHtml}</div>`,
    plainText: snippetLines.join('\n'),
    snippetLines,
    warnings: [],
  };
}
