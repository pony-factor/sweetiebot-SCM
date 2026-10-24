'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace_trust');
const { createWorkspaceDirectory } = require('./workspace_layout');
const { resolvePythonExecutable } = require('./python_runtime');
const { prepareCodexHandoff } = require('./codex_workspace_handoff');

const exec = promisify(execFile);
async function git(args) {
  return (await exec('git', args, { timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

async function originalRepository(root, {
  run = git, githubDirectory = path.join(os.homedir(), 'GitHub'),
  baseDirectory = independentWorkspaceParent()
} = {}) {
  root = await fs.realpath(root);
  const worktrees = (await run(['-C', root, 'worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const shared = worktrees.find(block => block.split('\0').includes('branch refs/heads/main') &&
    block.split('\0').some(line => line.startsWith('worktree ') && inside(githubDirectory, line.slice(9))));
  if (shared) return shared.split('\0').find(line => line.startsWith('worktree ')).slice(9);
  // Linked topic worktrees already identify the original repository exactly.
  const common = await run(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonRoot = path.basename(common) === '.git' ? await fs.realpath(path.dirname(common)) : null;
  if (commonRoot && commonRoot !== root) return commonRoot;
  if (!inside(baseDirectory, root)) return root;

  // Legacy independent clones have no shared Git directory. Resolve only an
  // existing original checkout, never pick another clone as a hidden base.
  const remote = await run(['-C', root, 'remote', 'get-url', 'origin']).catch(() => '');
  const match = remote.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (match) {
    for (const candidate of [path.join(githubDirectory, match[1], match[2]), path.join(githubDirectory, match[2])]) {
      const candidateRemote = await run(['-C', candidate, 'remote', 'get-url', 'origin']).catch(() => '');
      const identity = value => value.replace(/\.git\/?$/, '').replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/').replace(/\/$/, '').toLowerCase();
      if (candidateRemote && identity(candidateRemote) === identity(remote)) return candidate;
    }
  }
  throw new Error('Cannot locate this repository’s original checkout under ~/GitHub. Its independent checkout was preserved.');
}

async function mainRoot(root, options = {}) {
  const run = options.run || git;
  const original = await originalRepository(root, options);
  if (await run(['-C', original, 'branch', '--show-current']) !== 'main') {
    const error = new Error('The original checkout at ' + original + ' must be on main before reconnecting. Its topic files were preserved.');
    error.code = 'SWEETIEBOT_ORIGINAL_ON_TOPIC';
    throw error;
  }
  return original;
}

async function openFolders(vscode, folders, { forceNewWindow = false,
  baseDirectory = independentWorkspaceParent(), io = fs, kind = 'shared-main', handoff } = {}) {
  const workspace = vscode.workspace.workspaceFile;
  if (!forceNewWindow && workspace?.scheme === 'file') {
    // Keep the existing workbench and workspace identity. Opening a different
    // workspace file reloads the entire renderer, making a branch switch look
    // like closing and reopening VS Code. Persist the handoff before updating
    // folders because changing the first root can restart the extension host.
    if (handoff) await vscode.commands.executeCommand('sweetiebot.codexHandoff.save', {
      workspace: workspace.fsPath, plan: handoff
    });
    try {
      const accepted = vscode.workspace.updateWorkspaceFolders(0,
        vscode.workspace.workspaceFolders.length,
        ...folders.map(folder => ({ uri: vscode.Uri.file(folder.path), name: folder.name })));
      if (!accepted) throw new Error('VS Code could not update this workspace’s folders.');
      return { directory: path.dirname(workspace.fsPath), target: workspace.fsPath, folders };
    } catch (error) {
      if (handoff) await vscode.commands.executeCommand('sweetiebot.codexHandoff.clear', workspace.fsPath).catch(() => {});
      throw error;
    }
  }
  const directory = await createWorkspaceDirectory(baseDirectory, path.basename(folders[0].path), io);
  const target = path.join(directory, 'workspace.code-workspace');
  try {
    // A unique workspace file permits separate windows on the SAME main
    // folder. It does not introduce another Git checkout or another main ref.
    await io.writeFile(target, JSON.stringify({ folders }, null, 2) + '\n');
    await io.writeFile(path.join(directory, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind, repositories: []
    }, null, 2) + '\n');
    if (handoff) await vscode.commands.executeCommand('sweetiebot.codexHandoff.save', { workspace: target, plan: handoff });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target),
      forceNewWindow ? { forceNewWindow: true } : { forceReuseWindow: true });
    return { directory, target, folders };
  } catch (error) {
    if (handoff) await vscode.commands.executeCommand('sweetiebot.codexHandoff.clear', target).catch(() => {});
    await io.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function openSharedMainWorkspace(vscode, options = {}) {
  const run = options.run || git;
  const folders = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'file') throw new Error('Shared main requires local Git folders.');
    const location = await fs.realpath(folder.uri.fsPath);
    const root = await fs.realpath(await run(['-C', location, 'rev-parse', '--show-toplevel']));
    folders.push({ path: path.join(await mainRoot(root, options), path.relative(root, location)), name: folder.name });
  }
  if (!folders.length) throw new Error('Open a local Git workspace first.');
  return openFolders(vscode, folders, { ...options, forceNewWindow: options.forceNewWindow !== false });
}

async function replaceRepository(vscode, root, destination, options) {
  const run = options.run || git;
  const folders = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const folderRoot = folder.uri.scheme === 'file'
      ? await run(['-C', folder.uri.fsPath, 'rev-parse', '--show-toplevel']).catch(() => '') : '';
    const location = folderRoot ? await fs.realpath(folder.uri.fsPath) : folder.uri.fsPath;
    const sameRoot = folderRoot && await fs.realpath(folderRoot) === root;
    folders.push({ path: sameRoot
      ? path.join(destination, path.relative(root, location)) : folder.uri.fsPath, name: folder.name });
  }
  return openFolders(vscode, folders, options);
}

async function capturePendingFiles(root, run) {
  const patch = (await exec('git', ['-C', root, 'diff', '--binary', 'HEAD', '--'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const names = (await run(['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const files = [];
  for (const name of names) {
    const file = path.resolve(root, name);
    if (!inside(root, file)) throw new Error('Invalid untracked path during Codex handoff.');
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error('Codex handoff preserves source symlinks and special files in their original checkout.');
    files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const head = await run(['-C', root, 'rev-parse', 'HEAD']);
  const ref = await run(['-C', root, 'symbolic-ref', 'HEAD']);
  const index = (await exec('git', ['-C', root, 'diff', '--cached', '--binary', 'HEAD', '--'],
    { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const tracked = (await run(['-C', root, 'diff', '--name-only', '-z', 'HEAD', '--']))
    .split('\0').filter(Boolean);
  const staged = (await run(['-C', root, 'diff', '--cached', '--name-only', '-z', 'HEAD', '--']))
    .split('\0').filter(Boolean);
  return { patch, files, head, ref, index, tracked: [...new Set([...tracked, ...staged])] };
}

async function copyPendingFiles(root, destination, directory, snapshot) {
  for (const { name } of snapshot.files) {
    if (await fs.lstat(path.join(destination, name)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('A pending file already exists in the destination; the source files were preserved.');
  }
  if (snapshot.patch) {
    const patchFile = path.join(directory, '.sweetiebot-handoff.patch');
    try {
      await fs.writeFile(patchFile, snapshot.patch, { mode: 0o600, flag: 'wx' });
      await exec('git', ['-C', destination, 'apply', '--binary', patchFile]);
    } finally { await fs.rm(patchFile, { force: true }); }
  }
  for (const file of snapshot.files) {
    const source = path.join(root, file.name);
    const before = await fs.lstat(source);
    if (!before.isFile() || before.size !== file.size || before.mtimeMs !== file.mtimeMs) {
      throw new Error('A pending file changed during checkout handoff; the original files were preserved.');
    }
    const target = path.join(destination, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL);
  }
}

async function removeTransferredFiles(root, destination, directory, snapshot, run) {
  // Validate both copies before removing anything. A changed source or index
  // belongs to the user and must stay in place, even if copying succeeded.
  const current = await capturePendingFiles(root, run);
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
    throw new Error('Source files or staging changed during checkout handoff; both checkouts were preserved.');
  }
  const patchFile = path.join(directory, '.sweetiebot-handoff-verify.patch');
  if (snapshot.patch) {
    try {
      await fs.writeFile(patchFile, snapshot.patch, { mode: 0o600, flag: 'wx' });
      await exec('git', ['-C', destination, 'apply', '--reverse', '--check', '--binary', patchFile]);
    } finally { await fs.rm(patchFile, { force: true }); }
  }
  for (const file of snapshot.files) {
    const source = path.join(root, file.name);
    const target = path.join(destination, file.name);
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || !(await fs.readFile(source)).equals(await fs.readFile(target))) {
      throw new Error('A transferred file differs from its source; both checkouts were preserved.');
    }
  }
  // Remove only transferred tracked paths, including their old staged entries.
  // The destination remains unstaged; unrelated source paths are untouched.
  if (snapshot.tracked.length) {
    await exec('git', ['-C', root, '--literal-pathspecs', 'restore', '--source=' + snapshot.head,
      '--staged', '--worktree', '--', ...snapshot.tracked]);
  }
  for (const file of snapshot.files) {
    const source = path.join(root, file.name);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs ||
        !(await fs.readFile(source)).equals(await fs.readFile(path.join(destination, file.name)))) {
      throw new Error('A source file changed during cleanup; its remaining changes were preserved.');
    }
    await fs.unlink(source);
  }
}

async function switchRepository(vscode, root, destination, options) {
  const handoff = await prepareCodexHandoff(vscode, root);
  try {
    return await replaceRepository(vscode, root, destination, {
      ...options, forceNewWindow: false, handoff: handoff && { ...handoff, destination }
    });
  } catch (error) {
    if (handoff) await vscode.commands.executeCommand('sweetiebot.codex.resumeWorkspaceHandoff',
      { ...handoff, destination: root }).catch(() => {});
    throw error;
  }
}

async function routeBranch(vscode, repository, { branch, create = false, adoptExisting = false, start,
  forkScript, source, expectedHead, ...options } = {}) {
  const run = options.run || git;
  if (!repository.rootUri?.fsPath || !branch || !vscode.workspace?.workspaceFolders?.length) return false;
  const root = await fs.realpath(repository.rootUri.fsPath);
  const original = await originalRepository(root, options);
  const current = await run(['-C', root, 'branch', '--show-current']);
  if (branch === 'main') {
    if (root === original && current === 'main') return false;
    await mainRoot(root, options);
    await switchRepository(vscode, root, original, options);
    return true;
  }
  if (!create && !adoptExisting && (root !== original || current !== 'main')) return false;
  if ((create || adoptExisting) && root !== original) {
    const common = await Promise.all([root, original].map(directory =>
      run(['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'])));
    // Legacy independent clones have their own refs and pending title jobs.
    // Keep their existing branch flow instead of routing into another Git DB.
    if (common[0] !== common[1]) return false;
  }
  await run(['-C', original, 'check-ref-format', '--branch', branch]);
  // Reopening an existing topic must use its existing files, including edits.
  const worktrees = (await run(['-C', original, 'worktree', 'list', '--porcelain'])).split('\n\n');
  const existing = worktrees.find(block => block.split('\n').includes('branch refs/heads/' + branch));
  if (existing && adoptExisting) throw new Error('The new stacked branch already has a worktree.');
  if (existing && !create) {
    const destination = existing.split('\n').find(line => line.startsWith('worktree ')).slice(9);
    await switchRepository(vscode, root, destination, options);
    return true;
  }
  const baseDirectory = options.baseDirectory || independentWorkspaceParent();
  const directory = await createWorkspaceDirectory(baseDirectory, path.basename(original));
  const destination = path.join(directory, path.basename(original));
  let added = false;
  let transferred = false;
  let handoff;
  try {
    handoff = await prepareCodexHandoff(vscode, root);
    const pendingFiles = handoff && create ? await capturePendingFiles(root, run) : null;
    const args = ['-C', original, 'worktree', 'add'];
    if (create && !adoptExisting) args.push('-b', branch);
    args.push('--', destination, create && !adoptExisting ? (start || 'main') : branch);
    if (create && forkScript) {
      if (expectedHead && await run(['-C', root, 'symbolic-ref', 'HEAD']) !== expectedHead) {
        throw new Error('The active branch changed while preparing the new branch.');
      }
      // Pending main title jobs and fork subscriptions belong to the original
      // checkout. Validate the source above, then use that job owner's HEAD
      // for the helper's additional check under its repository lock.
      const ownerHead = await run(['-C', original, 'symbolic-ref', 'HEAD']);
      await exec(resolvePythonExecutable(), [forkScript, '--fork-worktree',
        source, branch, ownerHead, destination], { cwd: original, timeout: 120000 });
    } else {
      await run(args);
    }
    added = true;
    if (pendingFiles) await copyPendingFiles(root, destination, directory, pendingFiles);
    // The old independent-clone pruner intentionally ignores linked worktrees.
    await fs.writeFile(path.join(directory, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind: 'topic-worktree', repositories: [path.basename(original)]
    }, null, 2) + '\n');
    if (pendingFiles) {
      await removeTransferredFiles(root, destination, directory, pendingFiles, run);
      transferred = true;
    }
    // The user wants this same chat and window to follow the selected branch.
    // Its turn was stopped before creating the checkout; the destination host
    // resumes the same thread only after verifying its execution directory.
    await replaceRepository(vscode, root, destination,
      { ...options, forceNewWindow: false, handoff: handoff && { ...handoff, destination } });
    return true;
  } catch (error) {
    if (handoff) {
      await vscode.commands.executeCommand('sweetiebot.codex.resumeWorkspaceHandoff',
        { ...handoff, destination: transferred ? destination : root }).catch(() => {});
    }
    if (!added) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    // Once added, retain the checkout and any edits even if opening fails.
    if (transferred) error.message += ' Transferred edits remain in ' + destination + '; the source checkout was cleaned.';
    throw error;
  }
}

async function reconnectManagedMain(vscode, options = {}) {
  const run = options.run || git;
  const baseDirectory = options.baseDirectory || independentWorkspaceParent();
  if (vscode.workspace.workspaceFolders?.length !== 1) return false;
  const folder = vscode.workspace.workspaceFolders[0];
  if (folder.uri.scheme !== 'file' || !inside(baseDirectory, folder.uri.fsPath)) return false;
  const root = await run(['-C', folder.uri.fsPath, 'rev-parse', '--show-toplevel']);
  if (await run(['-C', root, 'branch', '--show-current']) !== 'main') return false;
  let original;
  try { original = await mainRoot(root, options); }
  catch (error) {
    // Independent main windows remain usable while the original is on a
    // topic. Reconnect on a later activation after it returns to main.
    if (error.code === 'SWEETIEBOT_ORIGINAL_ON_TOPIC') return false;
    throw error;
  }
  if (root === original) {
    if (path.resolve(folder.uri.fsPath) === original) return false;
    await switchRepository(vscode, root, original, options);
    return true;
  }
  if (await run(['-C', root, 'status', '--porcelain'])) {
    throw new Error('This old main checkout has separate pending edits. Reconnect it after preserving those edits in the original repo.');
  }
  const sha = await run(['-C', root, 'rev-parse', 'HEAD']);
  const unfinished = await run(['-C', root, 'log', '--format=%s', '--extended-regexp',
    '--grep=^(placeholder_[0-9a-f]{16}|💭 Generate local commit message \\[[0-9a-f]{16}\\])$', sha]);
  if (unfinished) throw new Error('This main checkout is still finalizing a commit. It will reconnect after finalization.');
  try { await run(['-C', original, 'merge-base', '--is-ancestor', sha, 'main']); }
  catch { throw new Error('This old main checkout has separate commits. Preserve them in the original repo before reconnecting.'); }
  await switchRepository(vscode, root, original, options);
  return true;
}

function registerSharedMain(vscode, context) {
  let running = false;
  const reconnect = async () => {
    if (running) return;
    running = true;
    try { await reconnectManagedMain(vscode); }
    catch (error) { vscode.window.showWarningMessage('Sweetiebot shared main: ' + error.message); }
    finally { running = false; }
  };
  // A newly opened saved shared workspace already points outside Workspaces,
  // so it will not reopen itself on subsequent activations.
  setImmediate(() => void reconnect());
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void reconnect()));
}

module.exports = { originalRepository, mainRoot, openSharedMainWorkspace, routeBranch,
  reconnectManagedMain, registerSharedMain };
