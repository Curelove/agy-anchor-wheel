import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BacklinkIndex } from '../sidecars/anchor_wheel/backend/backlink_index.mjs';
import { normalizeFilePath, toFileUri } from '../sidecars/anchor_wheel/backend/security.mjs';

test('indexes markdown links, wikilinks, inline paths, artifact brain MDs, and detects dead links', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-idx-'));
  try {
    const ws = path.join(tmpRoot, 'workspace');
    const brain = path.join(tmpRoot, 'brain');
    const convDir = path.join(brain, 'conv-1234');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(convDir, { recursive: true });

    const codeFile = path.join(ws, 'src', 'engine.py');
    fs.writeFileSync(codeFile, 'print("ok")\n', 'utf8');

    const guideMd = path.join(ws, 'guide.md');
    fs.writeFileSync(guideMd, '# 操作指南\n见 `src/engine.py` 和 [[missing_note]]\n', 'utf8');

    const summaryArtifact = path.join(convDir, 'summary_report.md');
    const fileUrl = `file:///${codeFile.replace(/\\/g, '/')}`;
    fs.writeFileSync(
      summaryArtifact,
      `# AI 验收总览\n\n- 核心脚本：[engine.py](${fileUrl}#L1)\n- 说明书：[操作指南](${guideMd})\n- 失效文件：[ghost.md](${path.join(ws, 'ghost.md')})\n`,
      'utf8'
    );

    const idx = new BacklinkIndex({
      workspaceRoots: [ws],
      brainDir: brain,
      scanWorkspace: true,
      scanArtifacts: true,
    });
    const stats = idx.rescan({ force: true });
    assert.equal(stats.markdownFiles, 2);

    const engineLinks = idx.getLinksForFile(codeFile);
    assert.equal(engineLinks.backlinks.length, 2);
    assert.ok(engineLinks.backlinks.some((b) => b.isArtifact && b.sourceTitle === 'AI 验收总览'));
    assert.ok(engineLinks.backlinks.some((b) => !b.isArtifact && b.sourceTitle === '操作指南'));

    const summaryLinks = idx.getLinksForFile(summaryArtifact);
    assert.equal(summaryLinks.outlinks.length, 3);
    const dead = summaryLinks.outlinks.find((o) => o.label === 'ghost.md');
    assert.equal(dead.exists, false);
    const alive = summaryLinks.outlinks.find((o) => o.label === 'engine.py');
    assert.equal(alive.exists, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('strips NUL-delimited composite workspace URI prefixes cleanly', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-nul-'));
  try {
    const ws = path.join(tmpRoot, 'proj');
    const brain = path.join(tmpRoot, 'brain');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(brain, { recursive: true });
    fs.writeFileSync(path.join(ws, 'note.md'), '# Note\nSee `other.md`\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'other.md'), '# Other\n', 'utf8');

    const compositeUri = `a27e5050-55d1-4afc-96a8-155b4e86c798\u0000${toFileUri(ws)}`;
    assert.equal(normalizeFilePath(compositeUri), path.normalize(ws));

    const idx = new BacklinkIndex({ brainDir: brain, scanWorkspace: true, scanArtifacts: false });
    idx.updateConfig({ workspaceRoots: [compositeUri] });
    const stats = idx.rescan({ force: true });
    assert.equal(stats.workspaceRoots[0], path.normalize(ws));
    assert.equal(stats.markdownFiles, 2);
    assert.equal(idx.getLinksForFile(path.join(ws, 'other.md')).backlinks.length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('parses outlinks on demand for Markdown files outside workspace/brain roots', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ondemand-'));
  try {
    const ws = path.join(tmpRoot, 'ws');
    const extDir = path.join(tmpRoot, 'external_skills');
    const brain = path.join(tmpRoot, 'brain');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(brain, { recursive: true });

    const helperFile = path.join(extDir, 'helper.mjs');
    fs.writeFileSync(helperFile, 'export const ok = true;\n', 'utf8');
    const extMd = path.join(extDir, 'SKILL.md');
    fs.writeFileSync(
      extMd,
      '# External Skill\nUses `helper.mjs` and [missing](./nope.md)\n',
      'utf8'
    );

    const idx = new BacklinkIndex({ workspaceRoots: [ws], brainDir: brain });
    idx.rescan({ force: true });
    assert.equal(idx.getStats().markdownFiles, 0);

    const res = idx.getLinksForFile(extMd);
    assert.equal(res.title, 'External Skill');
    assert.equal(res.exists, true);
    assert.equal(res.outlinks.length, 2);
    const hitAlive = res.outlinks.find((o) => o.label === 'helper.mjs');
    const hitDead = res.outlinks.find((o) => o.label === 'missing');
    assert.equal(hitAlive?.exists, true);
    assert.equal(hitDead?.exists, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('decodes double-encoded Chinese file URIs and avoids duplicate dead entries from backticked link labels', () => {
  const doubleEnc = 'file:///c%3A/Users/demo/notes/01_%25E5%2589%25A7%25E6%259C%25AC.md';
  assert.equal(
    normalizeFilePath(doubleEnc),
    path.normalize('c:\\Users\\demo\\notes\\01_剧本.md')
  );

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-backtick-'));
  try {
    const parentMd = path.join(tmpRoot, '01_剧本.md');
    const subDir = path.join(tmpRoot, 'sub');
    const childMd = path.join(subDir, 'report.md');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(parentMd, '# Parent\n', 'utf8');
    fs.writeFileSync(
      childMd,
      '# Report\n- Missing first: [nope](./missing.md)\n- Backticked link: [`01_剧本.md`](../01_剧本.md)\n',
      'utf8'
    );

    const idx = new BacklinkIndex({ workspaceRoots: [tmpRoot], scanWorkspace: true, scanArtifacts: false });
    idx.rescan({ force: true });
    const res = idx.getLinksForFile(childMd);
    // Exactly 2 outlinks (01_剧本.md alive + nope dead), no false-dead inline_path duplicate for `01_剧本.md`
    assert.equal(res.outlinks.length, 2);
    // Alive link is sorted before dead link
    assert.equal(res.outlinks[0].exists, true);
    assert.equal(res.outlinks[0].label, '`01_剧本.md`');
    assert.equal(res.outlinks[1].exists, false);
    assert.equal(res.outlinks[1].label, 'nope');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
