import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../sidecars/anchor_wheel/main.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'plugin.json'), 'utf8')
).version;

test('standalone HTTP API serves UI assets, session ops, backlinks, and encoding inspect/read', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-api-'));
  const wsDir = path.join(tmpDir, 'ws');
  const dataDir = path.join(tmpDir, 'data');
  const brainDir = path.join(tmpDir, 'brain');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });

  const childFile = path.join(wsDir, 'sub.txt');
  fs.writeFileSync(childFile, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])); // GBK "中文\n"

  const mdFile = path.join(wsDir, 'overview.md');
  fs.writeFileSync(mdFile, '# Overview\nSee [sub.txt](./sub.txt)\n', 'utf8');

  fs.writeFileSync(
    path.join(dataDir, 'update_cache.json'),
    JSON.stringify({
      ok: true,
      currentVersion: PLUGIN_VERSION,
      latestVersion: PLUGIN_VERSION,
      tagName: `v${PLUGIN_VERSION}`,
      updateAvailable: false,
      repoUrl: 'https://github.com/Curelove/agy-anchor-wheel',
      releasesUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases',
      releaseUrl: `https://github.com/Curelove/agy-anchor-wheel/releases/tag/v${PLUGIN_VERSION}`,
      checkedAt: Date.now(),
    }),
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

  try {
    const base = `http://127.0.0.1:${inst.port}`;

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('锚点轮盘工作台'));

    const statusRes = await (await fetch(`${base}/api/status`)).json();
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.version, PLUGIN_VERSION);
    assert.ok(Array.isArray(statusRes.compatibility?.testedAntigravityVersions));

    const updRes = await (await fetch(`${base}/api/update/check`)).json();
    assert.equal(updRes.ok, true);
    assert.equal(updRes.latestVersion, PLUGIN_VERSION);
    assert.equal(updRes.fromCache, true);

    // Invalid JSON returns 400 cleanly
    const badJsonRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(badJsonRes.status, 400);

    // Launcher generator writes pure 7-bit ASCII scripts on Windows
    const launchRes = await (
      await fetch(`${base}/api/launcher/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    ).json();
    assert.equal(launchRes.ok, true);
    if (process.platform === 'win32') {
      const cmdRaw = fs.readFileSync(launchRes.launcherPath, 'utf8');
      const vbsRaw = fs.readFileSync(launchRes.vbsPath, 'utf8');
      assert.equal(/^[\x00-\x7F]*$/.test(cmdRaw), true);
      assert.equal(/^[\x00-\x7F]*$/.test(vbsRaw), true);
      assert.ok(cmdRaw.includes('%~dp0'));
      assert.ok(vbsRaw.includes('%LOCALAPPDATA%'));
    }

    const readGbk = await (
      await fetch(`${base}/api/file/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: childFile }),
      })
    ).json();
    assert.equal(readGbk.ok, true);
    assert.equal(readGbk.isNonUtf8, true);
    assert.equal(readGbk.text, '中文\n');

    const linksRes = await (
      await fetch(`${base}/api/backlinks?path=${encodeURIComponent(childFile)}`)
    ).json();
    assert.equal(linksRes.ok, true);
    assert.equal(linksRes.backlinks.length, 1);
    assert.equal(linksRes.backlinks[0].sourceTitle, 'Overview');

    const pinRes = await (
      await fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 't1', op: 'pinAnchor', path: mdFile, title: 'Overview' }),
      })
    ).json();
    assert.equal(pinRes.ok, true);
    assert.equal(pinRes.session.groups.length, 1);

    const linRes = await (
      await fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 't1', op: 'recordLineage', parentPath: mdFile, childPath: childFile }),
      })
    ).json();
    assert.equal(linRes.ok, true);

    const navRes = await (
      await fetch(`${base}/api/nav-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 't1', path: childFile }),
      })
    ).json();
    assert.equal(navRes.ok, true);
    assert.equal(navRes.parent.title, 'Overview');

    const prevRes = await (
      await fetch(`${base}/api/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: childFile }),
      })
    ).json();
    assert.equal(prevRes.ok, true);
    assert.equal(prevRes.kind, 'text');
    assert.equal(prevRes.snippetText, '中文');

    // Directory listing, nav-context, and preview endpoints
    fs.mkdirSync(path.join(wsDir, 'ignored_subdir'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.env'), 'SECRET=1', 'utf8');
    const dirListRes = await (
      await fetch(`${base}/api/dir/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: wsDir }),
      })
    ).json();
    assert.equal(dirListRes.ok, true);
    assert.equal(dirListRes.isDirectory, true);
    assert.equal(dirListRes.skippedSubdirCount, 1);
    assert.equal(dirListRes.files.some((f) => f.name === '.env'), false);
    assert.equal(dirListRes.files.some((f) => f.name === 'overview.md'), true);

    const dirNavRes = await (
      await fetch(`${base}/api/nav-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 't-dir', path: wsDir, isDirectory: true }),
      })
    ).json();
    assert.equal(dirNavRes.ok, true);
    assert.equal(dirNavRes.current.isDirectory, true);
    assert.equal(dirNavRes.current.dirMeta.skippedSubdirCount, 1);
    assert.ok(dirNavRes.totalCurrentChildren >= 2);

    const dirPrevRes = await (
      await fetch(`${base}/api/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: wsDir }),
      })
    ).json();
    assert.equal(dirPrevRes.ok, true);
    assert.equal(dirPrevRes.kind, 'directory');
    assert.equal(dirPrevRes.subdirCount, 1);
    assert.equal(dirPrevRes.entries.some((e) => e.name === '.env'), false);

    const rtfFile = path.join(wsDir, 'sample.rtf');
    fs.writeFileSync(rtfFile, '{\\rtf1\\ansi\\ansicpg936 \\\'d6\\\'d0\\\'ce\\\'c4\\par Hello RTF}', 'latin1');
    const docRenderRes = await (
      await fetch(`${base}/api/doc/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: rtfFile }),
      })
    ).json();
    assert.equal(docRenderRes.ok, true);
    assert.equal(docRenderRes.format, 'rtf');
    assert.ok(docRenderRes.bodyHtml.includes('中文'));

    const openExtRes = await (
      await fetch(`${base}/api/file/open-external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: rtfFile, dryRun: true }),
      })
    ).json();
    assert.equal(openExtRes.ok, true);
    assert.equal(openExtRes.dryRun, true);

    for (const staticPath of ['/nav_shared.js', '/bilateral_wheel.js', '/ae_tree.js', '/settings_modal.js', '/doc_viewer.js']) {
      const sr = await fetch(`${base}${staticPath}`);
      assert.equal(sr.status, 200);
    }
  } finally {
    await inst.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
