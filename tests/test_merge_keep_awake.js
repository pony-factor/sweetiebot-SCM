'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMergeKeepAwake } = require('../efs/merge_keep_awake');
const children = [], timers = new Set();
const controller = createMergeKeepAwake({ platform: 'darwin', pid: 123,
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
console.log('Merge queue screensaver protection checks passed.');
