'use strict';

const { spawn, execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { verifiedHumanAuthor } = require('./human-squash-merge');
const { humanSquashMerge } = require('./local-human-squash');
const { squashMessage, readCommits } = require('./squash-attribution');
const { configuredMergeActor } = require('../github/app-commit-identity');

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[^\\\x00-\x20\x7f]+$/;
const SHA = /^[a-f0-9]{40}$/i;

async function gitCommitSigningEnabled(directory) {
  if (typeof directory !== 'string' || !directory.trim()) return false;
  const { stdout } = await exec('git', [
    '-C', directory, 'config', '--type=bool', '--default', 'false', '--get', 'commit.gpgsign'
  ], { timeout: 5000, maxBuffer: 4096 });
  return stdout.trim() === 'true';
}

// Legacy transport when distinct App mode is disabled. Configured Lindsey
// workflows replace this transport before reading or writing the selected PR.
function githubApi(endpoint, { method = 'GET', body } = {}, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--include', '--hostname', 'github.com', '--method', method, endpoint];
    if (body !== undefined) args.push('--input', '-');
    const command = process.env.KEFANIA_GH_COMMAND ||
      ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
    const child = spawnProcess(command, args,
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Merge request timed out. Check GitHub before trying again.'));
    }, 60000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error('Unexpectedly large GitHub merge response.'));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('GitHub CLI is unavailable. Install gh; Sweetiebot uses your VS Code GitHub sign-in.')));
    child.on('close', code => {
      const response = require('../github/rate-limit').parseCLIResponse(output);
      if (code !== 0) {
        let message = stderr;
        try { message += ' ' + JSON.parse(response.body).message; } catch { /* gh can return only stderr. */ }
        const limited = require('../github/rate-limit').rateLimitError({ status: response.status || Number(stderr.match(/HTTP (\d{3})/)?.[1]) || (/rate.?limit/i.test(message) ? 403 : 0), headers: response.headers, message });
        const failure = limited || new Error('GitHub rejected the request (' + (response.status || stderr.match(/HTTP (\d{3})/)?.[1] || 'check authentication, reviews, and branch protection') + '). Check the PR before retrying.');
        failure.status = response.status || Number(stderr.match(/HTTP (\d{3})/)?.[1]);
        failure.githubMessage = String(message || '').slice(0, 500);
        return finish(failure);
      }
      try { finish(null, JSON.parse(response.body || (method === 'DELETE' ? 'null' : ''))); }
      catch { finish(new Error('GitHub returned an invalid merge response. Check the PR before retrying.')); }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// Retry only a pre-publication destination race. Revalidate the selected PR
// before every retry; a published squash or changed head is never resubmitted.
async function retryBaseAdvance(operation, { refresh, onRetry = () => {}, attempts = 3 }) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (error.code !== 'MERGE_BASE_CHANGED' || error.publishedSha || error.preparedHead ||
          error.sha || attempt >= attempts - 1) throw error;
      await refresh();
      onRetry(attempt + 1);
    }
  }
}

