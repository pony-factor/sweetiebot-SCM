'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');
const { githubRepository } = require('../merge/sync-review');
const { separateAppsEnabled } = require('../github/app-identity');
const { appCommitIdentity: syncIdentity } = require('../github/app-commit-identity');
const { createLindseyTransport } = require('../merge/lindsey-transport');
const { gitFailure } = require('../commits/git-failure');
const exec = promisify(execFile);

// Refresh the shared main without switching the topic checkout or disturbing
// another window's edits. Divergence requires an explicit main-branch sync.
async function refreshMain(repository, { defaultBranch, remote, checkBranch }) {
  const root = repository.rootUri?.fsPath;
  if (!root || !existsSync(require('node:path').join(root, '.git'))) return null;
  const git = async (args, cwd = root) => (await exec('git', args, {
    cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  if (await git(['status', '--porcelain'])) throw Error('Commit or stash your changes before syncing the default branch.');
  const config = async key => git(['config', '--get', key]).catch(error => {
    if (error.code === 1) return ''; throw error;
  });
  const trackedRemote = await config(`branch.${defaultBranch}.remote`);
  const trackedRef = await config(`branch.${defaultBranch}.merge`);
  const sourceBranch = trackedRemote === remote && trackedRef.startsWith('refs/heads/')
    ? trackedRef.slice('refs/heads/'.length) : defaultBranch;
  await repository.fetch({ remote, ref: sourceBranch });
  await checkBranch();
  const incoming = `refs/remotes/${remote}/${sourceBranch}`;
  const tip = await git(['rev-parse', '--verify', incoming]);
  const local = `refs/heads/${defaultBranch}`;
  const before = await git(['rev-parse', '--verify', local]).catch(() => null);
  if (before === tip) return local;
  const ancestor = async (a, b) => exec('git', ['merge-base', '--is-ancestor', a, b], { cwd: root })
    .then(() => true, error => { if (error.code === 1) return false; throw error; });
  if (before && await ancestor(tip, before)) return local;
  if (before && !await ancestor(before, tip)) {
    throw Error(`${defaultBranch} has diverged from ${remote}/${defaultBranch}. Sync it separately before syncing this branch.`);
  }
  const blocks = (await git(['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const occupied = blocks.find(block => block.split('\0').includes(`branch ${local}`));
  const worktree = occupied?.split('\0').find(line => line.startsWith('worktree '))?.slice(9);
  await checkBranch();
  if (worktree) {
    if (await git(['status', '--porcelain', '--untracked-files=all'], worktree)
        || await git(['symbolic-ref', 'HEAD'], worktree) !== local
        || await git(['rev-parse', 'HEAD'], worktree) !== before) {
      throw Error(`${defaultBranch} is busy or has local changes. Finish that work before syncing.`);
    }
    await git(['merge', '--ff-only', tip], worktree);
  } else {
    await git(['update-ref', local, tip, before || '0'.repeat(tip.length)]);
  }
  await checkBranch();
  return local;
}

// Use the same verified App for Git authorship and authenticated publication.
// Command-scoped identity preserves the user's config and signing behavior.
async function syncPublisher(root, remote, { enabled = separateAppsEnabled, transport = createLindseyTransport,
  run = exec, identity = syncIdentity } = {}) {
  if (!enabled()) return null;
  const url = (await run('git', ['remote', 'get-url', '--push', remote], { cwd: root })).stdout.trim();
  const repo = githubRepository(url);
  if (!repo) throw Error('Lindsey sync requires a GitHub publishing remote.');
  const auth = transport(repo);
  const token = await auth.gitToken(); // Fail before creating a commit when App setup is invalid.
  const author = await identity({ token });
  const publish = async (branch, sha) => {
    const token = await auth.gitToken();
    const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
    const args = ['-c', 'credential.helper=', '-c', `credential.helper=!${gh} auth git-credential`,
      'push', `https://github.com/${repo}.git`, `${sha}:refs/heads/${branch}`];
    try {
      await run('git', args, { cwd: root, timeout: 120000,
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token,
          GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_ASKPASS: '', SSH_ASKPASS: '' } });
    } catch (error) { throw gitFailure(error, ['push']); }
  };
  publish.commit = async message => {
    try {
      await run('git', ['commit', '-m', message], { cwd: root, timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email } });
    } catch (error) { throw gitFailure(error, ['commit']); }
  };
  return publish;
}

module.exports = { refreshMain, syncIdentity, syncPublisher };
