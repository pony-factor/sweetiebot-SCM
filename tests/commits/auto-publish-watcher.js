'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { registerAutoPublish } = require('../../extension/branches/auto-publish');
const tick = () => new Promise(resolve => setTimeout(resolve,650));
(async () => {
  const trial = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-publish-trial-'));
  const trialRoot = path.join(trial, 'repository');
  await fs.mkdir(trialRoot);
  await fs.writeFile(path.join(trial, '.sweetiebot-experiment.json'), '{}');
  const {resolveDefaultBranch} = require('../../extension/branches/actions');
  const module = require('../../extension/branches/actions');
  module.resolveDefaultBranch = async () => 'main';
  let change, open, enabled=true;
  const calls=[];
  const repository={rootUri:{fsPath:'/repo'},state:{HEAD:{name:'manual',commit:'a'.repeat(40)},remotes:[{name:'origin'}],onDidChange(fn){change=fn;return{dispose(){}};}}};
  const api={repositories:[repository],onDidOpenRepository(fn){open=fn;return{dispose(){}};},onDidCloseRepository(){return{dispose(){}};}};
  const context={subscriptions:[]};
  const vscode={extensions:{getExtension(){return{activate:async()=>({getAPI:()=>api})};}},
    workspace:{getConfiguration:()=>({get:(key,fallback)=>key==='autoPublishNewBranches'?enabled:fallback}),onDidChangeConfiguration(){return{dispose(){}};}},
    commands:{executeCommand:async(...args)=>{calls.push(args);repository.state.HEAD.upstream={remote:'origin',name:repository.state.HEAD.name};return true;}},
    window:{showWarningMessage:assert.fail}};
  try {
    await registerAutoPublish(vscode,context); await tick();
    assert.equal(calls.length,1,'A branch in a new workspace publishes without a prior branch event');
    assert.equal(calls[0][2].silentMerged, true,
      'Background publishing must not display the merged-PR recovery dialog');
    assert.equal(calls[0][2].automatic, true);
    change(); await tick(); assert.equal(calls.length,1,'Tracking branches are not republished');
    repository.state.HEAD={name:'manual-two',commit:'a'.repeat(40),upstream:{remote:'origin',name:'main'}};
    change(); await tick(); assert.equal(calls.length,2,'Inherited tracking does not suppress a new branch');
    repository.state.HEAD={name:'main',commit:'a'.repeat(40)};change();await tick();assert.equal(calls.length,2);
    module.resolveDefaultBranch=async()=>assert.fail('Empty/local-only repositories must not resolve a remote default branch');
    repository.state.HEAD={name:'title-startup'};change();await tick();
    assert.equal(calls.length,2,'Unborn branches are not published');
    repository.state.HEAD={name:'local-only',commit:'a'.repeat(40)};repository.state.remotes=[];change();await tick();
    assert.equal(calls.length,2,'Repositories without the publish remote are skipped');
    module.resolveDefaultBranch=async ()=>'main';repository.state.remotes=[{name:'origin'}];
    change();await tick();assert.equal(calls.length,3,'Adding the publish remote enables publishing');
    repository.rootUri = { fsPath: trialRoot };
    repository.state.HEAD = { name: 'trial-12345678', commit: 'a'.repeat(40) };
    change();await tick();assert.equal(calls.length,3,'Existing trial workspaces never auto-publish with the preference enabled');
    repository.state.HEAD = { name: 'renamed-experiment', commit: 'a'.repeat(40) };
    change();await tick();assert.equal(calls.length,3,'Renaming a trial branch does not enable automatic publishing');
    await fs.unlink(path.join(trial, '.sweetiebot-experiment.json'));
    repository.state.HEAD = { name: 'trial-87654321', commit: 'a'.repeat(40) };
    change();await tick();assert.equal(calls.length,4,'A normal workspace is not excluded merely by its branch name');
    enabled=false;repository.state.HEAD={name:'local',commit:'a'.repeat(40)};change();await tick();assert.equal(calls.length,4);
    console.log('Repository automatic publishing watcher checks passed.');
  } finally {context.subscriptions.forEach(item=>item.dispose()); module.resolveDefaultBranch=resolveDefaultBranch;await fs.rm(trial,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
