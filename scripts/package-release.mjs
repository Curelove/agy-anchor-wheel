import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function copyFiltered(src, dst, skipNames = new Set(['data', 'backups', 'node_modules', '.git', 'dist', 'scratch'])) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (skipNames.has(ent.name)) continue;
      copyFiltered(path.join(src, ent.name), path.join(dst, ent.name), skipNames);
    }
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function buildReleaseZip() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = String(manifest.version || '').trim();
  const pkgVersion = String(pkg.version || '').trim();
  if (!version) {
    throw new Error('plugin.json is missing a valid version');
  }
  if (pkgVersion !== version) {
    throw new Error(`Version mismatch: plugin.json (${version}) !== package.json (${pkgVersion})`);
  }
  const distDir = path.join(REPO_ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const outZip = path.join(distDir, `agy-anchor-wheel-v${version}.zip`);
  if (fs.existsSync(outZip)) fs.rmSync(outZip, { force: true });

  const stageTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-release-'));
  const stageRoot = path.join(stageTmp, 'agy-anchor-wheel');
  fs.mkdirSync(stageRoot, { recursive: true });

  const entries = [
    'plugin.json',
    'package.json',
    'README.md',
    'LICENSE',
    'install-plugin.cmd',
    'assets',
    'sidecars',
    path.join('scripts', 'install-plugin.mjs'),
    path.join('scripts', 'remove-plugin.mjs'),
  ];

  try {
    for (const rel of entries) {
      const src = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`Missing required release file: ${rel}`);
      }
      copyFiltered(src, path.join(stageRoot, rel));
    }

    if (process.platform === 'win32') {
      const psCmd = `Compress-Archive -Path '${stageRoot.replace(/'/g, "''")}' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit' });
    } else {
      execFileSync('zip', ['-r', outZip, 'agy-anchor-wheel'], { cwd: stageTmp, stdio: 'inherit' });
    }

    const bytes = fs.statSync(outZip).size;
    console.log(`[package:release] Created ${outZip} (${(bytes / 1024).toFixed(1)} KB)`);
    return outZip;
  } finally {
    fs.rmSync(stageTmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  }
}

buildReleaseZip();
