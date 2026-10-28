'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const listeners = new Map();
let style, activate, removed = false, styleWrites = 0;
const window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, listener, capture) {
        assert.equal(capture, true);
        listeners.set(type, listener);
    },
    removeEventListener(type, listener, capture) {
        assert.equal(capture, true);
        assert.equal(listeners.get(type), listener);
        listeners.delete(type);
    },
};
const document = {
    createElement: () => {
        let disabled;
        return {
            get disabled() { return disabled; },
            set disabled(value) { styleWrites++; disabled = value; },
            remove() { removed = true; },
        };
    },
    head: { appendChild(element) { style = element; } },
};
vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workbench/codex_file_drag.js'), 'utf8'), {
    window, document,
    globalThis: { __sweetiebotWorkbenchComponents: {
        register(name, callback) {
            assert.equal(name, 'codex-file-drag');
            activate = callback;
        }
    } }
});
assert.equal(style, undefined, 'Registration must not install the component before activation');
const component = activate({ window, document });
const fileDrag = { dataTransfer: { types: ['Files'], items: [], files: [] } };
assert.equal(style.disabled, true);
assert.match(style.textContent, /extensionId=openai\.chatgpt&/);
assert.match(style.textContent, /pointer-events:auto!important/,
    'file drags override the host inline pointer-events:none');
listeners.get('dragenter')(fileDrag);
assert.equal(style.disabled, false, 'protected file drags work before files are readable');
const writesWhileDragging = styleWrites;
for (let index = 0; index < 100; index++) listeners.get('dragover')(fileDrag);
assert.equal(styleWrites, writesWhileDragging, 'repeated file dragovers must not rewrite CSS');
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
const writesWhileIdle = styleWrites;
for (let index = 0; index < 100; index++) listeners.get('mousemove')({});
assert.equal(styleWrites, writesWhileIdle, 'ordinary mouse movement must not rewrite CSS');
listeners.get('dragover')({ dataTransfer: { types: { contains: type => type === 'Files' } } });
assert.equal(style.disabled, false, 'DOMStringList file types are recognized without copying');
listeners.get('dragover')({ dataTransfer: { items: [{ kind: 'file' }] } });
assert.equal(style.disabled, false, 'file items also identify external drags');
component.dispose();
assert.equal(removed, true, 'Unloading the component removes its style');
assert.equal(listeners.size, 0, 'Unloading the component releases event listeners');
console.log('Codex workbench file-drag lifecycle checks passed.');
