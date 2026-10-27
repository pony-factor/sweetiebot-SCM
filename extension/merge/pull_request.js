'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { verifiedHumanAuthor } = require('./human_squash_merge');
const { humanSquashMerge } = require('./local_human_squash');
const { squashMessage, readCommits } = require('./squash_attribution');

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[^\\\x00-\x20\x7f]+$/;
const SHA = /^[a-f0-9]{40}$/i;

// VS Code callers provide the signed-in user's transport; local handoffs
// inherit that same session through GH_TOKEN, never the PR-creation bot.
// GitHub applies repository permissions, reviews, and branch protection.
function githubApi(endpoint, { method = 'GET', body } = {}, spawnProcess = spawn) {
  // Preserve /user and every merge write under gh's human authentication.
  if (method === 'GET' && spawnProcess === spawn &&
      /^repos\/[\w.-]+\/[\w.-]+(?:[/?]|$)/.test(endpoint) &&
      require('../github/app_identity').separateAppsEnabled()) {
    const repository = endpoint.split('/').slice(1, 3).join('/');
    const readFetch = require('../github/read_api').createLindseyReadFetch(repository);
    return require('../github/user_api').githubUserAPI('unused-user-token', readFetch)(endpoint);
  }
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
      const response = require('../github/rate_limit').parseCLIResponse(output);
      if (code !== 0) {
        let message = stderr;
        try { message += ' ' + JSON.parse(response.body).message; } catch { /* gh can return only stderr. */ }
        const limited = require('../github/rate_limit').rateLimitError({ status: response.status || Number(stderr.match(/HTTP (\d{3})/)?.[1]) || (/rate.?limit/i.test(message) ? 403 : 0), headers: response.headers, message });
        return finish(limited || new Error('GitHub rejected the request (' + (response.status || stderr.match(/HTTP (\d{3})/)?.[1] || 'check authentication, reviews, and branch protection') + '). Check the PR before retrying.'));
      }
      try { finish(null, JSON.parse(response.body || (method === 'DELETE' ? 'null' : ''))); }
      catch { finish(new Error('GitHub returned an invalid merge response. Check the PR before retrying.')); }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function squashMergePullRequest({ repository, head, base, result }, request = githubApi,
  { humanMerge = humanSquashMerge, method = 'squash', gitToken } = {}) {
  if (!['squash', 'merge', 'local-signed-squash'].includes(method)) throw new Error('Unknown merge method.');
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) ||
      typeof head !== 'string' || !REF.test(head) ||
      typeof base !== 'string' || !REF.test(base) ||
      !Number.isSafeInteger(result?.number) || result.number < 1 ||
      result.url !== `https://github.com/${repository}/pull/${result.number}`) {
    throw new Error('Invalid published pull-request identity; refusing to merge.');
  }
  const endpoint = `repos/${repository}/pulls/${result.number}`;
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
  const baseSha = await readBaseTip();
  if (method === 'merge') {
    const info = await request('repos/' + repository);
    if (info.allow_merge_commit !== true) throw new Error('This repository does not allow merge commits.');
    const actor = await request('user');
    if (actor.type !== 'User' || /\[bot\]$/i.test(actor.login || '')) throw new Error('A signed-in human account is required for this merge.');
    const commits = await readCommits(async ([url]) => request(url), repository, result.number);
    const human = verifiedHumanAuthor(commits);
    const prepared = squashMessage(pr.title, result.number, commits,
      { primaryAuthor: human.login.toLowerCase() === actor.login.toLowerCase() ? human : undefined });
    const checks = await require('./checks').readMergeChecks(path => request(path), repository, pr.head.sha);
    if (checks.state !== 'passed') throw new Error('PR checks must pass before merging while preserving commits.');
    const fresh = await request(endpoint);
    if (fresh.state !== 'open' || fresh.draft || fresh.merged_at || fresh.title !== pr.title ||
        fresh.head?.sha !== pr.head.sha || fresh.head?.ref !== head || fresh.base?.ref !== base || await readBaseTip() !== baseSha) {
      throw new Error('PR or base changed before merge; refresh and review the current branch.');
    }
    const merged = await request(endpoint + '/merge', { method: 'PUT', body: {
      sha: pr.head.sha, merge_method: 'merge', commit_title: prepared.title, commit_message: prepared.message
    } });
    if (!merged.merged || !SHA.test(merged.sha || '')) throw new Error('GitHub did not confirm the merge.');
    const destination = await request('repos/' + repository + '/commits/' + merged.sha);
    const parents = destination.parents?.map(parent => parent.sha) || [];
    const verified = await request(endpoint);
    if (!parents.includes(baseSha) || !parents.includes(pr.head.sha) || destination.author?.login !== actor.login ||
        destination.author?.type !== 'User' || verified.merged !== true || verified.merge_commit_sha !== merged.sha) {
      throw new Error('The merge occurred, but preserved ancestry or human attribution could not be verified. Inspect GitHub.');
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
    const landed = await humanMerge(repository, result.number, { api, gitToken, offerAuthorChoice: !signLocally,
      allowHistoryRewrite: signLocally, rewriteReason: signLocally ? 'preserve-human-author' : '', requireSignedCommit: signLocally,
      expected: { headSha: pr.head.sha, baseSha, head, base, title: pr.title } });
    if (landed?.merged !== true || !SHA.test(landed.sha || '')) {
      throw Object.assign(new Error(landed?.reason || 'GitHub did not confirm the merge. Check the pull request.'),
        landed?.needsAuthorChoice ? { code: 'SQUASH_AUTHOR_CHOICE_REQUIRED' } : {});
    }
    return { merged: true, sha: landed.sha, url: result.url,
      number: result.number, base, author: landed.author };
  };
  if (method === 'local-signed-squash') {
    if (pr.mergeable !== true) throw new Error('The PR must be confirmed mergeable before starting a signed local squash.');
    const originalCommits = await readCommits(async ([url]) => request(url), repository, result.number);
    const human = verifiedHumanAuthor(originalCommits);
    if (pr.user.type === 'User' && human.login.toLowerCase() === pr.user.login.toLowerCase()) {
      throw new Error('This PR already has a matching human opener; use the normal squash option without rewriting the PR branch.');
    }
    return mergeWithHumanAuthor(true);
  }
  if (pr.user.type === 'Bot' || /\[bot\]$/i.test(pr.user.login)) {
    return mergeWithHumanAuthor();
  }
  const originalCommits = await readCommits(async ([url]) => request(url), repository, result.number);
  const human = verifiedHumanAuthor(originalCommits);
  if (human.login.toLowerCase() !== pr.user.login.toLowerCase()) {
    return mergeWithHumanAuthor();
  }
  const prepared = squashMessage(pr.title, result.number, originalCommits);
  const fresh = await request(endpoint);
  if (fresh.state !== 'open' || fresh.draft || fresh.merged_at ||
      fresh.title !== pr.title || fresh.head?.ref !== pr.head.ref ||
      fresh.base?.ref !== pr.base.ref || fresh.head?.sha !== pr.head.sha ||
      await readBaseTip() !== baseSha) {
    throw new Error('Pull request changed before squash merge; refresh and try again.');
  }
  const merged = await request(endpoint + '/merge', {method: 'PUT',
    body: {sha: pr.head.sha, merge_method: 'squash',
      commit_title: prepared.title, commit_message: prepared.message}});
  if (merged.merged !== true || !SHA.test(merged.sha)) throw new Error('GitHub did not confirm the squash merge. Check the pull request.');
  const landed = await request('repos/' + repository + '/git/commits/' + merged.sha);
  if (String(landed?.message || '').replace(/\r\n?/g, '\n').split('\n')[0] !== prepared.title) {
    throw new Error('GitHub merged the PR, but its squash commit title differs from the PR title. Verify the GitHub commit.');
  }
  return { merged: true, sha: merged.sha, url: result.url, number: result.number, base };
}

module.exports = { squashMergePullRequest, githubApi };
