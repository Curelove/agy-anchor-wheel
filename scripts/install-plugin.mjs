import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_NAME = 'agy-anchor-wheel';
const TARGET_ROOT = path.join(os.homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);
const BACKUP_AUTO_DIR = path.join(REPO_ROOT, 'backups', 'auto');
const BACKUP_LATEST_DIR = path.join(REPO_ROOT, 'backups', 'latest-current');

const DEPLOY_ENTRIES = ['plugin.json', 'agy-market.json', 'package.json', 'README.md', 'LICENSE', 'assets', 'skills', 'sidecars'];

function formatStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function copyDirRecursive(src, dst, { skipNames = new Set() } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(s, d, { skipNames });
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function pruneOldAutoBackups(maxKeep = 15) {
  if (!fs.existsSync(BACKUP_AUTO_DIR)) return;
  const dirs = fs
    .readdirSync(BACKUP_AUTO_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  while (dirs.length > maxKeep) {
    const oldest = dirs.shift();
    fs.rmSync(path.join(BACKUP_AUTO_DIR, oldest), { recursive: true, force: true });
  }
}

function backupInstalledCopyIfExists() {
  if (!fs.existsSync(TARGET_ROOT)) return null;
  const stamp = formatStamp();
  const snapDir = path.join(BACKUP_AUTO_DIR, stamp);
  copyDirRecursive(TARGET_ROOT, snapDir, { skipNames: new Set(['data', 'backups', '.git']) });
  pruneOldAutoBackups(15);
  return snapDir;
}

function deploy() {
  const backupPath = backupInstalledCopyIfExists();
  if (backupPath) {
    console.log(`[install] Backed up previous installed version to ${backupPath}`);
  }

  fs.mkdirSync(TARGET_ROOT, { recursive: true });
  for (const entry of DEPLOY_ENTRIES) {
    const src = path.join(REPO_ROOT, entry);
    const dst = path.join(TARGET_ROOT, entry);
    if (!fs.existsSync(src)) continue;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      // Overwrite files in-place without deleting directories (avoids Windows EPERM when sidecar cwd locks a folder)
      copyDirRecursive(src, dst, { skipNames: new Set(['data', 'node_modules', '.git']) });
    } else {
      fs.copyFileSync(src, dst);
    }
  }

  // Refresh backups/latest-current snapshot
  if (fs.existsSync(BACKUP_LATEST_DIR)) {
    fs.rmSync(BACKUP_LATEST_DIR, { recursive: true, force: true });
  }
  copyDirRecursive(TARGET_ROOT, BACKUP_LATEST_DIR, { skipNames: new Set(['data', 'backups', '.git']) });

  console.log(`[install] Deployed ${PLUGIN_NAME} -> ${TARGET_ROOT}`);
  console.log('[install] Preserved existing data/ directory if present.');
}

deploy();
