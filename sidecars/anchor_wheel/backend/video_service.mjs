import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSafeReadPath } from './security.mjs';

export const VIDEO_EXTENSIONS = Object.freeze(
  new Set([
    '.mp4',
    '.m4v',
    '.mov',
    '.qt',
    '.mkv',
    '.webm',
    '.avi',
    '.flv',
    '.f4v',
    '.wmv',
    '.asf',
    '.ts',
    '.mts',
    '.m2ts',
    '.mpg',
    '.mpeg',
    '.m2v',
    '.ogv',
    '.3gp',
    '.3g2',
    '.rmvb',
    '.rm',
    '.vob',
    '.mxf',
    '.divx',
  ])
);

export const AUDIO_EXTENSIONS = Object.freeze(
  new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma', '.aiff', '.aif'])
);

export const MEDIA_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  // Video: serve .mov / .m4v as video/mp4 in direct fallback so Chromium plays H.264 MOV natively even without ffmpeg
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.qt': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.f4v': 'video/mp4',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.m2v': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.rm': 'application/vnd.rn-realmedia',
  '.vob': 'video/mpeg',
  '.mxf': 'application/mxf',
  '.divx': 'video/x-msvideo',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
});

const MP4_DIRECT_EXTS = new Set(['.mp4', '.m4v']);
const UNSUPPORTED_NATIVE_CONTAINERS = new Set([
  '.mkv', '.avi', '.wmv', '.asf', '.flv', '.f4v', '.ts', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.m2v', '.3gp', '.3g2', '.rmvb', '.rm', '.vob', '.mxf', '.divx',
]);
const REMUX_CANDIDATE_EXTS = new Set(['.mov', '.qt', '.mkv', '.ts', '.mts', '.m2ts', '.flv', '.f4v', '.3gp', '.3g2', '.m4v', '.mp4']);
const SAFE_MP4_VIDEO_CODECS = new Set(['h264', 'av1', 'vp9']);
const SAFE_WEBM_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1']);
const SAFE_MP4_AUDIO_CODECS = new Set(['', 'aac', 'mp3', 'flac', 'opus']);
const SAFE_WEBM_AUDIO_CODECS = new Set(['', 'opus', 'vorbis']);
const SAFE_8BIT_PIX_FMTS = new Set(['', 'yuv420p', 'yuvj420p', 'nv12']);
export const ALPHA_PIX_FMT_RE = /^(?:yuva|rgba|bgra|argb|abgr|gbrap|ya)/i;

const MAX_REMUX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CACHED_TRANSCODE_DURATION_SEC = 360;
const MAX_CACHED_TRANSCODE_UNKNOWN_DUR_BYTES = 1024 * 1024 * 1024;
const MAX_RAW_SERVE_BYTES = 128 * 1024 * 1024;
const MAX_INLINE_BLOB_BYTES = 24 * 1024 * 1024;
const MAX_MEDIA_CACHE_FILES = 20;
const MAX_MEDIA_CACHE_BYTES = 300 * 1024 * 1024;
const MAX_PROBE_CACHE = 160;
const FAILED_JOB_TTL_MS = 45 * 1000;

