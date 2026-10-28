'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const listeners = new Map();
const notices = [];
const urls = [];
class FakeFile {
    constructor(parts, name, options = {}) {
        this.parts = parts;
        this.name = name;
        this.type = options.type || '';
        this.size = parts.reduce((total, part) => total + (part.size || 0), 0);
    }
}
function fakeVideo() {
    const handlers = new Map();
    const video = {
        duration: 24, videoWidth: 2560, videoHeight: 1440,
        addEventListener(type, handler) { handlers.set(type, handler); },
        removeEventListener(type) { handlers.delete(type); },
        load() { if (this.src) setImmediate(() => handlers.get('loadeddata')?.()); },
        pause() {}, removeAttribute() { this.src = ''; },
        set currentTime(value) { this._time = value; setImmediate(() => handlers.get('seeked')?.()); },
        get currentTime() { return this._time || 0; },
    };
    return video;
}
const body = { contains: () => true, appendChild: node => notices.push(node) };
const document = {
    body,
    getElementById: () => notices[0] || null,
    createElement(type) {
        if (type === 'video') return fakeVideo();
        if (type === 'canvas') return {
            getContext: () => ({ drawImage() {} }),
            toBlob(callback) { callback({ size: 100, type: 'image/jpeg' }); },
        };
        return { style: {}, setAttribute() {}, addEventListener() {},
            remove() { notices.splice(notices.indexOf(this), 1); } };
    },
};
const window = { location: { href: 'chat-1' },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
};
const context = vm.createContext({
    document, window, File: FakeFile, Date, setTimeout, clearTimeout,
    setImmediate, URL: { createObjectURL: () => 'blob:sample',
        revokeObjectURL: url => urls.push(url) },
});
for (const file of ['video-frames.js', 'image-drop.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex', file), 'utf8'), context);
}
const uploads = [], leaves = [];
let dispose = context.scmToolkitRegisterImageDropTarget(null, () => {}, () => leaves.push(true),
    event => uploads.push(Array.from(event.dataTransfer.files)));
const originalVideo = { name: 'bug.mov', type: 'video/quicktime', size: 20000 };
const originalImage = { name: 'notes.png', type: 'image/png', size: 999 };
function drop(files) {
    let prevented = false, stopped = false;
    const dataTransfer = {
        files, types: ['Files', 'text/plain'],
        items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        getData: () => 'video details',
    };
    listeners.get('drop')({
        type: 'drop', dataTransfer, preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
    });
    dataTransfer.files = []; dataTransfer.items = [];
    assert.equal(prevented, true, 'video drops are intercepted synchronously');
    assert.equal(stopped, true);
}
async function settle() {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}
(async () => {
    drop([originalVideo, originalImage]);
    await settle();
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].length, 9, 'eight video frames and the original image attach together');
    assert.ok(uploads[0].some(file => file === originalImage));
    assert.ok(!uploads[0].includes(originalVideo), 'unsupported original video is never forwarded');
    const frames = uploads[0].filter(file => file.type === 'image/jpeg');
    assert.equal(frames.length, 8);
    assert.ok(frames.every(frame => /^bug-at-.*s\.jpg$/.test(frame.name)));
    assert.equal(urls.length, 1, 'temporary decoder URL is released');

    // Two videos share the frame budget rather than sending sixteen attachments.
    drop([originalVideo, { ...originalVideo, name: 'second.mp4' }]);
    await settle();
    assert.equal(uploads[1].length, 8);
    assert.ok(uploads[1].every(file => file.type === 'image/jpeg'));

    // A target change during async decoding must not attach to the next chat.
    drop([originalVideo]);
    window.location.href = 'chat-2';
    await settle();
    assert.equal(uploads.length, 2, 'navigation cancels deferred video attachments');
    assert.match(notices[0].textContent, /target chat changed/);
    window.location.href = 'chat-1';

    dispose();
    assert.equal(listeners.size, 0);
    console.log('Codex video-drop screenshot checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
