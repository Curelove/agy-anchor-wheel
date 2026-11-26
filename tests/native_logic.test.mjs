import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8')).version;

function findBrowserExe() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function waitForPortFile(userDataDir, timeoutMs = 8000) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out waiting for headless Chromium DevToolsActivePort');
}

class MiniCdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'Runtime exception');
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalAsync(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res?.result?.value;
  }
}

test('Mode 1 native_enhancer: DOM container tracking, non-overwriting tab dispatch, middle-click wheel, and popover tab switching', async (t) => {
  const exe = findBrowserExe();
  if (!exe) {
    t.skip('No headless Chromium binary available');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-native-test-'));
  const profileDir = path.join(tmpRoot, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const wheelCss = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'wheel_styles.css'), 'utf8');
  const navSharedJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'nav_shared.js'), 'utf8');
  const wheelJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'radial_wheel.js'), 'utf8');
  const bilateralJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'bilateral_wheel.js'), 'utf8');
  const aeTreeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'ae_tree.js'), 'utf8');
  const settingsModalJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'settings_modal.js'), 'utf8');
  const mdJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'markdown_render.js'), 'utf8');
  const nativeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'native', 'native_enhancer.js'), 'utf8');

  let browserProc = null;
  let ws = null;

  try {
    browserProc = spawn(
      exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const port = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new MiniCdp(ws);
    await cdp.send('Runtime.enable');

    // Mount Antigravity DOM + sidePanelV2 Redux mock inside page
    const setupResult = await cdp.evalAsync(`(async () => {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);

      const cid = '11111111-2222-3333-4444-555555555555';
      const mdUri = 'file:///c%3A/Users/demo/02_%E5%AE%A1%E6%A0%A1%E6%8A%A5%E5%91%8A.md';
      const doubleEncTargetUri = 'file:///c%3A/Users/demo/01_%25E5%2589%25A7%25E6%259C%25AC.md';

      window.__dispatchedActions = [];
      window.__nativeOverwriteCount = 0;

      const storeState = {
        sidePanelV2: {
          conversationPanes: {
            [cid]: {
              activeTabId: 'file__' + mdUri,
              tabs: [
                {
                  id: 'file__' + mdUri,
                  content: { type: 'fileView', fileView: { fileUri: mdUri, cascadeId: cid } },
                  isPreview: true,
                },
              ],
            },
          },
          overviewPanelOpen: {},
        },
      };
      const listeners = new Set();
      const reduxStore = {
        getState: () => storeState,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        dispatch: (action) => {
          window.__dispatchedActions.push(action);
          const pane = storeState.sidePanelV2.conversationPanes[cid];
          if (action.type === 'sidePanel/setSidePanelOpen') {
            if (!action.payload?.panelScope?.kind) {
              throw new TypeError("Cannot read properties of undefined (reading 'kind')");
            }
          } else if (action.type === 'sidePanelV2/promoteTab') {
            const tab = pane.tabs.find((t) => t.id === action.payload.tabId);
            if (tab) tab.isPreview = false;
          } else if (action.type === 'sidePanelV2/setContent') {
            const f = action.payload.content;
            const k = action.payload.tabId || ('file__' + f.fileView?.fileUri);
            if (!pane.tabs.some((t) => t.id === k)) {
              pane.tabs.push({ id: k, content: f });
            }
            if (!action.payload.background) pane.activeTabId = k;
          } else if (action.type === 'sidePanelV2/setActiveTab') {
            pane.activeTabId = action.payload.tabId;
          }
          for (const fn of listeners) fn();
        },
      };

      const browserCtx = {
        openUrlInBrowserPane: () => {},
        getTargetTreeId: () => ({ kind: 'cascadeId', cascadeId: cid }),
      };
      window.__routerSearch = { project: 'demo-proj', tab: 'file__' + mdUri };
      const mockRouter = {
        navigate: (opts) => {
          if (typeof opts?.search === 'function') {
            window.__routerSearch = opts.search(window.__routerSearch);
          } else if (opts?.search && typeof opts.search === 'object') {
            window.__routerSearch = { ...opts.search };
          }
          return Promise.resolve();
        },
        buildLocation: () => ({}),
      };
      root.__reactContainer$test = {
        memoizedProps: { store: reduxStore, value: browserCtx, router: mockRouter },
        child: null,
        sibling: null,
      };

      // Mock chat prompt box on the left to test Tab input safety
      const chatBox = document.createElement('div');
      chatBox.setAttribute('data-testid', 'agent-input-box');
      const chatInput = document.createElement('input');
      chatInput.id = 'chat-input';
      chatInput.type = 'text';
      chatBox.appendChild(chatInput);
      root.appendChild(chatBox);

      // Mock Antigravity aux pane split DOM (wide enough > 80px for right pane check)
      const aux = document.createElement('div');
      aux.setAttribute('data-testid', 'aux-pane-split');
      const left = document.createElement('div');
      const right = document.createElement('div');
      right.style.cssText = 'width:460px;height:700px;';
      const col = document.createElement('div');
      col.className = 'flex flex-col browser-hole-ancestor';
      col.style.cssText = 'width:460px;height:700px;';

      const tabBar = document.createElement('div');
      tabBar.className = 'agy-layout-vars shrink-0 flex items-center';
      const tabEl = document.createElement('div');
      tabEl.className = 'agy-aux-tab';
      tabEl.__reactFiber$test = { memoizedProps: { tab: storeState.sidePanelV2.conversationPanes[cid].tabs[0] } };
      tabBar.appendChild(tabEl);

      const contentWrap = document.createElement('div');
      contentWrap.className = 'flex-grow basis-0 overflow-hidden';
      const crumb = document.createElement('div');
      crumb.setAttribute('data-uri', mdUri);
      crumb.textContent = '02_审校报告.md';
      const para = document.createElement('p');
      para.id = 'blank-para';
      para.textContent = '正文空白测试区域';
      const pill = document.createElement('button');
      pill.id = 'test-pill';
      pill.className = 'inline-pill';
      pill.setAttribute('data-uri', doubleEncTargetUri);
      pill.textContent = '01_剧本.md';
      pill.addEventListener('click', () => {
        window.__nativeOverwriteCount++;
      });

      contentWrap.append(crumb, para, pill);
      col.append(tabBar, contentWrap);
      right.appendChild(col);
      aux.append(left, right);
      root.appendChild(aux);

      // Mock RPC backend in window
      const mockSession = {
        groups: [],
        activeGroupId: null,
        history: { entries: [], index: -1 },
        recentlyEvicted: [],
        lineage: { parentByKey: {} },
      };
      let mockSettings = {
        wheelTrigger: 'middle_or_badge',
        middleMode: 'bilateral_wheel',
        tabTriggerEnabled: true,
        tabMode: 'ae_tree',
        tabCustomHotkey: 'Tab',
        tabCloseOnSelect: false,
        childSourceScope: 'opened_and_outlinks',
        parentDirection: 'left',
        hoverPreviewEnabled: true,
        hoverPreviewDelayMs: 50,
        videoPreviewAnimated: true,
        wheelSectors: 8,
        autoAnchorSummaryMd: true,
        autoCheckUpdates: false,
      };
      const outlinks = [
        ...Array.from({ length: 5 }, (_, idx) => ({
          kind: 'markdown',
          label: 'shot_' + idx + '.png',
          rawTarget: './shot_' + idx + '.png',
          resolvedPath: 'C:\\\\Users\\\\demo\\\\shot_' + idx + '.png',
          exists: true,
          line: idx + 1,
          lineStart: idx + 1,
        })),
        ...Array.from({ length: 7 }, (_, idx) => ({
          kind: 'markdown',
          label: 'item_' + idx + '.md',
          rawTarget: './item_' + idx + '.md',
          resolvedPath: 'C:\\\\Users\\\\demo\\\\item_' + idx + '.md',
          exists: idx < 5,
          line: idx + 10,
          lineStart: idx + 10,
        })),
      ];
      window.__agAnchorWheelCall = (raw) => {
        const req = JSON.parse(raw);
        const replyDelay = req.action === 'getPreview' ? 35 : 0;
        setTimeout(() => {
          let res = { ok: true, session: mockSession };
          if (req.action === 'getBoot') {
            res = {
              ok: true,
              version: ${JSON.stringify(PLUGIN_VERSION)},
              repoUrl: 'https://github.com/Curelove/agy-anchor-wheel',
              releasesUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases',
              compatibility: {
                testedAntigravityVersions: ['2.34.0'],
                testedRange: 'Antigravity 2.34.x',
                localAntigravity: { installedVersion: '2.34.0', compatLevel: 'verified' },
              },
              updateInfo: {
                ok: true,
                currentVersion: ${JSON.stringify(PLUGIN_VERSION)},
                latestVersion: ${JSON.stringify(PLUGIN_VERSION)},
                updateAvailable: false,
                releaseUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases/tag/v' + ${JSON.stringify(PLUGIN_VERSION)},
                publishedAt: '2026-11-24T03:00:00Z',
              },
              settings: mockSettings,
              session: mockSession,
            };
          } else if (req.action === 'checkUpdate') {
            res = {
              ok: true,
              currentVersion: ${JSON.stringify(PLUGIN_VERSION)},
              latestVersion: '0.7.0',
              updateAvailable: true,
              targetAntigravity: '2.34.x',
              releaseUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases/tag/v0.7.0',
              publishedAt: '2026-11-24T04:00:00Z',
              bodySnippet: 'Mock update available',
            };
          } else if (req.action === 'updateSettings') {
            mockSettings = { ...mockSettings, ...(req.settings || {}) };
            res = { ok: true, settings: mockSettings };
          } else if (req.action === 'getBacklinks') {
            res = { ok: true, path: req.path, title: '02_审校报告.md', backlinks: [], outlinks };
          } else if (req.action === 'getNavContext') {
            const p = String(req.path || '');
            const isShot = p.endsWith('.png');
            const children = isShot
              ? []
              : outlinks.filter((o) => o.exists).map((o, idx) => ({
                  path: o.resolvedPath,
                  key: o.resolvedPath.toLowerCase(),
                  title: o.label,
                  ext: o.label.split('.').pop(),
                  isOpenedTab: idx === 0,
                  categoryId: o.label.endsWith('.png') ? 'image' : 'doc',
                  categoryLabel: o.label.endsWith('.png') ? '图片' : '文档',
                }));
            const filtered = req.scope === 'opened_only' ? children.filter((c) => c.isOpenedTab) : children;
            res = {
              ok: true,
              activePath: p,
              childSourceScope: req.scope || mockSettings.childSourceScope,
              parentDirection: mockSettings.parentDirection,
              current: { path: p, key: p.toLowerCase(), title: p.split('\\\\').pop(), children: filtered },
              ancestors: [
                {
                  path: 'C:\\\\Users\\\\demo\\\\00_母页.md',
                  key: 'c:\\\\users\\\\demo\\\\00_母页.md',
                  title: '00_母页.md',
                  siblings: [{ path: 'C:\\\\Users\\\\demo\\\\sibling_a.md', title: 'sibling_a.md', isOpenedTab: true }],
                },
              ],
              parent: { path: 'C:\\\\Users\\\\demo\\\\00_母页.md', title: '00_母页.md' },
              categories: [
                { id: 'image', label: '图片', items: filtered.filter((x) => x.categoryId === 'image') },
                { id: 'video', label: '视频', items: [] },
                { id: 'doc', label: '文档', items: filtered.filter((x) => x.categoryId === 'doc') },
                { id: 'other', label: '其他', items: [] },
              ],
              totalCurrentChildren: filtered.length,
            };
          } else if (req.action === 'getPreview') {
            res = {
              ok: true,
              kind: 'text',
              path: req.path,
              title: String(req.path || '').split('\\\\').pop(),
              ext: 'md',
              snippetText: '# Preview Line 1\\nFast head snippet ready.',
              truncated: true,
            };
          } else if (req.action === 'sessionOp') {
            let targetEntry = null;
            if (req.op === 'pinAnchor') {
              const g = { id: 'grp-1', anchorPath: req.path, anchorTitle: req.title, children: [] };
              mockSession.groups = [g];
              mockSession.activeGroupId = g.id;
            } else if (req.op === 'adoptChild') {
              const g = mockSession.groups.find((x) => x.id === req.groupId);
              if (g && !g.children.some((c) => c.path === req.childPath)) {
                g.children.push({ path: req.childPath, title: req.childTitle, locked: false, lastAccessedAt: Date.now() });
              }
            } else if (req.op === 'history') {
              const ha = req.historyAction;
              if (ha === 'push' && req.entry?.path) {
                const h = mockSession.history;
                const cur = h.index >= 0 ? h.entries[h.index] : null;
                if (!cur || cur.path.toLowerCase() !== req.entry.path.toLowerCase()) {
                  h.entries = (h.index >= 0 ? h.entries.slice(0, h.index + 1) : []).concat([req.entry]);
                  h.index = h.entries.length - 1;
                }
              } else if (ha === 'back' || ha === 'forward') {
                const h = mockSession.history;
                const next = h.index + (ha === 'back' ? -1 : 1);
                if (next >= 0 && next < h.entries.length) {
                  h.index = next;
                  targetEntry = h.entries[next];
                }
              }
            }
            res = { ok: true, session: mockSession, evicted: [], targetEntry };
          }
          window.__agAnchorWheelResolve?.(req.id, res);
        }, replyDelay);
      };

      window.__agAnchorWheelBoot = { version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, wheelCss: ${JSON.stringify(wheelCss)} };
      eval(${JSON.stringify(navSharedJs)});
      eval(${JSON.stringify(wheelJs)});
      eval(${JSON.stringify(bilateralJs)});
      eval(${JSON.stringify(aeTreeJs)});
      eval(${JSON.stringify(settingsModalJs)});
      eval(${JSON.stringify(mdJs)});
      eval(${JSON.stringify(nativeJs)});

      const deadline = Date.now() + 800;
      while (Date.now() < deadline) {
        const d = window.__agAnchorWheel?.getDebugState?.();
        if (d && d.outlinkCount > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return {
        debug: window.__agAnchorWheel.getDebugState(),
        storeState,
      };
    })()`);

    assert.deepEqual(cdp.errors, []);
    assert.equal(setupResult.debug.version, PLUGIN_VERSION);
    assert.equal(setupResult.debug.hasContentContainer, true);
    assert.equal(setupResult.debug.contentContainerIndex, 2);
    assert.equal(setupResult.debug.outlinkCount, 12);

    // Test Popover: clicking 出链 12 defaults to outlinks tab, filter renders, switching tabs does NOT close!
    const popResult = await cdp.evalAsync(`(async () => {
      const linksBtn = document.querySelector('#aw-companion-strip [data-aw-role="links-btn"]');
      linksBtn.click();
      await new Promise((r) => setTimeout(r, 20));
      const pop1 = document.querySelector('.aw-popover');
      const outActive1 = pop1?.querySelector('[data-aw-ltab="outlinks"]')?.getAttribute('data-active');
      const hasFilter = !pop1?.querySelector('.aw-popover-filter')?.hidden;
      const rowsBefore = pop1?.querySelectorAll('.aw-link-row')?.length || 0;

      // Switch to backlinks tab
      pop1?.querySelector('[data-aw-ltab="backlinks"]')?.click();
      await new Promise((r) => setTimeout(r, 20));
      const popStillOpenAfterSwitch = Boolean(document.querySelector('.aw-popover'));
      const backActive = document.querySelector('.aw-popover [data-aw-ltab="backlinks"]')?.getAttribute('data-active');

      // Switch back to outlinks tab
      document.querySelector('.aw-popover [data-aw-ltab="outlinks"]')?.click();
      await new Promise((r) => setTimeout(r, 20));
      const popStillOpen2 = Boolean(document.querySelector('.aw-popover'));
      const outActive2 = document.querySelector('.aw-popover [data-aw-ltab="outlinks"]')?.getAttribute('data-active');

      // Click outside to close popover cleanly
      document.body.click();
      await new Promise((r) => setTimeout(r, 20));
      const closedAfterOutside = !document.querySelector('.aw-popover');

      return { outActive1, hasFilter, rowsBefore, popStillOpenAfterSwitch, backActive, popStillOpen2, outActive2, closedAfterOutside };
    })()`);

    assert.equal(popResult.outActive1, '1');
    assert.equal(popResult.hasFilter, true);
    assert.equal(popResult.rowsBefore, 12);
    assert.equal(popResult.popStillOpenAfterSwitch, true);
    assert.equal(popResult.backActive, '1');
    assert.equal(popResult.popStillOpen2, true);
    assert.equal(popResult.outActive2, '1');
    assert.equal(popResult.closedAfterOutside, true);

    // Test Middle Mouse Hold -> Bilateral Wheel (zero unreachable bottom buttons!), cancel on outside release
    const wheelResult = await cdp.evalAsync(`(async () => {
      const para = document.getElementById('blank-para');
      const mdEv = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1, clientX: 260, clientY: 260 });
      para.dispatchEvent(mdEv);

      const pdEv = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 260, clientY: 260 });
      para.dispatchEvent(pdEv);
      await new Promise((r) => setTimeout(r, 150));

      const biOpenHold = Boolean(document.querySelector('.aw-bi-stage'));
      const toolbarBtnsInHold = document.querySelectorAll('.aw-wheel-toolbar').length;

      // Move outside wheel to cancel and release middle button
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 12, clientY: 12 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, clientX: 12, clientY: 12 }));
      await new Promise((r) => setTimeout(r, 30));
      const closedOnOutsideRelease = !document.querySelector('.aw-bi-stage');

      // Stuck preview regression test: open hold wheel, hover category -> rail, glide across multiple items quickly,
      // then release outside BEFORE async getPreview finishes, verifying ZERO orphaned .aw-preview-card remain!
      para.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 260, clientY: 260 }));
      await new Promise((r) => setTimeout(r, 150));
      document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])')[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      document.querySelector('.aw-bi-more-pill')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));

      const railPills = Array.from(document.querySelectorAll('.aw-bi-rail-item'));
      let maxConcurrentPreviews = 0;
      railPills[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 110)); // first preview card mounted & resolved
      maxConcurrentPreviews = Math.max(maxConcurrentPreviews, document.querySelectorAll('.aw-preview-card').length);

      railPills[1]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 75)); // second preview loading
      maxConcurrentPreviews = Math.max(maxConcurrentPreviews, document.querySelectorAll('.aw-preview-card').length);

      railPills[2]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60)); // third preview in-flight async fetch!
      maxConcurrentPreviews = Math.max(maxConcurrentPreviews, document.querySelectorAll('.aw-preview-card').length);

      // Release outside while in-flight
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, clientX: 10, clientY: 10 }));
      const stuckImmediate = document.querySelectorAll('.aw-preview-card').length;
      await new Promise((r) => setTimeout(r, 140)); // wait past async resolve + poll windows
      const stuckAfterAsync = document.querySelectorAll('.aw-preview-card').length;

      // Re-open hold wheel, hover over parent left arc, and release to open parent!
      para.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 260, clientY: 260 }));
      await new Promise((r) => setTimeout(r, 150));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 170, clientY: 260 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, clientX: 170, clientY: 260 }));
      await new Promise((r) => setTimeout(r, 90));

      const cid = '11111111-2222-3333-4444-555555555555';
      const pane = root.__reactContainer$test.memoizedProps.store.getState().sidePanelV2.conversationPanes[cid];
      const openedParent = pane.tabs.some((t) => String(t.content?.fileView?.fileUri || '').includes('%E6%AF%8D%E9%A1%B5'));
      // Switch back to report for remaining tests
      root.__reactContainer$test.memoizedProps.store.dispatch({
        type: 'sidePanelV2/setActiveTab',
        payload: { panelScope: { kind: 'cascadeId', cascadeId: cid }, treeId: { kind: 'cascadeId', cascadeId: cid }, tabId: pane.tabs[0].id },
      });
      await new Promise((r) => setTimeout(r, 120));

      return {
        mousedownPrevented: mdEv.defaultPrevented,
        biOpenHold,
        toolbarBtnsInHold,
        closedOnOutsideRelease,
        maxConcurrentPreviews,
        stuckImmediate,
        stuckAfterAsync,
        openedParent,
      };
    })()`);

    assert.equal(wheelResult.mousedownPrevented, true);
    assert.equal(wheelResult.biOpenHold, true);
    assert.equal(wheelResult.toolbarBtnsInHold, 0);
    assert.equal(wheelResult.closedOnOutsideRelease, true);
    assert.ok(wheelResult.maxConcurrentPreviews <= 1);
    assert.equal(wheelResult.stuckImmediate, 0);
    assert.equal(wheelResult.stuckAfterAsync, 0);
    assert.equal(wheelResult.openedParent, true);

    // Test Tab key override: ignored in chat input, intercepted in right pane to toggle AE Tree + stack expand + preview + persistent click
    const treeResult = await cdp.evalAsync(`(async () => {
      const chatInput = document.getElementById('chat-input');
      chatInput.focus();
      const inputTabEv = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      chatInput.dispatchEvent(inputTabEv);
      await new Promise((r) => setTimeout(r, 30));
      const openedInInput = Boolean(document.querySelector('.aw-tree-panel'));

      chatInput.blur();
      document.body.focus();
      const docTabEv = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      window.dispatchEvent(docTabEv);
      await new Promise((r) => setTimeout(r, 100));

      const treeOpen = Boolean(document.querySelector('.aw-tree-panel'));
      const parentRows = document.querySelectorAll('.aw-tree-node').length;
      const childrenBeforeExpand = document.querySelectorAll('.aw-tree-row[data-current="1"] .aw-tree-child').length;
      const stackBtn = document.querySelector('.aw-tree-stack-corner');
      stackBtn?.click();
      await new Promise((r) => setTimeout(r, 30));
      const childrenAfterExpand = document.querySelectorAll('.aw-tree-row[data-current="1"] .aw-tree-child').length;

      // Hover first child for > 50ms mock preview delay to verify preview card renders, then click scope toggle to trigger renderPanel
      const firstChild = document.querySelector('.aw-tree-row[data-current="1"] .aw-tree-child');
      firstChild?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const previewShown = Boolean(document.querySelector('.aw-preview-card'));

      // Toggle scope to 仅已开 (rebuilds panel -> preview card MUST be hidden immediately!)
      document.querySelector('[data-aw-tree-scope="opened_only"]')?.click();
      const previewAfterRebuild = document.querySelectorAll('.aw-preview-card').length;
      await new Promise((r) => setTimeout(r, 60));
      const countOpenedOnly = document.querySelectorAll('.aw-tree-row[data-current="1"] .aw-tree-child').length;
      document.querySelector('[data-aw-tree-scope="opened_and_outlinks"]')?.click();
      await new Promise((r) => setTimeout(r, 60));

      // Press Tab again to toggle AE Tree OFF
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 30));
      const treeClosedOnSecondTab = !document.querySelector('.aw-tree-panel');

      return {
        inputTabPrevented: inputTabEv.defaultPrevented,
        openedInInput,
        docTabPrevented: docTabEv.defaultPrevented,
        treeOpen,
        parentRows,
        childrenBeforeExpand,
        childrenAfterExpand,
        previewShown,
        previewAfterRebuild,
        countOpenedOnly,
        treeClosedOnSecondTab,
      };
    })()`);

    assert.equal(treeResult.inputTabPrevented, false);
    assert.equal(treeResult.openedInInput, false);
    assert.equal(treeResult.docTabPrevented, true);
    assert.equal(treeResult.treeOpen, true);
    assert.equal(treeResult.parentRows, 2);
    assert.equal(treeResult.childrenBeforeExpand, 3);
    assert.ok(treeResult.childrenAfterExpand > 3);
    assert.equal(treeResult.previewShown, true);
    assert.equal(treeResult.previewAfterRebuild, 0);
    assert.equal(treeResult.countOpenedOnly, 1);
    assert.equal(treeResult.treeClosedOnSecondTab, true);

    // Test Settings & Reactive Visual Guide Modal (strict single-active card, click switch, live parameter linkage, clipPath)
    const settingsResult = await cdp.evalAsync(`(async () => {
      document.querySelector('#aw-companion-strip [data-aw-role="settings-btn"]')?.click();
      await new Promise((r) => setTimeout(r, 40));
      const guideSvgs = document.querySelectorAll('.aw-settings-modal .aw-guide-svg').length;
      const clipPathCount = document.querySelectorAll('.aw-settings-modal clipPath').length;
      const activeBefore = document.querySelectorAll('.aw-guide-card[data-card-state="active"]').length;
      const dimmedBefore = document.querySelectorAll('.aw-guide-card[data-card-state="dimmed"]').length;
      const activeKeyBefore = document.querySelector('.aw-guide-card[data-card-state="active"]')?.getAttribute('data-aw-guide-card');

      // Live parameter linkage: change parentDirection to 'right' and wheelSectors later
      const pDirSel = document.getElementById('aw-sm-pdir');
      pDirSel.value = 'right';
      pDirSel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      const liveSvgRightText = document.querySelector('[data-aw-guide-card="bilateral_wheel"] .aw-guide-svg')?.textContent || '';

      // Click second guide card (ae_tree) directly -> switches focus channel & makes ae_tree ONLY active card!
      document.querySelector('[data-aw-guide-card="ae_tree"]')?.click();
      await new Promise((r) => setTimeout(r, 20));
      const activeAfterClick = document.querySelectorAll('.aw-guide-card[data-card-state="active"]').length;
      const activeKeyAfterClick = document.querySelector('.aw-guide-card[data-card-state="active"]')?.getAttribute('data-aw-guide-card');

      // Change hotkey to Alt+Q -> live SVG keycap updates immediately!
      const hkSel = document.getElementById('aw-sm-tab-key');
      hkSel.value = 'Alt+Q';
      hkSel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      const treeSvgText = document.querySelector('[data-aw-guide-card="ae_tree"] .aw-guide-svg')?.textContent || '';

      // Restore defaults before saving
      pDirSel.value = 'left';
      pDirSel.dispatchEvent(new Event('change', { bubbles: true }));
      hkSel.value = 'Tab';
      hkSel.dispatchEvent(new Event('change', { bubbles: true }));

      document.querySelector('[data-aw-sm-tab="categories"]')?.click();
      await new Promise((r) => setTimeout(r, 30));
      const lockedOtherVisible = Boolean(document.querySelector('.aw-rule-locked'));

      // Verify adding & deleting categories updates the live SVG wheel beyond 3 custom rules AND preserves scroll
      const getCatSvgText = () => document.querySelector('#aw-sm-cat-live-preview [data-aw-mini-col="bilateral"] .aw-guide-svg')?.textContent || '';
      const catSvgBeforeAdd = getCatSvgText();
      const bodyEl = document.querySelector('.aw-settings-body');
      if (bodyEl) bodyEl.scrollTop = 40;
      const addBtn = document.querySelector('#aw-sm-add-rule');
      addBtn?.click(); // 4 custom + 其他 = 5
      addBtn?.click(); // 5 custom + 其他 = 6
      addBtn?.click(); // 6 custom + 其他 = 7
      addBtn?.click(); // 7 custom + 其他 = 8
      await new Promise((r) => setTimeout(r, 30));
      const catSvgAfterAdd = getCatSvgText();
      const ruleRowCountAfterAdd = document.querySelectorAll('.aw-rule-row[data-aw-rule-idx]').length;

      // Edit first rule's label & extension -> live SVG reflects both immediately
      const firstLabel = document.querySelector('.aw-sm-rule-label');
      const firstExt = document.querySelector('.aw-sm-rule-exts');
      if (firstLabel) { firstLabel.value = '立绘'; firstLabel.dispatchEvent(new Event('input', { bubbles: true })); }
      if (firstExt) { firstExt.value = 'psd, png'; firstExt.dispatchEvent(new Event('input', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 20));
      const catSvgAfterEdit = getCatSvgText();

      // Delete added rules back down to 3 default rules cleanly
      for (let k = 0; k < 4; k++) {
        const dels = document.querySelectorAll('.aw-sm-del-rule');
        dels[dels.length - 1]?.click();
      }
      if (firstLabel) { firstLabel.value = '图片'; firstLabel.dispatchEvent(new Event('input', { bubbles: true })); }
      if (firstExt) { firstExt.value = 'png, jpg, webp, svg'; firstExt.dispatchEvent(new Event('input', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 20));
      const catSvgAfterDel = getCatSvgText();

      // Test Markdown inline code protection (& not double-escaped, * not broken by italic regex)
      const mdRendered = window.AnchorWheelMarkdown.renderMarkdown('See \`a&b*c*.py\` and *italic*');
      const mdSafeAmp = mdRendered.includes('data-aw-link="a&amp;b*c*.py"') && !mdRendered.includes('&amp;amp;');
      const mdSafeStar = !mdRendered.includes('<em>c</em>') && mdRendered.includes('<em>italic</em>');

      document.querySelector('[data-aw-sm-tab="storage"]')?.click();
      await new Promise((r) => setTimeout(r, 30));
      const hasCompatGrid = Boolean(document.querySelector('.aw-compat-grid'));
      document.querySelector('#aw-sm-check-update')?.click();
      await new Promise((r) => setTimeout(r, 40));
      const updateBoxText = document.querySelector('#aw-sm-update-box')?.textContent || '';

      document.querySelector('#aw-sm-save')?.click();
      await new Promise((r) => setTimeout(r, 40));
      const closedAfterSave = !document.querySelector('.aw-settings-modal');
      return {
        guideSvgs,
        clipPathCount,
        activeBefore,
        dimmedBefore,
        activeKeyBefore,
        liveHasRightDir: liveSvgRightText.includes('母页在右'),
        activeAfterClick,
        activeKeyAfterClick,
        treeSvgHasAltQ: treeSvgText.includes('Alt+Q'),
        lockedOtherVisible,
        catHas4Before: catSvgBeforeAdd.includes('共 4 分类扇区'),
        ruleRowCountAfterAdd,
        catHas8After: catSvgAfterAdd.includes('共 8 分类扇区'),
        catReflectsEdit: catSvgAfterEdit.includes('立绘') && catSvgAfterEdit.includes('.psd'),
        catHas4AfterDel: catSvgAfterDel.includes('共 4 分类扇区'),
        mdSafeAmp,
        mdSafeStar,
        hasCompatGrid,
        updateBoxFoundNew: updateBoxText.includes('0.7.0'),
        closedAfterSave,
      };
    })()`);
    assert.equal(settingsResult.guideSvgs, 3);
    assert.ok(settingsResult.clipPathCount >= 1);
    assert.equal(settingsResult.activeBefore, 1);
    assert.equal(settingsResult.dimmedBefore, 2);
    assert.equal(settingsResult.activeKeyBefore, 'bilateral_wheel');
    assert.equal(settingsResult.liveHasRightDir, true);
    assert.equal(settingsResult.activeAfterClick, 1);
    assert.equal(settingsResult.activeKeyAfterClick, 'ae_tree');
    assert.equal(settingsResult.treeSvgHasAltQ, true);
    assert.equal(settingsResult.lockedOtherVisible, true);
    assert.equal(settingsResult.catHas4Before, true);
    assert.equal(settingsResult.ruleRowCountAfterAdd, 7);
    assert.equal(settingsResult.catHas8After, true);
    assert.equal(settingsResult.catReflectsEdit, true);
    assert.equal(settingsResult.catHas4AfterDel, true);
    assert.equal(settingsResult.mdSafeAmp, true);
    assert.equal(settingsResult.mdSafeStar, true);
    assert.equal(settingsResult.hasCompatGrid, true);
    assert.equal(settingsResult.updateBoxFoundNew, true);
    assert.equal(settingsResult.closedAfterSave, true);

    // Test non-overwriting inline-pill click + double-encoded Chinese URI cleanup + breadcrumb isolation
    const linkResult = await cdp.evalAsync(`(async () => {
      // Ensure breadcrumb div[data-uri] is NOT intercepted
      const crumb = document.querySelector('[data-uri]');
      const crumbEv = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      crumb.dispatchEvent(crumbEv);

      // Click actual inline-pill with double-encoded Chinese URI
      const pill = document.getElementById('test-pill');
      const pillEv = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      pill.dispatchEvent(pillEv);
      await new Promise((r) => setTimeout(r, 80));

      const cid = '11111111-2222-3333-4444-555555555555';
      const pane = root.__reactContainer$test.memoizedProps.store.getState().sidePanelV2.conversationPanes[cid];
      const childTabIdAfterClick = pane.activeTabId;
      const routerTabAfterClick = window.__routerSearch?.tab;

      // Test History Back button returns to orig MD tab, and Forward returns to child tab!
      const trayBtns = document.querySelectorAll('#aw-companion-strip .aw-tray-btn');
      const backEnabled = !trayBtns[0].disabled;
      trayBtns[0].click();
      await new Promise((r) => setTimeout(r, 80));
      const activeAfterBack = pane.activeTabId;
      const fwdEnabled = !document.querySelectorAll('#aw-companion-strip .aw-tray-btn')[1].disabled;
      document.querySelectorAll('#aw-companion-strip .aw-tray-btn')[1].click();
      await new Promise((r) => setTimeout(r, 80));
      const activeAfterFwd = pane.activeTabId;

      return {
        crumbPrevented: crumbEv.defaultPrevented,
        pillPrevented: pillEv.defaultPrevented,
        nativeOverwriteCount: window.__nativeOverwriteCount,
        dispatchedTypes: window.__dispatchedActions.map((a) => a.type),
        tabCount: pane.tabs.length,
        tabUris: pane.tabs.map((t) => t.content?.fileView?.fileUri),
        activeTabId: childTabIdAfterClick,
        routerTab: routerTabAfterClick,
        backEnabled,
        activeAfterBack,
        fwdEnabled,
        activeAfterFwd,
      };
    })()`);

    assert.equal(linkResult.crumbPrevented, false);
    assert.equal(linkResult.pillPrevented, true);
    assert.equal(linkResult.nativeOverwriteCount, 0);
    assert.ok(linkResult.dispatchedTypes.includes('sidePanelV2/promoteTab'));
    assert.ok(linkResult.dispatchedTypes.includes('sidePanelV2/setContent'));
      assert.equal(linkResult.tabCount, 3);
      assert.ok(linkResult.tabUris.some((u) => String(u).includes('%E5%89%A7%E6%9C%AC.md')));
      assert.ok(!linkResult.tabUris.some((u) => String(u).includes('%25')));
    assert.equal(linkResult.routerTab, linkResult.activeTabId);
    assert.ok(!String(linkResult.routerTab || '').includes('%25'));
    assert.equal(linkResult.backEnabled, true);
    assert.ok(linkResult.activeAfterBack.includes('02_%E5%AE%A1%E6%A0%A1%E6%8A%A5%E5%91%8A.md'));
    assert.equal(linkResult.fwdEnabled, true);
    assert.equal(linkResult.activeAfterFwd, linkResult.activeTabId);
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        browserProc.once('exit', () => { clearTimeout(timer); resolve(); });
        try { browserProc.kill(); } catch { resolve(); }
      });
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {}
  }
});

