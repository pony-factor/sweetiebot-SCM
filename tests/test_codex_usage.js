const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const intervals = [];
const listeners = {};
const components = new Map();
const context = vm.createContext({
    HTMLElement: class {
        constructor() { this.style = {}; this.attributes = {}; }
        getAttribute(name) { return this.attributes[name] ?? null; }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        removeAttribute(name) { delete this.attributes[name]; }
    },
    customElements: {
        get(name) { return components.get(name); },
        define(name, element) { components.set(name, element); },
    },
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

const piePercent = context.scmToolkitUsagePiePercent;
assert.equal(piePercent(100), 100);
assert.equal(piePercent(42.4), 42);
assert.equal(piePercent(-5), 0);
assert.equal(piePercent(105), 100);
assert.equal(piePercent('not-a-number'), null);

// The user's VS Code JSON theme accent applies only at ten percent or below.
const UsagePie = components.get('scm-toolkit-usage-pie');
const indicator = new UsagePie();
indicator.connectedCallback();
for (const [percent, color] of [
    [100, 'currentColor'],
    [11, 'currentColor'],
    [10, 'var(--vscode-focusBorder, currentColor)'],
    [1, 'var(--vscode-focusBorder, currentColor)'],
    [0, 'var(--vscode-focusBorder, currentColor)'],
    [50, 'currentColor'],
]) {
    indicator.setAttribute('percent', percent);
    indicator.update();
    assert.ok(indicator.style.background.includes(`, ${color} `), `${percent}% foreground`);
    assert.equal(indicator.getAttribute('aria-label'), `${percent}% Codex usage remaining`);
}
indicator.setAttribute('percent', 'unavailable');
indicator.update();
assert.equal(indicator.style.background, 'transparent');
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

const relativeReset = context.scmToolkitRelativeUsageReset;
assert.equal(relativeReset((1_800_000_000_000 + 105 * 60_000) / 1000, 300, 1_800_000_000_000), '1h 45m');
assert.equal(relativeReset((1_800_000_000_000 + 1) / 1000, 300, 1_800_000_000_000), '1m');
assert.equal(relativeReset((1_800_000_000_000 + 2 * 86400000) / 1000, 10080, 1_800_000_000_000), '2 days');

const relativeLabel = context.scmToolkitRelativeUsageResetLabel;
const lateEvening = new Date(2026, 9, 3, 23, 39).getTime();
assert.equal(relativeLabel('Resets 1:24 AM', lateEvening), 'Resets in 1h 45m');
const octoberSeventh = new Date(2026, 9, 7, 3, 30).getTime();
assert.equal(relativeLabel('Resets Oct 9', octoberSeventh), 'Resets in 2 days');
assert.equal(relativeLabel('Resets Oct 7', octoberSeventh), 'Resets today');
assert.equal(relativeLabel('Not a reset', octoberSeventh), null);

const nativeLimitLabels = [
    { textContent: 'Your rate limit resets in 0m.', children: [] },
    { textContent: "You've hit your usage limit. Try again in 0m.", children: [] },
    { textContent: 'Rendered in 0m', children: [] },
];
context.scmToolkitCorrectLastMinuteUsageLabels({
    querySelectorAll() { return nativeLimitLabels; },
});
assert.equal(nativeLimitLabels[0].textContent, 'Your rate limit resets in 1m.');
assert.equal(nativeLimitLabels[1].textContent, "You've hit your usage limit. Try again in 1m.");
assert.equal(nativeLimitLabels[2].textContent, 'Rendered in 0m');

const resetRows = [
    { textContent: 'Resets 1:24 AM', children: [] },
    { textContent: 'Resets Oct 9', children: [] },
];
const usageDialog = {
    textContent: 'Usage 5 hour usage limit Resets 1:24 AM Weekly usage limit Resets Oct 9',
    querySelectorAll() { return resetRows; },
};
context.scmToolkitApplyUsageDialogRelativeTimes({
    querySelectorAll() { return [usageDialog]; },
}, lateEvening);
assert.equal(resetRows[0].textContent, 'Resets in 1h 45m');
// The weekly row is also rewritten from its absolute calendar date.
assert.match(resetRows[1].textContent, /^Resets in \d+ days?$/);

context.scmToolkitHideUsageResetTimes = true;
resetRows[0].textContent = 'Resets 1:24 AM';
resetRows[1].textContent = 'Resets Oct 9';
context.scmToolkitApplyUsageDialogRelativeTimes({
    querySelectorAll() { return [usageDialog]; },
}, lateEvening);
assert.equal(resetRows[0].textContent, '');
assert.equal(resetRows[1].textContent, '');

console.log('Codex five-hour usage and reset regression checks passed.');
