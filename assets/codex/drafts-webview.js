// Disable the native browser fallback for composer state, which is shared by
// webviews. The scoped extension host is the only durable store for these atoms.
(() => {
    const atoms = new Set([
        'composer-prompt-drafts-v1', 'composer-prompt-drafts-v2',
        'composer-retained-documents-v1', 'draft-thread-identities-v1',
        'sweetiebot-composer-attachments-v1'
    ]);
    const renderer = window.crypto?.randomUUID?.() ?? Math.random().toString(36);
    let scope, generation;
    window.addEventListener?.('message', event => {
        if (event.data?.type === 'persisted-atom-sync') {
            scope = event.data.scmToolkitDraftScope;
            generation = event.data.scmToolkitDraftGeneration;
        }
    });
    if (typeof window.acquireVsCodeApi === 'function') {
        const acquire = window.acquireVsCodeApi;
        window.acquireVsCodeApi = function() {
            const api = acquire();
            return Object.freeze({ getState: () => api.getState(), setState: value => api.setState(value),
                postMessage(message) {
                    if (message?.type === 'persisted-atom-sync-request') {
                        return api.postMessage({ ...message, scmToolkitDraftRenderer: renderer });
                    }
                    if (message?.type === 'persisted-atom-update' && atoms.has(message.key)) {
                        return api.postMessage({ ...message, scmToolkitDraftRenderer: renderer,
                            scmToolkitDraftScope: scope, scmToolkitDraftGeneration: generation });
                    }
                    return api.postMessage(message);
                } });
        };
    }
    const storageKeys = new Set(Array.from(atoms, key => 'codex:persisted-atom:' + key));
    let storage;
    try { storage = window.localStorage; } catch { return; }
    if (!storage || typeof Storage === 'undefined') return;
    for (const method of ['getItem', 'setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function(key, ...args) {
            if (this === storage && storageKeys.has(key)) return method === 'getItem' ? null : undefined;
            return original.call(this, key, ...args);
        };
    }
})();
