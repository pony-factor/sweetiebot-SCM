'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the injected workbench function without requiring VS Code or a browser.
const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('function scmToolkitCustomizeSyncLabels(');
const end = source.indexOf('\nfunction scmToolkitCustomizeCommitButtonLabel(', start);
assert.ok(start >= 0 && end > start, 'Sync label customization must exist');
const sandbox = vm.createContext({});
vm.runInContext(source.slice(start, end), sandbox);

class Element {
  constructor(classes = '', text = '') {
    this.className = classes;
    this.textContent = text;
    this.hidden = false;
    this.parentElement = null;
  }
  get classList() { return {contains: value => this.className.split(' ').includes(value)}; }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    // Like the DOM, previousElementSibling skips intervening text nodes.
    return siblings.slice(0, siblings.indexOf(this)).reverse()
      .find(node => node instanceof Element) || null;
  }
  before(node) {
    const children = this.parentElement.children;
    node.parentElement = this.parentElement;
    children.splice(children.indexOf(this), 0, node);
  }
  remove() {
    const children = this.parentElement.children;
    children.splice(children.indexOf(this), 1);
    this.parentElement = null;
  }
}

function group(...nodes) {
  // Match a real DOM parent: injected labels inspect parentElement.classList.
  const parent = {children: nodes, classList: {contains: () => false}};
  for (const node of nodes) node.parentElement = parent;
  return parent;
}

const incomingCount = new Element('', '2');
const incomingArrow = new Element('codicon codicon-arrow-down');
const outgoingCount = new Element('', '3');
const outgoingArrow = new Element('codicon codicon-arrow-up');
const incomingGroup = group(incomingCount, incomingArrow);
const outgoingGroup = group(outgoingCount, outgoingArrow);
const action = {
  querySelector: selector => selector === '.codicon-sync' ? {} : null,
  querySelectorAll: selector => selector.includes('codicon-arrow-down') ? [incomingArrow] : [outgoingArrow]
};
const root = {querySelectorAll: selector => selector === '.button-container .monaco-button' ? [action] : []};
let observer, configurationListener, disposed = false;
const doc = {
  defaultView: {
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {}
      disconnect() { disposed = true; }
    }
  },
  createElement: () => new Element()
};
const values = {incomingSyncLabel: 'From origin', outgoingSyncLabel: 'To origin'};
const configuration = {
  getValue: key => values[key.split('.').pop()] ?? '',
  onDidChangeConfiguration: callback => {
    configurationListener = callback;
    return {dispose() {}};
  }
};
const widget = {
  element: {closest: () => root, ownerDocument: doc},
  disposables: {add(item) { this.item = item; }}
};
sandbox.scmToolkitCustomizeSyncLabels(widget, configuration, {
  incomingSyncLabel: '', outgoingSyncLabel: '', hideOutgoingSyncCount: true
});
assert.equal(incomingGroup.children[0].textContent, 'From origin\u00a0');
assert.equal(outgoingGroup.children[0].textContent, 'To origin\u00a0');
assert.equal(incomingCount.textContent, '2', 'Incoming Git count remains intact');
assert.equal(outgoingCount.hidden, true, 'Existing hide-outgoing-count behavior remains intact');
assert.equal(outgoingCount.textContent, '3', 'Hidden counts retain their native text for live restoration');
assert.equal(outgoingArrow.previousElementSibling, outgoingCount, 'Native arrows remain adjacent to counts');
values.hideOutgoingSyncArrow = true;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.hideOutgoingSyncArrow'});
assert.equal(outgoingArrow.hidden, true, 'Outgoing arrow can be hidden independently');
assert.equal(incomingArrow.hidden, false, 'Incoming arrow remains visible');
assert.equal(outgoingCount.hidden, true, 'Existing outgoing count preference is unaffected');
values.hideIncomingSyncArrow = true;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.hideIncomingSyncArrow'});
assert.equal(incomingArrow.hidden, true, 'Incoming arrow can also be hidden');
assert.equal(incomingCount.textContent, '2', 'Hiding an arrow retains its Git count');
observer.callback();
assert.equal(incomingArrow.hidden, true, 'Mutation updates preserve arrow visibility');
values.hideOutgoingSyncArrow = false;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.hideOutgoingSyncArrow'});
assert.equal(outgoingArrow.hidden, false, 'Outgoing arrow reappears without recreating Git controls');
assert.equal(incomingArrow.hidden, true, 'Incoming preference is independent');
values.hideIncomingSyncArrow = false;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.hideIncomingSyncArrow'});
assert.equal(incomingArrow.hidden, false, 'Incoming arrow reappears without a reload');
observer.callback();
assert.equal(incomingGroup.children.length, 3, 'Mutation observer must not duplicate custom labels');
values.incomingSyncLabel = 'Fetch';
values.outgoingSyncLabel = '';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.incomingSyncLabel'});
assert.equal(incomingGroup.children[0].textContent, 'Fetch\u00a0');
assert.equal(outgoingGroup.children.length, 2, 'Clearing a name restores native label layout');
values.incomingSyncLabel = '';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.incomingSyncLabel'});
assert.equal(incomingGroup.children.length, 2);
assert.equal(incomingCount.textContent, '2');

