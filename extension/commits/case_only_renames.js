'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execute = promisify(execFile);

async function runGit(root, args) {
  const result = await execute('git', ['-C', root, '--literal-pathspecs', ...args], {
    encoding:'utf8', maxBuffer:8 * 1024 * 1024, timeout:20000
  });
  return result.stdout;
}

function caseRenameDetectionEnabled(vscode, rootUri) {
  return vscode.workspace.getConfiguration('scmToolkit', rootUri)
    .get('caseOnlyRenameDetection', true) !== false;
}

function isInside(root, location) {
  const relative = path.relative(root, location);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

// Git status can silently miss capitalization-only renames when core.ignorecase
// is true. Inspect exact index names against physical directory entries instead.
async function findCaseOnlyRenames(root, {git = runGit, readdir = fs.readdir,
  realpath = fs.realpath} = {}) {
  const tracked = (await git(root, ['ls-files', '--cached', '-z'])).split('\0').filter(Boolean);
  const directories = new Map();
  for (const file of tracked) {
    if (path.posix.isAbsolute(file) || file.startsWith('../')) continue;
    const dir = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (!directories.has(dir)) directories.set(dir, []);
    directories.get(dir).push(name);
  }
  const realRoot = await realpath(root);
  const found = [];
  for (const [dir, names] of directories) {
    const parent = path.resolve(root, dir);
    if (!isInside(root, parent)) continue;
    let entries;
    try {
      if (!isInside(realRoot, await realpath(parent))) continue;
      entries = await readdir(parent, {withFileTypes:true});
    } catch { continue; }
    const actual = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue; // Never follow symlinks/submodules.
      const key = entry.name.toLowerCase();
      if (!actual.has(key)) actual.set(key, []);
      actual.get(key).push(entry.name);
    }
    const indexed = new Map();
    for (const name of names) {
      const key = name.toLowerCase();
      if (!indexed.has(key)) indexed.set(key, []);
      indexed.get(key).push(name);
    }
    for (const [key, originals] of indexed) {
      const matches = actual.get(key) || [];
      // Never guess when the index or filesystem has a case collision.
      if (originals.length !== 1 || matches.length !== 1 ||
          originals[0] === matches[0]) continue;
      found.push({
        from:path.posix.join(dir, originals[0]),
        to:path.posix.join(dir, matches[0])
      });
    }
  }
  return found;
}

// Stage only after the user confirms the SCM action. The physical rename is
// already complete: remove its former index entry, then add the exact new name.
async function stageCaseOnlyRename(root, from, to, {git = runGit} = {}) {
  const changes = await findCaseOnlyRenames(root, {git});
  if (!changes.some(change => change.from === from && change.to === to)) {
    throw new Error('The filename rename is no longer present. Refresh Source Control.');
  }
  if (await git(root, ['diff', '--cached', '--name-only', '-z', '--', from])) {
    throw new Error('This file already has staged changes; review those first.');
  }
  const records = (await git(root, ['ls-files', '--stage', '-z', '--', from]))
    .split('\0').filter(Boolean);
  if (records.length !== 1) throw new Error('The original Git index entry is ambiguous.');
  const old = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t/.exec(records[0]);
  if (!old || !records[0].endsWith('\t' + from)) {
    throw new Error('Cannot safely identify the original Git index entry.');
  }
  await git(root, ['rm', '--cached', '-f', '--', from]);
  try {
    await git(root, ['-c', 'core.ignorecase=false', 'add', '--', to]);
    const indexed = (await git(root, ['ls-files', '--cached', '-z']))
      .split('\0').filter(Boolean);
    if (!indexed.includes(to) || indexed.includes(from)) {
      throw new Error('Git did not record the exact new filename.');
    }
  } catch (error) {
    try {
      await git(root, ['-c', 'core.ignorecase=false', 'rm', '--cached', '-f', '--', to])
        .catch(() => {});
      await git(root, ['update-index', '--add', '--cacheinfo',
        old[1] + ',' + old[2] + ',' + from]);
    } catch (rollback) {
      throw new Error('Staging failed and index recovery also failed: ' +
        error.message + '; ' + rollback.message);
    }
    throw error;
  }
}

