'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync } = require('node:fs');
const { githubApi } = require('../efs/merge_pull_request');
const { squashMergePullRequest } = require('../efs/merge_pull_request');

(async () => {
  const originalPath = process.env.PATH;
  const originalCommand = process.env.KEFANIA_GH_COMMAND;
  const spawned = [];
  const spawnProcess = (command, args) => {
    spawned.push({command, args});
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => {
      child.stdout.emit('data', '{"ok":true}');
      child.emit('close', 0);
    });
    return child;
  };
  try {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    delete process.env.KEFANIA_GH_COMMAND;
    assert.equal((await githubApi('user', {}, spawnProcess)).ok, true);
    assert.equal(spawned[0].command,
      ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh',
      'GUI launch PATH must not hide Homebrew GitHub CLI');
    process.env.KEFANIA_GH_COMMAND = '/custom/bin/gh';
    await githubApi('user', {}, spawnProcess);
    assert.equal(spawned[1].command, '/custom/bin/gh', 'Explicit CLI override wins');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCommand === undefined) delete process.env.KEFANIA_GH_COMMAND;
    else process.env.KEFANIA_GH_COMMAND = originalCommand;
  }
  const input = {repository:'owner/repo',head:'pony',base:'main',
    result:{number:12,url:'https://github.com/owner/repo/pull/12'}};
  const pr = {html_url:input.result.url,state:'open',draft:false,merged_at:null,
    user:{login:'JFWooten4',type:'User'},
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
    [{state:'closed'},'no longer open'],
    [{draft:true},'ready for review'],
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