export function isVideoFilePath(filePath) {
  if (!filePath) return false;
  const ext = path.extname(String(filePath).replace(/[\\/]+$/, '')).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export function isAudioFilePath(filePath) {
  if (!filePath) return false;
  const ext = path.extname(String(filePath).replace(/[\\/]+$/, '')).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

export function getMediaMimeForExt(ext) {
  const clean = String(ext || '').toLowerCase();
  const normalized = clean.startsWith('.') ? clean : `.${clean}`;
  return MEDIA_MIME_BY_EXT[normalized] || 'application/octet-stream';
}

function findBinaryRecursive(rootDir, exeName, maxDepth = 3, curDepth = 0) {
  if (curDepth > maxDepth) return '';
  try {
    if (!fs.existsSync(rootDir)) return '';
    const direct = path.join(rootDir, exeName);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    const binDirect = path.join(rootDir, 'bin', exeName);
    if (fs.existsSync(binDirect) && fs.statSync(binDirect).isFile()) return binDirect;
    if (curDepth === maxDepth) return '';
    for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const hit = findBinaryRecursive(path.join(rootDir, ent.name), exeName, maxDepth, curDepth + 1);
      if (hit) return hit;
    }
  } catch {}
  return '';
}

let cachedBinaries = null;

export function detectMediaBinaries({ force = false } = {}) {
  if (cachedBinaries && !force) return cachedBinaries;
  const isWin = process.platform === 'win32';
  const exeFfmpeg = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const exeFfprobe = isWin ? 'ffprobe.exe' : 'ffprobe';
  const cmd = isWin ? 'where' : 'which';

  let ffmpegBin = '';
  try {
    const out = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', timeout: 2200, windowsHide: true });
    ffmpegBin =
      String(out || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && fs.existsSync(s)) || '';
  } catch {}

  if (!ffmpegBin) {
    const searchRoots = isWin
      ? [
          'C:\\ffmpeg',
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg'),
          path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
          path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
          path.join(os.homedir(), 'scoop', 'shims'),
          'C:\\ProgramData\\chocolatey\\bin',
        ]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/opt/local/bin',
          '/snap/bin',
          path.join(os.homedir(), '.local', 'bin'),
        ];
    for (const root of searchRoots) {
      if (!root) continue;
      const depth = /ffmpeg|Packages$/i.test(root) ? 3 : 1;
      const hit = findBinaryRecursive(root, exeFfmpeg, depth);
      if (hit) {
        ffmpegBin = hit;
        break;
      }
    }
  }

  let ffprobeBin = '';
  if (ffmpegBin) {
    const sibling = path.join(path.dirname(ffmpegBin), exeFfprobe);
    if (fs.existsSync(sibling)) ffprobeBin = sibling;
  }
  if (!ffprobeBin) {
    try {
      const out = execFileSync(cmd, ['ffprobe'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      ffprobeBin =
        String(out || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s && fs.existsSync(s)) || '';
    } catch {}
  }

  cachedBinaries = { ffmpegBin, ffprobeBin };
  return cachedBinaries;
}

export function formatDurationShort(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytesShort(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseFrameRate(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '0/0') return 0;
  const parts = s.split('/');
  if (parts.length === 2) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      const val = a / b;
      return val > 0 && val <= 240 ? Math.round(val * 100) / 100 : 0;
    }
  }
  const num = Number(s);
  return Number.isFinite(num) && num > 0 && num <= 240 ? Math.round(num * 100) / 100 : 0;
}

export function decideVideoStrategy({ ext, sizeBytes, probe, hasFfmpeg }) {
  const lowExt = String(ext || '').toLowerCase();
  const vCodec = String(probe?.videoCodec || '').toLowerCase();
  const aCodec = String(probe?.audioCodec || '').toLowerCase();
  const pixFmt = String(probe?.pixFmt || '').toLowerCase();
  const duration = Number(probe?.duration || 0);

  const safePix = SAFE_8BIT_PIX_FMTS.has(pixFmt);
  const safeMp4Video = SAFE_MP4_VIDEO_CODECS.has(vCodec) && safePix;
  const safeWebmVideo = SAFE_WEBM_VIDEO_CODECS.has(vCodec) && safePix;
  const safeMp4Audio = SAFE_MP4_AUDIO_CODECS.has(aCodec);
  const safeWebmAudio = SAFE_WEBM_AUDIO_CODECS.has(aCodec);

  if (probe) {
    if (MP4_DIRECT_EXTS.has(lowExt) && safeMp4Video && safeMp4Audio) {
      return { strategy: 'direct', copyAudio: true, reason: '原生 MP4 兼容流' };
    }
    if (lowExt === '.webm' && safeWebmVideo && safeWebmAudio) {
      return { strategy: 'direct', copyAudio: true, reason: '原生 WebM 兼容流' };
    }
    if (lowExt === '.ogv' && (vCodec === 'theora' || vCodec === 'vp8') && safeWebmAudio) {
      return { strategy: 'direct', copyAudio: true, reason: '原生 Ogg 兼容流' };
    }
  } else if (!hasFfmpeg && (MP4_DIRECT_EXTS.has(lowExt) || lowExt === '.webm' || lowExt === '.ogv')) {
    return { strategy: 'direct', copyAudio: true, reason: '直接流式播放' };
  }

  if (!hasFfmpeg) {
    return {
      strategy: 'native_fallback',
      copyAudio: false,
      reason: '未检测到本机 ffmpeg，已尝试以兼容 MIME 直接播放',
    };
  }

  // Fast lossless video remux (H.264/AV1/VP9 8-bit inside .mov/.mkv/.ts/.flv/.mp4 with non-standard audio)
  if (probe && safeMp4Video && REMUX_CANDIDATE_EXTS.has(lowExt) && sizeBytes <= MAX_REMUX_BYTES) {
    const canCopyAudio = aCodec === '' || aCodec === 'aac' || aCodec === 'mp3';
    return {
      strategy: 'remux',
      copyAudio: canCopyAudio,
      reason: canCopyAudio
        ? `无损极速封装 ${lowExt.slice(1).toUpperCase()} → MP4`
        : `视频直通 + 音频转 AAC（${aCodec.toUpperCase()}）`,
    };
  }

  // Incompatible codec (ProRes, HEVC/H.265, 10-bit, Alpha MOV, AVI/DivX/Xvid, WMV, MPEG-2, RMVB, VOB, etc.)
  const shortEnoughToCache =
    (duration > 0 && duration <= MAX_CACHED_TRANSCODE_DURATION_SEC) ||
    (!duration && sizeBytes <= MAX_CACHED_TRANSCODE_UNKNOWN_DUR_BYTES);

  if (shortEnoughToCache) {
    const codecNote = vCodec ? `${vCodec.toUpperCase()}${pixFmt && !safePix ? `/${pixFmt}` : ''}` : lowExt.slice(1).toUpperCase();
    return {
      strategy: 'transcode_cached',
      copyAudio: false,
      reason: `转码为侧边栏兼容 MP4（原编码 ${codecNote}）`,
    };
  }

  return {
    strategy: 'transcode_live',
    copyAudio: false,
    reason: `长视频实时转码流（${vCodec ? vCodec.toUpperCase() : lowExt.slice(1).toUpperCase()}）`,
  };
}

export function parseHttpRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader || !Number.isFinite(totalSize) || totalSize <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!m) return { invalid: true };
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return { invalid: true };
  if (m[1] === '') {
    const suffixLen = Number(m[2]);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { invalid: true };
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? totalSize - 1 : Math.min(totalSize - 1, Number(m[2]));
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
    return { invalid: true };
  }
  return { start, end, chunkSize: end - start + 1 };
}

