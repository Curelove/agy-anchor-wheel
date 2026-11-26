import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evictOverflowChildren,
  pushHistory,
  resolveAncestors,
  sanitizeCategoryRules,
  sanitizeSettings,
  StateStore,
  stepHistory,
  wouldCreateCycle,
} from '../sidecars/anchor_wheel/backend/state_store.mjs';
import { BacklinkIndex } from '../sidecars/anchor_wheel/backend/backlink_index.mjs';
import { buildNavContext, classifyFile } from '../sidecars/anchor_wheel/backend/nav_context.mjs';
import { canonicalKey } from '../sidecars/anchor_wheel/backend/security.mjs';

test('evictOverflowChildren protects anchor and locked children and evicts oldest unlocked LRU', () => {
  const ws = path.join(os.tmpdir(), 'aw-mock-ws');
  const group = {
    id: 'g1',
    anchorPath: path.join(ws, 'summary.md'),
    children: [
      { path: path.join(ws, 'a.md'), lastAccessedAt: 100, addedAt: 10, locked: true },
      { path: path.join(ws, 'b.md'), lastAccessedAt: 200, addedAt: 20, locked: false },
      { path: path.join(ws, 'c.md'), lastAccessedAt: 500, addedAt: 30, locked: false },
      { path: path.join(ws, 'd.md'), lastAccessedAt: 300, addedAt: 40, locked: false },
      { path: path.join(ws, 'e.md'), lastAccessedAt: 400, addedAt: 50, locked: false },
    ],
  };

  // maxChildren = 2 unlocked -> b.md (200) and d.md (300) should be evicted; a.md is locked so immune!
  const { group: next, evicted } = evictOverflowChildren(group, 2);
  assert.equal(evicted.length, 2);
  assert.deepEqual(
    evicted.map((x) => path.basename(x.path)).sort(),
    ['b.md', 'd.md']
  );
  assert.deepEqual(
    next.children.map((x) => path.basename(x.path)),
    ['a.md', 'c.md', 'e.md']
  );
});

test('history stack supports back, forward, scroll preservation, and branch truncation', () => {
  const ws = path.join(os.tmpdir(), 'aw-mock-hist');
  const pAnchor = path.join(ws, 'anchor.md');
  const pChild1 = path.join(ws, 'child1.md');
  const pChild2 = path.join(ws, 'child2.md');
  const pChild3 = path.join(ws, 'child3.md');

  let h = { entries: [], index: -1 };
  h = pushHistory(h, { path: pAnchor, scrollTop: 120 });
  h = pushHistory(h, { path: pChild1, scrollTop: 0 });
  h = pushHistory(h, { path: pChild2, scrollTop: 340 });
  assert.equal(h.index, 2);

  let step = stepHistory(h, -1);
  assert.equal(step.targetEntry.path, pChild1);
  step = stepHistory(step.historyState, -1);
  assert.equal(step.targetEntry.path, pAnchor);
  assert.equal(step.targetEntry.scrollTop, 120);

  // Branch off from anchor.md
  const branched = pushHistory(step.historyState, { path: pChild3 });
  assert.equal(branched.entries.length, 2);
  assert.equal(branched.entries[1].path, pChild3);
});

test('StateStore persists sessions, records recentlyEvicted, and restores evicted item', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-store-'));
  const ws = path.join(dataDir, 'ws');
  try {
    const store = new StateStore(dataDir);
    store.updateSettings({ maxChildrenPerGroup: 2 });
    store.pinAnchor('conv-1', { path: path.join(ws, 'master.md'), title: 'Master' });

    store.adoptChild('conv-1', { childPath: path.join(ws, 'f1.md') });
    store.adoptChild('conv-1', { childPath: path.join(ws, 'f2.md') });
    const r3 = store.adoptChild('conv-1', { childPath: path.join(ws, 'f3.md') });
    assert.equal(r3.evicted.length, 1);
    assert.equal(r3.session.recentlyEvicted.length, 1);

    const restored = store.restoreEvicted('conv-1', { path: r3.session.recentlyEvicted[0].path });
    assert.equal(restored.session.groups[0].children.length, 2);

    // Reload from disk
    const store2 = new StateStore(dataDir);
    assert.equal(store2.getSettings().maxChildrenPerGroup, 2);
    assert.equal(store2.getSession('conv-1').groups[0].anchorTitle, 'Master');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sanitizeSettings preserves mandatory 其他 fallback category and validates new dual-channel defaults', () => {
  const s = sanitizeSettings({
    middleMode: 'classic_wheel',
    tabMode: 'bilateral_wheel',
    tabCustomHotkey: 'Alt+Q',
    parentDirection: 'right',
    hoverPreviewDelayMs: 300,
    categoryRules: [
      { id: 'other', label: '其他', extensions: ['png'] },
      { id: 'sprites', label: '立绘', extensions: ['.PNG', 'WebP'] },
    ],
  });
  assert.equal(s.middleMode, 'classic_wheel');
  assert.equal(s.tabMode, 'bilateral_wheel');
  assert.equal(s.tabCustomHotkey, 'Alt+Q');
  assert.equal(s.parentDirection, 'right');
  assert.equal(s.hoverPreviewDelayMs, 300);
  // Explicit 'other' stripped from custom list; custom rule normalized cleanly
  assert.equal(s.categoryRules.length, 1);
  assert.equal(s.categoryRules[0].label, '立绘');
  assert.deepEqual(s.categoryRules[0].extensions, ['png', 'webp']);

  const rulesOnly = sanitizeCategoryRules([]);
  assert.ok(rulesOnly.length >= 1);
  assert.equal(classifyFile(path.join(os.tmpdir(), 'a.unknown'), s.categoryRules).id, 'other');
  assert.equal(classifyFile(path.join(os.tmpdir(), 'hero.PNG'), s.categoryRules).label, '立绘');
});

