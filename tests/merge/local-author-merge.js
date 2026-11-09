'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {humanSquashMerge}=require('../../extension/merge/local-human-squash');
async function fixture({protectedBase=false,rules=[],failed=false,race=false,advanceBase=false,humanOpener=false,failedOriginalOnly=false,lostAck=false,privateRepository=false,rulesUnavailable=false,rulesForbidden=false,requireSignedCommit=false,conflict=false,missingSigningKey=false,githubCannotVerifySignature=false,appMode=false,syncOnly=false,protectedHead=false,dependentPR=false,closeRetry=false,localSigningEnabled=false,userGraphQL=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lindsey-local-author-'));
  const remote=path.join(root,'remote.git'),work=path.join(root,'work');
  const author={name:'Original Human',email:'human@example.test'};
  const signer={name:'Local Signer',email:'signer@example.test'};
  const bot={name:'lindsey-fixture[bot]',email:'123+lindsey-fixture[bot]@users.noreply.github.com'};
  const expectedSigner=signer;
  const git=async(...args)=>(await run('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',
    '-c','user.name='+author.name,'-c','user.email='+author.email,...args])).stdout.trim();
  const inWork=(...args)=>git('-C',work,...args);
  const inRemote=(...args)=>git('--git-dir='+remote,...args);
  const pushes=[];
  const oldGlobalConfig=process.env.GIT_CONFIG_GLOBAL;
  try {
    if(!missingSigningKey) {
      await run('ssh-keygen',['-q','-t','ed25519','-N','','-C',author.email,'-f',path.join(root,'signing_key')]);
      const publicKey=(await fs.readFile(path.join(root,'signing_key.pub'),'utf8')).trim();
      const allowed=path.join(root,'allowed_signers');
      await fs.writeFile(allowed,[author.email,signer.email,bot.email].map(email=>email+' '+publicKey).join('\n')+'\n');
      const config=path.join(root,'gitconfig');
      await fs.writeFile(config,'[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tallowedSignersFile = '+allowed+'\n[user]\n\tname = '+signer.name+'\n\temail = '+signer.email+'\n\tsigningkey = '+path.join(root,'signing_key')+'\n');
    }
    // Isolate the fixture from the developer's global Git settings. Without
    // a signer, Lindsey may publish only an explicitly unsigned fallback.
    const config=path.join(root,'gitconfig');
    if(missingSigningKey)await fs.writeFile(config,'[gpg]\n\tformat = ssh\n');
    process.env.GIT_CONFIG_GLOBAL=config;
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
      if(conflict)await fs.writeFile(path.join(work,'file.txt'),'main behavior\n');
      await inWork('add',conflict?'file.txt':'base-only.txt');await inWork('commit','--quiet','-m','Advance base');baseSha=await inWork('rev-parse','HEAD');
      await inWork('checkout','--quiet','feature');
    }
    await inWork('push','--quiet','origin','main','feature');
    const branch=name=>inRemote('rev-parse','refs/heads/'+name);
    let manuallyClosed=false, closeAttempts=0, nativeMerged=false;
    const pr=async()=>{
      const tip=await branch('main');
      // GitHub recognizes a direct push only when the PR head is included.
      // Pushing an unrelated squash to main must not fake a merged response.
      const merged=nativeMerged || tip!==baseSha && !race &&
        (humanOpener&&!appMode&&!requireSignedCommit&&!conflict || tip===await branch('feature'));
      return {node_id:'PR_fixture',state:merged||manuallyClosed?'closed':'open',merged,merged_at:merged?'2026-10-28':null,
        merge_commit_sha:merged?tip:null,title:'✨ Complete feature',mergeable:!conflict,mergeable_state:conflict?'dirty':'clean',
        user:humanOpener?{type:'User',login:'human'}:{type:'Bot',login:'automation[bot]'},head:{ref:'feature',sha:await branch('feature'),repo:{full_name:'owner/repo'}},
        base:{ref:'main',sha:tip,repo:{full_name:'owner/repo'}}};
    };
    const api=async (endpoint,method,fields=[])=>{
      if(endpoint==='graphql'){
        assert.equal(method,'POST');
        const query=fields[1];
        const value=key=>JSON.parse(query.match(new RegExp(key+':("(?:[^"\\\\]|\\\\.)*")'))[1]);
        assert.equal(value('pullRequestId'),'PR_fixture');
        assert.equal(value('authorEmail'),author.email);
        assert.equal(value('expectedHeadOid'),await branch('feature'));
        assert(query.includes('mergeMethod:SQUASH'));
        const outcome=await api('repos/owner/repo/pulls/1/merge','PUT',[
          '-f','sha='+value('expectedHeadOid'),'-f','merge_method=squash',
          '-f','commit_title='+value('commitHeadline'),'-f','commit_message='+value('commitBody')]);
        return {data:{mergePullRequest:{pullRequest:{merged:outcome.merged,mergeCommit:{oid:outcome.sha}}}}};
      }
      if(endpoint==='repos/owner/repo')return {default_branch:'main',allow_squash_merge:true,allow_rebase_merge:true,private:privateRepository};
      if(endpoint.endsWith('/pulls/1/merge')&&method==='PUT'){
        assert(humanOpener,'Only a matching human opener uses native squash');
        const values=Object.fromEntries(fields.filter((_,i)=>i%2).map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
        assert.equal(values.merge_method,'squash');
        const mergedSha=await inRemote('commit-tree',values.sha+'^{tree}','-p',baseSha,'-m',values.commit_title+'\n\n'+values.commit_message);
        await inRemote('update-ref','refs/heads/main',mergedSha,baseSha);nativeMerged=true;if(lostAck)throw Error('Merge response was lost');return {merged:true,sha:mergedSha};
      }
      if(endpoint.endsWith('/pulls/1')&&method==='PATCH') {
        assert.deepEqual(fields,['-f','state=closed']);
        assert.notEqual(await branch('main'),baseSha,'Publish before closing');
        assert.equal(await branch('feature'),headSha,'Closing must preserve the original PR head');
        if(closeRetry&&closeAttempts++===0)throw Error('Close temporarily unavailable');
        manuallyClosed=true; return pr();
      }
      if(endpoint.endsWith('/pulls/1'))return pr();
      if(endpoint.includes('/pulls/1/commits?'))return commits;
      if(endpoint.includes('/pulls?state=open&per_page=100&page='))return dependentPR?[{number:2,head:{ref:'child'},base:{ref:'feature'}}]:[];
      if(endpoint.includes('/rules/branches/')){
        if(rulesUnavailable||rulesForbidden)throw Object.assign(Error('HTTP 403'),{status:403,githubMessage:rulesUnavailable?'Upgrade to GitHub Pro or make this repository public to enable this feature.':'Resource not accessible by integration'});
        return rules;
      }
      if(endpoint.includes('/branches/')){const name=decodeURIComponent(endpoint.split('/').at(-1));return {protected:name==='main'?protectedBase:protectedHead,commit:{sha:await branch(name)}};}
      if(endpoint.includes('/check-runs?'))return {check_runs:failed||failedOriginalOnly?[{name:'regression',status:'completed',conclusion:failed||endpoint.includes(headSha)?'failure':'success'}]:[]};
      if(endpoint.includes('/check-suites?'))return {check_suites:[]};
      if(endpoint.includes('/status?'))return {statuses:[]};
      if(endpoint.includes('/commits/')){
        const sha=endpoint.split('/').at(-1);
        const [name,email,committerName,committerEmail,...message]=(await inRemote('show','-s','--format=%an%x00%ae%x00%cn%x00%ce%x00%B',sha)).split('\0');
        const signed=/(?:^|\n)gpgsig /.test(await inRemote('cat-file','-p',sha));
        return {commit:{author:{name,email},committer:{name:committerName,email:committerEmail},message:message.join('\0'),
          verification:{verified:signed&&!githubCannotVerifySignature,
            reason:!signed?'unsigned':githubCannotVerifySignature?'bad_email':'valid'}}, 
          parents:(await inRemote('show','-s','--format=%P',sha)).split(' ').map(sha=>({sha}))};
      }
      throw Error('Unexpected API write or endpoint: '+endpoint);
    };
    let competing;
    const localGit=async(...args)=>{
      if(localSigningEnabled && args.includes('config') && args.at(-1)==='commit.gpgsign')return 'true';
      if(!missingSigningKey && args.includes('config') && args.at(-1)==='user.name')return signer.name;
      if(!missingSigningKey && args.includes('config') && args.at(-1)==='user.email')return signer.email;
      if(args[0]==='clone')args[3]=remote;
      if(args.includes('push')){
        pushes.push(args);
        assert(!args.some(arg=>arg.startsWith('--force')||arg==='-f'||arg.startsWith('+')),
          'Force-pushes are forbidden on every branch');
        assert((syncOnly||conflict)&&args.at(-1).endsWith(':refs/heads/feature'),
          'Only conflict repair may append to the PR head; main is merged by GitHub');
        if(race){competing=await inRemote('commit-tree',baseSha+'^{tree}','-p',baseSha,'-m','Concurrent base update');await inRemote('update-ref','refs/heads/main',competing,baseSha);}
      }
      return git(...args);
    };
    const action=(options={})=>humanSquashMerge('owner/repo',1,{api:appMode?()=>assert.fail('App mode must not borrow the user API'):api,
      git:localGit,localGitMerge:true,requireSignedCommit,
      nativeAPI:appMode?()=>assert.fail('App merges never borrow the human native API'):userGraphQL?api:undefined,
      getAppActor:async()=>appMode?{api,gitToken:async()=> 'fixture-app-token',author:bot}:null,
      expected:{headSha,baseSha,head:'feature',base:'main',title:'✨ Complete feature'},
      publicationDirectory:path.join(root,'receipts'),
      temporaryDirectory:()=>fs.mkdtemp(path.join(root,'executor-')),...options});
    if(!syncOnly && (!humanOpener || requireSignedCommit)) {
      const blocked = await action();
      assert.equal(blocked.merged,false,'Unsupported attribution/signing must not be reported as merged');
      assert.equal(blocked.status,conflict?'needs_resolution':'blocked');
      assert.equal(await branch('main'),baseSha,'A blocked merge never publishes directly to main');
      assert.equal(await branch('feature'),headSha,'A blocked merge preserves PR history');
      assert.equal(manuallyClosed,false,'A blocked merge must never close the PR');
      assert.equal(pushes.length,0);
      return;
    }
    if(rulesForbidden||rulesUnavailable&&!privateRepository){await assert.rejects(action(),/HTTP 403/);assert.equal(pushes.length,0);}
    else if(race){await assert.rejects(action(),/rejected|fetch first|non-fast-forward|Base changed/);assert.equal(await branch('main'),competing);}
    else if(protectedBase||rules.length){await assert.rejects(action(),/protected|active branch rules/);assert.equal(pushes.length,0);}
    else {
      if(conflict){
        const pending=await action(syncOnly?{operation:'sync'}:{});
        assert.equal(pending.status,'needs_resolution','A genuine conflict requests a current-base decision');
        assert.equal(pushes.length,0,'Conflict discovery never synchronizes the PR head');
      }
      const resolutionPatch=conflict?
        'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-main behavior\n+combined feature and main\n':null;
      if(closeRetry) await assert.rejects(action(),/Close temporarily unavailable/);
      const result=await action({...(syncOnly?{operation:'sync'}:{}),...(conflict?{resolutionPatch,decisions:[{path:'file.txt',
        title:'🛠️ Preserve both behaviors',description:'Combine main behavior and the PR feature.'}],
        assistantModelNumber:'6'}:{})});
      if(syncOnly) {
        assert.equal(result.status,'synced');
        assert.equal(await branch('main'),baseSha);
        assert.equal(await branch('feature'),result.sha);
        assert.equal(await inRemote('rev-parse',result.sha+'^^'),headSha);
        for(const sha of [result.sha,result.sha+'^']) {
          assert.equal(await inRemote('show','-s','--format=%an <%ae>|%cn <%ce>',sha),
            `${bot.name} <${bot.email}>|${bot.name} <${bot.email}>`,'Both fix and sync commits belong to the App');
        }
        assert.equal(await inRemote('show','-s','--format=%an',headSha),author.name);
        assert.equal(pushes.length,1);
        return;
      }
      if(protectedBase||rules.length||failed||failedOriginalOnly){assert.equal(result.merged,false);assert.equal(pushes.length,0);assert.equal(await branch('main'),baseSha);}
      else {
        assert.equal(result.merged,true,JSON.stringify(result));
        assert.equal(pushes.length,conflict?1:0,'Only an actual conflict repair appends to the PR branch');
        if(conflict)await inRemote('merge-base','--is-ancestor',headSha,await branch('feature'));
        assert.equal(await inRemote('show','-s','--format=%P',result.sha),baseSha,
          'GitHub squash creates one commit with the selected base as its only parent');
        assert.equal((await pr()).merged,true,'A successful result requires GitHub merged state');
        if(advanceBase&&!conflict)assert.equal(await inRemote('show',result.sha+':base-only.txt'),'Retain the new base behavior');
        assert.equal(await inRemote('show',result.sha+':file.txt'),conflict?'combined feature and main':'finished feature');
        assert.equal(await inRemote('show','-s','--format=%an',result.sha),author.name);
        if(appMode) {
          const committer=author;
          assert.equal(await inRemote('show','-s','--format=%cn <%ce>',result.sha),`${committer.name} <${committer.email}>`,
            'App-authenticated squashes retain a human committer');
          assert.deepEqual(result.author,author,'Merge reports the verified human author');
          const message=await inRemote('show','-s','--format=%B',result.sha);
          assert(!message.includes(`Co-authored-by: ${author.name} <${author.email}>`),'The primary author needs no duplicate co-author trailer');
          assert(message.includes('Co-authored-by: Codex <noreply@openai.com>'),'Retain original assistant credit');
          assert.equal(await inRemote('show','-s','--format=%an',headSha),author.name,'Original human commits remain unchanged');
        }
      }
    }
    if(protectedBase||rules.length||failed||failedOriginalOnly||humanOpener&&!appMode&&!requireSignedCommit&&!conflict)assert.equal(await branch('feature'),headSha,
      'Blocked and native merges leave the original PR head untouched');
  } finally {
    if(oldGlobalConfig===undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL=oldGlobalConfig;
    await fs.rm(root,{recursive:true,force:true});
  }
}
(async()=>{for(const options of [{},{protectedBase:true},{rules:[{type:'pull_request'}]},{failed:true},{race:true},{advanceBase:true},{advanceBase:true,conflict:true},{advanceBase:true,humanOpener:true,failedOriginalOnly:true},{privateRepository:true,rulesUnavailable:true},{rulesUnavailable:true},{privateRepository:true,rulesForbidden:true},{advanceBase:true,humanOpener:true,requireSignedCommit:true},{missingSigningKey:true},{githubCannotVerifySignature:true}])await fixture(options);
 // Keep response-loss recovery separate from the branch-rules safety matrix.
 await fixture({humanOpener:true,lostAck:true});
 await fixture({humanOpener:true,userGraphQL:true,lostAck:true});
 await fixture({appMode:true});
 await fixture({appMode:true,closeRetry:true});
 await fixture({appMode:true,humanOpener:true});
 await fixture({appMode:true,humanOpener:true,localSigningEnabled:true,lostAck:true});
 await fixture({appMode:true,humanOpener:true,localSigningEnabled:true,advanceBase:true,conflict:true});
 await fixture({protectedHead:true});
 await fixture({dependentPR:true});
 await fixture({appMode:true,missingSigningKey:true});
 await fixture({appMode:true,advanceBase:true,conflict:true});
 await fixture({appMode:true,advanceBase:true,conflict:true,syncOnly:true});
 await fixture({appMode:true,advanceBase:true,humanOpener:true,requireSignedCommit:true});
 console.log('Local fallback squashes retain one base parent, human authorship, signing, credits and publication guards; explicit sync stays append-only.');
})().catch(error=>{console.error(error);process.exitCode=1;});
