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
    matches(selector) { return Boolean((this.roleLog && selector.includes('[role="log"]'))
        || (this.bodyRoot && selector.includes('body'))); },
    closest(selector) {
        for (let node = this; node; node = node.parentElement) {
            if (node.matches?.(selector)) return node;
        }
        return null;
    },
    contains(other) {
        for (let node = other; node; node = node.parentElement) {
            if (node === this) return true;
        }
        return false;
    },
    querySelector: () => null,
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren(child) { this.child = child; this.textContent = ''; },
});
const editor = makeNode('', rect(35, 878, 530, 100));
const inChat = makeNode('Rate limited', rect(39, 470, 96, 96));
const inChatLabel = makeNode('Rate limited', rect(39, 470, 96, 24), inChat);
const footer = makeNode('Rated Limited', rect(27, 814, 564, 54));
const footerLabel = makeNode('Rated Limited', rect(78, 834, 115, 20), footer);
// Composer/footer ownership stays constant when the view is resized, zoomed,
// moved to a different display or rendered as a compact iconless pill.
const appRoot = makeNode('', rect(0, 0, 3000, 1200));
appRoot.bodyRoot = true;
const composerRegion = makeNode('', rect(0, 0, 300, 100));
composerRegion.parentElement = appRoot;
editor.parentElement = composerRegion;
footer.parentElement = composerRegion;
const transcript = makeNode('', rect(0, 0, 3000, 1100));
transcript.roleLog = true;
transcript.parentElement = appRoot;
inChat.parentElement = transcript;
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
assert.equal(footer.style.border, '1px solid var(--vscode-focusBorder, currentColor)');
assert.equal(footer.style.outline, 'none');
assert.equal(footer.style.width, 'max-content');
assert.equal(footer.style.borderRadius, '12px');
assert.equal(footer.style.display, 'inline-flex');
// replaceChildren detaches the original footer label in the real webview.
footerLabel.parentElement = null;
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, null);

// Both icon-bearing and iconless status pills are selected by composer ancestry.
const compactFooter = makeNode('Rated Limited', rect(27, 814, 220, 54));
const compactLabel = makeNode('Rated Limited', rect(86, 834, 115, 20), compactFooter);
compactFooter.parentElement = composerRegion;
compactFooter.querySelector = selector => selector.startsWith('svg,') ? {} : null;
const compactRoot = {
    ...imageRoot,
    querySelectorAll(selector) {
        if (selector.startsWith('textarea,')) return [editor];
        if (selector.startsWith('span,')) return [compactLabel];
        return [];
    },
};
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, compactFooter);
context.scmToolkitSyncRateLimitPony(compactRoot);
assert.equal(imagesCreated, 2);
imageEvents.load();
assert.equal(compactFooter.child.width, 96);
const noIconFooter = makeNode('Rate limited', rect(-18000, 99999, 1, 1));
noIconFooter.parentElement = composerRegion;
const noIconLabel = makeNode('Rate limited', rect(86, 834, 115, 20), noIconFooter);
compactRoot.querySelectorAll = selector => selector.startsWith('textarea,') ? [editor]
    : selector.startsWith('span,') ? [noIconLabel] : [];
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, noIconFooter);
// A similar notice elsewhere in the app, without a shared composer owner,
// must not be mistaken for the footer even if it has identical wording.
const outsider = makeNode('Rate limited', rect(27, 814, 564, 54));
const outsiderLabel = makeNode('Rate limited', rect(27, 814, 564, 54), outsider);
outsider.parentElement = appRoot;
compactRoot.querySelectorAll = selector => selector.startsWith('textarea,') ? [editor]
    : selector.startsWith('span,') ? [outsiderLabel] : [];
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, null);
// Neither CSS layout nor the device pixel ratio is consulted.
editor.getBoundingClientRect = () => { throw Error('No pixel geometry required'); };
noIconFooter.getBoundingClientRect = () => { throw Error('No pixel geometry required'); };
compactRoot.querySelectorAll = selector => selector.startsWith('textarea,') ? [editor]
    : selector.startsWith('span,') ? [noIconLabel] : [];
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, noIconFooter);
// Multiple equal candidates are ambiguous; never choose one at random.
const secondFooter = makeNode('Rate limited', rect(0, 0, 9000, 10));
secondFooter.parentElement = composerRegion;
const secondLabel = makeNode('Rate limited', rect(0, 0, 9000, 10), secondFooter);
compactRoot.querySelectorAll = selector => selector.startsWith('textarea,') ? [editor]
    : selector.startsWith('span,') ? [noIconLabel, secondLabel] : [];
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, null);
// A layout whose only shared owner also contains the transcript is unsafe.
compactRoot.querySelectorAll = selector => selector.startsWith('textarea,') ? [editor]
    : selector.startsWith('span,') ? [noIconLabel] : [];
