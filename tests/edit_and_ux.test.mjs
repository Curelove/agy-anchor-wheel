import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditService } from '../sidecars/anchor_wheel/backend/edit_service.mjs';
import { CdpBridge } from '../sidecars/anchor_wheel/backend/cdp_bridge.mjs';
import { classifyFile } from '../sidecars/anchor_wheel/backend/nav_context.mjs';
import { DEFAULT_SETTINGS, StateStore } from '../sidecars/anchor_wheel/backend/state_store.mjs';

await import('../sidecars/anchor_wheel/shared/nav_shared.js');
await import('../sidecars/anchor_wheel/shared/soundwave_orb.js');
const SoundwaveMod = globalThis.AnchorWheelSoundwave;

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
    await new Promise((r) => setTimeout(r, 90));
  }
  throw new Error('Timed out waiting for headless browser DevToolsActivePort');
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
        this.errors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.errors.push(msg.params.args?.map((a) => a.value || a.description).join(' ') || 'console.error');
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
    return res?.result?.value;
  }
}

test('EditService: safe editable guard, JSON unclosed-syntax pause, unified diff ledger, conflict guard, and revert cleanup', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-edit-svc-'));
  try {
    const wsDir = path.join(tmpRoot, 'ws');
    const dataDir = path.join(tmpRoot, 'data');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const mdPath = path.join(wsDir, 'notes.md');
    const jsonPath = path.join(wsDir, 'config.json');
    const envPath = path.join(wsDir, '.env');
    fs.writeFileSync(mdPath, '# 标题\n第一行原始文本\n第二行保持不变\n', 'utf8');
    fs.writeFileSync(jsonPath, '{\n  "name": "demo",\n  "count": 1\n}\n', 'utf8');
    fs.writeFileSync(envPath, 'SECRET=123\n', 'utf8');

    const svc = new EditService(dataDir);

    // Sensitive .env is blocked
    const blockedEnv = svc.openForEdit(envPath);
    assert.equal(blockedEnv.ok, false);

    // Open & save Markdown -> generates unified diff & RECENT_USER_EDITS.md
    const openedMd = svc.openForEdit(mdPath);
    assert.equal(openedMd.ok, true);
    assert.equal(openedMd.syntaxKind, 'markdown');

    const savedMd = svc.saveEditedFile({
      path: mdPath,
      content: '# 标题\n第一行已由用户在侧边栏修改\n第二行保持不变\n新增第三行备注\n',
      sessionId: openedMd.sessionId,
      baseMtimeMs: openedMd.mtimeMs,
    });
    assert.equal(savedMd.ok, true);
    assert.ok(savedMd.latestRecord?.diffText.includes('-第一行原始文本'));
    assert.ok(savedMd.latestRecord?.diffText.includes('+第一行已由用户在侧边栏修改'));
    assert.ok(fs.existsSync(savedMd.reportPath));
    const reportMd = fs.readFileSync(savedMd.reportPath, 'utf8');
    assert.ok(reportMd.includes('notes.md'));
    assert.ok(reportMd.includes('+新增第三行备注'));

    // Revert back to original baseline -> removes no-op session diff cleanly
    const revertedMd = svc.saveEditedFile({
      path: mdPath,
      content: '# 标题\n第一行原始文本\n第二行保持不变\n',
      sessionId: openedMd.sessionId,
      baseMtimeMs: savedMd.mtimeMs,
    });
    assert.equal(revertedMd.ok, true);
    assert.equal(revertedMd.history.length, 0);

    // JSON unclosed syntax pauses auto-save without corrupting disk, then saves once closed
    const openedJson = svc.openForEdit(jsonPath);
    assert.equal(openedJson.ok, true);
    assert.equal(openedJson.syntaxKind, 'json');

    const pausedJson = svc.saveEditedFile({
      path: jsonPath,
      content: '{\n  "name": "demo",\n  "count": ',
      sessionId: openedJson.sessionId,
      baseMtimeMs: openedJson.mtimeMs,
      forceSave: false,
    });
    assert.equal(pausedJson.ok, false);
    assert.equal(pausedJson.syntaxPaused, true);
    assert.ok(fs.readFileSync(jsonPath, 'utf8').includes('"count": 1'));

    const closedJson = svc.saveEditedFile({
      path: jsonPath,
      content: '{\n  "name": "demo",\n  "count": 2\n}\n',
      sessionId: openedJson.sessionId,
      baseMtimeMs: openedJson.mtimeMs,
      forceSave: false,
    });
    assert.equal(closedJson.ok, true);
    assert.ok(fs.readFileSync(jsonPath, 'utf8').includes('"count": 2'));

    // Simulate external edit changing file content & mtimeMs -> triggers conflict until forceOverwrite
    fs.writeFileSync(jsonPath, '{\n  "name": "external_ai_change",\n  "count": 99\n}\n', 'utf8');
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(jsonPath, futureTime, futureTime);

    const conflictRes = svc.saveEditedFile({
      path: jsonPath,
      content: '{\n  "name": "demo",\n  "count": 3\n}\n',
      sessionId: openedJson.sessionId,
      baseMtimeMs: closedJson.mtimeMs,
      forceOverwrite: false,
    });
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.conflict, true);

    const forcedOverwrite = svc.saveEditedFile({
      path: jsonPath,
      content: '{\n  "name": "demo",\n  "count": 3\n}\n',
      sessionId: openedJson.sessionId,
      baseMtimeMs: closedJson.mtimeMs,
      forceOverwrite: true,
    });
    assert.equal(forcedOverwrite.ok, true);
    assert.ok(fs.readFileSync(jsonPath, 'utf8').includes('"count": 3'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('SoundwaveOrb & StateStore: default OFF, per-theme soundwave memory, and .js/.mjs default document rules + one-time migration', () => {
  assert.equal(DEFAULT_SETTINGS.wheelSoundwaveEnabled, false);
  assert.equal(SoundwaveMod.isSoundwaveActiveForSettings(DEFAULT_SETTINGS), false);
  assert.equal(SoundwaveMod.isSoundwaveActiveForSettings({ theme: 'soundwave', wheelSoundwaveEnabled: false }), true);
  assert.equal(SoundwaveMod.isSoundwaveActiveForSettings({ theme: 'alabaster', wheelSoundwaveEnabled: true }), true);
  assert.equal(SoundwaveMod.isSoundwaveActiveForSettings({ theme: 'alabaster', wheelSoundwaveEnabled: false }), false);
  assert.equal(
    SoundwaveMod.isSoundwaveActiveForSettings({
      theme: 'obsidian',
      wheelSoundwaveEnabled: false,
      wheelSoundwaveByTheme: { auto: false, obsidian: true, warm: false, crystal: false, alabaster: false },
    }),
    true
  );
  assert.equal(
    SoundwaveMod.isSoundwaveActiveForSettings({
      theme: 'alabaster',
      wheelSoundwaveEnabled: true,
      wheelSoundwaveByTheme: { auto: false, obsidian: true, warm: false, crystal: false, alabaster: false },
    }),
    false
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-round2-store-'));
  try {
    // 1. Fresh store classifies .js, .mjs, .ts, .py into 'doc' ('文档')
    const freshDir = path.join(tmpDir, 'fresh');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshStore = new StateStore(freshDir);
    const freshRules = freshStore.getSettings().categoryRules;
    assert.equal(classifyFile(path.join(tmpDir, 'app.js'), freshRules).id, 'doc');
    assert.equal(classifyFile(path.join(tmpDir, 'worker.mjs'), freshRules).id, 'doc');
    assert.equal(classifyFile(path.join(tmpDir, 'types.ts'), freshRules).id, 'doc');
    assert.equal(classifyFile(path.join(tmpDir, 'tool.py'), freshRules).id, 'doc');

    // 2. Legacy settings.json without js/mjs gets one-time migration into 'doc', then respects user edits afterward
    const migDir = path.join(tmpDir, 'mig');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(
      path.join(migDir, 'settings.json'),
      JSON.stringify({
        theme: 'alabaster',
        categoryRules: [
          { id: 'image', label: '图片', extensions: ['png', 'jpg'] },
          { id: 'doc', label: '文档', extensions: ['md', 'txt', 'json'] },
        ],
      }),
      'utf8'
    );
    const migStore = new StateStore(migDir);
    const migDoc = migStore.getSettings().categoryRules.find((r) => r.id === 'doc');
    assert.ok(migDoc.extensions.includes('js') && migDoc.extensions.includes('mjs'));
    assert.equal(migStore.getSettings().docCodeExtsSeeded, true);

    // User manually removes 'js' -> reload must NOT re-add 'js'
    migStore.updateSettings({
      categoryRules: [
        { id: 'image', label: '图片', extensions: ['png', 'jpg'] },
        { id: 'doc', label: '文档', extensions: ['md', 'txt', 'json'] },
      ],
    });
    const reloadedStore = new StateStore(migDir);
    const reloadedDoc = reloadedStore.getSettings().categoryRules.find((r) => r.id === 'doc');
    assert.equal(reloadedDoc.extensions.includes('js'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  let centerMax = 0;
  let rightLeanRightMax = 0;
  let rightLeanLeftMax = 0;
  let extremeCeilingMax = 0;

  for (let i = 0; i < 72; i++) {
    const ang = (i / 72) * Math.PI * 2;
    const cRes = SoundwaveMod.computeBarHeight(ang, 0, 0, 0.8, null);
    if (cRes.height > centerMax) centerMax = cRes.height;

    const rRes = SoundwaveMod.computeBarHeight(ang, 0.85, 0, 0.8, null);
    if (Math.cos(ang) > 0.7 && rRes.height > rightLeanRightMax) rightLeanRightMax = rRes.height;
    if (Math.cos(ang) < -0.7 && rRes.height > rightLeanLeftMax) rightLeanLeftMax = rRes.height;

    const extRes = SoundwaveMod.computeBarHeight(ang, 1.0, 0, 1.35, null);
    if (extRes.height > extremeCeilingMax) extremeCeilingMax = extRes.height;
  }

  assert.ok(centerMax <= 4.2, `Expected calm center wave <= 4.2px, got ${centerMax}`);
  assert.ok(
    rightLeanRightMax > rightLeanLeftMax * 2.4,
    `Expected leaned right side (${rightLeanRightMax}) >> opposite left side (${rightLeanLeftMax})`
  );
  assert.ok(
    extremeCeilingMax <= SoundwaveMod.MAX_OUTER_CREST_PX,
    `Expected strict ceiling <= ${SoundwaveMod.MAX_OUTER_CREST_PX}px, got ${extremeCeilingMax}`
  );

  // Integrated wheel-body contour morphing: gentle breathing at center, strong directional swell on leaned side
  assert.equal(typeof SoundwaveMod.computeBodyMorph, 'function');
  const morphCenter = Math.abs(SoundwaveMod.computeBodyMorph(0, 0, 0, 0.8, null));
  const morphLeaned = SoundwaveMod.computeBodyMorph(0, 0.9, 0, 0.8, null);
  const morphOpposite = SoundwaveMod.computeBodyMorph(Math.PI, 0.9, 0, 0.8, null);
  assert.ok(morphCenter <= 4.0, `Expected calm center body morph <= 4.0px, got ${morphCenter}`);
  assert.ok(
    morphLeaned > morphOpposite + 4.0,
    `Expected leaned sector body morph (${morphLeaned}) >> opposite side (${morphOpposite})`
  );
});

test('Mode 1 Headless Integration: in-sidebar editor, right-pane selection menu isolation, category drag reorder, misleading wheel removal, and soundwave orb', async (t) => {
  const browserBin = findBrowserExe();
  if (!browserBin) {
    t.skip('No local Chromium/Edge binary available for headless browser test');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-v014-e2e-'));
  const wsDir = path.join(tmpRoot, 'ws');
  const dataDir = path.join(tmpRoot, 'data');
  const profileDir = path.join(tmpRoot, 'profile');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const jsonPath = path.join(wsDir, 'settings_demo.json');
  fs.writeFileSync(jsonPath, '{\n  "title": "初始标题",\n  "enabled": true\n}\n', 'utf8');
  const jsonUri = pathToFileURL(jsonPath).href;
  const jsPath = path.join(wsDir, 'omni_demo.js');
  fs.writeFileSync(jsPath, 'export function greet(name) {\n  return "hello " + name;\n}\n', 'utf8');
  const jsUri = pathToFileURL(jsPath).href;

  const stateStore = new StateStore(dataDir);
  stateStore.updateSettings({
    middleMode: 'bilateral_wheel',
    wheelTriggerButton: 'middle',
    wheelTriggerModifier: 'none',
    wheelHoldSensitivity: 'fast',
    parentDirection: 'left',
    tabTriggerEnabled: true,
    tabMode: 'ae_tree',
    tabCustomHotkey: 'Tab',
    tabTriggerAction: 'toggle',
    rightPaneSelectionMenuEnabled: true,
    wheelSoundwaveEnabled: true,
    theme: 'alabaster',
    categoryRules: [
      { id: 'images', label: '图片', extensions: ['png', 'jpg'] },
      { id: 'code', label: '代码', extensions: ['js', 'py'] },
      { id: 'docs', label: '文档', extensions: ['md', 'json'] },
    ],
  });

  const editSvc = new EditService(dataDir);
  const cdpBridge = new CdpBridge({ stateStore, editService: editSvc });
  const bundleCode = cdpBridge.buildInjectBundle();

  let browserProc = null;
  let ws = null;

  try {
    browserProc = spawn(
      browserBin,
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

    const cdpPort = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new MiniCdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

    await cdp.send('Runtime.addBinding', { name: '__agAnchorWheelCall' });
    let savedSettingsPayload = null;

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__agAnchorWheelCall') {
        const req = JSON.parse(msg.params.payload);
        let result = { ok: true, session: stateStore.getSession('conv-e2e') };
        if (req.action === 'getBoot') {
          result = {
            ok: true,
            version: '0.14.0',
            settings: stateStore.getSettings(),
            session: stateStore.getSession('conv-e2e'),
          };
        } else if (req.action === 'openForEdit') {
          result = editSvc.openForEdit(req.path);
        } else if (req.action === 'saveEditedFile') {
          result = editSvc.saveEditedFile(req);
        } else if (req.action === 'getEditHistory') {
          result = editSvc.getEditHistory({ path: req.path, limit: req.limit });
        } else if (req.action === 'updateSettings') {
          savedSettingsPayload = req.settings;
          result = { ok: true, settings: stateStore.updateSettings(req.settings || {}) };
        } else if (req.action === 'getBacklinks') {
          result = { ok: true, path: req.path, title: 'settings_demo.json', backlinks: [], outlinks: [] };
        } else if (req.action === 'getNavContext') {
          result = {
            ok: true,
            activePath: req.path,
            childSourceScope: 'opened_and_outlinks',
            parentDirection: stateStore.getSettings().parentDirection,
            current: { path: jsonPath, key: jsonPath.toLowerCase(), title: 'settings_demo.json', isDirectory: false, children: [] },
            parent: null,
            ancestors: [],
            totalCurrentChildren: 2,
            categories: [
              { id: 'images', label: '图片', items: [{ path: path.join(wsDir, 'a.png'), title: 'a.png' }] },
              { id: 'code', label: '代码', items: [{ path: path.join(wsDir, 'b.js'), title: 'b.js' }] },
              { id: 'docs', label: '文档', items: [] },
              { id: 'other', label: '其他', items: [] },
            ],
          };
        }
        void cdp.send('Runtime.evaluate', {
          expression: `window.__agAnchorWheelResolve?.(${JSON.stringify(req.id)}, ${JSON.stringify(result)})`,
        });
      }
    });

    // Build mock Antigravity host DOM matching Mode 1 sidePanelV2 + aux-pane-split contract
    await cdp.evalAsync(`(() => {
      document.body.innerHTML = '';
      const root = document.createElement('div');
      root.id = 'root';
      root.style.cssText = 'display:flex;width:1200px;height:800px;';
      document.body.appendChild(root);

      const cid = 'conv-e2e';
      const fileUri = ${JSON.stringify(jsonUri)};
      const storeState = {
        sidePanel: { isOpen: true },
        sidePanelV2: {
          conversationPanes: {
            [cid]: {
              activeTabId: 'file__' + fileUri,
              tabs: [
                {
                  id: 'file__' + fileUri,
                  content: { case: 'fileView', fileView: { fileUri } },
                  isPreview: false,
                },
              ],
            },
          },
          overviewPanelOpen: {},
        },
      };
      let storeListener = null;
      const reduxStore = {
        getState: () => storeState,
        subscribe: (fn) => {
          storeListener = fn;
          return () => {};
        },
        dispatch: () => {},
        __notifyTest: () => storeListener?.(),
      };
      const browserCtx = {
        openUrlInBrowserPane: () => {},
        getTargetTreeId: () => ({ kind: 'cascadeId', cascadeId: cid }),
      };
      const mockRouter = {
        navigate: () => Promise.resolve(),
        buildLocation: () => ({}),
      };
      root.__reactContainer$test = {
        memoizedProps: { store: reduxStore, value: browserCtx, router: mockRouter },
        child: null,
        sibling: null,
      };

      const aux = document.createElement('div');
      aux.setAttribute('data-testid', 'aux-pane-split');
      aux.style.cssText = 'display:flex;width:1200px;height:800px;';

      const left = document.createElement('div');
      left.style.cssText = 'width:600px;height:800px;padding:16px;';
      const chatMsg = document.createElement('p');
      chatMsg.id = 'chat-msg';
      chatMsg.textContent = '这是左侧对话消息气泡文字，右键不应弹出插件选区菜单';
      const chatBox = document.createElement('div');
      chatBox.setAttribute('data-testid', 'agent-input-box');
      const chatInput = document.createElement('textarea');
      chatInput.id = 'chat-input';
      chatInput.style.cssText = 'width:520px;height:64px;';
      chatBox.appendChild(chatInput);
      left.append(chatMsg, chatBox);

      const right = document.createElement('div');
      right.style.cssText = 'width:600px;height:800px;';
      const col = document.createElement('div');
      col.className = 'flex flex-col browser-hole-ancestor';
      col.style.cssText = 'width:600px;height:800px;display:flex;flex-direction:column;';

      const tabBar = document.createElement('div');
      tabBar.className = 'agy-layout-vars shrink-0 flex items-center';
      tabBar.style.cssText = 'height:34px;display:flex;';
      const tabEl = document.createElement('div');
      tabEl.className = 'agy-aux-tab';
      tabEl.__reactFiber$test = { memoizedProps: { tab: storeState.sidePanelV2.conversationPanes[cid].tabs[0] } };
      tabBar.appendChild(tabEl);

      const contentWrap = document.createElement('div');
      contentWrap.className = 'flex-grow basis-0 overflow-hidden';
      contentWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;';

      const crumb = document.createElement('div');
      crumb.setAttribute('data-uri', fileUri);
      crumb.textContent = 'settings_demo.json';

      const pre = document.createElement('pre');
      pre.id = 'native-json-view';
      pre.textContent = ${JSON.stringify('{\n  "title": "初始标题",\n  "enabled": true\n}')};

      const fileChip = document.createElement('a');
      fileChip.id = 'file-link-chip';
      fileChip.setAttribute('data-uri', fileUri);
      fileChip.href = fileUri;
      fileChip.textContent = 'settings_demo.json';

      contentWrap.append(crumb, pre, fileChip);
      col.append(tabBar, contentWrap);
      right.appendChild(col);
      aux.append(left, right);
      root.appendChild(aux);
    })()`);

    await cdp.evalAsync(bundleCode);
    await new Promise((r) => setTimeout(r, 260));

    // 1. Verify official view remains default until user clicks 编辑
    const initialCheck = await cdp.evalAsync(`(() => ({
      hasEditBtn: Boolean(document.querySelector('#aw-companion-strip [data-aw-role="edit-btn"]')),
      editorOverlayOpen: Boolean(document.getElementById('aw-native-editor-overlay') && !document.getElementById('aw-native-editor-overlay').hidden),
      nativePreVisible: document.getElementById('native-json-view')?.offsetHeight > 0,
    }))()`);
    assert.equal(initialCheck.hasEditBtn, true);
    assert.equal(initialCheck.editorOverlayOpen, false);
    assert.equal(initialCheck.nativePreVisible, true);

    // 2. Right-click selection menu: isolated strictly to Right Sidebar plain text!
    const selMenuCheck = await cdp.evalAsync(`(async () => {
      function selectNodeText(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // 2a. Select text in LEFT chat bubble + right click -> MUST NOT open .aw-ctx-menu
      selectNodeText(document.getElementById('chat-msg'));
      const chatEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 40 });
      document.getElementById('chat-msg').dispatchEvent(chatEv);
      const chatMenuOpened = Boolean(document.querySelector('.aw-ctx-menu'));

      // 2b. Right click on a file link/pill in right pane -> MUST yield (for obsidian-prism)
      selectNodeText(document.getElementById('file-link-chip'));
      const linkEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 720, clientY: 160 });
      document.getElementById('file-link-chip').dispatchEvent(linkEv);
      const linkMenuOpened = Boolean(document.querySelector('.aw-ctx-menu'));

      // 2c. Select plain text in right sidebar #native-json-view + right click -> opens selection menu!
      const pre = document.getElementById('native-json-view');
      const textNode = pre.firstChild;
      const range = document.createRange();
      range.setStart(textNode, textNode.textContent.indexOf('"初始标题"'));
      range.setEnd(textNode, textNode.textContent.indexOf('"初始标题"') + 6);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const rightEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 760, clientY: 120 });
      pre.dispatchEvent(rightEv);
      await new Promise((r) => setTimeout(r, 35));
      const menuText = document.querySelector('.aw-ctx-menu')?.textContent || '';
      const hasQuoteItem = menuText.includes('引用选中片段到输入框');
      const hasEditLocateItem = menuText.includes('进入编辑并定位到此段');

      // Click "引用选中片段到输入框" -> inserts into chat input!
      document.querySelector('.aw-ctx-menu [data-aw-sel-act="quote-to-chat"]')?.click();
      await new Promise((r) => setTimeout(r, 35));
      const chatInputAfterQuote = document.getElementById('chat-input')?.value || '';

      // Re-open menu and click "进入编辑并定位到此段" -> opens editor overlay and highlights selection!
      sel.removeAllRanges();
      sel.addRange(range);
      pre.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 760, clientY: 120 }));
      await new Promise((r) => setTimeout(r, 35));
      document.querySelector('.aw-ctx-menu [data-aw-sel-act="edit-locate"]')?.click();
      await new Promise((r) => setTimeout(r, 150));

      const ta = document.getElementById('aw-ed-ta');
      const locatedSlice = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';

      return {
        chatMenuOpened,
        linkMenuOpened,
        hasQuoteItem,
        hasEditLocateItem,
        chatInputAfterQuote,
        editorOpenedViaMenu: Boolean(ta),
        locatedSlice,
      };
    })()`);

    assert.equal(selMenuCheck.chatMenuOpened, false);
    assert.equal(selMenuCheck.linkMenuOpened, false);
    assert.equal(selMenuCheck.hasQuoteItem, true);
    assert.equal(selMenuCheck.hasEditLocateItem, true);
    assert.ok(selMenuCheck.chatInputAfterQuote.includes('settings_demo.json'));
    assert.ok(selMenuCheck.chatInputAfterQuote.includes('"初始标题"'));
    assert.equal(selMenuCheck.editorOpenedViaMenu, true);
    assert.equal(selMenuCheck.locatedSlice, '"初始标题"');

    // 3. Test Editor: unclosed JSON pauses auto-save, closing JSON auto-saves, and "发给 AI 查看" sends diff to chat box!
    const editorCheck = await cdp.evalAsync(`(async () => {
      const ta = document.getElementById('aw-ed-ta');
      ta.value = '{\\n  "title": "未闭合JSON';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 780));
      const statusWhenUnclosed = document.getElementById('aw-ed-status')?.getAttribute('data-state');
      const textWhenUnclosed = document.getElementById('aw-ed-status-text')?.textContent || '';

      // Now close the JSON properly -> auto-saves after debounce!
      ta.value = '{\\n  "title": "侧边栏直接编辑后的新标题",\\n  "enabled": false\\n}\\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 820));
      const statusWhenClosed = document.getElementById('aw-ed-status')?.getAttribute('data-state');
      const histBtnLabel = document.getElementById('aw-ed-hist-lbl')?.textContent || '';

      // Open history drawer & click "发给 AI 查看"
      document.getElementById('chat-input').value = '';
      document.getElementById('aw-ed-hist-btn')?.click();
      await new Promise((r) => setTimeout(r, 40));
      document.querySelector('.aw-ed-send-rec')?.click();
      await new Promise((r) => setTimeout(r, 40));
      const chatInputWithDiff = document.getElementById('chat-input')?.value || '';

      // Exit editor back to official view
      document.getElementById('aw-ed-exit')?.click();
      await new Promise((r) => setTimeout(r, 50));
      const backToOfficialView = !document.getElementById('aw-native-editor-overlay') || document.getElementById('aw-native-editor-overlay').hidden;

      return {
        statusWhenUnclosed,
        textWhenUnclosed,
        statusWhenClosed,
        histBtnLabel,
        chatInputWithDiff,
        backToOfficialView,
      };
    })()`);

    assert.equal(editorCheck.statusWhenUnclosed, 'paused');
    assert.ok(editorCheck.textWhenUnclosed.includes('待闭合'));
    assert.equal(editorCheck.statusWhenClosed, 'saved');
    assert.ok(editorCheck.histBtnLabel.includes('(1)'));
    assert.ok(editorCheck.chatInputWithDiff.includes('侧边栏直接编辑后的新标题'));
    assert.equal(editorCheck.backToOfficialView, true);
    assert.ok(fs.readFileSync(jsonPath, 'utf8').includes('侧边栏直接编辑后的新标题'));

    // 4. Settings Modal: verify misleading top wheel in storage tab is GONE, and category drag-reorder updates order & SVG live!
    const settingsCheck = await cdp.evalAsync(`(async () => {
      document.querySelector('#aw-companion-strip [data-aw-role="settings-btn"]')?.click();
      await new Promise((r) => setTimeout(r, 50));

      // Switch to storage tab -> verify ZERO .aw-guide-svg inside storage tab, group title is "界面外观", and per-theme soundwave memory works!
      document.querySelector('[data-aw-sm-tab="storage"]')?.click();
      await new Promise((r) => setTimeout(r, 40));
      const storageGuideSvgCount = document.querySelectorAll('.aw-settings-body .aw-guide-svg').length;
      const firstGroupTitle = document.querySelector('.aw-settings-body .aw-settings-group-title')?.textContent?.trim() || '';
      const hasSoundwaveThemeOpt = Boolean(document.querySelector('#aw-sm-theme option[value="soundwave"]'));
      const swInput = document.getElementById('aw-sm-soundwave');
      const themeSel = document.getElementById('aw-sm-theme');
      const hasSoundwaveToggle = Boolean(swInput);

      // Test per-theme memory:
      // 1) Turn OFF on alabaster
      themeSel.value = 'alabaster';
      themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      swInput.checked = false;
      swInput.dispatchEvent(new Event('change', { bubbles: true }));
      // 2) Switch to obsidian -> default OFF -> toggle ON
      themeSel.value = 'obsidian';
      themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      const obsidianInitialOff = swInput.checked === false && swInput.disabled === false;
      swInput.checked = true;
      swInput.dispatchEvent(new Event('change', { bubbles: true }));
      // 3) Switch to soundwave -> forced ON & disabled!
      themeSel.value = 'soundwave';
      themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      const soundwaveForcedLocked = swInput.checked === true && swInput.disabled === true;
      // 4) Switch back to alabaster -> remembers OFF & enabled!
      themeSel.value = 'alabaster';
      themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      const alabasterRememberedOff = swInput.checked === false && swInput.disabled === false;
      // 5) Switch back to obsidian -> remembers ON & enabled!
      themeSel.value = 'obsidian';
      themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      const obsidianRememberedOn = swInput.checked === true && swInput.disabled === false;
      // Leave alabaster ON for step 5 wheel canvas test
      themeSel.value = 'alabaster';
      themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      swInput.checked = true;
      swInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Switch to categories tab -> drag first category ("图片") below second category ("代码") using PointerEvents!
      document.querySelector('[data-aw-sm-tab="categories"]')?.click();
      await new Promise((r) => setTimeout(r, 50));
      const handles = document.querySelectorAll('.aw-rule-drag-handle');
      const rows = document.querySelectorAll('.aw-rule-row[data-aw-rule-idx]');
      const r0 = rows[0].getBoundingClientRect();
      const r1 = rows[1].getBoundingClientRect();

      handles[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r0.left + 10, clientY: r0.top + 12 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: r1.left + 10, clientY: r1.bottom - 2 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r1.left + 10, clientY: r1.bottom - 2 }));
      await new Promise((r) => setTimeout(r, 40));

      const labelsAfterDrag = Array.from(document.querySelectorAll('.aw-sm-rule-label')).map((el) => el.value);
      const lockedStillBottom = document.querySelector('.aw-rule-list')?.lastElementChild?.classList?.contains('aw-rule-locked');

      document.getElementById('aw-sm-save')?.click();
      await new Promise((r) => setTimeout(r, 50));

      return {
        storageGuideSvgCount,
        firstGroupTitle,
        hasSoundwaveThemeOpt,
        hasSoundwaveToggle,
        obsidianInitialOff,
        soundwaveForcedLocked,
        alabasterRememberedOff,
        obsidianRememberedOn,
        labelsAfterDrag,
        lockedStillBottom,
      };
    })()`);

    assert.equal(settingsCheck.storageGuideSvgCount, 0);
    assert.equal(settingsCheck.firstGroupTitle, '界面外观');
    assert.equal(settingsCheck.hasSoundwaveThemeOpt, true);
    assert.equal(settingsCheck.hasSoundwaveToggle, true);
    assert.equal(settingsCheck.obsidianInitialOff, true);
    assert.equal(settingsCheck.soundwaveForcedLocked, true);
    assert.equal(settingsCheck.alabasterRememberedOff, true);
    assert.equal(settingsCheck.obsidianRememberedOn, true);
    assert.deepEqual(settingsCheck.labelsAfterDrag, ['代码', '图片', '文档']);
    assert.equal(settingsCheck.lockedStillBottom, true);
    assert.deepEqual(savedSettingsPayload?.categoryRules?.map((r) => r.label), ['代码', '图片', '文档']);
    assert.equal(savedSettingsPayload?.wheelSoundwaveByTheme?.obsidian, true);
    assert.equal(savedSettingsPayload?.wheelSoundwaveByTheme?.auto, false);

    // 4b. Regression test for .js files rendered by Antigravity R4 (.file-viewer-root containing [data-testid="more-actions-overflow"] and zero <pre>/<code>):
    // Clicking top [data-aw-role="edit-btn"] MUST hide .file-viewer-root and mount #aw-native-editor-overlay visibly inside viewport!
    const jsEditBtnCheck = await cdp.evalAsync(`(async () => {
      const jsFileUri = ${JSON.stringify(jsUri)};
      const root = document.getElementById('root') || document.body.firstElementChild || document.body;
      const store = root.__reactContainer$test?.memoizedProps?.store;
      const st = store.getState();
      const pane = st.sidePanelV2.conversationPanes['conv-e2e'];
      pane.activeTabId = 'file__' + jsFileUri;
      pane.tabs = [{ id: 'file__' + jsFileUri, content: { case: 'fileView', fileView: { fileUri: jsFileUri } }, isPreview: false }];
      const tabEl = document.querySelector('.agy-aux-tab');
      if (tabEl && tabEl.__reactFiber$test) tabEl.__reactFiber$test.memoizedProps.tab = pane.tabs[0];

      const strip = document.getElementById('aw-companion-strip');
      const contentWrap = strip.nextElementSibling;
      // Replace contentWrap with exact Antigravity x4 -> R4 .file-viewer-root block structure (non-flex wrapper, h:100%, overflow-hidden)
      const savedJsonKids = Array.from(contentWrap.children);
      contentWrap.style.cssText = 'flex:1;display:block;position:relative;overflow:hidden;min-height:0;';
      contentWrap.innerHTML = '';
      const x4Inner = document.createElement('div');
      x4Inner.className = 'w-full h-full relative';
      x4Inner.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden;';
      const r4Outer = document.createElement('div');
      r4Outer.className = 'relative flex-1 min-h-0 w-full';
      r4Outer.style.cssText = 'width:100%;height:100%;position:relative;';
      const r4Viewer = document.createElement('div');
      r4Viewer.className = 'file-viewer-root w-full cursor-text overflow-y-auto h-full relative py-2';
      r4Viewer.setAttribute('data-viewer-tab-id', 'file__' + jsFileUri);
      r4Viewer.setAttribute('data-active-file-uri', jsFileUri);
      r4Viewer.style.cssText = 'width:100%;height:100%;';
      const overflowBtn = document.createElement('button');
      overflowBtn.setAttribute('data-testid', 'more-actions-overflow');
      overflowBtn.textContent = '...';
      const codeLine = document.createElement('div');
      codeLine.className = 'code-line';
      codeLine.textContent = 'export function greet(name) { return "hello " + name; }';
      r4Viewer.append(overflowBtn, codeLine);
      r4Outer.appendChild(r4Viewer);
      x4Inner.appendChild(r4Outer);
      contentWrap.appendChild(x4Inner);

      // Trigger Redux subscriber so activeFilePath updates to omni_demo.js
      store.__notifyTest?.();
      await new Promise((r) => setTimeout(r, 260));

      const editBtn = document.querySelector('#aw-companion-strip [data-aw-role="edit-btn"]');
      if (!editBtn) return { hasEditBtn: false };
      editBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      editBtn.click();
      await new Promise((r) => setTimeout(r, 180));

      const edOv = document.getElementById('aw-native-editor-overlay');
      const edRect = edOv ? edOv.getBoundingClientRect() : null;
      const x4Hidden = getComputedStyle(x4Inner).display === 'none';
      const taVal = document.getElementById('aw-ed-ta')?.value || '';

      // Exit editor and restore original JSON test view for step 5
      document.getElementById('aw-ed-exit')?.click();
      await new Promise((r) => setTimeout(r, 60));
      const x4Restored = getComputedStyle(x4Inner).display !== 'none';

      contentWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;';
      contentWrap.innerHTML = '';
      for (const k of savedJsonKids) contentWrap.appendChild(k);
      pane.activeTabId = 'file__' + ${JSON.stringify(jsonUri)};
      pane.tabs = [{ id: 'file__' + ${JSON.stringify(jsonUri)}, content: { case: 'fileView', fileView: { fileUri: ${JSON.stringify(jsonUri)} } }, isPreview: false }];
      if (tabEl && tabEl.__reactFiber$test) tabEl.__reactFiber$test.memoizedProps.tab = pane.tabs[0];
      store.__notifyTest?.();
      await new Promise((r) => setTimeout(r, 240));

      return {
        hasEditBtn: true,
        x4Hidden,
        edTop: edRect ? Math.round(edRect.top) : -1,
        edHeight: edRect ? Math.round(edRect.height) : 0,
        taHasJsCode: taVal.includes('export function greet'),
        x4Restored,
      };
    })()`);

    assert.equal(jsEditBtnCheck.hasEditBtn, true);
    assert.equal(jsEditBtnCheck.x4Hidden, true);
    assert.ok(jsEditBtnCheck.edTop >= 0 && jsEditBtnCheck.edTop < 160, `Expected editor overlay at top of pane, got top=${jsEditBtnCheck.edTop}`);
    assert.ok(jsEditBtnCheck.edHeight > 300, `Expected full-height editor overlay on .js, got height=${jsEditBtnCheck.edHeight}`);
    assert.equal(jsEditBtnCheck.taHasJsCode, true);
    assert.equal(jsEditBtnCheck.x4Restored, true);

    // 5. Soundwave Orb live wheel mount, SVG contour morph & clean teardown on Alabaster theme
    const orbWheelCheck = await cdp.evalAsync(`(async () => {
      const pre = document.getElementById('native-json-view');
      pre.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, buttons: 4, clientX: 880, clientY: 360 }));
      await new Promise((r) => setTimeout(r, 110));
      const canvasMounted = Boolean(document.querySelector('.aw-bi-stage .aw-soundwave-canvas'));
      const fxCanvasMounted = Boolean(document.querySelector('.aw-bi-stage .aw-soundwave-fx-canvas'));
      const stageRect = document.querySelector('.aw-bi-stage')?.getBoundingClientRect();
      const canvasRect = document.querySelector('.aw-bi-stage .aw-soundwave-canvas')?.getBoundingClientRect();
      const fxCanvasRect = document.querySelector('.aw-bi-stage .aw-soundwave-fx-canvas')?.getBoundingClientRect();
      const centerDeltaX = stageRect && canvasRect ? Math.abs((stageRect.left + stageRect.width / 2) - (canvasRect.left + canvasRect.width / 2)) : 999;
      const centerDeltaY = stageRect && canvasRect ? Math.abs((stageRect.top + stageRect.height / 2) - (canvasRect.top + canvasRect.height / 2)) : 999;
      const fxCenterDeltaX = stageRect && fxCanvasRect ? Math.abs((stageRect.left + stageRect.width / 2) - (fxCanvasRect.left + fxCanvasRect.width / 2)) : 999;
      const fxCenterDeltaY = stageRect && fxCanvasRect ? Math.abs((stageRect.top + stageRect.height / 2) - (fxCanvasRect.top + fxCanvasRect.height / 2)) : 999;
      const morphedSectorCount = Array.from(document.querySelectorAll('.aw-bi-stage .aw-wheel-sector')).filter((el) => (el.getAttribute('d') || '').includes(' C ')).length;
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, buttons: 4, clientX: 980, clientY: 360 }));
      await new Promise((r) => setTimeout(r, 40));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 1, buttons: 0, clientX: 880, clientY: 360 }));
      await new Promise((r) => setTimeout(r, 40));
      const canvasCleanedUp = !document.querySelector('.aw-soundwave-canvas') && !document.querySelector('.aw-soundwave-fx-canvas');
      return { canvasMounted, fxCanvasMounted, centerDeltaX, centerDeltaY, fxCenterDeltaX, fxCenterDeltaY, morphedSectorCount, canvasCleanedUp };
    })()`);

    assert.equal(orbWheelCheck.canvasMounted, true);
    assert.equal(orbWheelCheck.fxCanvasMounted, true);
    assert.ok(orbWheelCheck.centerDeltaX < 1, `Expected soundwave canvas centered X, delta=${orbWheelCheck.centerDeltaX}`);
    assert.ok(orbWheelCheck.centerDeltaY < 1, `Expected soundwave canvas centered Y, delta=${orbWheelCheck.centerDeltaY}`);
    assert.ok(orbWheelCheck.fxCenterDeltaX < 1, `Expected soundwave fx canvas centered X, delta=${orbWheelCheck.fxCenterDeltaX}`);
    assert.ok(orbWheelCheck.fxCenterDeltaY < 1, `Expected soundwave fx canvas centered Y, delta=${orbWheelCheck.fxCenterDeltaY}`);
    assert.ok(orbWheelCheck.morphedSectorCount >= 5, `Expected morphed Bezier wheel sectors >= 5, got ${orbWheelCheck.morphedSectorCount}`);
    assert.equal(orbWheelCheck.canvasCleanedUp, true);
    assert.deepEqual(cdp.errors, []);
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
