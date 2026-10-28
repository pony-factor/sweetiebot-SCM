'use strict';
const assert = require('node:assert/strict');
const { registerAutoPublish } = require('../extension/branches/auto_publish');
const tick = () => new Promise(resolve => setTimeout(resolve,650));
(async () => {
  const {resolveDefaultBranch} = require('../extension/branches/actions');
  const module = require('../extension/branches/actions');
  module.resolveDefaultBranch = async () => 'main';
  let change, open, enabled=true;
  const calls=[];
  const repository={rootUri:{fsPath:'/repo'},state:{HEAD:{name:'manual'},onDidChange(fn){change=fn;return{dispose(){}};}}};
  const api={repositories:[repository],onDidOpenRepository(fn){open=fn;return{dispose(){}};},onDidCloseRepository(){return{dispose(){}};}};
  const context={subscriptions:[]};
  const vscode={extensions:{getExtension(){return{activate:async()=>({getAPI:()=>api})};}},
    workspace:{getConfiguration:()=>({get:(key,fallback)=>key==='autoPublishNewBranches'?enabled:fallback}),onDidChangeConfiguration(){return{dispose(){}};}},
    commands:{executeCommand:async(...args)=>{calls.push(args);repository.state.HEAD.upstream={remote:'origin',name:repository.state.HEAD.name};return true;}},
    window:{showWarningMessage:assert.fail}};
  try {
    await registerAutoPublish(vscode,context); await tick();
    assert.equal(calls.length,1,'A branch in a new workspace publishes without a prior branch event');
    change(); await tick(); assert.equal(calls.length,1,'Tracking branches are not republished');
    repository.state.HEAD={name:'manual-two',upstream:{remote:'origin',name:'main'}};
    change(); await tick(); assert.equal(calls.length,2,'Inherited tracking does not suppress a new branch');
    repository.state.HEAD={name:'main'};change();await tick();assert.equal(calls.length,2);
    enabled=false;repository.state.HEAD={name:'local'};change();await tick();assert.equal(calls.length,2);
    console.log('Repository automatic publishing watcher checks passed.');
  } finally {context.subscriptions.forEach(item=>item.dispose()); module.resolveDefaultBranch=resolveDefaultBranch;}
})().catch(error=>{console.error(error);process.exitCode=1;});
