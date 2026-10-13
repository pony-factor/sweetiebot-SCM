'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

// Exercise the actual titlebar toggle's resize logic without loading VS Code.
const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
const entry = source.indexOf('function scmToolkitMountCompactWindow(');
const begin = source.indexOf('    const toggle = async action => {', entry);
const end = source.indexOf('    const mount = () => {', begin);
assert(entry >= 0 && begin > entry && end > begin, 'compact-window toggle must be present');
const createToggle = new Function(
    'state', 'win', 'nativeHost', 'updateAction', 'console',
    source.slice(begin, end) + '\nreturn toggle;'
);

async function verifySquare(screen, expectedBounds) {
    const calls = [];
    const state = { restore: null, busy: false };
    const win = {
        screen, screenX: 15, screenY: 25,
        outerWidth: 1200, outerHeight: 760, vscodeWindowId: 17
    };
    const nativeHost = {
        async positionWindow(bounds, options) {
            calls.push({ bounds, options });
        }
    };
    const action = { title: '', setAttribute() {} };
    const toggle = createToggle(state, win, nativeHost, () => {}, console);
    await toggle(action);
    assert.deepEqual(calls[0].bounds, expectedBounds);
    assert.equal(calls[0].options.targetWindowId, 17);
    assert.equal(calls[0].bounds.width, calls[0].bounds.height);
    assert.deepEqual(state.restore, { x: 15, y: 25, width: 1200, height: 760 });
    await toggle(action);
    assert.deepEqual(calls[1].bounds, { x: 15, y: 25, width: 1200, height: 760 });
    assert.equal(state.restore, null);
    assert.equal(state.busy, false);
}

(async () => {
    await verifySquare(
        { availWidth: 1600, availHeight: 1000 },
        { x: 520, y: 220, width: 560, height: 560 }
    );
    await verifySquare(
        { availWidth: 450, availHeight: 390, availLeft: 1600, availTop: 24 },
        { x: 1662, y: 56, width: 326, height: 326 }
    );
    await verifySquare(
        { availWidth: 500, availHeight: 1000 },
        { x: 32, y: 282, width: 436, height: 436 }
    );
    console.log('Compact square resize and restore passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
