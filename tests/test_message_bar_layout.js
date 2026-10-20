'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ scmToolkitCreateControls() {} });
vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../assets/workbench/message_bar.js'), 'utf8'), context);

function normalize(layout) {
    context.savedLayout = JSON.stringify(layout);
    return JSON.parse(vm.runInContext(
        'JSON.stringify(scmToolkitMessageBarLayout(savedLayout))', context));
}

// Omitted controls are in Available buttons, including on older saved layouts.
for (const layout of [
    { before: ['home', 'branch'], after: ['push', 'sync', 'spellcheck', 'codex'] },
    { before: [], after: [] },
    { before: ['post-spellcheck', 'branch'], after: ['push', 'codex'] },
    { before: ['branch'], after: ['push', 'codex', 'post-spellcheck'] },
]) {
    assert.deepEqual(normalize(layout), layout);
}

console.log('message bar saved placement tests passed');
