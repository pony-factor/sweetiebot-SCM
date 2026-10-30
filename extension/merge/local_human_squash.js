'use strict';

// Preserve PR history by default: append integration commits and use GitHub's
// native squash when the opener is the verified original human author.
// A bot-opened PR requiring a rewritten squash needs explicit local approval.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { splitSquashTrailers, squashMessage, readCommits } = require('./squash_attribution');
const { patchPaths, safePatchPath } = require('./patch');
const { readMergeChecks, waitForMergeChecks } = require('./checks');
const { readPushedPR } = require('../github/pushed_pr');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

const { verifiedHumanAuthor, verifyCommit } = require('./human_squash_merge');

async function humanSquashMerge(repository, number, {
  api, git, gitToken, expected, resolutionPatch = null, repairChecks = false, checkOptions = {}, decisions = [], operation = 'merge', onProgress = () => {},
  localGitMerge = false, allowHistoryRewrite = false, rewriteReason = '', offerAuthorChoice = false, requireSignedCommit = false, commitProposal,
  temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-human-squash-'))
} = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0 ||
      !expected || !SHA.test(expected.headSha || '') || !SHA.test(expected.baseSha || '')) {
    throw Error('Invalid repository or PR number.');
  }
  api ||= require('../github/user_api').legacyAPI(require('./pull_request').githubApi);
  git ||= async (...args) => {
    try { return (await exec('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
    '-c', 'credential.helper=!' + gh + ' auth git-credential', ...args],
  { timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...(gitToken ? { GH_TOKEN: gitToken } : {}), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } })).stdout.trim();
    } catch (error) { throw require('../commits/git_failure').gitFailure(error, args); }
  };
  const endpoint = 'repos/' + repository;
  const progress = (stage, detail = {}) => {
    try { onProgress({ number, stage, ...detail }); } catch { /* Display failures cannot change Git execution. */ }
  };
  progress('preparing', { description: expected.explanation });
  progress('reading-pr');
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
  const refreshBase = () => Object.assign(Error('Base changed; refresh the remaining PR and regenerate its current-base resolution.'), { code: 'MERGE_BASE_CHANGED' });
  if (expected && (originalSha !== expected.headSha || base !== expected.base ||
      head !== expected.head || original.title !== expected.title)) {
    throw Error('Selected PR head, base or title changed; prepare a fresh handoff.');
  }
  if (resolutionPatch !== null && baseSha !== expected.baseSha) throw refreshBase();
  if (resolutionPatch !== null && (!expected || typeof resolutionPatch !== 'string' ||
      !resolutionPatch.trim() || Buffer.byteLength(resolutionPatch) > 60000)) {
    throw Error('A complete bounded resolution patch requires an exact selected snapshot.');
  }
  if (original?.state !== 'open' || original.draft || original.merged_at ||
      original?.stack ||
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
  const checkHeadWritable = async () => {
    const headBranch = await api(endpoint + '/branches/' + encodeURIComponent(head));
    if (headBranch.protected !== false) throw Error('PR head is protected; cannot safely update its commits.');
  };
  // Dependent PRs must block destructive rewrites, NOT append-only integration
  // commits or GitHub merges that leave the selected parent branch unchanged.
  const checkHeadRewriteSafety = async () => {
    await checkHeadWritable();
    for (let page = 1; page <= 100; page++) {
      const pulls = await api(endpoint + '/pulls?state=open&per_page=100&page=' + page);
      if (!Array.isArray(pulls)) throw Error('Cannot inspect all dependent pull requests.');
      const dependent = pulls.filter(p => p.number !== number &&
        (p.base?.ref === head || (p.head?.ref === head &&
          p.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase())));
      if (dependent.length) {
        const names = dependent.map(p => '#' + p.number + ' (' + (p.head?.ref || '?') + ' → ' + (p.base?.ref || '?') + ')').join(', ');
        throw Error('Open PR ' + names + ' depends on or shares this head branch "' + head + '"; refusing to rewrite it.');
      }
      if (pulls.length < 100) break;
      if (page === 100) throw Error('Open PR dependency list is incomplete.');
    }
  };
  const checkBaseWritable = async () => {
    const branch = await api(endpoint + '/branches/' + encodeURIComponent(base));
    if (branch.protected !== false) {
      throw Error('The base branch is protected; a locally signed squash cannot bypass its merge policy.');
    }
    let rules;
    try { rules = await api(endpoint + '/rules/branches/' + encodeURIComponent(base)); }
    catch (error) {
      const unavailable = repositoryInfo.private === true && error.status === 403 &&
        /^Upgrade to GitHub Pro or make this repository public to enable this feature\.?$/i.test(error.githubMessage || '');
      if (!unavailable) throw error;
      rules = [];
    }
    if (!Array.isArray(rules) || rules.length) {
      throw Error('The base has active branch rules; a locally signed squash cannot bypass them.');
    }
  };
  const commits = await readCommits(async ([url]) => api(url), repository, number);
  if (commits.at(-1)?.sha && commits.at(-1).sha !== originalSha) {
    throw Error('Original commit history does not match the selected PR head.');
  }
  const verifiedAuthor = verifiedHumanAuthor(commits);
  const author = { name: verifiedAuthor.name, email: verifiedAuthor.email };
  const nativeSquash = !requireSignedCommit && repositoryInfo.allow_squash_merge === true && original.user?.type === 'User' &&
    original.user.login?.toLowerCase() === verifiedAuthor.login.toLowerCase();
  const rewriteApproved = allowHistoryRewrite === true && rewriteReason === 'preserve-human-author' && !nativeSquash;
  if (offerAuthorChoice && operation === 'merge' && resolutionPatch === null && original.mergeable === true && !nativeSquash &&
      !allowHistoryRewrite && !localGitMerge && commits.length > 1) {
    return { merged: false, status: 'blocked', needsAuthorChoice: true, number, base, baseSha,
      reason: 'This PR has no merge conflict. It was opened by a bot or a different account, so GitHub’s native squash would assign the wrong Git author. Choose Merge preserving commits to retain the original commits without rebasing or rewriting history. A single human-authored squash would require a separately approved history rewrite.' };
  }
  decisions = require('./resolution_commits').validateDecisions(decisions);
  if (!['merge', 'sync'].includes(operation)) throw Error('Unknown local merge operation.');
  const prepared = require('./commit_proposal').validateCommitProposal(commitProposal, squashMessage(original.title, number, commits, { primaryAuthor: author }));
  progress('message-prepared', { title: prepared.title, description: prepared.message, proposed: prepared.proposed, adjusted: prepared.adjusted });
  const preparedMessage = prepared.title + '\n\n' + prepared.message;
  // Retrying after GitHub rejects pending checks or reviews must NOT rewrite
  // the same PR head again: doing so would restart checks on every click.
  const existing = commits.length === 1 ? commits[0].commit.message.replace(/\r\n/g, '\n').trimEnd() : '';
  const sections = splitSquashTrailers(existing);
  const alreadyPrepared = sections.length === 2 &&
    existing.split('\n', 1)[0] === prepared.title &&
    sections[1].split('\n').every(line => /^Co-authored-by: .+ <[^<>\s]+@[^<>\s]+>$/.test(line)) &&
    sections[1].includes('Co-authored-by: Codex Web <noreply@openai.com>') &&
    !sections[1].includes('Co-authored-by: ' + author.name + ' <');
  const message = alreadyPrepared ? existing : preparedMessage;
  let operationCommitTitle = commits.at(-1)?.commit?.message?.split('\n')[0] || prepared.title;
  progress('reading-checks', { sha: originalSha });
  const initialChecks = await readMergeChecks(api, repository, originalSha);
  if (repairChecks && (resolutionPatch === null || initialChecks.state !== 'failed')) {
    throw Error('A check repair requires a complete patch and confirmed failing checks on the selected head.');
  }
  const finish = async (sha, expected, method = 'rebase') => {
    progress('waiting-checks', { sha, title: operationCommitTitle });
    const checks = await waitForMergeChecks(api, repository, sha, {
      ...checkOptions, expectChecks: initialChecks.hasChecks, collectEvidence: true,
      onPoll: checks => progress('checks-polled', { sha, ...checks })
    });
    if (checks.state !== 'passed') return { merged: false, status: checks.state === 'pending' ? 'waiting' : 'checks_failed',
      sha, previousHeadSha: originalSha, base, baseSha, number, author,
      reason: checks.state === 'pending' ? 'Waiting for checks on the integrated PR head'
        : 'Checks failed on the integrated PR head: ' + checks.names.join(', ') };
    progress('checks-passed', { sha, title: operationCommitTitle });
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title || fresh.head?.sha !== sha ||
        fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before GitHub merge; inspect the updated head and base.');
    }
    if (await readBaseTip() !== baseSha) throw Object.assign(refreshBase(), { sha, previousHeadSha: originalSha });
    progress('merging', { sha, title: operationCommitTitle });
    let outcome;
    try {
      outcome = await api(prPath + '/merge', 'PUT',
        ['-f', 'sha=' + sha, '-f', 'merge_method=' + method,
          ...(method === 'squash' ? ['-f', 'commit_title=' + prepared.title, '-f', 'commit_message=' + prepared.message] : [])]);
    } catch (error) {
      // A failed response does not prove the server rejected the write. Read
      // the exact PR before reporting failure; never resubmit the merge here.
      for (let attempt = 0; attempt < 3; attempt++) {
        let settled;
        try { settled = await api(prPath); } catch { break; }
        if (settled.merged === true && SHA.test(settled.merge_commit_sha || '')
            && settled.head?.sha === sha && settled.head?.ref === head
            && settled.base?.ref === base && settled.title === original.title) {
          outcome = { merged: true, sha: settled.merge_commit_sha };
          break;
        }
        if (attempt < 2) await (checkOptions.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(200 * (attempt + 1));
      }
      if (!outcome) throw error;
    }
    if (outcome?.merged !== true || !SHA.test(outcome.sha || '')) {
      throw Error('GitHub did not confirm the merge; the PR branch remains available.');
    }
    const destination = await api(endpoint + '/commits/' + outcome.sha);
    verifyCommit(destination, expected, author);
    const merged = await api(prPath);
    if (!merged.merged || merged.base?.ref !== base || merged.merge_commit_sha !== outcome.sha) {
      throw Error('PR merge bookkeeping or target was not verified; inspect GitHub.');
    }
    return { merged: true, status: 'merged', sha: outcome.sha, headSha: sha, previousHeadSha: originalSha,
      author, base, baseSha, number,
      url: 'https://github.com/' + repository + '/commit/' + outcome.sha };
  };
  // GitHub can squash a clean human-opened PR without a preliminary sync.
  if (operation === 'merge' && resolutionPatch === null && original.mergeable === true && nativeSquash && initialChecks.state !== 'failed') {
    return finish(originalSha, preparedMessage, 'squash');
  }
  if (operation === 'merge' && alreadyPrepared && resolutionPatch === null && !requireSignedCommit) {
    const parent = await api(endpoint + '/commits/' + originalSha);
    if (parent.parents?.length === 1 && parent.parents[0].sha === baseSha && repositoryInfo.allow_rebase_merge === true) return finish(originalSha, existing);
    // A different base requires a new integrated tree and checks, not a blind retry.
  }
  if (!localGitMerge || operation === 'sync' || nativeSquash) await checkHeadWritable();
  let temp, pushedSha, conflicts = [];
  try { await git('check-ref-format', '--branch', base); await git('check-ref-format', '--branch', head); }
  catch { throw Error('Invalid Git branch name.'); }
  try {
    progress('creating-checkout');
    temp = await temporaryDirectory();
    const remote = 'https://github.com/' + repository + '.git';
    progress('cloning');
    await git('clone', '--quiet', '--no-checkout', remote, temp);
    const inRepo = (...args) => git('-C', temp, ...args);
    const verifyPushedPR = preparedSha => readPushedPR({
      original, preparedSha, readPR: () => api(prPath),
      readHead: async () => {
        const ref = 'refs/heads/' + head;
        const lines = (await inRepo('ls-remote', '--refs', 'origin', ref)).split('\n');
        const match = lines.find(line => line.split(/\s+/)[1] === ref);
        return match?.split(/\s+/)[0];
      }
    });
    // Fetch both exact branch tips. Never work inside the user's editor checkout.
    await inRepo('fetch', '--quiet', 'origin', 'refs/heads/' + base, 'refs/heads/' + head);
    const liveBase = await inRepo('rev-parse', 'refs/remotes/origin/' + base);
    const liveHead = await inRepo('rev-parse', 'refs/remotes/origin/' + head);
    if (liveHead !== originalSha) {
      throw Error('Selected base or head changed during fetch; restart from a fresh PR snapshot.');
    }
    if (liveBase !== baseSha) throw refreshBase();
    const finishSignedSquash = async finalTree => {
      if (operation !== 'merge' || resolutionPatch !== null || conflicts.length) {
        throw Error('A signed squash requires a clean, conflict-free PR merge.');
      }
      const baseTree = await inRepo('rev-parse', liveBase + '^{tree}');
      if (finalTree === baseTree) throw Error('Signed squash would make no changes; refusing an empty commit.');
      progress('waiting-checks', { sha: originalSha, title: prepared.title });
      const sourceChecks = await waitForMergeChecks(api, repository, originalSha, {
        ...checkOptions, expectChecks: initialChecks.hasChecks, collectEvidence: true,
        onPoll: checks => progress('checks-polled', { sha: originalSha, ...checks })
      });
      if (sourceChecks.state !== 'passed') {
        return { merged: false, status: sourceChecks.state === 'pending' ? 'waiting' : 'checks_failed',
          sha: originalSha, previousHeadSha: originalSha, base, baseSha, number, author,
          reason: sourceChecks.state === 'pending' ? 'Waiting for checks before preparing the signed squash'
            : 'Checks failed on the selected PR head: ' + sourceChecks.names.join(', ') };
      }
      await checkBaseWritable();
      await checkHeadRewriteSafety();
      const selected = await api(prPath);
      if (selected?.state !== 'open' || selected.draft || selected.merged_at || selected.title !== original.title ||
          selected.head?.sha !== originalSha || selected.head?.ref !== head || selected.base?.ref !== base || selected.stack) {
        throw Error('PR changed before signed squash preparation; no branch was modified.');
      }
      if (await readBaseTip() !== baseSha) throw refreshBase();

      const originalTree = await inRepo('rev-parse', originalSha + '^{tree}');
      const originalParents = (await inRepo('show', '-s', '--format=%P', originalSha)).trim().split(/\s+/).filter(Boolean);
      const originalMessage = (await inRepo('show', '-s', '--format=%B', originalSha))
        .replace(/\r\n/g, '\n').trimEnd();
      let signedSha;
      if (originalTree === finalTree && originalParents.length === 1 && originalParents[0] === baseSha &&
          originalMessage === preparedMessage.trimEnd() &&
          /(?:^|\n)gpgsig /.test(await inRepo('cat-file', '-p', originalSha))) {
        signedSha = originalSha;
      }
      if (!signedSha) {
        const messageFile = path.join(temp, '.git', 'sweetiebot-signed-squash-message');
        await fs.writeFile(messageFile, preparedMessage + '\n', { mode: 0o600 });
        signedSha = await inRepo('-c', 'user.name=' + author.name, '-c', 'user.email=' + author.email,
          'commit-tree', '-S', finalTree, '-p', baseSha, '-F', messageFile);
        const raw = await inRepo('cat-file', '-p', signedSha);
        const parents = (await inRepo('show', '-s', '--format=%P', signedSha)).trim().split(/\s+/).filter(Boolean);
        if (!SHA.test(signedSha) || !/(?:^|\n)gpgsig /.test(raw) || parents.length !== 1 ||
            parents[0] !== baseSha || await inRepo('rev-parse', signedSha + '^{tree}') !== finalTree) {
          throw Error('Local Git did not produce the required signed one-parent squash; no branch was pushed.');
        }
        const [name, email, ...body] = (await inRepo('show', '-s', '--format=%an%x00%ae%x00%B', signedSha)).split('\0');
        verifyCommit({ commit: { author: { name, email }, message: body.join('\0') } }, preparedMessage, author);
      }

      const newHeadPushed = signedSha !== originalSha;
      const rollbackHead = async () => {
        if (!newHeadPushed) return true;
        try {
          if (await readBaseTip() !== baseSha) return false;
          const current = await api(prPath);
          if (current?.state !== 'open' || current.head?.sha !== signedSha ||
              current.head?.ref !== head || current.base?.ref !== base) return false;
          await inRepo('push', '--force-with-lease=refs/heads/' + head + ':' + signedSha,
            'origin', originalSha + ':refs/heads/' + head);
          pushedSha = undefined;
          return true;
        } catch { return false; }
      };
      if (newHeadPushed) {
        const fresh = await api(prPath);
        if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title ||
            fresh.head?.sha !== originalSha || fresh.head?.ref !== head || fresh.base?.ref !== base || fresh.stack) {
          throw Error('PR changed before signed squash push; no branch was modified.');
        }
        if (await readBaseTip() !== baseSha) throw refreshBase();
        await checkBaseWritable();
        await checkHeadRewriteSafety();
        progress('pushing-signed-squash-head', { sha: signedSha, title: prepared.title });
        try {
          await inRepo('push', '--force-with-lease=refs/heads/' + head + ':' + originalSha,
            'origin', signedSha + ':refs/heads/' + head);
          pushedSha = signedSha;
        } catch (error) {
          let remoteHead;
          try {
            const lines = (await inRepo('ls-remote', '--refs', 'origin', 'refs/heads/' + head)).split('\n');
            remoteHead = lines.find(line => line.split(/\s+/)[1] === 'refs/heads/' + head)?.split(/\s+/)[0];
          } catch {}
          if (remoteHead !== signedSha) throw error;
          pushedSha = signedSha;
        }
      }

      try {
        progress('verifying-push', { sha: signedSha, title: prepared.title });
        await verifyPushedPR(signedSha);
        const destination = await api(endpoint + '/commits/' + signedSha);
        verifyCommit(destination, preparedMessage, author);
        const verification = destination?.commit?.verification;
        if (verification?.verified !== true) {
          throw Error('GitHub did not verify the signed squash commit (' +
            (verification?.reason || 'unknown reason') + '); the base was not updated.');
        }
      } catch (error) {
        const restored = await rollbackHead();
        if (!restored && newHeadPushed) Object.assign(error, { preparedHead: signedSha, originalHead: originalSha });
        throw error;
      }
      pushedSha = signedSha;

      if (finalTree !== originalTree) {
        progress('waiting-checks', { sha: signedSha, title: prepared.title });
        const integratedChecks = await waitForMergeChecks(api, repository, signedSha, {
          ...checkOptions, expectChecks: initialChecks.hasChecks, collectEvidence: true,
          onPoll: checks => progress('checks-polled', { sha: signedSha, ...checks })
        });
        if (integratedChecks.state !== 'passed') {
          return { merged: false, status: integratedChecks.state === 'pending' ? 'waiting' : 'checks_failed',
            sha: signedSha, previousHeadSha: originalSha, base, baseSha, number, author,
            reason: integratedChecks.state === 'pending' ? 'Waiting for checks on the signed squash commit'
              : 'Checks failed on the signed squash commit: ' + integratedChecks.names.join(', ') };
        }
      }

      try {
        const fresh = await api(prPath);
        if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title ||
            fresh.head?.sha !== signedSha || fresh.head?.ref !== head || fresh.base?.ref !== base || fresh.stack) {
          throw Error('PR changed before signed squash publication; the base was not updated.');
        }
        if (await readBaseTip() !== baseSha) throw refreshBase();
        await checkBaseWritable();
      } catch (error) {
        const restored = await rollbackHead();
        if (!restored && newHeadPushed) Object.assign(error, { preparedHead: signedSha, originalHead: originalSha });
        throw error;
      }

      progress('pushing-signed-squash-base', { sha: signedSha, title: prepared.title });
      try {
        await inRepo('push', 'origin', signedSha + ':refs/heads/' + base);
      } catch (error) {
        // A lost push acknowledgement is resolved by checking whether the exact
        // signed commit reached the base. Otherwise preserve the PR for recovery.
        try {
          await inRepo('fetch', '--quiet', 'origin', 'refs/heads/' + base);
          const remoteBase = await inRepo('rev-parse', 'refs/remotes/origin/' + base);
          await inRepo('merge-base', '--is-ancestor', signedSha, remoteBase);
        } catch {
          const restored = await rollbackHead();
          if (!restored && newHeadPushed) Object.assign(error, { preparedHead: signedSha, originalHead: originalSha });
          throw error;
        }
      }
      await inRepo('fetch', '--quiet', 'origin', 'refs/heads/' + base);
      const remoteBase = await inRepo('rev-parse', 'refs/remotes/origin/' + base);
      try { await inRepo('merge-base', '--is-ancestor', signedSha, remoteBase); }
      catch { throw Error('The signed squash did not reach the base branch; inspect the remote before retrying.'); }

      progress('verifying-signed-squash', { sha: signedSha, title: prepared.title });
      for (let attempt = 0; attempt < 12; attempt++) {
        const merged = await api(prPath);
        if (merged?.merged === true && merged.merge_commit_sha === signedSha &&
            merged.base?.ref === base && merged.head?.sha === signedSha) {
          const destination = await api(endpoint + '/commits/' + signedSha);
          verifyCommit(destination, preparedMessage, author);
          if (destination?.commit?.verification?.verified !== true) {
            throw Error('GitHub no longer reports the signed squash as verified; inspect the merged commit.');
          }
          return { merged: true, status: 'merged', sha: signedSha, headSha: signedSha,
            previousHeadSha: originalSha, author, base, baseSha, number,
            method: 'local-signed-squash', signed: true,
            url: 'https://github.com/' + repository + '/commit/' + signedSha };
        }
        if (attempt < 11) await (checkOptions.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
      }
      throw Error('The signed squash reached the base, but GitHub has not confirmed the PR as merged; do not repeat the merge.');
    };
    progress('inspecting-files');
    const mergeBase = await inRepo('merge-base', liveBase, liveHead);
    if (!SHA.test(mergeBase)) throw Error('No verified common ancestor.');
    const originalFiles = (await inRepo('diff', '--name-only', '-z', mergeBase, liveHead)).split('\0').filter(Boolean).sort();
    // Check names before checking out or reading changed file contents.
    if (!originalFiles.length || originalFiles.some(name => !safePatchPath(name))) {
      throw Error('PR contains unsafe or secret-bearing paths; local execution is blocked.');
    }
    if (mergeBase === liveBase && resolutionPatch === null) {
      if (operation === 'sync') return { merged: false, status: 'synced', number,
        sha: originalSha, previousHeadSha: originalSha, base, baseSha, unchanged: true,
        reason: 'PR branch already contains the current base; no incremental commit or push was needed.' };
      if (nativeSquash) return finish(originalSha, preparedMessage, 'squash');
      if (!rewriteApproved && !localGitMerge) return { merged: false, status: 'blocked', number,
        needsAuthorChoice: true, reason: 'Squash is blocked by Git-author attribution, not merge conflicts. GitHub would credit the bot or different PR opener. Choose Merge preserving commits for a merge commit without rebasing or rewriting the PR branch; a human-authored single squash requires explicit local approval.' };
    }
    const treeEntries = new Map();
    for (const tree of [liveBase, liveHead]) {
      const entries = await inRepo('ls-tree', '-z', tree, '--', ...originalFiles);
      if (entries.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))) {
        throw Error('Local squash supports regular text files only.');
      }
      treeEntries.set(tree, new Map(entries.split('\0').filter(Boolean).map(entry => {
        const separator = entry.indexOf('\t');
        return [entry.slice(separator + 1), entry.slice(0, separator)];
      })));
    }
    const requiredFiles = originalFiles.filter(name => treeEntries.get(liveBase).get(name) !== treeEntries.get(liveHead).get(name));
    await inRepo('checkout', '--quiet', '--detach', liveBase);
    let resolvedFiles;
    if (resolutionPatch !== null) {
      // Determine actual conflicts independently of model-supplied metadata.
      try { await inRepo('merge', '--squash', '--no-commit', liveHead); }
      catch (error) {
        conflicts = (await inRepo('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        if (conflicts.some(name => !safePatchPath(name))) throw Error('Conflict involves an unsafe or secret-bearing path.');
      }
      if (conflicts.length && (conflicts.length !== decisions.length ||
          conflicts.some(file => !decisions.some(item => item.path === file)))) {
        return { merged: false, status: 'needs_resolution', number, headSha: originalSha, baseSha,
          conflictPaths: conflicts, reason: 'Provide a specific decision title and explanation for each conflicted file before synchronizing the PR branch.' };
      }
      const patchFile = path.join(temp, '.git', 'sweetiebot-resolution.patch');
      await fs.writeFile(patchFile, resolutionPatch, { mode: 0o600 });
      const numstat = await inRepo('apply', '--numstat', '-z', '--', patchFile);
      resolvedFiles = patchPaths(resolutionPatch, numstat, originalFiles, { allowCheckRepairTests: repairChecks });
      const missing = requiredFiles.filter(name => !resolvedFiles.includes(name));
      if (missing.some(name => conflicts.includes(name))) {
        throw Error('Resolution patch must cover every conflicted PR file.');
      }
      // Keep Git's clean integration for PR files outside the supplied patch.
      // This diff is generated from the isolated three-way index, never from
      // the old PR tree, which could discard newer base changes.
      const cleanEntries = [];
      if (missing.length) {
        const changed = (await inRepo('diff', '--cached', '--name-only', '-z', liveBase, '--', ...missing))
          .split('\0').filter(Boolean);
        for (const name of changed) {
          if (!missing.includes(name) || !safePatchPath(name)) throw Error('Unexpected clean integration path.');
          const entry = await inRepo('ls-files', '--stage', '-z', '--', name);
          const match = /^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)\0?$/.exec(entry);
          if (entry && (!match || match[3] !== name)) throw Error('Clean integration contains an unresolved, symlink or submodule entry.');
          cleanEntries.push(match ? {name,mode:match[1],blob:match[2]} : {name});
        }
        resolvedFiles = [...resolvedFiles, ...cleanEntries.map(entry => entry.name)].sort();
      }
      await inRepo('reset', '--hard', liveBase);
      const baseEntries = await inRepo('ls-tree', '-z', liveBase, '--', ...resolvedFiles);
      if (baseEntries.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))) {
        throw Error('Resolution patches cannot modify existing symlinks or submodules.');
      }
      progress('applying-resolution');
      await inRepo('apply', '--check', '--index', '--', patchFile);
      await inRepo('apply', '--index', '--', patchFile);
      // Preserve Git's own clean index entries, including image blobs. Model
      // supplied patches remain text-only and never choose these blob IDs.
      for (const entry of cleanEntries) {
        if (entry.blob) await inRepo('update-index', '--add', '--cacheinfo', entry.mode, entry.blob, entry.name);
        else await inRepo('update-index', '--force-remove', '--', entry.name);
      }
      await inRepo('diff', '--cached', '--check');
    } else {
      progress('integrating');
      try { await inRepo('merge', '--squash', '--no-commit', liveHead); }
      catch (error) {
        const conflicts = (await inRepo('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        if (conflicts.some(name => !safePatchPath(name))) throw Error('Conflict involves an unsafe or secret-bearing path.');
        return { merged: false, status: 'needs_resolution', number, headSha: originalSha, baseSha,
          conflictPaths: conflicts, reason: 'Resolve the overlapping edits against the current base, preserving both intentions.' };
      }
    }
    // A clean integration is not a conflict resolution. Do not append main-only
    // changes or restart CI merely because the base branch advanced.
    if (operation === 'sync' && resolutionPatch === null && !conflicts.length) {
      return { merged: false, status: 'synced', unchanged: true, number,
        sha: originalSha, previousHeadSha: originalSha, base, baseSha,
        reason: 'No merge conflicts or explicit resolution changes; left the PR branch unchanged.' };
    }
    const staged = await inRepo('diff', '--cached', '--name-only', '-z');
    if (!staged.trim()) throw Error('Squash would make no changes; refusing empty commit.');
    // No unexpected base-only or unrelated file changes may enter this commit.
    const proposedFiles = staged.split('\0').filter(Boolean).sort();
    if (proposedFiles.some(name => !originalFiles.includes(name) &&
          !(repairChecks && /^tests\/test_[\w.-]+\.(?:js|py)$/.test(name))) ||
        (resolvedFiles && JSON.stringify(proposedFiles) !== JSON.stringify(resolvedFiles))) {
      throw Error('The squash changes a different file set than the PR; inspect conflicts manually.');
    }
    const finishLocal = async (sha, finalTree) => require('./local_author_merge').localAuthorMerge({
      repository, number, original, headSha: sha, baseSha, tree: finalTree, author,
      message: preparedMessage, git: inRepo, api, directory: temp, checkOptions,
      expectChecks: initialChecks.hasChecks, onProgress: progress, requireSignedCommit,
      privateRepository: repositoryInfo.private === true
    });
    if (requireSignedCommit) return await finishSignedSquash(await inRepo('write-tree'));
    if (localGitMerge && operation === 'merge' && !nativeSquash) {
      const finalTree = await inRepo('write-tree');
      if (finalTree === await inRepo('rev-parse', originalSha + '^{tree}')) return await finishLocal(originalSha, finalTree);
    }
    if (operation === 'sync' || conflicts.length || nativeSquash || localGitMerge || !rewriteApproved) {
      const finalTree = await inRepo('write-tree');
      const prepared = await require('./resolution_commits').createResolutionCommits({
        git: inRepo, directory: temp, headSha: originalSha, baseSha, finalTree,
        conflicts, decisions, author, base,
        onCommit: decision => progress('decision-commit', decision)
      });
      operationCommitTitle = '🔄 Sync branch to ' + base;
      progress('sync-prepared', { sha: prepared.sha, title: operationCommitTitle });
      // The PR history is append-only. No reference on main is updated here.
      await inRepo('merge-base', '--is-ancestor', originalSha, prepared.sha);
      const fresh = await api(prPath);
      if (fresh.state !== 'open' || fresh.draft || fresh.head?.sha !== originalSha || fresh.title !== original.title ||
          fresh.head?.ref !== head || fresh.base?.ref !== base) throw Error('PR changed before branch synchronization.');
      if (await readBaseTip() !== baseSha) throw refreshBase();
      await checkHeadWritable();
      // An exact-head lease plus the ancestry check above guarantees this is
      // an append-only update, including if someone rewinds the remote ref.
      progress('pushing', { sha: prepared.sha, title: operationCommitTitle });
      await inRepo('push', 'origin', prepared.sha + ':refs/heads/' + head);
      pushedSha = prepared.sha;
      progress('pushed', { sha: prepared.sha, title: operationCommitTitle });
      progress('verifying-push', { sha: prepared.sha, title: operationCommitTitle });
      await verifyPushedPR(prepared.sha);
      // A conflict-free merge request already authorizes this integration.
      // Keep the check, identity and live-base gates in finish(), without an
      // extra AI round and clone just to merge the head we have verified.
      if (operation === 'merge' && nativeSquash && !conflicts.length) {
        pushedSha = prepared.sha;
        return await finish(prepared.sha, preparedMessage, 'squash');
      }
      if (operation === 'merge' && localGitMerge && !nativeSquash) return await finishLocal(prepared.sha, finalTree);
      return { merged: false, status: 'synced', number, sha: prepared.sha, previousHeadSha: originalSha,
        base, baseSha, resolutionCommits: prepared.commits,
        reason: prepared.commits.length
          ? 'Appended per-file conflict decisions followed by the remaining base synchronization; existing PR history was retained.'
          : 'Appended a base synchronization commit with a normal fast-forward push; existing PR history was retained.' };
    }
    if (!rewriteApproved || repositoryInfo.allow_rebase_merge !== true) {
      throw Error('A history rewrite requires explicit local approval and a verified human-author necessity.');
    }
    // Rewriting any parent head would orphan or invalidate dependent PRs.
    // Even explicit rewrite approval cannot override an open PR dependency.
    await checkHeadRewriteSafety();
    progress('rewrite-approved', { description: 'Explicit local approval to preserve the original human author; incremental integration cannot produce the required squash.' });
    const messageFile = path.join(temp, '.git', 'sweetiebot-squash-message');
    await fs.writeFile(messageFile, message + '\n');
    await inRepo('-c', 'user.name=' + author.name, '-c', 'user.email=' + author.email,
      'commit', ...(requireSignedCommit ? ['-S'] : []), '--author=' + author.name + ' <' + author.email + '>', '-F', messageFile);
    if (requireSignedCommit && !/(?:^|\n)gpgsig /.test(await inRepo('cat-file', '-p', 'HEAD'))) {
      throw Error('The local Git signer did not attach a commit signature; no branch was pushed.');
    }
    const preparedSha = await inRepo('rev-parse', 'HEAD');
    const baseTree = await inRepo('rev-parse', liveBase + '^{tree}');
    const newTree = await inRepo('rev-parse', 'HEAD^{tree}');
    if (!SHA.test(preparedSha) || newTree === baseTree) throw Error('No new verified squash tree.');
    operationCommitTitle = prepared.title;
    progress('prepared', { sha: preparedSha, title: operationCommitTitle });
    // Re-read GitHub before the ONLY force-with-lease, scoped strictly to the selected head.
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title || fresh.head?.sha !== originalSha ||
        fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before guarded push; no branch was modified.');
    }
    if (await readBaseTip() !== baseSha) throw refreshBase();
    // Close the PR-dependency race immediately before the only destructive push.
    await checkHeadRewriteSafety();
    progress('pushing', { sha: preparedSha, title: operationCommitTitle });
    await inRepo('push', '--force-with-lease=refs/heads/' + head + ':' + originalSha,
      'origin', preparedSha + ':refs/heads/' + head);
    pushedSha = preparedSha;
    progress('pushed', { sha: preparedSha, title: operationCommitTitle });
    progress('verifying-push', { sha: preparedSha, title: operationCommitTitle });
    await verifyPushedPR(preparedSha);
    if (await readBaseTip() !== baseSha) throw refreshBase();
    // Native GitHub rebase merge records the same bot-opened PR as merged.
    return await finish(preparedSha, message);
  } catch (error) {
    if (error.code === 'INVALID_RESOLUTION_PATCH' && !pushedSha) {
      return { merged: false, status: 'needs_resolution', number, headSha: originalSha, baseSha,
        conflictPaths: conflicts, reason: error.message +
          ' Regenerate the complete current-base unified diff with correct hunk lengths and context. No branch was pushed.' };
    }
    if (error.code === 'MERGE_BASE_CHANGED') {
      if (pushedSha) Object.assign(error, { sha: pushedSha, previousHeadSha: originalSha });
      throw error;
    }
    if (pushedSha) throw Object.assign(error, { preparedHead: pushedSha, originalHead: originalSha });
    throw error;
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { humanSquashMerge };
