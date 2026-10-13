'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const OPEN_WORKSPACE_COMMAND = 'sweetiebot.openIndependentWorkspace';
const execFileAsync = promisify(execFile);

async function runGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}

async function describeRepository(folder, git) {
  if (folder.uri.scheme !== 'file' || !folder.uri.fsPath) {
    throw new Error('Independent workspaces require local Git folders.');
  }
  const location = path.resolve(folder.uri.fsPath);
  let root;
  try {
    root = path.resolve(await git(['-C', location, 'rev-parse', '--show-toplevel']));
  } catch {
    throw new Error('"' + (folder.name || location) + '" is not inside a local Git repository.');
  }
  try {
    await git(['-C', root, 'show-ref', '--verify', '--quiet', 'refs/heads/main']);
  } catch {
    throw new Error('"' + root + '" has no local main branch. Create or fetch main before opening a new workspace.');
  }
  return { root, relative: path.relative(root, location), name: folder.name };
}

async function copyRemotes(source, destination, git) {
  // Do not retain clone's default origin, which would push into the original
  // *local checkout* instead of the actual hosted repository.
  const remotes = (await git(['-C', source, 'remote'])).split(/\r?\n/).filter(Boolean);
  if (!remotes.length) {
    // Preserve local topic branches when no remote exists. Removing origin
    // otherwise removes the only refs cloned from the original repository.
    const refs = (await git(['-C', destination, 'for-each-ref',
      '--format=%(refname:short)', 'refs/remotes/origin'])).split(/\r?\n/).filter(Boolean);
    for (const ref of refs) {
      if (ref.startsWith('origin/') && ref !== 'origin/main' && ref !== 'origin/HEAD') {
        await git(['-C', destination, 'branch', ref.slice('origin/'.length), ref]);
      }
    }
    await git(['-C', destination, 'remote', 'remove', 'origin']);
    return;
  }
  const primary = remotes.includes('origin') ? 'origin' : remotes[0];
  if (primary !== 'origin') {
    await git(['-C', destination, 'remote', 'rename', 'origin', primary]);
  }
  for (const name of remotes) {
    const fetchUrl = await git(['-C', source, 'remote', 'get-url', name]);
    const pushUrl = await git(['-C', source, 'remote', 'get-url', '--push', name]);
    if (name === primary) {
      await git(['-C', destination, 'remote', 'set-url', name, fetchUrl]);
    } else {
      await git(['-C', destination, 'remote', 'add', name, fetchUrl]);
    }
    if (pushUrl !== fetchUrl) {
      await git(['-C', destination, 'remote', 'set-url', '--push', name, pushUrl]);
    }
  }
}

async function openIndependentWorkspace(vscode, {
  git = runGit,
  io = fs,
  baseDirectory = path.join(os.homedir(), 'Sweetiebot Workspaces')
} = {}) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('Open a local Git workspace first.');

  // Reject unsupported folders before creating anything. Reuse one clone
  // for nested workspace folders that belong to the same Git repository.
  const sources = [];
  const byRoot = new Map();
  for (const folder of folders) {
    const item = await describeRepository(folder, git);
    sources.push(item);
    if (!byRoot.has(item.root)) byRoot.set(item.root, byRoot.size);
  }

  await io.mkdir(baseDirectory, { recursive: true });
  const directory = await io.mkdtemp(path.join(baseDirectory, 'workspace-'));
  try {
    const destinations = new Map();
    for (const [root, index] of byRoot) {
      const label = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
      const destination = path.join(directory, String(index + 1) + '-' + label);
      // Separate clone rather than another window on the same Git worktree.
      // Do not use --single-branch; later branch switching must work.
      await git(['clone', '--local', '--no-hardlinks', '--branch', 'main', '--', root, destination]);
      await copyRemotes(root, destination, git);
      destinations.set(root, destination);
    }

    const targets = sources.map(source => ({
      path: path.join(destinations.get(source.root), source.relative),
      name: source.name
    }));
    const target = targets.length === 1
      ? targets[0].path : path.join(directory, 'workspace.code-workspace');
    if (targets.length > 1) {
      await io.writeFile(target, JSON.stringify({
        folders: targets.map(folder => ({ path: folder.path, name: folder.name }))
      }, null, 2) + '\n', 'utf8');
    }
    await vscode.commands.executeCommand(
      'vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true }
    );
    return { directory, target };
  } catch (error) {
    // Delete only our newly created directory, not a user's worktree.
    try { await io.rm(directory, { recursive: true, force: true }); }
    catch { /* Preserve the original error. */ }
    throw error;
  }
}

function registerNewWorkspaceCommand(vscode, context) {
  let opening = false;
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_WORKSPACE_COMMAND, async () => {
    if (opening) return;
    opening = true;
    try {
      return await openIndependentWorkspace(vscode);
    } catch (error) {
      vscode.window.showErrorMessage('Could not open an independent workspace: ' + error.message);
      throw error;
    } finally {
      opening = false;
    }
  }));
}

module.exports = { OPEN_WORKSPACE_COMMAND, openIndependentWorkspace, registerNewWorkspaceCommand };
