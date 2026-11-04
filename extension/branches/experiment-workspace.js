'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createWorkspaceDirectory } = require('./workspace-layout');
const { copyRemotes } = require('./new-workspace');

const OPEN_EXPERIMENT_COMMAND = 'sweetiebot.openExperimentWorkspace';
const EXPERIMENT_PARENT = '/var/tmp/Sweetiebot';
const execFileAsync = promisify(execFile);

async function runGit(args) {
  return (await execFileAsync('git', args, {
    timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function privateParent(baseDirectory, io = fs) {
  await io.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
  const stat = await io.lstat(baseDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('The experimental workspace parent must be a private directory owned by you (mode 0700): ' + baseDirectory);
  }
  return io.realpath(baseDirectory);
}

async function captureSnapshot(root, git = runGit, io = fs) {
  const command = args => git(['-C', root, ...args]);
  const head = (await command(['rev-parse', 'HEAD'])).trim();
  const branch = (await command(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if ((await command(['ls-files', '--unmerged'])).trim()) {
    throw new Error('Resolve unmerged Git paths before making an experimental snapshot.');
  }
  // Capture both index and working-tree changes, rather than moving or stashing
  // them from the source. Git binary patches include tracked symlinks.
  const [worktree, staged, untracked] = await Promise.all([
    command(['diff', '--binary', 'HEAD', '--']),
    command(['diff', '--cached', '--binary', 'HEAD', '--']),
    command(['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  const files = [];
  for (const name of untracked.split('\0').filter(Boolean)) {
    const source = path.resolve(root, name);
    if (!inside(root, source) || source === root) throw new Error('Unsafe untracked file path.');
    const stat = await io.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Untracked symbolic links or special files need manual review: ' + name);
    }
    const hash = (await command(['hash-object', '--', name])).trim();
    files.push({ name, hash });
  }
  return { head, branch, worktree, staged, files };
}

async function applyPatch(git, io, root, directory, name, patch, cached = false) {
  if (!patch) return;
  const file = path.join(directory, name);
  try {
    await io.writeFile(file, patch, { mode: 0o600, flag: 'wx' });
    await git(['-C', root, 'apply', ...(cached ? ['--cached'] : []), '--binary', '--', file]);
  } finally {
    await io.rm(file, { force: true });
  }
}

async function copySnapshot(root, destination, directory, snapshot, git = runGit, io = fs) {
  await applyPatch(git, io, destination, directory, '.sweetiebot-experiment-worktree.patch', snapshot.worktree);
  await applyPatch(git, io, destination, directory, '.sweetiebot-experiment-index.patch', snapshot.staged, true);
  for (const file of snapshot.files) {
    const target = path.resolve(destination, file.name);
    if (!inside(destination, target) || target === destination) throw new Error('Unsafe destination file path.');
    await io.mkdir(path.dirname(target), { recursive: true });
    const resolvedParent = await io.realpath(path.dirname(target));
    if (!inside(destination, resolvedParent)) throw new Error('An untracked file would escape the experiment.');
    await io.copyFile(path.join(root, file.name), target, constants.COPYFILE_EXCL);
    const copiedHash = (await git(['-C', destination, 'hash-object', '--', file.name])).trim();
    if (copiedHash !== file.hash) throw new Error('An untracked file changed while making the experiment: ' + file.name);
  }
}

function snapshotEqual(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function openExperimentWorkspace(vscode, {
  git = runGit, io = fs, baseDirectory = EXPERIMENT_PARENT
} = {}) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length !== 1 || folders[0].uri.scheme !== 'file') {
    throw new Error('Open exactly one local Git repository to create an experiment.');
  }
  const location = await io.realpath(folders[0].uri.fsPath);
  const root = await io.realpath((await git(['-C', location, 'rev-parse', '--show-toplevel'])).trim());
  const relative = path.relative(root, location);
  const snapshot = await captureSnapshot(root, git, io);
  const parent = await privateParent(baseDirectory, io);
  const label = path.basename(root);
  const directory = await createWorkspaceDirectory(parent, label, io, {
    branch: snapshot.branch || 'detached'
  });
  let opened = false;
  try {
    const destination = path.join(directory, label);
    const clone = ['clone', '--local', '--no-hardlinks'];
    if (snapshot.branch) clone.push('--branch', snapshot.branch);
    clone.push('--', root, destination);
    await git(clone);
    if (!snapshot.branch) await git(['-C', destination, 'checkout', '--detach', snapshot.head]);
    const head = (await git(['-C', destination, 'rev-parse', 'HEAD'])).trim();
    if (head !== snapshot.head) throw new Error('The experiment did not clone the selected commit.');
    await copyRemotes(root, destination, args => git(args).then(value => value.trim()));
    await copySnapshot(root, destination, directory, snapshot, git, io);
    if (!snapshotEqual(snapshot, await captureSnapshot(root, git, io)) ||
        !snapshotEqual(snapshot, await captureSnapshot(destination, git, io))) {
      throw new Error('The experimental checkout differs from the source snapshot. The source was not modified.');
    }
    const target = path.join(destination, relative);
    await io.writeFile(path.join(directory, '.sweetiebot-experiment.json'), JSON.stringify({
      version: 1, kind: 'experiment', source: root, repository: destination,
      branch: snapshot.branch || null, head: snapshot.head
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    opened = true;

    // The original Codex thread stays in the original VS Code window. It
    // receives a direction, not a thread handoff or an interruption.
    let directionSent = false;
    try {
      directionSent = await vscode.commands.executeCommand(
        'sweetiebot.codex.sendExperimentDirection',
        { source: root, destination, branch: snapshot.branch || '(detached HEAD)' }
      ) === true;
    } catch (error) {
      vscode.window?.showWarningMessage('Experiment ready at ' + destination +
        ', but the original Codex chat was not notified: ' + error.message);
    }
    return { directory, destination, target, branch: snapshot.branch, directionSent };
  } catch (error) {
    if (!opened) await io.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function registerExperimentWorkspaceCommand(vscode, context) {
  let opening = false;
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_EXPERIMENT_COMMAND, async () => {
    if (opening) return;
    opening = true;
    try {
      return await openExperimentWorkspace(vscode);
    } catch (error) {
      vscode.window.showErrorMessage('Could not open an experimental workspace: ' + error.message);
      throw error;
    } finally {
      opening = false;
    }
  }));
}

module.exports = {
  OPEN_EXPERIMENT_COMMAND, EXPERIMENT_PARENT, openExperimentWorkspace,
  captureSnapshot, privateParent, registerExperimentWorkspaceCommand
};
