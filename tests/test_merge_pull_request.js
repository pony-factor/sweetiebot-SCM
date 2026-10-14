'use strict';
const assert = require('node:assert/strict');
const { squashMergePullRequest } = require('../efs/merge_pull_request');

(async () => {
  const input = {repository:'owner/repo',head:'pony',base:'main',
    result:{number:12,url:'https://github.com/owner/repo/pull/12'}};
  const pr = {html_url:input.result.url,state:'open',draft:false,merged_at:null,
    head:{ref:'pony',sha:'a'.repeat(40),repo:{full_name:'owner/repo'}},
    base:{ref:'main',repo:{full_name:'owner/repo'}}};
  const calls = [];
  const api = async (endpoint,options) => {
    calls.push([endpoint,options]);
    if(!options)return pr;
    assert.equal(options.method,'PUT');
    assert.equal(options.body.sha,pr.head.sha);
    assert.equal(options.body.merge_method,'squash');
    return {merged:true,sha:'b'.repeat(40)};
  };
  assert.equal((await squashMergePullRequest(input,api)).merged,true);
  assert.equal(calls.length,2);
  for(const [update,message] of [
    [{state:'closed'},'closed'],
    [{draft:true},'draft'],
    [{head:{...pr.head,ref:'different'}},'changed'],
    [{base:{...pr.base,ref:'develop'}},'changed'],
    [{head:{...pr.head,repo:{full_name:'different/repo'}}},'changed'],
  ]) {
    const attempts=[];
    await assert.rejects(squashMergePullRequest(input,async (...args)=>{
      attempts.push(args);return {...pr,...update};
    }),new RegExp(message,'i'));
    assert.equal(attempts.length,1,'Invalid PRs must never reach the merge endpoint');
  }
  await assert.rejects(squashMergePullRequest({...input,result:{number:12,url:'https://github.com/attacker/repo/pull/12'}},api),/identity/);
  console.log('Squash merge checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
