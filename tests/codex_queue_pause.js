'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const exportsForTest = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../assets/codex/queued-edit.js'),'utf8'), {
  __SCM_TOOLKIT_QUEUE_EDIT_TEST__: exportsForTest
});
const {QueuePause} = exportsForTest;
(async()=>{
  const held = new Map();
  let calls = 0, finish;
  const gate = new Promise(resolve=>{finish=resolve;});
  const adapter = threadId=>({threadId,coordinator:async()=>({deferAutomaticTurns:async thread=>{
    calls++; await gate;
    held.set(thread,(held.get(thread)||0)+1);
    return {dispose(){held.set(thread,held.get(thread)-1);}};
  }})});
  const first = new QueuePause(adapter('a'));
  const opening = first.toggle();
  assert(first.pending,'Pause exposes immediate pending state');
  await first.toggle();
  finish(); await opening;
  assert.equal(calls,1,'Rapid activation acquires only one pause lease');
  assert.equal(held.get('a'),1);
  const other = new QueuePause(adapter('b'));
  await other.toggle();
  await first.toggle();
  assert.equal(held.get('a'),0,'Resume releases only its own queue');
  assert.equal(held.get('b'),1,'Other queues remain paused');
  other.dispose();
  assert.equal(held.get('b'),0,'Closing the view releases its queue hold');
  let acquired, disposed=0;
  const delayed = new QueuePause({threadId:'c',coordinator:async()=>({deferAutomaticTurns:()=>new Promise(resolve=>{acquired=resolve;})})});
  const pending=delayed.toggle();
  await new Promise(resolve=>setImmediate(resolve));
  delayed.dispose();
  acquired({dispose(){disposed++;}});
  await pending;
  assert.equal(disposed,1,'A late native pause cannot leak after the view closes');
  const unsupported=new QueuePause({coordinator:async()=>({})});
  await unsupported.toggle();
  assert(!unsupported.lease);
  assert(unsupported.error.includes('unavailable'),'Missing native support is visible and never fakes a pause');
  console.log('Native queue pause/resume, rapid activation, independent threads and disposal checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
