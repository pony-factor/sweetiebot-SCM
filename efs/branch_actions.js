'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const repositoryOperations = new WeakMap();

function queueRepositoryOperation(repository, operation) {
  const previous = repositoryOperations.get(repository) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  repositoryOperations.set(repository, current);
  return current.finally(() => {
    if (repositoryOperations.get(repository) === current) repositoryOperations.delete(repository);
  });
}

async function autoPullClean(repository, { fetch = false } = {}) {
  // Read fresh extension-host state after earlier branch operations finish.
  await repository.status();
  const previous = { ...repository.state.HEAD, upstream: { ...repository.state.HEAD?.upstream } };
  if (fetch) {
    if (!previous.upstream.remote || !previous.upstream.name || repository.state.mergeChanges?.length) return false;
    await repository.fetch({ remote: previous.upstream.remote, ref: previous.upstream.name });
    await repository.status();
    const current = repository.state.HEAD;
    if (current?.name !== previous.name || current?.commit !== previous.commit
        || current?.upstream?.remote !== previous.upstream.remote
        || current?.upstream?.name !== previous.upstream.name) return false;
  }
  const { HEAD: head, mergeChanges = [] } = repository.state;
  if (!head?.upstream || !head.behind || head.ahead !== 0
      || mergeChanges.length) return false;
  if (repository.rootUri?.fsPath) {
    // Let Git carry nonconflicting local edits; never create a merge commit or
    // overwrite a changed path. A failed fast-forward preserves the worktree.
    await promisify(execFile)('git', ['merge', '--ff-only', `refs/remotes/${head.upstream.remote}/${head.upstream.name}`], {
      cwd: repository.rootUri.fsPath, timeout: 120000
    });
  } else {
    await repository.merge(`${head.upstream.remote}/${head.upstream.name}`);
  }
  await repository.status();
  return true;
}

async function cleanupMergedBranch(repository, branch) {
  const installedScript = path.join(__dirname, 'prune_merged_branches.py');
  const script = existsSync(installedScript) ? installedScript : path.join(__dirname, '../scripts/prune_merged_branches.py');
  await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [
    script, '--force', '--repo', repository.rootUri.fsPath, `--branch=${branch}`
  ], { timeout: 120000 });
}

async function returnHome(repository) {
  await repository.checkout('main');
  await repository.status();
  if (repository.state.HEAD?.name !== 'main') {
    throw new Error('Could not switch to main.');
  }
  return 'main';
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n');
}

async function retryConnection(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !/timed? out|timeout|connection (?:reset|closed)|could not resolve host|failed to connect|HTTP (?:502|503|504)|requested URL returned error: (?:502|503|504)/i.test(errorText(error))) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function syncDefaultBranch(repository, defaultBranch, remote, checkout = true) {
  if (checkout) await repository.checkout(defaultBranch);
  const checkBranch = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== defaultBranch) {
      throw new Error(`Could not switch to ${defaultBranch}, or the active branch changed while syncing it.`);
    }
  };
  await checkBranch();
  const upstream = repository.state.HEAD.upstream;
  if (!upstream || upstream.remote !== remote) {
    throw new Error(`${defaultBranch} must track a branch on ${remote} before syncing.`);
  }
  for (let attempt = 0; ; attempt++) {
    // Fetch and merge explicitly: VS Code's throttled pull can retain a failed
    // queued request after a timeout, preventing later attempts from running.
    await retryConnection(async () => {
      await checkBranch();
      await repository.fetch({ remote });
    });
    await checkBranch();
    await repository.merge(`${remote}/${upstream.name}`);
    await checkBranch();
    if (!repository.state.HEAD.ahead) return;
    try {
      await retryConnection(async () => {
        await checkBranch();
        await repository.push(remote, `${defaultBranch}:${upstream.name}`);
      });
      await checkBranch();
      return;
    } catch (error) {
      // Another writer can advance the remote between fetching and pushing.
      // Merge their changes before retrying; never force-push or rebase.
      if (attempt >= 2 || !/non-fast-forward|fetch first|tip of your current branch is behind/i.test(errorText(error))) {
        throw error;
      }
    }
  }
}