function timingSafeTokenEquals(a, b) {
  const sa = Buffer.from(String(a || ''), 'utf8');
  const sb = Buffer.from(String(b || ''), 'utf8');
  if (sa.length !== sb.length || sa.length === 0) return false;
  return crypto.timingSafeEqual(sa, sb);
}

const SCALE_VF =
  'scale=w=if(gt(iw\\,ih)\\,min(1280\\,iw)\\,-2):h=if(gt(iw\\,ih)\\,-2\\,min(1280\\,ih)),scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';

export function buildAlphaCheckerFilter(scaleExpr, { cellSize = 16 } = {}) {
  const cs = Math.max(6, Math.min(32, Number(cellSize) || 16));
  return `[0:v:0]${scaleExpr},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=rgba[fg];[fg]split[fg_ref][fg_ov];[fg_ref]trim=end_frame=1,geq=r='if(eq(mod(floor(X/${cs})+floor(Y/${cs}),2),0),36,52)':g='if(eq(mod(floor(X/${cs})+floor(Y/${cs}),2),0),39,56)':b='if(eq(mod(floor(X/${cs})+floor(Y/${cs}),2),0),46,64)':a=255,loop=-1:1:0[bg];[bg][fg_ov]overlay=0:0:shortest=1:format=auto,format=yuv420p[vout]`;
}

