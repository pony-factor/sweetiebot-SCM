'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const seekTimes = [];
const captures = [];
const urls = [];
let duration = 24;
let analysisEnabled = true;
let staticScene = false;
let throwOnRead = false;
let throwOnSeek = false;
function fakeVideo() {
    const callbacks = new Map();
    return {
        duration, videoWidth: 2560, videoHeight: 1440, readyState: 4,
        currentTime: 0,
        addEventListener(type, callback) { callbacks.set(type, callback); },
        removeEventListener(type) { callbacks.delete(type); },
        load() { if (this.src) setImmediate(() => callbacks.get('loadeddata')?.()); },
        pause() {}, removeAttribute(name) { if (name === 'src') this.src = ''; },
        set currentTime(value) {
            this._time = value;
            seekTimes.push(value);
            setImmediate(() => callbacks.get('seeked')?.());
        },
        get currentTime() { return this._time ?? 0; },
    };
}
function frameBytes(time) {
    const data = new Uint8ClampedArray(160 * 90 * 4);
    // Staged screen changes at 6s and 16s. Most of each frame stays unchanged,
    // making these representative of dialogs opening and closing in a screen cast.
    const marker = staticScene ? 0 : time >= 16 ? 40 : time >= 6 ? 190 : 0;
    for (let index = 0; index < 160 * 90; index++) {
        const light = index < 160 * 90 * 0.4 ? marker : 50;
        const offset = index * 4;
        data[offset] = light;
        data[offset + 1] = light;
        data[offset + 2] = light;
        data[offset + 3] = 255;
    }
    return data;
}
const document = {
    createElement(type) {
        if (type === 'video') return fakeVideo();
        if (type !== 'canvas') throw new Error('Unexpected element: ' + type);
        return {
            getContext(kind, options) {
                if (options?.willReadFrequently) {
                    if (!analysisEnabled) return null;
                    return {
                        drawImage(source) { this.time = source.currentTime; },
                        getImageData() {
                            if (throwOnRead) throw new Error('Readback blocked');
                            return { data: frameBytes(this.time) };
                        },
                    };
                }
                return { drawImage(source) { this.time = source.currentTime; } };
            },
            toBlob(callback) {
                captures.push({ time: this.getContextCalledTime });
                callback({ size: 150, type: 'image/jpeg' });
            },
        };
    },
};
class FakeFile {
    constructor(parts, name, opts) { this.name = name; this.type = opts.type; this.size = 150; }
}
const sandbox=vm.createContext({
    document, File: FakeFile, Date, setTimeout, clearTimeout, setImmediate,
    Uint8ClampedArray, URL: { createObjectURL() { return 'blob:test'; },
        revokeObjectURL(url) { urls.push(url); } },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex/video-frames.js'), 'utf8'), sandbox);
const photoNames = async max => {
    seekTimes.length = 0;
    const files = await sandbox.scmToolkitVideoScreenshots({
        name: 'capture.mp4', type: 'video/mp4', size: 1000,
    }, max);
    return Array.from(files, file => Number(file.name.match(/-at-(\d+(?:\.\d+)?)s\.jpg$/)[1]));
};
(async () => {
    const diff = sandbox.scmToolkitVideoDifference;
    const before = new Uint8ClampedArray([0,0,0,255, 30,30,30,255]);
    const after = new Uint8ClampedArray([0,0,0,255, 250,250,250,255]);
    assert.ok(diff(before, after) > diff(before, before));
    assert.equal(diff(before, new Uint8ClampedArray(2)), 0);

    const times = await photoNames(8);
    assert.equal(times.length, 8);
    assert.deepEqual([...times].sort((a,b) => a-b), times, 'output is chronological');
    assert.ok(times[0] < 3 && times[7] > 21, 'timeline anchors survive scene changes');
    assert.ok(times.some(t => t >= 6 && t < 7), 'first dialog opening is selected');
    assert.ok(times.some(t => t >= 16 && t < 17), 'second dialog transition is selected');
    assert.ok(seekTimes.length <= 64 + 8, 'decoding work is bounded');
    assert.equal(urls.length, 1, 'decoder URL is released');

    staticScene = true;
    const uniform = await photoNames(8);
    assert.deepEqual(uniform, [1.5,4.5,7.5,10.5,13.5,16.5,19.5,22.5],
        'unchanged video falls back to equally spaced frames');

    analysisEnabled = false;
    assert.deepEqual(await photoNames(8), uniform, 'missing analysis canvas is nonfatal');
    assert.equal(seekTimes.length, 8, 'fallback avoids unnecessary scan seeks');

    analysisEnabled = true;
    throwOnRead = true;
    assert.deepEqual(await photoNames(8), uniform, 'blocked readback is nonfatal');
    throwOnRead = false;

    duration = 0.2;
    assert.equal((await photoNames(8)).length, 1, 'very short clips keep one frame');
    duration = 24;
    assert.equal((await photoNames(2)).length, 2, 'small shared drop budget is honored');
    console.log('Codex adaptive frame selection checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
