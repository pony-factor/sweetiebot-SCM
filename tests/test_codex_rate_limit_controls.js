const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/codex-rate-limit-controls.js'), 'utf8'), context);
for (const [label, eligible] of [
    ['1 reset available', true], ['2 resets available', true], ['Full reset', true],
    ['0 resets available', false], ['Add credits', false],
    ['Credits remaining: 30', false], ['1 reset expired', false],
]) assert.equal(context.scmToolkitIsAvailableResetSummary(label), eligible, label);
assert.equal(context.scmToolkitIsLimitCardHeading('Rate limited'), true);
assert.equal(context.scmToolkitIsLimitCardHeading("You've hit your usage limit."), true);
assert.equal(context.scmToolkitIsLimitCardHeading('Rate limited when coding'), false);
const source = {dataset: {}, textContent: '1 reset available', isConnected: true,
    clicks: 0, getAttribute: () => null, click() { this.clicks++; }};
const added = [];
const dismiss = { textContent: 'Dismiss', getAttribute: () => null };
const row = { style: {}, parentElement: null, textContent: 'Rate limited',
    querySelectorAll: () => [dismiss],
    append(button) { added.push(button); button.parentElement = this; }};
row.parentElement = { textContent: 'Rate limited Dismiss', parentElement: null,
    querySelectorAll: () => [dismiss], matches: () => false };
const heading = { textContent: 'Rate limited', parentElement: row, closest: () => null };
const root = {
    querySelectorAll(query) { return query.includes('h1,') ? [heading] : [source]; },
    querySelector() { return added.find(button => !button.removed) || null; },
    createElement() { return {dataset: {}, style: {}, attrs: {},
        setAttribute(k,v) {this.attrs[k]=v;},
        getAttribute(k) {return this.attrs[k] ?? null;},
        addEventListener(k,cb) {this.handler=cb;},
        remove() {this.removed=true;}}; },
};
context.scmToolkitSyncResetShortcut(root);
assert.equal(added.length, 1);
assert.equal(added[0].textContent, 'Use credits');
added[0].handler();
assert.equal(source.clicks, 1);
context.scmToolkitSyncResetShortcut(root);
assert.equal(added.length, 1);
source.textContent = '0 resets available';
context.scmToolkitSyncResetShortcut(root);
assert.equal(added[0].removed, true);
console.log('Codex reset credit control checks passed.');
