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
