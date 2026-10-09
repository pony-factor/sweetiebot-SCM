'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const repositoryOperations = new WeakMap();
const activeCommits = new WeakMap();

function commitInProgress(repository) {
  return (activeCommits.get(repository) ?? 0) > 0;
}

function beginRepositoryCommit(repository) {
  activeCommits.set(repository, (activeCommits.get(repository) ?? 0) + 1);
}

function endRepositoryCommit(repository) {
  const remaining = (activeCommits.get(repository) ?? 0) - 1;
  if (remaining > 0) activeCommits.set(repository, remaining);
  else activeCommits.delete(repository);
}

function queueRepositoryOperation(repository, operation) {
  const previous = repositoryOperations.get(repository) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  repositoryOperations.set(repository, current);
  return current.finally(() => {
    if (repositoryOperations.get(repository) === current) repositoryOperations.delete(repository);
  });
}

async function gitConfig(repository, key, fallback) {
  if (!repository.rootUri?.fsPath) return fallback;
  try {
    const { stdout } = await promisify(execFile)('git', ['config', '--get', key], {
      cwd: repository.rootUri.fsPath, timeout: 10000
    });
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
}

const resolvedDefaultBranches = new WeakMap();

// A repository-local override wins; otherwise identify the real remote HEAD.
// Cache the result briefly so branch-control refreshes do not repeatedly fetch.
async function resolveDefaultBranch(repository, remote = 'origin') {
  const cwd = repository.rootUri?.fsPath;
  if (!cwd) return gitConfig(repository, 'scm-toolkit.default-branch', 'main');
  const cached = resolvedDefaultBranches.get(repository);
  if (cached?.remote === remote && cached.expires > Date.now()) return cached.name;
  const git = async args => (await promisify(execFile)('git', args, {
    cwd, timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  let name;
  try {
    name = await git(['config', '--local', '--get', 'scm-toolkit.default-branch']);
  } catch { /* No local override. */ }
  if (!name) {
    try {
      const refs = await git(['ls-remote', '--symref', remote, 'HEAD']);
      name = refs.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1];
    } catch { /* Use the remote-tracking symbolic ref when offline. */ }
  }
  if (!name) {
    try {
      const ref = await git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
      if (ref.startsWith(`${remote}/`)) name = ref.slice(remote.length + 1);
    } catch { /* No remote HEAD available locally. */ }
  }
  if (!name) {
    const configured = await gitConfig(repository, 'scm-toolkit.default-branch', 'main');
    try {
      await git(['show-ref', '--verify', `refs/heads/${configured}`]);
      name = configured;
    } catch { /* Do not guess a nonexistent branch. */ }
  }
  if (!name) {
    throw new Error(`Could not determine this repository's default branch. Check ${remote}/HEAD or set a repository-local scm-toolkit.default-branch override.`);
  }
  resolvedDefaultBranches.set(repository, { remote, name, expires: Date.now() + 60000 });
  return name;
}

async function automaticPullTarget(repository, head, remote) {
  const defaultBranch = await resolveDefaultBranch(repository, remote || 'origin');
  if (head?.name === defaultBranch) {
    return {
      remote: remote || await gitConfig(repository, 'scm-toolkit.remote', head.upstream?.remote),
      name: defaultBranch
    };
  }
  return { remote: head?.upstream?.remote, name: head?.upstream?.name };
}

async function automaticPullDivergence(repository, head, target) {
  if (target.remote === head?.upstream?.remote && target.name === head?.upstream?.name) {
    return { ahead: head.ahead ?? 0, behind: head.behind ?? 0 };
  }
  if (!repository.rootUri?.fsPath || !target.remote || !target.name) return undefined;
  try {
    const { stdout } = await promisify(execFile)('git', [
      'rev-list', '--left-right', '--count',
      `HEAD...refs/remotes/${target.remote}/${target.name}`
    ], { cwd: repository.rootUri.fsPath, timeout: 10000 });
    const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
    return { ahead, behind };
  } catch {
    return undefined;
  }
}

async function autoPullClean(repository, { fetch = false, remote } = {}) {
  // A commit and a fast-forward both update HEAD. Never let Sweetiebot move the
  // branch ref while VS Code/Git is building or finalizing a commit.
  if (commitInProgress(repository)) return false;
  await repository.status();
  if (commitInProgress(repository)) return false;
  const previous = { ...repository.state.HEAD, upstream: { ...repository.state.HEAD?.upstream } };
  const target = await automaticPullTarget(repository, previous, remote);
  if (!target.remote || !target.name) return false;
  if (fetch) {
    if (repository.state.mergeChanges?.length) return false;
    await repository.fetch({ remote: target.remote, ref: target.name });
    await repository.status();
    if (commitInProgress(repository)) return false;
    const current = repository.state.HEAD;
    if (current?.name !== previous.name || current?.commit !== previous.commit
        || current?.upstream?.remote !== previous.upstream.remote
        || current?.upstream?.name !== previous.upstream.name) return false;
  }
  const { HEAD: head, mergeChanges = [] } = repository.state;
  const divergence = await automaticPullDivergence(repository, head, target);
  if (!divergence?.behind || divergence.ahead !== 0
      || mergeChanges.length || commitInProgress(repository)) return false;
  if (repository.rootUri?.fsPath) {
    // Let Git carry nonconflicting local edits; never create a merge commit or
    // overwrite a changed path. A failed fast-forward preserves the worktree.
    await promisify(execFile)('git', ['merge', '--ff-only', `refs/remotes/${target.remote}/${target.name}`], {
      cwd: repository.rootUri.fsPath, timeout: 120000
    });
  } else {
    await repository.merge(`${target.remote}/${target.name}`);
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

async function returnHome(repository, { defaultBranch = 'main' } = {}) {
  await repository.checkout(defaultBranch);
  await repository.status();
  if (repository.state.HEAD?.name !== defaultBranch) {
    throw new Error(`Could not switch to ${defaultBranch}.`);
  }
  return defaultBranch;
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n');
}


function gitErrorLines(error) {
  const seen = new Set();
  const lines = [];
  for (const value of [error?.stderr, error?.stdout, error?.message]) {
    for (const raw of String(value || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line
          || /^(?:Git error|Failed to execute git)$/i.test(line)
          || /^Command failed: git\b/i.test(line)
          || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}

function formatGitError(error) {
  const details = errorText(error);
  let reason;

  if (/index\.lock|unable to create .*\.lock|another git process/i.test(details)) {
    reason = 'Git is locked by another Git process. Let that operation finish, or remove the stale lock file if no Git process is running.';
  } else if (/CONFLICT|unmerged files|unmerged changes|resolve your current index first|fix conflicts/i.test(details)) {
    reason = 'Git stopped because there are unresolved merge conflicts. Resolve the conflicted files, then try again.';
  } else if (/local changes.*would be overwritten|would be overwritten by (?:checkout|merge)/i.test(details)) {
    reason = 'Git refused because local changes would be overwritten. Commit or move those changes, then try again.';
  } else if (/authentication failed|could not read username|permission denied \(publickey\)|repository not found/i.test(details)) {
    reason = 'Git could not authenticate with the remote. Check the GitHub sign-in and remote access, then try again.';
  } else if (/non-fast-forward|fetch first|tip of your current branch is behind/i.test(details)) {
    reason = 'Git rejected the update because the remote branch has newer commits. Sync the branch, then try again.';
  } else if (/not a git repository/i.test(details)) {
    reason = 'This folder is not a Git repository.';
  } else if (/pathspec .* did not match|unknown revision|bad revision|couldn['’]t find remote ref/i.test(details)) {
    reason = 'Git could not find the requested branch, ref, or path.';
  } else if (/detached HEAD|not currently on a branch/i.test(details)) {
    reason = 'Git cannot complete this operation while HEAD is detached. Check out a branch, then try again.';
  } else {
    const line = gitErrorLines(error)[0];
    reason = line
      ? line.replace(/^(?:fatal|error):\s*/i, '').slice(0, 320)
      : `Git reported ${error?.gitErrorCode || 'an error'} without a specific reason. Open Git Output for the command details.`;
  }

  return reason;
}

function explainGitError(error) {
  const message = String(error?.message || '').trim();
  const isGitFailure = Boolean(
    error?.gitErrorCode
    || error?.stderr
    || error?.stdout
    || /^(?:Git error|Failed to execute git)$/i.test(message)
  );
  if (!isGitFailure || (error?.cause && message === formatGitError(error.cause))) return error;
  return new Error(formatGitError(error), { cause: error });
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
    // Checking the default branch out in a separate worktree reserves it without switching
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
  if (repository.state.mergeChanges?.length) {
    throw new Error('Resolve the merge conflicts before deleting the branch.');
  }
  await repository.fetch({ remote, prune: true });
  await repository.status();
  if (repository.state.HEAD?.name !== branch) {
    throw new Error('The active branch changed while preparing branch cleanup.');
  }
  const refs = await repository.getRefs({ pattern: `refs/remotes/${remote}` });
  if (!refs.length) throw new Error(`Cannot delete ${branch}: ${remote} could not be verified.`);
  if (refs.some(ref => ref.name === `${remote}/${branch}`)) {
    throw new Error(`Cannot delete ${branch}: it still exists on ${remote}.`);
  }
  const home = await repository.getBranch(defaultBranch);
  if (home.upstream?.remote !== remote || !home.upstream.name) {
    throw new Error(`${defaultBranch} must track a branch on ${remote} before syncing.`);
  }
  // Advance the inactive local ref before checkout. Checking out a stale default
  // branch first can reject edits based on the merged topic, even when the updated branch
  // can carry them intact. Git rejects non-fast-forwards and worktree-held refs;
  // this never creates a merge commit, pushes, stashes, or changes staging.
  await repository.fetch({
    remote: '.',
    ref: `refs/remotes/${remote}/${home.upstream.name}:refs/heads/${defaultBranch}`
  });
  await repository.status();
  if (repository.state.HEAD?.name !== branch) {
    throw new Error('The active branch changed while preparing branch cleanup.');
  }
  await repository.checkout(defaultBranch);
  await repository.status();
  if (repository.state.HEAD?.name !== defaultBranch) {
    throw new Error(`Could not switch to ${defaultBranch}.`);
  }
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
  const resolveRepository = async uri => {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const repositoryUri = vscode.Uri.from(uri?.rootUri ?? uri);
    const repository = git.getAPI(1).getRepository(repositoryUri);
    if (!repository) throw new Error('The selected Git repository is unavailable.');
    return repository;
  };

  const needsDefaultBranch = new Set([
    'sweetiebot.returnHome', 'sweetiebot.createBranch',
    'sweetiebot.deleteBranch', 'sweetiebot.syncBranch'
  ]);
  for (const [command, action] of [
    ['sweetiebot.returnHome', returnHome],
    ['sweetiebot.autoPullClean', autoPullClean],
    ['sweetiebot.createBranch', createBranch],
    ['sweetiebot.publishBranch', publishBranch],
    ['sweetiebot.deleteBranch', deleteBranch],
    ['sweetiebot.syncBranch', syncBranch]
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (uri, options) => {
      try {
        const repository = await resolveRepository(uri);
        return await queueRepositoryOperation(repository, async () => {
          if (!needsDefaultBranch.has(command)) return action(repository, options);
          const defaultBranch = await resolveDefaultBranch(repository, options?.remote || 'origin');
          return action(repository, { ...options, defaultBranch });
        });
      } catch (error) {
        throw explainGitError(error);
      }
    }));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.resolveDefaultBranch', async (uri, options) => {
      try {
        const repository = await resolveRepository(uri);
        return await resolveDefaultBranch(repository, options?.remote || 'origin');
      } catch (error) {
        throw explainGitError(error);
      }
    }),
    vscode.commands.registerCommand('sweetiebot.beginCommit', async uri => {
      const repository = await resolveRepository(uri);
      return queueRepositoryOperation(repository, () => beginRepositoryCommit(repository));
    }),
    vscode.commands.registerCommand('sweetiebot.endCommit', async uri => {
      const repository = await resolveRepository(uri);
      return queueRepositoryOperation(repository, () => endRepositoryCommit(repository));
    })
  );

  let scanning = false, disposed = false;
  const lastFetch = new WeakMap();
  const retryAfter = new WeakMap();
  const scan = async () => {
    if (scanning || disposed) return;
    scanning = true;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) return;
      const git = await extension.activate();
      for (const repository of git.getAPI(1).repositories ?? []) {
        if (disposed || repository.rootUri.scheme !== 'file') continue;
        const head = repository.state.HEAD;
        if (!head?.name || commitInProgress(repository)) continue;
        const defaultBranch = await resolveDefaultBranch(repository);
        if (head.name !== defaultBranch) continue;
        const now = Date.now();
        if (now < (retryAfter.get(repository) ?? 0)) continue;
        const fetch = !lastFetch.has(repository) || now - lastFetch.get(repository) >= 60000;
        // Git may discover an incoming commit through another fetch. Pull it
        // promptly instead of waiting for our next network-fetch interval.
        if (!fetch && (!head.behind || head.ahead)) continue;
        await queueRepositoryOperation(repository, async () => {
          if (disposed || commitInProgress(repository)) return;
          await repository.status();
          if (disposed || repository.state.HEAD?.name !== defaultBranch) return;
          try {
            const { stdout } = await promisify(execFile)('git', ['config', '--bool', '--get', 'scm-toolkit.auto-pull-clean'], {
              cwd: repository.rootUri.fsPath, timeout: 10000
            });
            if (stdout.trim() !== 'true') return;
          } catch (error) {
            if (error.code !== 1) return; // An unset preference defaults to enabled.
          }
          if (fetch) lastFetch.set(repository, Date.now());
          await autoPullClean(repository, { fetch });
          retryAfter.delete(repository);
        }).catch(() => {
          // Avoid repeatedly attempting an overlapping fast-forward every second.
          retryAfter.set(repository, Date.now() + 5000);
        }); // Git preserves edits when an incoming path overlaps.
      }
    } finally {
      scanning = false;
    }
  };
  const run = () => void scan().catch(() => {});
  const timer = setInterval(run, 1000);
  timer.unref?.();
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); } });
  run();
}

module.exports = {
  resolveDefaultBranch,
  returnHome,
  createBranch,
  publishBranch,
  deleteBranch,
  syncBranch,
  registerBranchCommands,
  autoPullClean,
  beginRepositoryCommit,
  endRepositoryCommit,
  commitInProgress,
  formatGitError,
  explainGitError
};
