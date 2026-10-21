const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/rate-limit-controls.js'), 'utf8'), context);
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

// A narrow transcript notice is not the empty composer-adjacent rate-limit card.
const rect = (left, top, width, height) => ({left, top, width, height, bottom: top + height});
const makeNode = (value, bounds, parent = null) => ({
    textContent: value, parentElement: parent, dataset: {}, style: {}, attrs: {},
    isConnected: true, getBoundingClientRect: () => bounds, querySelectorAll: () => [],
    matches: () => false, getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren(child) { this.child = child; this.textContent = ''; },
});
const editor = makeNode('', rect(35, 878, 530, 100));
const inChat = makeNode('Rate limited', rect(39, 470, 96, 96));
const inChatLabel = makeNode('Rate limited', rect(39, 470, 96, 24), inChat);
const footer = makeNode('Rated Limited', rect(27, 814, 564, 54));
const footerLabel = makeNode('Rated Limited', rect(78, 834, 115, 20), footer);
const imageEvents = {};
let imagesCreated = 0;
const imageRoot = {
    querySelectorAll(selector) {
        if (selector.startsWith('textarea,')) {
            assert.match(selector, /\[contenteditable\]/); // Codex ProseMirror can be contenteditable=plaintext-only.
            return [editor];
        }
        if (selector.startsWith('span,')) return [inChatLabel, footerLabel];
        return [];
    },
    createElement(tag) {
        assert.equal(tag, 'img');
        imagesCreated++;
        return {style: {}, addEventListener(event, callback) { imageEvents[event] = callback; }};
    },
};
assert.equal(context.scmToolkitIsShortRateLimit('Rated Limited'), true);
assert.equal(context.scmToolkitIsShortRateLimit('Rate Limited'), true);
assert.equal(context.scmToolkitIsShortRateLimit('Rate limited · 2h reset'), false);
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, footer);
context.scmToolkitSyncRateLimitPony(imageRoot);
assert.equal(imagesCreated, 1);
assert.equal(inChat.style.display, 'none');
assert.equal(inChat.attrs['data-scm-toolkit-rate-limit-duplicate'], 'true');
assert.equal(footer.child, undefined);
context.scmToolkitSyncRateLimitPony(imageRoot);
assert.equal(imagesCreated, 1); // Do not queue two network requests.
imageEvents.load();
assert.equal(footer.child.src, '__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__');
assert.match(footer.child.alt, /Twilight Sparkle/);
assert.equal(footer.attrs['data-scm-toolkit-rate-limit-pony'], 'true');
assert.equal(footer.style.border, '0');
assert.equal(footer.style.outline, 'none');
assert.equal(footer.style.width, 'max-content');
assert.equal(footer.style.display, 'inline-flex');
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, null);

// A full card with extra information or an actionable native control is untouched.
const timed = makeNode('Rated Limited · resets in 2h', rect(27, 814, 564, 54));
footerLabel.parentElement = timed;
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, null);
const actionable = makeNode('Rated Limited', rect(27, 814, 564, 54));
actionable.querySelectorAll = () => [{}];
footerLabel.parentElement = actionable;
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, null);

// Never guess which message to replace when the composer is absent.
footerLabel.parentElement = footer;
footer.textContent = 'Rated Limited';
footer.dataset = {};
footer.attrs = {};
footer.style = {};
footer.child = undefined;
imageRoot.querySelectorAll = selector => selector.startsWith('span,')
    ? [inChatLabel, footerLabel] : [];
inChat.style = {};
context.scmToolkitSyncRateLimitPony(imageRoot);
assert.equal(footer.child, undefined);
assert.equal(inChat.style.display, undefined);

// Image failure leaves native text available.
imageRoot.querySelectorAll = selector => selector.startsWith('textarea,') ? [editor]
    : selector.startsWith('span,') ? [inChatLabel, footerLabel] : [];
context.scmToolkitSyncRateLimitPony(imageRoot);
imageEvents.error();
assert.equal(footer.textContent, 'Rated Limited');
assert.equal(footer.child, undefined);
assert.equal(footer.dataset.scmToolkitRateLimitPonyUnavailable, 'true');

// Loading after status changes cannot replace more informative content.
footer.dataset = {};
context.scmToolkitSyncRateLimitPony(imageRoot);
footer.textContent = 'Rated Limited · reset available';
imageEvents.load();
assert.equal(footer.child, undefined);
assert.equal(footer.attrs['data-scm-toolkit-rate-limit-pony'], undefined);
console.log('Codex reset shortcut and composer-only rate-limit sticker checks passed.');
