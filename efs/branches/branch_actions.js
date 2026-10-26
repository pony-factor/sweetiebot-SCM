'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdtemp, rm, readFile, writeFile, rename } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { isConflictState, offerConflictRecoveryOptions } = require('../merge/lindsey_conflicts');
const { reviewSyncConflicts, queueSyncReport, registerSyncReportPublisher } = require('../merge/sync_review');
const { loadBranchNameHistory, chooseBranchName, saveBranchNameHistory } = require('./branch_name_selection');
const { listBranchStrip, checkoutBranchStrip } = require('./branch_strip');
const { resolvePythonExecutable } = require('../ui/python_runtime');
const { recoveryPlan } = require('../commits/finalized_commit_recovery');
const { mergedBranchAction, mergedBranchStatus, warnMergedBranch } = require('./merged_branch');
const { routeBranch } = require('./shared_main');
const { createStackedBranch } = require('./stacked_branch');

const repositoryOperations = new WeakMap();
const activeCommits = new WeakMap();
const POST_COMMIT_GATE = 'sweetiebot-post-commit-push.json';

async function asyncCommitPending(repository, { background = true, refs = ['HEAD'] } = {}) {
  const root = repository.rootUri?.fsPath;
  if (!root || !existsSync(path.join(root, '.git'))) return false;
  // A checkout may have a .git directory or a linked-worktree .git file.
  // If a real checkout's metadata cannot be inspected, fail closed.
  try {
    const installedScript = path.join(__dirname, '../commits/background_commit.py');
    const script = existsSync(installedScript) ? installedScript : path.join(__dirname, '../../scripts/background_commit.py');
    const { stdout } = await promisify(execFile)(resolvePythonExecutable(), [
      script, background ? '--pending' : '--pending-legacy', ...refs
    ], { cwd: root, timeout: 10000 });
    const pending = JSON.parse(stdout);
    return typeof pending === 'boolean' ? pending : true;
  } catch {
    return true;
  }
}

async function requireFinalizedCommit(repository, options) {
  if (await asyncCommitPending(repository, options)) {
    throw new Error('A local commit message is still being finalized. Git operations and publishing are paused until it finishes.');
  }
}


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

