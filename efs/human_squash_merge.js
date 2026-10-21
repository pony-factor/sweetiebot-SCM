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
const { squashMessage, readCommits } = require('./squash_attribution');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

function humanAuthor(commits) {
  if (!Array.isArray(commits) || !commits.length) throw Error('Original PR commits are unavailable.');
  const candidates = commits.filter(item => {
    const git = item?.commit?.author;
    const account = item?.author;
    return account?.type === 'User' && typeof account.login === 'string' &&
      !/\[bot\]$/i.test(account.login) &&
      typeof git?.name === 'string' && git.name.trim() &&
      !/\[bot\]|^codex(?: web)?$|^copilot$|^ollama/i.test(git.name.trim()) &&
      typeof git?.email === 'string' && /^[^\s<>]+@[^\s<>]+$/.test(git.email);
  });
  if (!candidates.length) {
    throw Error('No verified original human Git author with a linked GitHub account; refusing bot-authored merge.');
  }
  const chosen = candidates[0];
  const author = { name: chosen.commit.author.name.trim(), email: chosen.commit.author.email.trim() };
  if (/[<>\r\n]/.test(author.name)) throw Error('Invalid human Git author identity.');
  return author;
}

function verifyCommit(commit, expected, author) {
  const message = commit?.commit?.message?.replace(/\r\n/g, '\n').trimEnd();
  const gitAuthor = commit?.commit?.author;
  if (message !== expected.trimEnd() ||
      gitAuthor?.name !== author.name || gitAuthor?.email !== author.email ||
      /\[bot\]|codex-pony/i.test(gitAuthor.name)) {
    throw Error('Merged commit author or exact squash message differs; do not claim a verified merge.');
  }
}

async function humanSquashMerge(repository, number, {
  api, git, temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-human-squash-'))
} = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0) {
    throw Error('Invalid repository or PR number.');
  }
  api ||= async (endpoint, method = 'GET', fields = []) =>
    JSON.parse((await exec(gh, ['api', '-X', method, endpoint, ...fields], { timeout: 120000 })).stdout);
  git ||= async (...args) => (await exec('git', args, { timeout: 120000 })).stdout.trim();
  const endpoint = 'repos/' + repository;
  const prPath = endpoint + '/pulls/' + number;
  const original = await api(prPath);
  const base = original?.base?.ref;
  const head = original?.head?.ref;
  const originalSha = original?.head?.sha;
  const baseSha = original?.base?.sha;
  if (original?.state !== 'open' || original.draft || original.merged_at ||
      original?.stack || original.mergeable !== true ||
      original?.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      original?.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !SHA.test(originalSha || '') || !SHA.test(baseSha || '') || !head || !base || head === base ||
      head === 'main' || head === 'master') {
    throw Error('PR must be open, mergeable, unstacked and use a separate writable head in this repository.');
  }
  const repositoryInfo = await api(endpoint);
  if (repositoryInfo.allow_rebase_merge !== true) {
    throw Error('GitHub rebase merging is disabled; cannot preserve an explicit squash Git author.');
  }
  const headBranch = await api(endpoint + '/branches/' + head.split('/').map(encodeURIComponent).join('/'));
  if (headBranch.protected) throw Error('PR head is protected; cannot safely replace its commits.');
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
  const commits = await readCommits(async ([url]) => api(url), repository, number);
  const author = humanAuthor(commits);
  const prepared = squashMessage(original.title, number, commits, { primaryAuthor: author });
  const message = prepared.title + '\n\n' + prepared.message;
  // Retrying after GitHub rejects pending checks or reviews must NOT rewrite
  // the same PR head again: doing so would restart checks on every click.
  const existing = commits.length === 1 ? commits[0].commit.message.replace(/\r\n/g, '\n').trimEnd() : '';
  const sections = existing.split('\n\n---------\n\n');
  const alreadyPrepared = sections.length === 2 &&
    sections[0].startsWith(prepared.title + '\n\n- ') &&
    sections[1].split('\n').every(line => /^Co-authored-by: .+ <[^<>\s]+@[^<>\s]+>$/.test(line)) &&
    sections[1].includes('Co-authored-by: Codex Web <noreply@openai.com>') &&
    !sections[1].includes('Co-authored-by: ' + author.name + ' <');
  const finish = async (sha, expected) => {
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.head?.sha !== sha ||
        fresh.base?.sha !== baseSha || fresh.base?.ref !== base ||
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
  if (alreadyPrepared) return finish(originalSha, existing);
  let temp;
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
    await inRepo('checkout', '--quiet', '--detach', liveBase);
    await inRepo('merge', '--squash', '--no-commit', liveHead);
    const staged = await inRepo('diff', '--cached', '--name-only');
    if (!staged.trim()) throw Error('Squash would make no changes; refusing empty commit.');
    // No unexpected base-only or unrelated file changes may enter this commit.
    const originalFiles = (await inRepo('diff', '--name-only', mergeBase, liveHead)).split('\n').filter(Boolean).sort();
    const proposedFiles = staged.split('\n').filter(Boolean).sort();
    if (JSON.stringify(proposedFiles) !== JSON.stringify(originalFiles)) {
      throw Error('The squash changes a different file set than the PR; inspect conflicts manually.');
    }
    const messageFile = path.join(temp, '.git', 'sweetiebot-squash-message');
    await fs.writeFile(messageFile, message + '\n');
    await inRepo('commit', '--author=' + author.name + ' <' + author.email + '>', '-F', messageFile);
    const preparedSha = await inRepo('rev-parse', 'HEAD');
    const baseTree = await inRepo('rev-parse', liveBase + '^{tree}');
    const newTree = await inRepo('rev-parse', 'HEAD^{tree}');
    if (!SHA.test(preparedSha) || newTree === baseTree) throw Error('No new verified squash tree.');
    // Re-read GitHub before the ONLY force-with-lease, scoped strictly to the selected head.
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.head?.sha !== originalSha ||
        fresh.base?.sha !== baseSha || fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before guarded push; no branch was modified.');
    }
    await inRepo('push', '--force-with-lease=refs/heads/' + head + ':' + originalSha,
      'origin', preparedSha + ':refs/heads/' + head);
    const rewritten = await api(prPath);
    if (rewritten?.state !== 'open' || rewritten.head?.sha !== preparedSha ||
        rewritten.base?.ref !== base || rewritten.base?.sha !== baseSha) {
      throw Error('PR changed after guarded push; inspect the selected branch before merging.');
    }
    // Native GitHub rebase merge records the same bot-opened PR as merged.
    return finish(preparedSha, message);
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [repository, rawNumber] = process.argv.slice(2);
  humanSquashMerge(repository, Number(rawNumber)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { humanAuthor, verifyCommit, humanSquashMerge };
