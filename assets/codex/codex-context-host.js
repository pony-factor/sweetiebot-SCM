// Registered inside each Codex extension host, so requests stay in this window.
function scmToolkitRegisterCodexSnapshotProvider(provider, vscode) {
    const pending = new Map();
    const listeners = new Set();
    const originalInitialize = provider.initializeWebview;
    const originalHandleMessage = provider.handleMessage;
    const crypto = require('crypto');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const extensionId = 'jfwooten4.scm-toolkit-workspace-search';

    const sourceFor = conversationId => {
        const value = String(conversationId ?? '').trim();
        if (!uuid.test(value)) return undefined;
        const deepLink = `vscode://${extensionId}/codex/${value}`;
        return {
            kind: 'codex',
            uuid: value,
            url: `https://vscode.dev/redirect?url=${encodeURIComponent(deepLink)}`,
        };
    };

    provider.handleMessage = function(webview, message) {
        if (message?.type === 'scm-toolkit-context-response') return;
        return originalHandleMessage.call(this, webview, message);
    };
    provider.initializeWebview = function(webview, role, onDispose, ...args) {
        const listener = webview.onDidReceiveMessage(message => {
            const request = pending.get(message?.id);
            if (message?.type !== 'scm-toolkit-context-response' || request?.webview !== webview) return;
            pending.delete(message.id);
            clearTimeout(request.timeout);
            const text = typeof message.text === 'string' ? message.text.trim().slice(-6000) : '';
            if (!text) {
                request.reject(new Error('Open a Codex conversation with text in this window first.'));
                return;
            }
            if (request.includeSource) {
                request.resolve({ text, source: sourceFor(message.conversationId) });
            } else {
                request.resolve(text);
            }
        });
        listeners.add(listener);
        onDispose(() => {
            listener.dispose();
            listeners.delete(listener);
            for (const [id, request] of pending) {
                if (request.webview !== webview) continue;
                clearTimeout(request.timeout);
                pending.delete(id);
                request.reject(new Error('The Codex view closed before its text could be captured.'));
            }
        });
        return originalInitialize.call(this, webview, role, onDispose, ...args);
    };

    const capture = includeSource => {
        const panels = [...provider.editorPanels.keys()].filter(panel => provider.getWebviewForPanel(panel));
        const activePanel = panels.find(panel => {
            try { return panel.active; } catch { return false; }
        });
        const sidebars = [...provider.sidebarViews];
        const focusedPanel = provider.focusedView?.kind === 'panel' ? provider.focusedView.panel : undefined;
        const focusedWebview = focusedPanel ? provider.getWebviewForPanel(focusedPanel)
            : provider.focusedView?.kind === 'sidebar' ? provider.sidebarView?.webview : undefined;
        const sidebar = sidebars.find(view => view.visible) ?? provider.sidebarView ?? sidebars[0];
        const webview = focusedWebview ?? (activePanel ? provider.getWebviewForPanel(activePanel) : sidebar?.webview)
            ?? (panels.length === 1 ? provider.getWebviewForPanel(panels[0]) : undefined);
        if (!webview) throw new Error('Open a Codex conversation in this window first.');
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error('Codex text capture timed out. Reopen this window after installing the toolkit.'));
            }, 5000);
            pending.set(id, { webview, resolve, reject, timeout, includeSource });
            webview.postMessage({ type: 'scm-toolkit-context-request', id }).then(sent => {
                if (!sent && pending.has(id)) {
                    clearTimeout(timeout);
                    pending.delete(id);
                    reject(new Error('The Codex view is unavailable.'));
                }
            }, error => {
                clearTimeout(timeout);
                pending.delete(id);
                reject(error);
            });
        });
    };

    const textCommand = vscode.commands.registerCommand(
        'scmToolkit.readCodexContext',
        () => capture(false)
    );
    const sourceCommand = vscode.commands.registerCommand(
        'scmToolkit.readCodexConversation',
        () => capture(true)
    );

    return { dispose() {
        textCommand.dispose();
        sourceCommand.dispose();
        provider.initializeWebview = originalInitialize;
        provider.handleMessage = originalHandleMessage;
        for (const listener of listeners) listener.dispose();
        for (const request of pending.values()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Codex text capture was disposed.'));
        }
        pending.clear();
    } };
}
