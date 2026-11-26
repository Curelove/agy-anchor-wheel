import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildRevealCommand,
  resolveSafeExplorerTarget,
  revealInSystemExplorer,
} from '../sidecars/anchor_wheel/backend/system_explorer.mjs';

test('buildRevealCommand produces safe platform-specific explorer commands across win32, darwin, and linux', () => {
  const winDir = buildRevealCommand('C:\\Users\\demo\\中文 目录,测试\\dist', {
    isDirectory: true,
    platform: 'win32',
  });
  assert.equal(winDir.command, 'explorer.exe');
  assert.deepEqual(winDir.args, ['"C:\\Users\\demo\\中文 目录,测试\\dist"']);
  assert.equal(winDir.spawnOptions.windowsVerbatimArguments, true);
  assert.equal(winDir.spawnOptions.detached, true);

  const winRoot = buildRevealCommand('C:\\', {
    isDirectory: true,
    platform: 'win32',
  });
  assert.equal(winRoot.command, 'explorer.exe');
  assert.deepEqual(winRoot.args, ['C:\\']);

  const winFile = buildRevealCommand('C:\\Users\\demo\\中文 目录,测试\\a b.zip', {
    isDirectory: false,
    platform: 'win32',
  });
  assert.equal(winFile.command, 'explorer.exe');
  assert.deepEqual(winFile.args, ['/select,"C:\\Users\\demo\\中文 目录,测试\\a b.zip"']);
  assert.equal(winFile.spawnOptions.windowsVerbatimArguments, true);

  const macDir = buildRevealCommand('/Users/demo/My Project/dist', {
    isDirectory: true,
    platform: 'darwin',
  });
  assert.equal(macDir.command, 'open');
  assert.deepEqual(macDir.args, ['/Users/demo/My Project/dist']);

  const macFile = buildRevealCommand('/Users/demo/My Project/dist/app.zip', {
    isDirectory: false,
    platform: 'darwin',
  });
  assert.equal(macFile.command, 'open');
  assert.deepEqual(macFile.args, ['-R', '/Users/demo/My Project/dist/app.zip']);

  const linuxDir = buildRevealCommand('/home/demo/project/dist', {
    isDirectory: true,
    platform: 'linux',
  });
  assert.equal(linuxDir.command, 'xdg-open');
  assert.deepEqual(linuxDir.args, ['/home/demo/project/dist']);

  const linuxFile = buildRevealCommand('/home/demo/project/dist/archive.tar.gz', {
    isDirectory: false,
    platform: 'linux',
  });
  assert.equal(linuxFile.command, 'xdg-open');
  assert.deepEqual(linuxFile.args, ['/home/demo/project/dist']);
});

test('resolveSafeExplorerTarget and revealInSystemExplorer dryRun handle directories, files, preferDirectory, and security blocks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-explorer-'));
  const subDir = path.join(tmpDir, '中文 文件夹,样本');
  const sshDir = path.join(tmpDir, '.ssh');
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(sshDir, { recursive: true });

  const zipFile = path.join(subDir, 'bundle v0.8.1.zip');
  const envFile = path.join(subDir, '.env');
  const vaultFile = path.join(subDir, 'private_vault.json');
  fs.writeFileSync(zipFile, 'PK\x05\x06', 'binary');
  fs.writeFileSync(envFile, 'SECRET=1', 'utf8');
  fs.writeFileSync(vaultFile, '{}', 'utf8');

  try {
    // 1. Directory reveal (both raw path and file:// URI)
    const dirRes = revealInSystemExplorer(subDir, { dryRun: true });
    assert.equal(dirRes.ok, true);
    assert.equal(dirRes.dryRun, true);
    assert.equal(dirRes.mode, 'open-dir');
    assert.equal(dirRes.isDirectory, true);
    assert.equal(dirRes.targetPath, fs.realpathSync(subDir));

    const dirUriRes = revealInSystemExplorer(pathToFileURL(subDir).href, { dryRun: true });
    assert.equal(dirUriRes.ok, true);
    assert.equal(dirUriRes.isDirectory, true);
    assert.equal(dirUriRes.targetPath, fs.realpathSync(subDir));

    // 2. Arbitrary file reveal (never restricted by executable extension list since it does not execute!)
    const fileRes = revealInSystemExplorer(zipFile, { dryRun: true });
    assert.equal(fileRes.ok, true);
    assert.equal(fileRes.mode, 'reveal-file');
    assert.equal(fileRes.isDirectory, false);
    assert.equal(fileRes.targetPath, fs.realpathSync(zipFile));
    assert.equal(fileRes.dirPath, fs.realpathSync(subDir));

    // 3. preferDirectory opens parent directory of a file
    const parentRes = revealInSystemExplorer(zipFile, { preferDirectory: true, dryRun: true });
    assert.equal(parentRes.ok, true);
    assert.equal(parentRes.mode, 'open-dir');
    assert.equal(parentRes.isDirectory, true);
    assert.equal(parentRes.targetPath, fs.realpathSync(subDir));

    // 4. Non-existent path fails cleanly
    const missing = resolveSafeExplorerTarget(path.join(subDir, 'does_not_exist'));
    assert.equal(missing.ok, false);

    // 5. Security blocks: UNC paths, relative paths, sensitive files & dirs
    assert.equal(resolveSafeExplorerTarget('').ok, false);
    assert.equal(resolveSafeExplorerTarget('relative/folder').ok, false);
    assert.equal(resolveSafeExplorerTarget('\\\\fileserver\\share\\folder').ok, false);
    assert.equal(resolveSafeExplorerTarget('//fileserver/share/folder').ok, false);
    assert.equal(resolveSafeExplorerTarget(envFile).ok, false);
    assert.equal(resolveSafeExplorerTarget(vaultFile).ok, false);
    assert.equal(resolveSafeExplorerTarget(sshDir).ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
