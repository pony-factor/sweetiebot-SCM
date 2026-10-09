const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, '../assets/codex/codex-clipboard-submit.js'), 'utf8'
), { globalThis: { __SCM_TOOLKIT_CLIPBOARD_TEST__: hooks } });

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
console.log('Codex clipboard button action-selection checks passed.');
