'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const path = require('node:path');

const runtime = fs.readFileSync(
    path.join(__dirname, '../assets/workbench/live_runtime.js'), 'utf8')
    // Simulate the browser's native module import without a file-backed app.
    .replace('await import(asset.href);', 'await globalThis.__testImport(asset.href);');

function harness() {
    const listeners = new Map();
    const local = new Map();
    const win = {
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
        setInterval(fn) { win.interval = fn; return 1; },
        clearInterval() { win.interval = undefined; },
        innerWidth: 1024, innerHeight: 768
    };
    const doc = {
        defaultView: win,
        hidden: false,
        baseURI: 'https://app.invalid/out/vs/code/electron-browser/workbench/workbench.html',
        querySelectorAll() { return []; },
        addEventListener(type, callback) { local.set(type, callback); },
        removeEventListener(type) { local.delete(type); },
        head: { appendChild(el) { el.connected = true; } },
        createElement(type) {
            assert.equal(type, 'style');
            return { disabled: false, textContent: '', remove() { this.connected = false; } };
        }
    };
    let version = 'a'.repeat(64);
    let invalid = false;
    let throwOnActivate = false;
    let imports = 0;
    let active = 0;
    let disposed = 0;
    const sandbox = {
        document: doc, window: win, URL, console,
        fetch: async url => {
            assert.match(String(url), /\/vs\/workbench\/sweetiebot\/manifest\.json/);
            return { ok: true, json: async () => ({
                schema: 1, modules: invalid ? [{ name: 'other', file: 'unknown.js', version }]
                    : [{ name: 'codex-file-drag', file: 'codex_file_drag.js', version }]
            }) };
        }
    };
    const context = vm.createContext(sandbox);
    sandbox.__testImport = async href => {
        imports++;
        assert.match(href, /\/vs\/workbench\/sweetiebot\/codex_file_drag\.js\?v=/);
        vm.runInContext(`globalThis.__sweetiebotWorkbenchComponents.register(
            'codex-file-drag', () => {
                if (globalThis.__testThrow()) throw Error('activation failed');
                globalThis.__testMounted();
                return { dispose() { globalThis.__testDisposed(); } };
            });`, context);
    };
    sandbox.__testThrow = () => throwOnActivate;
    sandbox.__testMounted = () => { active++; };
    sandbox.__testDisposed = () => { disposed++; active--; };
    const start = () => vm.runInContext(runtime, context);
    const refresh = () => sandbox.__sweetiebotWorkbenchComponents.refresh();
    return {
        start, refresh,
        setVersion: value => { version = value; },
        setInvalid: value => { invalid = value; },
        setThrow: value => { throwOnActivate = value; },
        get state() { return { imports, active, disposed }; },
        stop: () => sandbox.__sweetiebotWorkbenchComponents.dispose(),
        win, listeners, local
    };
}

test('hot replacement disposes the old module and skips unchanged versions', async () => {
    const app = harness();
    app.start();
    await new Promise(resolve => setImmediate(resolve));
    await app.refresh();
    assert.deepEqual(app.state, { imports: 1, active: 1, disposed: 0 });
    await app.refresh();
    assert.equal(app.state.imports, 1, 'same revision must not import twice');
    app.setVersion('b'.repeat(64));
    await app.refresh();
    assert.deepEqual(app.state, { imports: 2, active: 1, disposed: 1 });
    app.stop();
    assert.deepEqual(app.state, { imports: 2, active: 0, disposed: 2 });
    assert.equal(app.listeners.get('focus').size, 0);
    assert.equal(app.win.interval, undefined);
});

test('failed activation and unrecognized manifests do not discard running module', async () => {
    const app = harness();
    app.start();
    await new Promise(resolve => setImmediate(resolve));
    await app.refresh();
    app.setVersion('b'.repeat(64));
    app.setThrow(true);
    await app.refresh();
    assert.equal(app.state.active, 1);
    assert.equal(app.state.disposed, 0);
    app.setThrow(false);
    app.setInvalid(true);
    await app.refresh();
    assert.equal(app.state.active, 1);
    assert.equal(app.state.imports, 2);
    app.stop();
    assert.equal(app.state.active, 0);
});

test('Codex drag component removes every listener and its style on disposal', () => {
    const drag = fs.readFileSync(path.join(
        __dirname, '../assets/workbench/codex_file_drag.js'), 'utf8');
    let activate;
    vm.runInNewContext(drag, {
        globalThis: { __sweetiebotWorkbenchComponents: {
            register(name, factory) {
                assert.equal(name, 'codex-file-drag');
                activate = factory;
            }
        } }
    });
    const listeners = new Map();
    const styles = [];
    const win = {
        innerWidth: 1024, innerHeight: 768,
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type, fn) {
            assert.equal(listeners.get(type), fn);
            listeners.delete(type);
        }
    };
    const doc = {
        createElement(type) {
            assert.equal(type, 'style');
            const style = { disabled: false, remove() { this.removed = true; } };
            styles.push(style);
            return style;
        },
        head: { appendChild() {} }
    };
    const instance = activate({ document: doc, window: win });
    assert(listeners.has('dragenter'));
    assert(listeners.has('drop'));
    assert.equal(styles.length, 1);
    listeners.get('dragenter')({ dataTransfer: { types: ['Files'] } });
    assert.equal(styles[0].disabled, false);
    instance.dispose();
    assert.equal(listeners.size, 0);
    assert.equal(styles[0].removed, true);
});
