import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertFileToUtf8, inspectFileEncoding } from './encoding.mjs';
import { buildNavContext, classifyFile, listDirectoryDirectFiles } from './nav_context.mjs';
import { PreviewService } from './preview_service.mjs';
import { UpdateService } from './update_service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = path.resolve(__dirname, '..');

export const AW_BINDING = '__agAnchorWheelCall';
export const AW_RESOLVE = '__agAnchorWheelResolve';

export function getDefaultPortFilePath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'Antigravity', 'DevToolsActivePort');
}

export function readDevToolsPort(portFilePath = getDefaultPortFilePath()) {
  try {
    if (!fs.existsSync(portFilePath)) return null;
    const raw = fs.readFileSync(portFilePath, 'utf8').trim().split(/\r?\n/)[0]?.trim();
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

export function isEligibleAntigravityTarget(target) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || '').trim();
  const title = String(target.title || '').trim();
  if (!url) return false;
  const low = url.toLowerCase();
  if (
    low.startsWith('devtools://') ||
    low.startsWith('data:') ||
    low.startsWith('about:') ||
    low.startsWith('chrome:') ||
    low.startsWith('chrome-extension:') ||
    low.startsWith('edge:') ||
    low.startsWith('blob:') ||
    low.startsWith('plugin:')
  ) {
    return false;
  }
  if (/^(?:untitled|launchpad)$/i.test(title) || /\/launchpad(?:\.html)?(?:[?#]|$)/i.test(low)) {
    return false;
  }
  if (low.startsWith('vscode-file://') || low.startsWith('app://')) return true;
  if (low.startsWith('file://')) return /workbench|antigravity/i.test(low) || /\bantigravity\b/i.test(title);
  const m = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/[^?#]*)?(?:[?#]|$)/i.exec(url);
  if (!m) return false;
  const pathname = (m[3] || '/').toLowerCase();
  if (/^\/(?:viewer(?:\/|$)|sandbox(?:\/|$)|stream(?:\/|$)|api(?:\/|$))/.test(pathname)) return false;
  if (/\bantigravity\b/i.test(title)) return true;
  if (m[1].toLowerCase() === 'https' && (!title || /^127\.0\.0\.1(?::\d+)?/.test(title))) return true;
  return false;
}

class MiniCdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.onClose = null;

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) {
          try { cb(msg.params); } catch {}
        }
        return;
      }
      const req = msg.id && this.pending.get(msg.id);
      if (!req) return;
      this.pending.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else req.resolve(msg.result);
    });

    const closeHandler = () => {
      if (this.closed) return;
      this.closed = true;
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error('CDP closed'));
      }
      this.pending.clear();
      if (this.onClose) {
        try { this.onClose(); } catch {}
      }
    };

    ws.addEventListener('close', closeHandler);
    ws.addEventListener('error', closeHandler);
  }

  static connect(wsUrl, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new MiniCdpSession(ws));
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(err?.message || 'CDP connect error'));
      });
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(cb);
  }

  send(method, params = {}, timeoutMs = 4000) {
    if (this.closed) return Promise.reject(new Error('Session closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  evaluate(expression) {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error('CDP closed'));
    }
    this.pending.clear();
    this.listeners.clear();
    try { this.ws.close(); } catch {}
  }
}

const BUNDLE_SOURCE_FILES = Object.freeze([
  ['shared', 'wheel_styles.css'],
  ['shared', 'nav_shared.js'],
  ['shared', 'radial_wheel.js'],
  ['shared', 'bilateral_wheel.js'],
  ['shared', 'ae_tree.js'],
  ['shared', 'settings_modal.js'],
  ['shared', 'markdown_render.js'],
  ['native', 'native_enhancer.js'],
]);

