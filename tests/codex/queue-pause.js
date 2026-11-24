'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const exportsForTest = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../../assets/codex/queued-edit.js'),'utf8'), {
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
  let legacyCalls = 0, legacyReleases = 0;
  const legacy = new QueuePause({threadId:'legacy',hostId:'local',coordinator:async()=>({
    deferAutomaticTurns(){legacyCalls++; return {dispose(){legacyReleases++;}};}
  })});
  await legacy.refresh();
  assert.equal(legacyCalls,1,'Detect a legacy coordinator once');
  assert.equal(legacyReleases,1,'Release the capability-probe lease');
  await legacy.refresh();
  await legacy.refresh();
  assert.equal(legacyCalls,1,'Store updates must not acquire new legacy leases or wake the queue');
  await legacy.toggle();
  assert.equal(legacyCalls,2,'Explicit legacy Pause acquires one lease without probing again');
  await legacy.refresh();
  assert.equal(legacyReleases,1,'Refreshing while paused must not release a second lease');
  await legacy.toggle();
  assert.equal(legacyReleases,2,'Explicit Resume releases the user lease');

  let hostPaused = false, hostReads = 0;
  const modern = new QueuePause({threadId:'modern',hostId:'local',coordinator:async()=>({
    deferAutomaticTurns(thread,mode,value){
      assert.equal(thread,'modern'); assert.equal(mode,'sweetiebot-user-pause');
      if (typeof value === 'boolean') hostPaused = value;
      else hostReads++;
      return hostPaused;
    }
  })});
  await modern.refresh();
  assert.equal(modern.hostPaused,false);
  hostPaused = true;
  await modern.refresh();
  assert.equal(modern.hostPaused,true,'Refresh detects a pause restored by the host');
  await modern.toggle();
  assert.equal(hostPaused,false,'Resume clears the native host pause');
  assert.equal(modern.hostPaused,false);
  assert.equal(hostReads,3,'Supported coordinators still refresh native state');
  console.log('Native queue pause/resume, rapid activation, independent threads, disposal and legacy refresh checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
