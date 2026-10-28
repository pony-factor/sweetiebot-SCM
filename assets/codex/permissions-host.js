// Expose the existing Codex permissions menu without changing access policies.
function scmToolkitRegisterCodexPermissions(provider, vscode) {
    const views = new Set();
    const pending = new Map();
    const originalInitialize = provider.initializeWebview;
    const originalHandle = provider.handleMessage;
    const update = webview => webview.postMessage({
        type: 'sweetiebot-permissions-visibility',
        hidden: vscode.workspace?.getConfiguration('scmToolkit')?.get('codexHidePermissionsIcon', false) === true
    });
    provider.initializeWebview = function(webview, role, onDispose, ...args) {
        views.add(webview);
        onDispose(() => views.delete(webview));
        return originalInitialize.call(this, webview, role, onDispose, ...args);
    };
    provider.handleMessage = function(webview, message) {
        if (message?.type === 'sweetiebot-permissions-ready') { void update(webview); return; }
        if (message?.type === 'sweetiebot-permissions-opened') {
            const request = pending.get(message.id);
            if (!request || request.webview !== webview) return;
            pending.delete(message.id); clearTimeout(request.timer);
            if (message.opened) request.resolve();
            else request.reject(new Error('Codex could not open its permissions menu. Open a chat composer and try again.'));
            return;
        }
        return originalHandle.call(this, webview, message);
    };
    const changed = vscode.workspace?.onDidChangeConfiguration?.(event => {
        if (event.affectsConfiguration('scmToolkit.codexHidePermissionsIcon')) {
            for (const view of views) void update(view);
        }
    });
    const command = vscode.commands.registerCommand('sweetiebot.codex.openPermissions', async () => {
        await vscode.commands.executeCommand('chatgpt.openSidebar');
        provider.sidebarView?.show?.(false);
        const view = provider.sidebarView?.webview || [...views].at(-1);
        if (!view) throw new Error('Open the Codex sidebar before changing permissions.');
        const id = require('node:crypto').randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {pending.delete(id); reject(new Error('Codex did not confirm its permissions menu. Reload the Codex window and try again.'));}, 5000);
            pending.set(id, {resolve, reject, timer, webview: view});
            void view.postMessage({type: 'sweetiebot-open-permissions', id}).then(sent => {
                if (!sent) {clearTimeout(timer); pending.delete(id); reject(new Error('The Codex view is unavailable.'));}
            }, reject);
        });
    });
    return {dispose() {
        changed?.dispose(); command.dispose(); views.clear();
        for (const request of pending.values()) {clearTimeout(request.timer); request.reject(new Error('Codex permissions chooser closed.'));}
        pending.clear();
        provider.initializeWebview = originalInitialize;
        provider.handleMessage = originalHandle;
    }};
}
