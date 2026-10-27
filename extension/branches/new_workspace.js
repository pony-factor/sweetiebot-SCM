'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace_trust');
const { createWorkspaceDirectory, workspaceFileName } = require('./workspace_layout');
const { openSharedMainWorkspace } = require('./shared_main');

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
  let location = path.resolve(folder.uri.fsPath);
  let root;
  try {
    root = await fs.realpath(await git(['-C', location, 'rev-parse', '--show-toplevel']));
    location = await fs.realpath(location);
  } catch {
    throw new Error('"' + (folder.name || location) + '" is not inside a local Git repository.');
  }
  try {
    await git(['-C', root, 'show-ref', '--verify', '--quiet', 'rextension/heads/main']);
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
      '--format=%(refname:short)', 'rextension/remotes/origin'])).split(/\r?\n/).filter(Boolean);
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

async function openIndependentClone(vscode, {
  git = runGit,
  io = fs,
  baseDirectory = independentWorkspaceParent()
} = {}) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('Open a local Git workspace first.');

  // Reject unsupported folders before creating anything. Reuse one clone
  // for nested workspace folders that belong to the same Git repository.
  const sources = [];
  const roots = new Set();
  for (const folder of folders) {
    const item = await describeRepository(folder, git);
    sources.push(item);
    roots.add(item.root);
  }

  const labelFor = root =>
    path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';

  // Multi-root workspaces are grouped under their first repository.
  const firstLabel = labelFor(roots.values().next().value);
  const directory = await createWorkspaceDirectory(baseDirectory, firstLabel, io, { branch: 'main' });
  try {
    const destinations = new Map();
    const usedNames = new Set();
    for (const root of roots) {
      const label = labelFor(root);
      let name = label;
      let suffix = 2;
      // Different repositories can share a basename. Suffix only the
      // duplicates, so the normal names never start with an ordinal number.
      while (usedNames.has(name)) name = label + '-' + suffix++;
      usedNames.add(name);
      const destination = path.join(directory, name);
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
      ? targets[0].path : path.join(directory, workspaceFileName(directory));
    let workspaceFileContents = null;
    if (targets.length > 1) {
      workspaceFileContents = JSON.stringify({
        folders: targets.map(folder => ({ path: folder.path, name: folder.name }))
      }, null, 2) + '\n';
      await io.writeFile(target, workspaceFileContents, 'utf8');
    }
    // Keep the original multi-root workspace file byte-for-byte: later edits
    // by the user must disqualify the entire group from automatic deletion.
    await io.writeFile(path.join(directory, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1,
      kind: 'independent-clone',
      repositories: [...destinations.values()].map(destination => path.basename(destination)),
      workspaceFileContents
    }, null, 2) + '\n', { mode: 0o600 });
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

async function openIndependentWorkspace(vscode, options = {}) {
  // All new windows share the checked-out main directory. If main is currently
  // free, shared_main creates one linked worktree rather than cloning a second
  // Git database. Retain openIndependentClone only for legacy compatibility.
  return openSharedMainWorkspace(vscode, options);
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

module.exports = { OPEN_WORKSPACE_COMMAND, openIndependentWorkspace,
  openIndependentClone, registerNewWorkspaceCommand };
