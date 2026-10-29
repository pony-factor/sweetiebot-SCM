'use strict';
const assert = require('node:assert/strict');
const {withMergeProgress}=require('../extension/merge/progress');
const {stageLocation}=require('../extension/merge/progress');
const {waitForMergeChecks}=require('../extension/merge/checks');
const {updateMergeSessionCompletion}=require('../extension/merge/session_completion');
(async()=>{
  const messages=[];let options,release,finished=false,cancelled=false,tick,clock=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const vscode={ProgressLocation:{Notification:15},window:{withProgress:async (config,task)=>{
    options=config;try{return await task({report:message=>messages.push(message.message)});}finally{finished=true;}
  }}};
  const run=withMergeProgress(vscode,{numbers:[494],branchOnly:true},async report=>{
    report({number:494,stage:'integrating'});await gate;return 'done';
  },{schedule:callback=>{tick=callback;return 1;},cancel:()=>{cancelled=true;},now:()=>clock});
  assert(options.title.includes('Applying PR fix #494'));
  assert(!finished,'Notification stays open until local execution finishes');
  assert(messages.at(-1).includes('Integrating with the current base'));
  clock=20000;tick();assert(messages.at(-1).includes('20s elapsed'));
  release();assert.equal(await run,'done');assert(finished&&cancelled);
  const selection={repository:'o/r',pullRequests:[{number:494}]};
  let closeCount=0,completion;
  const host={window:{tabGroups:{all:[{tabs:[{label:'Lindsey · Local merge'}]}],close:()=>{closeCount++;}}}};
  updateMergeSessionCompletion(host,selection,{repository:'o/r',merged:[],deferred:[{number:494}]},()=>assert.fail('Failed result must stay visible'));
  updateMergeSessionCompletion(host,selection,{repository:'o/r',merged:[],prepared:[{number:494}],deferred:[]},callback=>{completion=callback;return 1;});
  completion();assert.equal(closeCount,1,'Successful branch-only repairs can close their completed local tab');
  assert.equal(stageLocation('integrating'),'local');
  assert.equal(stageLocation('pushing'),'upstream');
  assert.equal(stageLocation('reviewing'),'review');
  let reads=0,pollClock=0;const polls=[];
  const api=async endpoint=>endpoint.includes('/check-runs?')
    ? {check_runs:[{id:1,name:'Regression tests',status:++reads===1?'in_progress':'completed',conclusion:'success'}]}
    : endpoint.includes('/check-suites?')?{check_suites:[]}:{statuses:[]};
  const checks=await waitForMergeChecks(api,'owner/repo','a'.repeat(40),{
    now:()=>pollClock,sleep:async ms=>{pollClock+=ms;},intervalMs:15000,onPoll:result=>polls.push(result)});
  assert.equal(checks.state,'passed');assert.equal(polls.length,2);
  assert.equal(polls[0].evidence[0].result,'in_progress');
  assert.equal(polls[0].nextPollAt,15000);assert.equal(polls[1].nextPollAt,0);
  assert.equal((await waitForMergeChecks(api,'owner/repo','a'.repeat(40),{onPoll(){throw Error('UI unavailable');}})).state,'passed',
    'Activity display failures cannot change check enforcement');
  console.log('Persistent local-operation notification, elapsed progress and visible failure checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
