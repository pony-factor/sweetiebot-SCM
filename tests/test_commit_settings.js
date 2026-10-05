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
  const documentRoot = {};
  const classes = new Set();
  const makeDropdown = () => ({
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    append(button) { button.parentElement = this; }
  });
  dropdown = makeDropdown();
  const rows = { querySelector(selector) {
    assert.equal(selector, `.monaco-list-row[data-index="${index + 1}"]`);
    return { querySelector() { return dropdown; } };
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
      closest(selector) { return attached ? (selector === '.scm-view' ? root : row) : null; }
    },
    disposables: { add(value) { disposed = value; } }
  };
  const button = { parentElement: null, remove() { this.parentElement = null; } };
  const context = vm.createContext({ widget, button });
  vm.runInContext(attach + '\nscmToolkitAttachCommitSettings(widget, button);', context);
  assert.equal(observed, initiallyAttached ? root : documentRoot);
  if (!initiallyAttached) {
    assert.equal(button.parentElement, null);
    attached = true;
    callback();
  }
  assert.equal(observed, root, 'Stop observing the document after the sidebar appears');
  assert.equal(button.parentElement, dropdown, 'Attach after the input row is mounted');
  assert(classes.has('scm-toolkit-commit-settings'));
  callback();
  assert.equal(button.parentElement, dropdown, 'Repeated mutations preserve placement');
  index = 4;
  dropdown = makeDropdown();
  callback();
  assert.equal(button.parentElement, dropdown, 'Follow recycled action rows');
  disposed.dispose();
  assert.equal(observed, undefined);
  assert.equal(button.parentElement, null);
  assert(!classes.has('scm-toolkit-commit-settings'));
}
console.log('Commit settings attachment tests passed');
