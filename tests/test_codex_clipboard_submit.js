const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
const document = { body: {}, querySelectorAll: () => [] };
let clipboardText = '';
let timeoutTicks = 0;
let onTimeout = () => {};
const navigator = { clipboard: { readText: async () => clipboardText } };
vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, '../assets/codex/codex-clipboard-submit.js'), 'utf8'
), {
    globalThis: { __SCM_TOOLKIT_CLIPBOARD_TEST__: hooks },
    document,
    navigator,
    Event: class { constructor(type) { this.type = type; } },
    setTimeout(resolve) {
        timeoutTicks++;
        onTimeout();
        queueMicrotask(resolve);
    },
    requestAnimationFrame: () => {},
});

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


// Exercise the actual asynchronous clipboard path, not only action selection.
// A populated new-chat composer must be replaced and automatically submitted
// even when React initially leaves Send disabled.
async function runClipboardChecks() {
    let nativeClicks = 0;
    let inputValues = [];
    const submit = button('Send message', 'submit', true);
    const editor = {
        value: 'old text on new-chat page',
        isConnected: true,
        getClientRects: () => [1],
        querySelector: () => null,
        dispatchEvent(event) {
            assert.equal(event.type, 'input');
            inputValues.push(this.value);
        },
    };
    const root = {
        isConnected: true,
        parentElement: document.body,
        querySelectorAll: selector => selector === 'button' ? [submit] : [editor],
        querySelector: () => null,
    };
    editor.parentElement = root;
    document.querySelectorAll = selector => selector.startsWith('textarea:') ? [editor] : [];
    submit.click = () => {
        nativeClicks++;
        editor.value = ''; // Codex clears its submitted message.
    };
    const clipboardButton = {
        disabled: false,
        title: '',
        setAttribute() {},
    };
    clipboardText = 'replace me with clipboard text';
    timeoutTicks = 0;
    onTimeout = () => { if (timeoutTicks === 4) submit.disabled = false; };
    await hooks.sendClipboard(clipboardButton);
    assert.equal(nativeClicks, 1, 'automatically clicks Send when it becomes ready');
    assert.deepEqual(inputValues, [clipboardText], 'overwrites the prefilled draft');
    assert.equal(editor.value, '', 'does not restore the old draft after sending');
    assert.equal(clipboardButton.disabled, false);

    // When Send never becomes enabled, do not click an unrelated control
    // or quietly revert to the prior draft. Leave the clipboard visible.
    editor.value = 'different existing draft';
    submit.disabled = true;
    clipboardText = 'another clipboard message';
    inputValues = [];
    timeoutTicks = 0;
    onTimeout = () => {};
    await hooks.sendClipboard(clipboardButton);
    assert.equal(timeoutTicks, 25, 'waits for React to enable native Send');
    assert.equal(nativeClicks, 1, 'never clicks a disabled Send control');
    assert.equal(editor.value, clipboardText, 'leaves the replacement text for manual submission');
    assert.match(clipboardButton.title, /not ready/);

    // Preserve rich context (attachments or mentions), which cannot be
    // safely represented by clipboard plain text.
    editor.value = 'draft with attachment';
    editor.querySelector = () => ({});
    clipboardText = 'must not replace attachment';
    await hooks.sendClipboard(clipboardButton);
    assert.equal(editor.value, 'draft with attachment');
    assert.equal(nativeClicks, 1);
}
runClipboardChecks().then(() => console.log('Codex clipboard submission checks passed.')).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
