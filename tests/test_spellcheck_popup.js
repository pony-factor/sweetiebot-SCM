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
  const preview = {title: 'Spellcheck suggestions', html: '', files: spellcheckDiffFiles(patch)};
  context.scmToolkitWatchSpellcheckPopups(doc, {async executeCommand(id) {
    assert.equal(id, 'sweetiebot.takeSpellcheckPopup'); calls++; return calls === 1 ? preview : undefined;
  }});
  await new Promise(setImmediate);
  context.scmToolkitWatchSpellcheckPopups(doc, {});
  const dialog = elements.find(node => node.tag === 'dialog');
  assert.equal(dialog.open, true);
  assert.equal(elements.some(node => node.tag === 'iframe'), false);
  assert(elements.some(node => node.className === 'changed-token' && node.textContent === 'l'));
  await timer();
  assert.equal(calls, 1);
  dialog.events.click({target: dialog, clientX: 50, clientY: 50});
  assert.equal(dialog.removed, true);
  assert.equal(previousFocus.focused, true);
  await timer();
  assert.equal(calls, 2);
});
