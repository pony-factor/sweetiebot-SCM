'use strict';

// Prefer leaving the original PR branch unchanged for a squash.
// GitHub's native squash attributes bot-opened PRs to the bot. The only
// no-rewrite, single-commit exception is a pre-existing, already human-authored
// PR commit with the exact intended title and verified credits. Rebase-merging
// that commit preserves its original Git author while leaving the PR head alone.
const { execFile } = require('node:child_process');
const { isCodex } = require('../codex/attribution');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');
const { splitSquashTrailers, squashMessage, readCommits } = require('./squash_attribution');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

function verifiedHumanAuthor(commits) {
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
  return { ...author, login: chosen.author.login };
}

function humanAuthor(commits) {
  const { name, email } = verifiedHumanAuthor(commits);
  return { name, email };
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


async function humanSquashMerge(repository, number, { api, gitToken, allowHistoryRewrite = false, localMerge, trailerSeparatorStyle } = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0) {
    throw Error('Invalid repository or PR number.');
  }
  api ||= require('../github/user_api').legacyAPI(require('./pull_request').githubApi);

  const root = 'repos/' + repository;
  const prPath = root + '/pulls/' + number;
  const original = await api(prPath);
  const base = original?.base?.ref;
  const head = original?.head?.ref;
  const headSha = original?.head?.sha;
  if (original?.state !== 'open' || original.draft || original.merged_at ||
      original?.stack || original.mergeable !== true ||
      original?.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      original?.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !SHA.test(headSha || '') ||
      !head || !base || head === base || head === 'main' || head === 'master') {
    throw Error('PR must be open, mergeable, unstacked, and have a distinct head and base.');
  }

  // PR base.sha can lag behind the branch even on a fresh PR response.
  // Snapshot the branch itself and recheck it before the merge write.
  const readBaseTip = async () => {
    const branch = await api(root + '/branches/' + encodeURIComponent(base));
    if (!SHA.test(branch?.commit?.sha || '')) throw Error('Cannot verify the current PR base branch tip.');
    return branch.commit.sha;
  };
  const baseSha = await readBaseTip();

  const commits = await readCommits(async ([endpoint]) => api(endpoint), repository, number);
  const author = humanAuthor(commits);
  const prepareSquash = async () => {
    // Only the local one-PR merge action opts into this last resort. The local
    // executor independently verifies necessity, branch isolation, live tips,
    // human attribution, and checks before its exact-head leased push.
    localMerge ||= require('./local_human_squash').humanSquashMerge;
    return localMerge(repository, number, {
      api, gitToken, allowHistoryRewrite: true, rewriteReason: 'preserve-human-author',
      expected: { headSha, baseSha, head, base, title: original.title }
    });
  };
  if (commits.length !== 1) {
    if (allowHistoryRewrite) return prepareSquash();
    throw Error('No-force-push policy: cannot squash multiple original PR commits under a verified human author without rewriting the PR branch. No push was attempted. Use Merge preserving commits to retain the original history.');
  }
  const originalCommit = commits[0];
  if (originalCommit.sha && originalCommit.sha !== headSha) {
    throw Error('PR head does not match its only original commit; refusing the merge.');
  }
  const existing = String(originalCommit.commit?.message || '').replace(/\r\n?/g, '\n').trimEnd();
  const expectedTitle = squashMessage(original.title, number, commits, { primaryAuthor: author }).title;
  const sections = splitSquashTrailers(existing, trailerSeparatorStyle);
  if (existing.split('\n', 1)[0] !== expectedTitle ||
      sections.length !== 2 ||
      !existing.split('\n').some(line => {
        const coauthor = /^Co-authored-by: (.+?) <(noreply@openai\.com)>$/i.exec(line.trim());
        return coauthor && isCodex(coauthor[1], coauthor[2]) &&
          (/(?:\bWeb|\bWeb\))$/i.test(coauthor[1]));
      })) {
    if (allowHistoryRewrite) return prepareSquash();
    throw Error('No-force-push policy: the single original human-authored commit is not already prepared with the exact PR title, configured co-author separator and required Codex Web credit. No push was attempted. Use Merge preserving commits rather than rewriting this PR branch.');
  }
  const repositoryInfo = await api(root);
  if (repositoryInfo?.allow_rebase_merge !== true) {
    throw Error('GitHub rebase merging is disabled; no non-rewriting human-authored squash is available.');
  }

  // Re-read both tips immediately before the only write: the GitHub PR rebase
  // merge. This operation never pushes to (or changes the history of) the head.
  const fresh = await api(prPath);
  if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at ||
      fresh.title !== original.title || fresh.head?.ref !== head || fresh.head?.sha !== headSha ||
      fresh.base?.ref !== base || fresh.stack || await readBaseTip() !== baseSha) {
    throw Error('PR head or base changed before merge; the PR remains untouched.');
  }
  const outcome = await api(prPath + '/merge', 'PUT',
    ['-f', 'sha=' + headSha, '-f', 'merge_method=rebase']);
  if (outcome?.merged !== true || !SHA.test(outcome.sha || '')) {
    throw Error('GitHub did not confirm the human-authored rebase merge.');
  }
  const destination = await api(root + '/commits/' + outcome.sha);
  verifyCommit(destination, existing, author);
  const merged = await api(prPath);
  if (!merged?.merged || merged.base?.ref !== base || merged.merge_commit_sha !== outcome.sha) {
    throw Error('Merged PR destination or bookkeeping could not be verified.');
  }
  return { merged: true, sha: outcome.sha, author, base, number,
    url: 'https://github.com/' + repository + '/commit/' + outcome.sha };
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
module.exports = { humanAuthor, verifiedHumanAuthor, verifyCommit, humanSquashMerge };
