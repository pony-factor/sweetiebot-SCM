// Stable Sweetiebot workbench bootstrap. Only the bootstrap lives in VS Code's
// compiled bundle; independently versioned components live beside that bundle.
(() => {
    const KEY = '__sweetiebotWorkbenchComponents';
    if (globalThis[KEY]) return;
    const doc = document;
    const win = doc.defaultView || window;
    const active = new Map();
    const staging = new Map();
    let expectedName = '';
    let rootUrl, stopped = false, running = false, rerun = false;
    const roots = [];
    const script = Array.from(doc.querySelectorAll('script[src]'))
        .find(node => /workbench\.desktop\.main\.js(?:[?#]|$)/.test(node.src));
    if (script) roots.push(new URL('./sweetiebot/', script.src));
    // Electron's sandbox workbench HTML is normally three levels below vs/.
    roots.push(new URL('../../../workbench/sweetiebot/', doc.baseURI));
    roots.push(new URL('./sweetiebot/', doc.baseURI));

    const register = (name, activate) => {
        if (!stopped && name === expectedName && typeof activate === 'function') {
            staging.set(name, activate);
        }
    };
    const api = { register, refresh, dispose };
    globalThis[KEY] = api;

    async function manifestAt(base) {
        const response = await fetch(new URL('manifest.json', base), {
            cache: 'no-store', credentials: 'omit'
        });
        if (!response.ok) throw Error('Component manifest unavailable');
        const manifest = await response.json();
        if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.modules)) {
            throw Error('Invalid Sweetiebot component manifest');
        }
        return manifest;
    }

    async function load(name, version, filename) {
        if (active.get(name)?.version === version || stopped) return;
        const asset = new URL(filename, rootUrl);
        asset.searchParams.set('v', version);
        staging.delete(name);
        expectedName = name;
        try {
            // Desktop VS Code requires Trusted Types for script.src. Native
            // dynamic import uses the existing same-origin module loader.
            await import(asset.href);
            const activate = staging.get(name);
            if (typeof activate !== 'function') throw Error('Component did not register');
            // Prepare the replacement before removing its predecessor. If
            // initialization throws, the old component remains fully active.
            const next = activate({ document: doc, window: win });
            const disposeNext = typeof next === 'function' ? next : next?.dispose;
            if (typeof disposeNext !== 'function') {
                throw Error('Component must return a dispose function');
            }
            const previous = active.get(name);
            active.set(name, { version, dispose: () => disposeNext.call(next) });
            try { previous?.dispose(); }
            catch (error) { console.warn('Sweetiebot old component cleanup failed', error); }
        } finally {
            expectedName = '';
            staging.delete(name);
        }
    }

    async function update() {
        if (stopped || running) { rerun = !stopped; return; }
        running = true;
        try {
            let manifest;
            if (rootUrl) {
                manifest = await manifestAt(rootUrl);
            } else {
                for (const candidate of roots) {
                    try {
                        manifest = await manifestAt(candidate);
                        rootUrl = candidate;
                        break;
                    } catch { /* Try the other known Electron workbench layout. */ }
                }
                if (!rootUrl) throw Error('Could not locate the Sweetiebot component directory');
            }
            const present = new Set();
            for (const spec of manifest.modules) {
                // No arbitrary URLs or remote scripts in an update manifest.
                if (!spec || spec.name !== 'codex-file-drag'
                    || spec.file !== 'codex_file_drag.js'
                    || !/^[a-f0-9]{64}$/.test(spec.version)) {
                    throw Error('Unrecognized Sweetiebot component');
                }
                if (present.has(spec.name)) throw Error('Duplicate component');
                present.add(spec.name);
                await load(spec.name, spec.version, spec.file);
            }
            // Removed components are disposed when the new manifest is applied.
            for (const [name, previous] of active) {
                if (!present.has(name)) {
                    active.delete(name);
                    previous.dispose();
                }
            }
        } catch (error) {
            if (!stopped) console.warn('Sweetiebot live component update failed; retaining previous UI', error);
        } finally {
            running = false;
            if (rerun && !stopped) { rerun = false; void update(); }
        }
    }

    function refresh() { return update(); }
    function focus() { if (!doc.hidden) void update(); }
    function dispose() {
        if (stopped) return;
        stopped = true;
        win.clearInterval(interval);
        win.removeEventListener('focus', focus);
        win.removeEventListener('unload', dispose);
        doc.removeEventListener('visibilitychange', focus);
        for (const previous of active.values()) {
            try { previous.dispose(); }
            catch (error) { console.warn('Sweetiebot component disposal failed', error); }
        }
        active.clear();
        staging.clear();
        delete globalThis[KEY];
    }

    const interval = win.setInterval(focus, 60000);
    win.addEventListener('focus', focus);
    doc.addEventListener('visibilitychange', focus);
    win.addEventListener('unload', dispose, { once: true });
    void update();
})();
