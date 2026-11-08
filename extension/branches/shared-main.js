'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace-trust');
const { createWorkspaceDirectory, workspaceFileName } = require('./workspace-layout');
const { worktreeLocations } = require('./worktree-registry');
const { resolvePythonExecutable } = require('../ui/python-runtime');
const { prepareCodexHandoff } = require('../codex/workspace-handoff');

const exec = promisify(execFile);
const DELETION_RETURN = 'sweetiebot-deleted-branch.json';
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
  const registered = worktreeLocations(await run(['-C', root, 'worktree', 'list', '--porcelain', '-z']));
  const sharedMain = registered.get('main');
  if (sharedMain && inside(githubDirectory, sharedMain)) return sharedMain;
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

function checkedOutMain(listing) {
  return worktreeLocations(listing).get('main') || null;
}

async function mainRoot(root, options = {}) {
  const run = options.run || git;
  const io = options.io || fs;
  const original = await originalRepository(root, options);
  const listMain = async () => checkedOutMain(await run([
    '-C', original, 'worktree', 'list', '--porcelain', '-z'
  ]));
  const existing = await listMain();
  if (existing) return await io.realpath(existing);

  // An original repository may still have a topic checked out. Since Git
  // allows only one worktree per branch, create main only when it is free.
  const directory = await createWorkspaceDirectory(
    options.baseDirectory || independentWorkspaceParent(), path.basename(original), io
  );
  const destination = path.join(directory, path.basename(original));
  let added = false;
  try {
    await run(['-C', original, 'worktree', 'add', '--', destination, 'main']);
    added = true;
    await io.writeFile(path.join(directory, '.sweetiebot-workspace.json'),
      JSON.stringify({ version: 1, kind: 'main-worktree',
        repositories: [path.basename(original)] }, null, 2) + '\n',
      { mode: 0o600 });
    return destination;
  } catch (error) {
    if (added) {
      // A newly registered worktree must be detached via Git, never by
      // recursively deleting its working directory.
      await run(['-C', original, 'worktree', 'remove', '--', destination])
        .catch(() => {});
    }
    if (!added || !await io.lstat(destination).then(() => true, () => false)) {
      await io.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    // Another window may have checked out main during our Git operation.
    const winner = await listMain().catch(() => null);
    if (winner) return await io.realpath(winner);
    throw error;
  }
}

async function openFolders(vscode, folders, { forceNewWindow = false,
  baseDirectory = independentWorkspaceParent(), io = fs, kind = 'shared-main', handoff, branch = 'main' } = {}) {
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
  const directory = await createWorkspaceDirectory(baseDirectory, path.basename(folders[0].path), io, { branch });
  const target = path.join(directory, workspaceFileName(directory));
  try {
    // A unique workspace file permits separate windows on the SAME main
    // folder. It does not introduce another Git checkout or another main ref.
    await io.writeFile(target, JSON.stringify({ folders }, null, 2) + '\n');
    await io.writeFile(path.join(directory, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind, repositories: [], workspaceFileContents:
        JSON.stringify({ folders }, null, 2) + '\n'
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
  await require('./commit-drafts').preserveCommitDraft(vscode, root, destination, options.commitDraftValue);
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

async function backupPendingFiles(root, directory, snapshot) {
  if (!snapshot.patch && !snapshot.index && !snapshot.files.length) return null;
  const recovery = path.join(directory, '.sweetiebot-handoff-backup');
  await fs.mkdir(recovery, { mode: 0o700 });
  await fs.writeFile(path.join(recovery, 'worktree.patch'), snapshot.patch, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(recovery, 'index.patch'), snapshot.index, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(recovery, 'snapshot.json'), JSON.stringify({
    head: snapshot.head, ref: snapshot.ref, tracked: snapshot.tracked, files: snapshot.files
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  for (const file of snapshot.files) {
    const target = path.join(recovery, 'files', file.name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(root, file.name), target, require('node:fs').constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
  }
  return recovery;
}

// A dirty file may have been committed only on the source topic. Seed its
// preimage when main has no such path, so its pending edit can travel alone.
async function seedMissingPreimages(root, destination, snapshot) {
  if (!snapshot.tracked.length) return;
  const staged = new Set((await exec('git', ['-C', root, 'diff', '--cached', '--name-only', '-z', 'HEAD', '--'])).stdout.split('\0').filter(Boolean));
  for (const name of snapshot.tracked) {
    const source = (await exec('git', ['-C', root, 'ls-tree', '-z', snapshot.head, '--', name])).stdout;
    if (!source) continue; // A newly added file already has an addition patch.
    const target = (await exec('git', ['-C', destination, 'ls-tree', '-z', 'HEAD', '--', name])).stdout;
    if (target) continue;
    const match = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(source);
    if (!match) throw new Error('Cannot transfer a missing non-regular tracked file; source files were preserved.');
    const file = path.resolve(destination, name);
    if (!inside(destination, file)) throw new Error('Invalid tracked path during checkout handoff.');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { stdout } = await exec('git', ['-C', root, 'cat-file', 'blob', match[2]],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    await fs.writeFile(file, stdout, { flag: 'wx', mode: match[1] === '100755' ? 0o755 : 0o644 });
    // Only paths already staged by the user get a staged preimage.
    if (staged.has(name)) await exec('git', ['-C', destination, 'update-index', '--add', '--cacheinfo', match[1], match[2], name]);
  }
}

async function copyPendingFiles(root, destination, directory, snapshot) {
  await seedMissingPreimages(root, destination, snapshot);
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
  if (snapshot.index) {
    const patchFile = path.join(directory, '.sweetiebot-handoff-index.patch');
    try {
      await fs.writeFile(patchFile, snapshot.index, { mode: 0o600, flag: 'wx' });
      await exec('git', ['-C', destination, 'apply', '--cached', '--binary', patchFile]);
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
  if (snapshot.index) {
    const indexPatch = path.join(directory, '.sweetiebot-handoff-index-verify.patch');
    try {
      await fs.writeFile(indexPatch, snapshot.index, { mode: 0o600, flag: 'wx' });
      await exec('git', ['-C', destination, 'apply', '--cached', '--reverse', '--check', '--binary', indexPatch]);
    } finally { await fs.rm(indexPatch, { force: true }); }
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
  // The destination retains the original staging; unrelated source paths are untouched.
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

// The branch picker's final fallback uses this path when its Git registry
// shows an occupied worktree. Never call ordinary checkout in that case.
async function routeExistingBranchWorktree(vscode, repository, destination, options = {}) {
  if (!repository.rootUri?.fsPath) return false;
  const root = await fs.realpath(repository.rootUri.fsPath);
  const existing = await fs.realpath(destination).catch(() => null);
  if (!existing) return false;
  if (options.branch) {
    // Another window may have changed the registry after the first lookup.
    // Never route to a path without revalidating the selected branch in Git.
    const run = options.run || git;
    const registered = worktreeLocations(await run(['-C', root, 'worktree', 'list', '--porcelain', '-z']))
      .get(options.branch);
    if (!registered || await fs.realpath(registered).catch(() => null) !== existing
        || await run(['-C', existing, 'branch', '--show-current']).catch(() => '') !== options.branch) {
      return false;
    }
  }
  if (root === existing) return true;
  if (!vscode.workspace?.workspaceFolders?.length) return false;
  await switchRepository(vscode, root, existing, options);
  return true;
}

async function routeBranch(vscode, repository, { branch, create = false, adoptExisting = false, start,
  forkScript, source, expectedHead, ...options } = {}) {
  const run = options.run || git;
  if (!repository.rootUri?.fsPath || !branch || !vscode.workspace?.workspaceFolders?.length) return false;
  const root = await fs.realpath(repository.rootUri.fsPath);
  if (!Object.hasOwn(options, 'commitDraftValue') && typeof repository.inputBox?.value === 'string')
    options.commitDraftValue = repository.inputBox.value;
  await require('./commit-drafts').preserveCommitDraft(vscode, root, undefined, options.commitDraftValue);
  let original = await originalRepository(root, options);
  const current = await run(['-C', root, 'branch', '--show-current']);
  if (branch === 'main') {
    const main = await mainRoot(root, options);
    if (root === main && current === 'main') return true;
    await switchRepository(vscode, root, main, options);
    return true;
  }
  if (!create && current === branch) return true;
  if (!create && !adoptExisting && root !== original) {
    // A legacy clone has an independent Git database. Use its own worktree
    // registry for branch navigation, not the canonical checkout's records.
    // Otherwise the fallback checkout rejects an already-occupied branch.
    const common = await Promise.all([root, original].map(directory =>
      run(['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'])));
    if (common[0] !== common[1]) original = root;
  }
  if ((create || adoptExisting) && root !== original) {
    const common = await Promise.all([root, original].map(directory =>
      run(['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'])));
    // Legacy independent clones have their own refs and pending title jobs.
    // Keep their existing branch flow instead of routing into another Git DB.
    if (common[0] !== common[1]) return false;
  }
  await run(['-C', original, 'check-ref-format', '--branch', branch]);
  // Reopening an existing topic must use its existing files, including edits.
  const worktrees = worktreeLocations(await run(['-C', original, 'worktree', 'list', '--porcelain', '-z']));
  const registeredDestination = worktrees.get(branch);
  if (registeredDestination && adoptExisting) throw new Error('The new stacked branch already has a worktree.');
  if (registeredDestination && !create) {
    // Repoint the current window even when another live VS Code window
    // already owns the registered worktree.
    return routeExistingBranchWorktree(vscode, repository, registeredDestination, { ...options, branch });
  }
  const baseDirectory = options.baseDirectory || independentWorkspaceParent();
  const directory = await createWorkspaceDirectory(baseDirectory, path.basename(original), fs, { branch });
  const destination = path.join(directory, path.basename(original));
  let added = false;
  let transferred = false;
  let handoff;
  let recovery;
  try {
    handoff = await prepareCodexHandoff(vscode, root);
    // File ownership follows New Branch even when no Codex chat is open.
    const pendingFiles = create ? await capturePendingFiles(root, run) : null;
    if (pendingFiles) recovery = await backupPendingFiles(root, directory, pendingFiles);
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
      { ...options, branch, forceNewWindow: false, handoff: handoff && { ...handoff, destination } });
    return true;
  } catch (error) {
    if (handoff) {
      await vscode.commands.executeCommand('sweetiebot.codex.resumeWorkspaceHandoff',
        { ...handoff, destination: transferred ? destination : root }).catch(() => {});
    }
    if (!added && !recovery) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    // Once added, retain the checkout and any edits even if opening fails.
    if (transferred) error.message += ' Transferred edits remain in ' + destination + '; the source checkout was cleaned.';
    if (recovery) error.message += ' A recovery copy is saved in ' + recovery + '.';
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
  const main = await mainRoot(root, options);
  if (root === main) return false;
  if (root === original) {
    if (path.resolve(folder.uri.fsPath) === original) return false;
    await switchRepository(vscode, root, main, options);
    return true;
  }
  if (await run(['-C', root, 'status', '--porcelain'])) {
    throw new Error('This old main checkout has separate pending edits. Reconnect it after preserving those edits in the original repo.');
  }
  const sha = await run(['-C', root, 'rev-parse', 'HEAD']);
  const unfinished = await run(['-C', root, 'log', '--format=%s', '--extended-regexp',
    '--grep=^(placeholder_[0-9a-f]{16}|💭 Generate local commit message \\[[0-9a-f]{16}\\])$', sha]);
  if (unfinished) throw new Error('This main checkout is still finalizing a commit. It will reconnect after finalization.');
  // Compare with the actual shared main checkout, never the legacy clone's
  // own main ref: that independent ref can contain unpublished commits.
  try { await run(['-C', main, 'merge-base', '--is-ancestor', sha, 'HEAD']); }
  catch { throw new Error('This old main checkout has separate commits. Preserve them before reconnecting.'); }
  await switchRepository(vscode, root, main, options);
  return true;
}

async function recordDeletedBranchReturn(repository, branch, defaultBranch) {
  if (defaultBranch !== 'main' || !branch || !repository.rootUri?.fsPath) return;
  const root = await fs.realpath(repository.rootUri.fsPath);
  if (await git(['-C', root, 'branch', '--show-current'])) return;
  if ((await git(['-C', root, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + branch]))
      .split('\n').includes('refs/heads/' + branch)) return;
  const directory = await git(['-C', root, 'rev-parse', '--absolute-git-dir']);
  const head = await git(['-C', root, 'rev-parse', 'HEAD']);
  const headStamp = (await fs.stat(path.join(directory, 'HEAD'))).mtimeMs;
  const receipt = path.join(directory, DELETION_RETURN);
  const temporary = receipt + '.' + require('node:crypto').randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({
      version: 1, root, branch, head, headStamp, initiatorPid: process.pid
    }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, receipt);
  } finally { await fs.rm(temporary, {force: true}); }
}

async function reconnectDeletedBranch(vscode, options = {}) {
  const run = options.run || git;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'file') continue;
    const location = await run(['-C', folder.uri.fsPath, 'rev-parse', '--show-toplevel']).catch(() => null);
    if (!location) continue;
    const root = await fs.realpath(location);
    const directory = await run(['-C', root, 'rev-parse', '--absolute-git-dir']);
    const receipt = await fs.readFile(path.join(directory, DELETION_RETURN), 'utf8')
      .then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    if (receipt?.version !== 1 || receipt.root !== root || typeof receipt.branch !== 'string'
        || !/^[a-f0-9]{40,64}$/i.test(receipt.head || '')) continue;
    if (receipt.initiatorPid === options.ignorePid) continue;
    if (await run(['-C', root, 'branch', '--show-current'])
        || await run(['-C', root, 'rev-parse', 'HEAD']) !== receipt.head
        || (await fs.stat(path.join(directory, 'HEAD'))).mtimeMs !== receipt.headStamp
        || await run(['-C', root, 'status', '--porcelain', '--untracked-files=all'])) continue;
    if ((await run(['-C', root, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + receipt.branch]))
        .split('\n').includes('refs/heads/' + receipt.branch)) continue;
    return routeBranch(vscode, {rootUri: {fsPath: root}}, {...options, branch: 'main'});
  }
  return false;
}

function registerSharedMain(vscode, context) {
  let running = false, again = false;
  const watchers = new Map();
  const observe = async () => {
    const directories = new Set();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme !== 'file') continue;
      const directory = await git(['-C', folder.uri.fsPath, 'rev-parse', '--absolute-git-dir']).catch(() => null);
      if (!directory) continue;
      directories.add(directory);
      if (watchers.has(directory)) continue;
      const watcher = require('node:fs').watch(directory, {persistent: false}, (_, name) => {
        if (String(name) === DELETION_RETURN) void reconnect();
      });
      watcher.on('error', () => { watcher.close(); watchers.delete(directory); });
      watchers.set(directory, watcher);
    }
    for (const [directory, watcher] of watchers) {
      if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
    }
  };
  const reconnect = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      await observe();
      if (!await reconnectDeletedBranch(vscode, {ignorePid: process.pid})) await reconnectManagedMain(vscode);
    }
    catch (error) { vscode.window.showWarningMessage('Sweetiebot: ' + error.message); }
    finally {
      running = false;
      if (again) { again = false; queueMicrotask(() => void reconnect()); }
    }
  };
  // Saved shared-main windows may point at a managed main worktree; those
  // checkouts are already the target and must not be reconnected again.
  setImmediate(() => void reconnect());
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void reconnect()));
  context.subscriptions.push({dispose() { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); }});
}

module.exports = { originalRepository, mainRoot, openSharedMainWorkspace, routeBranch,
  routeExistingBranchWorktree,
  reconnectManagedMain, registerSharedMain, recordDeletedBranchReturn, reconnectDeletedBranch };
