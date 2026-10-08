const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/codex-hide-reset-times.js'), 'utf8'), context);
const hide = context.scmToolkitStripUsageResetTime;
for (const [input, expected] of [
    ['Resets in 1h 45m', ''],
    ['Resets 1:24 AM', ''],
    ['Resets Oct 9', ''],
    ['Resets tomorrow', ''],
    ['Next reset: in 2 days', ''],
    ['Your rate limit resets in 0m.', 'Your rate limit resets.'],
    ['Your limit resets on Oct 9.', 'Your limit resets.'],
    ['Try again at 2:30 PM.', 'Try again later.'],
    ["You've hit your usage limit. Try again in 10m.", "You've hit your usage limit. Try again later."],
    ['Wait until 1:24 AM.', 'wait until your limit resets.'],
    ['5-hour usage limit: 80%', '5-hour usage limit: 80%'],
    ['Next meeting is Oct 9 at 2:30 PM.', 'Next meeting is Oct 9 at 2:30 PM.'],
]) {
    assert.equal(hide(input), expected, input);
}
console.log('Codex reset time hiding checks passed.');