test('Mode 1 native_enhancer: directoryView in-place transition, YYc file-row non-overwriting click, hold-middle wheel on file row, and parent folder return', async (t) => {
  const exe = findBrowserExe();
  if (!exe) {
    t.skip('No headless Chromium binary available');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dir-native-test-'));
  const profileDir = path.join(tmpRoot, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const wheelCss = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'wheel_styles.css'), 'utf8');
  const navSharedJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'nav_shared.js'), 'utf8');
  const wheelJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'radial_wheel.js'), 'utf8');
  const bilateralJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'bilateral_wheel.js'), 'utf8');
  const aeTreeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'ae_tree.js'), 'utf8');
  const settingsModalJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'settings_modal.js'), 'utf8');
  const mdJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'markdown_render.js'), 'utf8');
  const nativeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'native', 'native_enhancer.js'), 'utf8');

  let browserProc = null;
  let ws = null;

  try {
    browserProc = spawn(
      exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const port = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new MiniCdp(ws);
    await cdp.send('Runtime.enable');

    const res = await cdp.evalAsync(`(async () => {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);

      const cid = '22222222-3333-4444-5555-666666666666';
      const dirUri = 'file:///c%3A/Users/demo/omni_raw';
      const dirPath = 'c:\\\\Users\\\\demo\\\\omni_raw';
      const file1Uri = 'file:///c%3A/Users/demo/omni_raw/01_shot.png';
      const file1Path = 'c:\\\\Users\\\\demo\\\\omni_raw\\\\01_shot.png';
      const file2Path = 'c:\\\\Users\\\\demo\\\\omni_raw\\\\02_shot.png';
      const file3Path = 'c:\\\\Users\\\\demo\\\\omni_raw\\\\03_notes.md';
      const subDirUri = 'file:///c%3A/Users/demo/omni_raw/nested_sub';

      window.__fileRowNativeClicks = 0;
      window.__subDirNativeClicks = 0;

      // Start as fileView with same tabId, then transition in-place to directoryView (exact real AGY flow!)
      const storeState = {
        sidePanelV2: {
          conversationPanes: {
            [cid]: {
              activeTabId: 'file__' + dirUri,
              tabs: [
                {
                  id: 'file__' + dirUri,
                  content: { type: 'fileView', fileView: { fileUri: dirUri, cascadeId: cid } },
                  isPreview: true,
                },
              ],
            },
          },
          overviewPanelOpen: {},
        },
      };
      const listeners = new Set();
      const reduxStore = {
        getState: () => storeState,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        dispatch: (action) => {
          const pane = storeState.sidePanelV2.conversationPanes[cid];
          if (action.type === 'sidePanelV2/promoteTab') {
            const tab = pane.tabs.find((t) => t.id === action.payload.tabId);
            if (tab) tab.isPreview = false;
          } else if (action.type === 'sidePanelV2/setContent') {
            const c = action.payload.content;
            const k =
              action.payload.tabId ||
              (c.type === 'directoryView' ? 'directory__' + c.directoryView.directoryUri : 'file__' + c.fileView.fileUri);
            const existing = pane.tabs.find((t) => t.id === k);
            if (existing) existing.content = c;
            else pane.tabs.push({ id: k, content: c, isPreview: false });
            if (!action.payload.background) pane.activeTabId = k;
          } else if (action.type === 'sidePanelV2/setActiveTab') {
            pane.activeTabId = action.payload.tabId;
          }
          for (const fn of listeners) fn();
        },
      };
      const browserCtx = {
        openUrlInBrowserPane: () => {},
        getTargetTreeId: () => ({ kind: 'cascadeId', cascadeId: cid }),
      };
      const mockRouter = { navigate: () => Promise.resolve(), buildLocation: () => ({}) };
      root.__reactContainer$test = {
        memoizedProps: { store: reduxStore, value: browserCtx, router: mockRouter },
        child: null,
        sibling: null,
      };

      const aux = document.createElement('div');
      aux.setAttribute('data-testid', 'aux-pane-split');
      const left = document.createElement('div');
      const right = document.createElement('div');
      right.style.cssText = 'width:480px;height:700px;';
      const col = document.createElement('div');
      col.className = 'flex flex-col browser-hole-ancestor';
      col.style.cssText = 'width:480px;height:700px;';
      const tabBar = document.createElement('div');
      tabBar.className = 'agy-layout-vars shrink-0 flex items-center';
      const tabEl = document.createElement('div');
      tabEl.className = 'agy-aux-tab';
      tabBar.appendChild(tabEl);

      const contentWrap = document.createElement('div');
      contentWrap.className = 'flex-grow basis-0 overflow-hidden';
      contentWrap.style.cssText = 'width:480px;height:620px;';

      // Realistic Antigravity YYc directory rows with React fiber keys & ancestor directoryUri prop
      const yycAncFiber = { memoizedProps: { directoryUri: dirUri, cascadeId: cid }, return: null };

      const fileRow = document.createElement('div');
      fileRow.id = 'dir-file-row';
      fileRow.style.cssText = 'height:32px;width:420px;';
      const fileLabel = document.createElement('div');
      fileLabel.textContent = '01_shot.png';
      fileRow.appendChild(fileLabel);
      fileRow.addEventListener('click', () => { window.__fileRowNativeClicks++; });
      const fileIconFiber = { memoizedProps: { uri: file1Uri, isDirectory: false }, child: null, sibling: null };
      fileRow.__reactFiber$test = {
        key: file1Uri,
        memoizedProps: { onClick: () => {}, onDoubleClick: () => {} },
        return: yycAncFiber,
        child: fileIconFiber,
      };

      const subRow = document.createElement('div');
      subRow.id = 'dir-sub-row';
      subRow.style.cssText = 'height:32px;width:420px;';
      const subLabel = document.createElement('div');
      subLabel.textContent = 'nested_sub';
      subRow.appendChild(subLabel);
      subRow.addEventListener('click', () => { window.__subDirNativeClicks++; });
      const subIconFiber = { memoizedProps: { uri: subDirUri, isDirectory: true }, child: null, sibling: null };
      subRow.__reactFiber$test = {
        key: subDirUri,
        memoizedProps: { onClick: () => {}, onDoubleClick: () => {} },
        return: yycAncFiber,
        child: subIconFiber,
      };

      contentWrap.append(fileRow, subRow);
      col.append(tabBar, contentWrap);
      right.appendChild(col);
      aux.append(left, right);
      root.appendChild(aux);

      const mockSession = {
        groups: [],
        activeGroupId: null,
        history: { entries: [], index: -1 },
        recentlyEvicted: [],
        lineage: { parentByKey: {} },
      };
      const mockSettings = {
        middleMode: 'bilateral_wheel',
        tabTriggerEnabled: true,
        tabMode: 'ae_tree',
        tabCustomHotkey: 'Tab',
        tabCloseOnSelect: false,
        childSourceScope: 'opened_and_outlinks',
        parentDirection: 'left',
        hoverPreviewEnabled: true,
        hoverPreviewDelayMs: 40,
        autoCheckUpdates: false,
      };
      const dirChildren = [
        { path: file1Path, key: file1Path.toLowerCase(), title: '01_shot.png', ext: 'png', isDirectory: false, isOpenedTab: false, categoryId: 'image', categoryLabel: '图片' },
        { path: file2Path, key: file2Path.toLowerCase(), title: '02_shot.png', ext: 'png', isDirectory: false, isOpenedTab: false, categoryId: 'image', categoryLabel: '图片' },
        { path: file3Path, key: file3Path.toLowerCase(), title: '03_notes.md', ext: 'md', isDirectory: false, isOpenedTab: false, categoryId: 'doc', categoryLabel: '文档' },
      ];

      window.__agAnchorWheelCall = (raw) => {
        const req = JSON.parse(raw);
        setTimeout(() => {
          let res = { ok: true, session: mockSession };
          if (req.action === 'getBoot') {
            res = { ok: true, version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, session: mockSession };
          } else if (req.action === 'getBacklinks') {
            res = { ok: true, path: req.path, title: 'omni_raw', backlinks: [], outlinks: [] };
          } else if (req.action === 'getNavContext') {
            const p = String(req.path || '');
            const isDir = Boolean(req.isDirectory) || p.toLowerCase() === dirPath.toLowerCase();
            if (isDir) {
              res = {
                ok: true,
                activePath: dirPath,
                childSourceScope: req.scope || 'opened_and_outlinks',
                parentDirection: 'left',
                current: {
                  path: dirPath,
                  key: dirPath.toLowerCase(),
                  title: 'omni_raw',
                  isDirectory: true,
                  dirMeta: { totalFiles: 3, skippedSubdirCount: 1, truncated: false, maxFiles: 200 },
                  children: dirChildren,
                },
                ancestors: [],
                parent: null,
                categories: [
                  { id: 'image', label: '图片', items: dirChildren.filter((x) => x.categoryId === 'image') },
                  { id: 'video', label: '视频', items: [] },
                  { id: 'doc', label: '文档', items: dirChildren.filter((x) => x.categoryId === 'doc') },
                  { id: 'other', label: '其他', items: [] },
                ],
                totalCurrentChildren: 3,
              };
            } else {
              const lin = mockSession.lineage.parentByKey[p.toLowerCase()];
              const parentObj = lin
                ? {
                    path: lin.parentPath,
                    key: lin.parentKey,
                    title: lin.parentTitle,
                    isDirectory: Boolean(lin.parentIsDirectory),
                    siblings: dirChildren.filter((x) => x.path.toLowerCase() !== p.toLowerCase()),
                  }
                : null;
              res = {
                ok: true,
                activePath: p,
                childSourceScope: req.scope || 'opened_and_outlinks',
                parentDirection: 'left',
                current: { path: p, key: p.toLowerCase(), title: p.split('\\\\').pop(), isDirectory: false, children: [] },
                ancestors: parentObj ? [parentObj] : [],
                parent: parentObj,
                categories: [
                  { id: 'image', label: '图片', items: [] },
                  { id: 'video', label: '视频', items: [] },
                  { id: 'doc', label: '文档', items: [] },
                  { id: 'other', label: '其他', items: [] },
                ],
                totalCurrentChildren: 0,
              };
            }
          } else if (req.action === 'getPreview') {
            res = { ok: true, kind: 'directory', path: req.path, title: 'omni_raw', itemCount: 3, subdirCount: 1, entries: [{ name: '01_shot.png', isDirectory: false }] };
          } else if (req.action === 'sessionOp') {
            if (req.op === 'recordLineage') {
              const cKey = String(req.childPath || '').toLowerCase();
              mockSession.lineage.parentByKey[cKey] = {
                parentPath: req.parentPath,
                parentKey: String(req.parentPath || '').toLowerCase(),
                parentTitle: req.parentTitle || 'omni_raw',
                parentIsDirectory: Boolean(req.parentIsDirectory),
                childPath: req.childPath,
                childKey: cKey,
                childTitle: req.childTitle || '',
                childIsDirectory: Boolean(req.childIsDirectory),
              };
            }
            res = { ok: true, session: mockSession, evicted: [] };
          }
          window.__agAnchorWheelResolve?.(req.id, res);
        }, 5);
      };

      window.__agAnchorWheelBoot = { version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, wheelCss: ${JSON.stringify(wheelCss)} };
      eval(${JSON.stringify(navSharedJs)});
      eval(${JSON.stringify(wheelJs)});
      eval(${JSON.stringify(bilateralJs)});
      eval(${JSON.stringify(aeTreeJs)});
      eval(${JSON.stringify(settingsModalJs)});
      eval(${JSON.stringify(mdJs)});
      eval(${JSON.stringify(nativeJs)});
      await new Promise((r) => setTimeout(r, 140));

      // 1. Trigger Antigravity's in-place fileView -> directoryView conversion on the SAME tabId!
      reduxStore.dispatch({
        type: 'sidePanelV2/setContent',
        payload: {
          tabId: 'file__' + dirUri,
          content: { type: 'directoryView', directoryView: { directoryUri: dirUri, cascadeId: cid } },
        },
      });
      await new Promise((r) => setTimeout(r, 180));

      const dirDebug = window.__agAnchorWheel.getDebugState();
      const stripLinksText = document.querySelector('#aw-companion-strip [data-aw-role="links-btn"]')?.textContent || '';
      const hasPinBtnForDir = Array.from(document.querySelectorAll('#aw-companion-strip .aw-status-pill')).some((el) => el.textContent === '设为母页');

      // 2. Hold middle mouse button directly ON TOP OF a file row -> Bilateral Wheel opens with '当前文件夹' hub!
      fileLabel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1, clientX: 240, clientY: 160 }));
      fileLabel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 240, clientY: 160 }));
      await new Promise((r) => setTimeout(r, 150));
      const biOpenOnFileRow = Boolean(document.querySelector('.aw-bi-stage'));
      const biHubTag = document.querySelector('.aw-wheel-hub-tag')?.textContent || '';
      const biNonEmptyCats = document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])').length;
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, clientX: 10, clientY: 10 }));
      await new Promise((r) => setTimeout(r, 40));

      // 3. Left-click subfolder row -> NOT blocked, native click runs!
      subLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 40));

      // 4. Left-click file row -> intercepted, preserves parent folder tab, opens new tab, records folder parent lineage!
      const fileClickEv = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      fileLabel.dispatchEvent(fileClickEv);
      await new Promise((r) => setTimeout(r, 180));

      const pane = storeState.sidePanelV2.conversationPanes[cid];
      const folderTabAfterClick = pane.tabs.find((t) => t.content?.type === 'directoryView');
      const childTabAfterClick = pane.tabs.find((t) => t.id === pane.activeTabId);

      // 5. On child file, press Tab -> AE Tree shows '母文件夹' + sibling files!
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 120));
      const treeParentRole = document.querySelector('.aw-tree-row:not([data-current="1"]) .aw-tree-role')?.textContent || '';
      const treeSiblings = document.querySelectorAll('.aw-tree-row:not([data-current="1"]) .aw-tree-child').length;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      // 6. Close original folder tab so return MUST re-open directoryView cleanly via left wheel arc!
      pane.tabs = pane.tabs.filter((t) => t.content?.type !== 'directoryView');
      contentWrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 260, clientY: 260 }));
      await new Promise((r) => setTimeout(r, 150));
      const parentMetaText = document.querySelector('.aw-wheel-node-meta')?.textContent || '';
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 170, clientY: 260 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, clientX: 170, clientY: 260 }));
      await new Promise((r) => setTimeout(r, 160));

      const reopenedActiveTab = pane.tabs.find((t) => t.id === pane.activeTabId);

      return {
        dirDebug,
        stripLinksText,
        hasPinBtnForDir,
        biOpenOnFileRow,
        biHubTag,
        biNonEmptyCats,
        subDirNativeClicks: window.__subDirNativeClicks,
        fileRowNativeClicks: window.__fileRowNativeClicks,
        fileClickPrevented: fileClickEv.defaultPrevented,
        folderPreservedAndPromoted: Boolean(folderTabAfterClick && folderTabAfterClick.isPreview === false),
        childOpenedAsFile: childTabAfterClick?.content?.type === 'fileView',
        treeParentRole,
        treeSiblings,
        parentMetaText,
        reopenedAsDirectoryView: reopenedActiveTab?.content?.type === 'directoryView',
        reopenedDirUri: reopenedActiveTab?.content?.directoryView?.directoryUri || '',
      };
    })()`);

    assert.deepEqual(cdp.errors, []);
    assert.equal(res.dirDebug.activeIsDirectory, true);
    assert.equal(res.dirDebug.dirChildCount, 3);
    assert.ok(res.stripLinksText.includes('3 文件'));
    assert.equal(res.hasPinBtnForDir, true);
    assert.equal(res.biOpenOnFileRow, true);
    assert.equal(res.biHubTag, '当前文件夹');
    assert.equal(res.biNonEmptyCats, 2);
    assert.equal(res.subDirNativeClicks, 1);
    assert.equal(res.fileRowNativeClicks, 0);
    assert.equal(res.fileClickPrevented, true);
    assert.equal(res.folderPreservedAndPromoted, true);
    assert.equal(res.childOpenedAsFile, true);
    assert.equal(res.treeParentRole, '母文件夹');
    assert.equal(res.treeSiblings, 2);
    assert.equal(res.parentMetaText, '母文件夹');
    assert.equal(res.reopenedAsDirectoryView, true);
    assert.ok(res.reopenedDirUri.endsWith('/omni_raw'));
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        browserProc.once('exit', () => { clearTimeout(timer); resolve(); });
        try { browserProc.kill(); } catch { resolve(); }
      });
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {}
  }
});