// Simulate the transient spinner Git displays while a commit is being pushed.
values.outgoingSyncLabel = 'To origin';
const spinningIcon = new Element('codicon codicon-sync codicon-modifier-spin');
const nativeCaption = {nodeType: 3, textContent: ' Sync Changes'};
const fullCount = new Element('', '4');
const fullArrow = new Element('codicon codicon-arrow-up');
const fullLabel = group(spinningIcon, nativeCaption, fullCount, fullArrow);
fullLabel.childNodes = fullLabel.children;
fullLabel.classList = {contains: name => name === 'monaco-button-label'};
fullLabel.querySelector = selector => selector === '.codicon-sync' ? spinningIcon : null;
const compactCount = new Element('', '4');
const compactArrow = new Element('codicon codicon-arrow-up');
const compactLabel = group(compactCount, compactArrow);
compactLabel.classList = {contains: name => name === 'monaco-button-label-short'};
let showCounts = true;
let showIncoming = false;
const progressAction = {
  querySelector: selector => {
    if (selector === '.codicon-sync') return spinningIcon;
    if (selector === '.monaco-button-label') return fullLabel;
    if (selector === '.codicon-arrow-up') return showCounts ? fullArrow : null;
    if (selector === '.codicon-arrow-down') return showIncoming ? incomingArrow : null;
    return null;
  },
  querySelectorAll: selector => showCounts && selector.includes('codicon-arrow-up')
    ? [fullArrow, compactArrow] : []
};
const progressRoot = {querySelectorAll: () => [progressAction]};
const progressWidget = {
  element: {closest: () => progressRoot, ownerDocument: doc},
  disposables: {add(item) { this.item = item; }}
};
sandbox.scmToolkitCustomizeSyncLabels(progressWidget, configuration, {
  incomingSyncLabel: '', outgoingSyncLabel: '', hideOutgoingSyncCount: false
});
const progressObserver = observer;
assert.equal(nativeCaption.textContent, ' To origin', 'Push spinner shows outgoing name instead of Sync Changes');
assert.equal(fullLabel.children.length, 4, 'Full-size spinner must not duplicate the outgoing name');
assert.equal(compactLabel.children[0].textContent, 'To origin\u00a0', 'Compact spinner keeps direction label');
values.hideOutgoingSyncArrow = true;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.hideOutgoingSyncArrow'});
assert.equal(fullArrow.hidden, true, 'Long sync button hides its outgoing arrow');
assert.equal(compactArrow.hidden, true, 'Compact sync button hides its outgoing arrow');
assert.equal(fullCount.textContent, '4', 'Arrow preference does not erase progress counts');
values.hideOutgoingSyncArrow = false;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.hideOutgoingSyncArrow'});
assert.equal(fullArrow.hidden, false, 'Long sync button arrow is restored');
assert.equal(compactArrow.hidden, false, 'Compact sync button arrow is restored');
progressObserver.callback();
assert.equal(nativeCaption.textContent, ' To origin', 'Repeated mutations are idempotent');
assert.equal(compactLabel.children.length, 3, 'Compact label is not duplicated');

spinningIcon.className = 'codicon codicon-sync';
progressObserver.callback();
assert.equal(nativeCaption.textContent, ' To origin', 'Custom caption remains after push');
assert.equal(fullLabel.children.length, 4, 'Normal caption must not duplicate the outgoing name');

spinningIcon.className = 'codicon codicon-sync codicon-modifier-spin';
values.outgoingSyncLabel = 'To remote';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.outgoingSyncLabel'});
assert.equal(nativeCaption.textContent, ' To remote', 'Spinner picks up live name changes');
values.outgoingSyncLabel = '';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.outgoingSyncLabel'});
assert.equal(nativeCaption.textContent, ' Sync Changes', 'Clearing custom name restores native caption');

