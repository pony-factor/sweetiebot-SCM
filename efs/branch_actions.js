'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdtemp, rm, readFile, writeFile, rename } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { isConflictState, offerConflictRecoveryOptions } = require('./lindsey_conflicts');

const repositoryOperations = new WeakMap();
const activeCommits = new WeakMap();
const POST_COMMIT_GATE = 'sweetiebot-post-commit-push.json';

// Store coordination only in .git; never stage or alter the committed worktree.
async function spellcheckPushGateFile(repository) {
  const root = repository.rootUri?.fsPath;
  if (!root) return null;
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, timeout: 10000 });
  const gitdir = stdout.trim();
  return path.isAbsolute(gitdir) ? path.join(gitdir, POST_COMMIT_GATE) : null;
}

async function storeSpellcheckPushGate(file, gate) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(gate), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function armSpellcheckPushGate(repository) {
  try {
    const file = await spellcheckPushGateFile(repository);
    if (!file) return null;
    const token = randomUUID();
    // Use Git's actual pre-commit HEAD rather than a potentially stale VS Code
    // status snapshot, so the worker can match this gate to the right commit.
    let previousHead = '';
    try {
      previousHead = (await promisify(execFile)('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repository.rootUri.fsPath, timeout: 10000
      })).stdout.trim();
    } catch { /* An unborn repository has no HEAD yet. */ }
    await storeSpellcheckPushGate(file, {
      token, state: 'pending', created_ms: Date.now(),
      previous_head: previousHead,
      branch: repository.state.HEAD?.name || ''
    });
    return token;
  } catch {
    // Keep normal Git commits usable even when this optional gate is unavailable.
    return null;
  }
}

async function releaseSpellcheckPushGate(repository, token, pushed) {
  if (!token) return;
  try {
    const file = await spellcheckPushGateFile(repository);
    if (!file) return;
    const gate = JSON.parse(await readFile(file, 'utf8'));
    if (gate.token !== token || gate.state !== 'pending') return;
    await storeSpellcheckPushGate(file, { ...gate, state: pushed ? 'pushed' : 'failed' });
  } catch {
    // A worker with an unreleased gate times out without touching files.
  }
}

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


function isBlockedByLocalChanges(error) {
  const details = [errorText(error), errorText(error?.cause)].join('\n');
  return /(?:local changes|untracked (?:working tree )?files)[\s\S]*?would be overwritten|would be overwritten by (?:checkout|merge|switch)|commit or stash your changes before/i.test(details);
}

