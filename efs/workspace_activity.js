'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace_trust');
const { isWorkspaceDirectory } = require('./workspace_layout');
const { MANIFEST, ACTIVATED, SESSION_PREFIX } = require('./workspace_prune');

const exec = promisify(execFile);
const HEARTBEAT_MS = 60 * 1000;
let stopCurrent = async () => {};

async function findManagedGroups(vscode, {
  baseDirectory = independentWorkspaceParent(), io = fs, gitRoot
} = {}) {
  const rootOf = gitRoot || (async location =>
    (await exec('git', ['-C', location, 'rev-parse', '--show-toplevel'], { timeout: 10000 })).stdout.trim());
  const groups = new Set();
  // Saved shared-main windows have their own workspace file, but their Git
  // folders point outside Sweetiebot storage. Track that file independently.
  const file = vscode.workspace.workspaceFile;
  if (file?.scheme === 'file' && path.basename(file.fsPath) === 'workspace.code-workspace') {
    const group = path.dirname(file.fsPath);
    try {
      if (await isWorkspaceDirectory(io, group, baseDirectory) &&
          (await io.lstat(group)).isDirectory()) {
        const manifest = JSON.parse(await io.readFile(path.join(group, MANIFEST), 'utf8'));
        if (manifest.version === 1 && manifest.kind === 'shared-main' &&
            Array.isArray(manifest.repositories) && manifest.repositories.length === 0) {
          groups.add(group);
        }
      }
    } catch { /* An unrelated VS Code workspace must not be tracked. */ }
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'file') continue;
    try {
      const root = path.resolve(await rootOf(folder.uri.fsPath));
      const group = path.dirname(root);
      if (!await isWorkspaceDirectory(io, group, baseDirectory)) continue;
      if (!(await io.lstat(group)).isDirectory() || !(await io.lstat(root)).isDirectory()) continue;
      const manifest = JSON.parse(await io.readFile(path.join(group, MANIFEST), 'utf8'));
      if (manifest.version !== 1 ||
          !['independent-clone', 'topic-worktree', 'main-worktree'].includes(manifest.kind) ||
          !Array.isArray(manifest.repositories) ||
          !manifest.repositories.includes(path.basename(root))) continue;
      groups.add(group);
    } catch { /* Normal repositories are unrelated to managed workspaces. */ }
  }
  return [...groups];
}

async function registerManagedWindowActivity(vscode, context, {
  io = fs, groups, pid = process.pid, uuid = randomUUID(), now = () => new Date(),
  findGroups = findManagedGroups
} = {}) {
  const sessions = new Map();
  let disposed = false;
  let refreshing = false;

  const refresh = async () => {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const paths = groups ?? await findGroups(vscode, { io });
      const wanted = new Set(paths);
      // Folder changes can happen without restarting the extension host.
      // Stop tracking the old worktree only after detecting the new one.
      for (const [group, entry] of sessions) {
        if (wanted.has(group)) continue;
        await io.rm(entry.session, { force: true }).catch(() => {});
        sessions.delete(group);
      }
      for (const group of wanted) {
        if (sessions.has(group)) continue;
        const activated = path.join(group, ACTIVATED);
        const session = path.join(group, SESSION_PREFIX + pid + '-' + uuid + '.json');
        try {
          await io.writeFile(session, JSON.stringify({ pid }), { flag: 'wx', mode: 0o600 });
          await io.writeFile(activated, 'Activated by Sweetiebot\\n', { mode: 0o600 });
          sessions.set(group, { activated, session });
        } catch (error) {
          await io.rm(session, { force: true }).catch(() => {});
          console.warn('Sweetiebot could not register workspace activity:', error.message);
        }
      }
    } finally { refreshing = false; }
  };
  await refresh();
  const tick = async () => {
    if (disposed) return;
    await refresh();
    await Promise.all([...sessions.values()].map(async entry => {
      try {
        await io.utimes(entry.activated, now(), now());
        await io.utimes(entry.session, now(), now());
      } catch { /* Missing heartbeat prevents deletion until safety checks recover. */ }
    }));
  };
  const timer = setInterval(() => void tick().catch(() => {}), HEARTBEAT_MS);
  const listener = vscode.workspace.onDidChangeWorkspaceFolders?.(
    () => void tick().catch(() => {})
  );
  const stop = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    listener?.dispose();
    await Promise.all([...sessions.values()].map(entry =>
      io.rm(entry.session, { force: true }).catch(() => {})
    ));
    sessions.clear();
  };
  stopCurrent = stop;
  context.subscriptions.push({ dispose() { void stop(); } });
}

async function stopManagedWindowActivity() {
  await stopCurrent();
}

module.exports = { findManagedGroups, registerManagedWindowActivity,
  stopManagedWindowActivity, HEARTBEAT_MS };
