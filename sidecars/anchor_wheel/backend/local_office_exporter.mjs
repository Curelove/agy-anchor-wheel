import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSafeReadPath } from './security.mjs';

const HIRES_SLIDE_LIMIT = 80;
const HIRES_CACHE_MAX_DECKS = 14;
const EXPORT_TIMEOUT_MS = 28000;

let activeExportJob = null;

function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || stdout || err.message).trim().slice(-320) || 'Export failed'));
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

export function detectLocalPresentationEngine() {
  // 1. Cross-platform LibreOffice (`soffice`) — 100% headless across Windows, macOS, Linux
  const sofficeCandidates = [];
  if (process.platform === 'win32') {
    sofficeCandidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    );
  } else if (process.platform === 'darwin') {
    sofficeCandidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(cmd, ['soffice'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    if (found) sofficeCandidates.unshift(found);
  } catch {}
  for (const c of sofficeCandidates) {
    if (c && fs.existsSync(c)) {
      return { available: true, kind: 'libreoffice', label: 'LibreOffice', binary: c };
    }
  }

  // 2. Windows Microsoft PowerPoint (`WithWindow = msoFalse` windowless COM — zero window, zero focus steal)
  if (process.platform === 'win32') {
    const pptPaths = [
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
      'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
    ];
    for (const p of pptPaths) {
      if (fs.existsSync(p)) {
        return { available: true, kind: 'powerpoint_com', label: 'PowerPoint', binary: p };
      }
    }

    // 3. Windows WPS Presentation (`WPP`) fallback
    const localApp = process.env.LOCALAPPDATA || '';
    if (localApp) {
      const wpsRoot = path.join(localApp, 'Kingsoft', 'WPS Office');
      try {
        if (fs.existsSync(wpsRoot)) {
          for (const d of fs.readdirSync(wpsRoot, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const wpp = path.join(wpsRoot, d.name, 'office6', 'wpp.exe');
            if (fs.existsSync(wpp)) {
              return { available: true, kind: 'wps_com', label: 'WPS 演示', binary: wpp };
            }
          }
        }
      } catch {}
    }
  }

  return { available: false, kind: 'none', label: '' };
}

function pruneOldDeckCaches(hiresRoot) {
  try {
    if (!fs.existsSync(hiresRoot)) return;
    const dirs = [];
    for (const d of fs.readdirSync(hiresRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = path.join(hiresRoot, d.name);
      try {
        const st = fs.statSync(full);
        dirs.push({ full, mtimeMs: st.mtimeMs });
      } catch {}
    }
    if (dirs.length <= HIRES_CACHE_MAX_DECKS) return;
    dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (dirs.length > HIRES_CACHE_MAX_DECKS) {
      const oldest = dirs.shift();
      try { fs.rmSync(oldest.full, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function readCachedSlides(deckDir) {
  if (!fs.existsSync(deckDir)) return null;
  const collator = new Intl.Collator(undefined, { numeric: true });
  const files = fs
    .readdirSync(deckDir)
    .filter((f) => /^slide_\d+\.png$/i.test(f))
    .sort((a, b) => collator.compare(a, b));
  if (!files.length) return null;
  return files.map((fname, idx) => {
    const buf = fs.readFileSync(path.join(deckDir, fname));
    return {
      index: idx + 1,
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    };
  });
}

async function exportViaPowerPointOrWpsCom(filePath, outDir, useWps = false) {
  // Strictly windowless (`WithWindow = 0`), zero focus steal, and preserves any pre-existing user session
  const progIds = useWps ? "@('KWPP.Application','WPP.Application','PowerPoint.Application')" : "@('PowerPoint.Application','KWPP.Application')";
  const psScript = `
$ErrorActionPreference = 'Stop'
$srcPath = $env:AW_PPT_SRC
$outDir = $env:AW_PPT_OUT
$maxSlides = [int]$env:AW_PPT_MAX
$wasPptRunning = @(Get-Process -Name 'POWERPNT','wpp' -ErrorAction SilentlyContinue).Count -gt 0
$app = $null
$pres = $null
try {
  foreach ($pidName in ${progIds}) {
    try { $app = New-Object -ComObject $pidName; if ($app) { break } } catch {}
  }
  if (-not $app) { throw '未找到可用的本机演示组件接口' }
  try { $app.DisplayAlerts = 1 } catch {}
  # Open(FileName, ReadOnly=-1, Untitled=0, WithWindow=0) -> 100% hidden windowless open!
  $pres = $app.Presentations.Open($srcPath, -1, 0, 0)
  $count = [Math]::Min([int]$pres.Slides.Count, $maxSlides)
  $w = 1440
  $h = [Math]::Max(540, [int][Math]::Round(1440 * ($pres.PageSetup.SlideHeight / [Math]::Max(1, $pres.PageSetup.SlideWidth))))
  for ($i = 1; $i -le $count; $i++) {
    $dest = Join-Path $outDir ('slide_{0:D3}.png' -f $i)
    $pres.Slides.Item($i).Export($dest, 'PNG', $w, $h)
  }
} finally {
  if ($pres) {
    try { $pres.Saved = -1 } catch {}
    try { $pres.Close() } catch {}
  }
  if ($app -and -not $wasPptRunning) {
    try { $app.Quit() } catch {}
  }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`;
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    {
      timeout: EXPORT_TIMEOUT_MS,
      env: {
        ...process.env,
        AW_PPT_SRC: filePath,
        AW_PPT_OUT: outDir,
        AW_PPT_MAX: String(HIRES_SLIDE_LIMIT),
      },
    }
  );
}

async function exportViaLibreOffice(sofficeBin, filePath, outDir, ffmpegBin = '') {
  // Isolated temporary LibreOffice profile per Rule 0.5 sandbox isolation
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-soffice-'));
  const profileUri = 'file:///' + path.join(tmpWork, 'profile').replace(/\\/g, '/');
  try {
    // Convert to PDF headlessly first, or single-slide PNG if pdftoppm/ffmpeg unavailable
    await execFileAsync(
      sofficeBin,
      [
        `-env:UserInstallation=${profileUri}`,
        '--headless',
        '--invisible',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        tmpWork,
        filePath,
      ],
      { timeout: EXPORT_TIMEOUT_MS }
    );
    const pdfFile = fs.readdirSync(tmpWork).find((f) => f.toLowerCase().endsWith('.pdf'));
    if (!pdfFile) throw new Error('LibreOffice 未产出 PDF 文件');
    const pdfFull = path.join(tmpWork, pdfFile);
    const pdfBuf = fs.readFileSync(pdfFull);
    fs.writeFileSync(path.join(outDir, 'deck.pdf'), pdfBuf);
  } finally {
    try { fs.rmSync(tmpWork, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {}
  }
}

/**
 * Exports 1:1 high-resolution slide images or PDF using a local windowless engine
 * (`PowerPoint COM` / `WPS` / `LibreOffice`), strictly cached by file content metadata.
 */
export async function renderSlidesWithLocalEngine(rawPath, { dataDir, dryRun = false } = {}) {
  const safe = resolveSafeReadPath(rawPath);
  if (!safe.ok) return { ok: false, error: safe.error };
  const ext = path.extname(safe.filePath).toLowerCase();
  if (!['.pptx', '.ppsx', '.potx', '.ppt', '.odp'].includes(ext)) {
    return { ok: false, error: `本机演示引擎不支持该扩展名：${ext}` };
  }

  const engine = detectLocalPresentationEngine();
  if (!engine.available) {
    return {
      ok: false,
      unavailable: true,
      error: '未检测到本机安装的 PowerPoint、WPS 演示或 LibreOffice，已保持零依赖矢量画布模式。',
    };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, engine: engine.label, kind: engine.kind, path: safe.filePath };
  }

  const hiresRoot = path.join(String(dataDir || os.tmpdir()), 'preview_cache', 'slides_hires');
  const hash = crypto
    .createHash('sha1')
    .update(`${safe.key}|${safe.stat.mtimeMs}|${safe.stat.size}|v1`)
    .digest('hex')
    .slice(0, 20);
  const deckDir = path.join(hiresRoot, hash);

  const cachedSlides = readCachedSlides(deckDir);
  if (cachedSlides) {
    return { ok: true, cached: true, engine: engine.label, mode: 'slides', slides: cachedSlides };
  }
  const cachedPdf = path.join(deckDir, 'deck.pdf');
  if (fs.existsSync(cachedPdf)) {
    const b64 = fs.readFileSync(cachedPdf).toString('base64');
    return { ok: true, cached: true, engine: engine.label, mode: 'pdf', pdfBase64: b64 };
  }

  // Single-flight guard so concurrent clicks never spawn duplicate background Office instances
  if (activeExportJob) {
    try { await activeExportJob; } catch {}
    const afterWait = readCachedSlides(deckDir);
    if (afterWait) return { ok: true, cached: true, engine: engine.label, mode: 'slides', slides: afterWait };
  }

  const runJob = (async () => {
    fs.mkdirSync(deckDir, { recursive: true });
    try {
      if (engine.kind === 'libreoffice') {
        await exportViaLibreOffice(engine.binary, safe.filePath, deckDir);
      } else {
        await exportViaPowerPointOrWpsCom(safe.filePath, deckDir, engine.kind === 'wps_com');
      }
      pruneOldDeckCaches(hiresRoot);
    } catch (err) {
      try { fs.rmSync(deckDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
  })();

  activeExportJob = runJob;
  try {
    await runJob;
  } catch (err) {
    return { ok: false, engine: engine.label, error: `本机引擎精绘失败：${err?.message || err}` };
  } finally {
    if (activeExportJob === runJob) activeExportJob = null;
  }

  const freshSlides = readCachedSlides(deckDir);
  if (freshSlides) {
    return { ok: true, cached: false, engine: engine.label, mode: 'slides', slides: freshSlides };
  }
  if (fs.existsSync(cachedPdf)) {
    const b64 = fs.readFileSync(cachedPdf).toString('base64');
    return { ok: true, cached: false, engine: engine.label, mode: 'pdf', pdfBase64: b64 };
  }
  return { ok: false, engine: engine.label, error: '本机引擎未生成任何幻灯片画面' };
}
