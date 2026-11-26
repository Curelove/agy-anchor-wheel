import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BacklinkIndex } from './backend/backlink_index.mjs';
import { createRouterHandlers } from './backend/http_router.mjs';
import { PreviewService } from './backend/preview_service.mjs';
import { normalizeFilePath } from './backend/security.mjs';
import { StateStore } from './backend/state_store.mjs';
import { UpdateService } from './backend/update_service.mjs';
import { VideoService } from './backend/video_service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const globalSdk = path.join(os.homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
    return await import(pathToFileUrlStr(globalSdk));
  }
}

function pathToFileUrlStr(p) {
  return pathToFileURL(path.resolve(String(p))).href;
}

function parseCliArgs(argv) {
  const args = {
    standalone: argv.includes('--standalone') || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
    noCdp: argv.includes('--no-cdp'),
    port: 0,
    dataDir: '',
    workspaceRoots: [],
    brainDir: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) args.port = Number(argv[++i]) || 0;
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7)) || 0;
    else if (a === '--data-dir' && argv[i + 1]) args.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) args.dataDir = a.slice(11);
    else if (a === '--workspace' && argv[i + 1]) args.workspaceRoots.push(normalizeFilePath(argv[++i]));
    else if (a.startsWith('--workspace=')) args.workspaceRoots.push(normalizeFilePath(a.slice(12)));
    else if (a === '--brain-dir' && argv[i + 1]) args.brainDir = normalizeFilePath(argv[++i]);
    else if (a.startsWith('--brain-dir=')) args.brainDir = normalizeFilePath(a.slice(12));
  }
  return args;
}

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

function resolveAllowedOrigin(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin || origin === 'null') return '';
  if (
    /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|vscode-file:\/\/[^\s]+|vscode-webview:\/\/[^\s]+|antigravity-ide:\/\/[^\s]+|app:\/\/[^\s]+)$/i.test(
      origin
    )
  ) {
    return origin;
  }
  return '';
}

function applySafeCorsHeaders(req, res) {
  const allowed = resolveAllowedOrigin(req);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.setHeader('Access-Control-Max-Age', '600');
}

function attachCorsAndMediaMiddleware(server, videoService) {
  if (!server || typeof server.listeners !== 'function') return;
  const existing = server.listeners('request');
  if (!existing.length) return;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    applySafeCorsHeaders(req, res);
    const method = String(req.method || '').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (videoService && (method === 'GET' || method === 'HEAD')) {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/api/media/stream') {
          videoService.handleMediaStreamHttp(req, res, url);
          return;
        }
        if (url.pathname === '/api/file/raw') {
          if (videoService.handleRawFileHttp(req, res, url)) return;
        }
      } catch {}
    }
    for (const listener of existing) listener.call(server, req, res);
  });
}

