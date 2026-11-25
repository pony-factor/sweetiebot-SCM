'use strict';

// Preserve PR history: ordinary local squashes publish one destination commit;
// Lindsey's assisted merges retain GitHub-confirmed merge finalization.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { splitSquashTrailers, squashMessage, readCommits } = require('./squash-attribution');
const { inspectResolutionPatch, safePatchPath } = require('./patch');
const { validateResolutionHunks, applyResolutionHunks } = require('./conflict-hunks');
const { readMergeChecks, waitForMergeChecks, describeMergeChecks } = require('./checks');
const { readPushedPR } = require('../github/pushed-pr');

const exec = promisify(execFile);
const SHA = /^[a-f\d]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

const { verifiedHumanAuthor, verifyCommit } = require('./human-squash-merge');
const { configuredMergeActor } = require('../github/app-commit-identity');
const { signingEnabled, commitIdentity, attributedCommitTree, verifyLocalCommitIdentity } = require('./commit-signing');

async function humanSquashMerge(repository, number, {
  api, nativeAPI, git, gitToken, expected, resolutionPatch = null, resolutionHunks = [], repairChecks = false, checkOptions = {}, decisions = [], operation = 'merge', onProgress = () => {},
  localGitMerge = false, allowHistoryRewrite = false, rewriteReason = '', offerAuthorChoice = false, requireSignedCommit = false, commitProposal,
  directLocal = false, repositoryPath,
  publicationDirectory = path.join(os.homedir(), '.sweetiebot', 'local-squash-receipts'),
  temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-human-squash-')),
  getAppActor = configuredMergeActor
} = {}) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number <= 0 ||
      !expected || !SHA.test(expected.headSha || '') || !SHA.test(expected.baseSha || '')) {
    throw Error('Invalid repository or PR number.');
  }
  const appActor = directLocal ? null : await getAppActor(repository);
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
  decisions = require('./resolution-commits').validateDecisions(decisions);
  const compactResolution = resolutionHunks.length > 0;
  const baseOnlyResolution = operation === 'sync' && !compactResolution && resolutionPatch === null &&
    decisions.length > 0 && decisions.every(item => item.keepBase);
  if (decisions.some(item => item.keepBase) && (operation !== 'sync' || compactResolution)) {
    throw Error('Keeping the exact incoming file requires a full branch-sync resolution.');
  }
  if (compactResolution && resolutionPatch !== null) throw Error('Compact hunks and a full patch are mutually exclusive.');
  const needsResolution = resolutionPatch !== null || compactResolution || baseOnlyResolution;
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
  const commits = await readCommits(async ([url]) => api(url), repository, number);
  if (commits.at(-1)?.sha && commits.at(-1).sha !== originalSha) {
    throw Error('Original commit history does not match the selected PR head.');
  }
  const verifiedAuthor = verifiedHumanAuthor(commits);
  const author = { name: verifiedAuthor.name, email: verifiedAuthor.email };
  // commit.gpgsign configures locally created commits. It does not require a
  // server-generated GitHub squash to use the local key. An explicitly chosen
  // local-signer operation still cannot be replaced with a native merge.
  const signLocally = requireSignedCommit;
  // A native squash uses the PR opener as Git author. For Kefania PRs,
  // preserve the verified human credit in the commit's author trailers.
  const kefaniaOpener = original.user?.type === 'Bot' &&
    original.user.login?.toLowerCase() === 'kefania-pony[bot]';
  // Installation-scoped repository reads can omit administrative merge settings.
  // Only an explicit false disables this route; GitHub's merge endpoint still
  // enforces the repository setting, checks and branch protection.
  const nativeSquash = !directLocal && !signLocally && repositoryInfo.allow_squash_merge !== false &&
    (kefaniaOpener || (original.user?.type === 'User' &&
      original.user.login?.toLowerCase() === verifiedAuthor.login.toLowerCase()));
  decisions = require('./resolution-commits').validateDecisions(decisions);
  if (!['merge', 'sync'].includes(operation)) throw Error('Unknown local merge operation.');
  const primaryAuthor = kefaniaOpener && nativeSquash && operation === 'merge' ? undefined : author;
  const prepared = require('./commit-proposal').validateCommitProposal(commitProposal,
    squashMessage(original.title, number, commits, { primaryAuthor }));
  progress('message-prepared', { title: prepared.title, description: prepared.message, proposed: prepared.proposed, adjusted: prepared.adjusted });
  const preparedMessage = prepared.title + '\n\n' + prepared.message;
  const receiptPath = path.join(publicationDirectory, repository.replace('/', '--') + '-' + number + '.json');
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
  const initialChecks = await readMergeChecks(api, repository, originalSha, { collectEvidence: directLocal });
  if (repairChecks && (resolutionPatch === null || initialChecks.state !== 'failed')) {
    throw Error('A check repair requires a complete patch and confirmed failing checks on the selected head.');
  }
  let additionalFiles = [];
  const finish = async (sha, expected, method = 'rebase') => {
    const creditAsCoauthor = method === 'squash' && kefaniaOpener;
    progress('waiting-checks', { sha, title: operationCommitTitle });
    const checks = await waitForMergeChecks(api, repository, sha, {
      ...checkOptions, expectChecks: initialChecks.hasChecks, collectEvidence: true,
      onPoll: checks => progress('checks-polled', { sha, ...checks })
    });
    if (checks.state !== 'passed') return { merged: false, additionalFiles, status: checks.state === 'pending' ? 'waiting' : 'checks_failed',
      sha, previousHeadSha: originalSha, base, baseSha, number, author, githubChecks: true,
      reason: describeMergeChecks(checks) };
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
      if (method === 'squash' && nativeAPI && !appActor && !creditAsCoauthor) {
        if (typeof original.node_id !== 'string' || !original.node_id) throw Error('Missing GitHub PR node ID; refusing an unbound merge.');
        const input = { pullRequestId: original.node_id, expectedHeadOid: sha,
          authorEmail: author.email, commitHeadline: prepared.title, commitBody: prepared.message };
        const fields = Object.entries(input).map(([key,value]) => key + ':' + JSON.stringify(value)).join(',');
        const response = await nativeAPI('graphql', 'POST', ['-f',
          'query=mutation { mergePullRequest(input:{' + fields + ',mergeMethod:SQUASH}) { pullRequest { merged mergeCommit { oid } } } }']);
        if (response?.errors?.length) throw Error('GitHub GraphQL: ' + response.errors.map(error => error.message).join('; '));
        const merged = response?.data?.mergePullRequest?.pullRequest;
        outcome = {merged:merged?.merged === true,sha:merged?.mergeCommit?.oid};
      } else outcome = await api(prPath + '/merge', 'PUT',
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
    if (creditAsCoauthor) {
      if (destination.parents?.length !== 1) throw Error('GitHub merged the PR, but the squash ancestry could not be verified.');
      verifyCommit(destination, expected, undefined, { authorLogin: original.user.login, allowBot: true });
    } else {
      verifyCommit(destination, expected, author);
    }
    const merged = await api(prPath);
    if (!merged.merged || merged.base?.ref !== base || merged.merge_commit_sha !== outcome.sha) {
      throw Error('PR merge bookkeeping or target was not verified; inspect GitHub.');
    }
    return { merged: true, additionalFiles, status: 'merged', githubMerged: true, method, sha: outcome.sha, headSha: sha, previousHeadSha: originalSha,
      author, base, baseSha, number,
      url: 'https://github.com/' + repository + '/commit/' + outcome.sha };
  };
  // GitHub can squash a clean PR without a preliminary sync.
  if (operation === 'merge' && !needsResolution && original.mergeable === true && nativeSquash && initialChecks.state !== 'failed') {
    return finish(originalSha, preparedMessage, 'squash');
  }
  if (!directLocal && operation === 'merge' && alreadyPrepared && !needsResolution && !signLocally && !appActor) {
    const parent = await api(endpoint + '/commits/' + originalSha);
    if (parent.parents?.length === 1 && parent.parents[0].sha === baseSha && repositoryInfo.allow_rebase_merge === true) return finish(originalSha, existing);
    // A different base requires a new integrated tree and checks, not a blind retry.
  }
  // Discover real conflicts even if final merge attribution is unavailable.
  // Otherwise the automatic branch-only repair queue never receives them.
  if (!directLocal && operation === 'merge' && !nativeSquash && original.mergeable === true && !needsResolution) return {
    merged: false, status: 'blocked', number, headSha: originalSha, base, baseSha,
    reason: 'A genuine GitHub squash merge cannot satisfy the required human attribution and signing with the current PR opener or authentication. No commit was published, no branch was rewritten, and no PR was closed.'
  };
  const checkBaseWritable = async () => {
    const branch = await api(endpoint + '/branches/' + encodeURIComponent(base));
    if (branch.protected !== false) throw Error('The base branch is protected; local Git cannot bypass its merge policy.');
    if (branch.commit?.sha !== baseSha) throw refreshBase();
    let rules;
    try { rules = await api(endpoint + '/rules/branches/' + encodeURIComponent(base)); }
    catch (error) {
      if (!(repositoryInfo.private === true && error.status === 403 &&
          /^Upgrade to GitHub Pro or make this repository public to enable this feature\.?$/i.test(error.githubMessage || ''))) throw error;
      rules = [];
    }
    if (!Array.isArray(rules) || rules.length) throw Error('The base has active branch rules; local Git will not bypass them.');
  };
  const localCheckBlocker = checks => ({ merged: false, number, additionalFiles,
    status: checks.state === 'pending' ? 'waiting' : 'checks_failed', sha: originalSha, base, baseSha,
    githubChecks: true, reason: describeMergeChecks(checks) });
  if (directLocal && operation === 'merge') {
    // A durable pre-push receipt prevents duplicate publication on retry.
    const receipt = await fs.readFile(receiptPath, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (receipt) {
      if (!SHA.test(receipt.sha || '') || !SHA.test(receipt.baseSha || '') ||
          !SHA.test(receipt.tree || '') || receipt.headSha !== originalSha || receipt.base !== base ||
          receipt.message !== preparedMessage) throw Error('A previous local squash receipt needs manual reconciliation; no new squash was attempted.');
      const sha = receipt.sha;
      try {
        if (sha !== baseSha) {
          const compare = await api(endpoint + '/compare/' + sha + '...' + baseSha);
          if (!['ahead', 'identical'].includes(compare?.status)) throw Error('Previous squash is not an ancestor of the destination.');
        }
        const destination = await api(endpoint + '/commits/' + sha);
        verifyCommit(destination, receipt.message, author, { committer: receipt.committer });
        if (destination.parents?.length !== 1 || destination.parents[0].sha !== receipt.baseSha ||
            destination.commit?.tree?.sha !== receipt.tree) throw Error('Previous squash ancestry or tree differs.');
        const verified = destination.commit?.verification?.verified === true;
        const current = await api(prPath);
        const githubMerged = (!receipt.signed || verified) && current?.merged === true &&
          current.merge_commit_sha === sha && current.head?.sha === originalSha && current.base?.ref === base;
        return { merged: githubMerged, githubMerged, published: true, status: githubMerged ? 'merged' : 'published',
          sha, number, base, baseSha: receipt.baseSha, headSha: originalSha, previousHeadSha: originalSha, author,
          method: receipt.signed ? 'local-signed-squash' : 'local-squash', signed: receipt.signed, verified,
          reason: receipt.signed && !verified ? 'Previous squash is published, but GitHub has not verified its signature.'
            : (!githubMerged ? 'Previous squash is already published; GitHub has not marked the PR merged.' : undefined),
          url: 'https://github.com/' + repository + '/commit/' + sha };
      } catch (error) {
        throw Object.assign(Error('Previous squash ' + sha + ' needs manual reconciliation before retrying: ' + error.message), { publishedSha: sha });
      }
    }
    const policyBlocked = original.mergeable !== true ||
      (original.mergeable_state && !['clean', 'unstable'].includes(original.mergeable_state));
    if (initialChecks.state === 'failed' || (policyBlocked && initialChecks.state === 'pending')) {
      return localCheckBlocker(initialChecks);
    }
    if (policyBlocked) {
      throw Error('The PR must be confirmed mergeable with no outstanding merge policy blocker.');
    }
    await checkBaseWritable();
  }
  if (operation === 'sync') await checkHeadWritable();
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
    const finishLocalSquash = async finalTree => {
      if (!directLocal) return { merged: false, additionalFiles, status: 'blocked', number,
        headSha: originalSha, base, baseSha,
        reason: 'Cannot complete a genuine GitHub squash merge with the required human attribution and signing under the current authentication. No squash was pushed and no PR was closed. PR branch history must not be rewritten.' };
      if (finalTree === await inRepo('rev-parse', liveBase + '^{tree}')) {
        throw Error('Squash would make no changes; refusing empty commit.');
      }
      const checks = await waitForMergeChecks(api, repository, originalSha, {
        ...checkOptions, expectChecks: initialChecks.hasChecks, collectEvidence: true,
        onPoll: checks => progress('checks-polled', { sha: originalSha, ...checks })
      });
      if (checks.state !== 'passed') return localCheckBlocker(checks);
      const samePR = current => current?.state === 'open' && !current.draft && !current.merged_at &&
        !current.stack && current.mergeable === true &&
        (!current.mergeable_state || ['clean', 'unstable'].includes(current.mergeable_state)) &&
        current.title === original.title && current.head?.sha === originalSha &&
        current.head?.ref === head && current.base?.ref === base;
      if (!samePR(await api(prPath))) throw Error('Selected PR changed before local squash; nothing was pushed.');
      await checkBaseWritable();
      // The isolated checkout must use the selected workspace's effective signing
      // configuration, not a different checkout's or an App's signing identity.
      if (repositoryPath) {
        for (const key of ['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign',
          'gpg.format', 'gpg.program', 'gpg.openpgp.program', 'gpg.x509.program',
          'gpg.ssh.program', 'gpg.ssh.allowedSignersFile', 'gpg.ssh.revocationFile', 'gpg.ssh.defaultKeyCommand']) {
          const value = await git('-C', repositoryPath, 'config', '--get', key).catch(error => {
            if (error.code === 1 || error.exitCode === 1 || /(?:exit(?: code)?|exited with code) 1\b/i.test(error.message)) return '';
            throw error;
          });
          if (value) {
            const isRelativePath = (key === 'user.signingkey' && /^(?:\.\.?\/|~\/)/.test(value)) ||
              /allowedSignersFile|revocationFile/.test(key);
            const configured = isRelativePath && !path.isAbsolute(value)
              ? (value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(repositoryPath, value)) : value;
            await inRepo('config', '--local', key, configured);
          }
        }
      }
      const signed = requireSignedCommit || await signingEnabled(inRepo);
      let identity;
      if (signed) identity = await commitIdentity(inRepo, author, true);
      else {
        const name = await inRepo('config', '--get', 'user.name');
        const email = await inRepo('config', '--get', 'user.email');
        identity = { author, committer: { name, email }, signed: false };
      }
      const messageFile = path.join(temp, '.git', 'sweetiebot-squash-message');
      await fs.writeFile(messageFile, preparedMessage + '\n', { mode: 0o600 });
      const sha = await attributedCommitTree({ directory: temp, tree: finalTree,
        parents: [baseSha], messageFile, identity });
      if (!SHA.test(sha) || await inRepo('show', '-s', '--format=%P', sha) !== baseSha ||
          await inRepo('rev-parse', sha + '^{tree}') !== finalTree) {
        throw Error('Local Git did not create the intended one-parent squash; nothing was pushed.');
      }
      await verifyLocalCommitIdentity(inRepo, sha, identity);
      const [name, email, ...body] = (await inRepo('show', '-s', '--format=%an%x00%ae%x00%B', sha)).split('\0');
      verifyCommit({ commit: { author: { name, email }, message: body.join('\0') } }, preparedMessage, author);
      if (!samePR(await api(prPath))) throw Error('Selected PR changed before publication; nothing was pushed.');
      await checkBaseWritable();
      await fs.mkdir(publicationDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(receiptPath, JSON.stringify({ sha, base, baseSha, headSha: originalSha, tree: finalTree,
        message: preparedMessage, committer: identity.committer, signed }), { mode: 0o600, flag: 'wx' });
      progress('pushing-squash-base', { sha, title: prepared.title });
      // A failed acknowledgement may still mean a successful push. Never retry
      // a possibly published commit; reconcile against the remote ancestry.
      let pushError;
      try { await inRepo('push', 'origin', sha + ':refs/heads/' + base); }
      catch (error) { pushError = error; }
      try {
        await inRepo('fetch', '--quiet', 'origin', 'refs/heads/' + base);
        await inRepo('merge-base', '--is-ancestor', sha, await inRepo('rev-parse', 'refs/remotes/origin/' + base));
      } catch (error) {
        throw Object.assign(Error('Local squash ' + sha + ' has an uncertain push result. Inspect the destination before retrying: ' + (pushError || error).message), { publishedSha: sha });
      }
      pushedSha = sha;
      let verified = false, githubMerged = false, reason;
      try {
        const destination = await api(endpoint + '/commits/' + sha);
        verifyCommit(destination, preparedMessage, author, { committer: identity.committer });
        if (destination.parents?.length !== 1 || destination.parents[0].sha !== baseSha ||
            destination.commit?.tree?.sha !== finalTree) {
          throw Error('GitHub returned different squash ancestry or tree.');
        }
        verified = destination.commit?.verification?.verified === true;
        if (signed && !verified) throw Error('GitHub has not verified the local signature.');
        const current = await api(prPath);
        githubMerged = current?.merged === true && current.merge_commit_sha === sha &&
          current.head?.sha === originalSha && current.head?.ref === head && current.base?.ref === base;
      } catch (error) { reason = error.message; }
      return { merged: githubMerged, githubMerged, published: true, status: githubMerged ? 'merged' : 'published',
        sha, number, base, baseSha, headSha: originalSha, previousHeadSha: originalSha, author, additionalFiles,
        method: signed ? 'local-signed-squash' : 'local-squash', signed, verified,
        reason: reason || (!githubMerged ? 'The squash is published; GitHub has not confirmed the PR as merged. Do not publish again.' : undefined),
        url: 'https://github.com/' + repository + '/commit/' + sha };
    };
    progress('inspecting-files');
    const mergeBase = await inRepo('merge-base', liveBase, liveHead);
    if (!SHA.test(mergeBase)) throw Error('No verified common ancestor.');
    const originalFiles = (await inRepo('diff', '--no-renames', '--name-only', '-z', mergeBase, liveHead)).split('\0').filter(Boolean).sort();
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
    let supportingDecisionFiles = [];
    if (needsResolution) {
      // Determine actual conflicts independently of model-supplied metadata.
      try { await inRepo(...(compactResolution ? ['-c', 'merge.conflictStyle=merge'] : []),
        'merge', '--squash', '--no-commit', liveHead); }
      catch (error) {
        conflicts = (await inRepo('diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        if (conflicts.some(name => !safePatchPath(name))) throw Error('Conflict involves an unsafe or secret-bearing path.');
      }
      if (conflicts.length && ((operation !== 'sync' || compactResolution) && conflicts.length !== decisions.length ||
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
        resolvedFiles = (await inRepo('diff', '--cached', '--no-renames', '--name-only', '-z'))
          .split('\0').filter(Boolean).sort();
        if (resolvedFiles.some(file => !originalFiles.includes(file))) {
          throw Error('Compact resolution modified a path outside the selected pull request.');
        }
        await inRepo('diff', '--cached', '--check');
      } else {
      const patchFile = path.join(temp, '.git', 'sweetiebot-resolution.patch');
      resolvedFiles = [];
      if (!baseOnlyResolution) {
        await fs.writeFile(patchFile, resolutionPatch, { mode: 0o600 });
        resolvedFiles = await inspectResolutionPatch(resolutionPatch, patchFile, inRepo);
      }
      const keptBase = new Set(decisions.filter(item => item.keepBase).map(item => item.path));
      if ([...keptBase].some(name => !conflicts.includes(name) || resolvedFiles.includes(name)) ||
          conflicts.some(name => !keptBase.has(name) && !resolvedFiles.includes(name))) {
        const reason = 'Resolve every conflicted file in the patch or explicitly keep the incoming file unchanged.';
        if (operation === 'sync') {
          return { merged: false, status: 'needs_resolution', number, headSha: originalSha, baseSha,
            conflictPaths: conflicts, reason };
        }
        throw Error(reason);
      }
      if (operation === 'sync') supportingDecisionFiles = resolvedFiles.filter(name => !conflicts.includes(name));
      if (decisions.some(item => !conflicts.includes(item.path) && !supportingDecisionFiles.includes(item.path))) {
        throw Error('A supporting-file decision must match a file edited by the approved patch.');
      }
      const missing = requiredFiles.filter(name => !resolvedFiles.includes(name) && !keptBase.has(name));
      // Keep Git's clean integration for PR files outside the supplied patch.
      // This diff is generated from the isolated three-way index, never from
      // the old PR tree, which could discard newer base changes.
      const cleanEntries = [];
      if (missing.length) {
        const changed = (await inRepo('diff', '--cached', '--no-renames', '--name-only', '-z', liveBase, '--', ...missing))
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
      if (!baseOnlyResolution) {
        await inRepo('apply', '--check', '--index', '--', patchFile);
        await inRepo('apply', '--index', '--', patchFile);
      }
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
    const staged = await inRepo('diff', '--cached', '--no-renames', '--name-only', '-z');
    if (!staged.trim() && !baseOnlyResolution) throw Error('Squash would make no changes; refusing empty commit.');
    // Additional supporting files are allowed when explicitly supplied by the
    // resolution patch. Keep the staged tree bound to that validated patch.
    const proposedFiles = staged.split('\0').filter(Boolean).sort();
    if (proposedFiles.some(name => !safePatchPath(name) ||
          (!originalFiles.includes(name) && !resolvedFiles?.includes(name))) ||
        (resolvedFiles && JSON.stringify(proposedFiles) !== JSON.stringify(resolvedFiles))) {
      throw Error('The integration changes a different file set than the validated resolution; inspect conflicts manually.');
    }
    additionalFiles = proposedFiles.filter(name => !originalFiles.includes(name));
    if (additionalFiles.length) progress('additional-files', { additionalFiles });
    const finishLocal = async finalTree => finishLocalSquash(finalTree);
    // Publish a one-parent squash without altering the original PR branch.
    if (operation === 'merge' && (!nativeSquash || (!conflicts.length && !needsResolution))) {
      const finalTree = await inRepo('write-tree');
      if (nativeSquash && !conflicts.length && !needsResolution) {
        return await finish(originalSha, preparedMessage, 'squash');
      }
      const headTree = await inRepo('rev-parse', originalSha + '^{tree}');
      if (finalTree !== headTree && await fs.stat(path.join(temp,
        'scripts', 'ci', 'ci-test-runner.py')).then(s => s.isFile()).catch(() => false)) {
        // Exercise the integrated tree's regression suites when this repository
        // provides them; a failure must stop publication before any push.
        for (const group of ['lindsey', 'github-pr']) {
          progress('testing-integration', { description: group });
          try {
            await exec('python3', ['scripts/ci/ci-test-runner.py', 'run', group],
              { cwd: temp, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          } catch (error) {
            return { merged: false, additionalFiles, status: 'checks_failed', number,
              sha: originalSha, previousHeadSha: originalSha, base, baseSha,
              reason: 'Integrated-tree ' + group + ' checks failed: ' +
                String(error.stderr || error.message).slice(-1800) };
          }
        }
      }
      return await finishLocal(finalTree);
    }
    {
      const finalTree = await inRepo('write-tree');
      const prepared = await require('./resolution-commits').createResolutionCommits({
        git: inRepo, directory: temp, headSha: originalSha, baseSha, finalTree,
        conflicts, decisions, supportingFiles: supportingDecisionFiles,
        author: automationAuthor || author, automationCommitter: automationAuthor, base,
        onCommit: decision => progress('decision-commit', decision)
      });
      if (prepared.unchanged) {
        return { merged: false, status: 'synced', unchanged: true, number,
          sha: originalSha, previousHeadSha: originalSha, base, baseSha,
          reason: 'The integrated tree already matches the PR head. No empty sync commit or push was created.' };
      }
      const lastCategory = prepared.commits.at(-1);
      operationCommitTitle = lastCategory?.sha === prepared.sha ? lastCategory.title : '🔄 Sync branch to ' + base;
      progress('sync-prepared', { sha: prepared.sha, title: operationCommitTitle });
      // The PR history is append-only. No reference on main is updated here.
      await inRepo('merge-base', '--is-ancestor', originalSha, prepared.sha);
      const fresh = await api(prPath);
      if (fresh.state !== 'open' || fresh.draft || fresh.head?.sha !== originalSha || fresh.title !== original.title ||
          fresh.head?.ref !== head || fresh.base?.ref !== base) throw Error('PR changed before branch synchronization.');
      if (await readBaseTip() !== baseSha) throw refreshBase();
      await checkHeadWritable();
      // The ancestry check and ordinary push preserve the PR branch history.
      progress('pushing', { sha: prepared.sha, title: operationCommitTitle });
      await inRepo('push', 'origin', prepared.sha + ':refs/heads/' + head);
      pushedSha = prepared.sha;
      progress('pushed', { sha: prepared.sha, title: operationCommitTitle });
      progress('verifying-push', { sha: prepared.sha, title: operationCommitTitle });
      await verifyPushedPR(prepared.sha);
      if (operation === 'merge' && nativeSquash) return finish(prepared.sha, preparedMessage, 'squash');
      return { merged: false, additionalFiles, status: 'synced', number, sha: prepared.sha, previousHeadSha: originalSha,
        base, baseSha, resolutionCommits: prepared.commits,
        reason: prepared.commits.length
          ? 'Appended related conflict-repair categories and recorded incoming ancestry without empty commits; existing PR history was retained.'
          : 'Appended a base synchronization commit with a normal fast-forward push; existing PR history was retained.' };
    }
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
    if (pushedSha) throw Object.assign(error, directLocal ? { publishedSha: pushedSha, originalHead: originalSha } : { preparedHead: pushedSha, originalHead: originalSha });
    throw error;
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { humanSquashMerge };