test('Mode 1 native_enhancer: auto-renders DOCX overlay over dead native preview, supports outline/find/paper/wheel, and optional CSV table toggle', async (t) => {
  const exe = findBrowserExe();
  if (!exe) {
    t.skip('No headless Chromium binary available');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-native-doc-test-'));
  const profileDir = path.join(tmpRoot, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const wheelCss = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'wheel_styles.css'), 'utf8');
  const navSharedJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'nav_shared.js'), 'utf8');
  const wheelJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'radial_wheel.js'), 'utf8');
  const bilateralJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'bilateral_wheel.js'), 'utf8');
  const aeTreeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'ae_tree.js'), 'utf8');
  const settingsModalJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'settings_modal.js'), 'utf8');
  const mdJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'markdown_render.js'), 'utf8');
  const docViewerJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'doc_viewer.js'), 'utf8');
  const nativeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'native', 'native_enhancer.js'), 'utf8');

  let browserProc = null;
  let ws = null;

  try {
    browserProc = spawn(
      exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const port = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new MiniCdp(ws);
    await cdp.send('Runtime.enable');

    const res = await cdp.evalAsync(`(async () => {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);

      const cid = '33333333-4444-5555-6666-777777777777';
      const docxUri = 'file:///c%3A/Users/demo/%E8%B0%83%E6%9F%A5%E9%97%AE%E5%8D%B7.docx';
      const csvUri = 'file:///c%3A/Users/demo/metrics.csv';
      const mdUri = 'file:///c%3A/Users/demo/readme.md';

      const storeState = {
        sidePanelV2: {
          conversationPanes: {
            [cid]: {
              activeTabId: 'file__' + docxUri,
              tabs: [
                { id: 'file__' + docxUri, content: { type: 'fileView', fileView: { fileUri: docxUri, cascadeId: cid } } },
                { id: 'file__' + csvUri, content: { type: 'fileView', fileView: { fileUri: csvUri, cascadeId: cid } } },
                { id: 'file__' + mdUri, content: { type: 'fileView', fileView: { fileUri: mdUri, cascadeId: cid } } },
              ],
            },
          },
          overviewPanelOpen: {},
        },
      };
      const listeners = new Set();
      const reduxStore = {
        getState: () => storeState,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        dispatch: (action) => {
          const pane = storeState.sidePanelV2.conversationPanes[cid];
          if (action.type === 'sidePanelV2/setActiveTab') {
            pane.activeTabId = action.payload.tabId;
          }
          for (const fn of listeners) fn();
        },
      };
      const browserCtx = { openUrlInBrowserPane: () => {}, getTargetTreeId: () => ({ kind: 'cascadeId', cascadeId: cid }) };
      const mockRouter = { navigate: () => Promise.resolve(), buildLocation: () => ({}) };
      root.__reactContainer$test = { memoizedProps: { store: reduxStore, value: browserCtx, router: mockRouter }, child: null, sibling: null };

      const aux = document.createElement('div');
      aux.setAttribute('data-testid', 'aux-pane-split');
      const left = document.createElement('div');
      const right = document.createElement('div');
      right.style.cssText = 'width:520px;height:740px;';
      const col = document.createElement('div');
      col.className = 'flex flex-col browser-hole-ancestor';
      col.style.cssText = 'width:520px;height:740px;display:flex;flex-direction:column;';

      const tabBar = document.createElement('div');
      tabBar.className = 'agy-layout-vars';
      const tabEl = document.createElement('div');
      tabEl.className = 'agy-aux-tab';
      tabEl.__reactFiber$test = { memoizedProps: { tab: storeState.sidePanelV2.conversationPanes[cid].tabs[0] } };
      tabBar.appendChild(tabEl);

      const contentWrap = document.createElement('div');
      contentWrap.className = 'flex-grow basis-0 overflow-hidden';
      contentWrap.style.cssText = 'flex:1;height:660px;overflow:hidden;display:flex;flex-direction:column;';
      const deadPlaceholder = document.createElement('div');
      deadPlaceholder.id = 'native-dead-preview';
      deadPlaceholder.textContent = 'Preview is not available for this file type.';
      contentWrap.appendChild(deadPlaceholder);

      col.append(tabBar, contentWrap);
      right.appendChild(col);
      aux.append(left, right);
      root.appendChild(aux);

      let inspectEncodingCalledForDocx = false;
      let externalOpenedPath = '';
      let mockSettings = {
        middleMode: 'bilateral_wheel',
        tabTriggerEnabled: true,
        tabMode: 'ae_tree',
        tabCustomHotkey: 'Tab',
        richDocPreviewEnabled: true,
        richDocPaperMode: false,
        autoCheckUpdates: false,
      };
      const mockSession = { groups: [], activeGroupId: null, history: { entries: [], index: -1 }, recentlyEvicted: [], lineage: { parentByKey: {} } };

      window.__agAnchorWheelCall = (raw) => {
        const req = JSON.parse(raw);
        let res = { ok: true, session: mockSession };
        if (req.action === 'getBoot') {
          res = { ok: true, version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, session: mockSession };
        } else if (req.action === 'inspectEncoding') {
          if (String(req.path || '').endsWith('.docx')) inspectEncodingCalledForDocx = true;
          res = { ok: true, encoding: 'utf-8', isNonUtf8: false, mojibakeHint: false };
        } else if (req.action === 'getBacklinks') {
          res = { ok: true, path: req.path, title: 'doc', backlinks: [], outlinks: [] };
        } else if (req.action === 'getNavContext') {
          res = {
            ok: true,
            activePath: req.path,
            childSourceScope: 'opened_and_outlinks',
            parentDirection: 'left',
            current: { path: req.path, key: String(req.path).toLowerCase(), title: '调查问卷.docx', children: [] },
            ancestors: [{ path: 'C:\\\\Users\\\\demo\\\\readme.md', key: 'c:\\\\users\\\\demo\\\\readme.md', title: 'readme.md', siblings: [] }],
            parent: { path: 'C:\\\\Users\\\\demo\\\\readme.md', title: 'readme.md' },
            categories: [{ id: 'doc', label: '文档', items: [] }, { id: 'other', label: '其他', items: [] }],
            totalCurrentChildren: 0,
          };
        } else if (req.action === 'renderDocument') {
          if (String(req.path || '').endsWith('.csv')) {
            res = {
              ok: true,
              format: 'csv',
              formatLabel: 'CSV 数据表',
              badge: 'CSV',
              path: req.path,
              title: 'metrics.csv',
              autoRender: false,
              supportsPaperMode: false,
              meta: { statsLabel: '2 条记录 · 2 列' },
              outline: [],
              bodyHtml: '<div class="aw-sheet-wrap"><table class="aw-sheet-table"><tbody><tr data-aw-row="1"><td>1</td><td>指标A</td></tr></tbody></table></div>',
              plainText: '指标A',
              warnings: [],
            };
          } else {
            res = {
              ok: true,
              format: 'docx',
              formatLabel: 'Word 文档',
              badge: 'DOCX',
              path: req.path,
              title: '短视频调查问卷',
              autoRender: true,
              supportsPaperMode: true,
              meta: { statsLabel: '约 1,200 字 · 2 表格' },
              outline: [
                { id: 'aw-h-1', level: 1, title: '问卷说明' },
                { id: 'aw-h-2', level: 2, title: '基础信息' },
              ],
              bodyHtml: '<h1 id="aw-h-1" class="aw-doc-h aw-doc-h1">问卷说明</h1><p id="docx-p1" class="aw-doc-p">这是调查问卷的核心正文，包含关键词：碎片化观看。</p><h2 id="aw-h-2" class="aw-doc-h aw-doc-h2">基础信息</h2>',
              plainText: '问卷说明\\n这是调查问卷的核心正文，包含关键词：碎片化观看。',
              warnings: [],
            };
          }
        } else if (req.action === 'openExternal') {
          externalOpenedPath = req.path;
          res = { ok: true, path: req.path };
        } else if (req.action === 'updateSettings') {
          mockSettings = { ...mockSettings, ...(req.settings || {}) };
          res = { ok: true, settings: mockSettings };
        }
        setTimeout(() => window.__agAnchorWheelResolve?.(req.id, res), 0);
      };

      window.__agAnchorWheelBoot = { version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, wheelCss: ${JSON.stringify(wheelCss)} };
      eval(${JSON.stringify(navSharedJs)});
      eval(${JSON.stringify(wheelJs)});
      eval(${JSON.stringify(bilateralJs)});
      eval(${JSON.stringify(aeTreeJs)});
      eval(${JSON.stringify(settingsModalJs)});
      eval(${JSON.stringify(mdJs)});
      eval(${JSON.stringify(docViewerJs)});
      eval(${JSON.stringify(nativeJs)});

      // Wait for auto-render of DOCX overlay
      const deadline = Date.now() + 900;
      while (Date.now() < deadline) {
        if (document.querySelector('#aw-native-doc-overlay .aw-doc-viewer')) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const autoMounted = Boolean(document.querySelector('#aw-native-doc-overlay .aw-doc-viewer'));
      const deadHidden = deadPlaceholder.style.display === 'none';
      const dbgDocx = window.__agAnchorWheel.getDebugState();

      // 1. Toggle Outline drawer
      document.querySelector('[data-aw-doc-act="outline"]')?.click();
      const outlineVisible = !document.querySelector('.aw-doc-outline')?.hidden;
      const outlineItems = document.querySelectorAll('.aw-doc-outline-item').length;

      // 2. Open Find bar and search "碎片化"
      document.querySelector('[data-aw-doc-act="find"]')?.click();
      const findInput = document.querySelector('.aw-doc-find-input');
      findInput.value = '碎片化';
      findInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 160));
      const findHitsCount = document.querySelectorAll('mark.aw-doc-hit').length;

      // 3. Toggle Paper mode
      document.querySelector('[data-aw-doc-act="paper"]')?.click();
      const paperAttrAfterToggle = document.querySelector('.aw-doc-viewer')?.getAttribute('data-aw-paper');

      // 4. Click external open button
      document.querySelector('[data-aw-doc-act="external"]')?.click();
      await new Promise((r) => setTimeout(r, 40));

      // 5. Hold Middle Mouse inside DOCX reading paragraph -> Bilateral Wheel still works!
      const p1 = document.getElementById('docx-p1');
      p1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 260, clientY: 280 }));
      await new Promise((r) => setTimeout(r, 150));
      const wheelOpenedInsideDocx = Boolean(document.querySelector('.aw-bi-stage'));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 1, clientX: 10, clientY: 10 }));
      await new Promise((r) => setTimeout(r, 40));

      // 6. Click 原生视图 -> restores native placeholder & shows DOCX 预览 pill on strip
      document.querySelector('[data-aw-doc-act="raw"]')?.click();
      await new Promise((r) => setTimeout(r, 30));
      const overlayRemovedOnRaw = !document.getElementById('aw-native-doc-overlay');
      const deadRestoredOnRaw = deadPlaceholder.style.display !== 'none';
      const reopenBtnText = document.querySelector('#aw-companion-strip [data-aw-role="doc-preview-btn"]')?.textContent || '';

      // 7. Click DOCX 预览 pill to reopen
      document.querySelector('#aw-companion-strip [data-aw-role="doc-preview-btn"]')?.click();
      await new Promise((r) => setTimeout(r, 60));
      const reopenedOverlay = Boolean(document.querySelector('#aw-native-doc-overlay .aw-doc-viewer'));

      // 8. Switch to CSV tab -> does NOT auto-hijack native view, offers 表格预览 pill instead!
      reduxStore.dispatch({ type: 'sidePanelV2/setActiveTab', payload: { tabId: 'file__' + csvUri } });
      await new Promise((r) => setTimeout(r, 160));
      const csvAutoHijacked = Boolean(document.getElementById('aw-native-doc-overlay'));
      const csvPillText = document.querySelector('#aw-companion-strip [data-aw-role="doc-preview-btn"]')?.textContent || '';
      document.querySelector('#aw-companion-strip [data-aw-role="doc-preview-btn"]')?.click();
      await new Promise((r) => setTimeout(r, 80));
      const csvOpenedOnClick = Boolean(document.querySelector('#aw-native-doc-overlay .aw-sheet-table'));

      // 9. Switch to MD tab -> clean full teardown
      reduxStore.dispatch({ type: 'sidePanelV2/setActiveTab', payload: { tabId: 'file__' + mdUri } });
      await new Promise((r) => setTimeout(r, 160));
      const cleanedOnMd = !document.getElementById('aw-native-doc-overlay') && deadPlaceholder.style.display !== 'none';

      return {
        autoMounted,
        deadHidden,
        inspectEncodingCalledForDocx,
        dbgDocx,
        outlineVisible,
        outlineItems,
        findHitsCount,
        paperAttrAfterToggle,
        externalOpenedPath,
        wheelOpenedInsideDocx,
        overlayRemovedOnRaw,
        deadRestoredOnRaw,
        reopenBtnText,
        reopenedOverlay,
        csvAutoHijacked,
        csvPillText,
        csvOpenedOnClick,
        cleanedOnMd,
      };
    })()`);

    assert.deepEqual(cdp.errors, []);
    assert.equal(res.autoMounted, true);
    assert.equal(res.deadHidden, true);
    assert.equal(res.inspectEncodingCalledForDocx, false);
    assert.equal(res.dbgDocx.docOverlayVisible, true);
    assert.equal(res.dbgDocx.activeDocFormat, 'docx');
    assert.equal(res.outlineVisible, true);
    assert.equal(res.outlineItems, 2);
    assert.equal(res.findHitsCount, 1);
    assert.equal(res.paperAttrAfterToggle, '1');
    assert.ok(res.externalOpenedPath.endsWith('调查问卷.docx'));
    assert.equal(res.wheelOpenedInsideDocx, true);
    assert.equal(res.overlayRemovedOnRaw, true);
    assert.equal(res.deadRestoredOnRaw, true);
    assert.equal(res.reopenBtnText, 'DOCX 预览');
    assert.equal(res.reopenedOverlay, true);
    assert.equal(res.csvAutoHijacked, false);
    assert.equal(res.csvPillText, '表格预览');
    assert.equal(res.csvOpenedOnClick, true);
    assert.equal(res.cleanedOnMd, true);
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        browserProc.once('exit', () => { clearTimeout(timer); resolve(); });
        try { browserProc.kill(); } catch { resolve(); }
      });
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {}
  }
});

