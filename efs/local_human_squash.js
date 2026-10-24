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
const { SQUASH_SEPARATOR, squashMessage, readCommits } = require('./squash_attribution');
const { patchPaths, safePatchPath } = require('./merge_patch');
const { readMergeChecks, waitForMergeChecks } = require('./merge_checks');
const { readPushedPR } = require('./pushed_pr');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

const { verifiedHumanAuthor, verifyCommit } = require('./human_squash_merge');

async function humanSquashMerge(repository, number, {
  api, git, gitToken, expected, resolutionPatch = null, checkOptions = {}, decisions = [], operation = 'merge', onProgress = () => {},
  allowHistoryRewrite = false, rewriteReason = '', offerAuthorChoice = false, commitProposal,
  temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-human-squash-'))
} = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0 ||
      !expected || !SHA.test(expected.headSha || '') || !SHA.test(expected.baseSha || '')) {
    throw Error('Invalid repository or PR number.');
  }
  api ||= require('./github_user_api').legacyAPI(require('./merge_pull_request').githubApi);
  git ||= async (...args) => {
    try { return (await exec('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
    '-c', 'credential.helper=!' + gh + ' auth git-credential', ...args],
  { timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...(gitToken ? { GH_TOKEN: gitToken } : {}), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } })).stdout.trim();
    } catch { throw Error('Local Git operation failed; no file contents are included in this report.'); }
  };
  const endpoint = 'repos/' + repository;
  const progress = (stage, detail = {}) => {
    try { onProgress({ number, stage, ...detail }); } catch { /* Display failures cannot change Git execution. */ }
  };
  progress('preparing', { description: expected.explanation });
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
  const verifiedAuthor = verifiedHumanAuthor(commits);
  const author = { name: verifiedAuthor.name, email: verifiedAuthor.email };
  const nativeSquash = repositoryInfo.allow_squash_merge === true && original.user?.type === 'User' &&
    original.user.login?.toLowerCase() === verifiedAuthor.login.toLowerCase();
  const rewriteApproved = allowHistoryRewrite === true && rewriteReason === 'preserve-human-author' && !nativeSquash;
  if (offerAuthorChoice && operation === 'merge' && resolutionPatch === null && original.mergeable === true && !nativeSquash &&
      !allowHistoryRewrite && commits.length > 1) {
    return { merged: false, status: 'blocked', needsAuthorChoice: true, number, base, baseSha,
      reason: 'This PR has no merge conflict. It was opened by a bot or a different account, so GitHub’s native squash would assign the wrong Git author. Choose Merge preserving commits to retain the original commits without rebasing or rewriting history. A single human-authored squash would require a separately approved history rewrite.' };
  }
  decisions = require('./resolution_commits').validateDecisions(decisions);
  if (!['merge', 'sync'].includes(operation)) throw Error('Unknown local merge operation.');
  const prepared = require('./merge_commit_proposal').validateCommitProposal(commitProposal, squashMessage(original.title, number, commits, { primaryAuthor: author }));
  progress('message-prepared', { title: prepared.title, description: prepared.message, proposed: prepared.proposed, adjusted: prepared.adjusted });
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
  const initialChecks = await readMergeChecks(api, repository, originalSha);
  const finish = async (sha, expected, method = 'rebase') => {
    progress('waiting-checks', { sha });
    const checks = await waitForMergeChecks(api, repository, sha, {
      ...checkOptions, expectChecks: initialChecks.hasChecks
    });
    if (checks.state !== 'passed') return { merged: false, status: checks.state === 'pending' ? 'waiting' : 'checks_failed',
      sha, previousHeadSha: originalSha, base, baseSha, number, author,
      reason: checks.state === 'pending' ? 'Waiting for checks on the integrated PR head'
        : 'Checks failed on the integrated PR head: ' + checks.names.join(', ') };
    progress('checks-passed', { sha });
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title || fresh.head?.sha !== sha ||
        fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before GitHub merge; inspect the updated head and base.');
    }
    if (await readBaseTip() !== baseSha) throw Object.assign(refreshBase(), { sha, previousHeadSha: originalSha });
    progress('merging', { sha });
    const outcome = await api(prPath + '/merge', 'PUT',
      ['-f', 'sha=' + sha, '-f', 'merge_method=' + method,
        ...(method === 'squash' ? ['-f', 'commit_title=' + prepared.title, '-f', 'commit_message=' + prepared.message] : [])]);
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
  if (operation === 'merge' && alreadyPrepared && resolutionPatch === null) {
    const parent = await api(endpoint + '/commits/' + originalSha);
    if (parent.parents?.length === 1 && parent.parents[0].sha === baseSha && repositoryInfo.allow_rebase_merge === true) return finish(originalSha, existing);
    // A different base requires a new integrated tree and checks, not a blind retry.
  }
  await checkHeadIsolation();
  let temp, pushedSha;
  try { await git('check-ref-format', '--branch', base); await git('check-ref-format', '--branch', head); }
  catch { throw Error('Invalid Git branch name.'); }
  try {
    temp = await temporaryDirectory();
    const remote = 'https://github.com/' + repository + '.git';
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
    const mergeBase = await inRepo('merge-base', liveBase, liveHead);
    if (!SHA.test(mergeBase)) throw Error('No verified common ancestor.');
    const originalFiles = (await inRepo('diff', '--name-only', '-z', mergeBase, liveHead)).split('\0').filter(Boolean).sort();
    // Check names before checking out or reading changed file contents.
    if (!originalFiles.length || originalFiles.some(name => !safePatchPath(name))) {
      throw Error('PR contains unsafe or secret-bearing paths; local execution is blocked.');
    }
    if (mergeBase === liveBase && resolutionPatch === null) {
      if (operation === 'sync') return { merged: false, status: 'synced', number,
        sha: originalSha, previousHeadSha: originalSha, base, baseSha,
        reason: 'PR branch already contains the current base; no incremental commit or push was needed.' };
      if (nativeSquash) return finish(originalSha, preparedMessage, 'squash');
      if (!rewriteApproved) return { merged: false, status: 'blocked', number,
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
    let resolvedFiles, conflicts = [];
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
      resolvedFiles = patchPaths(resolutionPatch, numstat, originalFiles);
      const missing = requiredFiles.filter(name => !resolvedFiles.includes(name));
      if (missing.some(name => conflicts.includes(name))) {
        throw Error('Resolution patch must cover every conflicted PR file.');
      }
      // Keep Git's clean integration for PR files outside the supplied patch.
      // This diff is generated from the isolated three-way index, never from
      // the old PR tree, which could discard newer base changes.
      let supplementalFile;
      if (missing.length) {
        const supplemental = await inRepo('diff', '--cached', '--binary', liveBase, '--', ...missing);
        if (supplemental) {
          supplementalFile = path.join(temp, '.git', 'sweetiebot-clean-integration.patch');
          await fs.writeFile(supplementalFile, supplemental + '\n', { mode: 0o600 });
          const stat = await inRepo('apply', '--numstat', '-z', '--', supplementalFile);
          resolvedFiles = [...resolvedFiles, ...patchPaths(supplemental, stat, originalFiles)].sort();
        }
      }
      await inRepo('reset', '--hard', liveBase);
      const baseEntries = await inRepo('ls-tree', '-z', liveBase, '--', ...resolvedFiles);
      if (baseEntries.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))) {
        throw Error('Resolution patches cannot modify existing symlinks or submodules.');
      }
      progress('applying-resolution');
      await inRepo('apply', '--check', '--index', '--', patchFile);
      await inRepo('apply', '--index', '--', patchFile);
      if (supplementalFile) {
        await inRepo('apply', '--check', '--index', '--', supplementalFile);
        await inRepo('apply', '--index', '--', supplementalFile);
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
    const staged = await inRepo('diff', '--cached', '--name-only', '-z');
    if (!staged.trim()) throw Error('Squash would make no changes; refusing empty commit.');
    // No unexpected base-only or unrelated file changes may enter this commit.
    const proposedFiles = staged.split('\0').filter(Boolean).sort();
    if (proposedFiles.some(name => !originalFiles.includes(name)) ||
        (resolvedFiles && JSON.stringify(proposedFiles) !== JSON.stringify(resolvedFiles))) {
      throw Error('The squash changes a different file set than the PR; inspect conflicts manually.');
    }
    if (operation === 'sync' || conflicts.length || nativeSquash || !rewriteApproved) {
      const finalTree = await inRepo('write-tree');
      const prepared = await require('./resolution_commits').createResolutionCommits({
        git: inRepo, directory: temp, headSha: originalSha, baseSha, finalTree,
        conflicts, decisions, author, base,
        onCommit: decision => progress('decision-commit', decision)
      });
      progress('sync-prepared', { sha: prepared.sha });
      // The PR history is append-only. No reference on main is updated here.
      await inRepo('merge-base', '--is-ancestor', originalSha, prepared.sha);
      const fresh = await api(prPath);
      if (fresh.state !== 'open' || fresh.draft || fresh.head?.sha !== originalSha || fresh.title !== original.title ||
          fresh.head?.ref !== head || fresh.base?.ref !== base) throw Error('PR changed before branch synchronization.');
      if (await readBaseTip() !== baseSha) throw refreshBase();
      await checkHeadIsolation();
      // An exact-head lease plus the ancestry check above guarantees this is
      // an append-only update, including if someone rewinds the remote ref.
      await inRepo('push', 'origin', prepared.sha + ':refs/heads/' + head);
      pushedSha = prepared.sha;
      progress('pushed', { sha: prepared.sha });
      progress('verifying-push', { sha: prepared.sha });
      await verifyPushedPR(prepared.sha);
      // A conflict-free merge request already authorizes this integration.
      // Keep the check, identity and live-base gates in finish(), without an
      // extra AI round and clone just to merge the head we have verified.
      if (operation === 'merge' && nativeSquash && !conflicts.length) {
        pushedSha = prepared.sha;
        return await finish(prepared.sha, preparedMessage, 'squash');
      }
      return { merged: false, status: 'synced', number, sha: prepared.sha, previousHeadSha: originalSha,
        base, baseSha, resolutionCommits: prepared.commits,
        reason: prepared.commits.length
          ? 'Appended per-file conflict decisions followed by the remaining base synchronization; existing PR history was retained.'
          : 'Appended a base synchronization commit with a normal fast-forward push; existing PR history was retained.' };
    }
    if (!rewriteApproved || repositoryInfo.allow_rebase_merge !== true) {
      throw Error('A history rewrite requires explicit local approval and a verified human-author necessity.');
    }
    progress('rewrite-approved', { description: 'Explicit local approval to preserve the original human author; incremental integration cannot produce the required squash.' });
    const messageFile = path.join(temp, '.git', 'sweetiebot-squash-message');
    await fs.writeFile(messageFile, message + '\n');
    await inRepo('-c', 'user.name=' + author.name, '-c', 'user.email=' + author.email,
      'commit', '--author=' + author.name + ' <' + author.email + '>', '-F', messageFile);
    const preparedSha = await inRepo('rev-parse', 'HEAD');
    const baseTree = await inRepo('rev-parse', liveBase + '^{tree}');
    const newTree = await inRepo('rev-parse', 'HEAD^{tree}');
    if (!SHA.test(preparedSha) || newTree === baseTree) throw Error('No new verified squash tree.');
    progress('prepared', { sha: preparedSha });
    // Re-read GitHub before the ONLY force-with-lease, scoped strictly to the selected head.
    const fresh = await api(prPath);
    if (fresh?.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== original.title || fresh.head?.sha !== originalSha ||
        fresh.base?.ref !== base ||
        fresh.head?.ref !== head || fresh.stack) {
      throw Error('PR changed before guarded push; no branch was modified.');
    }
    if (await readBaseTip() !== baseSha) throw refreshBase();
    // Close the PR-dependency race between the first preflight and this push.
    await checkHeadIsolation();
    await inRepo('push', '--force-with-lease=refs/heads/' + head + ':' + originalSha,
      'origin', preparedSha + ':refs/heads/' + head);
    pushedSha = preparedSha;
    progress('pushed', { sha: preparedSha });
    progress('verifying-push', { sha: preparedSha });
    await verifyPushedPR(preparedSha);
    if (await readBaseTip() !== baseSha) throw refreshBase();
    // Native GitHub rebase merge records the same bot-opened PR as merged.
    return await finish(preparedSha, message);
  } catch (error) {
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
