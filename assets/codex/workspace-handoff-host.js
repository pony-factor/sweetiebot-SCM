// Explicit, window-local thread handoff. Never inspect rollout or auth files.
function scmToolkitRegisterCodexWorkspaceHandoff(provider, vscode) {
    const { randomUUID } = require('node:crypto');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const connection = provider.codexMcpConnection;
    const pending = new Map();
    const bindings = new Map();
    const providerName = 'sweetiebot-workspace-handoff';
    const subscriptions = [];
    const originalSend = connection?.sendProviderRequest;
    const failPending = () => {
        for (const request of pending.values()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Codex disconnected during the checkout handoff.'));
        }
        pending.clear();
    };
    if (connection) {
        subscriptions.push(connection.registerProvider(providerName, {
            onResult(message) {
                const request = pending.get(String(message.id));
                if (!request) return;
                pending.delete(String(message.id));
                clearTimeout(request.timeout);
                if (message.error) request.reject(new Error('Codex refused the checkout handoff (' + request.method + ').'));
                else request.resolve(message.result);
            },
            onFatalError: failPending
        }));
    }
    const send = (method, params) => new Promise((resolve, reject) => {
        if (!connection) { reject(new Error('Reload this window to enable Codex checkout handoff.')); return; }
        const id = randomUUID();
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Codex checkout handoff timed out (' + method + ').'));
        }, 15000);
        pending.set(id, { resolve, reject, timeout, method });
        try { connection.sendRequest(providerName, id, method, params); }
        catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
    });
    const canonical = value => typeof value === 'string' && path.isAbsolute(value)
        ? fs.realpath(value) : Promise.reject(new Error('Codex did not report an absolute checkout path.'));
    const read = async threadId => {
        const result = await send('thread/read', { threadId, includeTurns: false });
        if (result?.thread?.id !== threadId) throw new Error('Codex returned a different chat during checkout handoff.');
        return result.thread;
    };
    // A frontend cache must not override the verified destination on its next
    // resume or user turn. Only this explicitly handed-off thread is affected.
    const guardedSend = typeof originalSend === 'function' ? function (name, id, method, params, ...rest) {
        const cwd = bindings.get(params?.threadId);
        if (cwd && ['thread/resume', 'turn/start', 'turn/addUserMessage'].includes(method)) params = { ...params, cwd };
        return originalSend.call(this, name, id, method, params, ...rest);
    } : undefined;
    if (guardedSend) connection.sendProviderRequest = guardedSend;

    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.openChatCheckout', async expectedThreadId => {
        const identity = await vscode.commands.executeCommand('sweetiebot.readCodexIdentity');
        if (!identity?.threadId || identity.threadId !== expectedThreadId) {
            throw new Error('The visible chat changed. Try the button again.');
        }
        const thread = await read(identity.threadId);
        const cwd = await canonical(thread.cwd);
        if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The recorded checkout is not a folder.');
        // Opening the existing folder does not checkout a branch, interrupt a turn,
        // or rebind the worker. Keep this window and its drafts intact.
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
        return { threadId: identity.threadId, cwd };
    }));

    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.startBlockerTask', async ({ cwd, prompt }) => {
        const root = await canonical(cwd);
        const folders = vscode.workspace.workspaceFolders || [];
        const roots = await Promise.all(folders.filter(folder => folder.uri.scheme === 'file').map(folder => canonical(folder.uri.fsPath)));
        if (!roots.includes(root) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24000) {
            throw new Error('The implementation task does not match this Codex workspace.');
        }
        // A new thread leaves every existing chat, draft and worker untouched.
        // Omit approval/model overrides so the configured defaults still apply.
        const started = await send('thread/start', { cwd: root });
        const threadId = started?.thread?.id;
        if (!threadId || await canonical(started.thread.cwd || started.cwd) !== root) {
            throw new Error('Codex did not confirm the implementation workspace.');
        }
        bindings.set(threadId, root);
        provider.navigateToRoute('/local/' + threadId);
        await vscode.commands.executeCommand('chatgpt.openSidebar');
        await send('turn/start', { threadId, cwd: root, clientUserMessageId: randomUUID(),
            input: [{ type: 'text', text: prompt, text_elements: [] }] });
        return { threadId, cwd: root };
    }));

    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.prepareWorkspaceHandoff', async ({ from }) => {
        const identity = await vscode.commands.executeCommand('sweetiebot.readCodexIdentity');
        if (!identity?.threadId) return null;
        const threadId = identity.threadId;
        const thread = await read(threadId);
        const oldCwd = await canonical(thread.cwd);
        const root = await canonical(from);
        let relative = path.relative(root, oldCwd);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            // Explicit branch navigation moves the visible chat too, including
            // a historical thread still attached to another checkout. Its old
            // relative path has no meaning in this workspace; use the new root.
            relative = '';
        }
        const wasActive = thread.status?.type === 'active';
        if (wasActive) {
            const turns = await send('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
            const turn = turns?.data?.[0];
            if (!turn?.id || turn.status !== 'inProgress') throw new Error('Cannot identify the active Codex turn; the checkout was not switched.');
            await send('turn/interrupt', { threadId, turnId: turn.id });
            const deadline = Date.now() + 10000;
            while ((await read(threadId)).status?.type === 'active') {
                if (Date.now() >= deadline) throw new Error('Codex has not stopped writing in the previous checkout; the checkout was not switched.');
                await new Promise(done => setTimeout(done, 100));
            }
        }
        return { threadId, oldCwd, relative, wasActive, id: randomUUID() };
    }));
    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.resumeWorkspaceHandoff', async plan => {
        const root = await canonical(plan.destination);
        const cwd = await canonical(path.join(root, plan.relative || ''));
        if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('Invalid Codex checkout handoff destination.');
        bindings.set(plan.threadId, cwd);
        const resumed = await send('thread/resume', { threadId: plan.threadId, cwd, excludeTurns: true });
        if (resumed?.thread?.id !== plan.threadId || await canonical(resumed.cwd) !== cwd) {
            bindings.delete(plan.threadId);
            throw new Error('Codex did not resume the same chat in the selected checkout.');
        }
        provider.navigateToRoute('/local/' + plan.threadId);
        await vscode.commands.executeCommand('chatgpt.openSidebar');
        if (plan.wasActive) {
            if (resumed.thread.status?.type === 'active') throw new Error('Codex is already active; a duplicate continuation was not submitted.');
            await send('turn/start', {
                threadId: plan.threadId, cwd, clientUserMessageId: plan.id,
                input: [{ type: 'text', text: 'The user moved this same chat to the selected Git checkout. Continue the existing task here. Working directory: ' + cwd + '. Use this checkout for subsequent file operations; preserve the user’s existing commit and staging instructions.', text_elements: [] }]
            });
        }
        return { threadId: plan.threadId, cwd };
    }));
    return { dispose() {
        for (const item of subscriptions) item.dispose();
        if (guardedSend && connection.sendProviderRequest === guardedSend) connection.sendProviderRequest = originalSend;
        failPending();
        bindings.clear();
    } };
}