composerRegion.querySelector = selector => selector.includes('[role="log"]') ? transcript : null;
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, null);
composerRegion.querySelector = () => null;
assert.equal(context.scmToolkitFooterRateLimitNotice(compactRoot).card, noIconFooter);

// An unmatched footer still has its typo fixed, without requiring a composer.
const unmatchedTypoText = {nodeType: 3, textContent: 'Rated Limited'};
const unmatchedTypoLabel = makeNode('Rated Limited', rect(27, 814, 220, 54));
unmatchedTypoLabel.childNodes = [unmatchedTypoText];
const noComposerRoot = {
    ...imageRoot,
    querySelectorAll(selector) {
        return selector.startsWith('span,') ? [unmatchedTypoLabel] : [];
    },
};
context.scmToolkitSyncRateLimitPony(noComposerRoot);
assert.equal(unmatchedTypoText.textContent, 'Rate limited');

// Typo normalization edits only text, retaining the icon and native fallback.
const typoText = {nodeType: 3, textContent: 'Rated Limited'};
const iconNode = {nodeType: 1, childNodes: []};
context.scmToolkitNormalizeRateLimitTypo({
    textContent: 'Rated Limited', childNodes: [iconNode, {nodeType: 1, childNodes: [typoText]}],
});
assert.equal(typoText.textContent, 'Rate limited');
assert.equal(iconNode.childNodes.length, 0);

// A detailed status keeps its native information and controls, but gets a
// standalone small sticker card in the same composer region.
const nativeButton = {textContent: 'Upgrade', clicks: 0, click() { this.clicks++; }};
const detailParent = makeNode('', rect(0, 0, 5000, 80));
detailParent.parentElement = composerRegion;
detailParent.querySelector = () => null;
detailParent.insertBefore = (companion, reference) => {
    assert.equal(reference.parentElement, detailParent);
    detailParent.companion = companion;
};
const richNotice = makeNode('Rate limited · resets in 2h', rect(0, 0, 5000, 80));
richNotice.parentElement = detailParent;
richNotice.querySelector = selector => selector.includes('button') ? nativeButton : null;
richNotice.querySelectorAll = selector => selector.includes('button') ? [nativeButton] : [];
const richRoot = {
    ...imageRoot,
    querySelectorAll(selector) {
        if (selector.startsWith('textarea,')) return [editor];
        if (selector.startsWith('span,')) return [richNotice];
        return [];
    },
    createElement(tag) {
        if (tag === 'div') {
            return {
                style: {}, attrs: {}, children: [],
                setAttribute(k, v) { this.attrs[k] = v; },
                append(child) { this.children.push(child); },
            };
        }
        return imageRoot.createElement(tag);
    },
};
assert.equal(context.scmToolkitFooterRateLimitNotice(richRoot).card, richNotice);
assert.equal(context.scmToolkitFooterRateLimitNotice(richRoot).rich, true);
context.scmToolkitSyncRateLimitPony(richRoot);
imageEvents.load();
assert.equal(richNotice.textContent, 'Rate limited · resets in 2h');
assert.equal(richNotice.querySelector('button'), nativeButton);
assert.equal(detailParent.companion.children[0].width, 96);
assert.equal(detailParent.companion.style.width, 'max-content');
assert.equal(detailParent.companion.attrs['data-scm-toolkit-rate-limit-pony-companion'], 'true');
context.scmToolkitSyncRateLimitPony(richRoot);
assert.equal(detailParent.companion.children.length, 1);
nativeButton.click();
assert.equal(nativeButton.clicks, 1);
// A bare status label with a sibling Upgrade button must create a separate
// sticker while leaving the original button functional.
const upgradeButton = {textContent: 'Upgrade', count: 0, click() { this.count++; }};
const upgradeCard = makeNode('Rate limited Upgrade', rect(0, 0, 1000, 10));
upgradeCard.parentElement = composerRegion;
const upgradeLabel = makeNode('Rate limited', rect(0, 0, 1000, 10), upgradeCard);
upgradeCard.querySelector = selector => selector.includes('button') ? upgradeButton : null;
upgradeCard.querySelectorAll = selector => selector.includes('button') ? [upgradeButton] : [];
const upgradeOwner = composerRegion;
const upgradeRoot = {
    ...imageRoot,
    querySelectorAll(selector) {
        if (selector.startsWith('textarea,')) return [editor];
        if (selector.startsWith('span,')) return [upgradeLabel];
        return [];
    },
    createElement: richRoot.createElement,
};
const upgradeParent = makeNode('', rect(0, 0, 1000, 10));
upgradeParent.parentElement = composerRegion;
upgradeCard.parentElement = upgradeParent;
upgradeParent.insertBefore = (companion, child) => {
    assert.equal(child, upgradeCard);
    upgradeParent.companion = companion;
};
assert.equal(context.scmToolkitFooterRateLimitNotice(upgradeRoot).card, upgradeCard);
assert.equal(context.scmToolkitFooterRateLimitNotice(upgradeRoot).rich, true);
const countBeforeUpgrade = imagesCreated;
context.scmToolkitSyncRateLimitPony(upgradeRoot);
assert.equal(imagesCreated, countBeforeUpgrade + 1);
imageEvents.load();
assert.equal(upgradeCard.textContent, 'Rate limited Upgrade');
assert.equal(upgradeParent.companion.style.width, 'max-content');
upgradeButton.click();
assert.equal(upgradeButton.count, 1);