async function armSpellcheckPushGate(repository, token = randomUUID()) {
  try {
    const file = await spellcheckPushGateFile(repository);
    if (!file) return null;
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
  const branch = repository.state.HEAD?.name;
  return [...(activeCommits.get(repository)?.values() || [])]
    .some(owner => !owner || !branch || owner === branch);
}

function beginRepositoryCommit(repository) {
  const token = randomUUID();
  const commits = activeCommits.get(repository) || new Map();
  commits.set(token, repository.state.HEAD?.name);
  activeCommits.set(repository, commits);
  return token;
}

function endRepositoryCommit(repository, token) {
  const commits = activeCommits.get(repository);
  if (!commits) return;
  if (!token) token = [...commits].find(([, owner]) => owner === repository.state.HEAD?.name)?.[0];
  commits.delete(token);
  if (!commits.size) activeCommits.delete(repository);
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
  if (commitInProgress(repository) || await asyncCommitPending(repository)) return false;
  await repository.status();
  if (commitInProgress(repository) || await asyncCommitPending(repository)) return false;
  const previous = { ...repository.state.HEAD, upstream: { ...repository.state.HEAD?.upstream } };
  const target = await automaticPullTarget(repository, previous, remote);
  if (!target.remote || !target.name) return false;
  if (fetch) {
    if (repository.state.mergeChanges?.length) return false;
    await retryFetch(() => repository.fetch({ remote: target.remote, ref: target.name }));
    await repository.status();
    if (commitInProgress(repository) || await asyncCommitPending(repository)) return false;
    const current = repository.state.HEAD;
    if (current?.name !== previous.name || current?.commit !== previous.commit
        || current?.upstream?.remote !== previous.upstream.remote
        || current?.upstream?.name !== previous.upstream.name) return false;
  }
  const { HEAD: head, mergeChanges = [] } = repository.state;
  const divergence = await automaticPullDivergence(repository, head, target);
  if (!divergence?.behind
      || mergeChanges.length || commitInProgress(repository)
      || await asyncCommitPending(repository)) return false;
  if (divergence.ahead !== 0) {
    const root = repository.rootUri?.fsPath;
    if (!root || head.name !== await resolveDefaultBranch(repository, target.remote)) return false;
    if (await gitConfig(repository, 'scm-toolkit.auto-reconcile-finalized-commits', 'false') !== 'true') return false;
    const plan = await recoveryPlan(root, head.name, `refs/remotes/${target.remote}/${target.name}`);
    if (!plan || commitInProgress(repository) || await asyncCommitPending(repository)) return false;
    await repository.status();
    if (repository.state.HEAD?.name !== plan.branch
        || repository.state.HEAD?.commit !== plan.local
        || repository.state.indexChanges?.length || repository.state.workingTreeChanges?.length
        || repository.state.mergeChanges?.length) return false;
    // An explicit opt-in permits this new merge commit. Existing commits retain
    // their identities, including any local descendants of the placeholder.
    await promisify(execFile)('git', ['merge', '--no-ff', '--no-edit', '-m',
      '🔄 Reconcile finalized commit history', plan.remote], { cwd: root, timeout: 120000 });
    await repository.status();
    return true;
  }
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
  const installedScript = path.join(__dirname, '../prune_merged_branches.py');
  const script = existsSync(installedScript) ? installedScript : path.join(__dirname, '../../scripts/prune_merged_branches.py');
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

async function retryFetch(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await retryConnection(operation);
    } catch (error) {
      // Another fetch or push can update a tracking ref after Git reads it.
      // Retry Git's comparison; leave persistent locks and other failures alone.
      if (attempt >= 2 || !/cannot lock ref 'refs\/remotes\/[^']+': is at [0-9a-f]+ but expected [0-9a-f]+/i.test(errorText(error))) throw error;
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
    await retryFetch(async () => {
      await checkBranch();
      await repository.fetch({ remote, ref: upstream.name });
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
  const worktrees = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const occupied = worktrees.find(block => block.split('\0').includes(`branch refs/heads/${defaultBranch}`));
  const existing = occupied?.split('\0').find(line => line.startsWith('worktree '))?.slice(9);
  const temporary = existing ? null : await mkdtemp(path.join(os.tmpdir(), 'sweetiebot-branch-'));
  const worktree = existing || path.join(temporary, 'worktree');
  let added = false;
  const checkMain = async () => {
    if (await git(worktree, ['branch', '--show-current']) !== defaultBranch) {
      throw new Error(`The ${defaultBranch} worktree changed branches while preparing the new branch.`);
    }
    return await git(worktree, ['status', '--porcelain', '--untracked-files=all']) === '';
  };
  try {
    await checkBranch();
    // A shared main window already reserves this branch. Reuse that checkout
    // only while clean; pending edits must never be merged or carried away.
    if (existing) {
      if (!await checkMain()) return await git(root, ['rev-parse', `refs/heads/${defaultBranch}`]);
    } else {
      await git(root, ['worktree', 'add', '--quiet', worktree, defaultBranch]);
      added = true;
    }
    for (let attempt = 0; ; attempt++) {
      await retryFetch(() => git(worktree, ['fetch', remote, `+refs/heads/${upstream.slice(prefix.length)}:${upstream}`]));
      await checkBranch();
      if (existing && !await checkMain()) return await git(root, ['rev-parse', `refs/heads/${defaultBranch}`]);
      try {
        await git(worktree, ['merge', existing ? '--ff-only' : '--no-edit', upstream]);
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
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function createBranch(repository, { defaultBranch, remote, names, isolateBranch }, secureRandomInt) {
  if (!names?.length) throw new Error('No pony branch names are configured.');
  await repository.status();
  if (repository.state.mergeChanges?.length) {
    throw new Error('Resolve the merge conflicts before creating a new branch.');
  }
  const merged = await mergedBranchStatus(repository, remote);
  if (merged) {
    const refs = await repository.getRefs({ pattern: ['refs/heads', `refs/remotes/${remote}`] });
    const used = new Set(refs.flatMap(ref => [ref.name, ref.name?.replace(`${remote}/`, '')]));
    const history = await loadBranchNameHistory(repository);
    const { branch, selected } = chooseBranchName([...new Set(names)].filter(name => !used.has(name)),
      history.selected, secureRandomInt);
    await mergedBranchAction(repository, '--new-branch', branch, remote);
    await saveBranchNameHistory(history.file, selected);
    await repository.status();
    return branch;
  }
  let original = repository.state.HEAD?.name;
  let start;
  let forkScript;
  let unfinishedBase = false;
  if (repository.rootUri?.fsPath && existsSync(path.join(repository.rootUri.fsPath, '.git'))) {
    const { stdout } = await promisify(execFile)('git', [
      'log', '-1', '--format=%s', '--extended-regexp',
      '--grep=^(placeholder_[0-9a-f]{16}|💭 Generate local commit message \\[[0-9a-f]{16}\\])$',
      `refs/heads/${defaultBranch}`
    ], { cwd: repository.rootUri.fsPath, timeout: 10000 }).catch(error => {
      if (error.code === 128) return { stdout: '' }; // Sync can create a missing local base ref.
      throw error;
    });
    unfinishedBase = /^(?:placeholder_[0-9a-f]{16}|💭 Generate local commit message \[[0-9a-f]{16}\])$/.test(stdout.trim());
  }
  if (unfinishedBase || await asyncCommitPending(repository, { refs: [`refs/heads/${defaultBranch}`] })) {
    const installedScript = path.join(__dirname, '../commits/background_commit.py');
    const script = existsSync(installedScript) ? installedScript : path.join(__dirname, '../../scripts/background_commit.py');
    forkScript = script;
  } else if (repository.state.indexChanges?.length || repository.state.workingTreeChanges?.length) {
    // Preserve pending edits and their staging by avoiding a remote merge.
    if (isolateBranch) {
      start = `refs/heads/${defaultBranch}`;
    } else {
      await repository.checkout(defaultBranch);
      await repository.status();
      if (repository.state.HEAD?.name !== defaultBranch) {
        throw new Error(`Could not switch to ${defaultBranch}.`);
      }
      original = defaultBranch;
      start = 'HEAD';
    }
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
  const history = await loadBranchNameHistory(repository);
  const { branch, selected } = chooseBranchName(available, history.selected, secureRandomInt);
  await repository.status();
  if (repository.state.HEAD?.name !== original) throw new Error('The active branch changed while preparing the new branch.');
  const isolated = isolateBranch && await isolateBranch(branch, start, {
    forkScript, source: `refs/heads/${defaultBranch}`, expectedHead: `refs/heads/${original}`
  });
  if (isolated) {
    // The shared main checkout stays on main even while its title jobs finish.
  } else if (forkScript) {
    await promisify(execFile)(resolvePythonExecutable(), [
      forkScript, '--fork-branch', `refs/heads/${defaultBranch}`, branch, `refs/heads/${original}`
    ], { cwd: repository.rootUri.fsPath, timeout: 120000 });
    await repository.status();
  } else {
    await repository.createBranch(branch, true, start);
  }
  try {
    await saveBranchNameHistory(history.file, selected);
  } catch (error) {
    throw new Error(`Created branch "${branch}", but could not save its name history: ${error.message}`, { cause: error });
  }
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

async function deleteBranch(repository, { branch, defaultBranch, remote, confirmUnverified }, cleanup = cleanupMergedBranch) {
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
      // The ordinary merged-PR guard stays fail-closed unless the caller
      // explicitly offers a separate, user-confirmed local-only override.
      if (typeof confirmUnverified === 'function') return confirmUnverified();
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



async function remoteBranchTip(repository, branch, remote = 'origin') {
  if (!repository.rootUri?.fsPath) throw new Error('A local Git repository is required.');
  const cwd = repository.rootUri.fsPath;
  const git = async (...args) => (await promisify(execFile)('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  await git('check-ref-format', '--branch', branch);
  const ref = `refs/heads/${branch}`;
  const response = await git('ls-remote', '--heads', remote, ref);
  const matching = response.split('\n').filter(Boolean)
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 2 && parts[1] === ref && /^[a-f0-9]{40,64}$/i.test(parts[0]));
  if (response && matching.length !== 1) {
    throw new Error(`Could not verify ${remote}/${branch}; no branch was deleted.`);
  }
  return matching[0]?.[0] || null;
}

async function deletePublishedBranch(repository, {
  branch, defaultBranch, remote = 'origin', expectedRemoteTip
}) {
  if (!branch || !defaultBranch || branch === defaultBranch) {
    throw new Error('Select a non-default branch to delete.');
  }
  if (!/^[a-f0-9]{40,64}$/i.test(expectedRemoteTip || '')) {
    throw new Error('Deleting a published branch requires confirmed remote revision.');
  }
  if (!repository.rootUri?.fsPath) throw new Error('A local Git repository is required.');
  const cwd = repository.rootUri.fsPath;
  const git = async (...args) => (await promisify(execFile)('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  await git('check-ref-format', '--branch', branch);
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/heads/${branch}`;
  const checkActive = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== branch) {
      throw new Error('The active branch changed; no branch was deleted.');
    }
  };
  await checkActive();
  if (commitInProgress(repository)) throw new Error('Finish the current commit before deleting a branch.');
  if (repository.state.mergeChanges?.length || await git('status', '--porcelain')) {
    throw new Error('Commit, stash, or discard working-tree changes before deleting a published branch.');
  }
  const localTip = await git('rev-parse', '--verify', localRef);
  if (localTip !== expectedRemoteTip) {
    throw new Error(`Cannot delete ${remote}/${branch}: local and published tips differ.`);
  }
  const home = await repository.getBranch(defaultBranch);
  if (!home?.upstream?.name || home.upstream.remote !== remote) {
    throw new Error(`${defaultBranch} must track a branch on ${remote} before deleting a published branch.`);
  }
  await git('fetch', '--prune', '--no-tags', remote);
  const remoteTip = await remoteBranchTip(repository, branch, remote);
  if (remoteTip !== expectedRemoteTip) {
    throw new Error(`Cannot delete ${remote}/${branch}: its tip changed after confirmation.`);
  }
  const baseRef = `refs/remotes/${remote}/${home.upstream.name}`;
  await git('rev-parse', '--verify', baseRef);
  const localBaseRef = `refs/heads/${defaultBranch}`;
  const canFastForward = await git('merge-base', '--is-ancestor', localBaseRef, baseRef)
    .then(() => true, error => {
      if (error.code === 1) return false;
      throw error;
    });
  await checkActive();
  if (canFastForward) {
    await repository.fetch({ remote: '.', ref: `${baseRef}:${localBaseRef}` });
  }
  await checkActive();
  if (await git('rev-parse', '--verify', localRef) !== localTip
      || await git('status', '--porcelain')) {
    throw new Error('The branch or working tree changed during verification; deletion was cancelled.');
  }
  await repository.checkout(defaultBranch);
  await repository.status();
  if (repository.state.HEAD?.name !== defaultBranch
      || await git('rev-parse', '--verify', localRef) !== localTip
      || await git('status', '--porcelain')) {
    throw new Error('Checkout or branch verification changed; remote deletion was cancelled.');
  }
  // The remote must still point to the exact SHA confirmed by the user.
  await git('push', `--force-with-lease=${remoteRef}:${expectedRemoteTip}`,
    remote, `:${remoteRef}`);
  try {
    await repository.deleteBranch(branch, true);
  } catch (error) {
    throw new Error(`${remote}/${branch} was deleted, but local branch ${branch} was preserved: ${error.message || error}`);
  }
  return { branch, remoteDeleted: true };
}


/**
 * Opt-in manual override for a branch whose remote ref is already gone but
 * whose exact tip cannot be proven to match a merged PR. Never remove a remote
 * ref here: published branches take the separate SHA-leased deletion path.
 */
async function deleteUnverifiedLocalBranch(repository, {
  branch, defaultBranch, remote = 'origin', expectedTip
}) {
  if (!branch || !defaultBranch || branch === defaultBranch) {
    throw new Error('Select a non-default branch to delete.');
  }
  if (!/^[a-f0-9]{40,64}$/i.test(expectedTip || '')) {
    throw new Error('Deleting an unverified local branch requires its confirmed revision.');
  }
  if (!repository.rootUri?.fsPath) throw new Error('A local Git repository is required.');
  const cwd = repository.rootUri.fsPath;
  const git = async (...args) => (await promisify(execFile)('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  await git('check-ref-format', '--branch', branch);
  const ref = 'refs/heads/' + branch;
  const verifyState = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== defaultBranch) {
      throw new Error('The active branch changed; the local branch was preserved.');
    }
    if (commitInProgress(repository)) throw new Error('Finish the current commit before deleting a branch.');
    if (repository.state.mergeChanges?.length || await git('status', '--porcelain')) {
      throw new Error('Commit, stash, or discard working-tree changes before deleting an unverified branch.');
    }
    if (await git('rev-parse', '--verify', ref) !== expectedTip) {
      throw new Error('The local branch tip changed after confirmation; deletion was cancelled.');
    }
    if (await remoteBranchTip(repository, branch, remote)) {
      throw new Error('The remote branch reappeared; use the published-branch deletion confirmation instead.');
    }
  };
  await verifyState();
  // Let Git enforce linked-worktree protections, even when force is confirmed.
  // Rechecking the exact tip keeps this distinct from unguarded branch removal.
  await verifyState();
  await repository.deleteBranch(branch, true);
  return { branch, remoteDeleted: false, unverifiedDeleted: true };
}

async function confirmUnverifiedLocalDeletion(vscode, repository, {
  branch, defaultBranch, remote = 'origin'
}) {
  if (!branch || branch === defaultBranch) throw new Error('Select a non-default branch to delete.');
  if (!repository.rootUri?.fsPath) throw new Error('A local Git repository is required.');
  const cwd = repository.rootUri.fsPath;
  const git = async (...args) => (await promisify(execFile)('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  await git('check-ref-format', '--branch', branch);
  const expectedTip = await git('rev-parse', '--verify', 'refs/heads/' + branch);
  const choice = await vscode.window.showWarningMessage(
    'Delete unverified local branch "' + branch + '"?',
    { modal: true, detail: 'The branch no longer exists on ' + remote
      + ', but its current commit could not be verified as belonging to a merged GitHub pull request. '
      + 'Deleting this LOCAL branch may make unmerged commits unreachable. '
      + 'The remote will not be changed. Cancel preserves the branch; you remain on ' + defaultBranch + '.' },
    'Delete Local Branch Anyway'
  );
  if (choice !== 'Delete Local Branch Anyway') return false;
  return deleteUnverifiedLocalBranch(repository, {
    branch, defaultBranch, remote, expectedTip
  });
}

async function syncBranch(repository, { branch, defaultBranch, remote, strategy = 'squash', reviewConflicts }) {
  if (!branch) throw new Error('Select a branch to sync.');
  if (!['squash', 'merge'].includes(strategy)) throw new Error('Unknown branch synchronization strategy.');
  const checkBranch = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== branch) {
      throw new Error('The active branch changed; select the branch to sync again.');
    }
  };
  await checkBranch();
  if (branch === defaultBranch) {
    const upstream = repository.state.HEAD.upstream;
    if (!upstream?.remote || !upstream.name) {
      throw new Error(`${branch} must track an upstream branch before syncing.`);
    }
    await syncDefaultBranch(repository, branch, upstream.remote, false);
    return branch;
  }
  await retryFetch(() => repository.fetch({ remote, ref: defaultBranch }));
  await checkBranch();
  const previousMessage = repository.inputBox.value;
  const message = defaultBranch === 'main'
    ? '🔄 Sync brach to main'
    : `🔄 Sync branch to ${defaultBranch}`;
  // A routine sync has no generated prose: only its fixed title and the
  // required authorship trailer. Proposed substantive edits need their own
  // human-reviewed commit before the sync is retried.
  const routineCommitMessage = message + '\n\nCo-authored-by: Codex Web <noreply@openai.com>';
  repository.inputBox.value = message;
  try {
    const root = repository.rootUri?.fsPath;
    const git = root ? async args => (await promisify(execFile)('git', args, {
      cwd: root, timeout: 120000, env: {
        ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no'
      }
    })).stdout.trim() : null;
    if (git && await git(['status', '--porcelain'])) {
      throw new Error('Commit or stash your changes before syncing the default branch. Unrelated edits must be reviewed and committed separately.');
    }
    const target = `refs/remotes/${remote}/${defaultBranch}`;
    const isAncestor = async () => promisify(execFile)('git',
      ['merge-base', '--is-ancestor', target, 'HEAD'], { cwd: root })
      .then(() => true, error => {
        if (error.code === 1) return false;
        throw error;
      });
    const proposedMergeTree = async head => {
      try {
        const output = await git(['merge-tree', '--write-tree', head, target]);
        const tree = output.split('\n')[0].trim();
        if (!/^[a-f0-9]{40,64}$/i.test(tree)) {
          throw new Error('Git did not provide a verifiable automatic merge tree.');
        }
        return tree;
      } catch (error) {
        // An actual conflict is resolved by the existing review/editor flow.
        // It must never be silently committed as routine sync work.
        if (error.code === 1) return null;
        throw error;
      }
    };
    const verifyAutomaticResult = async expected => {
      if (expected && await git(['write-tree']) !== expected) {
        throw new Error('Sync staged changes outside the automatic Git merge result. Review and commit substantive edits in their own human-authored commit before retrying.');
      }
    };
    const confirmConflict = async (headBefore, expectedTree) => {
      if (expectedTree !== null || typeof reviewConflicts !== 'function') return true;
      const targetSha = await git(['rev-parse', target]);
      const approved = await reviewConflicts(repository, {
        branch, defaultBranch, remote, strategy, head: headBefore, target: targetSha
      });
      if (!approved) return false;
      // A reviewer might switch branches, edit files, or move the target while
      // looking at the preview. Never apply a stale decision.
      await checkBranch();
      if (await git(['rev-parse', 'HEAD']) !== headBefore
          || await git(['rev-parse', target]) !== targetSha
          || await git(['status', '--porcelain'])) {
        throw new Error('Git changed during sync review. Start a fresh sync.');
      }
      return true;
    };
    const recordSync = async before => {
      const sha = await git(['rev-parse', 'HEAD']);
      const targetSha = await git(['rev-parse', target]);
      try {
        await queueSyncReport(root, {
          branch, defaultBranch, remote, strategy, before, target: targetSha, sha
        });
      } catch (error) {
        // The Git commit already succeeded. A comment outage must not cause
        // a dangerous retry that repeats the merge or changes its authorship.
        console.warn('Sweetiebot could not queue the sync report:', error.message);
      }
    };
    if (strategy === 'merge') {
      if (!git) {
        // Allow VS Code Git API fixtures that do not expose a real checkout.
        await repository.merge(`${remote}/${defaultBranch}`);
      } else if (!await isAncestor()) {
        const headBefore = await git(['rev-parse', 'HEAD']);
        const expectedTree = await proposedMergeTree(headBefore);
        if (!await confirmConflict(headBefore, expectedTree)) return false;
        // Do not let Git auto-commit with an arbitrary/generated description.
        await git(['merge', '--no-ff', '--no-commit', '-m', message, target]);
        await checkBranch();
        if (await git(['rev-parse', 'HEAD']) !== headBefore) {
          throw new Error('The branch advanced during synchronization; no sync commit was created.');
        }
        const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '');
        if (!mergeHead) throw new Error('Git did not leave a verifiable merge to commit.');
        await verifyAutomaticResult(expectedTree);
        await git(['commit', '-m', routineCommitMessage]);
        await recordSync(headBefore);
      }
    } else {
      if (!git) throw new Error('A local Git checkout is required for squash synchronization.');
      const headBefore = await git(['rev-parse', 'HEAD']);
      // If the target is already an ancestor there is nothing to incorporate.
      if (!await isAncestor()) {
        const expectedTree = await proposedMergeTree(headBefore);
        if (!await confirmConflict(headBefore, expectedTree)) return false;
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
          await verifyAutomaticResult(expectedTree);
          await git(['commit', '-m', routineCommitMessage]);
          await recordSync(headBefore);
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
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.refreshRepository', async uri => {
    // A workspace switch briefly leaves Git with no repositories. Unlike
    // git.refresh, background polling must never fall back to its picker,
    // whose error dialog appears even when the caller catches the rejection.
    if (!uri) return false;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) return false;
      const git = await extension.activate();
      const repository = git.getAPI(1).getRepository(vscode.Uri.from(uri.rootUri ?? uri));
      if (!repository) return false;
      await repository.status();
      return true;
    } catch {
      // The repository or extension host can disappear during the status read.
      return false;
    }
  }));
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
    'sweetiebot.returnHome', 'sweetiebot.createBranch', 'sweetiebot.createStackedBranch',
    'sweetiebot.deleteBranch', 'sweetiebot.syncBranch'
  ]);
  for (const [command, action] of [
    ['sweetiebot.returnHome', returnHome],
    ['sweetiebot.autoPullClean', autoPullClean],
    ['sweetiebot.createBranch', createBranch],
    ['sweetiebot.createStackedBranch', (repository, options) => createStackedBranch(vscode, repository, options)],
    ['sweetiebot.publishBranch', publishBranch],
    ['sweetiebot.deleteBranch', deleteBranch],
    ['sweetiebot.syncBranch', syncBranch]
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (uri, options = {}) => {
      try {
        const repository = await resolveRepository(uri);
        const attempt = async () => {
          const remote = options?.remote || 'origin';
          const defaultBranch = needsDefaultBranch.has(command) ? await resolveDefaultBranch(repository, remote) : undefined;
          const refs = [options?.branch || 'HEAD'];
          if (command === 'sweetiebot.syncBranch') refs.push(`refs/remotes/${remote}/${defaultBranch}`);
          // Switching to an unpublished branch can trigger automatic publishing.
          // Let a later status refresh retry after the background queue drains.
          if (command === 'sweetiebot.publishBranch' && await asyncCommitPending(repository, { refs })) return false;
          if (command === 'sweetiebot.publishBranch') {
            const merged = await mergedBranchStatus(repository, options.remote, options.branch);
            if (merged) return warnMergedBranch(vscode, repository, merged);
          }
          if (command !== 'sweetiebot.autoPullClean' && command !== 'sweetiebot.createBranch') {
            await requireFinalizedCommit(repository, {
              background: !['sweetiebot.returnHome', 'sweetiebot.createBranch'].includes(command), refs
            });
          }
          if (!needsDefaultBranch.has(command)) return action(repository, options);
          if (command === 'sweetiebot.returnHome' && defaultBranch === 'main' &&
              await routeBranch(vscode, repository, { branch: 'main' })) return 'main';
          if (command === 'sweetiebot.createBranch' && !options.names?.length) {
            options = { ...options, names: await mergedBranchAction(repository, '--names') };
          }
          if (command === 'sweetiebot.deleteBranch' && options?.branch
              && options.branch !== defaultBranch && repository.rootUri?.fsPath) {
            const tip = await remoteBranchTip(repository, options.branch, remote);
            if (tip) {
              const choice = await vscode.window.showWarningMessage(
                `Delete published branch "${options.branch}"?`,
                { modal: true, detail: `This permanently removes ${remote}/${options.branch} and its local branch. Any associated GitHub pull request may close, and unmerged commits may become unreachable. The working tree must be clean.` },
                'Delete Local and Remote'
              );
              if (choice !== 'Delete Local and Remote') return false;
              return deletePublishedBranch(repository, {
                branch: options.branch, defaultBranch, remote, expectedRemoteTip: tip
              });
            }
          }
          return action(repository, {
            ...options, defaultBranch,
            ...(command === 'sweetiebot.createBranch' && defaultBranch === 'main' ? {
              isolateBranch: (branch, start, fork) => routeBranch(vscode, repository, { branch, start, create: true, ...fork })
            } : {}),
            ...(command === 'sweetiebot.syncBranch' && vscode.window ? {
              reviewConflicts: (repo, details) => reviewSyncConflicts(vscode, repo, details)
            } : {}),
            ...(command === 'sweetiebot.deleteBranch' ? {
              confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, repository, {
                branch: options?.branch, defaultBranch, remote
              })
            } : {})
          });
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

  context.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.listBranchStrip', async (uri, options = {}) => {
      const repository = await resolveRepository(uri);
      // The workbench already knows this base; avoid an unnecessary ls-remote
      // before the first local-only branch listing.
      const defaultBranch = options.defaultBranch ||
        await resolveDefaultBranch(repository, options.remote || 'origin');
      return listBranchStrip(repository, { ...options, defaultBranch });
    }),
    vscode.commands.registerCommand('sweetiebot.checkoutBranchStrip', async (uri, options = {}) => {
      try {
        const repository = await resolveRepository(uri);
        return await queueRepositoryOperation(repository, async () => {
          await requireFinalizedCommit(repository, { background: false });
          if (await routeBranch(vscode, repository, options)) return options.branch;
          return checkoutBranchStrip(repository, options);
        });
      } catch (error) {
        throw explainGitError(error);
      }
    })
  );

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
      await requireFinalizedCommit(repository, { refs: [branch] });
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
        const token = beginRepositoryCommit(repository);
        if (options?.waitForPush) await armSpellcheckPushGate(repository, token);
        return token;
      });
    }),
    vscode.commands.registerCommand('sweetiebot.endCommit', async (uri, options) => {
      const repository = await resolveRepository(uri);
      return queueRepositoryOperation(repository, async () => {
        try {
          await releaseSpellcheckPushGate(repository, options?.gateToken, options?.pushed === true);
        } finally {
          endRepositoryCommit(repository, options?.gateToken);
        }
      });
    })
  );

  if (vscode.window?.createOutputChannel) registerSyncReportPublisher(vscode, context);

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
  remoteBranchTip,
  deletePublishedBranch,
  deleteUnverifiedLocalBranch,
  confirmUnverifiedLocalDeletion,
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
