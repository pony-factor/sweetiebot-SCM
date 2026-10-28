const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/hide-reset-times.js'), 'utf8'), context);
const hide = context.scmToolkitStripUsageResetTime;
for (const [input, expected] of [
    ['Resets in 1h 45m', ''],
    ['Resets 1:24 AM', ''],
    ['Resets Oct 9', ''],
    ['Resets tomorrow', ''],
    ['Next reset: in 2 days', ''],
    ['Your rate limit resets, 2:00 AM. Upgrade or use one of your rate limit resets now.', 'Your rate limit resets. Upgrade or use one of your rate limit resets now.'],
    ['Your rate limit resets: 2:00 AM.', 'Your rate limit resets.'],
    ['Your rate limit resets; 2:00 AM.', 'Your rate limit resets.'],
    ['Your rate limit resets — 2:00 AM.', 'Your rate limit resets.'],
    ['Resets, 2:00 AM', ''],
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

 // When the banner has a button child, remove the time from its own text node
 // without replacing the banner or removing any interactive controls.
const message = { nodeType: 3, textContent: 'Your rate limit resets, 2:00 AM. ' };
const upgrade = { nodeType: 1, textContent: 'Upgrade' };
const banner = {
    tagName: 'DIV',
    children: [upgrade],
    childNodes: [message, upgrade],
    get textContent() { return message.textContent + upgrade.textContent; },
    getAttribute() { return null; },
};
const dom = vm.createContext({
    document: { querySelectorAll() { return [banner]; } },
    MutationObserver: class { observe() {} },
    queueMicrotask(callback) { callback(); },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/hide-reset-times.js'), 'utf8'), dom);
assert.equal(message.textContent, 'Your rate limit resets. ');
assert.equal(upgrade.textContent, 'Upgrade');

// Simulate the separate module scopes loaded by the native app. Only the first
// module should register a document watcher or perform the startup scan.
let watchers = 0;
let scans = 0;
let onMutation;
const shared = vm.createContext({
    document: { querySelectorAll() { scans++; return [banner]; } },
    MutationObserver: class {
        constructor(callback) { watchers++; onMutation = callback; }
        observe() {}
    },
});
const asset = fs.readFileSync(path.join(__dirname, '../assets/codex/hide-reset-times.js'), 'utf8');
for (let i = 0; i < 35; i++) vm.runInContext(`(() => {${asset}\n})();`, shared);
assert.equal(watchers, 1);
assert.equal(scans, 2, 'only one startup scan of headings and elements');
message.textContent = 'Your rate limit resets, 2:00 AM. ';
onMutation();
assert.equal(message.textContent, 'Your rate limit resets. ', 'shared watcher still hides later updates');

console.log('Codex reset time hiding checks passed.');
