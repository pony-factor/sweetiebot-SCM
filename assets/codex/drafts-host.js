// Isolate the native new-chat slot for both full-map and record-update stores.
// Thread drafts and unrelated atoms retain the native Codex persistence path.
function scmToolkitProtectCodexDrafts(provider, vscode) {
    if (provider.scmToolkitCodexDraftsProtected) return provider;
    provider.scmToolkitCodexDraftsProtected = true;
    const scopes = provider.scmToolkitDraftScopes = new WeakMap();
    const generations = provider.scmToolkitDraftGenerations = new WeakMap();
    const views = new Set();
    scmToolkitProtectCodexAttachments(provider, vscode);
    const atoms = ['composer-prompt-drafts-v1', 'composer-prompt-drafts-v2'];
    const slot = 'new-conversation';
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const unpack = value => {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        if (typeof value !== 'string') return null;
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    };
    const replaceDraft = (value, draft) => {
        const parsed = unpack(value);
        if (!parsed) return value;
        const copy = { ...parsed };
        delete copy[slot];
        if (draft !== null && draft !== undefined && draft !== '') copy[slot] = draft;
        return typeof value === 'string' ? JSON.stringify(copy) : copy;
    };
    let writing = Promise.resolve();
    const read = () => writing.then(() => vscode.commands.executeCommand('sweetiebot.codexDraft.read'));
    const originalHandle = provider.handleMessage;
    provider.handleMessage = function(webview, message, ...rest) {
        if (message?.type !== 'persisted-atom-update' || !atoms.includes(message.key)) {
            return originalHandle.call(this, webview, message, ...rest);
        }
        const drafts = unpack(message.value);
        const entries = unpack(message.recordUpdate?.entries);
        if (!drafts && !entries && !message.deleted) return originalHandle.call(this, webview, message, ...rest);
        const safe = { ...message, value: replaceDraft(message.value, null) };
        // Strip scoped data from record updates too, including expectedValue.
        // Unconditionally retire any old account-wide copy of this slot.
        if (entries) safe.recordUpdate = { ...message.recordUpdate,
            entries: { ...entries, [slot]: { delete: true } } };
        const changed = entries ? own(entries, slot) : true;
        const entry = entries?.[slot];
        const draft = message.deleted || (entries ? entry == null || own(entry, 'delete') : !own(drafts, slot))
            ? null : entries ? entry.value : drafts[slot];
        const options = { scope: message.scmToolkitDraftScope || scopes.get(webview),
            generation: message.scmToolkitDraftGeneration ?? generations.get(webview),
            ...(entry && own(entry, 'expectedValue') ? { expectedValue: entry.expectedValue } : {}) };
        if (changed) writing = writing.catch(() => {}).then(() =>
            vscode.commands.executeCommand('sweetiebot.codexDraft.write', draft, options));
        return writing.then(() => originalHandle.call(this, webview, safe, ...rest));
    };
    const originalInitialize = provider.initializeWebview;
    provider.initializeWebview = function(webview, ...args) {
        views.add(webview);
        const originalPost = webview.postMessage;
        webview.postMessage = function(message, ...rest) {
            const snapshot = message?.type === 'persisted-atom-sync' &&
                message.state && typeof message.state === 'object' && !Array.isArray(message.state);
            const broadcast = message?.type === 'persisted-atom-updated' && atoms.includes(message.key);
            if (!snapshot && !broadcast) return originalPost.call(this, message, ...rest);
            const scoped = draft => {
                if (!snapshot) return { ...message, deleted: false, value: replaceDraft(message.value ?? {}, draft) };
                const state = { ...message.state };
                for (const atom of atoms) {
                    // Keep v2 absent on an older store so native v1 migration works.
                    if (atom === atoms[0] || own(state, atom)) state[atom] = replaceDraft(state[atom] ?? {}, draft);
                }
                return { ...message, state };
            };
            return Promise.resolve().then(read).then(result => {
                if (result?.scope) scopes.set(webview, result.scope);
                if (result?.generation !== undefined) generations.set(webview, result.generation);
                return originalPost.call(this, { ...scoped(result?.enabled ? result.draft : null),
                    scmToolkitDraftScope: result?.scope, scmToolkitDraftGeneration: result?.generation }, ...rest);
            },
                () => originalPost.call(this, scoped(null), ...rest));
        };
        return originalInitialize.call(this, webview, ...args);
    };
    vscode.commands.registerCommand('sweetiebot.codexDraft.refresh', async () => {
        for (const webview of views) {
            try { await provider.sendPersistedAtomState?.(webview); }
            catch { views.delete(webview); }
        }
    });
    return provider;
}

// Attachment records include image data URLs/local paths, file metadata and
// display order. Keep their native shape and isolate the entire map by workspace.
function scmToolkitProtectCodexAttachments(provider, vscode) {
    const key = 'sweetiebot-composer-attachments-v1';
    const originalHandle = provider.handleMessage;
    let writing = Promise.resolve();
    provider.handleMessage = function(webview, message, ...rest) {
        if (message?.type !== 'persisted-atom-update' || message.key !== key) {
            return originalHandle.call(this, webview, message, ...rest);
        }
        let value = message.value;
        try { if (typeof value === 'string') value = JSON.parse(value); }
        catch { return Promise.reject(new Error('Invalid Codex attachment draft.')); }
        const options = { scope: message.scmToolkitDraftScope || provider.scmToolkitDraftScopes?.get(webview),
            generation: message.scmToolkitDraftGeneration ?? provider.scmToolkitDraftGenerations?.get(webview) };
        writing = writing.catch(() => {}).then(() =>
            vscode.commands.executeCommand('sweetiebot.codexDraft.writeAttachments', value, options));
        // The native account-wide atom must never receive workspace attachments.
        return writing;
    };
    const initialize = provider.initializeWebview;
    provider.initializeWebview = function(webview, ...args) {
        const post = webview.postMessage;
        webview.postMessage = function(message, ...rest) {
            const snapshot = message?.type === 'persisted-atom-sync' && message.state;
            const broadcast = message?.type === 'persisted-atom-updated' && message.key === key;
            if (!snapshot && !broadcast) return post.call(this, message, ...rest);
            return writing.then(() => vscode.commands.executeCommand('sweetiebot.codexDraft.readAttachments'))
                .then(result => {
                    const value = result?.enabled ? result.drafts : {};
                    return post.call(this, snapshot
                        ? { ...message, state: { ...message.state, [key]: value } }
                        : { ...message, value }, ...rest);
                });
        };
        return initialize.call(this, webview, ...args);
    };
}