async function stashLocalChanges(repository, command) {
  const cwd = repository.rootUri?.fsPath;
  if (!cwd) throw new Error('This repository has no local working directory for a Git stash.');
  const git = async args => (await promisify(execFile)('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  const before = await git(['rev-parse', '-q', '--verify', 'refs/stash']).catch(() => '');
  await git(['stash', 'push', '--include-untracked', '-m', `Sweetiebot recovery: ${command}`]);
  const after = await git(['rev-parse', '-q', '--verify', 'refs/stash']).catch(() => '');
  if (!after || after === before) {
    throw new Error('Git found no changes to stash. Review the working tree before retrying.');
  }
  return after;
}

// Do not discard or silently move local edits. Only the explicit stash choice
// changes the working tree, and its saved changes stay recoverable after retry.
async function offerBlockedChangesOptions(vscode, repository, command, retry, stash = stashLocalChanges) {
  const choices = [
    { label: '$(diff) Review changes', description: 'Open Source Control without changing files', id: 'review' },
    { label: '$(archive) Stash changes and retry', description: 'Save staged, unstaged, and untracked changes; restore them later', id: 'stash' },
    { label: '$(check) Commit changes', description: 'Open Source Control to commit, then retry manually', id: 'commit' },
    { label: '$(output) Show Git output', description: 'Inspect the original error before deciding', id: 'output' },
    { label: '$(circle-slash) Cancel', description: 'Keep all local changes untouched', id: 'cancel' }
  ];
  const choice = await vscode.window.showQuickPick(choices, {
    title: 'Git blocked this operation to protect local changes',
    placeHolder: 'Choose how to preserve your work',
    ignoreFocusOut: true
  });
  if (choice?.id === 'review' || choice?.id === 'commit') {
    await vscode.commands.executeCommand('workbench.view.scm');
  } else if (choice?.id === 'output') {
    await vscode.commands.executeCommand('git.showOutput');
  } else if (choice?.id === 'stash') {
    const expectedBranch = repository.state.HEAD?.name;
    return queueRepositoryOperation(repository, async () => {
      await repository.status();
      if (repository.state.HEAD?.name !== expectedBranch) {
        throw new Error('The active branch changed while choosing recovery. Review the changes and try again.');
      }
      if (repository.state.mergeChanges?.length) {
        throw new Error('Resolve merge conflicts before stashing changes.');
      }
      const stashSha = await stash(repository, command);
      void vscode.window.showInformationMessage(
        `Saved local changes in Git stash (${stashSha.slice(0, 8)}). Restore them with git stash pop --index when ready.`
      );
      return retry();
    });
  }
  // Cancelling or opening the review/commit/output UI should not report success.
  return undefined;
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

/**
 * Delete a topic with no commits of its own, including the matching origin
 * branch when published. Do not reuse merged-PR cleanup for this: an empty
 * branch has no PR to validate. All remote deletion is SHA-leased.
 */
async function deleteEmptyBranch(repository, { branch, defaultBranch, remote = 'origin' }) {
  if (!branch || !defaultBranch || branch === defaultBranch) {
    throw new Error('Select a non-default branch to delete.');
  }
  if (!repository.rootUri?.fsPath) throw new Error('A local Git repository is required.');
  const root = repository.rootUri.fsPath;
  const git = async (...args) => (await promisify(execFile)('git', args, {
    cwd: root, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/heads/${branch}`;
  const verifyCurrent = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== branch) {
      throw new Error('The active branch changed; no branch was deleted.');
    }
  };
  await verifyCurrent();
  if (commitInProgress(repository)) throw new Error('Finish the current commit before deleting a branch.');
  if (repository.state.mergeChanges?.length || await git('status', '--porcelain')) {
    throw new Error('Commit, stash, or discard working-tree changes before deleting an empty branch.');
  }
  const expected = await git('rev-parse', '--verify', localRef);
  const home = await repository.getBranch(defaultBranch);
  if (!home?.upstream?.name || home.upstream.remote !== remote) {
    throw new Error(`${defaultBranch} must track a branch on ${remote} before deleting an empty branch.`);
  }

  // The actual remote must be reachable; remote-tracking refs alone may be stale.
  await git('fetch', '--prune', '--no-tags', remote);
  const baseRef = `refs/remotes/${remote}/${home.upstream.name}`;
  await git('rev-parse', '--verify', baseRef);
  if (await git('rev-parse', '--verify', localRef) !== expected) {
    throw new Error('The branch advanced while checking it; deletion was cancelled.');
  }
  try {
    await git('merge-base', '--is-ancestor', expected, baseRef);
  } catch (error) {
    if (error.code === 1) {
      throw new Error(`Cannot delete ${branch}: it contains commits absent from ${remote}/${home.upstream.name}.`);
    }
    throw error;
  }
  const refs = await git('ls-remote', '--heads', remote, remoteRef);
  const remoteTip = refs.split('\n').filter(Boolean)
    .map(line => line.split('\t'))
    .find(parts => parts.length === 2 && parts[1] === remoteRef)?.[0] || null;
  if (refs.trim() && !remoteTip) throw new Error('Could not verify the remote branch.');
  if (remoteTip && remoteTip !== expected) {
    throw new Error(`Cannot delete ${remote}/${branch}: its tip differs from the local branch.`);
  }

  // Fast-forward the inactive default ref when possible. If the local
  // default is already ahead of origin, preserve those unpublished commits.
  await verifyCurrent();
  const localBaseRef = `refs/heads/${defaultBranch}`;
  let canFastForward;
  try {
    await git('merge-base', '--is-ancestor', localBaseRef, baseRef);
    canFastForward = true;
  } catch (error) {
    if (error.code !== 1) throw error;
    canFastForward = false;
  }
  if (canFastForward) {
    await repository.fetch({ remote: '.', ref: `${baseRef}:${localBaseRef}` });
  } else {
    try {
      await git('merge-base', '--is-ancestor', expected, localBaseRef);
    } catch (error) {
      if (error.code === 1) {
        throw new Error('The local default branch diverges from the empty branch; deletion was cancelled.');
      }
      throw error;
    }
  }
  await verifyCurrent();
  if (await git('rev-parse', '--verify', localRef) !== expected
      || await git('status', '--porcelain')) {
    throw new Error('The branch or working tree changed during verification; deletion was cancelled.');
  }
  await repository.checkout(defaultBranch);
  await repository.status();
  if (repository.state.HEAD?.name !== defaultBranch) {
    throw new Error('Could not safely switch to the default branch; deletion was cancelled.');
  }
  if (await git('rev-parse', '--verify', localRef) !== expected) {
    throw new Error('The branch advanced after checkout; deletion was cancelled.');
  }

  // Git compares the exact expected remote tip before accepting the deletion.
  // Never delete a newer remote branch even if another user pushes meanwhile.
  if (remoteTip) {
    await git('push', `--force-with-lease=${remoteRef}:${remoteTip}`,
      remote, `:${remoteRef}`);
  }
  if (await git('rev-parse', '--verify', localRef) !== expected) {
    throw new Error('The local branch advanced during remote deletion and was preserved.');
  }
  await repository.deleteBranch(branch, false);
  return { branch, remoteDeleted: Boolean(remoteTip) };
}

async function syncBranch(repository, { branch, defaultBranch, remote, strategy = 'squash' }) {
  if (!branch || branch === defaultBranch) throw new Error(`Cannot sync ${defaultBranch} into itself.`);
  if (!['squash', 'merge'].includes(strategy)) throw new Error('Unknown branch synchronization strategy.');
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
  const message = defaultBranch === 'main'
    ? '🔄 Sync brach to main'
    : `🔄 Sync branch to ${defaultBranch}`;
  repository.inputBox.value = message;
  try {
    if (strategy === 'merge') {
      // Keep ordinary Git ancestry as an explicit alternative.
      await repository.merge(`${remote}/${defaultBranch}`);
    } else {
      const root = repository.rootUri.fsPath;
      const git = async args => (await promisify(execFile)('git', args, {
        cwd: root, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })).stdout.trim();
      // Squash must not consume the user's index, working tree, or unresolved conflicts.
      if (await git(['status', '--porcelain'])) {
        throw new Error('Commit or stash your changes before squashing the default branch.');
      }
      const target = `refs/remotes/${remote}/${defaultBranch}`;
      const headBefore = await git(['rev-parse', 'HEAD']);
      // If the target is already an ancestor there is nothing to incorporate.
      const ancestor = await promisify(execFile)('git',
        ['merge-base', '--is-ancestor', target, 'HEAD'], { cwd: root })
        .then(() => true, error => {
          if (error.code === 1) return false;
          throw error;
        });
      if (!ancestor) {
        await checkBranch();
        // A conflict intentionally leaves the index and worktree available to resolve.
        await git(['merge', '--squash', target]);
        await checkBranch();
        const staged = await promisify(execFile)('git',
          ['diff', '--cached', '--quiet'], { cwd: root })
          .then(() => false, error => {
            if (error.code === 1) return true;
            throw error;
          });
        if (staged) {
          if (await git(['rev-parse', 'HEAD']) !== headBefore) {
            throw new Error('The branch advanced during synchronization; changes were left staged.');
          }
          await git(['commit', '-m', `${message}\n\nCo-authored-by: Codex Web <noreply@openai.com>`]);
        }
      }
    }
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
        const attempt = async () => {
          if (!needsDefaultBranch.has(command)) return action(repository, options);
          const defaultBranch = await resolveDefaultBranch(repository, options?.remote || 'origin');
          return action(repository, { ...options, defaultBranch });
        };
        try {
          return await queueRepositoryOperation(repository, attempt);
        } catch (error) {
          // Conflicts differ from a dirty checkout and must never be stashed.
          await repository.status();
          if (isConflictState(repository)) {
            return await offerConflictRecoveryOptions(vscode, repository);
          }
          if (!isBlockedByLocalChanges(error)) throw error;
          return await offerBlockedChangesOptions(vscode, repository, command, attempt);
        }
      } catch (error) {
        throw explainGitError(error);
      }
    }));
  }

  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.deleteEmptyBranch', async (uri, options = {}) => {
    try {
      const repository = await resolveRepository(uri);
      const defaultBranch = await resolveDefaultBranch(repository, options.remote || 'origin');
      const branch = options.branch;
      if (!branch || branch === defaultBranch) throw new Error('Select a non-default branch to delete.');
      const choice = await vscode.window.showWarningMessage(
        `Delete empty branch "${branch}"?`,
        { modal: true, detail: `This deletes the local branch and, if present, ${options.remote || 'origin'}/${branch}. A branch with unique commits or unmatched remote changes is protected.` },
        'Delete Empty Branch'
      );
      if (choice !== 'Delete Empty Branch') return false;
      return await queueRepositoryOperation(repository, () => deleteEmptyBranch(repository, {
        branch, defaultBranch, remote: options.remote || 'origin'
      }));
    } catch (error) {
      throw explainGitError(error);
    }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.resolveDefaultBranch', async (uri, options) => {
      try {
        const repository = await resolveRepository(uri);
        return await resolveDefaultBranch(repository, options?.remote || 'origin');
      } catch (error) {
        throw explainGitError(error);
      }
    }),
    vscode.commands.registerCommand('sweetiebot.beginCommit', async (uri, options) => {
      const repository = await resolveRepository(uri);
      return queueRepositoryOperation(repository, async () => {
        beginRepositoryCommit(repository);
        return options?.waitForPush ? armSpellcheckPushGate(repository) : null;
      });
    }),
    vscode.commands.registerCommand('sweetiebot.endCommit', async (uri, options) => {
      const repository = await resolveRepository(uri);
      return queueRepositoryOperation(repository, async () => {
        try {
          await releaseSpellcheckPushGate(repository, options?.gateToken, options?.pushed === true);
        } finally {
          endRepositoryCommit(repository);
        }
      });
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
        const now = Date.now();
        if (now < (retryAfter.get(repository) ?? 0)) continue;
        const fetch = !lastFetch.has(repository) || now - lastFetch.get(repository) >= 60000;
        // Git may discover an incoming commit through another fetch. Pull it
        // promptly instead of waiting for our next network-fetch interval.
        if (!fetch && (!head.behind || head.ahead)) continue;
        await queueRepositoryOperation(repository, async () => {
          if (disposed || commitInProgress(repository)) return;
          await repository.status();
          // Follow the branch that was scanned, including tracked topic branches.
          // A checkout while this operation was queued must wait for the next scan.
          if (disposed || repository.state.HEAD?.name !== head.name) return;
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
  deleteEmptyBranch,
  syncBranch,
  registerBranchCommands,
  autoPullClean,
  beginRepositoryCommit,
  endRepositoryCommit,
  commitInProgress,
  formatGitError,
  explainGitError,
  isBlockedByLocalChanges,
  offerBlockedChangesOptions,
  stashLocalChanges
};
