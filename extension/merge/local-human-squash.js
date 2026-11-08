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
const { splitSquashTrailers, squashMessage, readCommits } = require('./squash-attribution');
const { patchPaths, safePatchPath } = require('./patch');
const { validateResolutionHunks, applyResolutionHunks } = require('./conflict-hunks');
const { readMergeChecks, waitForMergeChecks } = require('./checks');
const { readPushedPR } = require('../github/pushed-pr');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

const { verifiedHumanAuthor, verifyCommit } = require('./human-squash-merge');
const { configuredMergeActor, commitIdentityArgs } = require('../github/app-commit-identity');
const { commitIdentity, attributedCommitTree, verifyLocalCommitIdentity } = require('./commit-signing');

async function humanSquashMerge(repository, number, {
  api, git, gitToken, expected, resolutionPatch = null, resolutionHunks = [], repairChecks = false, checkOptions = {}, decisions = [], operation = 'merge', onProgress = () => {},
  localGitMerge = false, allowHistoryRewrite = false, rewriteReason = '', offerAuthorChoice = false, requireSignedCommit = false, commitProposal,
  temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-human-squash-')),
  getAppActor = configuredMergeActor
} = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0 ||
      !expected || !SHA.test(expected.headSha || '') || !SHA.test(expected.baseSha || '')) {
    throw Error('Invalid repository or PR number.');
  }
  const appActor = await getAppActor(repository);
  if (appActor) {
    api = appActor.api;
    gitToken = appActor.gitToken;
  }
  const automationAuthor = appActor?.author;
  api ||= require('../github/user-api').legacyAPI(require('./pull-request').githubApi);
  git ||= async (...args) => {
    const credential = typeof gitToken === 'function' ? await gitToken() : gitToken;
    const env = { ...process.env, ...(credential ? { GH_TOKEN: credential, GITHUB_TOKEN: credential } : {}),
      GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
    // New local commits receive explicit identity arguments below. Inherited
    // Git environment overrides must not replace either selected identity.
    for (const key of Object.keys(env)) {
      if (/^GIT_(?:AUTHOR|COMMITTER)_/.test(key)) delete env[key];
    }
    try { return (await exec('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
    '-c', 'credential.helper=!' + gh + ' auth git-credential', ...args],
  { timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env })).stdout.trim();
    } catch (error) { throw require('../commits/git-failure').gitFailure(error, args); }
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
  resolutionHunks = validateResolutionHunks(resolutionHunks);
  const compactResolution = resolutionHunks.length > 0;
  if (compactResolution && resolutionPatch !== null) throw Error('Compact hunks and a full patch are mutually exclusive.');
  const needsResolution = resolutionPatch !== null || compactResolution;
  if (needsResolution && baseSha !== expected.baseSha) throw refreshBase();
  if (resolutionPatch !== null && (!expected || typeof resolutionPatch !== 'string' ||
      !resolutionPatch.trim() || Buffer.byteLength(resolutionPatch) > 32 * 1024 * 1024)) {
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
  // Signing preferences never authorize PR-history changes. The matching
  // human opener can use GitHub's native, branch-preserving squash even when
  // commit.gpgsign is enabled; explicit local signing uses a local squash.
  const nativeSquash = !requireSignedCommit && repositoryInfo.allow_squash_merge === true && original.user?.type === 'User' &&
    original.user.login?.toLowerCase() === verifiedAuthor.login.toLowerCase();
  decisions = require('./resolution-commits').validateDecisions(decisions);
  if (!['merge', 'sync'].includes(operation)) throw Error('Unknown local merge operation.');
  const prepared = require('./commit-proposal').validateCommitProposal(commitProposal, squashMessage(original.title, number, commits, { primaryAuthor: author }));
  progress('message-prepared', { title: prepared.title, description: prepared.message, proposed: prepared.proposed, adjusted: prepared.adjusted });
  const preparedMessage = prepared.title + '\n\n' + prepared.message;
  // Retrying after GitHub rejects pending checks or reviews must NOT rewrite
  // the same PR head again: doing so would restart checks on every click.
  const existing = commits.length === 1 ? commits[0].commit.message.replace(/\r\n/g, '\n').trimEnd() : '';
  const sections = splitSquashTrailers(existing);
  const preparedTrailers = sections.length === 2 ? sections[1].split('\n') : [];
  const validTrailers = sections.length === 2
    ? preparedTrailers.every(line => /^Co-authored-by: .+ <[^<>\s]+@[^<>\s]+>$/.test(line))
    : sections.length === 1 && !existing.split('\n').some(line => /^Co-authored-by:/i.test(line));
  const alreadyPrepared = existing.split('\n', 1)[0] === prepared.title && validTrailers &&
    !preparedTrailers.some(line => line.startsWith('Co-authored-by: ' + author.name + ' <'));
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
  if (operation === 'merge' && !needsResolution && original.mergeable === true && nativeSquash && initialChecks.state !== 'failed') {
    return finish(originalSha, preparedMessage, 'squash');
  }
  if (operation === 'merge' && alreadyPrepared && !needsResolution && !signLocally) {
    const parent = await api(endpoint + '/commits/' + originalSha);
    if (parent.parents?.length === 1 && parent.parents[0].sha === baseSha && repositoryInfo.allow_rebase_merge === true) return finish(originalSha, existing);
    // A different base requires a new integrated tree and checks, not a blind retry.
  }
  if (!localGitMerge || operation === 'sync') await checkHeadWritable();
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
    // A true squash has exactly one parent (the previous base tip). Neither
    // signing nor author preservation permits a temporary PR-head rewrite.
    const finishLocalSquash = async (finalTree, finalMessage = preparedMessage) => {
      if (operation !== 'merge') throw Error('A local squash requires a PR merge operation.');
      if (finalTree === await inRepo('rev-parse', liveBase + '^{tree}')) {
        throw Error('Squash would make no changes; refusing an empty commit.');
      }
      progress('waiting-checks', { sha: originalSha, title: prepared.title });
      const checks = await waitForMergeChecks(api, repository, originalSha, {
        ...checkOptions, expectChecks: initialChecks.hasChecks, collectEvidence: true,
        onPoll: checks => progress('checks-polled', { sha: originalSha, ...checks })
      });
      if (checks.state !== 'passed') return { merged: false, number,
        status: checks.state === 'pending' ? 'waiting' : 'checks_failed',
        sha: originalSha, previousHeadSha: originalSha, base, baseSha,
        reason: checks.state === 'pending' ? 'Waiting for PR-head checks before publication.'
          : 'Checks failed on the selected PR head: ' + checks.names.join(', ') };
      await checkBaseWritable();
      const samePR = current => current?.state === 'open' && !current.draft && !current.merged_at &&
        !current.stack && current.title === original.title && current.head?.sha === originalSha &&
        current.head?.ref === head && current.base?.ref === base;
      if (!samePR(await api(prPath)) || await readBaseTip() !== baseSha) {
        throw Error('Selected PR or base changed before local squash preparation; no branch was modified.');
      }
      let identity = await commitIdentity(inRepo, author, requireSignedCommit, true, automationAuthor);
      const messageFile = path.join(temp, '.git', 'sweetiebot-squash-message');
      await fs.writeFile(messageFile, finalMessage + '\n', { mode: 0o600 });
      const create = () => attributedCommitTree({ directory: temp, tree: finalTree,
        parents: [baseSha], messageFile, identity });
      let sha;
      try { sha = await create(); }
      catch (error) {
        if (requireSignedCommit || !identity.signed) throw error;
        identity = { author, committer: automationAuthor || author, signed: false };
        sha = await create();
      }
      const parents = (await inRepo('show', '-s', '--format=%P', sha)).trim().split(/\s+/).filter(Boolean);
      const raw = await inRepo('cat-file', '-p', sha);
      if (!SHA.test(sha) || parents.length !== 1 || parents[0] !== baseSha ||
          await inRepo('rev-parse', sha + '^{tree}') !== finalTree ||
          (identity.signed && !/(?:^|\n)gpgsig /.test(raw))) {
        throw Error('Local Git did not create a valid one-parent squash; nothing was pushed.');
      }
      await verifyLocalCommitIdentity(inRepo, sha, identity);
      const [name, email, ...body] = (await inRepo('show', '-s', '--format=%an%x00%ae%x00%B', sha)).split('\0');
      verifyCommit({ commit: { author: { name, email }, message: body.join('\0') } }, finalMessage, author);
      if (!samePR(await api(prPath)) || await readBaseTip() !== baseSha) {
        throw Error('Selected PR or base changed before local squash publication; nothing was pushed.');
      }
      await checkBaseWritable();
      progress('pushing-squash-base', { sha, title: prepared.title });
      // Ordinary fast-forward only. The source PR head is never pushed or rolled back.
      await inRepo('push', 'origin', sha + ':refs/heads/' + base);
      pushedSha = sha;
      await inRepo('fetch', '--quiet', 'origin', 'refs/heads/' + base);
      await inRepo('merge-base', '--is-ancestor', sha,
        await inRepo('rev-parse', 'refs/remotes/origin/' + base));
      const destination = await api(endpoint + '/commits/' + sha);
      verifyCommit(destination, finalMessage, author);
      const current = await api(prPath);
      if (current?.head?.sha !== originalSha || current.head?.ref !== head) {
        throw Error('Squash reached the base but the PR head changed externally; inspect the PR.');
      }
      const verified = destination?.commit?.verification?.verified === true;
      const merged = current?.merged === true && current.merge_commit_sha === sha && current.base?.ref === base;
      return { merged, status: merged ? 'merged' : 'published', sha, number, base, baseSha,
        headSha: originalSha, previousHeadSha: originalSha, author,
        method: identity.signed ? 'local-signed-squash' : 'local-squash',
        signed: identity.signed, verified,
        ...(!merged ? { reason: 'The one-parent squash reached the base without changing the PR branch, but GitHub has not marked this PR merged. Do not publish a duplicate; review and close the PR separately.' } : {}),
        url: 'https://github.com/' + repository + '/commit/' + sha };
    };
    progress('inspecting-files');
    const mergeBase = await inRepo('merge-base', liveBase, liveHead);
    if (!SHA.test(mergeBase)) throw Error('No verified common ancestor.');
    const originalFiles = (await inRepo('diff', '--name-only', '-z', mergeBase, liveHead)).split('\0').filter(Boolean).sort();
    // Check names before checking out or reading changed file contents.
    if (!originalFiles.length || originalFiles.some(name => !safePatchPath(name))) {
      throw Error('PR contains unsafe or secret-bearing paths; local execution is blocked.');
    }
    if (mergeBase === liveBase && !needsResolution) {
      if (operation === 'sync') return { merged: false, status: 'synced', number,
        sha: originalSha, previousHeadSha: originalSha, base, baseSha, unchanged: true,
        reason: 'PR branch already contains the current base; no incremental commit or push was needed.' };
      if (nativeSquash) return finish(originalSha, preparedMessage, 'squash');
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
    if (needsResolution) {
      // Determine actual conflicts independently of model-supplied metadata.
      try { await inRepo(...(compactResolution ? ['-c', 'merge.conflictStyle=merge'] : []),
        'merge', '--squash', '--no-commit', liveHead); }
      catch (error) {
        conflicts = (await inRepo('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        if (conflicts.some(name => !safePatchPath(name))) throw Error('Conflict involves an unsafe or secret-bearing path.');
      }
      if (conflicts.length && (conflicts.length !== decisions.length ||
          conflicts.some(file => !decisions.some(item => item.path === file)))) {
        return { merged: false, status: 'needs_resolution', number, headSha: originalSha, baseSha,
          conflictPaths: conflicts, reason: 'Provide a specific decision title and explanation for each conflicted file before preparing the merge.' };
      }
      if (compactResolution) {
        const actual = conflicts.slice().sort();
        const supplied = resolutionHunks.map(file => file.path).sort();
        if (!actual.length || JSON.stringify(actual) !== JSON.stringify(supplied)) {
          throw Error('Compact resolution must cover exactly the actual conflicting files.');
        }
        const isolatedRoot = await fs.realpath(temp);
        for (const file of resolutionHunks) {
          if (!originalFiles.includes(file.path) || !safePatchPath(file.path)) {
            throw Error('Compact conflict resolution attempted an unrelated or unsafe path.');
          }
          const location = path.join(temp, file.path);
          const stat = await fs.lstat(location);
          const real = await fs.realpath(location);
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024 ||
              !real.startsWith(isolatedRoot + path.sep)) {
            throw Error('Compact conflict resolution must target an ordinary bounded checked-out file.');
          }
          const source = await fs.readFile(location);
          if (source.includes(0)) throw Error('Binary conflict content cannot use compact resolutions.');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
          const resolved = applyResolutionHunks(text, file.hunks);
          await fs.writeFile(location, resolved, { encoding: 'utf8' });
          await inRepo('add', '--', file.path);
        }
        const unresolved = await inRepo('diff', '--name-only', '--diff-filter=U', '-z');
        if (unresolved) throw Error('Unresolved Git conflicts remain after compact application.');
        resolvedFiles = (await inRepo('diff', '--cached', '--name-only', '-z'))
          .split('\0').filter(Boolean).sort();
        if (resolvedFiles.some(file => !originalFiles.includes(file))) {
          throw Error('Compact resolution modified a path outside the selected pull request.');
        }
        await inRepo('diff', '--cached', '--check');
      } else {
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
      }
    } else {
      progress('integrating');
      try { await inRepo('merge', '--squash', '--no-commit', liveHead); }
      catch (error) {
        const conflicts = (await inRepo('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        if (conflicts.some(name => !safePatchPath(name))) throw Error('Conflict involves an unsafe or secret-bearing path.');
        return { merged: false, status: 'needs_resolution', number, headSha: originalSha, baseSha,
          conflictPaths: conflicts, reason: 'Resolve overlapping edits in the temporary merge tree, preserving both intentions without synchronizing the PR branch.' };
      }
    }
    // A clean integration is not a conflict resolution. Do not append main-only
    // changes or restart CI merely because the base branch advanced.
    if (operation === 'sync' && !needsResolution && !conflicts.length) {
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
    const finishLocal = async finalTree => {
      const trailer = conflicts.length
        ? require('./resolution-commits').assistantCoauthorTrailer(assistantModelNumber) : '';
      if (conflicts.length && !trailer) {
        throw Error('Model-authored conflict decisions require the active coding model number.');
      }
      const finalMessage = trailer && !preparedMessage.includes('\n' + trailer)
        ? preparedMessage.trimEnd() + '\n\n' + trailer : preparedMessage;
      return finishLocalSquash(finalTree, finalMessage);
    };
    if (operation === 'merge') {
      if (nativeSquash && !conflicts.length && !needsResolution) {
        return await finish(originalSha, preparedMessage, 'squash');
      }
      const finalTree = await inRepo('write-tree');
      const headTree = await inRepo('rev-parse', originalSha + '^{tree}');
      const runnerPath = 'scripts/ci/ci-test-runner.py';
      // Validate the runner against the base rather than accidentally skipping
      // testing when a PR deletes or replaces its integrated copy.
      const baseHasRunner = await inRepo('cat-file', '-e', liveBase + ':' + runnerPath)
        .then(() => true, () => false);
      const integratedHasRunner = await fs.stat(path.join(temp, runnerPath))
        .then(stat => stat.isFile(), () => false);
      if (baseHasRunner && !integratedHasRunner) {
        return { merged: false, status: 'blocked', number,
          sha: originalSha, previousHeadSha: originalSha, base, baseSha,
          reason: 'Integrated-tree test runner was removed or is not a regular file; refusing to skip required regression suites.' };
      }
      if (finalTree !== headTree && baseHasRunner) {
        for (const group of ['lindsey', 'github-pr']) {
          progress('testing-integration', { description: group });
          try {
            await exec('python3', [runnerPath, 'run', group],
              { cwd: temp, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          } catch (error) {
            const diagnostics = String(error.stderr || '').split(/\r?\n/)
              .filter(line => /^::error(?:\s|::)/.test(line)).slice(-4);
            const detail = (diagnostics.length ? diagnostics.join(' | ')
              : String(error.stderr || error.message).trim()).slice(-1800);
            const unavailable = error.code === 125 || error.code === 'ENOENT' ||
              error.killed === true || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            return { merged: false, status: unavailable ? 'blocked' : 'checks_failed', number,
              ...(unavailable ? { kind: 'capability' } : {}),
              sha: originalSha, previousHeadSha: originalSha, base, baseSha,
              reason: 'Integrated-tree ' + group +
                (unavailable ? ' test infrastructure unavailable: ' : ' checks failed: ') + detail };
          }
        }
      }
      return await finishLocal(finalTree);
    }
    // Synchronization remains separate and append-only. A squash never
    // updates or force-pushes the original PR head.
    const finalTree = await inRepo('write-tree');
    const sync = await require('./resolution-commits').createResolutionCommits({
      git: inRepo, directory: temp, headSha: originalSha, baseSha, finalTree,
      conflicts, decisions, author: automationAuthor || author, automationCommitter: automationAuthor, base,
      onCommit: decision => progress('decision-commit', decision)
    });
    operationCommitTitle = '🔄 Sync branch to ' + base;
    progress('sync-prepared', { sha: sync.sha, title: operationCommitTitle });
    await inRepo('merge-base', '--is-ancestor', originalSha, sync.sha);
    const fresh = await api(prPath);
    if (fresh.state !== 'open' || fresh.draft || fresh.head?.sha !== originalSha || fresh.title !== original.title ||
        fresh.head?.ref !== head || fresh.base?.ref !== base) throw Error('PR changed before branch synchronization.');
    if (await readBaseTip() !== baseSha) throw refreshBase();
    await checkHeadWritable();
    progress('pushing', { sha: sync.sha, title: operationCommitTitle });
    await inRepo('push', 'origin', sync.sha + ':refs/heads/' + head);
    pushedSha = sync.sha;
    progress('pushed', { sha: sync.sha, title: operationCommitTitle });
    progress('verifying-push', { sha: sync.sha, title: operationCommitTitle });
    await verifyPushedPR(sync.sha);
    return { merged: false, status: 'synced', number, sha: sync.sha, previousHeadSha: originalSha,
      base, baseSha, resolutionCommits: sync.commits,
      reason: sync.commits.length
        ? 'Appended per-file conflict decisions followed by remaining base synchronization; existing PR history was retained.'
        : 'Appended a base synchronization commit with a normal fast-forward push; existing PR history was retained.' };
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
    if (pushedSha) throw Object.assign(error, { publishedSha: pushedSha, originalHead: originalSha });
    throw error;
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { humanSquashMerge };
