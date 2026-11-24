import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertFileToUtf8, inspectFileEncoding } from './encoding.mjs';
import { buildNavContext } from './nav_context.mjs';
import { PreviewService } from './preview_service.mjs';
import { resolveSafeReadPath } from './security.mjs';
import { UpdateService } from './update_service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.resolve(SIDECAR_ROOT, '..', '..');

const RAW_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
});

const MAX_RAW_SERVE_BYTES = 64 * 1024 * 1024;

function readAsset(relPath) {
  return fs.readFileSync(path.join(SIDECAR_ROOT, relPath));
}

function readPluginAsset(relPath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relPath));
}

const STANDALONE_PRELOAD_STUB = `
(function(){
  if (window.sidecar) return;
  const qs = new URLSearchParams(window.location.search);
  window.sidecar = {
    conversationId: qs.get('conversationId') || 'standalone',
    fetch: (url, opts = {}) => fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    }),
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    ui: {
      toggleAuxPane: () => {},
      toggleConversation: () => {},
      addArtifactComment: () => {}
    }
  };
})();
`;

export function createRouterHandlers({
  stateStore,
  backlinkIndex,
  previewService,
  updateService,
  getCdpStatus,
  pushNativeSync,
  ResponseCtor,
  isStandalone = false,
}) {
  const effectivePreviewService = previewService || new PreviewService(stateStore.dataDir);
  const effectiveUpdateService = updateService || new UpdateService({ dataDir: stateStore.dataDir, pluginRoot: PLUGIN_ROOT });
  const makeResp = (body, contentType = 'text/plain; charset=utf-8', status = 200, headers = {}) => {
    if (ResponseCtor) {
      return new ResponseCtor(body, { contentType, status, headers });
    }
    return { body, contentType, status, headers };
  };

  const staticPages = [
    ['/', 'frontend/index.html', 'text/html; charset=utf-8'],
    ['/styles.css', 'frontend/styles.css', 'text/css; charset=utf-8'],
    ['/app.js', 'frontend/app.js', 'application/javascript; charset=utf-8'],
    ['/wheel.css', 'shared/wheel_styles.css', 'text/css; charset=utf-8'],
    ['/nav_shared.js', 'shared/nav_shared.js', 'application/javascript; charset=utf-8'],
    ['/wheel.js', 'shared/radial_wheel.js', 'application/javascript; charset=utf-8'],
    ['/bilateral_wheel.js', 'shared/bilateral_wheel.js', 'application/javascript; charset=utf-8'],
    ['/ae_tree.js', 'shared/ae_tree.js', 'application/javascript; charset=utf-8'],
    ['/settings_modal.js', 'shared/settings_modal.js', 'application/javascript; charset=utf-8'],
    ['/markdown.js', 'shared/markdown_render.js', 'application/javascript; charset=utf-8'],
  ];

  const routes = new Map();

  for (const [route, file, mime] of staticPages) {
    routes.set(`GET ${route}`, () => {
      try {
        const buf = readAsset(file);
        return makeResp(buf.toString('utf8'), mime, 200);
      } catch (err) {
        return makeResp(`Asset not found: ${file}`, 'text/plain; charset=utf-8', 404);
      }
    });
  }

  routes.set('GET /logo.svg', () => {
    try {
      return makeResp(readPluginAsset('assets/logo.svg').toString('utf8'), 'image/svg+xml; charset=utf-8', 200);
    } catch {
      return makeResp('Not found', 'text/plain', 404);
    }
  });

  if (isStandalone) {
    routes.set('GET /preload.js', () => makeResp(STANDALONE_PRELOAD_STUB, 'application/javascript; charset=utf-8', 200));
  }

  routes.set('GET /api/status', () => {
    const meta = effectiveUpdateService.getPluginMeta();
    return {
      ok: true,
      version: meta.version,
      standalone: isStandalone,
      cdp: typeof getCdpStatus === 'function' ? getCdpStatus() : { connected: false, reason: 'disabled' },
      index: backlinkIndex.getStats(),
      settings: stateStore.getSettings(),
      compatibility: { ...meta.compatibility, localAntigravity: meta.localAntigravity },
      repoUrl: meta.repoUrl,
      releasesUrl: meta.releasesUrl,
      update: effectiveUpdateService.getCachedResult(),
    };
  });

  routes.set('GET /api/update/check', (data) =>
    effectiveUpdateService.checkForUpdates({
      force: data?.force === '1' || data?.force === 'true' || Boolean(data?.force),
    })
  );

  routes.set('POST /api/update/check', (data) =>
    effectiveUpdateService.checkForUpdates({ force: Boolean(data?.force) })
  );

  routes.set('GET /api/settings', () => ({ ok: true, settings: stateStore.getSettings() }));

  routes.set('POST /api/settings', (data) => {
    const next = stateStore.updateSettings(data?.settings || data);
    const cfgChanged = backlinkIndex.updateConfig({
      extraScanDirs: next.extraScanDirs,
      scanWorkspace: next.scanWorkspace,
      scanArtifacts: next.scanArtifacts,
    });
    if (cfgChanged) {
      backlinkIndex.scheduleBackgroundRescan({ force: false });
    }
    if (typeof pushNativeSync === 'function') {
      try { pushNativeSync({ settings: next }); } catch {}
    }
    return { ok: true, settings: next };
  });

  routes.set('GET /api/session', (data) => {
    const cid = data?.conversationId || 'default';
    return { ok: true, session: stateStore.getSession(cid) };
  });

  routes.set('POST /api/session', (data) => {
    const cid = data?.conversationId || 'default';
    const op = String(data?.op || '');
    let result = { session: stateStore.getSession(cid), evicted: [] };

    switch (op) {
      case 'pinAnchor':
        result = { session: stateStore.pinAnchor(cid, data) };
        break;
      case 'unpinGroup':
        result = { session: stateStore.unpinGroup(cid, data.groupId) };
        break;
      case 'adoptChild':
        result = stateStore.adoptChild(cid, data);
        break;
      case 'touchChild':
        result = { session: stateStore.touchChild(cid, data) };
        break;
      case 'toggleLock':
        result = { session: stateStore.toggleChildLock(cid, data) };
        break;
      case 'removeChild':
        result = { session: stateStore.removeChild(cid, data) };
        break;
      case 'restoreEvicted':
        result = stateStore.restoreEvicted(cid, data);
        break;
      case 'setGroupLimit':
        result = stateStore.setGroupLimit(cid, data);
        break;
      case 'history':
        result = stateStore.navigateHistory(cid, data);
        break;
      case 'recordLineage':
        result = { session: stateStore.recordLineage(cid, data) };
        break;
      default:
        return { ok: false, error: `Unknown session op: ${op}` };
    }

    if (typeof pushNativeSync === 'function') {
      try { pushNativeSync({ conversationId: cid, session: result.session }); } catch {}
    }
    return { ok: true, ...result };
  });

  routes.set('POST /api/nav-context', (data) => {
    let changed = false;
    if (Array.isArray(data?.workspaceRoots) && data.workspaceRoots.length) {
      changed = backlinkIndex.updateConfig({ workspaceRoots: data.workspaceRoots });
    }
    if (changed || backlinkIndex.lastScanMs === 0) {
      backlinkIndex.rescan({ force: false });
    } else {
      backlinkIndex.scheduleBackgroundRescan();
    }
    const ctx = buildNavContext({
      stateStore,
      backlinkIndex,
      conversationId: data?.conversationId || 'default',
      activePath: data?.path || data?.activePath || '',
      openTabs: Array.isArray(data?.openTabs) ? data.openTabs : [],
      scopeOverride: data?.scope || '',
    });
    return { ok: true, ...ctx };
  });

  routes.set('POST /api/preview', async (data) => {
    const animated =
      typeof data?.animated === 'boolean' ? data.animated : stateStore.getSettings().videoPreviewAnimated !== false;
    return effectivePreviewService.getPreview(data?.path || '', { animated });
  });

  routes.set('GET /api/backlinks', (data) => {
    let changed = false;
    if (data?.workspace) {
      const incoming = String(data.workspace).split('|').filter(Boolean);
      if (incoming.length) {
        changed = backlinkIndex.updateConfig({ workspaceRoots: incoming });
      }
    }
    if (changed || backlinkIndex.lastScanMs === 0) {
      backlinkIndex.rescan({ force: false });
    } else {
      backlinkIndex.scheduleBackgroundRescan();
    }
    const targetPath = String(data?.path || '').trim();
    return { ok: true, ...backlinkIndex.getLinksForFile(targetPath) };
  });

  routes.set('POST /api/index/rescan', (data) => {
    if (Array.isArray(data?.workspaceRoots) && data.workspaceRoots.length) {
      backlinkIndex.updateConfig({ workspaceRoots: data.workspaceRoots });
    }
    const stats = backlinkIndex.rescan({ force: Boolean(data?.force) });
    return { ok: true, stats };
  });

  routes.set('GET /api/files/tree', (data) => {
    if (data?.root) {
      backlinkIndex.updateConfig({ workspaceRoots: String(data.root).split('|').filter(Boolean) });
    }
    if (backlinkIndex.lastScanMs === 0) {
      backlinkIndex.rescan({ force: false });
    }
    const files = backlinkIndex.listFiles({
      filter: data?.filter || 'all',
      query: data?.q || '',
      limit: data?.limit || 140,
    });
    return { ok: true, files, stats: backlinkIndex.getStats() };
  });

  routes.set('POST /api/file/inspect', (data) => {
    return inspectFileEncoding(data?.path, {
      overrideEncoding: data?.encoding || '',
      maxBytes: 256 * 1024,
    });
  });

  routes.set('POST /api/file/read', (data) => {
    return inspectFileEncoding(data?.path, {
      overrideEncoding: data?.encoding || '',
      maxBytes: 4 * 1024 * 1024,
    });
  });

  routes.set('POST /api/file/convert-utf8', (data) => {
    if (!data?.confirm) {
      return { ok: false, error: 'Explicit user confirmation required' };
    }
    return convertFileToUtf8(data?.path, data?.encoding || '');
  });

  routes.set('POST /api/launcher/generate', () => {
    const dataDir = stateStore.dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    if (process.platform === 'win32') {
      const localApp = process.env.LOCALAPPDATA || '';
      const candidates = [
        path.join(localApp, 'Programs', 'antigravity', 'Antigravity.exe'),
        path.join(localApp, 'Programs', 'Antigravity', 'Antigravity.exe'),
      ];
      const exePath = candidates.find((c) => c && fs.existsSync(c)) || candidates[0];
      const cmdPath = path.join(dataDir, 'launch_antigravity_cdp.cmd');
      const vbsPath = path.join(dataDir, 'launch_antigravity_cdp.vbs');
      // Pure 7-bit ASCII + CRLF using %LOCALAPPDATA% & %~dp0 so non-ASCII Windows usernames never break
      const vbs = [
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set sh = CreateObject("WScript.Shell")',
        'base = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")',
        'exe1 = base & "\\Programs\\antigravity\\Antigravity.exe"',
        'exe2 = base & "\\Programs\\Antigravity\\Antigravity.exe"',
        'target = exe1',
        'If Not fso.FileExists(exe1) And fso.FileExists(exe2) Then target = exe2',
        'sh.Run """" & target & """ --remote-debugging-port=0", 1, False',
        '',
      ].join('\r\n');
      const cmd = [
        '@echo off',
        'wscript.exe //B "%~dp0launch_antigravity_cdp.vbs"',
        'exit /b 0',
        '',
      ].join('\r\n');
      fs.writeFileSync(vbsPath, vbs, 'ascii');
      fs.writeFileSync(cmdPath, cmd, 'ascii');
      return { ok: true, platform: 'win32', launcherPath: cmdPath, vbsPath, exePath };
    }
    const shPath = path.join(dataDir, 'launch_antigravity_cdp.sh');
    const sh = process.platform === 'darwin'
      ? '#!/usr/bin/env bash\nopen -a "/Applications/Antigravity.app" --args --remote-debugging-port=0\n'
      : '#!/usr/bin/env bash\nantigravity --remote-debugging-port=0 &\n';
    fs.writeFileSync(shPath, sh, { encoding: 'utf8', mode: 0o755 });
    return { ok: true, platform: process.platform, launcherPath: shPath };
  });

  routes.set('GET /api/file/raw', (data) => {
    const safe = resolveSafeReadPath(data?.path);
    if (!safe.ok) return makeResp(safe.error, 'text/plain; charset=utf-8', 404);
    if (safe.stat.size > MAX_RAW_SERVE_BYTES) {
      return makeResp('File too large for direct raw serve', 'text/plain; charset=utf-8', 413);
    }
    const ext = path.extname(safe.filePath).toLowerCase();
    const contentType = RAW_MIME[ext] || 'application/octet-stream';
    try {
      const buf = fs.readFileSync(safe.filePath);
      return makeResp(buf, contentType, 200, { 'Cache-Control': 'private, max-age=60' });
    } catch (err) {
      return makeResp(String(err?.message || err), 'text/plain; charset=utf-8', 500);
    }
  });

  return routes;
}
