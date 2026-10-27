'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMergeKeepAwake } = require('../extension/merge/merge_keep_awake');
const children = [], timers = new Set();
let clock = 0;
const controller = createMergeKeepAwake({ platform: 'darwin', pid: 123,
  now: () => clock, idleMs: 60000,
  spawn(executable, args) {
    assert.equal(executable, '/usr/bin/caffeinate');
    assert.deepEqual(args, ['-d', '-i', '-u', '-t', '30', '-w', '123']);
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  },
  schedule(callback) { const timer = { callback }; timers.add(timer); return timer; },
  cancel(timer) { timers.delete(timer); }
});
const selection = { pullRequests: [{ number: 1 }, { number: 2 }] };
controller.update({ merged: [], deferred: [] }, selection);
assert.equal(children.length, 1);
Array.from(timers)[0].callback();
assert(children[0].killed);
assert.equal(children.length, 2, 'Long GPT reviews renew screensaver protection');
controller.update({ merged: [{ number: 1 }], deferred: [] }, selection);
assert(!children[1].killed, 'Remaining PRs retain protection');
controller.update({ merged: [{ number: 1 }], deferred: [{ number: 2 }] }, selection);
assert(children[1].killed);
assert.equal(timers.size, 0);
controller.update({}, selection);
controller.update({ rateLimit: {} }, selection);
assert(children[2].killed, 'Rate-limited queues release protection');
controller.update({}, selection, false);
assert.equal(children.length, 3, 'Disabled setting is respected');
controller.update({}, selection);
controller.dispose();
assert(children[3].killed);
assert.equal(timers.size, 0);
controller.update({}, selection);
assert.equal(children.length, 4, 'Disposed queue cannot restart protection');
const stale = createMergeKeepAwake({ platform:'darwin', now:()=>clock, idleMs:60000,
  spawn() { const child=new EventEmitter(); child.kill=()=>{child.killed=true;}; children.push(child);return child; },
  schedule(callback) {const timer={callback};timers.add(timer);return timer;}, cancel(timer){timers.delete(timer);}
});
stale.update({round:1},selection);
clock=60001;
Array.from(timers)[0].callback();
assert(children[4].killed, 'A stalled queue releases protection when its progress lease expires');
stale.update({round:1},selection);
assert.equal(children.length,5,'Repeated stale state does not renew protection');
stale.update({round:2},selection);
assert.equal(children.length,6,'Actual progress can resume protection');
stale.dispose();
console.log('Merge queue screensaver protection checks passed.');
