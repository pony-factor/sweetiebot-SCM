'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {spellcheckDiffFiles} = require('../efs/spellcheck_diff');

for (const closingAction of ['dismiss', 'correction', 'line', 'edit']) {
test('popup safely renders and restores focus after closing via ' + closingAction, async () => {
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
      setAttribute(name, value) { (this.attributes ||= {})[name] = value; }, append(...children) { this.children.push(...children); },
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
  const patch = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-<speling>\n+<spelling>\n'
    + 'diff --git a/b.md b/b.md\n--- a/b.md\n+++ b/b.md\n@@ -1 +1 @@\n-speling\n+spelling\n';
  const preview = {sessionId: 'session', title: 'Spellcheck suggestions', message: '🤖 Spellcheck trading citations and notes', html: '', files: spellcheckDiffFiles(patch)};
  preview.files[0].rows.find(row => row.kind === 'add').editId = 'line';
  preview.files[1].rows.find(row => row.kind === 'add').editId = 'line-b';
  preview.files[0].rows.find(row => row.kind === 'add').changes = [
    {start: 0, end: 10, before: '<speling>', after: '<spelling>', changeId: 'change-a'}
  ];
  preview.files[1].rows.find(row => row.kind === 'add').changes = [
    {start: 0, end: 8, before: 'speling', after: 'spelling', changeId: 'change-b'}
  ];
  const saved = [];
  const undone = [];
  const accepted = [];
  const closed = [];
  let updatedPreview = preview;
  context.scmToolkitWatchSpellcheckPopups(doc, {async executeCommand(id, ...args) {
    if (id === 'sweetiebot.closeSpellcheckPopup') { closed.push(args); return; }
    if (id === 'sweetiebot.saveSpellcheckEdit') { saved.push(args); return updatedPreview; }
    if (id === 'sweetiebot.undoSpellcheckChange') { undone.push(args); return updatedPreview; }
    if (id === 'sweetiebot.finishSpellcheckPreview') { accepted.push(args); throw new Error('Fixture commit rejected'); }
    assert.equal(id, 'sweetiebot.takeSpellcheckPopup'); calls++; return calls === 1 ? preview : undefined;
  }});
  await new Promise(setImmediate);
  context.scmToolkitWatchSpellcheckPopups(doc, {});
  const dialog = elements.find(node => node.tag === 'dialog');
  assert.equal(dialog.open, true);
  assert.equal(elements.some(node => node.tag === 'iframe'), false);
  assert(elements.some(node => node.className === 'changed-token' && node.textContent === '<spelling>'));
  const inlineArrow = elements.find(node => node.className === 'scm-toolkit-spellcheck-undo');
  assert.equal(inlineArrow.textContent, '↶');
  assert.match(inlineArrow.attributes['aria-label'], /^Revert correction/);
  const wholeLineArrow = elements.find(node => node.className === 'scm-toolkit-spellcheck-revert-line');
  assert.equal(wholeLineArrow.textContent, '↶');
  assert.match(wholeLineArrow.attributes['aria-label'], /^Revert all corrections/);
  const editable = elements.find(node => node.tabIndex === 0);
  assert(editable);
  editable.events.click();
  const editor = elements.find(node => node.className === 'scm-toolkit-spellcheck-line-editor');
  assert.equal(editor.value, '<spelling>');
  editor.value = '<edited>\nsecond line';
  editor.events.blur();
  await new Promise(setImmediate);
  assert.deepEqual(saved, [['session', 'line', '<edited>\nsecond line']]);
  assert(elements.some(node => node.textContent === 'Saved'));
  const latestToggle = name => elements.filter(node =>
    node.className === 'scm-toolkit-spellcheck-file-toggle' && node.textContent.includes(name)).at(-1);
  const aToggle = latestToggle('a.md');
  aToggle.events.click();
  assert.equal(aToggle.attributes?.['aria-expanded'], 'false');
  const secondUndo = elements.filter(node => node.className === 'scm-toolkit-spellcheck-undo'
    && node.title.includes('"speling"')).at(-1);
  secondUndo.events.click({stopPropagation() {}});
  await new Promise(setImmediate);
  assert.deepEqual(undone, [['session', 'change-b']]);
  assert.equal(latestToggle('a.md').textContent.startsWith('▸'), true,
    'refresh preserves the first file collapsed while reviewing the next');
  const newToggle = latestToggle('a.md');
  newToggle.events.click();
  assert.equal(newToggle.textContent.startsWith('▾'), true);
  const revertLine = elements.filter(node => node.className === 'scm-toolkit-spellcheck-revert-line'
    && node.title.includes('a.md')).at(-1);
  revertLine.events.click({stopPropagation() {}});
  await new Promise(setImmediate);
  assert.deepEqual(saved.at(-1), ['session', 'line', '<speling>']);
  assert(elements.some(node => node.textContent === 'Line reverted'));
  const message = elements.find(node => node.className === 'scm-toolkit-spellcheck-message');
  assert.equal(message.value, preview.message);
  message.value = '🖊️ Use my revised commit message';
  message.events.input();
  const actions = elements.find(node => node.tag === 'footer');
  assert.deepEqual(actions.children.map(node => node.textContent), ['Revert', 'Accept']);
  actions.children[1].events.click();
  await new Promise(setImmediate);
  assert.deepEqual(accepted, [['session', 'accept', message.value]]);
  assert.equal(dialog.open, true, 'failed commit keeps the popup open');
  assert(elements.some(node => node.textContent === 'Fixture commit rejected'));
  await timer();
  assert.equal(calls, 1);
  updatedPreview = {...preview, files: []};
  if (closingAction === 'dismiss') {
    dialog.events.click({target: dialog, clientX: 50, clientY: 50});
  } else if (closingAction === 'edit') {
    elements.filter(node => node.tabIndex === 0).at(-1).events.click();
    const lastEditor = elements.filter(node => node.className === 'scm-toolkit-spellcheck-line-editor').at(-1);
    lastEditor.value = 'speling';
    lastEditor.events.blur();
  } else {
    const className = closingAction === 'line' ? 'scm-toolkit-spellcheck-revert-line' : 'scm-toolkit-spellcheck-undo';
    elements.filter(node => node.className === className).at(-1).events.click({stopPropagation() {}});
  }
  await new Promise(setImmediate);
  assert.equal(dialog.open, false);
  assert.equal(dialog.removed, true);
  assert.equal(previousFocus.focused, true);
  assert.deepEqual(closed, [['session']]);
  assert.equal(accepted.length, 1, 'automatic closure must not commit or revert files again');
  await timer();
  assert.equal(calls, 2);
});
}
