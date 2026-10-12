'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {spellcheckDiffFiles} = require('../efs/spellcheck_diff');

test('popup renders safe text, consumes once per document, and restores focus on dismissal', async () => {
  const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
  const start = source.indexOf('const scmToolkitSpellcheckDocuments');
  const end = source.indexOf('function scmToolkitCreateControls(', start);
  const context = vm.createContext({WeakSet});
  vm.runInContext(source.slice(start, end), context);
  const elements = [];
  const element = tag => {
    const node = {tag, children: [], events: {}, isConnected: true,
      style: {setProperty() {}}, classList: {add() {}},
      replaceChildren(...children) { this.children = children; },
      setAttribute() {}, append(...children) { this.children.push(...children); },
      addEventListener(name, callback) { this.events[name] = callback; },
      showModal() { this.open = true; }, close() { this.open = false; this.events.close(); },
      remove() { this.removed = true; }, focus() { this.focused = true; },
      getBoundingClientRect() { return {left: 100, right: 800, top: 100, bottom: 700}; }
    };
    Object.defineProperty(node, 'innerHTML', {set() { throw Error('Unsafe HTML sink'); }});
    elements.push(node);
    return node;
  };
  let timer, calls = 0;
  const previousFocus = element('input');
  const doc = {activeElement: previousFocus, body: element('body'), createElement: element,
    defaultView: {setInterval(callback) { assert.equal(timer, undefined); timer = callback; }}
  };
  const patch = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-<speling>\n+<spelling>\n';
  const preview = {sessionId: 'session', title: 'Spellcheck suggestions', html: '', files: spellcheckDiffFiles(patch)};
  preview.files[0].rows.find(row => row.kind === 'add').editId = 'line';
  const saved = [];
  context.scmToolkitWatchSpellcheckPopups(doc, {async executeCommand(id, ...args) {
    if (id === 'sweetiebot.closeSpellcheckPopup') return;
    if (id === 'sweetiebot.saveSpellcheckEdit') { saved.push(args); return preview; }
    assert.equal(id, 'sweetiebot.takeSpellcheckPopup'); calls++; return calls === 1 ? preview : undefined;
  }});
  await new Promise(setImmediate);
  context.scmToolkitWatchSpellcheckPopups(doc, {});
  const dialog = elements.find(node => node.tag === 'dialog');
  assert.equal(dialog.open, true);
  assert.equal(elements.some(node => node.tag === 'iframe'), false);
  assert(elements.some(node => node.className === 'changed-token' && node.textContent === 'l'));
  const editable = elements.find(node => node.tabIndex === 0);
  assert(editable);
  editable.events.click();
  const editor = elements.find(node => node.tag === 'textarea');
  assert.equal(editor.value, '<spelling>');
  editor.value = '<edited>\nsecond line';
  editor.events.blur();
  await new Promise(setImmediate);
  assert.deepEqual(saved, [['session', 'line', '<edited>\nsecond line']]);
  assert(elements.some(node => node.textContent === 'Saved'));
  await timer();
  assert.equal(calls, 1);
  dialog.events.click({target: dialog, clientX: 50, clientY: 50});
  await new Promise(setImmediate);
  assert.equal(dialog.removed, true);
  assert.equal(previousFocus.focused, true);
  await timer();
  assert.equal(calls, 2);
});
