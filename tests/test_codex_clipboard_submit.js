const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
const document = { body: {}, querySelectorAll: () => [] };
vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, '../assets/codex/codex-clipboard-submit.js'), 'utf8'
), { globalThis: { __SCM_TOOLKIT_CLIPBOARD_TEST__: hooks }, document });

function button(name, type = 'button', disabled = false) {
    return {
        id: '',
        type,
        disabled,
        isConnected: true,
        getClientRects: () => [1],
        textContent: '',
        getAttribute: key => key === 'aria-label' ? name : null,
    };
}
const send = button('Send message');
const queue = button('Queue message');
const stop = button('Stop response');
assert.equal(hooks.classify(send), 'send');
assert.equal(hooks.classify(queue), 'queue');
assert.equal(hooks.classify(stop), '');
assert.equal(hooks.chooseAction([send, stop], false), send);
assert.equal(hooks.chooseAction([send, stop, queue], true), queue);
assert.equal(hooks.chooseAction([send, stop], true), send, 'native default queues active follow-ups');
assert.equal(hooks.chooseAction([button('Send', 'submit', true)], false), null);
assert.equal(hooks.chooseAction([button('Stop and send')], true), null, 'never select interruption');

// The clipboard button must remain available for an empty existing chat and
// while Stop replaces Send during a running turn.
const disabledSend = button('Send message', 'submit', true);
const disabledAriaSend = button('Send message');
disabledAriaSend.getAttribute = key => key === 'aria-label' ? 'Send message'
    : key === 'aria-disabled' ? 'true' : null;
assert.equal(hooks.classify(disabledSend), '');
assert.equal(hooks.classify(disabledAriaSend), '');
assert.equal(hooks.chooseMountTarget([disabledSend], false), disabledSend);
assert.equal(hooks.chooseMountTarget([disabledAriaSend], false), disabledAriaSend);
assert.equal(hooks.chooseMountTarget([stop], true), stop);
assert.equal(hooks.chooseMountTarget([stop, disabledSend], true), stop);
assert.equal(hooks.chooseMountTarget([stop, queue], true), queue);
assert.equal(hooks.chooseAction([stop], true), null, 'never click Stop instead of queueing');

// Exercise the composer search as well as the target selector: the original
// bug dropped the entire composer surface when Send was disabled or absent.
function surfaceWith(buttons) {
    const editor = { isConnected: true, getClientRects: () => [1] };
    const root = {
        parentElement: document.body,
        querySelectorAll: selector => selector === 'button' ? buttons : [editor],
        querySelector: () => null,
    };
    editor.parentElement = root;
    document.querySelectorAll = selector => selector.startsWith('textarea:') ? [editor] : [];
    const result = hooks.findSurface();
    assert.equal(result.editor, editor);
    return result;
}
assert.equal(surfaceWith([disabledSend]).mountTarget, disabledSend);
assert.equal(surfaceWith([stop]).mountTarget, stop);
assert.equal(surfaceWith([stop, queue]).mountTarget, queue);
console.log('Codex clipboard button action-selection checks passed.');
