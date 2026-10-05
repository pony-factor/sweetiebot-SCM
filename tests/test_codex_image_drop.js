'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const listeners = new Map();
const body = {
    contains: node => node?.inside === true,
};
const window = {
    addEventListener(type, handler, capture) { assert.equal(capture, true); listeners.set(type, handler); },
    removeEventListener(type, handler) { assert.equal(listeners.get(type), handler); listeners.delete(type); },
};
const context = vm.createContext({ document: { body }, window });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/codex-image-drop.js'), 'utf8'), context);
let count = 0, highlighted = false, uploads = 0;
const dispose = context.scmToolkitRegisterImageDropTarget(null,
    event => { assert.equal(event.currentTarget, body); if (event.type === 'dragenter') count++; highlighted = true; event.preventDefault(); },
    () => { count = Math.max(0, count - 1); highlighted = count > 0; },
    event => { uploads++; count = 0; highlighted = false; event.preventDefault(); });
function event(type, hasFiles = true) {
    return { type, target: {}, currentTarget: body, relatedTarget: null,
        dataTransfer: { types: hasFiles ? ['Files'] : ['text/plain'], files: [], items: [] },
        defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; } };
}
listeners.get('dragenter')(event('dragenter'));
listeners.get('dragenter')(event('dragenter'));
assert.equal(count, 1, 'crossing child elements does not increment the pane counter');
const internalLeave = event('dragleave'); internalLeave.relatedTarget = { inside: true };
listeners.get('dragleave')(internalLeave);
assert.equal(highlighted, true);
listeners.get('dragleave')(event('dragleave'));
assert.equal(highlighted, false, 'leaving the pane clears the native highlight');
const over = event('dragover'); listeners.get('dragover')(over);
assert.equal(over.defaultPrevented, true, 'dragover alone activates a drop without an earlier dragenter');
assert.equal(count, 1, 'first dragover becomes one native dragenter');
assert.equal(over.stopped, true, 'root listeners cannot process the same drag twice');
const nullLeave = event('dragleave');
nullLeave.clientX = 20; nullLeave.clientY = 30;
context.document.elementFromPoint = () => ({ inside: true });
listeners.get('dragleave')(nullLeave);
assert.equal(highlighted, true, 'null relatedTarget over a child keeps the overlay');
const dropped = event('drop'); listeners.get('drop')(dropped);
assert.equal(uploads, 1);
assert.equal(dropped.stopped, true, 'native attachment processing happens once');
listeners.get('drop')(event('drop', false));
assert.equal(uploads, 1, 'text and internal drags are left alone');
let hiddenUploads = 0;
const disposeHidden = context.scmToolkitRegisterImageDropTarget(
    { contains: () => true, getClientRects: () => [] }, () => {}, () => {}, () => hiddenUploads++);
listeners.get('drop')(event('drop'));
assert.equal(hiddenUploads, 0, 'a hidden composer cannot take the drop');
disposeHidden(); dispose();
assert.equal(listeners.size, 0, 'unmount removes capture listeners');
const composer = { isConnected: true, contains: () => false, getClientRects: () => [{}] };
let promptUploads = 0, overlaySurface;
const disposePrompt = context.scmToolkitRegisterImageDropTarget(composer,
    e => { overlaySurface = e.currentTarget; e.preventDefault(); },
    () => { overlaySurface = null; },
    e => { promptUploads++; e.preventDefault(); });
const historyHover = event('dragover');
historyHover.target = { inside: true, historyRow: true };
listeners.get('dragover')(historyHover);
assert.equal(overlaySurface, body, 'hovering a past chat activates the full-view overlay');
assert.equal(historyHover.stopped, true, 'window capture handles files before history hover listeners');
listeners.get('drop')(event('drop'));
assert.equal(promptUploads, 1, 'a drop outside the composer attaches to the visible new-chat prompt');
listeners.get('dragover')(event('dragover'));
listeners.get('dragend')(event('dragend'));
assert.equal(overlaySurface, null, 'canceling a drag clears the overlay');
disposePrompt();
assert.equal(listeners.size, 0);
console.log('Codex image-drop capture checks passed.');