export async function startServer(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    path.join(PLUGIN_ROOT, 'data');

  const stateStore = new StateStore(dataDir);
  const previewService = new PreviewService(dataDir);
  const videoService = new VideoService(dataDir);
  const updateService = new UpdateService({
    dataDir,
    pluginRoot: PLUGIN_ROOT,
    getIgnoredVersion: () => stateStore.getSettings().ignoredUpdateVersion,
  });
  const settings = stateStore.getSettings();
  const backlinkIndex = new BacklinkIndex({
    workspaceRoots: options.workspaceRoots || [],
    extraScanDirs: settings.extraScanDirs,
    scanWorkspace: settings.scanWorkspace,
    scanArtifacts: settings.scanArtifacts,
    brainDir: options.brainDir || undefined,
  });

  // Initial lightweight scan in background tick so boot never blocks
  setImmediate(() => {
    try { backlinkIndex.rescan({ force: false }); } catch {}
  });

  let activePort = 0;
  const getMediaBaseUrl = () => (activePort ? `http://127.0.0.1:${activePort}` : '');

  let cdpBridge = null;
  if (!options.noCdp) {
    try {
      const mod = await import('./backend/cdp_bridge.mjs');
      cdpBridge = new mod.CdpBridge({
        stateStore,
        backlinkIndex,
        previewService,
        videoService,
        updateService,
        getMediaBaseUrl,
      });
      cdpBridge.start();
    } catch (err) {
      console.error('[anchor-wheel] cdp_bridge start skipped:', err?.message || err);
    }
  }

  const getCdpStatus = () => (cdpBridge ? cdpBridge.getStatus() : { connected: false, reason: 'disabled' });
  const pushNativeSync = (payload) => cdpBridge?.pushSync?.(payload);

  const runSilentUpdateCheck = async () => {
    if (stateStore.getSettings().autoCheckUpdates === false) return;
    try {
      const res = await updateService.checkForUpdates({ force: false });
      if (res && (res.ok || res.error)) {
        pushNativeSync({ updateInfo: res });
      }
    } catch {}
  };

  let bgUpdateTimer = null;
  let bgUpdateInterval = null;
  if (!options.noUpdateCheck) {
    bgUpdateTimer = setTimeout(() => {
      void runSilentUpdateCheck();
    }, 5000);
    bgUpdateTimer.unref?.();
    // Periodic 6-hour check so long-running Antigravity sessions receive new version pushes automatically
    bgUpdateInterval = setInterval(() => {
      void runSilentUpdateCheck();
    }, 6 * 60 * 60 * 1000);
    bgUpdateInterval.unref?.();
  }

  const isSidecarMode = !options.standalone && Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  if (isSidecarMode) {
    const { SidecarApp, Response } = await loadSidecarSdk();
    const app = new SidecarApp();
    const routes = createRouterHandlers({
      stateStore,
      backlinkIndex,
      previewService,
      videoService,
      updateService,
      getCdpStatus,
      pushNativeSync,
      ResponseCtor: Response,
      isStandalone: false,
    });

    for (const [key, handler] of routes.entries()) {
      const idx = key.indexOf(' ');
      const method = key.slice(0, idx);
      const routePath = key.slice(idx + 1);
      if (method === 'GET' && routePath === '/') {
        app.page('/', handler);
      } else {
        app.api(routePath, handler, method);
      }
    }

    const server = await app.run();
    activePort = server.address().port;
    attachCorsAndMediaMiddleware(server, videoService);
    return {
      server,
      port: activePort,
      stateStore,
      backlinkIndex,
      videoService,
      updateService,
      cdpBridge,
      async stop() {
        clearTimeout(bgUpdateTimer);
        clearInterval(bgUpdateInterval);
        await cdpBridge?.stop?.();
        previewService.dispose();
        videoService.dispose();
        backlinkIndex.dispose();
        stateStore.flush();
        await app.close();
      },
    };
  }

  // Standalone HTTP server mode (for browser preview, unit tests, and Playwright audit)
  const routes = createRouterHandlers({
    stateStore,
    backlinkIndex,
    previewService,
    videoService,
    updateService,
    getCdpStatus,
    pushNativeSync,
    ResponseCtor: null,
    isStandalone: true,
  });

  const server = http.createServer((req, res) => {
    applySafeCorsHeaders(req, res);
    const method = String(req.method || '').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    if (method === 'GET' || method === 'HEAD') {
      if (url.pathname === '/api/media/stream') {
        videoService.handleMediaStreamHttp(req, res, url);
        return;
      }
      if (url.pathname === '/api/file/raw') {
        if (videoService.handleRawFileHttp(req, res, url)) return;
      }
    }

    const routeKey = `${method} ${url.pathname}`;
    if (!routes.has(routeKey)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const handler = routes.get(routeKey);
    const chunks = [];
    let bodyBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Request payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooLarge) return;
      try {
        const data = {};
        for (const [k, v] of url.searchParams.entries()) data[k] = v;
        if (chunks.length) {
          const body = Buffer.concat(chunks).toString('utf8');
          if (body.trim()) {
            let parsed;
            try {
              parsed = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'Invalid JSON request body' }));
              return;
            }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              Object.assign(data, parsed);
            }
          }
        }
        const out = await handler(data);
        if (out && typeof out === 'object' && out.contentType && out.body !== undefined) {
          res.writeHead(out.status || 200, { 'Content-Type': out.contentType, ...(out.headers || {}) });
          res.end(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      }
    });
  });

  await new Promise((resolve) => server.listen(options.port || 0, '127.0.0.1', resolve));
  activePort = server.address().port;
  console.log(`[anchor-wheel] standalone listening on http://127.0.0.1:${activePort}`);

  return {
    server,
    port: activePort,
    stateStore,
    backlinkIndex,
    videoService,
    updateService,
    cdpBridge,
    async stop() {
      clearTimeout(bgUpdateTimer);
      clearInterval(bgUpdateInterval);
      await cdpBridge?.stop?.();
      previewService.dispose();
      videoService.dispose();
      backlinkIndex.dispose();
      stateStore.flush();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const cli = parseCliArgs(process.argv.slice(2));
  const inst = await startServer(cli);
  const shutdown = async () => {
    await inst.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
