'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { worktreeLocations } = require('./worktree-registry');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const PR_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $endCursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { headRefName isCrossRepository number url state updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const prCache = new Map();
const pendingPrLookups = new Map();
const PR_CACHE_MS = 30000;

// Linked worktrees share a Git common directory. Include the GitHub remote
// identity so distinct repositories/remotes cannot exchange PR associations.
function pullRequestCacheKey(commonDirectory, remoteUrl) {
  const repository = parseGitHubRemote(remoteUrl);
  return commonDirectory && repository
    ? `${path.resolve(commonDirectory)}\n${repository.toLowerCase()}` : null;
}

async function cachedPullRequestLookup(key, load, now = () => Date.now()) {
  const cached = prCache.get(key);
  if (cached && now() < cached.expires) return cached.value;
  if (pendingPrLookups.has(key)) return pendingPrLookups.get(key);
  // Coalesce simultaneous worktree refreshes, not only completed responses.
  const request = (async () => {
    const value = await load();
    prCache.set(key, { value, expires: now() + PR_CACHE_MS });
    return value;
  })();
  pendingPrLookups.set(key, request);
  try { return await request; }
  finally {
    if (pendingPrLookups.get(key) === request) pendingPrLookups.delete(key);
  }
}

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

async function pullRequestNames(root, remoteUrl, execute = runFile, commonDirectory = root) {
  const repository = parseGitHubRemote(remoteUrl);
  const cacheKey = pullRequestCacheKey(commonDirectory, remoteUrl);
  if (!cacheKey) return null;
  return cachedPullRequestLookup(cacheKey, async () => {
    let value = null;
    try {
    const [host, owner, name] = repository.split('/');
    const { stdout } = await execute(ghExecutable(), [
      'api', 'graphql', '--hostname', host, '--paginate', '--slurp',
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${PR_QUERY}`
    ], {
      cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    });
    const pages = JSON.parse(stdout);
    // Require a complete scan before inferring that any branch has no PR.
    if (Array.isArray(pages) && pages.length && pages.every((page, index) =>
      !page.errors?.length && Array.isArray(page.data?.repository?.pullRequests?.nodes)
      && page.data.repository.pullRequests.pageInfo?.hasNextPage === (index < pages.length - 1))) {
      const prs = pages.flatMap(page => page.data.repository.pullRequests.nodes);
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
    return value;
  });
}

async function listBranchStrip(repository, { defaultBranch, remote = 'origin', localOnly = false } = {}) {
  const root = repository.rootUri.fsPath;
  // Remote-tracking refs survive deletion upstream until a pruning fetch.
  // Only advertise remote branches after confirming their current state.
  const remoteAvailable = !localOnly && await git(root, ['fetch', '--prune', '--no-tags',
    '--no-prune-tags', '--no-recurse-submodules', remote,
    `+refs/heads/*:refs/remotes/${remote}/*`]).then(() => true, () => false);
  const refPrefixes = ['refs/heads', ...(remoteAvailable ? [`refs/remotes/${remote}`] : [])];
  const [refText, remoteUrl, gitCommonDir] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate',
      '--format=%(refname)%09%(committerdate:unix)', ...refPrefixes]),
    localOnly ? Promise.resolve('') : git(root, ['remote', 'get-url', remote]).catch(() => ''),
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => root)
  ]);
  // Resolve symlink/case aliases so all worktrees use the same cache identity.
  const repositoryId = await fs.realpath(gitCommonDir).catch(() => path.resolve(gitCommonDir));
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
    localOnly ? Promise.resolve(null) : pullRequestNames(root, remoteUrl, runFile, repositoryId)
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
  const destination = worktreeLocations(listing).get(branch);
  if (destination) {
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

module.exports = { groupBranchRefs, parseGitHubRemote, pullRequestCacheKey,
  cachedPullRequestLookup, listBranchStrip, checkoutBranchStrip, pullRequestNames };
