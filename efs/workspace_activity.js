'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace_trust');
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
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'file') continue;
    try {
      const root = path.resolve(await rootOf(folder.uri.fsPath));
      const group = path.dirname(root);
      if (path.dirname(group) !== baseDirectory) continue;
      if (!(await io.lstat(group)).isDirectory() || !(await io.lstat(root)).isDirectory()) continue;
      const manifest = JSON.parse(await io.readFile(path.join(group, MANIFEST), 'utf8'));
      if (manifest.version !== 1 || manifest.kind !== 'independent-clone' ||
          !manifest.repositories?.includes(path.basename(root))) continue;
      groups.add(group);
    } catch { /* Normal repositories are unrelated to managed workspaces. */ }
  }
  return [...groups];
}

async function registerManagedWindowActivity(vscode, context, {
  io = fs, groups, pid = process.pid, uuid = randomUUID(), now = () => new Date()
} = {}) {
  const paths = groups ?? await findManagedGroups(vscode, { io });
  const sessions = [];
  for (const group of paths) {
    try {
      const activated = path.join(group, ACTIVATED);
      const session = path.join(group, SESSION_PREFIX + pid + '-' + uuid + '.json');
      await io.writeFile(session, JSON.stringify({ pid }), { flag: 'wx', mode: 0o600 });
      await io.writeFile(activated, 'Activated by Sweetiebot\n', { mode: 0o600 });
      sessions.push({ activated, session });
    } catch (error) {
      console.warn('Sweetiebot could not register workspace activity:', error.message);
    }
  }
  if (!sessions.length) return;
  let disposed = false;
  const tick = async () => {
    if (disposed) return;
    await Promise.all(sessions.map(async entry => {
      try {
        await io.utimes(entry.activated, now(), now());
        await io.utimes(entry.session, now(), now());
      } catch { /* Missing heartbeat prevents deletion until safety checks recover. */ }
    }));
  };
  const timer = setInterval(() => void tick(), HEARTBEAT_MS);
  const stop = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    await Promise.all(sessions.map(entry => io.rm(entry.session, { force: true }).catch(() => {})));
  };
  stopCurrent = stop;
  context.subscriptions.push({ dispose() { void stop(); } });
}

async function stopManagedWindowActivity() {
  await stopCurrent();
}

module.exports = { findManagedGroups, registerManagedWindowActivity,
  stopManagedWindowActivity, HEARTBEAT_MS };
