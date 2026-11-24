import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BacklinkIndex } from '../sidecars/anchor_wheel/backend/backlink_index.mjs';
import { buildNavContext, listDirectoryDirectFiles } from '../sidecars/anchor_wheel/backend/nav_context.mjs';
import { StateStore } from '../sidecars/anchor_wheel/backend/state_store.mjs';

test('listDirectoryDirectFiles sorts naturally, excludes subfolders/sensitive/OS junk, and caps large folders', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dir-nav-'));
  try {
    const mediaDir = path.join(tmpDir, 'shots');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(path.join(mediaDir, 'nested_a'));
    fs.mkdirSync(path.join(mediaDir, 'nested_b'));

    // Mixed numeric filenames + sensitive/hidden/OS junk files
    for (const name of [
      'shot_10.png',
      'shot_2.png',
      'shot_1.png',
      'clip_01.mp4',
      'notes.md',
      'archive.zip',
      '.env',
      '.DS_Store',
      'desktop.ini',
      'Thumbs.db',
      'id_rsa',
      '~$temp.docx',
    ]) {
      fs.writeFileSync(path.join(mediaDir, name), 'demo', 'utf8');
    }

    const res = listDirectoryDirectFiles(mediaDir, { includeStats: true });
    assert.equal(res.ok, true);
    assert.equal(res.skippedSubdirCount, 2);
    assert.equal(res.truncated, false);
    assert.equal(res.totalFiles, 6);
    assert.deepEqual(
      res.files.map((f) => f.name),
      ['archive.zip', 'clip_01.mp4', 'notes.md', 'shot_1.png', 'shot_2.png', 'shot_10.png']
    );
    assert.equal(typeof res.files[0].sizeBytes, 'number');

    // Verify maxFiles cap preserves natural order prefix and reports real totalFiles
    const capped = listDirectoryDirectFiles(mediaDir, { maxFiles: 3 });
    assert.equal(capped.ok, true);
    assert.equal(capped.truncated, true);
    assert.equal(capped.totalFiles, 6);
    assert.equal(capped.files.length, 3);
    assert.deepEqual(
      capped.files.map((f) => f.name),
      ['archive.zip', 'clip_01.mp4', 'notes.md']
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildNavContext categorizes directory direct files in natural order, supports 3-level lineage, and infers open parent folder only', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dir-ctx-'));
  const dataDir = path.join(tmpDir, 'data');
  const wsDir = path.join(tmpDir, 'ws');
  const folderDir = path.join(wsDir, 'omni_raw');
  const standaloneDir = path.join(wsDir, 'unrelated');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(folderDir, { recursive: true });
  fs.mkdirSync(path.join(folderDir, 'sub_ignore'), { recursive: true });
  fs.mkdirSync(standaloneDir, { recursive: true });

  const summaryMd = path.join(wsDir, 'summary.md');
  fs.writeFileSync(summaryMd, '# 汇总报告\n\n查看素材目录 [omni_raw](./omni_raw)\n', 'utf8');
  const f1 = path.join(folderDir, '01_frame.png');
  const f2 = path.join(folderDir, '02_frame.png');
  const f10 = path.join(folderDir, '10_frame.png');
  const fVid = path.join(folderDir, '03_cut.mp4');
  const fDoc = path.join(folderDir, '04_script.md');
  const fOther = path.join(folderDir, '05_data.bin');
  const soloFile = path.join(standaloneDir, 'solo.txt');
  for (const p of [f1, f2, f10, fVid, fDoc, fOther, soloFile]) {
    fs.writeFileSync(p, 'hello', 'utf8');
  }

  try {
    const store = new StateStore(dataDir);
    const index = new BacklinkIndex({ workspaceRoots: [wsDir], scanArtifacts: false });
    index.rescan({ force: true });

    // Outlink in summary.md pointing to folder without trailing slash should be marked isDirectory: true
    const sumLinks = index.getLinksForFile(summaryMd);
    assert.equal(sumLinks.outlinks.length, 1);
    assert.equal(sumLinks.outlinks[0].isDirectory, true);

    // 1. Directory view context: direct files categorized, natural order preserved even when 10_frame.png is opened
    const dirCtx = buildNavContext({
      stateStore: store,
      backlinkIndex: index,
      conversationId: 'c1',
      activePath: folderDir,
      openTabs: [
        { path: folderDir, isDirectory: true },
        { path: f10, isDirectory: false },
      ],
    });
    assert.equal(dirCtx.current.isDirectory, true);
    assert.equal(dirCtx.current.dirMeta.skippedSubdirCount, 1);
    assert.equal(dirCtx.totalCurrentChildren, 6);
    assert.deepEqual(
      dirCtx.current.children.map((c) => c.title),
      ['01_frame.png', '02_frame.png', '03_cut.mp4', '04_script.md', '05_data.bin', '10_frame.png']
    );
    const f10Item = dirCtx.current.children.find((c) => c.title === '10_frame.png');
    assert.equal(f10Item.isOpenedTab, true);

    const imgCat = dirCtx.categories.find((c) => c.id === 'image');
    const vidCat = dirCtx.categories.find((c) => c.id === 'video');
    const docCat = dirCtx.categories.find((c) => c.id === 'doc');
    const othCat = dirCtx.categories.find((c) => c.id === 'other');
    assert.deepEqual(imgCat.items.map((i) => i.title), ['01_frame.png', '02_frame.png', '10_frame.png']);
    assert.deepEqual(vidCat.items.map((i) => i.title), ['03_cut.mp4']);
    assert.deepEqual(docCat.items.map((i) => i.title), ['04_script.md']);
    assert.deepEqual(othCat.items.map((i) => i.title), ['05_data.bin']);

    // opened_only scope filters directory files down to opened tabs only
    const dirOpenedOnly = buildNavContext({
      stateStore: store,
      backlinkIndex: index,
      conversationId: 'c1',
      activePath: folderDir,
      openTabs: [
        { path: folderDir, isDirectory: true },
        { path: f10, isDirectory: false },
      ],
      scopeOverride: 'opened_only',
    });
    assert.deepEqual(dirOpenedOnly.current.children.map((c) => c.title), ['10_frame.png']);

    // 2. Standalone file WITHOUT open enclosing folder -> parent MUST stay null (no false parent inference)
    const soloCtx = buildNavContext({
      stateStore: store,
      backlinkIndex: index,
      conversationId: 'c1',
      activePath: soloFile,
      openTabs: [{ path: soloFile, isDirectory: false }],
    });
    assert.equal(soloCtx.parent, null);

    // 3. File opened while its enclosing folder IS open as a tab -> infers parent folder cleanly
    const inferredParentCtx = buildNavContext({
      stateStore: store,
      backlinkIndex: index,
      conversationId: 'c1',
      activePath: f2,
      openTabs: [
        { path: folderDir, isDirectory: true },
        { path: f2, isDirectory: false },
      ],
    });
    assert.equal(inferredParentCtx.parent?.isDirectory, true);
    assert.equal(inferredParentCtx.parent?.inferred, true);
    assert.equal(inferredParentCtx.parent?.title, 'omni_raw');
    assert.equal(inferredParentCtx.parent?.siblings.some((s) => s.title === '01_frame.png'), true);
    assert.equal(inferredParentCtx.parent?.siblings.some((s) => s.title === '02_frame.png'), false);

    // 4. Explicit 3-level lineage: summary.md -> omni_raw (dir) -> 02_frame.png
    store.recordLineage('c2', {
      parentPath: summaryMd,
      parentTitle: '汇总报告',
      parentIsDirectory: false,
      childPath: folderDir,
      childTitle: 'omni_raw',
      childIsDirectory: true,
    });
    store.recordLineage('c2', {
      parentPath: folderDir,
      parentTitle: 'omni_raw',
      parentIsDirectory: true,
      childPath: f2,
      childTitle: '02_frame.png',
      childIsDirectory: false,
    });
    const threeLevel = buildNavContext({
      stateStore: store,
      backlinkIndex: index,
      conversationId: 'c2',
      activePath: f2,
    });
    assert.equal(threeLevel.ancestors.length, 2);
    assert.equal(threeLevel.ancestors[0].title, '汇总报告');
    assert.equal(threeLevel.ancestors[0].isDirectory, false);
    assert.equal(threeLevel.ancestors[1].title, 'omni_raw');
    assert.equal(threeLevel.ancestors[1].isDirectory, true);
    assert.equal(threeLevel.parent.isDirectory, true);

    // 5. History and Priority Anchor preserve isDirectory flag
    store.pinAnchor('c2', { path: folderDir, title: 'omni_raw', isDirectory: true });
    const hRes = store.navigateHistory('c2', {
      action: 'push',
      entry: { path: folderDir, title: 'omni_raw', isDirectory: true },
    });
    assert.equal(hRes.targetEntry.isDirectory, true);
    const sess = store.getSession('c2');
    assert.equal(sess.groups[0].anchorIsDirectory, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
