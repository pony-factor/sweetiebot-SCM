'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[^\\\x00-\x20\x7f]+$/;
const SHA = /^[a-f0-9]{40}$/i;

// The merge runs under the user's existing gh login, not the PR-creation bot.
// GitHub applies repository permissions, reviews, and branch protection.
function githubApi(endpoint, { method = 'GET', body } = {}, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
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
      if (output.length > 100000) {
        child.kill();
        finish(new Error('Unexpectedly large GitHub merge response.'));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('GitHub CLI is unavailable. Install gh and authenticate with gh auth login.')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('GitHub rejected the merge (' +
        (stderr.match(/HTTP (\d{3})/)?.[1] || 'check authentication, reviews, and branch protection') + '). Check the PR before retrying.'));
      try { finish(null, JSON.parse(output)); }
      catch { finish(new Error('GitHub returned an invalid merge response. Check the PR before retrying.')); }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function squashMergePullRequest({ repository, head, base, result }, request = githubApi) {
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
  const merged = await request(endpoint + '/merge', {method: 'PUT',
    body: {sha: pr.head.sha, merge_method: 'squash'}});
  if (merged.merged !== true || !SHA.test(merged.sha)) throw new Error('GitHub did not confirm the squash merge. Check the pull request.');
  return { merged: true, sha: merged.sha, url: result.url, number: result.number, base };
}

module.exports = { squashMergePullRequest, githubApi };
