import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../sidecars/anchor_wheel/main.mjs';

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
      currentVersion: '0.5.0',
      latestVersion: '0.5.0',
      tagName: 'v0.5.0',
      updateAvailable: false,
      repoUrl: 'https://github.com/Curelove/agy-anchor-wheel',
      releasesUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases',
      releaseUrl: 'https://github.com/Curelove/agy-anchor-wheel/releases/tag/v0.5.0',
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
    assert.equal(statusRes.version, '0.5.0');
    assert.ok(Array.isArray(statusRes.compatibility?.testedAntigravityVersions));

    const updRes = await (await fetch(`${base}/api/update/check`)).json();
    assert.equal(updRes.ok, true);
    assert.equal(updRes.latestVersion, '0.5.0');
    assert.equal(updRes.fromCache, true);

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

    for (const staticPath of ['/nav_shared.js', '/bilateral_wheel.js', '/ae_tree.js', '/settings_modal.js']) {
      const sr = await fetch(`${base}${staticPath}`);
      assert.equal(sr.status, 200);
    }
  } finally {
    await inst.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
