// Intercept only the new-conversation composer atom at Codex's existing IPC
// boundary. Authentication, project selection, conversation drafts and all
// unrelated persisted atoms continue through the native Codex handler.
function scmToolkitProtectCodexDrafts(provider, vscode) {
    if (provider.scmToolkitCodexDraftsProtected) return provider;
    provider.scmToolkitCodexDraftsProtected = true;
    scmToolkitProtectCodexAttachments(provider, vscode);
    const atom = 'composer-prompt-drafts-v1';
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
        delete copy['new-conversation'];
        if (typeof draft === 'string' && draft) copy['new-conversation'] = draft;
        return typeof value === 'string' ? JSON.stringify(copy) : copy;
    };
    const scrub = message => ({ ...message,
        state: { ...message.state,
            [atom]: replaceDraft(message.state[atom] ?? {}, null) } });
    const read = () => vscode.commands.executeCommand('sweetiebot.codexDraft.read');
    const write = draft => vscode.commands.executeCommand('sweetiebot.codexDraft.write', draft);
    const originalHandle = provider.handleMessage;
    provider.handleMessage = function(webview, message, ...rest) {
        if (message?.type !== 'persisted-atom-update' || message.key !== atom || !unpack(message.value)) {
            return originalHandle.call(this, webview, message, ...rest);
        }
        const drafts = unpack(message.value);
        const draft = own(drafts, 'new-conversation') ? drafts['new-conversation'] : null;
        // Do not persist the global new-conversation slot even if the scoped
        // write fails; that would expose this draft to another repository.
        const safe = { ...message, value: replaceDraft(message.value, null) };
        if (draft !== null && typeof draft !== 'string') {
            return originalHandle.call(this, webview, safe, ...rest);
        }
        return Promise.resolve().then(() => write(draft)).catch(() => false)
            .then(() => originalHandle.call(this, webview, safe, ...rest));
    };
    const originalInitialize = provider.initializeWebview;
    provider.initializeWebview = function(webview, ...args) {
        const originalPost = webview.postMessage;
        webview.postMessage = function(message, ...rest) {
            const snapshot = message?.type === 'persisted-atom-sync' &&
                message.state && typeof message.state === 'object' && !Array.isArray(message.state);
            const broadcast = message?.type === 'persisted-atom-updated' &&
                message.key === atom && unpack(message.value);
            if (!snapshot && !broadcast) return originalPost.call(this, message, ...rest);
            return Promise.resolve().then(read).then(result => {
                if (!result?.enabled) return originalPost.call(this, message, ...rest);
                const draft = typeof result.draft === 'string' ? result.draft : null;
                const safe = snapshot ? {
                    ...message, state: { ...message.state,
                        [atom]: replaceDraft(message.state[atom] ?? {}, draft) }
                } : { ...message, value: replaceDraft(message.value, draft) };
                return originalPost.call(this, safe, ...rest);
            }, () => originalPost.call(this,
                snapshot ? scrub(message) : { ...message, value: replaceDraft(message.value, null) }, ...rest));
        };
        return originalInitialize.call(this, webview, ...args);
    };
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
        writing = writing.catch(() => {}).then(() =>
            vscode.commands.executeCommand('sweetiebot.codexDraft.writeAttachments', value));
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