export function parseFfmpegStderrProbe(stderrText) {
  const text = String(stderrText || '');
  if (!text) return null;
  let duration = 0;
  const durM = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(text);
  if (durM) {
    duration = Math.round((Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])) * 100) / 100;
  }
  const vLineM = /Stream\s+#\d+:\d+[^\n]*Video:\s*([^\n]+)/i.exec(text);
  if (!vLineM) return null;
  const vLine = vLineM[1];
  const codecM = /^([a-z0-9_]+)/i.exec(vLine.trim());
  const videoCodec = codecM ? codecM[1].toLowerCase() : '';
  const dimM = /,\s*(\d{2,5})x(\d{2,5})(?:\s|\[|,)/i.exec(vLine);
  const width = dimM ? Number(dimM[1]) : 0;
  const height = dimM ? Number(dimM[2]) : 0;
  const fpsM = /,\s*(\d+(?:\.\d+)?)\s*(?:fps|tbr)\b/i.exec(vLine);
  const fps = fpsM ? Math.round(Number(fpsM[1]) * 100) / 100 : 0;
  const pixM = /,\s*((?:yuva?|rgba?|bgra?|argb|abgr|gbrap?|nv12|gray|ya)[a-z0-9_]*)(?:\(|,|\s)/i.exec(vLine);
  const pixFmt = pixM ? pixM[1].toLowerCase() : '';
  const aLineM = /Stream\s+#\d+:\d+[^\n]*Audio:\s*([a-z0-9_]+)/i.exec(text);
  const audioCodec = aLineM ? aLineM[1].toLowerCase() : '';
  const hasAlpha = ALPHA_PIX_FMT_RE.test(pixFmt);
  if (!videoCodec && !width && !duration) return null;
  return {
    duration,
    width,
    height,
    fps,
    videoCodec,
    audioCodec,
    pixFmt,
    hasAlpha,
    bitrate: 0,
    formatName: '',
  };
}

const ALPHA_CHECKER_FC = buildAlphaCheckerFilter(
  'scale=w=if(gt(iw\\,ih)\\,min(1280\\,iw)\\,-2):h=if(gt(iw\\,ih)\\,-2\\,min(1280\\,ih))',
  { cellSize: 16 }
);

function buildTranscodeArgs(filePath, outTarget, { hasAlpha = false, live = false, startSec = 0 } = {}) {
  const safeStart = Number.isFinite(startSec) && startSec > 0 ? startSec : 0;
  const inputArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(live && safeStart > 0 ? ['-ss', String(safeStart)] : []),
    '-i',
    filePath,
  ];
  const filterArgs = hasAlpha
    ? ['-filter_complex', ALPHA_CHECKER_FC, '-map', '[vout]', '-map', '0:a:0?']
    : ['-map', '0:v:0', '-map', '0:a:0?', '-vf', SCALE_VF];
  const encodeArgs = [
    '-c:v',
    'libx264',
    '-preset',
    live ? 'ultrafast' : 'veryfast',
    '-crf',
    live ? '25' : '23',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '4',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-movflags',
    live ? 'frag_keyframe+empty_moov+default_base_moof' : '+faststart',
    '-f',
    'mp4',
    ...(live ? [outTarget] : ['-y', outTarget]),
  ];
  return [...inputArgs, ...filterArgs, ...encodeArgs];
}

export class VideoService {
  constructor(dataDir, options = {}) {
    const bins = detectMediaBinaries();
    this.cacheDir = path.join(String(dataDir || process.cwd()), 'media_cache');
    this.ffmpegBin = options.ffmpegBin !== undefined ? options.ffmpegBin : bins.ffmpegBin;
    this.ffprobeBin = options.ffprobeBin !== undefined ? options.ffprobeBin : bins.ffprobeBin;
    this.mediaToken = options.mediaToken || crypto.randomBytes(16).toString('hex');
    this.probeCache = new Map();
    this.inflightJobs = new Map();
    this.failedJobs = new Map();
    this.activeProcs = new Set();
    this.disposed = false;
  }

  verifyMediaToken(token) {
    return timingSafeTokenEquals(token, this.mediaToken);
  }

  dispose() {
    this.disposed = true;
    for (const child of this.activeProcs) {
      try { child.kill(); } catch {}
    }
    this.activeProcs.clear();
  }

