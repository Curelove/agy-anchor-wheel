import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacklinkIndex } from './backend/backlink_index.mjs';
import { createRouterHandlers } from './backend/http_router.mjs';
import { PreviewService } from './backend/preview_service.mjs';
import { normalizeFilePath } from './backend/security.mjs';
import { StateStore } from './backend/state_store.mjs';
import { UpdateService } from './backend/update_service.mjs';

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
  const norm = String(p).replace(/\\/g, '/');
  return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
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

function attachCorsAndPreflight(server) {
  if (!server || typeof server.listeners !== 'function') return;
  const existing = server.listeners('request');
  if (!existing.length) return;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
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
  const updateService = new UpdateService({ dataDir, pluginRoot: PLUGIN_ROOT });
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

  let bgUpdateTimer = null;
  if (settings.autoCheckUpdates !== false && !options.noUpdateCheck) {
    bgUpdateTimer = setTimeout(() => {
      void updateService.checkForUpdates({ force: false });
    }, 5000);
    bgUpdateTimer.unref?.();
  }

  let cdpBridge = null;
  if (!options.noCdp) {
    try {
      const mod = await import('./backend/cdp_bridge.mjs');
      cdpBridge = new mod.CdpBridge({ stateStore, backlinkIndex, previewService, updateService });
      cdpBridge.start();
    } catch (err) {
      console.error('[anchor-wheel] cdp_bridge start skipped:', err?.message || err);
    }
  }

  const getCdpStatus = () => (cdpBridge ? cdpBridge.getStatus() : { connected: false, reason: 'disabled' });
  const pushNativeSync = (payload) => cdpBridge?.pushSync?.(payload);

  const isSidecarMode = !options.standalone && Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  if (isSidecarMode) {
    const { SidecarApp, Response } = await loadSidecarSdk();
    const app = new SidecarApp();
    const routes = createRouterHandlers({
      stateStore,
      backlinkIndex,
      previewService,
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
    attachCorsAndPreflight(server);
    return {
      server,
      port: server.address().port,
      stateStore,
      backlinkIndex,
      updateService,
      cdpBridge,
      async stop() {
        clearTimeout(bgUpdateTimer);
        await cdpBridge?.stop?.();
        await app.close();
      },
    };
  }

  // Standalone HTTP server mode (for browser preview, unit tests, and Playwright audit)
  const routes = createRouterHandlers({
    stateStore,
    backlinkIndex,
    previewService,
    updateService,
    getCdpStatus,
    pushNativeSync,
    ResponseCtor: null,
    isStandalone: true,
  });

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');
    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const routeKey = `${req.method.toUpperCase()} ${url.pathname}`;
    if (!routes.has(routeKey)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const handler = routes.get(routeKey);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = {};
        for (const [k, v] of url.searchParams.entries()) data[k] = v;
        if (body) Object.assign(data, JSON.parse(body));
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
  const actualPort = server.address().port;
  console.log(`[anchor-wheel] standalone listening on http://127.0.0.1:${actualPort}`);

  return {
    server,
    port: actualPort,
    stateStore,
    backlinkIndex,
    updateService,
    cdpBridge,
    async stop() {
      clearTimeout(bgUpdateTimer);
      await cdpBridge?.stop?.();
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