function safeJson(val) {
  return JSON.stringify(val ?? null).replace(/[<>/\u2028\u2029]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export class CdpBridge {
  constructor({ stateStore, backlinkIndex, previewService, updateService, portFilePath } = {}) {
    this.stateStore = stateStore;
    this.backlinkIndex = backlinkIndex;
    this.previewService = previewService || (stateStore ? new PreviewService(stateStore.dataDir) : null);
    this.updateService = updateService || (stateStore ? new UpdateService({ dataDir: stateStore.dataDir }) : null);
    this.portFilePath = portFilePath || getDefaultPortFilePath();
    this.sessions = new Map(); // target.id -> entry
    this.timer = null;
    this.running = false;
    this.tickInFlight = false;
    this.currentPort = null;
    this.lastError = '';
    this.lastSourceFingerprint = '';
    this._cachedBundle = null;
    this._cachedBundleFingerprint = '';
  }

  computeSourceFingerprint() {
    const parts = [];
    for (const segs of BUNDLE_SOURCE_FILES) {
      const p = path.join(SIDECAR_ROOT, ...segs);
      try {
        const st = fs.statSync(p);
        parts.push(`${segs.join('/')}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${segs.join('/')}:missing`);
      }
    }
    return parts.join('|');
  }

  computeBundle() {
    const fp = this.computeSourceFingerprint();
    const bundle = this.buildInjectBundle();
    const hash = crypto.createHash('sha256').update(fp).digest('hex');
    this._cachedBundle = bundle;
    this._cachedBundleFingerprint = fp;
    return { bundle, hash, fingerprint: fp };
  }

  buildInjectBundle() {
    const wheelCss = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'wheel_styles.css'), 'utf8');
    const navSharedJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'nav_shared.js'), 'utf8');
    const wheelJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'radial_wheel.js'), 'utf8');
    const bilateralJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'bilateral_wheel.js'), 'utf8');
    const aeTreeJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'ae_tree.js'), 'utf8');
    const settingsModalJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'settings_modal.js'), 'utf8');
    const mdJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'shared', 'markdown_render.js'), 'utf8');
    const nativeJs = fs.readFileSync(path.join(SIDECAR_ROOT, 'native', 'native_enhancer.js'), 'utf8');
    const meta = this.updateService?.getPluginMeta?.() || null;

    const bootConfig = {
      settings: this.stateStore.getSettings(),
      wheelCss,
      version: meta?.version || '0.0.0',
      repoUrl: meta?.repoUrl || 'https://github.com/Curelove/agy-anchor-wheel',
      releasesUrl: meta?.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases',
      compatibility: meta ? { ...meta.compatibility, localAntigravity: meta.localAntigravity } : null,
    };

    return [
      `window.__agAnchorWheelBoot = ${safeJson(bootConfig)};`,
      navSharedJs,
      wheelJs,
      bilateralJs,
      aeTreeJs,
      settingsModalJs,
      mdJs,
      nativeJs,
    ].join('\n;\n');
  }

  start(pollIntervalMs = 3000) {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => {
      if (this.running) void this.tick();
    }, pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const entry of this.sessions.values()) {
      try { entry.session.close(); } catch {}
    }
    this.sessions.clear();
  }

  async destroyOnAllPages() {
    for (const entry of this.sessions.values()) {
      await entry.session.evaluate('window.__agAnchorWheel?.destroy?.()').catch(() => {});
    }
  }

  getStatus() {
    return {
      connected: this.sessions.size > 0,
      port: this.currentPort,
      pageCount: this.sessions.size,
      reason: this.sessions.size > 0 ? 'connected' : this.lastError || 'waiting',
    };
  }

  pushSync(payload) {
    const expr = `window.__agAnchorWheel?.onBackendSync?.(${safeJson(payload)})`;
    for (const entry of this.sessions.values()) {
      void entry.session.evaluate(expr).catch(() => {});
    }
  }

  _isTrustedMainFrameCall(entry, executionContextId) {
    if (!entry) return false;
    if (typeof executionContextId !== 'number') return false;
    const meta = entry.contextFrames.get(executionContextId);
    if (!meta) return false;
    if (meta.isDefault !== true) return false;
    if (meta.type && meta.type !== 'default') return false;
    if (!entry.mainFrameId || !meta.frameId || meta.frameId !== entry.mainFrameId) return false;
    return true;
  }

  async _handleRpc(req) {
    const { action } = req;
    const cid = String(req.conversationId || 'default').trim() || 'default';
    switch (action) {
      case 'getBoot': {
        const meta = this.updateService
          ? this.updateService.getPluginMeta()
          : { version: '0.0.0', repoUrl: 'https://github.com/Curelove/agy-anchor-wheel', releasesUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases', compatibility: {}, localAntigravity: null };
        return {
          ok: true,
          version: meta.version,
          repoUrl: meta.repoUrl,
          releasesUrl: meta.releasesUrl,
          compatibility: { ...meta.compatibility, localAntigravity: meta.localAntigravity },
          updateInfo: this.updateService?.getCachedResult?.() || null,
          settings: this.stateStore.getSettings(),
          session: this.stateStore.getSession(cid),
          indexStats: this.backlinkIndex.getStats(),
        };
      }
      case 'checkUpdate':
        if (!this.updateService) return { ok: false, error: 'Update service unavailable' };
        return this.updateService.checkForUpdates({ force: Boolean(req.force) });
      case 'getCompatStatus':
        if (!this.updateService) return { ok: false, error: 'Update service unavailable' };
        return { ok: true, ...this.updateService.getPluginMeta(), cdp: this.getStatus() };
      case 'getSession':
        return { ok: true, session: this.stateStore.getSession(cid) };
      case 'sessionOp': {
        const op = String(req.op || '');
        if (op === 'pinAnchor') return { ok: true, session: this.stateStore.pinAnchor(cid, req) };
        if (op === 'unpinGroup') return { ok: true, session: this.stateStore.unpinGroup(cid, req.groupId) };
        if (op === 'adoptChild') return { ok: true, ...this.stateStore.adoptChild(cid, req) };
        if (op === 'touchChild') return { ok: true, session: this.stateStore.touchChild(cid, req) };
        if (op === 'toggleLock') return { ok: true, session: this.stateStore.toggleChildLock(cid, req) };
        if (op === 'removeChild') return { ok: true, session: this.stateStore.removeChild(cid, req) };
        if (op === 'restoreEvicted') return { ok: true, ...this.stateStore.restoreEvicted(cid, req) };
        if (op === 'setGroupLimit') return { ok: true, ...this.stateStore.setGroupLimit(cid, req) };
        if (op === 'history') {
          return {
            ok: true,
            ...this.stateStore.navigateHistory(cid, { ...req, action: req.historyAction || req.action }),
          };
        }
        if (op === 'recordLineage') {
          return { ok: true, session: this.stateStore.recordLineage(cid, req) };
        }
        return { ok: false, error: `Unknown op: ${op}` };
      }
      case 'getNavContext': {
        let changed = false;
        if (Array.isArray(req.workspaceRoots) && req.workspaceRoots.length) {
          changed = this.backlinkIndex.updateConfig({ workspaceRoots: req.workspaceRoots });
        }
        if (changed || this.backlinkIndex.lastScanMs === 0) {
          this.backlinkIndex.rescan({ force: false });
        } else {
          this.backlinkIndex.scheduleBackgroundRescan();
        }
        return {
          ok: true,
          ...buildNavContext({
            stateStore: this.stateStore,
            backlinkIndex: this.backlinkIndex,
            conversationId: cid,
            activePath: req.path || req.activePath || '',
            activeIsDirectory: Boolean(req.isDirectory),
            openTabs: Array.isArray(req.openTabs) ? req.openTabs : [],
            scopeOverride: req.scope || '',
          }),
        };
      }
      case 'listDir': {
        const settings = this.stateStore.getSettings();
        const listing = listDirectoryDirectFiles(req.path || '', {
          maxFiles: req.maxFiles,
          includeStats: Boolean(req.includeStats),
        });
        if (!listing.ok) return listing;
        const files = listing.files.map((f) => {
          const cls = classifyFile(f.path, settings.categoryRules, false);
          return {
            ...f,
            title: f.name,
            ext: cls.ext,
            isDirectory: false,
            categoryId: cls.id,
            categoryLabel: cls.label,
          };
        });
        return {
          ok: true,
          isDirectory: true,
          path: listing.dirPath,
          key: listing.key,
          title: listing.title,
          files,
          totalFiles: listing.totalFiles,
          skippedSubdirCount: listing.skippedSubdirCount,
          truncated: listing.truncated,
          maxFiles: listing.maxFiles,
        };
      }
      case 'getPreview': {
        if (!this.previewService) {
          return { ok: false, error: 'Preview service unavailable' };
        }
        const animated =
          typeof req.animated === 'boolean' ? req.animated : this.stateStore.getSettings().videoPreviewAnimated !== false;
        return this.previewService.getPreview(req.path || '', { animated });
      }
      case 'updateSettings': {
        const next = this.stateStore.updateSettings(req.settings || {});
        const cfgChanged = this.backlinkIndex.updateConfig({
          extraScanDirs: next.extraScanDirs,
          scanWorkspace: next.scanWorkspace,
          scanArtifacts: next.scanArtifacts,
        });
        if (cfgChanged) {
          this.backlinkIndex.scheduleBackgroundRescan({ force: false });
        }
        this.pushSync({ settings: next });
        return { ok: true, settings: next };
      }
      case 'getBacklinks': {
        let changed = false;
        if (Array.isArray(req.workspaceRoots) && req.workspaceRoots.length) {
          changed = this.backlinkIndex.updateConfig({ workspaceRoots: req.workspaceRoots });
        }
        if (changed || this.backlinkIndex.lastScanMs === 0) {
          this.backlinkIndex.rescan({ force: false });
        } else {
          this.backlinkIndex.scheduleBackgroundRescan();
        }
        return { ok: true, ...this.backlinkIndex.getLinksForFile(req.path || '') };
      }
      case 'rescanIndex': {
        if (Array.isArray(req.workspaceRoots) && req.workspaceRoots.length) {
          this.backlinkIndex.updateConfig({ workspaceRoots: req.workspaceRoots });
        }
        return { ok: true, stats: this.backlinkIndex.rescan({ force: Boolean(req.force) }) };
      }
      case 'inspectEncoding':
        return inspectFileEncoding(req.path, { overrideEncoding: req.encoding || '', maxBytes: 256 * 1024 });
      case 'readFile':
        return inspectFileEncoding(req.path, { overrideEncoding: req.encoding || '', maxBytes: 4 * 1024 * 1024 });
      case 'convertUtf8':
        if (!req.confirm) return { ok: false, error: 'Explicit confirm required' };
        return convertFileToUtf8(req.path, req.encoding || '');
      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  async _attachTarget(target) {
    const session = await MiniCdpSession.connect(target.webSocketDebuggerUrl);
    const entry = {
      id: target.id,
      session,
      mainFrameId: null,
      contextFrames: new Map(),
      newDocScriptId: null,
    };
    this.sessions.set(target.id, entry);

    session.onClose = () => {
      if (this.sessions.get(target.id) === entry) {
        this.sessions.delete(target.id);
      }
    };

    session.on('Runtime.executionContextCreated', (params) => {
      const ctx = params?.context;
      if (ctx && typeof ctx.id === 'number') {
        entry.contextFrames.set(ctx.id, {
          frameId: ctx.auxData?.frameId || '',
          isDefault: ctx.auxData?.isDefault === true,
          type: ctx.auxData?.type || 'default',
        });
      }
    });
    session.on('Runtime.executionContextDestroyed', (params) => {
      if (typeof params?.executionContextId === 'number') {
        entry.contextFrames.delete(params.executionContextId);
      }
    });
    session.on('Runtime.executionContextsCleared', () => {
      entry.contextFrames.clear();
    });
    session.on('Page.frameNavigated', (params) => {
      if (params?.frame && !params.frame.parentId && params.frame.id) {
        entry.mainFrameId = params.frame.id;
      }
    });

    session.on('Runtime.bindingCalled', async (params) => {
      if (!params || params.name !== AW_BINDING) return;
      if (!this._isTrustedMainFrameCall(entry, params.executionContextId)) return;
      let parsed;
      try {
        parsed = JSON.parse(params.payload || '{}');
      } catch {
        return;
      }
      const { id } = parsed;
      let res;
      try {
        res = await this._handleRpc(parsed);
      } catch (err) {
        res = { ok: false, error: String(err?.message || err) };
      }
      if (id !== undefined) {
        await session
          .send('Runtime.evaluate', {
            expression: `window.${AW_RESOLVE}?.(${safeJson(id)}, ${safeJson(res)})`,
            contextId: params.executionContextId,
            returnByValue: false,
          })
          .catch(() => {});
      }
    });

    await session.send('Page.enable').catch(() => {});
    await session.send('Runtime.enable').catch(() => {});

    const frameTree = await session.send('Page.getFrameTree').catch(() => null);
    if (frameTree?.frameTree?.frame?.id) {
      entry.mainFrameId = frameTree.frameTree.frame.id;
    }

    await session.send('Runtime.addBinding', { name: AW_BINDING }).catch(() => {});
    const { bundle, fingerprint } = this.computeBundle();
    this.lastSourceFingerprint = fingerprint;
    const scriptRes = await session
      .send('Page.addScriptToEvaluateOnNewDocument', { source: bundle })
      .catch(() => null);
    if (scriptRes?.identifier) entry.newDocScriptId = scriptRes.identifier;

    await session.evaluate(bundle).catch(() => {});
  }

  async _hotReloadSessions(bundle) {
    for (const entry of this.sessions.values()) {
      if (entry.newDocScriptId) {
        await entry.session
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.newDocScriptId })
          .catch(() => {});
        entry.newDocScriptId = null;
      }
      const scriptRes = await entry.session
        .send('Page.addScriptToEvaluateOnNewDocument', { source: bundle })
        .catch(() => null);
      if (scriptRes?.identifier) entry.newDocScriptId = scriptRes.identifier;
      await entry.session.evaluate(bundle).catch(() => {});
    }
  }

  async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const port = readDevToolsPort(this.portFilePath);
      if (!port) {
        this.currentPort = null;
        this.lastError = 'DevToolsActivePort not found';
        return;
      }
      this.currentPort = port;
      let pages;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        pages = await res.json();
      } catch {
        this.lastError = `Port ${port} unreachable`;
        return;
      }

      const eligible = (Array.isArray(pages) ? pages : []).filter(isEligibleAntigravityTarget);
      const eligibleIds = new Set(eligible.map((t) => t.id));
      for (const [id, entry] of this.sessions.entries()) {
        if (!eligibleIds.has(id)) {
          try { entry.session.close(); } catch {}
          this.sessions.delete(id);
        }
      }

      for (const target of eligible) {
        if (this.sessions.has(target.id)) continue;
        try {
          await this._attachTarget(target);
          this.lastError = '';
        } catch (err) {
          this.lastError = String(err?.message || err);
        }
      }

      // Lightweight stat-only fingerprint check: zero disk reads unless source files actually changed
      if (this.sessions.size > 0) {
        const fp = this.computeSourceFingerprint();
        if (fp !== this.lastSourceFingerprint) {
          const { bundle } = this.computeBundle();
          this.lastSourceFingerprint = fp;
          await this._hotReloadSessions(bundle);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