// If the artwork cannot render, a rich native notice stays unchanged.
const failureNotice = makeNode('Rate limited · resets in 2h', rect(0, 0, 1, 1));
failureNotice.parentElement = composerRegion;
const failureRoot = {
    ...richRoot,
    querySelectorAll(selector) {
        if (selector.startsWith('textarea,')) return [editor];
        if (selector.startsWith('span,')) return [failureNotice];
        return [];
    },
};
context.scmToolkitSyncRateLimitPony(failureRoot);
imageEvents.error();
assert.equal(failureNotice.textContent, 'Rate limited · resets in 2h');
assert.equal(failureNotice.dataset.scmToolkitRateLimitPonyUnavailable, 'true');

// A rich status without buttons still gets its own sticker when it has a timer.
assert.equal(context.scmToolkitIsDetailedRateLimitNotice('Rate Limited · resets in 2h'), true);
assert.equal(context.scmToolkitIsDetailedRateLimitNotice('Rate limited'), false);

// A timed card and a native Upgrade card now qualify for separate stickers.
// The original controls and countdown are never replaced.
const timed = makeNode('Rated Limited · resets in 2h', rect(27, 814, 564, 54));
timed.parentElement = composerRegion;
footerLabel.parentElement = timed;
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, timed);
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).rich, true);
const actionable = makeNode('Rated Limited', rect(27, 814, 564, 54));
actionable.parentElement = composerRegion;
actionable.querySelectorAll = () => [{}];
footerLabel.parentElement = actionable;
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).card, actionable);
assert.equal(context.scmToolkitFooterRateLimitNotice(imageRoot).rich, true);

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
// React can restore the original long no-reset text after the initial build
// substitution. Compact it again on every relevant DOM mutation.
const warningCopy = "You've hit your usage limit. Upgrade your plan or add credits to continue, or Try again later.";
assert.equal(context.scmToolkitIsUntimedRateLimitWarning(warningCopy), true);
assert.equal(context.scmToolkitIsUntimedRateLimitWarning(warningCopy.replace('Try', 'try')), true);
assert.equal(context.scmToolkitIsUntimedRateLimitWarning("You've hit your usage limit. Try again at 3:30 AM."), false);
assert.equal(context.scmToolkitIsUntimedRateLimitWarning('Upgrade your plan or add credits'), false);
const warningParts = [
    {nodeType: 3, textContent: "You've hit your usage limit. "},
    {nodeType: 3, textContent: "Upgrade your plan or add credits to continue, or Try again later."},
];
const retainedIcon = {nodeType: 1, childNodes: []};
const warningParagraph = {
    nodeType: 1,
    childNodes: [retainedIcon, {nodeType: 1, childNodes: warningParts}],
    get textContent() { return warningParts.map(part => part.textContent).join(''); },
    matches: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    parentElement: null,
};
assert.equal(context.scmToolkitCompactUntimedRateLimitNode(warningParagraph), true);
assert.equal(warningParagraph.textContent, 'Rate limited');
assert.equal(retainedIcon.childNodes.length, 0);
assert.equal(context.scmToolkitCompactUntimedRateLimitNode(warningParagraph), false);
warningParts[0].textContent = warningCopy; // Simulated fresh React render
warningParts[1].textContent = '';
const rootForRerender = {nodeType: 9, querySelectorAll: () => [warningParagraph]};
context.scmToolkitCompactUntimedRateLimitBranch(rootForRerender);
assert.equal(warningParagraph.textContent, 'Rate limited');
warningParts[0].textContent = warningCopy;
const textChange = {nodeType: 3, parentElement: warningParagraph};
context.scmToolkitCompactUntimedRateLimitBranch(textChange);
assert.equal(warningParagraph.textContent, 'Rate limited');

