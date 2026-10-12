'use strict';
const assert = require('node:assert/strict');
const { installPullRequestRefresh } = require('../efs/github_pr_refresh');
async function main() {
  const originalNow=Date.now, originalSet=global.setInterval, originalClear=global.clearInterval;
  const previous=global.__sweetiebotGitHubPrRefreshError;
  let now=1000000, seconds=120, enabled=true, calls=0, error, tick, delay, focus, configChanged;
  const owner={listeners:[],_register(item){this.listeners.push(item);}};
  const view={visible:true,onDidChangeVisibility:()=>({dispose(){}})};
  const vscode={
    window:{state:{focused:true},onDidChangeWindowState:fn=>{focus=fn;return {dispose(){}};}},
    workspace:{getConfiguration:()=>({get:(key,fallback)=>key==='pullRequestAutoRefresh'?enabled:key==='pullRequestRefreshIntervalSeconds'?seconds:fallback}),
      onDidChangeConfiguration:fn=>{configChanged=fn;return {dispose(){}};}},
    commands:{registerCommand:()=>({dispose(){}}),executeCommand:()=>{calls++;return error?Promise.reject(error):Promise.resolve();}}
  };
  Date.now=()=>now;
  global.setInterval=(fn,ms)=>{tick=fn;delay=ms;return 1;};
  global.clearInterval=()=>{};
  try {
    installPullRequestRefresh(vscode,view,owner);
    await Promise.resolve();
    assert.equal(calls,1);assert.equal(delay,120000);
    focus();await Promise.resolve();assert.equal(calls,1);
    now+=120000;await tick();assert.equal(calls,2);
    global.__sweetiebotGitHubPrRefreshError('API rate limit exceeded for user ID 123');
    global.__sweetiebotGitHubPrRefreshError('secondary rate limit');
    now+=120000;await tick();assert.equal(calls,2,'Native notices pause polling');
    now+=780001;
    error=new Error('API rate limit exceeded');
    await tick();assert.equal(calls,3,'Retries after fifteen minutes');
    error=undefined;
    now+=900001;await tick();assert.equal(calls,3,'Repeated limits extend to thirty minutes');
    now+=900001;await tick();assert.equal(calls,4,'Recovers after thirty minutes');
    seconds=600;configChanged({affectsConfiguration:key=>key.endsWith('RefreshIntervalSeconds')});
    assert.equal(delay,600000);
    focus();await Promise.resolve();assert.equal(calls,4);
    now+=600000;await tick();assert.equal(calls,5);
    enabled=false;configChanged({affectsConfiguration:()=>true});
    for(const item of owner.listeners)item.dispose();
    assert.equal(global.__sweetiebotGitHubPrRefreshError,previous);
  } finally {
    Date.now=originalNow;global.setInterval=originalSet;global.clearInterval=originalClear;
    if(previous===undefined)delete global.__sweetiebotGitHubPrRefreshError;
    else global.__sweetiebotGitHubPrRefreshError=previous;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
