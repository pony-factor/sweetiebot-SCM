'use strict';
const assert = require('node:assert/strict');
const {withMergeProgress}=require('../efs/merge_progress');
const {updateMergeSessionCompletion}=require('../efs/merge_session_completion');
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
  console.log('Persistent local-operation notification, elapsed progress and visible failure checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
