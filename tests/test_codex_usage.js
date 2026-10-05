const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({
    HTMLElement: class {},
    customElements: { get() { return true; } },
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
console.log('Codex five-hour usage and reset regression checks passed.');
