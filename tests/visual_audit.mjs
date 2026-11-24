import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../sidecars/anchor_wheel/main.mjs';

function findBrowserExe() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('No headless Chromium browser (Chrome/Edge) found');
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for headless browser DevToolsActivePort');
}

class AuditCdp {
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

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 480,
    });
    await new Promise((r) => setTimeout(r, 180));
  }

  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
  }
}

async function runAudit() {
  const outDir = process.argv[2] || path.join(os.tmpdir(), 'aw-audit-shots');
  fs.mkdirSync(outDir, { recursive: true });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vis-'));
  const wsDir = path.join(tmpDirOr(tmpRoot), 'ws');
  const brainDir = path.join(tmpRoot, 'brain');
  const convBrain = path.join(brainDir, 'conv-demo-01');
  const dataDir = path.join(tmpRoot, 'data');
  const profileDir = path.join(tmpRoot, 'chrome-profile');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(convBrain, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  // Create realistic test workspace & artifacts
  const pyFile = path.join(wsDir, 'render_pipeline.py');
  fs.writeFileSync(
    pyFile,
    'import math\n\ndef render_frame(idx: int, fps: int = 60):\n    t = idx / fps\n    return math.sin(t * 2.0)\n',
    'utf8'
  );
  const archMd = path.join(wsDir, 'architecture_notes.md');
  fs.writeFileSync(archMd, '# 渲染管线架构说明\n\n详见核心模块 `render_pipeline.py`。\n', 'utf8');
  const notesMd = path.join(wsDir, 'audio_sync.md');
  fs.writeFileSync(notesMd, '# 声画同步规则\n\n对齐节拍头与嘴型偏移校验。\n', 'utf8');
  const gbkFile = path.join(wsDir, 'legacy_log_gbk.txt');
  fs.writeFileSync(
    gbkFile,
    Buffer.concat([
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xa8, 0xb8, 0xe6]), // 中文测试报告
      Buffer.from(': ', 'ascii'),
      Buffer.from([0xd5, 0xfd, 0xb3, 0xa3, 0xbd, 0xe2, 0xc2, 0xeb, 0xce, 0xde, 0xc2, 0xd2, 0xc2, 0xeb]), // 正常解码无乱码
      Buffer.from('\nLine 2: ASCII fallback check.\n', 'ascii'),
    ])
  );
  const svgFile = path.join(wsDir, 'preview_card.svg');
  fs.writeFileSync(
    svgFile,
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="16" fill="#182032"/><circle cx="160" cy="80" r="44" fill="#669df6" fill-opacity="0.3" stroke="#669df6" stroke-width="3"/></svg>',
    'utf8'
  );
  const extraPngs = [1, 2, 3, 4, 5].map((n) => {
    const p = path.join(wsDir, `frame_0${n}.svg`);
    fs.writeFileSync(p, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#234"/></svg>`, 'utf8');
    return p;
  });

  const grandparentMd = path.join(convBrain, '00_总纲入口.md');
  const summaryMd = path.join(convBrain, 'V2_验收汇总报告.md');
  fs.writeFileSync(
    grandparentMd,
    `# 项目总纲\n\n- [V2 验收汇总报告](${summaryMd})\n- [architecture_notes.md](${archMd})\n`,
    'utf8'
  );
  fs.writeFileSync(
    summaryMd,
    [
      '# V2 音画同步交付验收总览',
      '',
      '本报告汇总了本次重构涉及的全部核心脚本、架构文档与分镜图：',
      '',
      '| 模块 | 关联文件 | 说明 |',
      '| :--- | :--- | :--- |',
      `| 核心管线 | [render_pipeline.py](${pyFile}) | 主帧率计算与曲线采样 |`,
      `| 架构设计 | [architecture_notes.md](${archMd}) | 模块职责拆分 |`,
      `| 声画规范 | [audio_sync.md](${notesMd}) | 节拍对齐检查 |`,
      `| 历史日志 | [legacy_log_gbk.txt](${gbkFile}) | GBK 编码日志样本 |`,
      `| 预览图0 | [preview_card.svg](${svgFile}) | 矢量预览样本 |`,
      ...extraPngs.map((ep, i) => `| 分镜${i + 1} | [frame_0${i + 1}.svg](${ep}) | 序列帧 ${i + 1} |`),
      `| 已删除项 | [ghost_missing.md](${path.join(wsDir, 'ghost_missing.md')}) | 测试失效链接标红 |`,
      '',
      '```python',
      'print("AnchorWheel optical code block")',
      '```',
    ].join('\n'),
    'utf8'
  );

  const inst = await startServer({
    standalone: true,
    noCdp: true,
    noUpdateCheck: true,
    port: 0,
    dataDir,
    workspaceRoots: [wsDir],
    brainDir,
  });

  let browserProc = null;
  let ws = null;

  try {
    const exe = findBrowserExe();
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

    const cdpPort = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new AuditCdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const baseUrl = `http://127.0.0.1:${inst.port}/`;
    await cdp.setViewport(1440, 940);
    await cdp.send('Page.navigate', { url: baseUrl });
    await new Promise((r) => setTimeout(r, 700));

    // 1. 1440px Dark Obsidian Home Desk + record multi-level lineage (00_总纲 -> V2_验收)
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await new Promise((r) => setTimeout(r, 150));
    await cdp.screenshot(path.join(outDir, '01_1440_obsidian_home.png'));

    // Navigate grandparent -> summary so ancestor trunk has grandparent + parent!
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(grandparentMd)})`);
    await new Promise((r) => setTimeout(r, 250));
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(summaryMd)})`);
    await new Promise((r) => setTimeout(r, 350));

    // 2. 1440px Obsidian Bilateral Wheel (holdMode = true, zero bottom buttons, hover image arc + open rail)
    await cdp.evalAsync(`(() => {
      window.__awWorkbench.openBilateralWheel(560, 420, { holdMode: true, persistOnScroll: false });
    })()`);
    await new Promise((r) => setTimeout(r, 180));
    await cdp.evalAsync(`(() => {
      const arcs = document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])');
      arcs[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 180));
    await cdp.evalAsync(`(() => {
      const more = document.querySelector('.aw-bi-more-pill');
      more?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evalAsync(`(() => {
      const firstSub = document.querySelector('.aw-bi-rail-item');
      firstSub?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 420));
    await cdp.screenshot(path.join(outDir, '02_1440_obsidian_bilateral.png'));

    // 3. 1440px Warm AE Tree (Tab persistent) + 0.25s hover preview
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'warm')`);
    await cdp.evalAsync(`window.__awWorkbench.openAeTree({ fromTabMode: true })`);
    await new Promise((r) => setTimeout(r, 250));
    await cdp.evalAsync(`(() => {
      const firstChild = document.querySelector('.aw-tree-row[data-current="1"] .aw-tree-child');
      firstChild?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 420));
    await cdp.screenshot(path.join(outDir, '03_1440_warm_aetree_preview.png'));

    // 4. 1440px Obsidian Settings & Reactive Interactive Guide Modal (strict single-active tri-state)
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openSettingsModal('modes')`);
    await new Promise((r) => setTimeout(r, 320));
    await cdp.screenshot(path.join(outDir, '04_1440_obsidian_settings_modes.png'));

    // 4b. Verify reactive click-switch to ae_tree + right parentDirection mirror in live preview!
    await cdp.evalAsync(`(() => {
      const p = document.getElementById('aw-sm-pdir');
      if (p) { p.value = 'right'; p.dispatchEvent(new Event('change', { bubbles: true })); }
      document.querySelector('[data-aw-guide-card="ae_tree"]')?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 320));
    await cdp.screenshot(path.join(outDir, '04b_1440_obsidian_settings_reactive.png'));

    // 4c. 1440px Obsidian Settings Storage / Update & Compat Diagnostics (scroll down to reveal full compat + update card)
    await cdp.evalAsync(`(() => {
      document.querySelector('[data-aw-sm-tab="storage"]')?.click();
      setTimeout(() => {
        const box = document.getElementById('aw-sm-update-box');
        box?.scrollIntoView({ block: 'end' });
      }, 60);
    })()`);
    await new Promise((r) => setTimeout(r, 280));
    await cdp.screenshot(path.join(outDir, '08b_1440_obsidian_settings_compat.png'));

    // 5. 1100px Alabaster Light Theme AE Tree with stacked corner expanded
    await cdp.setViewport(1100, 860);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'alabaster')`);
    await cdp.evalAsync(`window.__awWorkbench.openAeTree({ fromTabMode: true })`);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.evalAsync(`document.querySelector('.aw-tree-stack-corner')?.click()`);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.screenshot(path.join(outDir, '05_1100_alabaster_aetree.png'));

    // 6. 390px Narrow side-pane Bilateral Wheel
    await cdp.setViewport(390, 844);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openBilateralWheel(195, 420, { holdMode: true })`);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evalAsync(`document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])')[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowBilateral = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '06_390_obsidian_bilateral.png'));

    // 7. 390px Crystal Light AE Tree
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'crystal')`);
    await cdp.evalAsync(`window.__awWorkbench.openAeTree({ fromTabMode: true })`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowTree = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '07_390_crystal_aetree.png'));

    // 8. 390px Alabaster Settings Modal (categories + storage compat)
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'alabaster')`);
    await cdp.evalAsync(`window.__awWorkbench.openSettingsModal('categories')`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowSettings = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '08_390_alabaster_settings.png'));

    await cdp.evalAsync(`document.querySelector('[data-aw-sm-tab="storage"]')?.click()`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowSettingsCompat = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '09_390_alabaster_settings_compat.png'));

    console.log(JSON.stringify({
      ok: true,
      outDir,
      overflowBilateral,
      overflowTree,
      overflowSettings,
      overflowSettingsCompat,
      consoleErrors: cdp.errors,
    }, null, 2));
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        browserProc.once('exit', () => { clearTimeout(t); resolve(); });
        try { browserProc.kill(); } catch { resolve(); }
      });
    }
    await inst.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {}
  }
}

function tmpDirOr(p) { return p; }

void runAudit().catch((e) => {
  console.error(e);
  process.exit(1);
});
