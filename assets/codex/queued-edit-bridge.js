// Called from a guarded native store adapter, without running DOM work at import time.
function scmToolkitRegisterQueueStore(threadId, hostId, store, coordinator) {
    try {
        if (!threadId || typeof store?.actions?.get !== 'function'
            || typeof store.actions.send !== 'function' || typeof store.actions.beginEdit !== 'function' || typeof store.actions.restoreEdit !== 'function') return store;
        const registry = globalThis.scmToolkitQueuedEditStores ??= new Map();
        const adapter = {threadId, hostId, actions:store.actions, coordinator};
        registry.set(JSON.stringify([hostId, threadId]), adapter);
        globalThis.scmToolkitQueuedEditCurrent = adapter;
        // Notifications run after the native render has completed.
        queueMicrotask(() => { try { window.dispatchEvent(new CustomEvent('scm-toolkit-queue-store', {detail:adapter})); } catch {} });
    } catch {}
    return store;
}
function scmToolkitQueueRowRef(nativeRef, id, hostId) {
    try {
        if (typeof nativeRef !== 'function') return nativeRef;
        const refs = globalThis.scmToolkitQueueRowRefs ??= new WeakMap();
        let byId = refs.get(nativeRef);
        if (!byId) refs.set(nativeRef, byId = new Map());
        const key = JSON.stringify([hostId, id]);
        if (!byId.has(key)) byId.set(key, element => {
            const cleanup = nativeRef(element);
            try { if (element) { element.dataset.scmToolkitQueueId = id; element.dataset.scmToolkitQueueHost = String(hostId); } } catch {}
            return cleanup;
        });
        return byId.get(key);
    } catch { return nativeRef; }
}
