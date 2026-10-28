const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
const document = {body: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/codex/send-interrupt.js'), 'utf8'), {
    globalThis: {__SCM_TOOLKIT_SEND_INTERRUPT_TEST__: hooks},
    document,
    setTimeout: job => queueMicrotask(job),
});
function button(name) {
    return {
        isConnected: true, disabled: false, id: '', type: 'button', textContent: '',
        getClientRects: () => [1], getAttribute: key => key === 'aria-label' ? name : null,
    };
}
const send = button('Send message');
const stop = button('Stop response');
const editor = {value: 'typed draft', isConnected: true, getClientRects: () => [1]};
const root = {
    isConnected: true,
    parentElement: document.body,
    querySelectorAll: selector => selector === 'button' ? buttons : [editor],
};
send.parentElement = root;
let buttons = [send, stop];
assert.equal(hooks.isSend(send), true);
assert.equal(hooks.isSend(stop), false);
assert.equal(hooks.controls(send).editor, editor);
async function check() {
    let stopped = 0, submitted = 0;
    stop.click = () => {stopped++; buttons = [send];};
    send.click = () => {submitted++; editor.value = '';};
    let prevented = 0;
    hooks.onClick({
        isTrusted:true, defaultPrevented:false, button:0, target:{closest:()=>send},
        preventDefault(){prevented++;}, stopImmediatePropagation(){},
    });
    // Yield for the native stop/send sequence; no second click is needed.
    for (let i=0; i<10 && !submitted; i++) await new Promise(resolve=>setImmediate(resolve));
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(submitted, 1);
    hooks.onClick({isTrusted:false, defaultPrevented:false, button:0, target:{closest:()=>send}});
    assert.equal(submitted, 1, 'programmatic clipboard submissions are not intercepted');
}
check().then(()=>console.log('Codex Send click interruption checks passed.')).catch(error=>{console.error(error);process.exitCode=1;});
