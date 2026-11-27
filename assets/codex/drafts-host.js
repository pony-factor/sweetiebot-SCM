// Keep the entire composer state off Codex's account-wide persisted atoms.
function scmToolkitProtectCodexDrafts(provider, vscode) {
    if (provider.scmToolkitCodexDraftsProtected) return provider;
    provider.scmToolkitCodexDraftsProtected = true;
    const atoms = new Set([
        'composer-prompt-drafts-v1', 'composer-prompt-drafts-v2',
        'composer-retained-documents-v1', 'draft-thread-identities-v1',
        'sweetiebot-composer-attachments-v1'
    ]);
    const views = new Map();
    const command = (name, ...args) => vscode.commands.executeCommand('sweetiebot.codexDraft.' + name, ...args);
    const originalHandle = provider.handleMessage;
    provider.handleMessage = async function(webview, message, ...rest) {
        const view = views.get(webview);
        if (view && message?.type === 'persisted-atom-sync-request' && message.scmToolkitDraftRenderer) {
            if (message.scmToolkitDraftRenderer === view.retiredRenderer) return;
            view.renderer = message.scmToolkitDraftRenderer;
            view.remounting = false;
        }
        if (message?.type !== 'persisted-atom-update' || !atoms.has(message.key)) {
            return originalHandle.call(this, webview, message, ...rest);
        }
        if (!view?.scope || message.scmToolkitDraftRenderer !== view.renderer ||
            message.scmToolkitDraftScope !== view.scope ||
            message.scmToolkitDraftGeneration !== view.generation) return;
        const result = await command('writeAtom', message, { scope: view.scope, generation: view.generation });
        if (!result) return;
        for (const receiver of views.values()) {
            if (receiver.scope !== result.scope || receiver.generation !== result.generation) continue;
            const value = result.atoms[message.key];
            void receiver.post({ type: 'persisted-atom-updated', key: message.key, value, deleted: value === undefined });
        }
    };
    const originalInitialize = provider.initializeWebview;
    provider.initializeWebview = function(webview, role, onDispose, ...args) {
        if (!views.has(webview)) {
            const post = webview.postMessage.bind(webview);
            const view = { post, refresh: 0 };
            views.set(webview, view);
            onDispose?.(() => views.delete(webview));
            webview.postMessage = async function(message, ...rest) {
                if (message?.type === 'persisted-atom-updated' && atoms.has(message.key)) return true;
                if (message?.type !== 'persisted-atom-sync') return post(message, ...rest);
                if (view.remounting) return true;
                const result = await Promise.resolve().then(() => command('readAtoms')).catch(() => null);
                if (view.remounting) return true;
                if (view.scope && result?.scope && view.scope !== result.scope && webview.html) {
                    // The mounted editor keeps its own document after atom hydration.
                    // Renew this webview before giving any editor the new scope.
                    view.scope = undefined;
                    view.generation = undefined;
                    view.remounting = true;
                    view.retiredRenderer = view.renderer;
                    view.renderer = undefined;
                    try { view.thread = await provider.scmToolkitReadDraftThread?.(webview); }
                    catch { view.thread = undefined; }
                    const html = webview.html.replace(/\n<!-- sweetiebot-draft-refresh \d+ -->$/, '');
                    webview.html = html + '\n<!-- sweetiebot-draft-refresh ' + (++view.refresh) + ' -->';
                    return true;
                }
                const state = { ...message.state };
                for (const atom of atoms) delete state[atom];
                Object.assign(state, result?.atoms);
                view.scope = result?.scope;
                view.generation = result?.generation;
                const thread = view.thread;
                view.thread = undefined;
                return post({ ...message, state, scmToolkitDraftScope: view.scope,
                    scmToolkitDraftGeneration: view.generation, scmToolkitDraftThread: thread }, ...rest);
            };
        }
        return originalInitialize.call(this, webview, role, onDispose, ...args);
    };
    vscode.commands.registerCommand('sweetiebot.codexDraft.refresh', async () => {
        for (const webview of views.keys()) await provider.sendPersistedAtomState?.(webview);
    });
    return provider;
}
