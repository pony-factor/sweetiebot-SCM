const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const intervals = [];
const listeners = {};
const context = vm.createContext({
    HTMLElement: class {},
    customElements: { get() { return true; } },
    setInterval(fn, delay) {
        intervals.push({ fn, delay });
        return intervals.length;
    },
    window: {
        addEventListener(type, fn) { listeners[`window:${type}`] = fn; },
    },
    document: {
        hidden: false,
        addEventListener(type, fn) { listeners[`document:${type}`] = fn; },
    },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/codex-usage.js'), 'utf8'), context);
const remaining = context.scmToolkitRemainingUsage;
const bucket = (minutes, used) => ({ limit_window_seconds: minutes * 60, used_percent: used });
const usage = (primary, secondary) => ({ rate_limit: { primary_window: primary, secondary_window: secondary } });

// A reset must restore the five-hour percentage even when weekly usage is higher.
assert.equal(remaining(usage(bucket(300, 100), bucket(10080, 60))), 0);
assert.equal(remaining(usage(bucket(300, 0), bucket(10080, 60))), 100);
assert.equal(remaining(usage(bucket(300, 12), bucket(10080, 62))), 88);
assert.equal(remaining(usage(bucket(300, 12), bucket(10080, 100))), 88);
assert.equal(remaining(usage(bucket(10080, 60), bucket(300, 12))), 88);
assert.equal(remaining(usage(bucket(300, 12.6), null)), 87);
assert.equal(remaining(usage(bucket(300, -5), null)), 100);
assert.equal(remaining(usage(bucket(300, 105), null)), 0);
assert.equal(remaining(usage(null, bucket(10080, 60))), null);
assert.equal(remaining(usage(bucket(300, NaN), bucket(10080, 60))), null);
assert.equal(remaining(usage(bucket(300, '12'), null)), null);
assert.equal(remaining(undefined), null);
const keepFresh = context.scmToolkitKeepUsageFresh;
let firstRefreshes = 0;
let latestRefreshes = 0;
keepFresh(() => { firstRefreshes += 1; });
keepFresh(() => { latestRefreshes += 1; });
assert.equal(intervals.length, 1);
assert.equal(intervals[0].delay, 15000);

// Re-renders update the callback without starting another poller.
intervals[0].fn();
assert.equal(firstRefreshes, 0);
assert.equal(latestRefreshes, 1);

// Switching back to another VS Code window refreshes immediately.
listeners['window:focus']();
assert.equal(latestRefreshes, 2);
context.document.hidden = true;
listeners['document:visibilitychange']();
assert.equal(latestRefreshes, 2);
context.document.hidden = false;
listeners['document:visibilitychange']();
assert.equal(latestRefreshes, 3);

console.log('Codex five-hour usage and reset regression checks passed.');