test('StateStore lineage resolves multi-level ancestors cleanly and rejects cycle edges', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-lin-'));
  const wsDir = path.join(tmpDir, 'ws');
  const dataDir = path.join(tmpDir, 'data');
  const brainDir = path.join(tmpDir, 'brain');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });

  const gp = path.join(wsDir, '00_grandparent.md');
  const p = path.join(wsDir, '01_parent.md');
  const cur = path.join(wsDir, '02_current.md');
  const img = path.join(wsDir, 'shot.png');
  const vid = path.join(wsDir, 'clip.mp4');
  const sib = path.join(wsDir, '01b_sibling.md');
  fs.writeFileSync(gp, `# GP\n[parent](./01_parent.md)\n[sib](./01b_sibling.md)\n`, 'utf8');
  fs.writeFileSync(p, `# Parent\n[cur](./02_current.md)\n`, 'utf8');
  fs.writeFileSync(cur, `# Current\n[shot](./shot.png)\n[clip](./clip.mp4)\n`, 'utf8');
  fs.writeFileSync(img, Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(vid, Buffer.from([0, 0, 0, 24]));
  fs.writeFileSync(sib, '# Sib', 'utf8');

  try {
    const store = new StateStore(dataDir);
    store.recordLineage('c1', { parentPath: gp, childPath: p });
    store.recordLineage('c1', { parentPath: p, childPath: cur });
    // Attempt reverse cycle cur -> gp should be ignored!
    const afterCycleTry = store.recordLineage('c1', { parentPath: cur, childPath: gp });
    assert.equal(wouldCreateCycle(afterCycleTry.lineage.parentByKey, canonicalKey(gp), canonicalKey(cur)), true);

    const ancs = resolveAncestors(afterCycleTry, cur);
    assert.equal(ancs.length, 2);
    assert.equal(path.basename(ancs[0].path), '00_grandparent.md');
    assert.equal(path.basename(ancs[1].path), '01_parent.md');

    const idx = new BacklinkIndex({ workspaceRoots: [wsDir], brainDir });
    idx.rescan({ force: true });

    // Record shot.png as opened tab so it sorts first with isOpenedTab: true
    const ctxAll = buildNavContext({
      stateStore: store,
      backlinkIndex: idx,
      conversationId: 'c1',
      activePath: cur,
      openTabs: [{ path: gp }, { path: p }, { path: cur }, { path: img }],
      scopeOverride: 'opened_and_outlinks',
    });
    assert.equal(ctxAll.ancestors.length, 2);
    assert.equal(ctxAll.ancestors[0].siblings.some((x) => path.basename(x.path) === '01b_sibling.md'), true);
    assert.equal(ctxAll.current.children.length, 2);
    assert.equal(path.basename(ctxAll.current.children[0].path), 'shot.png');
    assert.equal(ctxAll.current.children[0].isOpenedTab, true);
    assert.ok(ctxAll.categories.some((c) => c.id === 'other'));

    const ctxOpened = buildNavContext({
      stateStore: store,
      backlinkIndex: idx,
      conversationId: 'c1',
      activePath: cur,
      openTabs: [{ path: gp }, { path: p }, { path: cur }, { path: img }],
      scopeOverride: 'opened_only',
    });
    assert.equal(ctxOpened.current.children.length, 1);
    assert.equal(path.basename(ctxOpened.current.children[0].path), 'shot.png');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
