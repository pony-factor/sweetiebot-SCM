'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const attach = source.slice(source.indexOf('function scmToolkitAttachCommitSettings('),
  source.indexOf('async function scmToolkitPullCleanRepository('));

for (const initiallyAttached of [false, true]) {
  let attached = initiallyAttached;
  let callback;
  let observed;
  let disposed;
  let index = 0;
  let dropdown;
  let singleButton;
  const documentRoot = {};
  const classes = new Set();
  const singleClasses = new Set();
  const actionContainer = {
    classList: {
      add: value => singleClasses.add(value),
      remove: (...values) => values.forEach(value => singleClasses.delete(value))
    },
    querySelector(selector) {
      if (selector === ':scope > .monaco-button-dropdown') return dropdown;
      if (selector === ':scope > .monaco-button') return singleButton;
      throw Error(`Unexpected action selector: ${selector}`);
    },
    append(button) { button.parentElement = this; }
  };
  const makeDropdown = () => ({
    classList: { add: value => classes.add(value), remove: (...values) => values.forEach(value => classes.delete(value)) },
    append(button) { button.parentElement = this; }
  });
  dropdown = makeDropdown();
  const rows = { querySelector(selector) {
    assert.equal(selector, `.monaco-list-row[data-index="${index + 1}"]`);
    return { querySelector(selector) {
      assert.equal(selector, '.button-container');
      return actionContainer;
    } };
  } };
  const row = { parentElement: rows, getAttribute() { return String(index); } };
  const root = {};
  const widget = {
    element: {
      ownerDocument: {
        documentElement: documentRoot,
        defaultView: { MutationObserver: class {
          constructor(fn) { callback = fn; }
          observe(target) { observed = target; }
          disconnect() { observed = undefined; }
        } }
      },
      closest(selector) { return attached ? (selector === '.scm-view' ? root : row) : null; },
      classList: { remove() {} },
      append(button) { button.parentElement = this; }
    },
    layout() {},
    disposables: { add(value) { disposed = value; } }
  };
  const button = { parentElement: null, remove() { this.parentElement = null; } };
  const context = vm.createContext({ widget, button });
  vm.runInContext(attach + '\nscmToolkitAttachCommitSettings(widget, button);', context);
  assert.equal(observed, initiallyAttached ? root : documentRoot);
  if (!initiallyAttached) {
    assert.equal(button.parentElement, widget.element,
      'Keep the wand available inline until VS Code mounts the action row');
    attached = true;
    callback();
  }
  assert.equal(observed, root, 'Stop observing the document after the sidebar appears');
  assert.equal(button.parentElement, dropdown, 'Attach after the input row is mounted');
  assert(classes.has('scm-toolkit-commit-settings'));
  callback();
  assert.equal(button.parentElement, dropdown, 'Repeated mutations preserve placement');
  dropdown.getClientRects = () => [];
  callback();
  assert.equal(button.parentElement, widget.element, 'An actually hidden action temporarily keeps settings reachable');
  dropdown.getClientRects = () => [{}];
  callback();
  assert.equal(button.parentElement, dropdown);
  dropdown = null;
  singleButton = { getClientRects: () => [{}] };
  callback();
  assert.equal(button.parentElement, actionContainer,
    'Native Sync receives the same enclosed wand as the Commit dropdown');
  assert(singleClasses.has('scm-toolkit-commit-settings'));
  assert(singleClasses.has('scm-toolkit-single-action-settings'));
  assert(!classes.has('scm-toolkit-commit-settings'));

  singleButton.getClientRects = () => [];
  callback();
  assert.equal(button.parentElement, widget.element,
    'Hidden Sync actions temporarily fall back to the message toolbar');
  assert(!singleClasses.has('scm-toolkit-single-action-settings'));

  singleButton.getClientRects = () => [{}];
  callback();
  assert.equal(button.parentElement, actionContainer,
    'The wand reattaches when Sync returns without a dropdown');
  singleButton = null;
  callback();
  assert.equal(button.parentElement, widget.element,
    'Fall back to the input toolbar when VS Code recycles all native actions');
  assert(!singleClasses.has('scm-toolkit-commit-settings'));
  index = 4;
  dropdown = makeDropdown();
  callback();
  assert.equal(button.parentElement, dropdown, 'Follow recycled action rows');
  disposed.dispose();
  assert.equal(observed, undefined);
  assert.equal(button.parentElement, null);
  assert(!classes.has('scm-toolkit-commit-settings'));
  assert(!singleClasses.has('scm-toolkit-single-action-settings'));
}

for (const actionCount of [1, 2]) {
  let callback;
  const containers = Array.from({ length: actionCount }, () => {
    const classes = new Set();
    const nativeSync = { getClientRects: () => [{}] };
    return {
      classes,
      classList: {
        add: value => classes.add(value),
        remove: (...values) => values.forEach(value => classes.delete(value))
      },
      querySelector(selector) {
        if (selector === ':scope > .monaco-button-dropdown') return null;
        if (selector === ':scope > .monaco-button') return nativeSync;
        throw Error('Unexpected selector: ' + selector);
      },
      append(button) { button.parentElement = this; }
    };
  });
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, '.button-container');
      return containers;
    }
  };
  // VS Code inserts an unrelated row: the native action is no longer at
  // the hard-coded index + 1 used by the original attachment logic.
  const row = {
    parentElement: { querySelector() { return null; } },
    getAttribute() { return '0'; }
  };
  const widget = {
    element: {
      ownerDocument: {
        documentElement: {},
        defaultView: { MutationObserver: class {
          constructor(onChange) { callback = onChange; }
          observe() {}
          disconnect() {}
        } }
      },
      closest(selector) { return selector === '.scm-view' ? root : row; },
      append(button) { button.parentElement = this; }
    },
    layout() {},
    disposables: { add() {} }
  };
  const button = { parentElement: null, remove() { this.parentElement = null; } };
  vm.runInNewContext(attach + '\nscmToolkitAttachCommitSettings(widget, button);', { widget, button });
  assert.equal(button.parentElement, actionCount === 1 ? containers[0] : widget.element,
    'Attach Sync when its native action is unique; do not guess between providers');
  assert.equal(containers[0].classes.has('scm-toolkit-single-action-settings'), actionCount === 1);
  callback();
  assert.equal(button.parentElement, actionCount === 1 ? containers[0] : widget.element);
}

console.log('Commit settings attachment tests passed');
