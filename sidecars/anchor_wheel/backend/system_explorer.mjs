import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalKey,
  isBlockedUncPath,
  isSensitiveFilePath,
  normalizeFilePath,
} from './security.mjs';

/**
 * Resolves a local file or directory path for safe reveal/open in the OS file manager.
 * Blocks empty paths, relative paths, UNC network paths, and sensitive credential files/dirs
 * (verified both before and after realpath resolution so symlinks cannot bypass).
 */
export function resolveSafeExplorerTarget(rawPath, { preferDirectory = false } = {}) {
  if (!rawPath || isBlockedUncPath(rawPath)) {
    return { ok: false, error: 'Blocked UNC or empty path' };
  }
  const normalized = normalizeFilePath(rawPath);
  if (!normalized || !path.isAbsolute(normalized)) {
    return { ok: false, error: 'Absolute local file or directory path required' };
  }
  if (isSensitiveFilePath(normalized)) {
    return { ok: false, error: 'Access to sensitive paths is blocked' };
  }

  let real;
  let stat;
  try {
    real = fs.realpathSync(normalized);
    if (isBlockedUncPath(real) || isSensitiveFilePath(real)) {
      return { ok: false, error: 'Resolved path is blocked' };
    }
    stat = fs.statSync(real);
  } catch (err) {
    return {
      ok: false,
      error: err?.code === 'ENOENT' ? '目标文件或文件夹不存在' : String(err?.message || err),
    };
  }

  if (stat.isDirectory()) {
    return {
      ok: true,
      mode: 'open-dir',
      isDirectory: true,
      targetPath: real,
      dirPath: real,
      key: canonicalKey(real),
    };
  }

  if (stat.isFile()) {
    const parentDir = path.dirname(real);
    if (preferDirectory) {
      if (isBlockedUncPath(parentDir) || isSensitiveFilePath(parentDir)) {
        return { ok: false, error: 'Resolved directory is blocked' };
      }
      return {
        ok: true,
        mode: 'open-dir',
        isDirectory: true,
        targetPath: parentDir,
        dirPath: parentDir,
        key: canonicalKey(parentDir),
      };
    }
    return {
      ok: true,
      mode: 'reveal-file',
      isDirectory: false,
      targetPath: real,
      dirPath: parentDir,
      key: canonicalKey(real),
    };
  }

  return { ok: false, error: 'Target is neither a regular file nor a directory' };
}

/**
 * Builds the OS-native command to open a folder or reveal/select a file in the system file manager.
 * Exported separately so cross-platform quoting behavior is deterministically unit-testable on any OS.
 */
export function buildRevealCommand(targetPath, { isDirectory = false, platform = process.platform } = {}) {
  const cleanTarget = String(targetPath || '').trim();
  if (!cleanTarget) {
    throw new Error('Target path is required');
  }

  if (platform === 'win32') {
    // Windows filenames cannot contain double quotes; strip as defense-in-depth before verbatim quoting.
    // Using windowsVerbatimArguments avoids libuv wrapping `/select,C:\a b` as `"/select,C:\a b"`
    // (which explorer.exe rejects) and protects paths containing commas/spaces/CJK characters.
    let winPath = cleanTarget.replace(/"/g, '').replace(/\//g, '\\');
    const isDriveRoot = /^[A-Za-z]:\\+$/.test(winPath);
    if (isDriveRoot) {
      winPath = `${winPath[0]}:\\`;
    } else {
      winPath = winPath.replace(/\\+$/, '');
    }
    const quoted = isDriveRoot ? winPath : `"${winPath}"`;
    const arg = isDirectory ? quoted : `/select,${quoted}`;
    return {
      command: 'explorer.exe',
      args: [arg],
      spawnOptions: {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      },
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'open',
      args: isDirectory ? [cleanTarget] : ['-R', cleanTarget],
      spawnOptions: {
        detached: true,
        stdio: 'ignore',
      },
    };
  }

  // Linux / other POSIX: always pass a directory to xdg-open so files are revealed via folder view
  // rather than executed by their default application.
  const dirToOpen = isDirectory ? cleanTarget : path.posix.dirname(cleanTarget.replace(/\\/g, '/'));
  return {
    command: 'xdg-open',
    args: [dirToOpen],
    spawnOptions: {
      detached: true,
      stdio: 'ignore',
    },
  };
}

/**
 * Safely opens a local directory or reveals a local file inside the OS file explorer
 * (Explorer on Windows, Finder on macOS, default file manager on Linux).
 * Unlike openExternalDocument, this never executes the target file.
 */
export function revealInSystemExplorer(
  rawPath,
  { preferDirectory = false, dryRun = false, platform = process.platform } = {}
) {
  const resolved = resolveSafeExplorerTarget(rawPath, { preferDirectory });
  if (!resolved.ok) return resolved;

  const spec = buildRevealCommand(resolved.targetPath, {
    isDirectory: resolved.isDirectory,
    platform,
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode: resolved.mode,
      isDirectory: resolved.isDirectory,
      targetPath: resolved.targetPath,
      dirPath: resolved.dirPath,
      command: spec.command,
      args: spec.args,
    };
  }

  try {
    const child = spawn(spec.command, spec.args, spec.spawnOptions);
    child.on('error', () => {});
    child.unref();
    return {
      ok: true,
      mode: resolved.mode,
      isDirectory: resolved.isDirectory,
      targetPath: resolved.targetPath,
      dirPath: resolved.dirPath,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
