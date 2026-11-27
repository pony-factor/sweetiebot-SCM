'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseGitHubRemote } = require('./strip');
const exec = promisify(execFile);

async function git(root, args) {
  return (await exec('git', args, { cwd: root, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}

function identity(ref) {
  const { host, owner, repositoryName } = ref?.repositoryCloneUrl || {};
  if (![host, owner, repositoryName].every(value =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value)))
    throw new Error('The PR repository identity is unavailable.');
  return { host, owner, repositoryName, key: (host + '/' + owner + '/' + repositoryName).toLowerCase() };
}

// Prepare refs only. Never switch, pull, stash, or reset the source worktree.
// The existing worktree router will open the selected branch separately.
async function preparePullRequestBranch(root, pr, run = git) {
  const call = (...args) => run(root, args);
  const optional = async (...args) => {
    try { return await call(...args); }
    catch (error) { if (error.code === 1) return ''; throw error; }
  };
  const head = identity(pr?.head), base = identity(pr?.base);
  const number = pr?.number, ref = pr?.head?.ref, sha = pr?.head?.sha;
  if (!Number.isSafeInteger(number) || number < 1 || typeof ref !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(sha || ''))
    throw new Error('The PR head is not verified.');
  await call('check-ref-format', 'refs/heads/' + ref);
  const metadata = base.owner + '#' + base.repositoryName + '#' + number;
  const remotes = (await call('remote')).split('\n').filter(Boolean);
  const remoteByIdentity = new Map();
  for (const name of remotes) {
    const url = await optional('config', '--get', 'remote.' + name + '.url');
    const key = parseGitHubRemote(url)?.toLowerCase();
    if (key && !remoteByIdentity.has(key)) remoteByIdentity.set(key, name);
  }
  const headRemote = remoteByIdentity.get(head.key), baseRemote = remoteByIdentity.get(base.key);
  if (!headRemote && !baseRemote)
    throw new Error('No configured remote matches the PR repository.');
  const branches = (await call('for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'))
    .split('\n').filter(Boolean);
  const protectedBranch = name => name === 'main' || name === 'master' || name === pr.base.ref;
  const config = (branch, key) => optional('config', '--get', 'branch.' + branch + '.' + key);
  const associated = [];
  for (const branch of branches) {
    if (!protectedBranch(branch) && await config(branch, 'github-pr-owner-number') === metadata)
      associated.push(branch);
  }
  if (associated.length > 1)
    throw new Error('Multiple local branches are associated with this PR. Select its worktree explicitly.');
  if (associated.length === 1) return associated[0];

  let branch = 'pr/' + head.owner + '/' + number;
  // Same-repository topic branches retain their normal editing identity when
  // their tracking configuration or exact commit proves they are the PR head.
  if (headRemote && head.key === base.key && !protectedBranch(ref)) {
    if (!branches.includes(ref)) branch = ref;
    else {
      const association = await config(ref, 'github-pr-owner-number');
      const tracked = await config(ref, 'remote') === headRemote &&
        await config(ref, 'merge') === 'refs/heads/' + ref;
      const local = await call('rev-parse', '--verify', 'refs/heads/' + ref);
      if (!association && (tracked || local.toLowerCase() === sha.toLowerCase())) {
        await call('config', 'branch.' + ref + '.github-pr-owner-number', metadata);
        return ref;
      }
    }
  }
  if (branches.includes(branch))
    throw new Error('The PR review branch name is already occupied by unrelated work.');
  await call('check-ref-format', '--branch', branch);
  const tracking = headRemote ? 'refs/remotes/' + headRemote + '/' + ref : null;
  const destination = tracking || 'refs/sweetiebot/pull/' + base.owner + '/' + base.repositoryName + '/' + number;
  await call('check-ref-format', destination);
  const source = headRemote ? 'refs/heads/' + ref : 'refs/pull/' + number + '/head';
  await call('fetch', '--no-tags', '--', headRemote || baseRemote, '+' + source + ':' + destination);
  const fetched = await call('rev-parse', '--verify', destination + '^{commit}');
  if (fetched.toLowerCase() !== sha.toLowerCase())
    throw new Error('The PR head changed during checkout. Refresh the PR and try again.');
  // Branch creation is atomic and non-forcing; a competing creator cannot
  // overwrite any existing local branch.
  await call('branch', '--no-track', branch, fetched);
  if (tracking) {
    await call('config', 'branch.' + branch + '.remote', headRemote);
    await call('config', 'branch.' + branch + '.merge', source);
  }
  await call('config', 'branch.' + branch + '.github-pr-owner-number', metadata);
  return branch;
}

module.exports = { preparePullRequestBranch };
