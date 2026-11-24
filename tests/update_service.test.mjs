import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UpdateService,
  compareSemver,
  evaluateCompatibility,
  extractTargetAgyFromNotes,
  parseGithubRepo,
  parseReleasesAtom,
} from '../sidecars/anchor_wheel/backend/update_service.mjs';

test('parseGithubRepo and compareSemver handle GitHub URLs and tags cleanly', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/Curelove/agy-anchor-wheel'), {
    owner: 'Curelove',
    repo: 'agy-anchor-wheel',
  });
  assert.deepEqual(parseGithubRepo('git@github.com:Curelove/agy-anchor-wheel.git'), {
    owner: 'Curelove',
    repo: 'agy-anchor-wheel',
  });

  assert.equal(compareSemver('0.5.0', '0.4.0'), 1);
  assert.equal(compareSemver('v0.5.0', '0.5.0'), 0);
  assert.equal(compareSemver('0.4.9', '0.5.0'), -1);
  assert.equal(compareSemver('0.5.0', '0.5.0-beta.1'), 1);
});

test('extractTargetAgyFromNotes and evaluateCompatibility classify Antigravity versions', () => {
  const body = '<!-- aw-compat: agy=2.34.x -->\n### 更新说明\n- 修复问题';
  assert.equal(extractTargetAgyFromNotes(body), '2.34.x');
  assert.equal(extractTargetAgyFromNotes('适配 Antigravity：2.35.0\n其他内容'), '2.35.0');

  const manifestCompat = { testedAntigravityVersions: ['2.34.0'], testedRange: 'Antigravity 2.34.x' };
  assert.equal(evaluateCompatibility('2.34.0', manifestCompat).compatLevel, 'verified');
  assert.equal(evaluateCompatibility('2.34.2', manifestCompat).compatLevel, 'verified');
  assert.equal(evaluateCompatibility('2.36.0', manifestCompat).compatLevel, 'same_major');
  assert.equal(evaluateCompatibility('3.0.0', manifestCompat).compatLevel, 'untested');
  assert.equal(evaluateCompatibility('', manifestCompat).compatLevel, 'unknown');
});

test('UpdateService checks latest GitHub release, caches result, and handles offline errors gracefully', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-upd-'));
  const fakePluginRoot = path.join(tmpDir, 'plugin');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(fakePluginRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    path.join(fakePluginRoot, 'plugin.json'),
    JSON.stringify({
      name: 'agy-anchor-wheel',
      version: '0.4.0',
      repository: { url: 'https://github.com/Curelove/agy-anchor-wheel' },
      compatibility: { testedAntigravityVersions: ['2.34.0'], testedRange: 'Antigravity 2.34.x' },
    }),
    'utf8'
  );

  let fetchCalls = 0;
  try {
    const svc = new UpdateService({
      dataDir,
      pluginRoot: fakePluginRoot,
      detectAgyImpl: () => '2.34.0',
      detectProxyImpl: () => 'http://127.0.0.1:7897',
      fetchJsonImpl: async (url, opts) => {
        fetchCalls++;
        assert.equal(opts.proxyUrl, 'http://127.0.0.1:7897');
        assert.ok(url.includes('/repos/Curelove/agy-anchor-wheel/releases/latest'));
        return {
          tag_name: 'v0.5.0',
          name: 'AnchorWheel v0.5.0',
          html_url: 'https://github.com/Curelove/agy-anchor-wheel/releases/tag/v0.5.0',
          published_at: '2026-11-24T03:00:00Z',
          body: '<!-- aw-compat: agy=2.34.x -->\n- 修复预览残留',
          assets: [
            {
              name: 'agy-anchor-wheel-v0.5.0.zip',
              size: 123456,
              browser_download_url: 'https://github.com/Curelove/agy-anchor-wheel/releases/download/v0.5.0/agy-anchor-wheel-v0.5.0.zip',
            },
          ],
        };
      },
    });

    const first = await svc.checkForUpdates({ force: false });
    assert.equal(first.ok, true);
    assert.equal(first.latestVersion, '0.5.0');
    assert.equal(first.currentVersion, '0.4.0');
    assert.equal(first.updateAvailable, true);
    assert.equal(first.targetAntigravity, '2.34.x');
    assert.equal(first.localAntigravity.compatLevel, 'verified');
    assert.equal(first.assets.length, 1);
    assert.equal(fetchCalls, 1);

    // Within 6h TTL, should hit cache
    const second = await svc.checkForUpdates({ force: false });
    assert.equal(second.fromCache, true);
    assert.equal(fetchCalls, 1);

    // Force refresh ignores cache
    const third = await svc.checkForUpdates({ force: true });
    assert.equal(third.fromCache, false);
    assert.equal(fetchCalls, 2);

    // Graceful failure on network error when both API and Atom fail
    const errSvc = new UpdateService({
      dataDir,
      pluginRoot: fakePluginRoot,
      detectAgyImpl: () => '2.34.0',
      detectProxyImpl: () => '',
      fetchJsonImpl: async () => {
        throw new Error('connect ETIMEDOUT');
      },
      fetchTextImpl: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    });
    const failed = await errSvc.checkForUpdates({ force: true });
    assert.equal(failed.ok, false);
    assert.ok(failed.error.includes('ETIMEDOUT'));

    // Fallback to releases.atom when api.github.com returns HTTP 403 rate limit!
    const sampleAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from agy-anchor-wheel</title>
  <entry>
    <id>tag:github.com,2008:Repository/12345/v0.5.0</id>
    <updated>2026-11-24T03:05:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/Curelove/agy-anchor-wheel/releases/tag/v0.5.0"/>
    <title>v0.5.0 — 修复悬停预览卡死残留</title>
    <content type="html">&lt;!-- aw-compat: agy=2.34.x --&gt;&lt;p&gt;修复预览残留，适配 Antigravity 2.34.0&lt;/p&gt;</content>
  </entry>
</feed>`;
    const parsedAtom = parseReleasesAtom(sampleAtom, 'https://github.com/Curelove/agy-anchor-wheel');
    assert.equal(parsedAtom?.tag_name, 'v0.5.0');
    assert.equal(parsedAtom?.targetAntigravity, '2.34.x');

    const atomSvc = new UpdateService({
      dataDir,
      pluginRoot: fakePluginRoot,
      detectAgyImpl: () => '2.34.0',
      detectProxyImpl: () => 'http://127.0.0.1:7897',
      fetchJsonImpl: async () => {
        const err = new Error('HTTP 403');
        err.statusCode = 403;
        throw err;
      },
      fetchTextImpl: async (url) => {
        assert.equal(url, 'https://github.com/Curelove/agy-anchor-wheel/releases.atom');
        return sampleAtom;
      },
    });
    const atomRes = await atomSvc.checkForUpdates({ force: true });
    assert.equal(atomRes.ok, true);
    assert.equal(atomRes.source, 'github_atom');
    assert.equal(atomRes.latestVersion, '0.5.0');
    assert.equal(atomRes.updateAvailable, true);
    assert.equal(atomRes.targetAntigravity, '2.34.x');
    assert.equal(atomRes.releaseUrl, 'https://github.com/Curelove/agy-anchor-wheel/releases/tag/v0.5.0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
