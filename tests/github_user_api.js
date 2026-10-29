"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {githubUserAPI, legacyAPI} = require('../extension/github/user_api');

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


test('transient reads retry with a bound, while writes and long server pauses never replay', async () => {
  for (const [method, retryAfter, expectedCalls, expectedDelay] of [['GET',null,2,500],['GET','2',2,2000],['GET','3600',1,null],['PUT',null,1,null]]) {
    let calls=0;const delays=[];
    const api=githubUserAPI('fixture-token',async()=>++calls===1?{ok:false,status:503,headers:{get:()=>retryAfter},json:async()=>({})}:{ok:true,status:200,json:async()=>({ok:true})}, {sleep:async ms=>delays.push(ms)});
    if(expectedCalls===1)await assert.rejects(api('repos/owner/repo',{method}),/HTTP 503/);
    else assert.equal((await api('repos/owner/repo',{method})).ok,true);
    assert.equal(calls,expectedCalls);assert.deepEqual(delays,expectedDelay===null?[]:[expectedDelay]);
  }
  let calls=0;
  const unavailable=githubUserAPI('fixture-token',async()=>{calls++;return {ok:false,status:502,json:async()=>({})};},{sleep:async()=>{}});
  await assert.rejects(unavailable('repos/owner/repo'),/HTTP 502/);assert.equal(calls,3);
});