  #ensureCacheDir() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch {}
  }

  #makeCacheHash(fileKey, stat) {
    return crypto
      .createHash('sha1')
      .update(`${fileKey}|${stat.mtimeMs}|${stat.size}`)
      .digest('hex')
      .slice(0, 20);
  }

  #pruneDiskCacheIfNeeded() {
    try {
      if (!fs.existsSync(this.cacheDir)) return;
      const entries = [];
      let totalBytes = 0;
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (name.endsWith('.tmp.mp4')) continue;
        const full = path.join(this.cacheDir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          totalBytes += st.size;
          entries.push({ full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
      if (entries.length <= MAX_MEDIA_CACHE_FILES && totalBytes <= MAX_MEDIA_CACHE_BYTES) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      while ((entries.length > MAX_MEDIA_CACHE_FILES || totalBytes > MAX_MEDIA_CACHE_BYTES) && entries.length) {
        const oldest = entries.shift();
        try {
          fs.unlinkSync(oldest.full);
          totalBytes -= oldest.size;
        } catch {}
      }
    } catch {}
  }

  #setProbeCache(cacheKey, val) {
    if (this.probeCache.has(cacheKey)) this.probeCache.delete(cacheKey);
    this.probeCache.set(cacheKey, val);
    if (this.probeCache.size > MAX_PROBE_CACHE) {
      const oldest = this.probeCache.keys().next().value;
      if (oldest) this.probeCache.delete(oldest);
    }
  }

  #runCommand(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('VideoService disposed'));
        return;
      }
      if (!bin) {
        reject(new Error('Media binary unavailable'));
        return;
      }
      const child = execFile(
        bin,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          this.activeProcs.delete(child);
          if (err) {
            reject(new Error(String(stderr || err.message || 'Process failed').slice(-320)));
          } else {
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
          }
        }
      );
      this.activeProcs.add(child);
    });
  }

  async probeMedia(rawPath) {
    const safe = resolveSafeReadPath(rawPath);
    if (!safe.ok) return { ok: false, error: safe.error };
    const { filePath, key, stat } = safe;
    const ext = path.extname(filePath).toLowerCase();
    const cacheKey = `${key}|${stat.mtimeMs}|${stat.size}`;
    if (this.probeCache.has(cacheKey)) {
      return this.probeCache.get(cacheKey);
    }

    let probe = null;
    if (this.ffprobeBin) {
      try {
        const { stdout } = await this.#runCommand(
          this.ffprobeBin,
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
          4500
        );
        const parsed = JSON.parse(stdout || '{}');
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const vStream =
          streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ||
          streams.find((s) => s.codec_type === 'video') ||
          null;
        const aStream = streams.find((s) => s.codec_type === 'audio') || null;
        const durationRaw = Number(parsed.format?.duration || vStream?.duration || aStream?.duration || 0);
        const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw * 100) / 100 : 0;
        const width = Number(vStream?.width || 0);
        const height = Number(vStream?.height || 0);
        const pixFmt = String(vStream?.pix_fmt || '').toLowerCase();
        const videoCodec = String(vStream?.codec_name || '').toLowerCase();
        const audioCodec = String(aStream?.codec_name || '').toLowerCase();
        const fps = parseFrameRate(vStream?.avg_frame_rate) || parseFrameRate(vStream?.r_frame_rate);
        const bitrate = Number(parsed.format?.bit_rate || 0);
        const hasAlpha = ALPHA_PIX_FMT_RE.test(pixFmt);

        probe = {
          duration,
          width,
          height,
          fps,
          videoCodec,
          audioCodec,
          pixFmt,
          hasAlpha,
          bitrate: Number.isFinite(bitrate) ? bitrate : 0,
          formatName: String(parsed.format?.format_name || ''),
        };
      } catch {
        probe = null;
      }
    }

    // Fallback when ffprobe binary is missing (e.g. single-binary ffmpeg install)
    if (!probe && this.ffmpegBin) {
      try {
        const stderrOut = await new Promise((resolve) => {
          const child = execFile(
            this.ffmpegBin,
            ['-hide_banner', '-i', filePath],
            { timeout: 4000, windowsHide: true, maxBuffer: 512 * 1024 },
            (_err, _stdout, stderr) => {
              this.activeProcs.delete(child);
              resolve(String(stderr || ''));
            }
          );
          this.activeProcs.add(child);
        });
        probe = parseFfmpegStderrProbe(stderrOut);
      } catch {
        probe = null;
      }
    }

    const parts = [];
    if (probe?.width && probe?.height) parts.push(`${probe.width}×${probe.height}`);
    if (probe?.duration) parts.push(formatDurationShort(probe.duration));
    if (probe?.fps) parts.push(`${probe.fps} fps`);
    if (probe?.videoCodec) parts.push(probe.videoCodec.toUpperCase());
    if (probe?.audioCodec) parts.push(probe.audioCodec.toUpperCase());
    parts.push(formatBytesShort(stat.size));

    const out = {
      ok: true,
      path: filePath,
      key,
      ext,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      probe,
      statsLabel: parts.filter(Boolean).join(' · '),
    };
    this.#setProbeCache(cacheKey, out);
    return out;
  }

  #getCachedMp4Path(hash, strategy, hasAlpha = false) {
    const suffix = strategy === 'remux' ? 'remux' : hasAlpha ? 'trans_a2' : 'trans';
    return path.join(this.cacheDir, `${hash}_${suffix}.mp4`);
  }

  #startPrepareJob(filePath, hash, decision, { hasAlpha = false } = {}) {
    this.#ensureCacheDir();
    const outPath = this.#getCachedMp4Path(hash, decision.strategy, hasAlpha);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 256) {
      return { ready: true, filePath: outPath };
    }

    const failKey = `${hash}:${decision.strategy}:${hasAlpha ? 'a' : 'o'}`;
    const failedRec = this.failedJobs.get(failKey);
    if (failedRec && Date.now() - failedRec.at < FAILED_JOB_TTL_MS) {
      return { ready: false, failed: true, error: failedRec.error };
    }

    if (this.inflightJobs.has(failKey)) {
      return { ready: false, preparing: true };
    }

    const tmpPath = path.join(this.cacheDir, `${hash}_${decision.strategy}_${process.pid}_${crypto.randomBytes(3).toString('hex')}.tmp.mp4`);
    const runTranscodeWithAlphaFallback = async () => {
      if (hasAlpha) {
        try {
          await this.#runCommand(this.ffmpegBin, buildTranscodeArgs(filePath, tmpPath, { hasAlpha: true, live: false }), 90000);
          return;
        } catch {
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        }
      }
      await this.#runCommand(this.ffmpegBin, buildTranscodeArgs(filePath, tmpPath, { hasAlpha: false, live: false }), 90000);
    };

    const job = (async () => {
      try {
        if (decision.strategy === 'remux') {
          const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            filePath,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-c:v',
            'copy',
            ...(decision.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            '-y',
            tmpPath,
          ];
          try {
            await this.#runCommand(this.ffmpegBin, args, 25000);
          } catch {
            // If stream-copy remux fails due to exotic codec tags inside .mov/.mkv, fall back to H.264 transcode
            await runTranscodeWithAlphaFallback();
          }
        } else {
          await runTranscodeWithAlphaFallback();
        }

        if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 256) {
          throw new Error('转码产物为空');
        }
        try {
          fs.renameSync(tmpPath, outPath);
        } catch {
          fs.copyFileSync(tmpPath, outPath);
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        this.failedJobs.delete(failKey);
        this.#pruneDiskCacheIfNeeded();
      } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        this.failedJobs.set(failKey, { at: Date.now(), error: String(err?.message || err) });
      } finally {
        this.inflightJobs.delete(failKey);
      }
    })();

    this.inflightJobs.set(failKey, job);
    return { ready: false, preparing: true };
  }

  async inspectVideoCompatibility(rawPath) {
    const probed = await this.probeMedia(rawPath);
    if (!probed.ok) return probed;
    const { path: filePath, ext, sizeBytes, probe, statsLabel } = probed;
    const hasFfmpeg = Boolean(this.ffmpegBin);
    const decision = decideVideoStrategy({ ext, sizeBytes, probe, hasFfmpeg });
    const vCodec = String(probe?.videoCodec || '').toLowerCase();
    const pixFmt = String(probe?.pixFmt || '').toLowerCase();
    const knownIncompatibleCodec = Boolean(
      vCodec && (!SAFE_MP4_VIDEO_CODECS.has(vCodec) || !SAFE_8BIT_PIX_FMTS.has(pixFmt))
    );
    const knownIncompatibleContainer = UNSUPPORTED_NATIVE_CONTAINERS.has(ext);
    const needsTranscode =
      decision.strategy === 'remux' ||
      decision.strategy === 'transcode_cached' ||
      decision.strategy === 'transcode_live' ||
      (decision.strategy === 'native_fallback' && (knownIncompatibleCodec || knownIncompatibleContainer));
    return {
      ok: true,
      path: filePath,
      ext: ext.slice(1),
      ffmpegAvailable: hasFfmpeg,
      strategy: decision.strategy,
      strategyReason: decision.reason,
      needsTranscode,
      hasAlpha: Boolean(probe?.hasAlpha),
      videoCodec: vCodec,
      audioCodec: String(probe?.audioCodec || '').toLowerCase(),
      pixFmt,
      statsLabel,
    };
  }

  async prepareVideo(rawPath, { mediaBaseUrl = '', posterDataUrl = '' } = {}) {
    const probed = await this.probeMedia(rawPath);
    if (!probed.ok) return probed;

    const { path: filePath, key, ext, sizeBytes, mtimeMs, probe, statsLabel } = probed;
    const hash = this.#makeCacheHash(key, { mtimeMs, size: sizeBytes });
    const hasFfmpeg = Boolean(this.ffmpegBin);
    const hasAlpha = Boolean(probe?.hasAlpha);
    const decision = decideVideoStrategy({ ext, sizeBytes, probe, hasFfmpeg });

    let ready = true;
    let preparing = false;
    let failedError = '';
    let playablePath = filePath;
    let streamMode = decision.strategy;

    if (decision.strategy === 'remux' || decision.strategy === 'transcode_cached') {
      const st = this.#startPrepareJob(filePath, hash, decision, { hasAlpha });
      if (st.ready) {
        playablePath = st.filePath;
        ready = true;
      } else if (st.failed) {
        ready = false;
        failedError = st.error || 'ffmpeg 转码失败';
      } else {
        ready = false;
        preparing = true;
      }
    }

    const qs = new URLSearchParams({
      token: this.mediaToken,
      path: filePath,
      mode: streamMode,
      hash,
      ...(hasAlpha ? { alpha: '1' } : {}),
    });
    const relStreamUrl = `/api/media/stream?${qs.toString()}`;
    const fullStreamUrl = mediaBaseUrl ? `${mediaBaseUrl.replace(/\/+$/, '')}${relStreamUrl}` : relStreamUrl;

    let playableSize = sizeBytes;
    if (ready && playablePath !== filePath) {
      try { playableSize = fs.statSync(playablePath).size; } catch {}
    }

    const canInlineBlob =
      ready &&
      streamMode !== 'transcode_live' &&
      playableSize > 0 &&
      playableSize <= MAX_INLINE_BLOB_BYTES;

    const warnings = [];
    if (decision.strategy === 'native_fallback') {
      warnings.push('本机未检测到 ffmpeg：若此视频编码不受内置播放器支持，可安装 ffmpeg 或点击右上角「打开」使用系统播放器查看。');
    } else if (decision.strategy === 'transcode_live') {
      warnings.push('视频时长较长且原编码需转码：当前采用实时流式转码播放，拖动进度条或点击时间点将重新定位。');
    } else if (hasAlpha) {
      warnings.push('检测到透明通道（Alpha）视频：侧边栏已叠加棋盘格透明底预览，原始透明通道不受影响。');
    }

    return {
      ok: true,
      format: 'video',
      formatLabel: `${ext.slice(1).toUpperCase()} 视频`,
      badge: ext.slice(1).toUpperCase(),
      path: filePath,
      title: path.basename(filePath),
      ext: ext.slice(1),
      sizeBytes,
      mtimeMs,
      autoRender: true,
      supportsPaperMode: false,
      ffmpegAvailable: hasFfmpeg,
      strategy: decision.strategy,
      strategyReason: decision.reason,
      ready,
      preparing,
      failedError,
      streamUrl: fullStreamUrl,
      relStreamUrl,
      canInlineBlob,
      posterDataUrl: posterDataUrl || '',
      videoMeta: {
        duration: probe?.duration || 0,
        durationText: formatDurationShort(probe?.duration || 0),
        width: probe?.width || 0,
        height: probe?.height || 0,
        fps: probe?.fps || 0,
        videoCodec: probe?.videoCodec || '',
        audioCodec: probe?.audioCodec || '',
        pixFmt: probe?.pixFmt || '',
        hasAlpha: Boolean(probe?.hasAlpha),
        sizeText: formatBytesShort(sizeBytes),
      },
      meta: {
        title: path.basename(filePath),
        statsLabel,
      },
      outline: [],
      bodyHtml: '',
      plainText: '',
      warnings,
    };
  }

  async readMediaBlob(rawPath, { mode = '' } = {}) {
    const probed = await this.probeMedia(rawPath);
    if (!probed.ok) return probed;
    const { path: filePath, key, ext, sizeBytes, mtimeMs, probe } = probed;
    const hash = this.#makeCacheHash(key, { mtimeMs, size: sizeBytes });
    const decision = decideVideoStrategy({ ext, sizeBytes, probe, hasFfmpeg: Boolean(this.ffmpegBin) });
    const effectiveMode = mode || decision.strategy;

    let targetFile = filePath;
    let mime = getMediaMimeForExt(ext);
    if (effectiveMode === 'remux' || effectiveMode === 'transcode_cached') {
      const cached = this.#getCachedMp4Path(hash, effectiveMode, Boolean(probe?.hasAlpha));
      if (fs.existsSync(cached) && fs.statSync(cached).size > 256) {
        targetFile = cached;
        mime = 'video/mp4';
      } else {
        return { ok: false, preparing: true, error: '视频仍在准备中' };
      }
    }

    const st = fs.statSync(targetFile);
    if (st.size > MAX_INLINE_BLOB_BYTES) {
      return { ok: false, tooLarge: true, error: `视频体积 ${formatBytesShort(st.size)} 超过内联回退上限` };
    }
    const buf = fs.readFileSync(targetFile);
    return {
      ok: true,
      mime,
      sizeBytes: st.size,
      base64: buf.toString('base64'),
    };
  }

  #sendFileRange(req, res, filePath, contentType, extraHeaders = null) {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not found');
      return;
    }

    const totalSize = st.size;
    const baseHeaders = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=120',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...(extraHeaders || {}),
    };

    const rangeHeader = req.headers?.range;
    const isHead = String(req.method || 'GET').toUpperCase() === 'HEAD';

    if (rangeHeader) {
      const parsed = parseHttpRangeHeader(rangeHeader, totalSize);
      if (!parsed || parsed.invalid) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${totalSize}`,
        'Content-Length': String(parsed.chunkSize),
      });
      if (isHead) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start: parsed.start, end: parsed.end });
      stream.on('error', () => {
        try { res.destroy(); } catch {}
      });
      res.on('close', () => {
        try { stream.destroy(); } catch {}
      });
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(totalSize),
    });
    if (isHead) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try { res.destroy(); } catch {}
    });
    res.on('close', () => {
      try { stream.destroy(); } catch {}
    });
    stream.pipe(res);
  }

  #streamLiveTranscode(req, res, filePath, startSec = 0, { hasAlpha = false } = {}) {
    if (!this.ffmpegBin) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ffmpeg unavailable');
      return;
    }
    const args = buildTranscodeArgs(filePath, 'pipe:1', { hasAlpha, live: true, startSec });

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });

    if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
      res.end();
      return;
    }

    const child = spawn(this.ffmpegBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.activeProcs.add(child);

    const cleanup = () => {
      this.activeProcs.delete(child);
      try {
        if (!child.killed) child.kill();
      } catch {}
    };

    child.stdout.pipe(res);
    child.on('exit', cleanup);
    child.on('error', () => {
      cleanup();
      try { res.end(); } catch {}
    });
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  handleMediaStreamHttp(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const token = url.searchParams.get('token') || '';
    if (!timingSafeTokenEquals(token, this.mediaToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid media token');
      return;
    }

    const rawPath = url.searchParams.get('path') || '';
    const safe = resolveSafeReadPath(rawPath);
    if (!safe.ok) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(safe.error || 'Not found');
      return;
    }

    const mode = url.searchParams.get('mode') || 'direct';
    const hasAlpha = url.searchParams.get('alpha') === '1';
    const hash = this.#makeCacheHash(safe.key, safe.stat);
    const ext = path.extname(safe.filePath).toLowerCase();

    if (mode === 'transcode_live') {
      const startSec = Number(url.searchParams.get('start') || 0);
      this.#streamLiveTranscode(req, res, safe.filePath, startSec, { hasAlpha });
      return;
    }

    if (mode === 'remux' || mode === 'transcode_cached') {
      const cached = this.#getCachedMp4Path(hash, mode, hasAlpha);
      const fallbackCached = hasAlpha ? this.#getCachedMp4Path(hash, mode, false) : '';
      const resolvedCached =
        fs.existsSync(cached) && fs.statSync(cached).size > 256
          ? cached
          : fallbackCached && fs.existsSync(fallbackCached) && fs.statSync(fallbackCached).size > 256
          ? fallbackCached
          : '';
      if (resolvedCached) {
        this.#sendFileRange(req, res, resolvedCached, 'video/mp4');
        return;
      }
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Media still preparing');
      return;
    }

    this.#sendFileRange(req, res, safe.filePath, getMediaMimeForExt(ext));
  }

  handleRawFileHttp(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const token = url.searchParams.get('token') || '';
    if (!this.verifyMediaToken(token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid media token');
      return true;
    }
    const rawPath = url.searchParams.get('path') || '';
    const safe = resolveSafeReadPath(rawPath);
    if (!safe.ok) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(safe.error || 'Not found');
      return true;
    }
    if (safe.stat.size > MAX_RAW_SERVE_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File too large for direct raw serve');
      return true;
    }
    const ext = path.extname(safe.filePath).toLowerCase();
    const extraHeaders = {
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (ext === '.svg' && String(req.headers?.['sec-fetch-dest'] || '').toLowerCase() === 'document') {
      extraHeaders['Content-Disposition'] = 'attachment';
    }
    this.#sendFileRange(req, res, safe.filePath, getMediaMimeForExt(ext), extraHeaders);
    return true;
  }
}