async function syncDefaultBranchInBackground(repository, defaultBranch, remote) {
  await repository.status();
  const original = repository.state.HEAD?.name;
  if (original === defaultBranch) {
    await syncDefaultBranch(repository, defaultBranch, remote, false);
    return `refs/heads/${defaultBranch}`;
  }
  const run = promisify(execFile);
  const git = async (cwd, args) => (await run('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' }
  })).stdout.trim();
  const root = repository.rootUri.fsPath;
  const upstream = await git(root, ['rev-parse', '--symbolic-full-name', `${defaultBranch}@{upstream}`]);
  const prefix = `refs/remotes/${remote}/`;
  if (!upstream.startsWith(prefix)) throw new Error(`${defaultBranch} must track a branch on ${remote} before syncing.`);
  const checkBranch = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== original) {
      throw new Error('The active branch changed while preparing the new branch.');
    }
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sweetiebot-branch-'));
  const worktree = path.join(temporary, 'worktree');
  let added = false;
  try {
    await checkBranch();
    // Checking main out in a separate worktree reserves it without switching
    // the user's editor or disturbing their working files.
    await git(root, ['worktree', 'add', '--quiet', worktree, defaultBranch]);
    added = true;
    for (let attempt = 0; ; attempt++) {
      await retryConnection(() => git(worktree, ['fetch', remote]));
      await checkBranch();
      try {
        await git(worktree, ['merge', '--no-edit', upstream]);
      } catch (error) {
        throw new Error(`Could not sync ${defaultBranch} in the background. ${errorText(error).includes('CONFLICT') ? 'Its local and remote changes conflict; sync and resolve them before creating a new branch.' : error.stderr?.trim() || error.message} Your current branch was preserved.`, { cause: error });
      }
      const tip = await git(worktree, ['rev-parse', 'HEAD']);
      const ahead = await git(worktree, ['rev-list', '--count', `${upstream}..HEAD`]);
      if (ahead === '0') return tip;
      await checkBranch();
      try {
        await retryConnection(() => git(worktree, ['push', remote, `${defaultBranch}:${upstream.slice(prefix.length)}`]));
        return tip;
      } catch (error) {
        if (attempt >= 2 || !/non-fast-forward|fetch first/i.test(errorText(error))) throw error;
      }
    }
  } finally {
    if (added) await git(root, ['worktree', 'remove', '--force', worktree]);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createBranch(repository, { defaultBranch, remote, names }, random = Math.random) {
  if (!names?.length) throw new Error('No pony branch names are configured.');
  await repository.status();
  if (repository.state.mergeChanges?.length) {
    throw new Error('Resolve the merge conflicts before creating a new branch.');
  }
  let original = repository.state.HEAD?.name;
  let start;
  if (repository.state.indexChanges?.length || repository.state.workingTreeChanges?.length) {
    // Preserve pending edits and their staging by avoiding a remote merge.
    await repository.checkout(defaultBranch);
    await repository.status();
    if (repository.state.HEAD?.name !== defaultBranch) {
      throw new Error(`Could not switch to ${defaultBranch}.`);
    }
    original = defaultBranch;
    start = 'HEAD';
  } else {
    start = await syncDefaultBranchInBackground(repository, defaultBranch, remote);
  }
  const refs = await repository.getRefs({ pattern: ['refs/heads', `refs/remotes/${remote}`] });
  const used = new Set(refs.flatMap(ref => [
    ref.name,
    ref.name?.startsWith(`${remote}/`) ? ref.name.slice(remote.length + 1) : ref.name
  ]));
  const available = [...new Set(names)].filter(name => !used.has(name));
  if (!available.length) throw new Error('All configured pony branch names are already in use.');
  const branch = available[Math.floor(random() * available.length)];
  await repository.status();
  if (repository.state.HEAD?.name !== original) throw new Error('The active branch changed while preparing the new branch.');
  await repository.createBranch(branch, true, start);
  return branch;
}

async function publishBranch(repository, { branch, remote }) {
  if (!branch) throw new Error('No branch was supplied for publishing.');
  await repository.status();
  const head = repository.state.HEAD;
  if (head?.name !== branch) {
    throw new Error('The active branch changed before it could be published.');
  }
  if (head.upstream) return false;
  await repository.push(remote, branch, true);
  return true;
}

async function deleteBranch(repository, { branch, defaultBranch, remote }, cleanup = cleanupMergedBranch) {
  if (!branch || branch === defaultBranch) throw new Error(`Cannot delete ${defaultBranch}.`);
  await repository.status();
  if (repository.state.HEAD?.name !== branch) {
    throw new Error('The active branch changed; select the branch to delete again.');
  }
  await repository.fetch({ remote, prune: true });
  const refs = await repository.getRefs({ pattern: `refs/remotes/${remote}` });
  if (!refs.length) throw new Error(`Cannot delete ${branch}: ${remote} could not be verified.`);
  if (refs.some(ref => ref.name === `${remote}/${branch}`)) {
    throw new Error(`Cannot delete ${branch}: it still exists on ${remote}.`);
  }
  await syncDefaultBranch(repository, defaultBranch, remote);
  try {
    await repository.deleteBranch(branch, false);
  } catch (error) {
    const stillExists = async () => (await repository.getRefs({ pattern: 'refs/heads' }))
      .some(ref => ref.name === branch);
    // Automatic cleanup may have removed the branch after checkout.
    if (!await stillExists()) return branch;
    if (error?.gitErrorCode !== 'BranchNotFullyMerged' && !/not fully merged/i.test(errorText(error))) {
      throw error;
    }
    // Squash merges do not satisfy Git's ancestry check. Reuse cleanup's
    // GitHub PR verification and atomic tip check rather than force-delete.
    await cleanup(repository, branch);
    if (await stillExists()) {
      throw new Error(`Cannot delete ${branch}: its current tip could not be verified as a merged pull request. The branch was preserved; you are now on ${defaultBranch}.`);
    }
    await repository.status();
  }
  return branch;
}

async function syncBranch(repository, { branch, defaultBranch, remote }) {
  if (!branch || branch === defaultBranch) throw new Error(`Cannot sync ${defaultBranch} into itself.`);
  const checkBranch = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== branch) {
      throw new Error('The active branch changed; select the branch to sync again.');
    }
  };
  await checkBranch();
  await repository.fetch({ remote });
  await checkBranch();
  const previousMessage = repository.inputBox.value;
  const message = `🔄 Sync branch with ${defaultBranch}`;
  repository.inputBox.value = message;
  try {
    await repository.merge(`${remote}/${defaultBranch}`);
  } finally {
    await repository.status();
    if (!repository.state.mergeChanges.length && repository.inputBox.value === message) {
      repository.inputBox.value = previousMessage;
    }
  }
  return branch;
}

