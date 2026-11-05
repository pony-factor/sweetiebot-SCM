'use strict';
const assert = require('node:assert/strict');
const { registerAutoPublish } = require('../../extension/branches/auto-publish');
const tick = () => new Promise(resolve => setTimeout(resolve,650));
(async () => {
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
    enabled=false;repository.state.HEAD={name:'local',commit:'a'.repeat(40)};change();await tick();assert.equal(calls.length,3);
    console.log('Repository automatic publishing watcher checks passed.');
  } finally {context.subscriptions.forEach(item=>item.dispose()); module.resolveDefaultBranch=resolveDefaultBranch;}
})().catch(error=>{console.error(error);process.exitCode=1;});
