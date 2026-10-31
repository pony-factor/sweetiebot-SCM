'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '../assets/workbench/graph_commit_actions.js'), 'utf8');

const context = vm.createContext({});
vm.runInContext(script, context);
const customize = context.scmToolkitGraphCommitActions;
const original = { id: 'workbench.scm.action.graph.viewChanges', label: 'Open Changes',
  class: 'codicon codicon-diff-multiple', run() { throw Error('Opened diff unexpectedly'); } };
const another = { id: 'other.action', label: 'Other' };
let call;
const hover = { showInstantHover(options, focus) { call = { options, focus }; return 'shown'; } };
const row = { tagName: 'DIV' };
const content = { value: '**Native commit metadata**' };
const options = { position: { hoverPosition: 1 }, appearance: { compact: true } };
const actions = customize([original, another], hover, row, content, options);
assert.equal(actions.length, 2);
assert.strictEqual(actions[1], another);
assert.equal(actions[0].label, 'Open Commit');
assert.equal(actions[0].tooltip, 'Open Commit');
assert.equal(actions[0].class, 'codicon codicon-git-commit');
assert.equal(actions[0].run(), 'shown');
assert.strictEqual(call.options.target, row);
assert.strictEqual(call.options.content, content);
assert.equal(call.focus, true);
assert.deepEqual(JSON.parse(JSON.stringify(call.options.appearance)), { compact: true });
assert.equal(original.label, 'Open Changes', 'Preserve original context menu action');
assert.notStrictEqual(actions[0], original);
assert.strictEqual(customize([original], {}, row, content, options)[0], original,
  'Unsupported hover API must retain native Open Changes');
console.log('Source Control Graph Open Commit inline action checks passed.');