async function registerCaseOnlyRenames(vscode, context, {git = runGit, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension || !vscode.scm?.createSourceControl) return;
  const api = (await gitExtension.activate()).getAPI(1);
  const providers = new Map();
  let nextId = 0;
  let disposed = false;
  let timer;
  let scanning = false;
  let rescan = false;

  async function refresh() {
    if (disposed) return;
    if (scanning) { rescan = true; return; }
    scanning = true;
    try {
      const repos = (api.repositories || []).filter(repo => repo.rootUri?.scheme === 'file');
      const roots = new Set(repos.map(repo => path.resolve(repo.rootUri.fsPath)));
      for (const [root, provider] of providers) {
        if (!roots.has(root)) { provider.dispose(); providers.delete(root); }
      }
      for (const repo of repos) {
        if (disposed) break;
        const root = path.resolve(repo.rootUri.fsPath);
        if (!caseRenameDetectionEnabled(vscode, repo.rootUri)) {
          if (providers.has(root)) { providers.get(root).dispose(); providers.delete(root); }
          continue;
        }
        let changes;
        try { changes = await findCaseOnlyRenames(root, {git}); }
        catch (error) {
          console.warn('Sweetiebot case-only rename detection:', error.message);
          continue;
        }
        if (!changes.length) {
          if (providers.has(root)) { providers.get(root).dispose(); providers.delete(root); }
          continue;
        }
        let provider = providers.get(root);
        if (!provider) {
          provider = vscode.scm.createSourceControl(
            'sweetiebot.caseRenames.' + (++nextId), 'Case-only renames', repo.rootUri);
          provider.caseRenameGroup = provider.createResourceGroup(
            'caseRenames', 'Filename capitalization changes');
          providers.set(root, provider);
        }
        provider.caseRenameGroup.resourceStates = changes.map(change => ({
          resourceUri:vscode.Uri.file(path.join(root, change.to)),
          decorations:{tooltip:change.from + ' → ' + change.to},
          command:{
            command:'sweetiebot.stageCaseOnlyRename',
            title:'Review and stage filename capitalization change',
            arguments:[root, change.from, change.to]
          }
        }));
        provider.count = changes.length;
      }
    } finally {
      scanning = false;
      if (rescan && !disposed) { rescan = false; schedule(); }
    }
  }

  function schedule() {
    if (disposed) return;
    clearTimer(timer);
    timer = setTimer(() => refresh().catch(error =>
      console.warn('Sweetiebot case-only rename refresh:', error.message)), 500);
    timer.unref?.();
  }

  context.subscriptions.push(vscode.commands.registerCommand(
    'sweetiebot.stageCaseOnlyRename', async (root, from, to) => {
      const repo = (api.repositories || []).find(item =>
        item.rootUri?.fsPath && path.resolve(item.rootUri.fsPath) === root);
      if (!repo || !caseRenameDetectionEnabled(vscode, repo.rootUri)) return;
      const choice = await vscode.window.showWarningMessage(
        'Stage filename capitalization change: ' + from + ' → ' + to + '?',
        {modal:true}, 'Stage rename');
      if (choice !== 'Stage rename' || !caseRenameDetectionEnabled(vscode, repo.rootUri)) return;
      try {
        await stageCaseOnlyRename(root, from, to, {git});
        await repo.status();
      } catch (error) {
        vscode.window.showErrorMessage('Could not stage case-only rename: ' + error.message);
      } finally { schedule(); }
    }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(watcher);
  for (const event of ['onDidCreate', 'onDidDelete', 'onDidChange']) {
    context.subscriptions.push(watcher[event](uri => {
      if (uri?.fsPath && (api.repositories || []).some(repo => repo.rootUri?.fsPath &&
          isInside(path.resolve(repo.rootUri.fsPath), path.resolve(uri.fsPath)))) schedule();
    }));
  }
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scmToolkit.caseOnlyRenameDetection')) schedule();
    }));
  }
  if (api.onDidOpenRepository) context.subscriptions.push(api.onDidOpenRepository(schedule));
  if (api.onDidCloseRepository) context.subscriptions.push(api.onDidCloseRepository(schedule));
  const interval = setInterval(schedule, 60000);
  interval.unref?.();
  context.subscriptions.push({dispose() {
    disposed = true;
    clearTimer(timer);
    clearInterval(interval);
    for (const provider of providers.values()) provider.dispose();
    providers.clear();
  }});
  await refresh();
}

module.exports = {runGit, isInside, caseRenameDetectionEnabled, findCaseOnlyRenames,
  stageCaseOnlyRename, registerCaseOnlyRenames};
