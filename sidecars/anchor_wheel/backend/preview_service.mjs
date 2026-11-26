import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSupportedDocumentMeta, renderDocument } from './document_renderer.mjs';
import { decodeBuffer } from './encoding.mjs';
import { isSensitiveFilePath, resolveSafeDirPath, resolveSafeReadPath } from './security.mjs';

const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
});

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
const MAX_INLINE_IMAGE_BYTES = 380 * 1024;
const MAX_TEXT_READ_BYTES = 8192;
const MAX_DISK_CACHE_FILES = 150;
const MAX_DISK_CACHE_BYTES = 35 * 1024 * 1024;
const MAX_MEM_ITEMS = 120;
const MAX_FFMPEG_CONCURRENCY = 2;
const MAX_PENDING_CLIPS = 6;
const FAILED_MEDIA_TTL_MS = 60 * 1000;

export function detectFfmpegBinary() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    const first = String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    if (first) return first;
  } catch {}
  if (process.platform === 'win32') {
    const candidates = ['C:\\ffmpeg\\bin\\ffmpeg.exe'];
    try {
      if (fs.existsSync('C:\\ffmpeg')) {
        for (const sub of fs.readdirSync('C:\\ffmpeg', { withFileTypes: true })) {
          if (sub.isDirectory()) candidates.push(path.join('C:\\ffmpeg', sub.name, 'bin', 'ffmpeg.exe'));
        }
      }
    } catch {}
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return '';
}

function runFfmpeg(ffmpegBin, args, timeoutMs = 5500, activeProcs = null) {
  return new Promise((resolve, reject) => {
    if (!ffmpegBin) {
      reject(new Error('ffmpeg unavailable'));
      return;
    }
    const child = execFile(
      ffmpegBin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        activeProcs?.delete(child);
        if (err) {
          reject(new Error(stderr?.toString()?.slice(-240) || err.message));
        } else {
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
      }
    );
    activeProcs?.add(child);
  });
}

