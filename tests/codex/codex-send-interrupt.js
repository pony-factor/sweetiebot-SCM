const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
const document = {body: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../assets/codex/send-interrupt.js'), 'utf8'), {
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
    getClientRects: () => [1],
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

    // Current Codex morphs one primary button from Stop to Queue/Steer.
    // There is no separate Stop DOM node once a draft has been typed.
    const queue = button('Queue');
    queue.parentElement = root;
    let nativeStops = 0, queued = 0;
    const props = {
        isResponseInProgress: true,
        onStop() { nativeStops++; props.isResponseInProgress = false; },
        handleSubmit() {},
    };
    queue.__reactFiber$fixture = {memoizedProps: props};
    queue.click = () => {queued++;};
    buttons = [queue];
    editor.value = 'interrupt with this draft';
    assert.equal(hooks.controls(queue).nativeButton, queue);
    assert.equal(hooks.isSend(button('Steer')), true);
    assert.equal(await hooks.interruptAndSend(hooks.controls(queue)), true);
    assert.equal(nativeStops, 1);
    assert.equal(queued, 1);
    assert.equal(hooks.controls(queue), null, 'idle Send keeps native behavior');

    // Use committed React props, not a stale alternate that reports idle.
    const stale = {memoizedProps: {...props}, stateNode: {}};
    const current = {memoizedProps: props};
    stale.alternate = current;
    stale.stateNode.current = current;
    queue.__reactFiber$fixture = stale;
    props.isResponseInProgress = true;
    assert.equal(hooks.nativeRun(queue), props);

    props.onStop = () => { editor.value = 'new user edit'; props.isResponseInProgress = false; };
    assert.equal(await hooks.interruptAndSend(hooks.controls(queue)), false);
    assert.equal(queued, 1, 'never submit a draft edited during interruption');
    assert.equal(editor.value, 'new user edit');

    props.isResponseInProgress = true;
    props.onStop = () => {};
    assert.equal(await hooks.interruptAndSend(hooks.controls(queue)), false);
    assert.equal(queued, 1, 'never queue when interruption does not finish');

    props.onStop = async () => { throw new Error('stop unavailable'); };
    assert.equal(await hooks.interruptAndSend(hooks.controls(queue)), false);
    assert.equal(editor.value, 'new user edit', 'preserve the draft if stop fails');

    // Enter dispatches a keyboard-generated click (detail 0), not a pointer click.
    // Its native queue submission must not be intercepted.
    hooks.onClick({isTrusted:true, defaultPrevented:false, button:0, detail:0,
        target:{closest:()=>queue}, preventDefault(){assert.fail('Enter must queue');}});
}
check().then(()=>console.log('Codex Send click interruption checks passed.')).catch(error=>{console.error(error);process.exitCode=1;});
