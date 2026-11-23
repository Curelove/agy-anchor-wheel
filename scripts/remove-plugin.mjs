import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPortFilePath, isEligibleAntigravityTarget, readDevToolsPort } from '../sidecars/anchor_wheel/backend/cdp_bridge.mjs';

const PLUGIN_NAME = 'agy-anchor-wheel';
const TARGET_ROOT = path.join(os.homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);
const KEEP_DATA = process.argv.includes('--keep-data');

async function cleanupInjectedDom() {
  const port = readDevToolsPort(getDefaultPortFilePath());
  if (!port) return;
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
    const eligible = (Array.isArray(pages) ? pages : []).filter(isEligibleAntigravityTarget);
    for (const target of eligible) {
      try {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout')), 1500);
          ws.addEventListener('open', () => { clearTimeout(t); res(); });
          ws.addEventListener('error', rej);
        });
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__agAnchorWheel?.destroy?.()' } }));
        await new Promise((r) => setTimeout(r, 150));
        ws.close();
      } catch {}
    }
  } catch {}
}

await cleanupInjectedDom();

if (fs.existsSync(TARGET_ROOT)) {
  if (KEEP_DATA) {
    for (const ent of fs.readdirSync(TARGET_ROOT, { withFileTypes: true })) {
      if (ent.name === 'data') continue;
      fs.rmSync(path.join(TARGET_ROOT, ent.name), { recursive: true, force: true });
    }
    console.log(`[remove] Removed ${PLUGIN_NAME} files (kept data/)`);
  } else {
    fs.rmSync(TARGET_ROOT, { recursive: true, force: true });
    console.log(`[remove] Removed ${TARGET_ROOT}`);
  }
} else {
  console.log(`[remove] Plugin directory not present: ${TARGET_ROOT}`);
}
