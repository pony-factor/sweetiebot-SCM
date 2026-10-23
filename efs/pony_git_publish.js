'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const VALID_SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * Commit only a newly created Kafania pony record, then fast-forward push main.
 * Never stage unrelated changes, rewrite a branch, or push earlier local commits.
 */
async function publishPonyProfile(directory, pony, storedPath, { run = execute } = {}) {
  const pack = String(pony?.packId || '').trim().toLowerCase();
  const slug = String(pony?.canonicalSlug || pony?.slug || '').trim().toLowerCase();
  if (!VALID_SLUG.test(pack) || !VALID_SLUG.test(slug) || storedPath !== `${pack}/${slug}.json`) {
    throw new Error('Kafania returned an unexpected pony profile path.');
  }
  const relativePath = `ponies/${storedPath}`;
  const root = path.resolve(directory);
  const git = async (...args) => {
    const { stdout } = await run('git', args, {
      cwd: root, timeout: 30000, maxBuffer: 512 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return String(stdout).trim();
  };

  const top = await git('rev-parse', '--show-toplevel');
  if (await fs.realpath(top) !== await fs.realpath(root)) {
    throw new Error('Refusing to commit outside the Kafania repository root.');
  }
  const info = await fs.lstat(path.join(root, relativePath));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The pony record must be a regular file.');

  if (await git('symbolic-ref', '--quiet', '--short', 'HEAD') !== 'main' ||
      await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') !== 'origin/main') {
    throw new Error('Automatic pony publishing requires Kafania main tracking origin/main.');
  }
  const status = await git('status', '--porcelain=1', '--untracked-files=all', '--', relativePath);
  if (status !== `?? ${relativePath}` && status !== `A  ${relativePath}`) {
    throw new Error('The pony profile is not a new, uncommitted file; refusing to overwrite existing work.');
  }

  // Fetch before committing. A behind-only local main may fast-forward,
  // but never publish earlier local commits or rewrite diverged history.
  await git('fetch', '--quiet', 'origin', 'main');
  const parent = await git('rev-parse', 'HEAD');
  const upstream = await git('rev-parse', 'refs/remotes/origin/main');
  if (parent !== upstream) {
    let common;
    try { common = await git('merge-base', 'HEAD', 'refs/remotes/origin/main'); }
    catch { /* Unrelated histories must fail closed, like divergent commits. */ }
    if (common !== parent) {
      throw new Error('Kafania main is not synchronized with origin/main: local commits prevent a safe fast-forward.');
    }
    try {
      // Equivalent to the merge phase of git pull --ff-only, using the ref
      // we just fetched. Git refuses to overwrite staged or untracked work.
      await git('merge', '--ff-only', '--quiet', 'refs/remotes/origin/main');
    } catch {
      throw new Error('Kafania main could not fast-forward to origin/main without overwriting local work; resolve the checkout manually.');
    }
  }
  if (await git('rev-parse', 'HEAD') !== await git('rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('Kafania main changed during synchronization; refusing automatic publishing.');
  }
  // Revalidate after the pull: a newly tracked pony path cannot be committed
  // as though it were our untracked research result.
  const updatedStatus = await git('status', '--porcelain=1', '--untracked-files=all', '--', relativePath);
  if (updatedStatus !== `?? ${relativePath}` && updatedStatus !== `A  ${relativePath}`) {
    throw new Error('The pony profile changed while synchronizing; refusing to overwrite existing work.');
  }
  await git('add', '--', relativePath);
  if (await git('diff', '--cached', '--name-only', '--diff-filter=A', '--', relativePath) !== relativePath) {
    throw new Error('The pony profile was not staged as a new file; refusing an empty commit.');
  }

  const title = `🦄 Add pony profile: ${pack}/${slug}`;
  const message = `${title}\n\nAdd the researched pony profile to Kafania's permanent library.\n\nCo-authored-by: Codex Web <noreply@openai.com>`;
  // --only commits just this path, preserving all other staged user changes.
  await git('commit', '--only', '-m', message, '--', relativePath);
  const sha = await git('rev-parse', 'HEAD');
  if (await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD') !== relativePath) {
    throw new Error('Pony commit included unexpected files; refusing to push.');
  }
  await git('push', 'origin', 'HEAD:refs/heads/main');
  return { pushed: true, commit: sha, path: relativePath };
}

module.exports = { publishPonyProfile };
