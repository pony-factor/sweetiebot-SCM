'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const { githubApi, gitCommitSigningEnabled } = require('../extension/merge/pull_request');
const { squashMergePullRequest } = require('../extension/merge/pull_request');

(async () => {
  const originalPath = process.env.PATH;
  const originalCommand = process.env.KEFANIA_GH_COMMAND;
  const spawned = [];
  let apiOutput = '{"ok":true}';
  const spawnProcess = (command, args) => {
    spawned.push({command, args});
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => {
      child.stdout.emit('data', apiOutput);
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
    apiOutput = JSON.stringify([{ body: 'Normal repository PR metadata '.repeat(20000) }]);
    assert.equal((await githubApi('repos/owner/repo/pulls?per_page=100', {}, spawnProcess)).length, 1, 'Normal PR-list responses can exceed 100 KB');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCommand === undefined) delete process.env.KEFANIA_GH_COMMAND;
    else process.env.KEFANIA_GH_COMMAND = originalCommand;
  }
  const input = {repository:'owner/repo',head:'pony',base:'main',
    result:{number:12,url:'https://github.com/owner/repo/pull/12'}};
  const pr = {html_url:input.result.url,title:'🖌️ Improve settings',state:'open',draft:false,merged_at:null,
    user:{login:'JFWooten4',type:'User'},
    head:{ref:'pony',sha:'a'.repeat(40),repo:{full_name:'owner/repo'}},
    base:{ref:'main',sha:'c'.repeat(40),repo:{full_name:'owner/repo'}}};
  const calls = [];
  const api = async (endpoint,options) => {
    calls.push([endpoint,options]);
    if(!options) {
      if(endpoint==='repos/owner/repo/branches/main') return {commit:{sha:'d'.repeat(40)}};
      if(endpoint==='repos/owner/repo/git/commits/'+'b'.repeat(40))
        return {message:'🖌️ Improve settings (#12)\n\nVerified subject'};
      if(endpoint.endsWith('/commits?per_page=100&page=1')) return [
        {author:{login:'JFWooten4',type:'User'},commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},
          message:'🖌️ Improve settings\n\nCo-authored-by: Codex Web <noreply@openai.com>'}},
        {author:{login:'JFWooten4',type:'User'},commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},
          message:'🔄 Sync brach to main\n\nKeep settings in sync.'}}
      ];
      return pr;
    }
    assert.equal(options.method,'PUT');
    assert.equal(options.body.sha,pr.head.sha);
    assert.equal(options.body.merge_method,'squash');
    assert.equal(options.body.commit_title,'🖌️ Improve settings (#12)');
    assert(options.body.commit_message.includes('- 🖌️ Improve settings'));
    assert(options.body.commit_message.includes('\n\n__________\n\n'));
    assert(!options.body.commit_message.includes('---------'));
    assert(!options.body.commit_message.includes('Sync brach to main'));
    return {merged:true,sha:'b'.repeat(40)};
  };
  assert.equal((await squashMergePullRequest(input,api)).merged,true);
  assert.equal(calls.length,7, 'PR and live base snapshots, history, merge, and landed commit');
  // Bot-opened PRs use the local commit preparation path with an exact snapshot.
  const botPR = {...pr, user:{login:'codex-pony[bot]',type:'Bot'}};
  const localCalls = [];
  const localRequest = async (endpoint, options) => {
    localCalls.push([endpoint, options]);
    if (endpoint === 'repos/owner/repo/pulls/12' && !options) return botPR;
    return api(endpoint, options);
  };
  let prepared = 0;
  const humanMerge = async (repository, number, options) => {
    prepared++;
    assert.equal(repository, input.repository);
    assert.equal(number, 12);
    assert.deepEqual(options.expected, {headSha:pr.head.sha,baseSha:'d'.repeat(40),
      head:'pony',base:'main',title:pr.title});
    assert.equal((await options.api('repos/owner/repo/pulls/12')).user.type, 'Bot');
    await options.api('repos/owner/repo/pulls/12/merge', 'PUT',
      ['-f','sha='+'e'.repeat(40),'-f','merge_method=rebase']);
    return {merged:true,sha:'b'.repeat(40),author:{name:'John Wooten'}};
  };
  // Verify the helper's write is forwarded using the button's authenticated API.
  const localTransport = async (endpoint, options) => {
    if (options) {
      assert.deepEqual(options, {method:'PUT',body:{sha:'e'.repeat(40),merge_method:'rebase'}});
      return {merged:true,sha:'b'.repeat(40)};
    }
    return localRequest(endpoint);
  };
  assert((await squashMergePullRequest(input, localTransport, {humanMerge})).merged);
  assert.equal(prepared, 1);
  for (const status of ['waiting','checks_failed','needs_resolution']) {
    await assert.rejects(squashMergePullRequest(input, localRequest, {
      humanMerge:async()=>({merged:false,status,reason:'Specific '+status})
    }), new RegExp('Specific '+status));
  }
  await assert.rejects(squashMergePullRequest(input, localRequest, {
    humanMerge:async()=>({merged:true,sha:'invalid'})
  }), /did not confirm/);
  // Explicit local signing must request a signed commit and a leased head
  // rewrite rather than silently falling back to GitHub's merge commit.
  let signedOptions;
  const signedBotTransport=async(endpoint,options)=>{
    if(endpoint==='repos/owner/repo/pulls/12'&&!options)return {...botPR,mergeable:true};
    return localTransport(endpoint,options);
  };
  const signedResult=await squashMergePullRequest(input,signedBotTransport,{
    method:'local-signed-squash',humanMerge:async(repository,number,options)=>{
      signedOptions=options;
      assert.equal(repository,'owner/repo');assert.equal(number,12);
      return {merged:true,sha:'b'.repeat(40)};
    }
  });
  assert.equal(signedResult.merged,true);
  assert.equal(signedOptions.allowHistoryRewrite,false);
  assert.equal(signedOptions.localGitMerge,true);
  assert.equal(signedOptions.rewriteReason,'');
  assert.equal(signedOptions.requireSignedCommit,true);
  assert.equal(signedOptions.offerAuthorChoice,false);
  let humanSignedOptions;
  const humanSignedResult=await squashMergePullRequest(input,async(endpoint,options)=>{
    if(endpoint==='repos/owner/repo/pulls/12'&&!options)return {...pr,mergeable:true};
    return api(endpoint,options);
  },{method:'local-signed-squash',humanMerge:async(repository,number,options)=>{
    humanSignedOptions=options;
    assert.equal(repository,'owner/repo');assert.equal(number,12);
    return {merged:true,sha:'b'.repeat(40)};
  }});
  assert.equal(humanSignedResult.merged,true,'A signed squash is available for a matching human opener too');
  assert.equal(humanSignedOptions.requireSignedCommit,true);
  assert.equal(humanSignedOptions.localGitMerge,true);

  const signingRepo=await fs.mkdtemp(path.join(os.tmpdir(),'sweetiebot-signing-config-'));
  try {
    await run('git',['init','--quiet',signingRepo]);
    assert.equal(await gitCommitSigningEnabled(signingRepo),false);
    await run('git',['-C',signingRepo,'config','commit.gpgsign','true']);
    assert.equal(await gitCommitSigningEnabled(signingRepo),true);
    let autoSignedOptions;
    const autoSignedResult=await squashMergePullRequest(input,async(endpoint,options)=>{
      if(endpoint==='repos/owner/repo/pulls/12'&&!options)return {...pr,mergeable:true};
      return api(endpoint,options);
    },{repositoryPath:signingRepo,humanMerge:async(repository,number,options)=>{
      autoSignedOptions=options;
      return {merged:true,sha:'b'.repeat(40)};
    }});
    assert.equal(autoSignedResult.merged,true);
    assert.equal(autoSignedOptions.requireSignedCommit,true,
      'The default Kefania squash action honors local commit.gpgsign=true');
  } finally { await fs.rm(signingRepo,{recursive:true,force:true}); }
  // A human opener differing from the original author uses the same local path.
  let differentAuthorPrepared = false;
  assert((await squashMergePullRequest(input, async (endpoint, options) => {
    if (endpoint === 'repos/owner/repo/pulls/12')
      return {...pr,user:{login:'another-user',type:'User'}};
    return api(endpoint, options);
  }, {humanMerge:async()=>{
    differentAuthorPrepared = true;
    return {merged:true,sha:'b'.repeat(40)};
  }})).merged);
  assert(differentAuthorPrepared);
  // PR metadata may catch up while the actual branch remains unchanged.
  let metadataReads = 0;
  assert((await squashMergePullRequest(input, async (endpoint, options) => {
    if (endpoint === 'repos/owner/repo/pulls/12' && ++metadataReads === 2)
      return {...pr, base:{...pr.base, sha:'d'.repeat(40)}};
    return api(endpoint, options);
  })).merged);
  for (const invalid of [false, true]) {
    let baseReads = 0;
    const attempts = [];
    await assert.rejects(squashMergePullRequest(input, async (endpoint, options) => {
      attempts.push([endpoint, options]);
      if (endpoint === 'repos/owner/repo/branches/main') {
        return {commit:{sha: invalid ? 'invalid' : (++baseReads === 1 ? 'd' : 'e').repeat(40)}};
      }
      return api(endpoint, options);
    }), invalid ? /Cannot verify/ : /changed before squash merge/);
    assert(!attempts.some(([, options]) => options?.method === 'PUT'));
  }
  const changedTitleCalls = [];
  let refreshed = 0;
  await assert.rejects(squashMergePullRequest(input, async (endpoint, options) => {
    changedTitleCalls.push([endpoint, options]);
    if (endpoint === 'repos/owner/repo/pulls/12' && ++refreshed === 2)
      return {...pr, title:'🖌️ Renamed settings'};
    return api(endpoint, options);
  }), /changed before squash merge/);
  assert(!changedTitleCalls.some(([, options]) => options?.method === 'PUT'));
  await assert.rejects(squashMergePullRequest(input, async (endpoint, options) => {
    if (endpoint === 'repos/owner/repo/git/commits/'+'b'.repeat(40))
      return {message:'🗣️ Original commit title'};
    return api(endpoint, options);
  }), /squash commit title differs/);
  const blockedCalls = [];
  await assert.rejects(squashMergePullRequest(input, async (endpoint, options) => {
    blockedCalls.push([endpoint, options]);
    if (endpoint === 'repos/owner/repo/branches/main') return api(endpoint, options);
    if(endpoint.endsWith('/commits?per_page=100&page=1')) return [
      {author:{login:'codex-pony[bot]',type:'Bot'},
       commit:{author:{name:'codex-pony[bot]',email:'bot@example.org'},message:'Bot-only change'}}];
    if(options?.method === 'PUT') throw Error('A native merge must not run without a person');
    return pr;
  }), /No verified original human Git author/);
  assert.equal(blockedCalls.filter(([,options]) => options?.method === 'PUT').length, 0,
    'A human PR opener without a linked human original author is not mergeable');
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
