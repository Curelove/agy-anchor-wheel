import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCompatTarget,
  getExpectedArtifacts,
  parseReleaseNotesMarkdown,
  readRepoMetadata,
  resolveReleaseNotes,
} from '../scripts/publish-release.mjs';
import { extractTargetAgyFromNotes } from '../sidecars/anchor_wheel/backend/update_service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('release pipeline metadata matches plugin.json, package.json, and compatibility.json', () => {
  const meta = readRepoMetadata(ROOT);
  assert.match(meta.version, /^\d+\.\d+\.\d+/);
  assert.equal(meta.tag, `v${meta.version}`);
  assert.equal(extractCompatTarget(meta.compatibility), '2.34.x');

  const expected = getExpectedArtifacts(meta.version, ROOT).map((p) => path.basename(p));
  assert.deepEqual(expected, [
    `agy-anchor-wheel-v${meta.version}.zip`,
    `agy-anchor-wheel-v${meta.version}.tar.gz`,
    `agy-anchor-wheel-v${meta.version}.tar.gz.sha256`,
  ]);
});

test('parseReleaseNotesMarkdown extracts title and guarantees aw-compat metadata', () => {
  const parsed = parseReleaseNotesMarkdown('# v9.9.9 — Test Release\n\n- Feature A\n- Feature B', {
    tag: 'v9.9.9',
    version: '9.9.9',
    compatibility: { testedRange: 'Antigravity 2.34.x' },
  });
  assert.equal(parsed.title, 'v9.9.9 — Test Release');
  assert.equal(extractTargetAgyFromNotes(parsed.body), '2.34.x');
  assert.ok(parsed.body.includes('- Feature A'));
});

test('current version release notes and GitHub Actions workflow are configured cleanly', () => {
  const meta = readRepoMetadata(ROOT);
  const notes = resolveReleaseNotes({
    repoRoot: ROOT,
    tag: meta.tag,
    version: meta.version,
    compatibility: meta.compatibility,
  });
  assert.ok(notes.title.includes(meta.tag));
  assert.equal(extractTargetAgyFromNotes(notes.body), '2.34.x');

  const wfPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
  assert.equal(fs.existsSync(wfPath), true);
  const wf = fs.readFileSync(wfPath, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(wf.includes("tags:\n      - 'v*'"));
  assert.ok(wf.includes('workflow_dispatch:'));
  assert.ok(wf.includes('contents: write'));
  assert.ok(wf.includes('npm test'));
  assert.ok(wf.includes('npm run package:release'));
  assert.ok(wf.includes('gh release create'));
  assert.ok(wf.includes('gh release upload'));
});
