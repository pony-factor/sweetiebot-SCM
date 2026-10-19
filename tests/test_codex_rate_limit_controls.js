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

// The short provider toast can become a tiny sticker without changing real usage cards.
const notice = {
    textContent: 'Rate Limited', dataset: {}, style: {}, isConnected: true, attrs: {},
    parentElement: null, matches: () => false,
    querySelector: () => ({}), querySelectorAll: () => [],
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren(child) { this.child = child; this.textContent = child.alt; },
};
const label = {
    textContent: 'Rate Limited', parentElement: notice, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [], matches: () => false,
};
let imageEvents = {};
const imageRoot = {
    querySelectorAll() { return [label]; },
    createElement(tag) {
        assert.equal(tag, 'img');
        return {style: {}, addEventListener(event, callback) { imageEvents[event] = callback; }};
    },
};
context.scmToolkitSyncRateLimitPony(imageRoot);
assert.equal(notice.dataset.scmToolkitRateLimitPonyPending, 'true');
assert.equal(notice.child, undefined);
context.scmToolkitSyncRateLimitPony(imageRoot);
assert.equal(notice.child, undefined); // No duplicate image before load.
assert.equal(typeof imageEvents.load, 'function');
imageEvents.load();
assert.equal(notice.child.src, '__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__');
assert.match(notice.child.alt, /Twilight Sparkle/);
assert.equal(notice.attrs['data-scm-toolkit-rate-limit-pony'], 'true');
assert.equal(notice.style.border, '0');
assert.equal(context.scmToolkitSmallRateLimitNotice(imageRoot), null);
const unsupported = {
    ...notice, textContent: 'Your rate limit resets in 2h', dataset: {}, child: null,
};
label.parentElement = unsupported;
label.textContent = 'Your rate limit resets in 2h';
assert.equal(context.scmToolkitSmallRateLimitNotice(imageRoot), null);
label.textContent = 'Rate Limited';
unsupported.textContent = 'Rate Limited';
imageEvents = {};
context.scmToolkitSyncRateLimitPony(imageRoot);
imageEvents.error();
assert.equal(unsupported.child, null); // Failed remote image retains original text.
assert.equal(unsupported.textContent, 'Rate Limited');

// Hide the exact native inline error, including its icon, independently of image load.
const inlineCopy = "You've hit your usage limit. Upgrade your plan or add credits to continue, or Try again later.";
assert.equal(context.scmToolkitIsInlineUsageLimitText(inlineCopy), true);
assert.equal(context.scmToolkitIsInlineUsageLimitText(inlineCopy.replace('Try again later.', 'Try again in two hours.')), false);
assert.equal(context.scmToolkitIsInlineUsageLimitText('You have reached a different limit.'), false);
const inlineRow = {
    textContent: inlineCopy, parentElement: null, dataset: {}, style: {},
    matches: () => false, querySelector: selector => selector === 'svg, img' ? {} : null,
    setAttribute(name, val) { this[name] = val; },
};
const inlineLeaf = {
    textContent: inlineCopy, parentElement: inlineRow, children: [],
    closest: () => null, matches: () => false, querySelector: () => null,
};
const inlineRoot = {querySelectorAll: () => [inlineLeaf, inlineRow]};
context.scmToolkitSyncInlineUsageLimit(inlineRoot);
assert.equal(inlineRow.hidden, true);
assert.equal(inlineRow.style.display, 'none');
context.scmToolkitSyncInlineUsageLimit(inlineRoot); // Idempotent.
const quotedUserRow = {
    textContent: inlineCopy, parentElement: null, dataset: {}, style: {},
    matches: () => false, querySelector: () => null, setAttribute: () => {},
};
const quotedLeaf = {
    textContent: inlineCopy, parentElement: quotedUserRow, children: [],
    closest: () => null, matches: () => false, querySelector: () => null,
};
context.scmToolkitSyncInlineUsageLimit({querySelectorAll: () => [quotedLeaf, quotedUserRow]});
assert.equal(quotedUserRow.hidden, undefined); // No status icon, so preserve user text.
console.log('Codex reset credit control, Twilight sticker and inline limit checks passed.');