test('Mode 1 native_enhancer: directoryView overflow menu injects explorer open item (ZH & EN, no dup), strip 1-click reveal, and tree/row/breadcrumb context menu', async (t) => {
  const exe = findBrowserExe();
  if (!exe) {
    t.skip('No headless Chromium binary available');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-native-explorer-test-'));
  const profileDir = path.join(tmpRoot, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const wheelCss = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'wheel_styles.css'), 'utf8');
  const navSharedJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'nav_shared.js'), 'utf8');
  const wheelJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'radial_wheel.js'), 'utf8');
  const bilateralJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'bilateral_wheel.js'), 'utf8');
  const aeTreeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'ae_tree.js'), 'utf8');
  const settingsModalJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'settings_modal.js'), 'utf8');
  const mdJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'markdown_render.js'), 'utf8');
  const docViewerJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'shared', 'doc_viewer.js'), 'utf8');
  const nativeJs = fs.readFileSync(path.join(ROOT, 'sidecars', 'anchor_wheel', 'native', 'native_enhancer.js'), 'utf8');

  let browserProc = null;
  let ws = null;

  try {
    browserProc = spawn(
      exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const port = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new MiniCdp(ws);
    await cdp.send('Runtime.enable');

    const res = await cdp.evalAsync(`(async () => {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);

      const cid = '44444444-5555-6666-7777-888888888888';
      const parentUri = 'file:///c%3A/Users/demo/agy-anchor-wheel';
      const distUri = 'file:///c%3A/Users/demo/agy-anchor-wheel/dist';
      const zipUri = 'file:///c%3A/Users/demo/agy-anchor-wheel/dist/agy-anchor-wheel-v0.8.0.zip';
      const treeDirUri = 'file:///c%3A/Users/demo/agy-anchor-wheel/scripts';

      const storeState = {
        sidePanelV2: {
          conversationPanes: {
            [cid]: {
              activeTabId: 'directory__' + distUri,
              tabs: [
                {
                  id: 'directory__' + distUri,
                  content: { type: 'directoryView', directoryView: { directoryUri: distUri, cascadeId: cid } },
                  isPreview: false,
                },
              ],
            },
          },
          overviewPanelOpen: {},
        },
      };
      const listeners = new Set();
      const reduxStore = {
        getState: () => storeState,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        dispatch: (action) => {
          const pane = storeState.sidePanelV2.conversationPanes[cid];
          if (action.type === 'sidePanelV2/setContent') {
            const c = action.payload.content;
            const k = c.type === 'directoryView' ? 'directory__' + c.directoryView.directoryUri : 'file__' + c.fileView.fileUri;
            if (!pane.tabs.some((t) => t.id === k)) pane.tabs.push({ id: k, content: c, isPreview: false });
            if (!action.payload.background) pane.activeTabId = k;
          } else if (action.type === 'sidePanelV2/setActiveTab') {
            pane.activeTabId = action.payload.tabId;
          }
          for (const fn of listeners) fn();
        },
      };
      const browserCtx = { openUrlInBrowserPane: () => {}, getTargetTreeId: () => ({ kind: 'cascadeId', cascadeId: cid }) };
      const mockRouter = { navigate: () => Promise.resolve(), buildLocation: () => ({}) };
      root.__reactContainer$test = { memoizedProps: { store: reduxStore, value: browserCtx, router: mockRouter }, child: null, sibling: null };

      const aux = document.createElement('div');
      aux.setAttribute('data-testid', 'aux-pane-split');
      const left = document.createElement('div');
      const right = document.createElement('div');
      right.style.cssText = 'width:620px;height:740px;';
      const col = document.createElement('div');
      col.className = 'flex flex-col browser-hole-ancestor';
      col.style.cssText = 'width:620px;height:740px;';
      const tabBar = document.createElement('div');
      tabBar.className = 'agy-layout-vars';
      const tabEl = document.createElement('div');
      tabEl.className = 'agy-aux-tab';
      tabBar.appendChild(tabEl);

      const contentWrap = document.createElement('div');
      contentWrap.className = 'flex-grow basis-0 overflow-hidden';
      contentWrap.style.cssText = 'width:620px;height:660px;position:relative;';

      // Header bar with breadcrumbs + native more-actions-overflow button
      const headerBar = document.createElement('div');
      headerBar.className = 'flex items-center justify-between group/file-row';
      const bcParent = document.createElement('div');
      bcParent.id = 'bc-parent';
      bcParent.setAttribute('data-uri', parentUri);
      bcParent.textContent = 'agy-anchor-wheel';
      const bcDist = document.createElement('div');
      bcDist.id = 'bc-dist';
      bcDist.setAttribute('data-uri', distUri);
      bcDist.textContent = 'dist';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.setAttribute('data-testid', 'more-actions-overflow');
      moreBtn.setAttribute('aria-haspopup', 'menu');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.style.cssText = 'width:28px;height:28px;';
      headerBar.append(bcParent, bcDist, moreBtn);

      // Directory file row (YYc mock)
      const yycAncFiber = { memoizedProps: { directoryUri: distUri, cascadeId: cid }, return: null };
      const zipRow = document.createElement('div');
      zipRow.id = 'zip-row';
      zipRow.style.cssText = 'height:30px;width:400px;';
      zipRow.textContent = 'agy-anchor-wheel-v0.8.0.zip';
      zipRow.__reactFiber$test = {
        key: zipUri,
        memoizedProps: { onClick: () => {}, onDoubleClick: () => {} },
        return: yycAncFiber,
        child: { memoizedProps: { uri: zipUri, isDirectory: false }, child: null, sibling: null },
      };

      // Workspace sidebar file tree mock (tab-file-tree-sidebar)
      const treeSidebar = document.createElement('div');
      treeSidebar.setAttribute('data-testid', 'tab-file-tree-sidebar');
      const treeItem = document.createElement('div');
      treeItem.id = 'tree-scripts-dir';
      treeItem.setAttribute('role', 'treeitem');
      treeItem.textContent = 'scripts';
      treeItem.__reactFiber$test = {
        memoizedProps: {},
        return: {
          memoizedProps: {
            entry: { uri: treeDirUri, fileType: 2 },
          },
          return: null,
        },
      };
      treeSidebar.appendChild(treeItem);

      contentWrap.append(headerBar, zipRow, treeSidebar);
      col.append(tabBar, contentWrap);
      right.appendChild(col);
      aux.append(left, right);
      root.appendChild(aux);

      const revealCalls = [];
      const mockSession = { groups: [], activeGroupId: null, history: { entries: [], index: -1 }, recentlyEvicted: [], lineage: { parentByKey: {} } };
      const mockSettings = { middleMode: 'bilateral_wheel', tabTriggerEnabled: true, autoCheckUpdates: false };

      window.__agAnchorWheelCall = (raw) => {
        const req = JSON.parse(raw);
        let res = { ok: true, session: mockSession };
        if (req.action === 'getBoot') {
          res = { ok: true, version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, session: mockSession };
        } else if (req.action === 'getBacklinks') {
          res = { ok: true, path: req.path, title: 'dist', backlinks: [], outlinks: [] };
        } else if (req.action === 'getNavContext') {
          res = {
            ok: true,
            activePath: req.path,
            childSourceScope: 'opened_and_outlinks',
            parentDirection: 'left',
            current: { path: req.path, key: String(req.path).toLowerCase(), title: 'dist', isDirectory: true, children: [] },
            ancestors: [],
            parent: null,
            categories: [{ id: 'other', label: '其他', items: [] }],
            totalCurrentChildren: 0,
          };
        } else if (req.action === 'revealInExplorer') {
          revealCalls.push({ path: req.path, preferDirectory: Boolean(req.preferDirectory) });
          res = { ok: true, mode: req.preferDirectory ? 'open-dir' : 'open-dir', targetPath: req.path, isDirectory: true };
        }
        setTimeout(() => window.__agAnchorWheelResolve?.(req.id, res), 0);
      };

      window.__agAnchorWheelBoot = { version: ${JSON.stringify(PLUGIN_VERSION)}, settings: mockSettings, wheelCss: ${JSON.stringify(wheelCss)} };
      eval(${JSON.stringify(navSharedJs)});
      eval(${JSON.stringify(wheelJs)});
      eval(${JSON.stringify(bilateralJs)});
      eval(${JSON.stringify(aeTreeJs)});
      eval(${JSON.stringify(settingsModalJs)});
      eval(${JSON.stringify(mdJs)});
      eval(${JSON.stringify(docViewerJs)});
      eval(${JSON.stringify(nativeJs)});
      await new Promise((r) => setTimeout(r, 150));

      // 1. Companion Strip 1-click button renders for directoryView and calls revealInExplorer
      const stripRevealBtn = document.querySelector('#aw-companion-strip [data-aw-role="reveal-btn"]');
      const stripRevealText = stripRevealBtn?.textContent || '';
      stripRevealBtn?.click();
      await new Promise((r) => setTimeout(r, 40));

      // 2. Open native overflow menu containing ONLY '复制路径' -> AnchorWheel injects Chinese Explorer item!
      const menuZh = document.createElement('div');
      menuZh.id = 'native-overflow-zh';
      menuZh.setAttribute('role', 'menu');
      const copyItemZh = document.createElement('div');
      copyItemZh.setAttribute('role', 'menuitem');
      copyItemZh.textContent = '复制路径';
      menuZh.appendChild(copyItemZh);
      let escDismissed = false;
      menuZh.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          escDismissed = true;
          moreBtn.setAttribute('aria-expanded', 'false');
          moreBtn.removeAttribute('aria-controls');
          menuZh.remove();
        }
      });
      moreBtn.setAttribute('aria-expanded', 'true');
      moreBtn.setAttribute('aria-controls', 'native-overflow-zh');
      document.body.appendChild(menuZh);
      moreBtn.click();
      await new Promise((r) => setTimeout(r, 80));

      const injectedZh = menuZh.querySelector('[data-aw-role="reveal-menu-item"]');
      const injectedZhText = injectedZh?.textContent || '';
      injectedZh?.click();
      await new Promise((r) => setTimeout(r, 50));

      // 3. Open native overflow menu in English ('Copy Path' only) -> adapts to English!
      const menuEn = document.createElement('div');
      menuEn.id = 'native-overflow-en';
      menuEn.setAttribute('role', 'menu');
      const copyItemEn = document.createElement('div');
      copyItemEn.setAttribute('role', 'menuitem');
      copyItemEn.textContent = 'Copy Path';
      menuEn.appendChild(copyItemEn);
      moreBtn.setAttribute('aria-expanded', 'true');
      moreBtn.setAttribute('aria-controls', 'native-overflow-en');
      document.body.appendChild(menuEn);
      moreBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const injectedEnText = menuEn.querySelector('[data-aw-role="reveal-menu-item"]')?.textContent || '';
      menuEn.remove();
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.removeAttribute('aria-controls');

      // 4. Open native overflow menu that ALREADY has 'Show in File Explorer' -> zero duplicates!
      const menuHasNative = document.createElement('div');
      menuHasNative.id = 'native-overflow-file';
      menuHasNative.setAttribute('role', 'menu');
      const copyItem3 = document.createElement('div');
      copyItem3.setAttribute('role', 'menuitem');
      copyItem3.textContent = 'Copy Path';
      const nativeExplorerItem = document.createElement('div');
      nativeExplorerItem.setAttribute('role', 'menuitem');
      nativeExplorerItem.textContent = 'Show in File Explorer';
      menuHasNative.append(copyItem3, nativeExplorerItem);
      moreBtn.setAttribute('aria-expanded', 'true');
      moreBtn.setAttribute('aria-controls', 'native-overflow-file');
      document.body.appendChild(menuHasNative);
      moreBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const dupCount = menuHasNative.querySelectorAll('[data-aw-role="reveal-menu-item"]').length;
      menuHasNative.remove();
      moreBtn.setAttribute('aria-expanded', 'false');

      // 5. Right-click workspace sidebar tree directory item -> context menu opens & reveals tree folder!
      treeItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 220 }));
      await new Promise((r) => setTimeout(r, 30));
      const treeMenuOpen = Boolean(document.querySelector('[data-aw-role="explorer-ctx-menu"]'));
      const treeHasParentAct = Boolean(document.querySelector('[data-aw-ctx-act="open-parent"]'));
      document.querySelector('[data-aw-ctx-act="reveal"]')?.click();
      await new Promise((r) => setTimeout(r, 40));

      // 6. Right-click file row in directoryView -> offers BOTH 'reveal' and 'open-parent'
      zipRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 260 }));
      await new Promise((r) => setTimeout(r, 30));
      const fileHasParentAct = Boolean(document.querySelector('[data-aw-ctx-act="open-parent"]'));
      document.querySelector('[data-aw-ctx-act="open-parent"]')?.click();
      await new Promise((r) => setTimeout(r, 40));

      // 7. Right-click parent breadcrumb -> opens context menu and Escape dismisses cleanly
      bcParent.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
      await new Promise((r) => setTimeout(r, 30));
      const bcMenuTitle = document.querySelector('.aw-ctx-header-name')?.textContent || '';
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
      const closedOnEsc = !document.querySelector('[data-aw-role="explorer-ctx-menu"]');

      return {
        stripRevealText,
        injectedZhText,
        escDismissed,
        injectedEnText,
        dupCount,
        treeMenuOpen,
        treeHasParentAct,
        fileHasParentAct,
        bcMenuTitle,
        closedOnEsc,
        revealCalls,
      };
    })()`);

    assert.deepEqual(cdp.errors, []);
    assert.equal(res.stripRevealText, '打开目录');
    assert.match(res.injectedZhText, /在(?:文件资源管理器|访达|文件管理器)中打开/);
    assert.equal(res.escDismissed, true);
    assert.match(res.injectedEnText, /Open in (?:File Explorer|Finder|File Manager)/);
    assert.equal(res.dupCount, 0);
    assert.equal(res.treeMenuOpen, true);
    assert.equal(res.treeHasParentAct, false);
    assert.equal(res.fileHasParentAct, true);
    assert.equal(res.bcMenuTitle, 'agy-anchor-wheel');
    assert.equal(res.closedOnEsc, true);
    assert.equal(res.revealCalls.length, 4);
    assert.ok(res.revealCalls[0].path.endsWith('dist'));
    assert.ok(res.revealCalls[1].path.endsWith('dist'));
    assert.ok(res.revealCalls[2].path.endsWith('scripts'));
    assert.ok(res.revealCalls[3].path.endsWith('agy-anchor-wheel-v0.8.0.zip'));
    assert.equal(res.revealCalls[3].preferDirectory, true);
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        browserProc.once('exit', () => { clearTimeout(timer); resolve(); });
        try { browserProc.kill(); } catch { resolve(); }
      });
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {}
  }
});
