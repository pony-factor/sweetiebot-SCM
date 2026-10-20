'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const listeners = new Map();
let style;
const window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, listener, capture) {
        assert.equal(capture, true);
        listeners.set(type, listener);
    },
};
const document = {
    createElement: () => ({}),
    head: { appendChild(element) { style = element; } },
};
vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workbench/codex_file_drag.js'), 'utf8'), { window, document });
const fileDrag = { dataTransfer: { types: ['Files'], items: [], files: [] } };
assert.equal(style.disabled, true);
assert.match(style.textContent, /extensionId=openai\.chatgpt&/);
assert.match(style.textContent, /pointer-events:auto!important/,
    'file drags override the host inline pointer-events:none');
listeners.get('dragenter')(fileDrag);
assert.equal(style.disabled, false, 'protected file drags work before files are readable');
listeners.get('dragleave')({ relatedTarget: null, clientX: 700, clientY: 400 });
assert.equal(style.disabled, false, 'crossing into the iframe keeps it reachable');
listeners.get('dragleave')({ relatedTarget: null, clientX: 1000, clientY: 400 });
assert.equal(style.disabled, true, 'leaving the window restores normal iframe handling');
for (const type of ['drop', 'dragend', 'blur', 'mousedown', 'mousemove']) {
    listeners.get('dragover')(fileDrag);
    assert.equal(style.disabled, false, 'returning from the editor re-enables file drops');
    listeners.get(type)({});
    assert.equal(style.disabled, true, `${type} cleans up the file drag override`);
}
listeners.get('dragover')({ dataTransfer: { types: ['text/plain'] } });
assert.equal(style.disabled, true, 'text and layout drags retain native behavior');
listeners.get('dragover')({ dataTransfer: { items: [{ kind: 'file' }] } });
assert.equal(style.disabled, false, 'file items also identify external drags');
console.log('Codex workbench file-drag checks passed.');
