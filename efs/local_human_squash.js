'use strict';

// A GitHub squash merge credits the PR opener (often codex-pony[bot]) as Git
// author. Build one human-authored commit on the selected PR head instead, then
// ask GitHub to rebase-merge that ONE commit. This keeps GitHub PR bookkeeping,
// branch rules, reviews and the original PR opener intact.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { SQUASH_SEPARATOR, squashMessage, readCommits } = require('./squash_attribution');
const { patchPaths, safePatchPath } = require('./merge_patch');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

const { humanAuthor, verifyCommit } = require('./human_squash_merge');

async function humanSquashMerge(repository, number, {
  api, git, expected, resolutionPatch = null,
  temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-human-squash-'))
} = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0 ||
      !expected || !SHA.test(expected.headSha || '') || !SHA.test(expected.baseSha || '')) {
    throw Error('Invalid repository or PR number.');
  }
  api ||= async (endpoint, method = 'GET', fields = []) =>
    JSON.parse((await exec(gh, ['api', '-X', method, endpoint, ...fields], { timeout: 120000 })).stdout);
  git ||= async (...args) => {
    try { return (await exec('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
    '-c', 'credential.helper=!' + gh + ' auth git-credential', ...args],
  { timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } })).stdout.trim();
    } catch { throw Error('Local Git operation failed; no file contents are included in this report.'); }
  };
  const endpoint = 'repos/' + repository;
  const prPath = endpoint + '/pulls/' + number;
  const original = await api(prPath);
  const base = original?.base?.ref;
  const head = original?.head?.ref;
  const originalSha = original?.head?.sha;
  // GitHub PR base.sha may lag the actual destination branch.
  const readBaseTip = async () => {
    const branch = await api(endpoint + '/branches/' + encodeURIComponent(base));
    if (!SHA.test(branch?.commit?.sha || '')) throw Error('Cannot verify the current base branch tip.');
    return branch.commit.sha;
  };
  const baseSha = await readBaseTip();
  if (expected && (originalSha !== expected.headSha || base !== expected.base ||
      head !== expected.head || original.title !== expected.title ||
      (resolutionPatch !== null && baseSha !== expected.baseSha))) {
    throw Error('Selected PR head, base or title changed; prepare a fresh handoff.');
  }
  if (resolutionPatch !== null && (!expected || typeof resolutionPatch !== 'string' ||
      !resolutionPatch.trim() || Buffer.byteLength(resolutionPatch) > 60000)) {
    throw Error('A complete bounded resolution patch requires an exact selected snapshot.');
  }
  if (original?.state !== 'open' || original.draft || original.merged_at ||
      original?.stack || (resolutionPatch === null && original.mergeable !== true) ||
      original?.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      original?.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !SHA.test(originalSha || '') || !SHA.test(baseSha || '') || !head || !base || head === base ||
      head === 'main' || head === 'master') {
    throw Error('PR must be open, mergeable, unstacked and use a separate writable head in this repository.');
  }
  for (const ref of [base, head]) {
    if (ref.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')) {
      throw Error('Unsafe Git branch name.');
    }
  }
  const repositoryInfo = await api(endpoint);
  if (head === repositoryInfo.default_branch) throw Error('Cannot rewrite the repository default branch.');
  if (repositoryInfo.allow_rebase_merge !== true) {
    throw Error('GitHub rebase merging is disabled; cannot preserve an explicit squash Git author.');
  }
  const checkHeadIsolation = async () => {
    const headBranch = await api(endpoint + '/branches/' + encodeURIComponent(head));
    if (headBranch.protected !== false) throw Error('PR head is protected; cannot safely replace its commits.');
    // Rewriting the head of an open child PR or sibling would affect unselected work.
    for (let page = 1; page <= 100; page++) {
      const pulls = await api(endpoint + '/pulls?state=open&per_page=100&page=' + page);
      if (!Array.isArray(pulls)) throw Error('Cannot inspect all dependent pull requests.');
      if (pulls.some(p => p.number !== number &&
        (p.base?.ref === head || (p.head?.ref === head &&
          p.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase())))) {
        throw Error('Another open PR depends on or shares this head branch; refusing to rewrite it.');
      }
      if (pulls.length < 100) break;
      if (page === 100) throw Error('Open PR dependency list is incomplete.');
    }
  };
  const commits = await readCommits(async ([url]) => api(url), repository, number);
  if (commits.at(-1)?.sha && commits.at(-1).sha !== originalSha) {
    throw Error('Original commit history does not match the selected PR head.');
  }
  const author = humanAuthor(commits);
  const prepared = squashMessage(original.title, number, commits, { primaryAuthor: author });
  const preparedMessage = prepared.title + '\n\n' + prepared.message;
  // Retrying after GitHub rejects pending checks or reviews must NOT rewrite
  // the same PR head again: doing so would restart checks on every click.
  const existing = commits.length === 1 ? commits[0].commit.message.replace(/\r\n/g, '\n').trimEnd() : '';
  const sections = existing.split('\n\n' + SQUASH_SEPARATOR + '\n\n');
  const alreadyPrepared = sections.length === 2 &&
    existing.split('\n', 1)[0] === prepared.title &&
    sections[1].split('\n').every(line => /^Co-authored-by: .+ <[^<>\s]+@[^<>\s]+>$/.test(line)) &&
    sections[1].includes('Co-authored-by: Codex Web <noreply@openai.com>') &&
    !sections[1].includes('Co-authored-by: ' + author.name + ' <');
  const message = alreadyPrepared ? existing : preparedMessage;
  const finish = async (sha, expected) => {
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title || fresh.head?.sha !== sha ||
        await readBaseTip() !== baseSha || fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before GitHub merge; inspect the updated head and base.');
    }
    const outcome = await api(prPath + '/merge', 'PUT',
      ['-f', 'sha=' + sha, '-f', 'merge_method=rebase']);
    if (outcome?.merged !== true || !SHA.test(outcome.sha || '')) {
      throw Error('GitHub did not confirm rebase merge; the human-authored PR branch remains available.');
    }
    const destination = await api(endpoint + '/commits/' + outcome.sha);
    verifyCommit(destination, expected, author);
    const merged = await api(prPath);
    if (!merged.merged || merged.base?.ref !== base || merged.merge_commit_sha !== outcome.sha) {
      throw Error('PR merge bookkeeping or target was not verified; inspect GitHub.');
    }
    return { merged: true, sha: outcome.sha, author, base, number,
      url: 'https://github.com/' + repository + '/commit/' + outcome.sha };
  };
  if (alreadyPrepared && resolutionPatch === null) return finish(originalSha, existing);
  await checkHeadIsolation();
  let temp, pushedSha;
  try { await git('check-ref-format', '--branch', base); await git('check-ref-format', '--branch', head); }
  catch { throw Error('Invalid Git branch name.'); }
  try {
    temp = await temporaryDirectory();
    const remote = 'https://github.com/' + repository + '.git';
    await git('clone', '--quiet', '--no-checkout', remote, temp);
    const inRepo = (...args) => git('-C', temp, ...args);
    // Fetch both exact branch tips. Never work inside the user's editor checkout.
    await inRepo('fetch', '--quiet', 'origin', 'refs/heads/' + base, 'refs/heads/' + head);
    const liveBase = await inRepo('rev-parse', 'refs/remotes/origin/' + base);
    const liveHead = await inRepo('rev-parse', 'refs/remotes/origin/' + head);
    if (liveBase !== baseSha || liveHead !== originalSha) {
      throw Error('Selected base or head changed during fetch; restart from a fresh PR snapshot.');
    }
    const mergeBase = await inRepo('merge-base', liveBase, liveHead);
    if (!SHA.test(mergeBase)) throw Error('No verified common ancestor.');
    const originalFiles = (await inRepo('diff', '--name-only', '-z', mergeBase, liveHead)).split('\0').filter(Boolean).sort();
    // Check names before checking out or reading changed file contents.
    if (!originalFiles.length || originalFiles.some(name => !safePatchPath(name))) {
      throw Error('PR contains unsafe or secret-bearing paths; local execution is blocked.');
    }
    for (const tree of [liveBase, liveHead]) {
      const entries = await inRepo('ls-tree', '-z', tree, '--', ...originalFiles);
      if (entries.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))) {
        throw Error('Local squash supports regular text files only.');
      }
    }
    await inRepo('checkout', '--quiet', '--detach', liveBase);
    let resolvedFiles;
    if (resolutionPatch !== null) {
      const patchFile = path.join(temp, '.git', 'sweetiebot-resolution.patch');
      await fs.writeFile(patchFile, resolutionPatch, { mode: 0o600 });
      const numstat = await inRepo('apply', '--numstat', '-z', '--', patchFile);
      resolvedFiles = patchPaths(resolutionPatch, numstat, originalFiles);
      if (JSON.stringify(resolvedFiles) !== JSON.stringify(originalFiles)) {
        throw Error('Complete resolution patch must cover the original PR file set.');
      }
      const baseEntries = await inRepo('ls-tree', '-z', liveBase, '--', ...resolvedFiles);
      if (baseEntries.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))) {
        throw Error('Resolution patches cannot modify existing symlinks or submodules.');
      }
      await inRepo('apply', '--check', '--index', '--', patchFile);
      await inRepo('apply', '--index', '--', patchFile);
      await inRepo('diff', '--cached', '--check');
    } else {
      await inRepo('merge', '--squash', '--no-commit', liveHead);
    }
    const staged = await inRepo('diff', '--cached', '--name-only', '-z');
    if (!staged.trim()) throw Error('Squash would make no changes; refusing empty commit.');
    // No unexpected base-only or unrelated file changes may enter this commit.
    const proposedFiles = staged.split('\0').filter(Boolean).sort();
    if (JSON.stringify(proposedFiles) !== JSON.stringify(resolvedFiles || originalFiles)) {
      throw Error('The squash changes a different file set than the PR; inspect conflicts manually.');
    }
    const messageFile = path.join(temp, '.git', 'sweetiebot-squash-message');
    await fs.writeFile(messageFile, message + '\n');
    await inRepo('-c', 'user.name=' + author.name, '-c', 'user.email=' + author.email,
      '-c', 'commit.gpgsign=false', 'commit', '--author=' + author.name + ' <' + author.email + '>', '-F', messageFile);
    const preparedSha = await inRepo('rev-parse', 'HEAD');
    const baseTree = await inRepo('rev-parse', liveBase + '^{tree}');
    const newTree = await inRepo('rev-parse', 'HEAD^{tree}');
    if (!SHA.test(preparedSha) || newTree === baseTree) throw Error('No new verified squash tree.');
    // Re-read GitHub before the ONLY force-with-lease, scoped strictly to the selected head.
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title || fresh.head?.sha !== originalSha ||
        await readBaseTip() !== baseSha || fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before guarded push; no branch was modified.');
    }
    // Close the PR-dependency race between the first preflight and this push.
    await checkHeadIsolation();
    await inRepo('push', '--force-with-lease=refs/heads/' + head + ':' + originalSha,
      'origin', preparedSha + ':refs/heads/' + head);
    pushedSha = preparedSha;
    const rewritten = await api(prPath);
    if (rewritten?.state !== 'open' || rewritten.draft || rewritten.title !== original.title || rewritten.head?.sha !== preparedSha ||
        rewritten.base?.ref !== base || await readBaseTip() !== baseSha) {
      throw Error('PR changed after guarded push; inspect the selected branch before merging.');
    }
    // Native GitHub rebase merge records the same bot-opened PR as merged.
    return await finish(preparedSha, message);
  } catch (error) {
    if (pushedSha) throw Error(error.message + ' Prepared head: ' + pushedSha + '; original head: ' + originalSha + '. Retry from a fresh selection after checks/reviews pass.');
    throw error;
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { humanSquashMerge };
