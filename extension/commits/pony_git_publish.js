'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');

const execute = promisify(execFile);
const VALID_SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/;

async function pendingDirectory(root, run) {
  const { stdout } = await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: root });
  return path.join(String(stdout).trim(), 'sweetiebot-pony-publish');
}

async function pendingPonyProfiles(directory, { run = execute } = {}) {
  const folder = await pendingDirectory(directory, run);
  let files;
  try { files = await fs.readdir(folder); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const pending = [];
  for (const file of files.filter(name => /^[a-z0-9_-]+\.json$/.test(name))) {
    try {
      const entry = JSON.parse(await fs.readFile(path.join(folder, file), 'utf8'));
      if (typeof entry.pony?.packId === 'string' && typeof entry.pony?.slug === 'string'
          && VALID_SLUG.test(entry.pony.packId) && VALID_SLUG.test(entry.pony.slug)
          && entry.path === `${entry.pony.packId}/${entry.pony.slug}.json`) pending.push(entry);
    } catch { /* A damaged queue entry must not prevent other profiles retrying. */ }
  }
  return pending;
}

/**
 * Commit only a newly created Kafania pony record, then fast-forward push main.
 * A durable receipt allows a failed push to resume only the exact commit we made.
 * Never stage unrelated changes, rewrite a branch, or push earlier user commits.
 */
async function publishPonyProfile(directory, pony, storedPath, { run = execute } = {}) {
  const pack = String(pony?.packId || '').trim().toLowerCase();
  let slug = String(pony?.canonicalSlug || pony?.slug || '').trim().toLowerCase();
  if (pack === 'g4-stallions' && slug === 'hoofar') slug = 'hoo-far';
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
  const folder = await pendingDirectory(root, run);
  const receiptPath = path.join(folder, `${pack}--${slug}.json`);
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (receipt && (receipt.path !== storedPath || receipt.pony?.packId !== pack || receipt.pony?.slug !== slug)) {
    throw new Error('Invalid pending pony publication receipt.');
  }
  if (receipt?.parent && (!/^[a-f0-9]{40,64}$/.test(receipt.parent)
      || !/^[a-f0-9]{40,64}$/.test(receipt.blob))) throw new Error('Invalid pending pony commit evidence.');
  const saveReceipt = async () => {
    await fs.mkdir(folder, { recursive: true });
    const temporary = receiptPath + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(receipt) + '\n');
    await fs.rename(temporary, receiptPath);
  };
  const finish = async result => { await fs.rm(receiptPath, { force: true }); return result; };
  if (!receipt && !status) return { pushed: false, reason: 'existing-profile-preserved' };
  if (!receipt) {
    if (status !== `?? ${relativePath}` && status !== `A  ${relativePath}`) {
      throw new Error('The pony profile is not a new, uncommitted file; refusing to overwrite existing work.');
    }
    receipt = { pony: { packId: pack, slug }, path: storedPath, id: randomUUID() };
    // Persist before any network request so a failed fetch can retry after restart.
    await saveReceipt();
  }
  await git('fetch', '--quiet', 'origin', 'main');
  const head = await git('rev-parse', 'HEAD');
  const remote = await git('rev-parse', 'rextension/remotes/origin/main');
  // Recover a crash after committing but before recording its SHA, using the
  // saved parent and blob as evidence rather than trusting a commit title.
  if (!receipt.commit && receipt.parent && !status && head !== receipt.parent
      && await git('rev-parse', 'HEAD^') === receipt.parent
      && await git('rev-parse', `HEAD:${relativePath}`) === receipt.blob
      && await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD') === relativePath
      && typeof receipt.id === 'string' && /^[a-f0-9-]{36}$/.test(receipt.id)
      && (await git('log', '-1', '--format=%B', 'HEAD')).split('\n')
        .includes(`Sweetiebot-Pony-Publication: ${receipt.id}`)) {
    receipt.commit = head;
    await saveReceipt();
  }
  if (receipt.commit) {
    if (!/^[a-f0-9]{40,64}$/.test(receipt.commit)) throw new Error('Invalid pending pony commit.');
    let published = false;
    try { await git('merge-base', '--is-ancestor', receipt.commit, remote); published = true; }
    catch { /* Still pending, or history has changed: validate before pushing. */ }
    if (published) return finish({ pushed: true, commit: receipt.commit, path: relativePath });
    if (status || head !== receipt.commit || await git('rev-parse', `${receipt.commit}^`) !== remote
        || await git('diff-tree', '--no-commit-id', '--name-only', '-r', receipt.commit) !== relativePath) {
      throw new Error('Pending pony push is waiting for Kafania main to be synchronized; local work is preserved.');
    }
    await git('push', 'origin', `${receipt.commit}:rextension/heads/main`);
    return finish({ pushed: true, commit: receipt.commit, path: relativePath });
  }
  // A manual batch may have published the entry while this job was waiting.
  if (!status && head === remote) return finish({ pushed: false, reason: 'already-published' });
  if (status !== `?? ${relativePath}` && status !== `A  ${relativePath}`) {
    throw new Error('The pony profile is not a new, uncommitted file; refusing to overwrite existing work.');
  }

  // Fetch before committing. A behind-only local main may fast-forward,
  // but never publish earlier local commits or rewrite diverged history.
  const parent = await git('rev-parse', 'HEAD');
  const upstream = await git('rev-parse', 'rextension/remotes/origin/main');
  if (parent !== upstream) {
    let common;
    try { common = await git('merge-base', 'HEAD', 'rextension/remotes/origin/main'); }
    catch { /* Unrelated histories must fail closed, like divergent commits. */ }
    if (common !== parent) {
      throw new Error('Kafania main is not synchronized with origin/main: local commits prevent a safe fast-forward.');
    }
    try {
      // Equivalent to the merge phase of git pull --ff-only, using the ref
      // we just fetched. Git refuses to overwrite staged or untracked work.
      await git('merge', '--ff-only', '--quiet', 'rextension/remotes/origin/main');
    } catch {
      throw new Error('Kafania main could not fast-forward to origin/main without overwriting local work; resolve the checkout manually.');
    }
  }
  if (await git('rev-parse', 'HEAD') !== await git('rev-parse', 'rextension/remotes/origin/main')) {
    throw new Error('Kafania main changed during synchronization; refusing automatic publishing.');
  }
  // Revalidate after the pull: a newly tracked pony path cannot be committed
  // as though it were our untracked research result.
  const updatedStatus = await git('status', '--porcelain=1', '--untracked-files=all', '--', relativePath);
  if (updatedStatus !== `?? ${relativePath}` && updatedStatus !== `A  ${relativePath}`) {
    throw new Error('The pony profile changed while synchronizing; refusing to overwrite existing work.');
  }
  receipt.parent = await git('rev-parse', 'HEAD');
  receipt.blob = await git('hash-object', '--', relativePath);
  await saveReceipt();
  await git('add', '--', relativePath);
  if (await git('diff', '--cached', '--name-only', '--diff-filter=A', '--', relativePath) !== relativePath) {
    throw new Error('The pony profile was not staged as a new file; refusing an empty commit.');
  }

  const title = `🦄 Add pony profile: ${pack}/${slug}`;
  const message = `${title}\n\nAdd the researched pony profile to Kafania's permanent library.\n\nSweetiebot-Pony-Publication: ${receipt.id}\nCo-authored-by: Codex Web <noreply@openai.com>`;
  // --only commits just this path, preserving all other staged user changes.
  await git('commit', '--only', '-m', message, '--', relativePath);
  const sha = await git('rev-parse', 'HEAD');
  receipt.commit = sha;
  await saveReceipt();
  if (await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD') !== relativePath) {
    throw new Error('Pony commit included unexpected files; refusing to push.');
  }
  if (await git('rev-parse', 'HEAD') !== sha || await git('rev-parse', `${sha}^`) !== receipt.parent) {
    throw new Error('Kafania main changed while committing; refusing to push other local commits.');
  }
  await git('push', 'origin', `${sha}:rextension/heads/main`);
  return finish({ pushed: true, commit: sha, path: relativePath });
}

module.exports = { publishPonyProfile, pendingPonyProfiles };
