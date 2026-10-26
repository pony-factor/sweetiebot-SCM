"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {githubUserAPI, legacyAPI} = require('../efs/github/github_user_api');

test('squash metadata and merge requests accept repository roots and preserve the user transport', async () => {
  const calls = [];
  const api = legacyAPI(githubUserAPI('fixture-token', async (url, options) => {
    calls.push({url, ...options});
    return {ok: true, status: 200, json: async () => ({allow_squash_merge: true})};
  }));
  assert.equal((await api('repos/owner/repo')).allow_squash_merge, true);
  await api('repos/owner/repo/pulls/12/merge', 'PUT', ['-f', 'merge_method=squash']);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo');
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-token');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].body), {merge_method: 'squash'});
  for (const endpoint of ['https://evil.test/repos/owner/repo', 'repos/owner', 'repos/owner/repo?bad', 'users/owner']) {
    await assert.rejects(api(endpoint), /Invalid GitHub user API endpoint/);
  }
  assert.equal(calls.length, 2);
});

test('GitHub cooldown handling remains intact', async () => {
  const api = githubUserAPI('fixture-token', async () => ({ok:false,status:429,headers:{get:name=>name==='retry-after'?'60':null},json:async()=>({message:'API rate limit exceeded'})}));
  await assert.rejects(api('repos/owner/repo'), error => error.rateLimited === true && error.retryAt > Date.now());
});
