'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { independentWorkspaceParent } = require('./workspace_trust');
const { SESSION_PREFIX } = require('./workspace_prune');

const SESSION_MAX_AGE_MS = 150 * 1000;

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function findLiveBranchWindow(destination, {
  io = fs, baseDirectory = independentWorkspaceParent(), sourcePid = process.pid,
  now = () => Date.now(), alive = processAlive
} = {}) {
  // Never discover windows outside Sweetiebot's own managed workspace parent.
  const resolved = await io.realpath(destination).catch(() => null);
  if (!resolved) return null;
  const repositoryDirectory = path.join(baseDirectory, path.basename(resolved));
  const groups = await io.readdir(repositoryDirectory, { withFileTypes: true }).catch(() => []);
  let newest = null;
  for (const group of groups) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue;
    const directory = path.join(repositoryDirectory, group.name);
    const names = await io.readdir(directory).catch(() => []);
    for (const name of names) {
      if (!name.startsWith(SESSION_PREFIX) || !name.endsWith('.json')) continue;
      const file = path.join(directory, name);
      try {
        const stat = await io.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() ||
            !Number.isFinite(stat.mtimeMs) ||
            now() - stat.mtimeMs > SESSION_MAX_AGE_MS || stat.mtimeMs > now() + 10000) continue;
        const record = JSON.parse(await io.readFile(file, 'utf8'));
        if (!Number.isSafeInteger(record.pid) || record.pid === sourcePid ||
            !alive(record.pid) || !Array.isArray(record.roots)) continue;
        const roots = record.roots.filter(root => typeof root === 'string' && path.isAbsolute(root));
        const resolvedRoots = await Promise.all(roots.map(root => io.realpath(root).catch(() => null)));
        if (!resolvedRoots.some(root => root && (root === resolved || root.startsWith(resolved + path.sep)))) continue;
        let target = resolved;
        if (record.workspaceFile) {
          if (typeof record.workspaceFile !== 'string' ||
              !path.isAbsolute(record.workspaceFile) ||
              !record.workspaceFile.endsWith('.code-workspace')) continue;
          if (!(await io.stat(record.workspaceFile)).isFile()) continue;
          target = record.workspaceFile;
        }
        if (!newest || stat.mtimeMs > newest.modified) {
          newest = { target, pid: record.pid, modified: stat.mtimeMs };
        }
      } catch { /* Stale or malformed session markers do not control navigation. */ }
    }
  }
  return newest;
}

async function focusExistingBranchWindow(vscode, destination, options = {}) {
  const window = await findLiveBranchWindow(destination, options);
  if (!window) return false;
  // VS Code handles focus/open-window routing for an existing workspace URI.
  // Never reuse the caller's window here: it would destroy the target window's
  // separate editor/terminal/Codex state. Only close after opening succeeds.
  await vscode.commands.executeCommand('vscode.openFolder',
    vscode.Uri.file(window.target), { forceNewWindow: true });
  await vscode.commands.executeCommand('workbench.action.closeWindow');
  return true;
}

module.exports = { findLiveBranchWindow, focusExistingBranchWindow, SESSION_MAX_AGE_MS };
