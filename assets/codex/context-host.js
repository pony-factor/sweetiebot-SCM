// Registered inside each Codex extension host, so requests stay in this window.
function scmToolkitRegisterCodexSnapshotProvider(provider, vscode) {
    const pending = new Map();
    const listeners = new Set();
    const originalInitialize = provider.initializeWebview;
    const originalHandleMessage = provider.handleMessage;
    const crypto = require('crypto');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const extensionId = 'jfwooten4.scm-toolkit-workspace-search';
    const resumeEnabled = () => vscode.workspace?.getConfiguration('sweetiebot')
        ?.get('codexContinueAtReset', false) === true;
    const sendResumeSetting = webview => webview?.postMessage?.({
        type: 'scm-toolkit-resume-setting', enabled: resumeEnabled()
    });
    const resumeSubscription = vscode.workspace?.onDidChangeConfiguration?.(event => {
        if (!event.affectsConfiguration('sweetiebot.codexContinueAtReset')) return;
        const views = new Set([...provider.sidebarViews].map(view => view.webview));
        if (provider.sidebarView?.webview) views.add(provider.sidebarView.webview);
        for (const panel of provider.editorPanels.keys()) {
            const view = provider.getWebviewForPanel(panel);
            if (view) views.add(view);
        }
        for (const view of views) void sendResumeSetting(view);
    });

    // Workspace roots can change without navigating the Codex chat.
    const checkoutSubscription = vscode.workspace?.onDidChangeWorkspaceFolders?.(() => {
        const views = new Set([...provider.sidebarViews].map(view => view.webview));
        if (provider.sidebarView?.webview) views.add(provider.sidebarView.webview);
        for (const panel of provider.editorPanels.keys()) {
            const view = provider.getWebviewForPanel(panel);
            if (view) views.add(view);
        }
        for (const view of views) void view?.postMessage?.({ type: 'scm-toolkit-checkout-visibility-refresh' });
    });

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
        if (message?.type === 'scm-toolkit-read-resume-setting') {
            void sendResumeSetting(webview);
            return;
        }
        if (message?.type === 'scm-toolkit-read-limit-reset') {
            void vscode.commands.executeCommand('sweetiebot.codex.readRateLimitReset', message)
                .then(result => webview.postMessage({ type: 'scm-toolkit-limit-reset-result',
                    threadId: message.threadId, requestId: message.requestId, ...result }))
                .catch(() => webview.postMessage({ type: 'scm-toolkit-limit-reset-result',
                    threadId: message.threadId, requestId: message.requestId, known: false }));
            return;
        }
        if (message?.type === 'scm-toolkit-continue-at-reset') {
            if (!resumeEnabled()) return;
            void vscode.commands.executeCommand('sweetiebot.codex.continueAfterRateLimit', message)
                .catch(error => vscode.window.showWarningMessage('Automatic continuation paused: ' + error.message));
            return;
        }
        if (message?.type === 'scm-toolkit-checkout-visibility-request') {
            if (!uuid.test(message.threadId ?? '') || !Number.isSafeInteger(message.requestId)) return;
            const reply = show => webview.postMessage({ type: 'scm-toolkit-checkout-visibility-result',
                threadId: message.threadId, requestId: message.requestId, show });
            void vscode.commands.executeCommand('sweetiebot.codex.chatCheckoutVisibility', message.threadId)
                .then(result => reply(result?.threadId === message.threadId && result?.needsNewWindow === true))
                .catch(() => reply(false));
            return;
        }
        if (message?.type === 'scm-toolkit-open-chat-checkout') {
            // Resolve identity in this host; never accept a filesystem path from the DOM.
            void vscode.commands.executeCommand('sweetiebot.codex.openChatCheckout', message.threadId)
                .catch(error => vscode.window.showErrorMessage('Cannot open this chat’s checkout: ' + error.message));
            return;
        }
        if (message?.type === 'scm-toolkit-restore-conversation') {
            // Only navigate to a validated local chat UUID; never trust a webview path or URL.
            if (uuid.test(message.conversationId ?? '')) {
                this.postMessageToWebview(webview, {
                    type: 'navigate-to-route', path: `/local/${message.conversationId}`
                });
            }
            return;
        }
        if (message?.type === 'scm-toolkit-context-response') return;
        return originalHandleMessage.call(this, webview, message);
    };
    provider.initializeWebview = function(webview, role, onDispose, ...args) {
        const listener = webview.onDidReceiveMessage(message => {
            const request = pending.get(message?.id);
            if (message?.type !== 'scm-toolkit-context-response' || request?.webview !== webview) return;
            if (message.nativeCopy && !request.shareOnly && !request.identityOnly && !request.modelOnly && !request.reloadState) {
                if (request.copying) return;
                request.copying = true;
                void (async () => {
                    if (!uuid.test(message.conversationId || '') ||
                        (request.threadId && request.threadId !== message.conversationId))
                        throw new Error('The active Codex chat changed during capture.');
                    const expected = request.text === undefined ? 'markdown' : 'deeplink';
                    if (message.nativeCopy !== expected) throw new Error('Unexpected Codex copy response.');
                    const until = Date.now() + 15000;
                    let value;
                    do {
                        value = await vscode.env.clipboard.readText();
                        if (value && value !== request.marker) break;
                        await new Promise(resolve => setTimeout(resolve, 50));
                    } while (Date.now() < until);
                    if (!value || value === request.marker) throw new Error('Codex did not copy the requested chat content.');
                    if (expected === 'markdown') {
                        request.text = value;
                        request.threadId = message.conversationId;
                        request.marker = crypto.randomUUID();
                        await vscode.env.clipboard.writeText(request.marker);
                        request.copying = false;
                        await webview.postMessage({ type: 'scm-toolkit-context-request', id: message.id,
                            copyDeepLink: true, expectedThreadId: request.threadId });
                        return;
                    }
                    const link = new URL(value.trim());
                    if (link.protocol !== 'codex:' || link.hostname !== 'threads' ||
                        link.pathname !== '/' + request.threadId || link.username || link.password || link.port || link.hash)
                        throw new Error('Codex did not copy a deeplink for the originating chat.');
                    pending.delete(message.id);
                    clearTimeout(request.timeout);
                    await vscode.env.clipboard.writeText(request.clipboard);
                    // Native Markdown includes tool activity and inline image data.
                    // Remove those before transport bounding so actual user turns
                    // and assistant replies are not displaced by binary payloads.
                    const text = request.text
                        .replace(/^<details><summary>\d+ previous messages?<\/summary>[\s\S]*?^<\/details>/gm,
                            '[Tool activity omitted from drafting context.]')
                        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi,
                            'attachment:image-data-omitted')
                        .trim();
                    request.resolve(request.includeSource ? { text,
                        source: { ...sourceFor(request.threadId), desktopUrl: value.trim() }, model: message.model } : text);
                })().catch(async error => {
                    pending.delete(message.id);
                    clearTimeout(request.timeout);
                    await vscode.env.clipboard.writeText(request.clipboard);
                    request.reject(error);
                });
                return;
            }
            pending.delete(message.id);
            clearTimeout(request.timeout);
            if (message.error) {
                if (request.clipboard !== undefined) void vscode.env.clipboard.writeText(request.clipboard);
                request.reject(new Error(message.error));
                return;
            }
            if (request.reloadState) {
                // Restore only an identified chat. No conversation text is captured.
                request.resolve(uuid.test(message.conversationId ?? ''));
                return;
            }
            if (request.shareOnly) {
                if (message.error || message.conversationId !== request.shareOnly) {
                    request.reject(new Error(message.error || 'The active chat changed while sharing.'));
                    return;
                }
                void vscode.env.clipboard.readText().then(async value => {
                    const until = Date.now() + 5000;
                    while (!/^https:\/\/chatgpt\.com\/s\/cx_[A-Za-z0-9_-]{16,128}$/.test(value) && Date.now() < until) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        value = await vscode.env.clipboard.readText();
                    }
                    if (!/^https:\/\/chatgpt\.com\/s\/cx_[A-Za-z0-9_-]{16,128}$/.test(value)) {
                        throw new Error('Codex did not copy a verified public chat link.');
                    }
                    if (request.clipboard !== undefined) await vscode.env.clipboard.writeText(request.clipboard);
                    request.resolve({ ...sourceFor(message.conversationId), sharedUrl: value });
                }).catch(request.reject);
                return;
            }
            if (request.identityOnly) {
                if (message.hasConversation && !uuid.test(message.conversationId ?? '')) {
                    request.reject(new Error('Cannot identify the visible Codex chat; its worker was not moved.'));
                    return;
                }
                request.resolve({ threadId: uuid.test(message.conversationId ?? '') ? message.conversationId : null });
                return;
            }
            if (request.modelOnly) {
                const label = value => typeof value === 'string' && value.length <= 100
                    ? value.replace(/\s+/g, ' ').trim() : '';
                request.resolve({ name: label(message.model?.name), effort: label(message.model?.effort) });
                return;
            }
            // Keep a substantial transcript for PR intent, not merely its last
            // few turns. URL transport will independently enforce its 70 KB cap.
            const clipped = typeof message.text === 'string' ? message.text.trim().slice(-95000) : '';
            // Never start the URL-bound context with a split UTF-16 surrogate.
            const text = /^[\uDC00-\uDFFF]/.test(clipped) ? clipped.slice(1) : clipped;
            if (!text) {
                request.reject(new Error('Open a Codex conversation with text in this window first.'));
                return;
            }
            if (request.includeSource) {
                const label = value => typeof value === 'string' && value.length <= 100
                    ? value.replace(/\s+/g, ' ').trim() : '';
                const name = label(message.model?.name);
                const effort = label(message.model?.effort);
                request.resolve({ text, source: sourceFor(message.conversationId),
                    ...((name || effort) ? { model: { name, effort } } : {}) });
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

    const captureRaw = (includeSource, identityOnly = false, modelOnly = false, shareOnly = false, clipboard, reloadState = false, clipboardMarker) => {
        const panels = [...provider.editorPanels.keys()].filter(panel => provider.getWebviewForPanel(panel));
        const activePanel = panels.find(panel => {
            try { return panel.active; } catch { return false; }
        });
        const sidebars = [...provider.sidebarViews];
        const focusedPanel = provider.focusedView?.kind === 'panel' ? provider.focusedView.panel : undefined;
        const focusedWebview = focusedPanel ? provider.getWebviewForPanel(focusedPanel)
            : provider.focusedView?.kind === 'sidebar' ? provider.sidebarView?.webview : undefined;
        const sidebar = sidebars.find(view => view.visible) ?? provider.sidebarView ?? sidebars[0];
        // Background windows and hidden views must not reopen a previous chat.
        if (reloadState && !activePanel && !sidebar?.visible) return Promise.resolve(false);
        const webview = focusedWebview ?? (activePanel ? provider.getWebviewForPanel(activePanel) : sidebar?.webview)
            ?? (panels.length === 1 ? provider.getWebviewForPanel(panels[0]) : undefined);
        if (!webview) {
            if (reloadState) return Promise.resolve(false);
            if (identityOnly) return { threadId: null };
            throw new Error('Open a Codex conversation in this window first.');
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error(shareOnly
                    ? 'Codex Share is still preparing. PR creation can continue without its public link.'
                    : 'Codex text capture timed out. Reopen this window after installing the toolkit.'));
                if (clipboard !== undefined) void vscode.env.clipboard.writeText(clipboard);
            }, shareOnly ? 155000 : (identityOnly || modelOnly || reloadState) ? 5000 : 45000);
            pending.set(id, { webview, resolve, reject, timeout, includeSource, identityOnly, modelOnly, shareOnly, clipboard, reloadState, marker: clipboardMarker });
            const allowHidden = !activePanel && !sidebars.some(view => view.webview === webview && view.visible);
            webview.postMessage({ type: 'scm-toolkit-context-request', id, identityOnly, modelOnly, allowHidden, shareOnly, reloadState }).then(sent => {
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

    let copying = false;
    const capture = (includeSource, identityOnly = false, modelOnly = false, shareOnly = false, clipboard, reloadState = false) => {
        if (identityOnly || modelOnly || reloadState) return captureRaw(includeSource, identityOnly, modelOnly, shareOnly, clipboard, reloadState);
        if (copying) return Promise.reject(new Error('A Codex copy is already in progress. Retry when it finishes.'));
        copying = true;
        return (async () => {
            const saved = clipboard ?? await vscode.env.clipboard.readText();
            const marker = crypto.randomUUID();
            try {
                await vscode.env.clipboard.writeText(marker);
                return await captureRaw(includeSource, false, false, shareOnly, saved, false, marker);
            } finally {
                await vscode.env.clipboard.writeText(saved);
                copying = false;
            }
        })();
    };

    const textCommand = vscode.commands.registerCommand(
        'sweetiebot.readCodexContext',
        () => capture(false)
    );
    const sourceCommand = vscode.commands.registerCommand(
        'sweetiebot.readCodexConversation',
        () => capture(true)
    );
    const reloadCommand = vscode.commands.registerCommand(
        'sweetiebot.preserveCodexConversation',
        () => capture(false, false, false, false, undefined, true)
    );
    const shareCommand = vscode.commands.registerCommand('sweetiebot.shareCodexConversation', async threadId => {
        if (!uuid.test(threadId || '')) throw new Error('A verified active Codex chat is required.');
        return capture(false, false, false, threadId, await vscode.env.clipboard.readText());
    });
    const identityCommand = vscode.commands.registerCommand('sweetiebot.readCodexIdentity', () => capture(false, true));
    const modelCommand = vscode.commands.registerCommand('sweetiebot.readCodexModel', () => capture(false, false, true));
    const legacyTextCommand = vscode.commands.registerCommand(
        'scmToolkit.readCodexContext', () => capture(false)
    );
    const legacySourceCommand = vscode.commands.registerCommand(
        'scmToolkit.readCodexConversation', () => capture(true)
    );

    return { dispose() {
        textCommand.dispose();
        sourceCommand.dispose();
        reloadCommand.dispose();
        identityCommand.dispose();
        shareCommand.dispose();
        modelCommand.dispose();
        legacyTextCommand.dispose();
        legacySourceCommand.dispose();
        resumeSubscription?.dispose();
        checkoutSubscription?.dispose();
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
