#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export function readRepoMetadata(repoRoot = REPO_ROOT) {
  const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = String(plugin.version || '').trim();
  const pkgVersion = String(pkg.version || '').trim();
  if (!version) throw new Error('plugin.json is missing a valid version');
  if (version !== pkgVersion) {
    throw new Error(`Version mismatch: plugin.json (${version}) !== package.json (${pkgVersion})`);
  }

  let compatibility = {};
  const compatPath = path.join(repoRoot, 'sidecars', 'anchor_wheel', 'compatibility.json');
  if (fs.existsSync(compatPath)) {
    try {
      compatibility = JSON.parse(fs.readFileSync(compatPath, 'utf8'));
    } catch {
      compatibility = {};
    }
  }

  return {
    name: String(plugin.name || 'agy-anchor-wheel'),
    version,
    tag: `v${version}`,
    compatibility,
  };
}

export function extractCompatTarget(compatibility = {}) {
  const range = String(compatibility?.testedRange || '').trim();
  const mRange = /([0-9]+\.[0-9]+\.[0-9A-Za-z._-]+)/.exec(range);
  if (mRange?.[1]) return mRange[1];
  const first = Array.isArray(compatibility?.testedAntigravityVersions)
    ? String(compatibility.testedAntigravityVersions[0] || '').trim()
    : '';
  return first || '2.34.x';
}

export function parseReleaseNotesMarkdown(rawMarkdown, { tag, version, compatibility = {} } = {}) {
  const normalized = String(rawMarkdown || '').replace(/\r\n/g, '\n').trim();
  const fallbackTitle = `AnchorWheel ${tag || `v${version}`}`;
  const compatTarget = extractCompatTarget(compatibility);

  let title = fallbackTitle;
  let body = normalized;

  const h1Match = /^#\s+(.+?)\s*(?:\n+([\s\S]*))?$/.exec(normalized);
  if (h1Match) {
    title = h1Match[1].trim();
    body = (h1Match[2] || '').trim();
  }

  if (!body) {
    body = [
      `### 更新说明（${tag || `v${version}`}）`,
      '',
      `- 预构建 \`agy-anchor-wheel-v${version}.tar.gz\`（含 \`.sha256\` 校验，供 AGY Market 安装升级）与 \`agy-anchor-wheel-v${version}.zip\`（解压后双击 \`install-plugin.cmd\` 手动安装）。`,
      `- 适配 Antigravity：\`${compatTarget}\`（本地需 Node.js >= 22）`,
    ].join('\n');
  }

  if (!/<!--\s*aw-compat:\s*agy=/i.test(body)) {
    body = `<!-- aw-compat: agy=${compatTarget} -->\n\n${body}`;
  }

  return { title, body: `${body.trim()}\n` };
}

export function resolveReleaseNotes({ repoRoot = REPO_ROOT, tag, version, compatibility = {}, notesFile = '' } = {}) {
  const candidates = [];
  if (notesFile) {
    candidates.push(path.isAbsolute(notesFile) ? notesFile : path.join(repoRoot, notesFile));
  }
  candidates.push(path.join(repoRoot, 'docs', 'releases', `${tag}.md`));
  candidates.push(path.join(repoRoot, 'docs', 'releases', `v${version}.md`));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8');
      return {
        source: candidate,
        ...parseReleaseNotesMarkdown(raw, { tag, version, compatibility }),
      };
    }
  }

  // Fallback to annotated git tag body when no docs/releases/<tag>.md exists
  let tagMessage = '';
  try {
    tagMessage = execFileSync('git', ['tag', '-l', '--format=%(contents)', tag], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    tagMessage = '';
  }

  const fallbackMd = tagMessage
    ? `# ${tag}\n\n${tagMessage}`
    : `# AnchorWheel ${tag}\n`;

  return {
    source: tagMessage ? `git-tag:${tag}` : 'generated-default',
    ...parseReleaseNotesMarkdown(fallbackMd, { tag, version, compatibility }),
  };
}

export function findGhExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        'gh.exe',
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
      ]
    : ['gh', '/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];

  for (const cand of candidates) {
    if (!cand) continue;
    if (path.isAbsolute(cand)) {
      if (fs.existsSync(cand)) return cand;
      continue;
    }
    try {
      execFileSync(cand, ['--version'], { stdio: 'ignore' });
      return cand;
    } catch {
      // keep searching
    }
  }
  return null;
}

export function parseArgs(argv = []) {
  const opts = {
    tag: '',
    notesFile: '',
    prepareOnly: false,
    outTitle: '',
    outBody: '',
    skipTest: false,
    skipPackage: false,
    dryRun: false,
    draft: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag' && argv[i + 1]) opts.tag = argv[++i];
    else if (a === '--notes-file' && argv[i + 1]) opts.notesFile = argv[++i];
    else if (a === '--out-title' && argv[i + 1]) opts.outTitle = argv[++i];
    else if (a === '--out-body' && argv[i + 1]) opts.outBody = argv[++i];
    else if (a === '--prepare-only') opts.prepareOnly = true;
    else if (a === '--skip-test') opts.skipTest = true;
    else if (a === '--skip-package') opts.skipPackage = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--draft') opts.draft = true;
  }
  return opts;
}

