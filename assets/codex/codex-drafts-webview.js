// Installed before Codex's bundle runs. Its browser-origin fallback is shared
// by webviews, so prevent an unsent new-chat draft in localStorage from seeding
// another repository before the scoped host sync finishes. Preserve raw data.
(() => {
    const storageKey = 'codex:persisted-atom:composer-prompt-drafts-v1';
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
        return this === storage && key === storageKey ? cleaned(value) : value;
    };
    Storage.prototype.setItem = function(key, value) {
        return originalSet.call(this, key,
            this === storage && key === storageKey ? cleaned(String(value)) : value);
    };
})();
