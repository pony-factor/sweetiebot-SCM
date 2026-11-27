// Disable the native browser fallback for composer state, which is shared by
// webviews. The scoped extension host is the only durable store for these atoms.
(() => {
    const atoms = new Set([
        'composer-prompt-drafts-v1', 'composer-prompt-drafts-v2',
        'composer-retained-documents-v1', 'draft-thread-identities-v1',
        'sweetiebot-composer-attachments-v1'
    ]);
    const renderer = window.crypto?.randomUUID?.() ?? Math.random().toString(36);
    let scope, generation, revision = 0;
    const latestWrite = new Map();
    window.addEventListener?.('message', event => {
        const message = event.data;
        if (message?.type === 'persisted-atom-sync') {
            scope = message.scmToolkitDraftScope;
            generation = message.scmToolkitDraftGeneration;
        }
        // Codex applies its own edits immediately. An earlier disk write can
        // finish after the editor has already cleared or changed the draft.
        if (message?.type === 'persisted-atom-updated' && message.scmToolkitDraftRenderer === renderer &&
            message.scmToolkitDraftRevision < (latestWrite.get(message.key) ?? 0)) {
            event.stopImmediatePropagation();
        }
    }, true);
    if (typeof window.acquireVsCodeApi === 'function') {
        const acquire = window.acquireVsCodeApi;
        window.acquireVsCodeApi = function() {
            const api = acquire();
            return Object.freeze({ getState: () => api.getState(), setState: value => api.setState(value),
                postMessage(message) {
                    if (message?.type === 'persisted-atom-sync-request' || message?.type === 'ready') {
                        return api.postMessage({ ...message, scmToolkitDraftRenderer: renderer });
                    }
                    if (message?.type === 'persisted-atom-update' && atoms.has(message.key)) {
                        latestWrite.set(message.key, ++revision);
                        return api.postMessage({ ...message, scmToolkitDraftRenderer: renderer, scmToolkitDraftRevision: revision,
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