export function getExpectedArtifacts(version, repoRoot = REPO_ROOT) {
  const distDir = path.join(repoRoot, 'dist');
  return [
    path.join(distDir, `agy-anchor-wheel-v${version}.zip`),
    path.join(distDir, `agy-anchor-wheel-v${version}.tar.gz`),
    path.join(distDir, `agy-anchor-wheel-v${version}.tar.gz.sha256`),
  ];
}

function runReleaseCli() {
  const opts = parseArgs(process.argv.slice(2));
  const meta = readRepoMetadata(REPO_ROOT);
  const tag = opts.tag || meta.tag;

  if (tag !== meta.tag) {
    throw new Error(`Requested tag (${tag}) does not match plugin.json/package.json (${meta.tag})`);
  }

  const notes = resolveReleaseNotes({
    repoRoot: REPO_ROOT,
    tag,
    version: meta.version,
    compatibility: meta.compatibility,
    notesFile: opts.notesFile,
  });

  if (opts.outTitle) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outTitle)), { recursive: true });
    fs.writeFileSync(opts.outTitle, notes.title, 'utf8');
  }
  if (opts.outBody) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outBody)), { recursive: true });
    fs.writeFileSync(opts.outBody, notes.body, 'utf8');
  }

  if (opts.prepareOnly) {
    console.log(`[release:publish] Prepared release metadata for ${tag} from ${notes.source}`);
    console.log(`[release:publish] Title: ${notes.title}`);
    return;
  }

  if (!opts.skipTest) {
    console.log('[release:publish] Running npm test...');
    execFileSync(process.execPath, ['--test',
      'tests/encoding.test.mjs',
      'tests/backlink_index.test.mjs',
      'tests/group_lru.test.mjs',
      'tests/preview_service.test.mjs',
      'tests/video_service.test.mjs',
      'tests/update_service.test.mjs',
      'tests/directory_nav.test.mjs',
      'tests/document_renderer.test.mjs',
      'tests/system_explorer.test.mjs',
      'tests/server_api.test.mjs',
      'tests/native_logic.test.mjs',
      'tests/release_pipeline.test.mjs',
    ], { cwd: REPO_ROOT, stdio: 'inherit' });
  }

  if (!opts.skipPackage) {
    console.log('[release:publish] Building release bundles...');
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'package-release.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }

  const artifacts = getExpectedArtifacts(meta.version, REPO_ROOT);
  for (const file of artifacts) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing release artifact: ${file}`);
    }
  }

  if (opts.dryRun) {
    console.log(`[release:publish] DRY RUN OK for ${tag}`);
    console.log(`  Title : ${notes.title}`);
    console.log(`  Source: ${notes.source}`);
    for (const f of artifacts) console.log(`  Asset : ${path.basename(f)} (${(fs.statSync(f).size / 1024).toFixed(1)} KB)`);
    return;
  }

  const ghExe = findGhExecutable();
  if (!ghExe) {
    throw new Error('GitHub CLI (gh) not found. Install via `winget install --id GitHub.cli` or push a v* tag to trigger GitHub Actions.');
  }

  try {
    execFileSync(ghExe, ['auth', 'status'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    throw new Error('GitHub CLI (gh) is not authenticated yet. Run `gh auth login` once, or push a v* tag to let GitHub Actions publish automatically.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gh-rel-'));
  const notesPath = path.join(tmpDir, 'notes.md');
  try {
    fs.writeFileSync(notesPath, notes.body, 'utf8');

    let exists = false;
    try {
      execFileSync(ghExe, ['release', 'view', tag], { cwd: REPO_ROOT, stdio: 'ignore' });
      exists = true;
    } catch {
      exists = false;
    }

    if (exists) {
      console.log(`[release:publish] Updating existing GitHub Release ${tag}...`);
      const editArgs = ['release', 'edit', tag, '--title', notes.title, '--notes-file', notesPath];
      if (!opts.draft) editArgs.push('--draft=false');
      execFileSync(ghExe, editArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
      execFileSync(ghExe, ['release', 'upload', tag, ...artifacts, '--clobber'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } else {
      console.log(`[release:publish] Creating GitHub Release ${tag}...`);
      const createArgs = ['release', 'create', tag, ...artifacts, '--title', notes.title, '--notes-file', notesPath, '--verify-tag'];
      if (opts.draft) createArgs.push('--draft');
      execFileSync(ghExe, createArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
    }
    console.log(`[release:publish] Published ${tag} successfully.`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  runReleaseCli();
}