function toDataUrl(filePath, mime) {
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export class PreviewService {
  constructor(dataDir, options = {}) {
    this.cacheDir = path.join(String(dataDir || process.cwd()), 'preview_cache');
    this.ffmpegBin = options.ffmpegBin !== undefined ? options.ffmpegBin : detectFfmpegBinary();
    this.memCache = new Map();
    this.inflightClips = new Map();
    this.inflightHigh = new Map();
    this.highPriorityQueue = [];
    this.lowPriorityQueue = [];
    this.activeJobs = 0;
    this.activeProcs = new Set();
    this.failedCache = new Map(); // key -> timestamp
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    for (const task of [...this.highPriorityQueue, ...this.lowPriorityQueue]) {
      try { task.reject(new Error('PreviewService disposed')); } catch {}
    }
    this.highPriorityQueue = [];
    this.lowPriorityQueue = [];
    for (const child of this.activeProcs) {
      try { child.kill(); } catch {}
    }
    this.activeProcs.clear();
  }

  #isRecentlyFailed(failKey) {
    const at = this.failedCache.get(failKey);
    if (!at) return false;
    if (Date.now() - at < FAILED_MEDIA_TTL_MS) return true;
    this.failedCache.delete(failKey);
    return false;
  }

  #markFailed(failKey) {
    this.failedCache.set(failKey, Date.now());
    if (this.failedCache.size > 200) {
      const oldest = this.failedCache.keys().next().value;
      if (oldest) this.failedCache.delete(oldest);
    }
  }

  #ensureCacheDir() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch {}
  }

  #pruneDiskCacheIfNeeded() {
    try {
      if (!fs.existsSync(this.cacheDir)) return;
      const entries = [];
      let totalBytes = 0;
      for (const name of fs.readdirSync(this.cacheDir)) {
        const full = path.join(this.cacheDir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          totalBytes += st.size;
          entries.push({ full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
      if (entries.length <= MAX_DISK_CACHE_FILES && totalBytes <= MAX_DISK_CACHE_BYTES) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      while ((entries.length > MAX_DISK_CACHE_FILES || totalBytes > MAX_DISK_CACHE_BYTES) && entries.length) {
        const oldest = entries.shift();
        try {
          fs.unlinkSync(oldest.full);
          totalBytes -= oldest.size;
        } catch {}
      }
    } catch {}
  }

  #getMem(key) {
    if (!this.memCache.has(key)) return null;
    const val = this.memCache.get(key);
    this.memCache.delete(key);
    this.memCache.set(key, val);
    return val;
  }

  #setMem(key, val) {
    if (this.memCache.has(key)) this.memCache.delete(key);
    this.memCache.set(key, val);
    if (this.memCache.size > MAX_MEM_ITEMS) {
      const oldestKey = this.memCache.keys().next().value;
      if (oldestKey) this.memCache.delete(oldestKey);
    }
  }

  #enqueueFfmpegJob(fn, { priority = 'low' } = {}) {
    if (this.disposed) return Promise.reject(new Error('PreviewService disposed'));
    return new Promise((resolve, reject) => {
      const task = { fn, resolve, reject };
      if (priority === 'high') {
        this.highPriorityQueue.push(task);
      } else {
        // Drop oldest stale queued background clip if user rapidly glides over many videos
        while (this.lowPriorityQueue.length >= MAX_PENDING_CLIPS) {
          const dropped = this.lowPriorityQueue.shift();
          try { dropped?.resolve?.(null); } catch {}
        }
        this.lowPriorityQueue.push(task);
      }
      this.#drainQueue();
    });
  }

  #drainQueue() {
    if (this.disposed) return;
    while (this.activeJobs < MAX_FFMPEG_CONCURRENCY) {
      const task = this.highPriorityQueue.shift() || this.lowPriorityQueue.shift();
      if (!task) break;
      this.activeJobs++;
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.activeJobs--;
          this.#drainQueue();
        });
    }
  }

  #makeCacheHash(fileKey, stat) {
    return crypto
      .createHash('sha1')
      .update(`${fileKey}|${stat.mtimeMs}|${stat.size}`)
      .digest('hex')
      .slice(0, 20);
  }

  async #buildImageThumb(filePath, hash) {
    this.#ensureCacheDir();
    const outPath = path.join(this.cacheDir, `${hash}_thumb.jpg`);
    if (fs.existsSync(outPath)) {
      return toDataUrl(outPath, 'image/jpeg');
    }
    const failKey = `thumb:${hash}`;
    if (this.#isRecentlyFailed(failKey)) return '';
    const inflightKey = `thumb:${hash}`;
    if (this.inflightHigh.has(inflightKey)) {
      return this.inflightHigh.get(inflightKey);
    }
    const job = this.#enqueueFfmpegJob(
      async () => {
        try {
          await runFfmpeg(
            this.ffmpegBin,
            ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '6', '-y', outPath],
            4000,
            this.activeProcs
          );
          this.#pruneDiskCacheIfNeeded();
          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
            return toDataUrl(outPath, 'image/jpeg');
          }
          this.#markFailed(failKey);
          return '';
        } catch {
          this.#markFailed(failKey);
          return '';
        }
      },
      { priority: 'high' }
    ).finally(() => {
      this.inflightHigh.delete(inflightKey);
    });
    this.inflightHigh.set(inflightKey, job);
    return job;
  }

  async #ensurePosterFrame(filePath, hash) {
    this.#ensureCacheDir();
    const outPath = path.join(this.cacheDir, `${hash}_poster.jpg`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
      return toDataUrl(outPath, 'image/jpeg');
    }
    const failKey = `poster:${hash}`;
    if (this.#isRecentlyFailed(failKey)) return '';
    const inflightKey = `poster:${hash}`;
    if (this.inflightHigh.has(inflightKey)) {
      return this.inflightHigh.get(inflightKey);
    }

    const job = this.#enqueueFfmpegJob(
      async () => {
        // Fast input-seek past common black intro frames, then pick representative bright frame via thumbnail=8
        for (const ss of ['1.2', '0']) {
          try {
            await runFfmpeg(
              this.ffmpegBin,
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-ss',
                ss,
                '-i',
                filePath,
                '-vf',
                'thumbnail=8,scale=320:-2',
                '-frames:v',
                '1',
                '-q:v',
                '6',
                '-y',
                outPath,
              ],
              3200,
              this.activeProcs
            );
            if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
              this.#pruneDiskCacheIfNeeded();
              return toDataUrl(outPath, 'image/jpeg');
            }
          } catch {}
        }
        this.#markFailed(failKey);
        return '';
      },
      { priority: 'high' }
    ).finally(() => {
      this.inflightHigh.delete(inflightKey);
    });
    this.inflightHigh.set(inflightKey, job);
    return job;
  }

  #triggerClipGeneration(filePath, hash) {
    this.#ensureCacheDir();
    const clipPath = path.join(this.cacheDir, `${hash}_clip.webp`);
    if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 300) {
      return clipPath;
    }
    const failKey = `clip:${hash}`;
    if (this.#isRecentlyFailed(failKey)) return 'failed';
    if (this.inflightClips.has(hash)) return null;

    const jobPromise = this.#enqueueFfmpegJob(
      async () => {
        try {
          await runFfmpeg(
            this.ffmpegBin,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-ss',
              '1.0',
              '-t',
              '3.0',
              '-i',
              filePath,
              '-vf',
              'fps=6,scale=300:-2:flags=lanczos',
              '-c:v',
              'libwebp_anim',
              '-loop',
              '0',
              '-q:v',
              '45',
              '-compression_level',
              '3',
              '-an',
              '-f',
              'webp',
              '-y',
              clipPath,
            ],
            6500,
            this.activeProcs
          );
          if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size <= 300) {
            // Retry from 0s for very short (<1s) clips
            await runFfmpeg(
              this.ffmpegBin,
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-t',
                '3.0',
                '-i',
                filePath,
                '-vf',
                'fps=6,scale=300:-2:flags=lanczos',
                '-c:v',
                'libwebp_anim',
                '-loop',
                '0',
                '-q:v',
                '45',
                '-compression_level',
                '3',
                '-an',
                '-f',
                'webp',
                '-y',
                clipPath,
              ],
              6500,
              this.activeProcs
            );
          }
          if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size <= 300) {
            this.#markFailed(failKey);
          } else {
            this.#pruneDiskCacheIfNeeded();
          }
        } catch {
          this.#markFailed(failKey);
          try {
            if (fs.existsSync(clipPath) && fs.statSync(clipPath).size < 200) fs.unlinkSync(clipPath);
          } catch {}
        } finally {
          this.inflightClips.delete(hash);
        }
      },
      { priority: 'low' }
    );
    this.inflightClips.set(hash, jobPromise);
    return null;
  }

  async getPreview(rawPath, { animated = true } = {}) {
    if (!rawPath) return { ok: false, error: 'Empty path' };

    // Try file first; fallback to directory if target is a folder
    let safeFile = resolveSafeReadPath(rawPath);
    if (!safeFile.ok) {
      const safeDir = resolveSafeDirPath(rawPath);
      if (safeDir.ok) {
        try {
          const dirents = fs.readdirSync(safeDir.dirPath, { withFileTypes: true });
          const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
          const files = [];
          let subdirCount = 0;
          for (const d of dirents) {
            if (!d.name || d.name.startsWith('.') || /^(?:desktop\.ini|thumbs\.db|~\$.*)$/i.test(d.name)) continue;
            const full = path.join(safeDir.dirPath, d.name);
            if (d.isDirectory()) {
              subdirCount++;
              continue;
            }
            if (isSensitiveFilePath(full)) continue;
            if (d.isFile()) files.push({ name: d.name, isDirectory: false });
          }
          files.sort((a, b) => collator.compare(a.name, b.name));
          return {
            ok: true,
            kind: 'directory',
            path: safeDir.dirPath,
            title: path.basename(safeDir.dirPath) || safeDir.dirPath,
            itemCount: files.length,
            subdirCount,
            entries: files.slice(0, 14),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      }
      return safeFile;
    }

    const { filePath, key, stat } = safeFile;
    const ext = path.extname(filePath).toLowerCase();
    const hash = this.#makeCacheHash(key, stat);
    const memKey = `${hash}|${animated ? '1' : '0'}`;
    const memHit = this.#getMem(memKey);
    if (memHit) return memHit;

    // 1. Images
    if (IMAGE_MIME[ext]) {
      let dataUrl = '';
      if (stat.size <= MAX_INLINE_IMAGE_BYTES) {
        dataUrl = toDataUrl(filePath, IMAGE_MIME[ext]);
      } else if (this.ffmpegBin && ext !== '.svg') {
        try {
          dataUrl = await this.#buildImageThumb(filePath, hash);
        } catch {}
      }
      const res = {
        ok: true,
        kind: 'image',
        path: filePath,
        title: path.basename(filePath),
        ext: ext.slice(1),
        sizeBytes: stat.size,
        dataUrl,
        tooLargeWithoutFfmpeg: !dataUrl,
      };
      if (dataUrl) this.#setMem(memKey, res);
      return res;
    }

    // 2. Videos (poster frame avoiding black intro + async 3s compressed animated WebP)
    if (VIDEO_EXTS.has(ext)) {
      if (!this.ffmpegBin) {
        return {
          ok: true,
          kind: 'video',
          path: filePath,
          title: path.basename(filePath),
          ext: ext.slice(1),
          sizeBytes: stat.size,
          noFfmpeg: true,
          posterDataUrl: '',
          animDataUrl: '',
          animPending: false,
        };
      }

      const clipPath = path.join(this.cacheDir, `${hash}_clip.webp`);
      const hasClip = animated && fs.existsSync(clipPath) && fs.statSync(clipPath).size > 300;
      const animDataUrl = hasClip ? toDataUrl(clipPath, 'image/webp') : '';
      const posterDataUrl = animDataUrl ? '' : await this.#ensurePosterFrame(filePath, hash);
      let animPending = false;
      if (animated && !animDataUrl) {
        const trig = this.#triggerClipGeneration(filePath, hash);
        animPending = trig !== 'failed';
      }

      const res = {
        ok: true,
        kind: 'video',
        path: filePath,
        title: path.basename(filePath),
        ext: ext.slice(1),
        sizeBytes: stat.size,
        posterDataUrl,
        animDataUrl,
        animPending,
      };
      if (!animPending) this.#setMem(memKey, res);
      return res;
    }

    // 3. Audio metadata (no auto playback blast)
    if (AUDIO_EXTS.has(ext)) {
      const res = {
        ok: true,
        kind: 'audio',
        path: filePath,
        title: path.basename(filePath),
        ext: ext.slice(1),
        sizeBytes: stat.size,
      };
      this.#setMem(memKey, res);
      return res;
    }

    // 3.5 Rich Office / E-Book / Table / Archive / PDF quick snippet preview
    const richDocMeta = getSupportedDocumentMeta(filePath);
    if (richDocMeta) {
      const parsed = renderDocument(filePath, { snippetOnly: true });
      if (parsed && parsed.ok) {
        const lines = Array.isArray(parsed.snippetLines) ? parsed.snippetLines.slice(0, 14) : [];
        const snippetText = lines.join('\n').trimEnd();
        const res = {
          ok: true,
          kind: 'document',
          format: parsed.format,
          formatLabel: parsed.formatLabel,
          badge: parsed.badge,
          statsLabel: parsed.meta?.statsLabel || '',
          path: filePath,
          title: path.basename(filePath),
          ext: ext.slice(1),
          sizeBytes: stat.size,
          lines,
          snippetText,
          truncated: true,
        };
        this.#setMem(memKey, res);
        return res;
      }
    }

    // 4. Text / Markdown / Code: strictly read only first 8192 bytes!
    let sliceBuf = Buffer.alloc(0);
    let fd = null;
    try {
      const readLen = Math.min(stat.size, MAX_TEXT_READ_BYTES);
      if (readLen > 0) {
        sliceBuf = Buffer.allocUnsafe(readLen);
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, sliceBuf, 0, readLen, 0);
        if (bytesRead < readLen) sliceBuf = sliceBuf.subarray(0, bytesRead);
      }
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    const decoded = decodeBuffer(sliceBuf, '', { truncated: stat.size > MAX_TEXT_READ_BYTES });
    if (decoded.isBinary) {
      const res = {
        ok: true,
        kind: 'binary',
        path: filePath,
        title: path.basename(filePath),
        ext: ext.slice(1),
        sizeBytes: stat.size,
      };
      this.#setMem(memKey, res);
      return res;
    }

    const allLines = String(decoded.text || '').split(/\r?\n/);
    const lines = allLines.slice(0, 18);
    const snippetText = lines.join('\n').trimEnd();
    const res = {
      ok: true,
      kind: 'text',
      path: filePath,
      title: path.basename(filePath),
      ext: ext.slice(1),
      isMarkdown: ext === '.md' || ext === '.mdx',
      encoding: decoded.encoding,
      sizeBytes: stat.size,
      lines,
      snippetText,
      truncated: stat.size > MAX_TEXT_READ_BYTES || allLines.length > 18,
    };
    this.#setMem(memKey, res);
    return res;
  }
}
