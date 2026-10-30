'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {humanSquashMerge}=require('../extension/merge/local_human_squash');
async function fixture({protectedBase=false,rules=[],failed=false,race=false,advanceBase=false,humanOpener=false,failedOriginalOnly=false,lostAck=false,privateRepository=false,rulesUnavailable=false,rulesForbidden=false,requireSignedCommit=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lindsey-local-author-'));
  const remote=path.join(root,'remote.git'),work=path.join(root,'work');
  const author={name:'Original Human',email:'human@example.test'};
  const git=async(...args)=>(await run('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',
    '-c','user.name='+author.name,'-c','user.email='+author.email,...args])).stdout.trim();
  const inWork=(...args)=>git('-C',work,...args);
  const inRemote=(...args)=>git('--git-dir='+remote,...args);
  const pushes=[];
  const oldGlobalConfig=process.env.GIT_CONFIG_GLOBAL;
  try {
    if(requireSignedCommit) {
      await run('ssh-keygen',['-q','-t','ed25519','-N','','-C',author.email,'-f',path.join(root,'signing_key')]);
      const publicKey=(await fs.readFile(path.join(root,'signing_key.pub'),'utf8')).trim();
      const allowed=path.join(root,'allowed_signers');
      await fs.writeFile(allowed,author.email+' '+publicKey+'\n');
      const config=path.join(root,'gitconfig');
      await fs.writeFile(config,'[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tallowedSignersFile = '+allowed+'\n[user]\n\tsigningkey = '+path.join(root,'signing_key')+'\n');
      process.env.GIT_CONFIG_GLOBAL=config;
    }
    await git('init','--quiet','--bare','--initial-branch=main',remote);
    await git('init','--quiet','--initial-branch=main',work);
    await inWork('remote','add','origin',remote);
    await fs.writeFile(path.join(work,'file.txt'),'base\n');
    await inWork('add','file.txt');await inWork('commit','--quiet','-m','Base');
    let baseSha=await inWork('rev-parse','HEAD');
    await inWork('checkout','--quiet','-b','feature');
    const commits=[];
    for(const [index,text] of ['first feature\n','finished feature\n'].entries()) {
      await fs.writeFile(path.join(work,'file.txt'),text);
      await inWork('commit','--quiet','-am','✨ Feature step '+index+'\n\nCo-authored-by: Codex <noreply@openai.com>');
      const sha=await inWork('rev-parse','HEAD');
      commits.push({sha,author:{type:'User',login:'human'},commit:{author,message:await inWork('show','-s','--format=%B',sha)}});
    }
    const headSha=commits.at(-1).sha;
    if(advanceBase){
      await inWork('checkout','--quiet','main');await fs.writeFile(path.join(work,'base-only.txt'),'Retain the new base behavior\n');
      await inWork('add','base-only.txt');await inWork('commit','--quiet','-m','Advance base');baseSha=await inWork('rev-parse','HEAD');
      await inWork('checkout','--quiet','feature');
    }
    await inWork('push','--quiet','origin','main','feature');
    const branch=name=>inRemote('rev-parse','refs/heads/'+name);
    const pr=async()=>{
      const tip=await branch('main');
      const merged=tip!==baseSha && !race;
      return {state:merged?'closed':'open',merged,merged_at:merged?'2026-10-28':null,
        merge_commit_sha:merged?tip:null,title:'✨ Complete feature',mergeable:true,mergeable_state:'clean',
        user:humanOpener?{type:'User',login:'human'}:{type:'Bot',login:'automation[bot]'},head:{ref:'feature',sha:await branch('feature'),repo:{full_name:'owner/repo'}},
        base:{ref:'main',sha:tip,repo:{full_name:'owner/repo'}}};
    };
    const api=async (endpoint,method,fields=[])=>{
      if(endpoint==='repos/owner/repo')return {default_branch:'main',allow_squash_merge:true,allow_rebase_merge:true,private:privateRepository};
      if(endpoint.endsWith('/pulls/1/merge')&&method==='PUT'){
        assert(humanOpener,'Only a matching human opener uses native squash');
        const values=Object.fromEntries(fields.filter((_,i)=>i%2).map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
        assert.equal(values.merge_method,'squash');
        const mergedSha=await inRemote('commit-tree',values.sha+'^{tree}','-p',baseSha,'-m',values.commit_title+'\n\n'+values.commit_message);
        await inRemote('update-ref','refs/heads/main',mergedSha,baseSha);if(lostAck)throw Error('Merge response was lost');return {merged:true,sha:mergedSha};
      }
      if(endpoint.endsWith('/pulls/1'))return pr();
      if(endpoint.includes('/pulls/1/commits?'))return commits;
      if(endpoint.includes('/pulls?state=open&per_page=100&page='))return [];
      if(endpoint.includes('/rules/branches/')){
        if(rulesUnavailable||rulesForbidden)throw Object.assign(Error('HTTP 403'),{status:403,githubMessage:rulesUnavailable?'Upgrade to GitHub Pro or make this repository public to enable this feature.':'Resource not accessible by integration'});
        return rules;
      }
      if(endpoint.includes('/branches/')){const name=decodeURIComponent(endpoint.split('/').at(-1));return {protected:name==='main'?protectedBase:!advanceBase,commit:{sha:await branch(name)}};}
      if(endpoint.includes('/check-runs?'))return {check_runs:failed||failedOriginalOnly?[{name:'regression',status:'completed',conclusion:failed||endpoint.includes(headSha)?'failure':'success'}]:[]};
      if(endpoint.includes('/check-suites?'))return {check_suites:[]};
      if(endpoint.includes('/status?'))return {statuses:[]};
      if(endpoint.includes('/commits/')){
        const sha=endpoint.split('/').at(-1);
        const [name,email,...message]=(await inRemote('show','-s','--format=%an%x00%ae%x00%B',sha)).split('\0');
        const signed=/(?:^|\n)gpgsig /.test(await inRemote('cat-file','-p',sha));
        return {commit:{author:{name,email},message:message.join('\0'),
          verification:{verified:signed,reason:signed?'valid':'unsigned'}},
          parents:(await inRemote('show','-s','--format=%P',sha)).split(' ').map(sha=>({sha}))};
      }
      throw Error('Unexpected API write or endpoint: '+endpoint);
    };
    let competing;
    const localGit=async(...args)=>{
      if(args[0]==='clone')args[3]=remote;
      if(args.includes('push')){
        pushes.push(args);
        const lease=args.find(arg=>arg.startsWith('--force-with-lease='));
        assert(!args.includes('--force'),'Never force-push a base branch');
        if(lease) {
          assert.equal(lease,'--force-with-lease=refs/heads/feature:'+headSha);
          assert(args.at(-1).endsWith(':refs/heads/feature'),'A leased rewrite may target only the PR head');
        } else {
          assert(args.at(-1).endsWith(':refs/heads/main') || advanceBase&&args.at(-1).endsWith(':refs/heads/feature'),
            'Normal pushes target only the selected base or PR head');
        }
        if(race){competing=await inRemote('commit-tree',baseSha+'^{tree}','-p',baseSha,'-m','Concurrent base update');await inRemote('update-ref','refs/heads/main',competing,baseSha);}
      }
      return git(...args);
    };
    const action=()=>humanSquashMerge('owner/repo',1,{api,git:localGit,localGitMerge:true,requireSignedCommit,
      expected:{headSha,baseSha,head:'feature',base:'main',title:'✨ Complete feature'},
      temporaryDirectory:()=>fs.mkdtemp(path.join(root,'executor-'))});
    if(rulesForbidden||rulesUnavailable&&!privateRepository){await assert.rejects(action(),/HTTP 403/);assert.equal(pushes.length,0);}
    else if(race){await assert.rejects(action(),/rejected|fetch first|non-fast-forward/);assert.equal(await branch('main'),competing);}
    else {
      const result=await action();
      if(protectedBase||rules.length||failed){assert.equal(result.merged,false);assert.equal(pushes.length,0);assert.equal(await branch('main'),baseSha);}
      else {
        assert.equal(result.merged,true,JSON.stringify(result));
        if(requireSignedCommit) assert.equal(result.method,'local-signed-squash');
        else if(!humanOpener) assert.equal(result.method,'local-git');
        assert.equal(pushes.length,requireSignedCommit?2:humanOpener?(advanceBase?1:0):advanceBase?2:1);
        assert.equal(await inRemote('rev-parse',result.sha+'^1'),baseSha);
        if(requireSignedCommit) {
          assert.equal(await inRemote('show','-s','--format=%P',result.sha),baseSha,'A signed squash has only the base as its parent');
          assert(/(?:^|\n)gpgsig /.test(await inRemote('cat-file','-p',result.sha)),'The published squash carries a real SSH signature');
          await inRemote('verify-commit',result.sha);
          assert.equal(await branch('feature'),result.sha,'The PR head is moved to the signed squash commit before the base fast-forward');
        } else if(!humanOpener) assert.equal(await inRemote('rev-parse',result.sha+'^2'),await branch('feature'));
        if(!requireSignedCommit) await inRemote('merge-base','--is-ancestor',headSha,await branch('feature'));
        if(advanceBase)assert.equal(await inRemote('show',result.sha+':base-only.txt'),'Retain the new base behavior');
        assert.equal(await inRemote('show',result.sha+':file.txt'),'finished feature');
        assert.equal(await inRemote('show','-s','--format=%an',result.sha),author.name);
      }
    }
    if(!advanceBase)assert.equal(await branch('feature'),headSha,'The original PR head is never rewritten or synchronized unnecessarily');
  } finally {
    if(oldGlobalConfig===undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL=oldGlobalConfig;
    await fs.rm(root,{recursive:true,force:true});
  }
}
(async()=>{for(const options of [{},{protectedBase:true},{rules:[{type:'pull_request'}]},{failed:true},{race:true},{advanceBase:true},{advanceBase:true,humanOpener:true,failedOriginalOnly:true},{privateRepository:true,rulesUnavailable:true},{rulesUnavailable:true},{privateRepository:true,rulesForbidden:true},{advanceBase:true,humanOpener:true,requireSignedCommit:true}])await fixture(options);
 // Keep response-loss recovery separate from the branch-rules safety matrix.
 await fixture({humanOpener:true,lostAck:true});
 console.log('Local Git merges preserve history and human authors; signed squashes verify signatures, lease only the PR head, fast-forward unprotected bases, and respect checks and branch rules.');
})().catch(error=>{console.error(error);process.exitCode=1;});