// Preserve actionable cards, reset timestamps, and unrelated messages.
warningParts[0].textContent = warningCopy;
warningParagraph.querySelector = () => ({nodeType: 1}); // Native action
assert.equal(context.scmToolkitCompactUntimedRateLimitNode(warningParagraph), false);
assert.equal(warningParagraph.textContent, warningCopy);
warningParagraph.querySelector = () => null;
warningParts[0].textContent = 'Rate limited · resets in 2h';
assert.equal(context.scmToolkitCompactUntimedRateLimitNode(warningParagraph), false);
assert.equal(warningParagraph.textContent, 'Rate limited · resets in 2h');
warningParts[0].textContent = warningCopy;
warningParagraph.closest = () => ({nodeType: 1}); // Editor or dialog
assert.equal(context.scmToolkitCompactUntimedRateLimitNode(warningParagraph), false);
assert.equal(warningParagraph.textContent, warningCopy);

// Check the actual MutationObserver integration: compaction occurs before
// general UI work is placed into a microtask.
const observerText = {nodeType: 3, textContent: warningCopy};
const observerMessage = {
    nodeType: 1,
    childNodes: [observerText],
    get textContent() { return observerText.textContent; },
    matches: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    parentElement: null,
};
observerText.parentElement = observerMessage;
const syntheticDocument = {
    nodeType: 9,
    querySelectorAll(query) {
        return query.startsWith('p, span, div,') ? [observerMessage] : [];
    },
    querySelector: () => null,
};
let mutationCallback = null;
let observedOptions = null;
let queuedSyncCount = 0;
class SyntheticObserver {
    constructor(callback) { mutationCallback = callback; }
    observe(root, options) {
        assert.equal(root, syntheticDocument);
        observedOptions = options;
    }
}
const injectedSource = fs.readFileSync(path.join(__dirname, '../assets/codex/rate-limit-controls.js'), 'utf8');
new Function('document', 'MutationObserver', 'queueMicrotask', 'globalThis', injectedSource)(
    syntheticDocument,
    SyntheticObserver,
    callback => {
        queuedSyncCount++;
        assert.equal(observerMessage.textContent, 'Rate limited');
        callback();
    },
    {},
);
assert.equal(observerMessage.textContent, 'Rate limited');
assert.equal(observedOptions.characterData, true);
assert.equal(observedOptions.childList, true);
assert.equal(typeof mutationCallback, 'function');
observerText.textContent = warningCopy;
mutationCallback([{target: observerText, addedNodes: []}]);
assert.equal(observerMessage.textContent, 'Rate limited');
assert.equal(queuedSyncCount, 2);

// Disabling the optional sticker must preserve compaction and avoid image
// creation or mutating the composer notice into a sticker card.
const disabledContext = vm.createContext({});
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../assets/codex/rate-limit-controls.js'), 'utf8')
        .replace('"__SCM_TOOLKIT_RATE_LIMIT_STICKER_ENABLED__"', 'false'),
    disabledContext
);
const disabledFooter = makeNode('Rate limited', rect(0, 0, 10, 10));
disabledFooter.parentElement = composerRegion;
const disabledLabel = makeNode('Rate limited', rect(0, 0, 10, 10), disabledFooter);
let disabledImages = 0;
const disabledRoot = {
    querySelectorAll(selector) {
        if (selector.startsWith('textarea,')) return [editor];
        if (selector.startsWith('span,')) return [disabledLabel];
        return [];
    },
    createElement() { disabledImages++; throw Error('No images when sticker disabled'); },
};
disabledContext.scmToolkitSyncRateLimitPony(disabledRoot);
assert.equal(disabledImages, 0);
assert.equal(disabledFooter.textContent, 'Rate limited');

console.log('Codex reset shortcut, persistent compact rate-limit text, and composer sticker checks passed.');