values.outgoingSyncLabel = 'To origin';
values.postCommitCommand = 'push';
showCounts = false;
configurationListener({affectsConfiguration: key => key === 'scmToolkit.outgoingSyncLabel'});
assert.equal(nativeCaption.textContent, ' To origin', 'Commit-and-push spinner works before counts appear');
values.postCommitCommand = 'none';
configurationListener({affectsConfiguration: key => key === 'git.postCommitCommand'});
assert.equal(nativeCaption.textContent, ' Sync Changes', 'No-count fallback only applies to push configuration');
// Match the real Git markup: the full caption and count share a span.
showCounts = true;
values.outgoingSyncLabel = 'Flight 80';
nativeCaption.textContent = ' Sync Changes 7';
progressObserver.callback();
assert.equal(nativeCaption.textContent, ' Flight 80 7');
nativeCaption.textContent = ' Sync Changes 9';
progressObserver.callback();
assert.equal(nativeCaption.textContent, ' Flight 80 9', 'Git updates replace the saved native caption');
values.outgoingSyncLabel = '';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.outgoingSyncLabel'});
assert.equal(nativeCaption.textContent, ' Sync Changes 9', 'Clearing restores the latest native count');

// Mixed incoming/outgoing sync captions belong to the arrow beside the span.
showIncoming = true;
values.incomingSyncLabel = 'Fetch';
values.outgoingSyncLabel = 'Send';
nativeCaption.nextElementSibling = incomingArrow;
nativeCaption.textContent = ' Sync Changes 5';
progressObserver.callback();
assert.equal(nativeCaption.textContent, ' Fetch 5', 'Mixed sync renames its incoming caption and preserves its count');
assert.equal(compactLabel.children[0].textContent, 'Send\u00a0', 'Mixed sync retains its outgoing name');
values.incomingSyncLabel = 'Receive';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.incomingSyncLabel'});
assert.equal(nativeCaption.textContent, ' Receive 5', 'Incoming name responds to preference changes');
showCounts = false;
progressObserver.callback();
assert.equal(nativeCaption.textContent, ' Receive 5', 'Incoming-only sync uses the incoming name');
values.incomingSyncLabel = '';
configurationListener({affectsConfiguration: key => key === 'scmToolkit.incomingSyncLabel'});
assert.equal(nativeCaption.textContent, ' Sync Changes 5', 'Clearing incoming name restores native caption');
showIncoming = false;
showCounts = true;
delete nativeCaption.nextElementSibling;
nativeCaption.textContent = ' Sync Changes 9';
progressWidget.disposables.item.dispose();

// The input may be detached when VS Code constructs it.
let attached = false;
const lateWidget = {
  element: {closest: () => attached ? progressRoot : null, ownerDocument: doc},
  disposables: {add(item) { this.item = item; }}
};
values.outgoingSyncLabel = 'Flight 80';
sandbox.scmToolkitCustomizeSyncLabels(lateWidget, configuration, {
  incomingSyncLabel: '', outgoingSyncLabel: '', hideOutgoingSyncCount: true
});
const lateObserver = observer;
attached = true;
lateObserver.callback();
assert.equal(nativeCaption.textContent, ' Flight 80', 'Late attachment applies name and hides native count');
lateObserver.callback();
assert.equal(nativeCaption.textContent, ' Flight 80', 'Digits in custom names survive repeated updates');
lateWidget.disposables.item.dispose();

widget.disposables.item.dispose();
assert.equal(disposed, true);
// Commit preferences must leave both sync captions intact.
const commitEnd = source.indexOf('\nfunction scmToolkitCustomizeMessagePlaceholder(', end);
vm.runInContext(source.slice(end, commitEnd), sandbox);
const shortCaption = {textContent: '1'};
const button = {querySelector: selector => selector === '.codicon-sync' ? spinningIcon : shortCaption};
const commitRoot = {querySelector: () => button};
const commitWidget = {
  element: {closest: selector => selector === '.scm-view' ? commitRoot : null, ownerDocument: doc},
  disposables: {add(item) { this.item = item; }}
};
sandbox.scmToolkitCustomizeCommitButtonLabel(commitWidget, configuration, 'Commit', 'Dash');
assert.equal(shortCaption.textContent, '1', 'Commit label override must not overwrite compact sync label');
button.querySelector = selector => selector === '.codicon-sync' ? null : shortCaption;
observer.callback();
assert.equal(shortCaption.textContent, 'Commit', 'Actual commit buttons still receive their custom name');
commitWidget.disposables.item.dispose();
console.log('Custom sync direction label checks passed.');