function registerBranchCommands(vscode, context) {
  for (const [command, action] of [
    ['scmToolkit.returnHome', returnHome],
    ['scmToolkit.autoPullClean', autoPullClean],
    ['scmToolkit.createBranch', createBranch],
    ['scmToolkit.publishBranch', publishBranch],
    ['scmToolkit.deleteBranch', deleteBranch],
    ['scmToolkit.syncBranch', syncBranch]
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (uri, options) => {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) throw new Error('The VS Code Git extension is unavailable.');
      const git = await extension.activate();
      // Built-in Git status-bar commands pass a SourceControl, not a Uri.
      // Resolve its root before calling the public Git API.
      // Workbench command arguments cross the extension-host boundary as data.
      // The Git API requires a real extension-host Uri instance.
      const repositoryUri = vscode.Uri.from(uri?.rootUri ?? uri);
      const repository = git.getAPI(1).getRepository(repositoryUri);
      if (!repository) throw new Error('The selected Git repository is unavailable.');
      return queueRepositoryOperation(repository, () => action(repository, options));
    }));
  }
  let scanning = false, disposed = false;
  const scan = async () => {
    if (scanning || disposed) return;
    scanning = true;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) return;
      const git = await extension.activate();
      for (const repository of git.getAPI(1).repositories ?? []) {
        if (disposed || repository.rootUri.scheme !== 'file') continue;
        await queueRepositoryOperation(repository, async () => {
          await repository.status();
          if (disposed || repository.state.HEAD?.name !== 'main') return;
          try {
            const { stdout } = await promisify(execFile)('git', ['config', '--bool', '--get', 'scm-toolkit.auto-pull-clean'], {
              cwd: repository.rootUri.fsPath, timeout: 10000
            });
            if (stdout.trim() !== 'true') return;
          } catch (error) {
            if (error.code !== 1) return; // An unset preference defaults to enabled.
          }
          await autoPullClean(repository, { fetch: true });
        }).catch(() => {}); // Git preserves edits when an incoming path overlaps.
      }
    } finally {
      scanning = false;
    }
  };
  const run = () => void scan().catch(() => {});
  const timer = setInterval(run, 60000);
  timer.unref?.();
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); } });
  run();
}

module.exports = { returnHome, createBranch, publishBranch, deleteBranch, syncBranch, registerBranchCommands, autoPullClean };
