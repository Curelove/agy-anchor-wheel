import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

const SENSITIVE_BASENAME_RE =
  /^(?:\.env(?:\..+)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|id_ecdsa(?:\..*)?|authorized_keys|known_hosts|credentials(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|private_vault\.json|DevToolsActivePort|cookies(?:\.[^.]+)?)$/i;

const SENSITIVE_EXT_RE = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

const SENSITIVE_SEGMENT_RE = /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|shadow|passwd)(?:[\\/]|$)/i;

const SYSTEM_PROTECTED_PREFIXES_WIN = [
  'c:/windows/',
  'c:/program files/',
  'c:/program files (x86)/',
];

export function isBlockedUncPath(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s) return false;
  if (/^\\\\(?!\?\\[A-Za-z]:[\\/])[^\\]/.test(s)) return true;
  if (/^\/\/[^/]/.test(s)) return true;
  return false;
}

export function splitPathAndLineRange(rawInput) {
  let str = String(rawInput || '').trim();
  if (!str) return { pathPart: '', lineStart: null, lineEnd: null };
  let lineStart = null;
  let lineEnd = null;
  const hashMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(str);
  if (hashMatch) {
    lineStart = parseInt(hashMatch[1], 10);
    lineEnd = hashMatch[2] ? parseInt(hashMatch[2], 10) : null;
    str = str.slice(0, hashMatch.index);
  } else {
    const colonMatch = /:(\d+)(?:(?:-(\d+))|(?::\d+))?$/.exec(str);
    if (colonMatch && colonMatch.index > 2) {
      lineStart = parseInt(colonMatch[1], 10);
      lineEnd = colonMatch[2] ? parseInt(colonMatch[2], 10) : null;
      str = str.slice(0, colonMatch.index);
    }
  }
  return { pathPart: str, lineStart, lineEnd };
}

function safeDecodeUriComponent(str) {
  let out = String(str ?? '');
  const hadDouble = /%25[0-9A-Fa-f]{2}/.test(out);
  try {
    out = decodeURIComponent(out);
  } catch {}
  if (hadDouble || /(?:%[C-Fc-f][0-9A-Fa-f](?:%[89ABab][0-9A-Fa-f]){1,3})/.test(out)) {
    try {
      out = decodeURIComponent(out);
    } catch {}
  }
  return out;
}

export function normalizeFilePath(rawUriOrPath) {
  let input = String(rawUriOrPath || '').trim();
  if (!input) return '';
  const nulIdx = input.lastIndexOf('\u0000');
  if (nulIdx !== -1) input = input.slice(nulIdx + 1).trim();
  if (!input) return '';
  if (/^antigravity-ide:\/\/file/i.test(input)) {
    input = 'file://' + input.replace(/^antigravity-ide:\/\/file/i, '');
  } else if (/^vscode-file:\/\/vscode-app/i.test(input)) {
    input = 'file://' + input.replace(/^vscode-file:\/\/vscode-app/i, '');
  }
  const { pathPart } = splitPathAndLineRange(input);
  let p = pathPart;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    if (/^localhost\//i.test(p)) p = p.slice('localhost'.length);
    p = safeDecodeUriComponent(p);
    if (/^\/[A-Za-z]:[\\/]/.test(p)) {
      p = p.slice(1);
    }
  } else if (/%[0-9A-Fa-f]{2}/.test(p)) {
    p = safeDecodeUriComponent(p);
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(2));
  }
  if (IS_WIN) {
    p = p.replace(/\//g, '\\');
    if (/^[A-Za-z]:$/.test(p)) p += '\\';
  }
  return path.isAbsolute(p) ? path.normalize(p) : p;
}

export function canonicalKey(filePath) {
  const norm = normalizeFilePath(filePath);
  const slashNorm = norm.replace(/\\/g, '/').replace(/\/+$/, '');
  return IS_WIN ? slashNorm.toLowerCase() : slashNorm;
}

export function toFileUri(filePath) {
  const abs = normalizeFilePath(filePath);
  if (!abs) return '';
  const posix = abs.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(posix)) {
    return encodeURI(`file:///${posix}`);
  }
  if (posix.startsWith('/')) {
    return encodeURI(`file://${posix}`);
  }
  return '';
}

export function isSensitiveFilePath(filePath) {
  const norm = normalizeFilePath(filePath);
  if (!norm) return true;
  const base = path.basename(norm);
  if (SENSITIVE_BASENAME_RE.test(base)) return true;
  if (SENSITIVE_EXT_RE.test(base)) return true;
  if (SENSITIVE_SEGMENT_RE.test(norm)) return true;
  return false;
}

export function isHostProtectedWritePath(filePath) {
  const key = canonicalKey(filePath);
  if (!key) return true;
  const localAppData = canonicalKey(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
  if (IS_WIN) {
    if (key.startsWith(`${localAppData}/programs/antigravity`)) return true;
    for (const prefix of SYSTEM_PROTECTED_PREFIXES_WIN) {
      if (key.startsWith(prefix)) return true;
    }
  } else {
    if (key.startsWith('/usr/') || key.startsWith('/bin/') || key.startsWith('/sbin/') || key.startsWith('/system/')) {
      return true;
    }
  }
  return false;
}

export function resolveSafeReadPath(rawPath) {
  if (!rawPath || isBlockedUncPath(rawPath)) {
    return { ok: false, error: 'Blocked UNC or empty path' };
  }
  const normalized = normalizeFilePath(rawPath);
  if (!normalized || !path.isAbsolute(normalized)) {
    return { ok: false, error: 'Absolute local file path required' };
  }
  if (isSensitiveFilePath(normalized)) {
    return { ok: false, error: 'Access to sensitive credential files is blocked' };
  }
  try {
    const lstat = fs.lstatSync(normalized);
    const real = lstat.isSymbolicLink() ? fs.realpathSync(normalized) : normalized;
    if (isBlockedUncPath(real) || isSensitiveFilePath(real)) {
      return { ok: false, error: 'Resolved path is blocked' };
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      return { ok: false, error: 'Target is not a regular file' };
    }
    return { ok: true, filePath: real, key: canonicalKey(real), stat };
  } catch (err) {
    return { ok: false, error: err?.code === 'ENOENT' ? 'File not found' : String(err?.message || err) };
  }
}

export function resolveSafeDirPath(rawPath) {
  if (!rawPath || isBlockedUncPath(rawPath)) {
    return { ok: false, error: 'Blocked UNC or empty path' };
  }
  const normalized = normalizeFilePath(rawPath);
  if (!normalized || !path.isAbsolute(normalized)) {
    return { ok: false, error: 'Absolute local directory path required' };
  }
  if (isSensitiveFilePath(normalized)) {
    return { ok: false, error: 'Access to sensitive directories is blocked' };
  }
  try {
    const lstat = fs.lstatSync(normalized);
    const real = lstat.isSymbolicLink() ? fs.realpathSync(normalized) : normalized;
    if (isBlockedUncPath(real) || isSensitiveFilePath(real)) {
      return { ok: false, error: 'Resolved directory is blocked' };
    }
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) {
      return { ok: false, error: 'Target is not a directory' };
    }
    return { ok: true, dirPath: real, key: canonicalKey(real), stat };
  } catch (err) {
    return { ok: false, error: err?.code === 'ENOENT' ? 'Directory not found' : String(err?.message || err) };
  }
}

export function resolveSafeWritePath(rawPath) {
  const check = resolveSafeReadPath(rawPath);
  if (!check.ok) return check;
  if (isHostProtectedWritePath(check.filePath)) {
    return { ok: false, error: 'Target path is protected and cannot be modified' };
  }
  return check;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
