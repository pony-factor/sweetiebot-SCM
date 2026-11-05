// Installed before Codex's bundle runs. Its browser-origin fallback is shared
// by webviews, so prevent an unsent new-chat draft in localStorage from seeding
// another repository before the scoped host sync finishes. Preserve raw data.
(() => {
    // Tag queued IPC writes with the scope that rendered their composer.
    // A delayed write from the previous branch must never populate the next one.
    let scope;
    window.addEventListener?.('message', event => {
        if (event.data?.type === 'persisted-atom-sync' && event.data.scmToolkitDraftScope) scope = event.data.scmToolkitDraftScope;
    });
    if (typeof window.acquireVsCodeApi === 'function') {
        const acquire = window.acquireVsCodeApi;
        window.acquireVsCodeApi = function() {
            const api = acquire();
            return Object.freeze({ getState: () => api.getState(), setState: value => api.setState(value),
                postMessage: message => api.postMessage(message?.type === 'persisted-atom-update'
                    && ['composer-prompt-drafts-v1', 'composer-prompt-drafts-v2', 'sweetiebot-composer-attachments-v1'].includes(message.key)
                    ? { ...message, scmToolkitDraftScope: scope } : message) });
        };
    }
    const storageKeys = new Set(['codex:persisted-atom:composer-prompt-drafts-v1',
        'codex:persisted-atom:composer-prompt-drafts-v2']);
    let storage;
    try { storage = window.localStorage; } catch { return; }
    if (!storage || typeof Storage === 'undefined') return;
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    if (Storage.prototype.scmToolkitDraftIsolation) return;
    Object.defineProperty(Storage.prototype, 'scmToolkitDraftIsolation', { value: true });
    const cleaned = value => {
        if (typeof value !== 'string') return value;
        try {
            const drafts = JSON.parse(value);
            if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) return value;
            const safe = { ...drafts };
            delete safe['new-conversation'];
            return JSON.stringify(safe);
        } catch { return value; }
    };
    Storage.prototype.getItem = function(key) {
        const value = originalGet.call(this, key);
        if (this === storage && key === 'codex:persisted-atom:sweetiebot-composer-attachments-v1') return '{}';
        return this === storage && storageKeys.has(key) ? cleaned(value) : value;
    };
    Storage.prototype.setItem = function(key, value) {
        if (this === storage && key === 'codex:persisted-atom:sweetiebot-composer-attachments-v1') {
            return originalSet.call(this, key, '{}');
        }
        return originalSet.call(this, key,
            this === storage && storageKeys.has(key) ? cleaned(String(value)) : value);
    };
})();
