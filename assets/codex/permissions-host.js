// Expose the existing Codex permissions menu without changing access policies.
function scmToolkitRegisterCodexPermissions(provider, vscode) {
    const views = new Set();
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
        if (!view || !await view.postMessage({type: 'sweetiebot-open-permissions'})) {
            throw new Error('Open the Codex sidebar before changing permissions.');
        }
    });
    return {dispose() {
        changed?.dispose(); command.dispose(); views.clear();
        provider.initializeWebview = originalInitialize;
        provider.handleMessage = originalHandle;
    }};
}
