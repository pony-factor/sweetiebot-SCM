'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const message = 'Sweetiebot update ready';
// The signed installer is generated from the canonical workbench assets.
const roots = ['assets/workbench'];

for (const directory of roots) {
  const javascript = fs.readFileSync(path.join(root, directory, 'picker.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, directory, 'picker.css'), 'utf8');
  assert(javascript.includes("row.classList.toggle('scm-toolkit-reload-ready',"), `Missing reload marker in ${directory}`);
  assert(javascript.includes(`text === '${message}'`), `Reload marker should match only the repair notice in ${directory}`);
  assert.match(css, /\.notification-list-item\.scm-toolkit-reload-ready \.notification-list-item-icon\.codicon-info::before\s*\{\s*content: '🤖';/);
  assert.match(css, /\.notification-list-item\.scm-toolkit-reload-ready \.notification-list-item-icon\.codicon-info::before,/);
  assert.match(css, /\.notification-list-item\.scm-toolkit-pr-merged \.notification-list-item-icon\.codicon-info::before\s*\{\s*content: '🎉';/);
  assert.match(css, /\.notification-list-item\.scm-toolkit-pr-queued \.notification-list-item-icon\.codicon-info::before\s*\{\s*content: '⏳';/);

  const start = javascript.indexOf('// Notification rows are reused, so update the marker whenever their message changes.');
  assert(start >= 0, `Missing notification observer in ${directory}`);
  let currentMessage = message;
  let observeMutations;
  const classes = new Set();
  const row = {
    nodeType: 1,
    closest() { return this; },
    querySelector() { return { textContent: currentMessage }; },
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    }
  };
  vm.runInNewContext(javascript.slice(start), {
    Node: { ELEMENT_NODE: 1 },
    document: { querySelectorAll() { return [row]; } },
    MutationObserver: class {
      constructor(callback) { observeMutations = callback; }
      observe() {}
    }
  });
  assert(classes.has('scm-toolkit-reload-ready'), `Robot icon class not added in ${directory}`);
  currentMessage = 'PR #12 merged into main.';
  observeMutations([{ target: row, addedNodes: [] }]);
  assert(classes.has('scm-toolkit-pr-merged'), `Merge icon class not added in ${directory}`);
  assert(!classes.has('scm-toolkit-reload-ready'), `Reused notification retained robot icon in ${directory}`);
  currentMessage = 'PR #12 queued for merge.';
  observeMutations([{ target: row, addedNodes: [] }]);
  assert(classes.has('scm-toolkit-pr-queued'), `Queue icon class not added in ${directory}`);
  assert(!classes.has('scm-toolkit-pr-merged'), `Reused notification retained merge icon in ${directory}`);
  currentMessage = 'Unrelated information notification.';
  observeMutations([{ target: row, addedNodes: [] }]);
  assert(!classes.has('scm-toolkit-reload-ready'), `Reused notification retained robot icon in ${directory}`);
  assert(!classes.has('scm-toolkit-pr-queued'), `Reused notification retained queue icon in ${directory}`);
  assert(!classes.has('scm-toolkit-pr-merged'), `Reused notification retained merge icon in ${directory}`);
}

const refresh = fs.readFileSync(path.join(root, 'efs/codex_refresh.js'), 'utf8');
assert(refresh.includes(`'${message}'`), 'Repair reload notification text changed unexpectedly');
assert(!refresh.includes('🤖'), 'Robot belongs in the notification glyph, not its message');
console.log('Sweetie Bot reload notification robot icon checks passed.');
