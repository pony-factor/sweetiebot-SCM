'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {humanSquashMerge}=require('../extension/merge/local_human_squash');
async function fixture({protectedBase=false,rules=[],failed=false,race=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lindsey-local-author-'));
  const remote=path.join(root,'remote.git'),work=path.join(root,'work');
  const author={name:'Original Human',email:'human@example.test'};
  const git=async(...args)=>(await run('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',
    '-c','user.name='+author.name,'-c','user.email='+author.email,...args])).stdout.trim();
  const inWork=(...args)=>git('-C',work,...args);
  const inRemote=(...args)=>git('--git-dir='+remote,...args);
  const pushes=[];
  try {
    await git('init','--quiet','--bare','--initial-branch=main',remote);
    await git('init','--quiet','--initial-branch=main',work);
    await inWork('remote','add','origin',remote);
    await fs.writeFile(path.join(work,'file.txt'),'base\n');
    await inWork('add','file.txt');await inWork('commit','--quiet','-m','Base');
    const baseSha=await inWork('rev-parse','HEAD');
    await inWork('checkout','--quiet','-b','feature');
    const commits=[];
    for(const [index,text] of ['first feature\n','finished feature\n'].entries()) {
      await fs.writeFile(path.join(work,'file.txt'),text);
      await inWork('commit','--quiet','-am','✨ Feature step '+index+'\n\nCo-authored-by: Codex <noreply@openai.com>');
      const sha=await inWork('rev-parse','HEAD');
      commits.push({sha,author:{type:'User',login:'human'},commit:{author,message:await inWork('show','-s','--format=%B',sha)}});
    }
    const headSha=commits.at(-1).sha;
    await inWork('push','--quiet','origin','main','feature');
    const branch=name=>inRemote('rev-parse','refs/heads/'+name);
    const pr=async()=>{
      const tip=await branch('main');
      const merged=tip!==baseSha && !race;
      return {state:merged?'closed':'open',merged,merged_at:merged?'2026-10-28':null,
        merge_commit_sha:merged?tip:null,title:'✨ Complete feature',mergeable:true,mergeable_state:'clean',
        user:{type:'Bot',login:'automation[bot]'},head:{ref:'feature',sha:await branch('feature'),repo:{full_name:'owner/repo'}},
        base:{ref:'main',sha:tip,repo:{full_name:'owner/repo'}}};
    };
    const api=async endpoint=>{
      if(endpoint==='repos/owner/repo')return {default_branch:'main',allow_squash_merge:true,allow_rebase_merge:true};
      if(endpoint.endsWith('/pulls/1'))return pr();
      if(endpoint.includes('/pulls/1/commits?'))return commits;
      if(endpoint.includes('/rules/branches/'))return rules;
      if(endpoint.includes('/branches/')){const name=decodeURIComponent(endpoint.split('/').at(-1));return {protected:name==='main'?protectedBase:true,commit:{sha:await branch(name)}};}
      if(endpoint.includes('/check-runs?'))return {check_runs:failed?[{name:'regression',status:'completed',conclusion:'failure'}]:[]};
      if(endpoint.includes('/check-suites?'))return {check_suites:[]};
      if(endpoint.includes('/status?'))return {statuses:[]};
      if(endpoint.includes('/commits/')){
        const sha=endpoint.split('/').at(-1);
        const [name,email,...message]=(await inRemote('show','-s','--format=%an%x00%ae%x00%B',sha)).split('\0');
        return {commit:{author:{name,email},message:message.join('\0')},parents:(await inRemote('show','-s','--format=%P',sha)).split(' ').map(sha=>({sha}))};
      }
      throw Error('Unexpected API write or endpoint: '+endpoint);
    };
    let competing;
    const localGit=async(...args)=>{
      if(args[0]==='clone')args[3]=remote;
      if(args.includes('push')){
        pushes.push(args);assert(!args.some(arg=>arg.startsWith('--force')));
        assert(args.at(-1).endsWith(':refs/heads/main'),'Only the destination receives a new commit');
        if(race){competing=await inRemote('commit-tree',baseSha+'^{tree}','-p',baseSha,'-m','Concurrent base update');await inRemote('update-ref','refs/heads/main',competing,baseSha);}
      }
      return git(...args);
    };
    const action=()=>humanSquashMerge('owner/repo',1,{api,git:localGit,localGitMerge:true,
      expected:{headSha,baseSha,head:'feature',base:'main',title:'✨ Complete feature'},
      temporaryDirectory:()=>fs.mkdtemp(path.join(root,'executor-'))});
    if(race){await assert.rejects(action(),/rejected|fetch first|non-fast-forward/);assert.equal(await branch('main'),competing);}
    else {
      const result=await action();
      if(protectedBase||rules.length||failed){assert.equal(result.merged,false);assert.equal(pushes.length,0);assert.equal(await branch('main'),baseSha);}
      else {
        assert.equal(result.merged,true,JSON.stringify(result));assert.equal(result.method,'local-git');assert.equal(pushes.length,1);
        assert.equal(await inRemote('rev-parse',result.sha+'^1'),baseSha);
        assert.equal(await inRemote('rev-parse',result.sha+'^2'),headSha);
        assert.equal(await inRemote('show',result.sha+':file.txt'),'finished feature');
        assert.equal(await inRemote('show','-s','--format=%an',result.sha),author.name);
      }
    }
    assert.equal(await branch('feature'),headSha,'The original PR head is never rewritten or synchronized unnecessarily');
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
(async()=>{for(const options of [{},{protectedBase:true},{rules:[{type:'pull_request'}]},{failed:true},{race:true}])await fixture(options);
 console.log('Local Git merge preserves original heads and human authors, verifies ancestry, respects rules/checks and rejects destination races.');
})().catch(error=>{console.error(error);process.exitCode=1;});
