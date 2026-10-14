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

async function promisedScreenshotChecks() {
    const listeners = new Map();
    const notices = [];
    const body = { contains: () => true, appendChild: notice => notices.push(notice) };
    const document = { body, getElementById: () => notices[0], createElement: () => ({
        style: {}, setAttribute() {}, addEventListener() {}, remove() { notices.length = 0; },
    }) };
    const window = {
        addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: type => listeners.delete(type),
    };
    const context = vm.createContext({ document, window, setTimeout, clearTimeout, Date });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/codex-image-drop.js'), 'utf8'), context);
    const uploads = [];
    let leaves = 0;
    const dispose = context.scmToolkitRegisterImageDropTarget(null, () => {}, () => leaves++, e => {
        // Match the native handler's rejection of zero-byte files.
        uploads.push(Array.from(e.dataTransfer.files).filter(file => file.size > 0));
        assert.equal(e.dataTransfer.getData('text/plain'), 'original drop');
    });
    const empty = { name: 'Screenshot.png', type: 'image/png', size: 0 };
    const ready = { ...empty, size: 512 };
    let reads = 0;
    const entry = { isFile: true, name: empty.name, file(success) { success(++reads === 1 ? empty : ready); } };
    const transfer = {
        files: [empty], types: ['Files', 'text/plain'],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => empty, webkitGetAsEntry: () => entry }],
        getData: () => 'original drop',
    };
    const dropped = event('drop'); dropped.dataTransfer = transfer;
    listeners.get('drop')(dropped);
    assert.equal(dropped.defaultPrevented, true, 'promised drop is accepted before asynchronous recovery');
    assert.equal(dropped.stopped, true);
    // The OS drag data is unavailable after returning from the drop event.
    transfer.files = []; transfer.items = []; transfer.getData = () => '';
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(reads, 2, 'retry requests fresh metadata from the file entry');
    assert.equal(uploads.length, 1, 'recovery uploads exactly once');
    assert.equal(uploads[0][0], ready, 'native upload receives the materialized image');
    assert.equal(leaves, 1, 'pending recovery clears the overlay');
    assert.equal(notices.length, 0, 'successful recovery shows no error');

    const unsupported = event('drop');
    unsupported.dataTransfer = { files: [empty], items: [], types: ['Files'], getData: () => '' };
    listeners.get('drop')(unsupported);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(uploads.length, 1, 'an unavailable image is not forwarded as an empty attachment');
    assert.match(notices[0].textContent, /Save it first/, 'failed drops provide visible recovery guidance');
    notices.length = 0;

    let stalledReads = 0;
    const stalled = event('drop');
    stalled.dataTransfer = { files: [empty], types: ['Files'], getData: () => '', items: [{
        kind: 'file', type: 'image/png', getAsFile: () => empty,
        webkitGetAsEntry: () => ({ isFile: true, file() { stalledReads++; } }),
    }] };
    listeners.get('drop')(stalled);
    await new Promise(resolve => setTimeout(resolve, 2900));
    assert.ok(stalledReads > 1, 'missing file callbacks are retried');
    assert.equal(uploads.length, 1, 'stalled promises never upload empty files');
    assert.equal(notices.length, 1, 'stalled promises stop within the bounded recovery window');
    notices.length = 0;

    const navigating = event('drop');
    navigating.dataTransfer = { files: [empty], types: ['Files'], getData: () => '', items: [{
        kind: 'file', type: 'image/png', getAsFile: () => empty,
        webkitGetAsEntry: () => ({ isFile: true, file: success => setTimeout(() => success(ready), 10) }),
    }] };
    listeners.get('drop')(navigating);
    listeners.get('pointerdown')({});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(uploads.length, 1, 'navigation with a reused composer cancels the pending attachment');
    assert.equal(notices.length, 1);
    notices.length = 0;

    const switching = event('drop');
    switching.dataTransfer = { files: [empty], types: ['Files'], getData: () => '', items: [{
        kind: 'file', type: 'image/png', getAsFile: () => empty,
        webkitGetAsEntry: () => ({ isFile: true, file: success => setTimeout(() => success(ready), 10) }),
    }] };
    listeners.get('drop')(switching);
    dispose();
    context.scmToolkitRegisterImageDropTarget(null, () => {}, () => {}, () => assert.fail('must not reroute to another chat'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(uploads.length, 1, 'unmounted composer cannot receive a delayed drop');
    assert.equal(notices.length, 1);
    console.log('Promised screenshot recovery checks passed.');
}
promisedScreenshotChecks().catch(error => { console.error(error); process.exitCode = 1; });
