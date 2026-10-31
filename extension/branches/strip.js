'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const PR_LIMIT = 500;
const prCache = new Map();

async function git(root, args) {
  const { stdout } = await runFile('git', args, {
    cwd: root, timeout: 12000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}

function parseGitHubRemote(value) {
  const match = String(value || '').trim().match(
    /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );
  return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
}

function groupBranchRefs(refText, mergedText, prNames, prKnown, base, remote = 'origin') {
  const refs = new Map();
  const merged = new Set(String(mergedText || '').split('\n'));
  for (const line of String(refText || '').split('\n')) {
    const [ref, stamp] = line.split('\t');
    let name, kind;
    if (ref?.startsWith('refs/heads/')) {
      name = ref.slice('refs/heads/'.length);
      kind = 'local';
    } else if (ref?.startsWith(`refs/remotes/${remote}/`)) {
      name = ref.slice(`refs/remotes/${remote}/`.length);
      kind = 'origin';
    } else continue;
    if (!name || (kind === 'origin' && name === 'HEAD')) continue;
    const item = refs.get(name) || {
      name, local: false, origin: false, merged: false, modified: 0
    };
    // The checked-out local branch wins if its remote was already merged.
    if (kind === 'local' || !item.local) item.merged = merged.has(ref);
    item[kind] = true;
    item.modified = Math.max(item.modified, Number(stamp) || 0);
    refs.set(name, item);
  }
  const branches = [...refs.values()].map(item => ({
    ...item,
    hasPr: prKnown ? prNames.has(item.name) : null,
    ...(prKnown && prNames instanceof Map && prNames.has(item.name)
      ? { pr: prNames.get(item.name) } : {}),
    featured: prKnown && item.name !== base && !item.merged && !prNames.has(item.name)
  }));
  branches.sort((a, b) =>
    Number(b.featured) - Number(a.featured)
    || (a.featured && b.featured ? Number(b.local) - Number(a.local) : 0)
    || b.modified - a.modified || a.name.localeCompare(b.name)
  );
  return { branches, featuredCount: branches.filter(item => item.featured).length };
}

function ghExecutable() {
  return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
    .find(candidate => existsSync(candidate)) || 'gh';
}

async function pullRequestNames(root, remoteUrl) {
  const repository = parseGitHubRemote(remoteUrl);
  if (!repository) return null;
  const cacheKey = `${root}\n${repository}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.value;
  let value = null;
  try {
    const { stdout } = await runFile(ghExecutable(), [
      'pr', 'list', '--repo', repository, '--state', 'all', '--limit', String(PR_LIMIT),
      '--json', 'headRefName,isCrossRepository,number,url,state,updatedAt'
    ], {
      cwd: root, timeout: 12000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    });
    const prs = JSON.parse(stdout);
    // An exactly capped result is incomplete: never infer that a branch has no PR.
    if (Array.isArray(prs) && prs.length < PR_LIMIT) {
      value = new Map();
      // Prefer the most recently updated PR when a branch has several.
      prs.filter(pr => pr && pr.isCrossRepository === false && pr.headRefName)
        .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
        .forEach(pr => {
          if (!value.has(pr.headRefName)) value.set(pr.headRefName, {
            number: pr.number, url: pr.url, state: pr.state
          });
        });
    }
  } catch { /* Offline or unauthenticated: group conservatively. */ }
  prCache.set(cacheKey, { value, expires: Date.now() + 30000 });
  return value;
}

async function listBranchStrip(repository, { defaultBranch, remote = 'origin', localOnly = false } = {}) {
  const root = repository.rootUri.fsPath;
  // Remote-tracking refs survive deletion upstream until a pruning fetch.
  // Only advertise remote branches after confirming their current state.
  const remoteAvailable = !localOnly && await git(root, ['fetch', '--prune', '--no-tags',
    '--no-prune-tags', '--no-recurse-submodules', remote,
    `+refs/heads/*:refs/remotes/${remote}/*`]).then(() => true, () => false);
  const refPrefixes = ['refs/heads', ...(remoteAvailable ? [`refs/remotes/${remote}`] : [])];
  const [refText, remoteUrl, repositoryId] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate',
      '--format=%(refname)%09%(committerdate:unix)', ...refPrefixes]),
    localOnly ? Promise.resolve('') : git(root, ['remote', 'get-url', remote]).catch(() => ''),
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => root)
  ]);
  const baseRefs = [...(remoteAvailable ? [`refs/remotes/${remote}/${defaultBranch}`] : []),
    `refs/heads/${defaultBranch}`];
  let baseRef;
  for (const candidate of baseRefs) {
    if (await git(root, ['rev-parse', '--verify', '--quiet', candidate]).catch(() => '')) {
      baseRef = candidate;
      break;
    }
  }
  const [mergedText, prNames] = await Promise.all([
    baseRef ? git(root, ['for-each-ref', `--merged=${baseRef}`,
      '--format=%(refname)', 'refs/heads', `refs/remotes/${remote}`]).catch(() => '') : '',
    localOnly ? Promise.resolve(null) : pullRequestNames(root, remoteUrl)
  ]);
  const prKnown = !localOnly && Boolean(prNames && baseRef);
  const classified = groupBranchRefs(refText, mergedText, prNames || new Set(),
    prKnown, defaultBranch, remote);
  return { ...classified, repositoryId, prStatus: localOnly ? 'loading' : prKnown ? 'available' : 'unavailable',
    remoteStatus: localOnly ? 'loading' : remoteAvailable ? 'available' : 'unavailable' };
}

async function checkoutBranchStrip(repository, { branch, remote = 'origin', onOccupiedWorktree } = {}) {
  if (!branch || typeof branch !== 'string') throw new Error('Choose a branch.');
  const root = repository.rootUri.fsPath;
  await git(root, ['check-ref-format', '--branch', branch]);
  // Final safety gate: even when the higher-level router cannot run, never
  // attempt a plain checkout of a branch held by another Git worktree.
  const listing = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  const occupied = listing.split('\0\0').find(block =>
    block.split('\0').includes('branch refs/heads/' + branch));
  if (occupied) {
    const registered = occupied.split('\0').find(line => line.startsWith('worktree '));
    if (!registered) throw new Error(`Cannot identify the worktree holding "${branch}".`);
    const destination = registered.slice('worktree '.length);
    const [owner, current] = await Promise.all([
      fs.realpath(destination).catch(() => path.resolve(destination)), fs.realpath(root)
    ]);
    if (owner !== current) {
      if (typeof onOccupiedWorktree === 'function' && await onOccupiedWorktree(destination)) return branch;
      throw new Error(`Branch "${branch}" is already checked out in worktree "${destination}". Open that worktree or recover its stale Git registration; checkout was not attempted.`);
    }
  }
  const local = await git(root, ['show-ref', '--verify', '--hash',
    `refs/heads/${branch}`]).catch(() => '');
  if (local) {
    await repository.checkout(branch);
  } else {
    const tracking = await git(root, ['show-ref', '--verify', '--hash',
      `refs/remotes/${remote}/${branch}`]).catch(() => '');
    if (!tracking) throw new Error(`Branch "${branch}" is no longer available. Refresh the branch bar.`);
    // Create a tracking branch; never checkout origin/name in detached HEAD.
    await git(root, ['switch', '--track', '-c', branch, `${remote}/${branch}`]);
  }
  await repository.status();
  if (repository.state.HEAD?.name !== branch) {
    throw new Error(`Could not switch to "${branch}".`);
  }
  return branch;
}

module.exports = { groupBranchRefs, parseGitHubRemote, listBranchStrip, checkoutBranchStrip };