async function squashMergePullRequest({ repository, head, base, result }, request = githubApi,
  { humanMerge = humanSquashMerge, method = 'squash', gitToken, repositoryPath, onProgress = () => {},
    getAppActor = configuredMergeActor } = {}) {
  if (!['squash', 'merge', 'local-signed-squash'].includes(method)) throw new Error('Unknown merge method.');
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) ||
      typeof head !== 'string' || !REF.test(head) ||
      typeof base !== 'string' || !REF.test(base) ||
      !Number.isSafeInteger(result?.number) || result.number < 1 ||
      result.url !== `https://github.com/${repository}/pull/${result.number}`) {
    throw new Error('Invalid published pull-request identity; refusing to merge.');
  }
  const originalRequest = request;
  const appActor = await getAppActor(repository);
  if (appActor) { request = appActor.request; gitToken = appActor.gitToken; }
  const endpoint = `repos/${repository}/pulls/${result.number}`;
  onProgress({ stage: 'reading-pr' });
  const pr = await request(endpoint);
  if (pr.html_url !== result.url || pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      pr.head?.ref !== head || pr.base?.ref !== base) {
    throw new Error('Pull-request repository, head, or base changed; review it on GitHub before merging.');
  }
  if (pr.state !== 'open' || pr.merged_at) throw new Error('Pull request is no longer open.');
  if (pr.draft) throw new Error('Mark this pull request ready for review on GitHub before merging.');
  if (!SHA.test(pr.head.sha)) throw new Error('Cannot verify the pull-request head SHA.');
  if (!pr.user?.login || !['Bot', 'User'].includes(pr.user.type)) {
    throw new Error('Cannot verify PR opener identity; refusing a bot-authored squash.');
  }
  // Compare live branch tips, not the potentially stale PR base.sha.
  const readBaseTip = async () => {
    const branch = await request('repos/' + repository + '/branches/' + encodeURIComponent(base));
    if (!SHA.test(branch?.commit?.sha || '')) throw new Error('Cannot verify the current PR base branch tip.');
    return branch.commit.sha;
  };
  onProgress({ stage: 'checking-base' });
  let baseSha = await readBaseTip();
  if (method === 'merge') {
    onProgress({ stage: 'reading-history' });
    const info = await request('repos/' + repository);
    if (info.allow_merge_commit !== true) throw new Error('This repository does not allow merge commits.');
    // GitHub attributes the merge action to the App login, which is distinct
    // from the Lindsey Pony name/email on commits created by Sweetiebot.
    const actor = appActor ? { type: 'Bot', login: appActor.login } : await request('user');
    if (appActor && (!actor.login || !/\[bot\]$/i.test(actor.login))) {
      throw new Error('Could not verify the Lindsey App login for merge attribution.');
    }
    if (!appActor && (actor.type !== 'User' || /\[bot\]$/i.test(actor.login || ''))) throw new Error('A signed-in human account is required for this merge.');
    const commits = await readCommits(async ([url]) => request(url), repository, result.number);
    const human = verifiedHumanAuthor(commits);
    const prepared = squashMessage(pr.title, result.number, commits,
      { primaryAuthor: human.login.toLowerCase() === actor.login.toLowerCase() ? human : undefined });
    onProgress({ stage: 'reading-checks' });
    const checks = await require('./checks').readMergeChecks(path => request(path), repository, pr.head.sha);
    if (checks.state !== 'passed') throw new Error('PR checks must pass before merging while preserving commits.');
    const fresh = await request(endpoint);
    if (fresh.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== pr.title ||
        fresh.head?.sha !== pr.head.sha || fresh.head?.ref !== head || fresh.base?.ref !== base || await readBaseTip() !== baseSha) {
      throw new Error('PR or base changed before merge; refresh and review the current branch.');
    }
    onProgress({ stage: 'merging' });
    const merged = await request(endpoint + '/merge', { method: 'PUT', body: {
      sha: pr.head.sha, merge_method: 'merge', commit_title: prepared.title, commit_message: prepared.message
    } });
    if (!merged.merged || !SHA.test(merged.sha || '')) throw new Error('GitHub did not confirm the merge.');
    onProgress({ stage: 'verifying-merge' });
    const destination = await request('repos/' + repository + '/commits/' + merged.sha);
    const parents = destination.parents?.map(parent => parent.sha) || [];
    const verified = await request(endpoint);
    if (!parents.includes(baseSha) || !parents.includes(pr.head.sha) || destination.author?.login !== actor.login ||
        destination.author?.type !== actor.type || verified.merged !== true || verified.merge_commit_sha !== merged.sha) {
      throw new Error('The merge occurred, but preserved ancestry or the selected merge identity could not be verified. Inspect GitHub.');
    }
    return { merged: true, sha: merged.sha, url: result.url, number: result.number, base, method: 'merge', authorsPreserved: true };
  }

  const mergeWithHumanAuthor = async (signLocally = false) => {
    // Use the same authenticated transport as the button and bind preparation
    // to the selected PR, rather than the read-only, already-prepared helper.
    const api = (endpoint, method = 'GET', fields = []) => {
      if (method === 'GET') return request(endpoint);
      const body = {};
      for (let index = 0; index < fields.length; index += 2) {
        if (fields[index] !== '-f' || typeof fields[index + 1] !== 'string' ||
            !fields[index + 1].includes('=')) throw new Error('Invalid local merge API fields.');
        const split = fields[index + 1].indexOf('=');
        body[fields[index + 1].slice(0, split)] = fields[index + 1].slice(split + 1);
      }
      return request(endpoint, { method, body });
    };
    onProgress({ stage: 'preparing-local' });
    const landed = await retryBaseAdvance(() => humanMerge(repository, result.number, { api, gitToken, onProgress, localGitMerge: true, offerAuthorChoice: false,
      nativeAPI: require('../github/user-api').legacyAPI(originalRequest),
      getAppActor: async () => appActor,
      allowHistoryRewrite: false, rewriteReason: '', requireSignedCommit: signLocally,
      expected: { headSha: pr.head.sha, baseSha, head, base, title: pr.title } }), {
      refresh: async () => {
        const fresh = await request(endpoint);
        if (fresh.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== pr.title ||
            fresh.head?.sha !== pr.head.sha || fresh.head?.ref !== head || fresh.base?.ref !== base)
          throw Error('PR changed while refreshing the destination; no merge was retried.');
        baseSha = await readBaseTip();
      },
      onRetry: () => onProgress({ stage: 'refreshing-base' })
    });
    if (landed?.merged !== true || landed.githubMerged === false || !SHA.test(landed.sha || '')) {
      throw Object.assign(new Error(landed?.reason || 'GitHub did not confirm the merge. Check the pull request.'),
        landed?.needsAuthorChoice ? { code: 'SQUASH_AUTHOR_CHOICE_REQUIRED' } : {});
    }
    return { merged: true, sha: landed.sha, url: result.url,
      number: result.number, base, author: landed.author,
      githubMerged: landed.githubMerged, prClosed: landed.prClosed,
      headSha: landed.headSha, previousHeadSha: landed.previousHeadSha, baseSha: landed.baseSha,
      ...(landed.method ? { method: landed.method } : {}),
      ...(landed.signed ? { signed: true } : {}) };
  };
  if (method === 'local-signed-squash') {
    if (pr.mergeable !== true) throw new Error('The PR must be confirmed mergeable before starting a signed local squash.');
    return mergeWithHumanAuthor(true);
  }
  if (pr.user.type === 'Bot' || /\[bot\]$/i.test(pr.user.login)) {
    return mergeWithHumanAuthor();
  }
  onProgress({ stage: 'reading-history' });
  const originalCommits = await readCommits(async ([url]) => request(url), repository, result.number);
  const human = verifiedHumanAuthor(originalCommits);
  if (human.login.toLowerCase() !== pr.user.login.toLowerCase()) {
    return mergeWithHumanAuthor();
  }
  // Lindsey remains the authenticated merge actor. The human PR author and
  // GitHub-generated commit identity are independent of who calls the API.
  const prepared = squashMessage(pr.title, result.number, originalCommits, {primaryAuthor:human});
  const fresh = await request(endpoint);
  if (fresh.state !== 'open' || fresh.draft || fresh.merged_at ||
      fresh.title !== pr.title || fresh.head?.ref !== pr.head.ref ||
      fresh.base?.ref !== pr.base.ref || fresh.head?.sha !== pr.head.sha ||
      await readBaseTip() !== baseSha) {
    throw new Error('Pull request changed before squash merge; refresh and try again.');
  }
  onProgress({ stage: 'merging' });
  const merged = await request(endpoint + '/merge', {method: 'PUT',
    body: {sha: pr.head.sha, merge_method: 'squash',
      commit_title: prepared.title, commit_message: prepared.message}});
  if (merged.merged !== true || !SHA.test(merged.sha)) throw new Error('GitHub did not confirm the squash merge. Check the pull request.');
  onProgress({ stage: 'verifying-merge' });
  const landed = await request('repos/' + repository + '/git/commits/' + merged.sha);
  if (String(landed?.message || '').replace(/\r\n?/g, '\n').split('\n')[0] !== prepared.title) {
    throw new Error('GitHub merged the PR, but its squash commit title differs from the PR title. Verify the GitHub commit.');
  }
  return { merged: true, sha: merged.sha, url: result.url, number: result.number, base };
}

module.exports = { squashMergePullRequest, githubApi, gitCommitSigningEnabled, retryBaseAdvance };
