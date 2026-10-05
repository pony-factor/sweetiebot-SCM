const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let now = 1_800_000_000_000;
let updateTimer;
let cleared;
let Countdown;
const context = vm.createContext({
    HTMLElement: class {
        getAttribute() { return this.resetAt; }
    },
    Node: { TEXT_NODE: 3 },
    Date: { now: () => now },
    setInterval(callback) { updateTimer = callback; return 7; },
    clearInterval(timer) { cleared = timer; },
    customElements: {
        get() {},
        define(name, element) { Countdown = element; },
    },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/codex-countdown.js'), 'utf8'), context);
const jsx = (tag, props, key) => ({ tag, props, key });
context.jsx = jsx;
context.resetAt = (now + 4 * 3_600_000 + 23 * 60_000) / 1000;

for (const [message, expected] of [
    ['Your limit resets on {time}.', 'Your limit resets in '],
    ['Try again at {time}.', 'Try again in '],
    ['Wait until {time}.', 'Wait '],
]) {
    context.message = message;
    const parts = vm.runInContext('scmToolkitUsageResetMessage(message, resetAt, jsx)', context);
    assert.equal(parts[0], expected);
    assert.equal(parts[1].props['reset-at'], context.resetAt);
    assert.equal(parts[2], '.');
}
assert.equal(vm.runInContext('scmToolkitUsageResetMessage("No reset available", null, jsx)', context), 'No reset available');
const element = new Countdown();
element.resetAt = context.resetAt;
element.connectedCallback();
assert.equal(element.textContent, '4h 23m');
now += 60_000;
updateTimer();
assert.equal(element.textContent, '4h 22m');
now += 5 * 3_600_000;
updateTimer();
assert.equal(element.textContent, '0m');
element.disconnectedCallback();
assert.equal(cleared, 7);
console.log('Codex countdown rendering and lifecycle checks passed.');
