// Use the same coordinator and queue storage as Codex. A handoff holds its
// own lease and exempts only the completion of the turn it actually stopped.
const scmToolkitCheckoutInterrupts = new WeakMap();
const scmToolkitUserQueuePauses = new WeakMap();
const scmToolkitLoadingCheckoutHandoff = new WeakSet();
function scmToolkitIsCheckoutInterrupt(coordinator, threadId, turnId) {
    const handoff = scmToolkitCheckoutInterrupts.get(coordinator)?.get(threadId);
    return Boolean(handoff?.turnId === turnId && turnId && !handoff.userStopped);
}

function scmToolkitUserQueuePause(coordinator, threadId, paused) {
    let pauses = scmToolkitUserQueuePauses.get(coordinator);
    if (paused === true) {
        if (!pauses) scmToolkitUserQueuePauses.set(coordinator, pauses = new Map());
        if (!pauses.has(threadId)) pauses.set(threadId, coordinator.deferAutomaticTurns(threadId));
    } else if (paused === false) {
        pauses?.get(threadId)?.[Symbol.dispose]();
        pauses?.delete(threadId);
    }
    return pauses?.has(threadId) ?? false;
}

// Explicit, window-local thread handoff. Never inspect rollout or auth files.
function scmToolkitRegisterCodexWorkspaceHandoff(provider, vscode, queueSupported = false) {
    const { randomUUID } = require('node:crypto');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const connection = provider.codexMcpConnection;
    const pending = new Map();
    const bindings = new Map();
    const providerName = 'sweetiebot-workspace-handoff';
    const subscriptions = [];
    const manager = provider.hostedManager?.manager;
    const coordinator = queueSupported ? manager?.getTurnCoordinator?.() : undefined;
    const handoffs = new Map();
    const submittedContinuations = new Set();
    let disposed = false;
    let queueReady;
    if (coordinator) {
        scmToolkitCheckoutInterrupts.set(coordinator, handoffs);
        // The native view can reconnect before Sweetiebot consumes the journal.
        // Acquire the destination lease before allowing automatic dispatch.
        scmToolkitLoadingCheckoutHandoff.add(coordinator);
        queueReady = vscode.commands.executeCommand('sweetiebot.codexHandoff.pendingQueue').then(plan => {
            if (!plan || disposed || handoffs.has(plan.threadId)) return;
            handoffs.set(plan.threadId, { ...plan, lease: coordinator.deferAutomaticTurns(plan.threadId) });
            if (plan.queuePaused) scmToolkitUserQueuePause(coordinator, plan.threadId, true);
        }, () => {}).finally(() => {
            if (disposed) return;
            scmToolkitLoadingCheckoutHandoff.delete(coordinator);
            coordinator.executionChanged?.();
        });
        const stopListening = manager.addTurnInterruptStartedListener?.(threadId => {
            const handoff = handoffs.get(threadId);
            if (handoff) handoff.userStopped = true;
        });
        if (stopListening) subscriptions.push({ dispose: stopListening });
    }
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
    const chatCheckoutPath = async threadId => {
        const thread = await read(threadId);
        // An explicit branch handoff may have rebound the chat before Codex's
        // stored thread metadata reflects its new checkout.
        return canonical(bindings.get(threadId) ?? thread.cwd);
    };
    const checkoutAlreadyOpen = async cwd => {
        const roots = (vscode.workspace.workspaceFolders || [])
            .filter(folder => folder.uri.scheme === 'file');
        const paths = await Promise.all(roots.map(folder => canonical(folder.uri.fsPath).catch(() => null)));
        return paths.includes(cwd);
    };
    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.chatCheckoutVisibility', async threadId => {
        const cwd = await chatCheckoutPath(threadId);
        return { threadId, needsNewWindow: !(await checkoutAlreadyOpen(cwd)) };
    }));
    // A frontend cache must not override the verified destination on its next
    // resume or user turn. Only this explicitly handed-off thread is affected.
    const guardedSend = typeof originalSend === 'function' ? function (name, id, method, params, ...rest) {
        const handoff = handoffs.get(params?.threadId);
        if (handoff && name !== providerName && method === 'turn/interrupt'
            && (!handoff.turnId || handoff.turnId === params.turnId)) handoff.userStopped = true;
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
        const cwd = await chatCheckoutPath(identity.threadId);
        if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The recorded checkout is not a folder.');
        if (await checkoutAlreadyOpen(cwd)) return { threadId: identity.threadId, cwd, alreadyOpen: true };
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

    // Inform the visible chat about the isolated test clone. Unlike branch
    // switching, this deliberately does not migrate its cwd or interrupt work.
    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.sendExperimentDirection', async ({ source, sourceBranch, destination, branch, expectedThreadId }) => {
        const identity = await vscode.commands.executeCommand('sweetiebot.readCodexIdentity');
        if (expectedThreadId && identity?.threadId !== expectedThreadId) {
            throw new Error('The original Codex chat changed; the trial notice was not sent to another chat.');
        }
        if (!identity?.threadId) return false;
        const thread = await read(identity.threadId);
        const original = await canonical(source);
        const sandbox = await canonical(destination);
        const cwd = await canonical(thread.cwd);
        const relative = path.relative(original, cwd);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw new Error('The visible Codex chat belongs to another checkout.');
        }
        if (sandbox === original || sandbox.startsWith(original + path.sep)) {
            throw new Error('The experiment must be outside the original checkout.');
        }
        const direction = 'A separate, disposable Sweetiebot experiment is now open in another VS Code window.\n' +
            'Original checkout: ' + JSON.stringify(original) + '\n' +
            'Original branch: ' + JSON.stringify(sourceBranch || null) + '\n' +
            'Experimental checkout: ' + JSON.stringify(sandbox) + '\n' +
            'Copied branch: ' + JSON.stringify(branch) + '\n\n' +
            'Run tests, builds, destructive resets, trial edits, and other experimental commands ONLY in the experimental checkout. ' +
            'Use that exact directory as the working directory and check pwd before running destructive commands. ' +
            'When the task requires window-specific or interactive testing, use the already-open experimental VS Code window and its experimental checkout for live UI, webview, focus, reload, restart, and window-lifecycle checks as applicable; do not use the original window as the test target. ' +
            'Exercise the actual behavior there when needed, not just shell tests or static inspection. Verify the test window and checkout identity first; if testing requires installing or patching shared application files, use an isolated test instance or profile with isolated application files as appropriate, not changes that would affect the original window. ' +
            'If live window testing is unavailable, report the specific blocker and any remaining manual checks rather than claiming they passed. ' +
            'During experimentation, preserve the original checkout, its index, working files, and current Codex conversation. ' +
            'The experiment contains a snapshot of committed, staged, unstaged, and non-ignored untracked files. ' +
            'Do not run git reset/clean/checkout against the original repository. ' +
            'After validating the solution in the experimental checkout, apply the final intended code changes to the original checkout and original branch above as part of this task; no additional request to copy them back is needed. ' +
            'Before applying them, verify the original checkout and branch identity and inspect its current changes. ' +
            'Transfer only the changes made for this task relative to the initial experiment snapshot, including intended new files and deletions; do not replay copied pre-existing edits or unrelated trial changes. ' +
            'Preserve existing user edits and staging, and reconcile overlapping edits without overwriting user work. Do not stage, commit, push, or rewrite history unless separately requested. ' +
            'Verify that the final changes are present in the original checkout before reporting completion. Work left only in the trial checkout is not completion. ' +
            'Keep the experimental checkout and its work intact until the transfer is verified; if access or a conflict prevents transfer, preserve the work and report the exact blocker. ' +
            'Do not publish experimental commits. ' +
            'The separate window is available for its own Codex session if sandbox permissions prevent access from this one.';
        const input = [{ type: 'text', text: direction, text_elements: [] }];
        if (thread.status?.type === 'active') {
            const turns = await send('thread/turns/list', {
                threadId: identity.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'
            });
            const activeTurn = turns?.data?.[0];
            if (!activeTurn?.id || activeTurn.status !== 'inProgress') {
                throw new Error('Cannot identify the active Codex turn; the experiment remains available.');
            }
            await send('turn/steer', { threadId: identity.threadId, expectedTurnId: activeTurn.id, input });
        } else {
            await send('turn/start', { threadId: identity.threadId, cwd,
                clientUserMessageId: randomUUID(), input });
        }
        return true;
    }));

    const continuedResets = new Set();
    let limitLookup;
    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.readRateLimitReset', async ({ threadId }) => {
        const identity = await vscode.commands.executeCommand('sweetiebot.readCodexIdentity');
        if (!threadId || identity?.threadId !== threadId) return { known: false };
        if (limitLookup && Date.now() - limitLookup.at < 30000) return limitLookup.result;
        const result = send('account/rateLimits/read', {}).then(value => {
            const windows = [value?.rateLimits?.primary, value?.rateLimits?.secondary].filter(Boolean);
            if (!windows.length) return { known: false };
            const exhausted = windows.filter(window => Number(window.usedPercent) >= 100);
            const resets = exhausted.map(window => Number(window.resetsAt) * 1000)
                .filter(reset => Number.isFinite(reset) && reset > Date.now() && reset < Date.now() + 31 * 86400000);
            return { known: true, limited: exhausted.length > 0, resetAt: resets.length ? Math.max(...resets) : null };
        }).catch(() => ({ known: false }));
        limitLookup = { at: Date.now(), result };
        return result;
    }));

    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.continueAfterRateLimit', async ({ threadId, resetAt }) => {
        const identity = await vscode.commands.executeCommand('sweetiebot.readCodexIdentity');
        const key = threadId + ':' + resetAt;
        if (!threadId || identity?.threadId !== threadId || !Number.isFinite(resetAt)
            || Date.now() < resetAt || Date.now() - resetAt > 300000 || continuedResets.has(key)) return false;
        const thread = await read(threadId);
        if (thread.status?.type === 'active') return false;
        const turns = await send('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        if (turns?.data?.[0]?.status !== 'failed') return false;
        continuedResets.add(key); // A lost response must not submit twice.
        await send('turn/start', { threadId, cwd: await canonical(thread.cwd), clientUserMessageId: randomUUID(),
            input: [{ type: 'text', text: 'Continue answering the unanswered requests in this conversation.', text_elements: [] }] });
        return true;
    }));

    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.prepareWorkspaceHandoff', async ({ from }) => {
        await queueReady;
        const identity = await vscode.commands.executeCommand('sweetiebot.readCodexIdentity');
        if (!identity?.threadId) return identity?.composerFocus ? { draftOnly: true, composerFocus: identity.composerFocus } : null;
        const threadId = identity.threadId;
        if (handoffs.has(threadId)) throw new Error('This Codex chat is already changing checkouts.');
        const handoff = { id: randomUUID(), lease: coordinator?.deferAutomaticTurns(threadId) };
        handoffs.set(threadId, handoff);
        try {
            const thread = await read(threadId);
            const oldCwd = await canonical(bindings.get(threadId) ?? thread.cwd);
            const root = await canonical(from);
            let relative = path.relative(root, oldCwd);
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) relative = '';
            let wasActive = false;
            if (thread.status?.type === 'active') {
                if (!coordinator) throw new Error('This Codex version cannot safely move a running task. Wait for the turn to finish before switching checkouts.');
                const latestTurn = async () => (await send('thread/turns/list', {
                    threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'
                }))?.data?.[0];
                const turn = await latestTurn();
                if (turn?.id && turn.status === 'inProgress') {
                    if (!handoff.userStopped) {
                        handoff.turnId = turn.id;
                        try { await send('turn/interrupt', { threadId, turnId: turn.id }); }
                        catch (error) {
                            // The turn may have finished while the interrupt was in flight.
                            if ((await latestTurn())?.status !== 'completed') throw error;
                        }
                    }
                    const deadline = Date.now() + 10000;
                    while ((await read(threadId)).status?.type === 'active') {
                        if (Date.now() >= deadline) throw new Error('Codex has not stopped writing in the previous checkout; the checkout was not switched.');
                        await new Promise(done => setTimeout(done, 100));
                    }
                    const stopped = await latestTurn();
                    if (stopped?.id !== turn.id) throw new Error('The active Codex turn changed during checkout preparation.');
                    wasActive = stopped.status === 'interrupted' && !handoff.userStopped;
                } else if ((await read(threadId)).status?.type === 'active') {
                    throw new Error('Cannot identify the active Codex turn; the checkout was not switched.');
                }
            }
            return { threadId, oldCwd, relative, wasActive, id: handoff.id,
                ...(wasActive ? { turnId: handoff.turnId } : {}),
                queuePaused: coordinator ? scmToolkitUserQueuePause(coordinator, threadId) : false,
                ...(identity.composerFocus ? { composerFocus: identity.composerFocus } : {}) };
        } catch (error) {
            handoffs.delete(threadId);
            handoff.lease?.[Symbol.dispose]();
            throw error;
        }
    }));
    subscriptions.push(vscode.commands.registerCommand('sweetiebot.codex.resumeWorkspaceHandoff', async plan => {
        await queueReady;
        const source = handoffs.get(plan.threadId);
        const handoff = source?.id === plan.id ? source : undefined;
        const lease = handoff?.lease ?? coordinator?.deferAutomaticTurns(plan.threadId);
        let checkoutVerified = false;
        try {
            const root = await canonical(plan.destination);
            const cwd = await canonical(path.join(root, plan.relative || ''));
            if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('Invalid Codex checkout handoff destination.');
            const previous = bindings.get(plan.threadId);
            bindings.set(plan.threadId, cwd);
            try {
                const params = { threadId: plan.threadId, cwd, excludeTurns: true };
                let resumed = await send('thread/resume', params);
                if (resumed?.thread?.id === plan.threadId && await canonical(resumed.cwd) !== cwd
                    && resumed.thread.status?.type === 'idle') {
                    // A loaded thread can ignore the cwd supplied to thread/resume.
                    await send('thread/settings/update', { threadId: plan.threadId, cwd });
                    resumed = await send('thread/resume', params);
                }
                if (resumed?.thread?.id !== plan.threadId || await canonical(resumed.cwd) !== cwd) {
                    throw new Error('Codex did not resume the same chat in the selected checkout.');
                }
                checkoutVerified = true;
                if (plan.queuePaused && !handoff) {
                    if (!coordinator) throw new Error('Codex could not restore the intentional queue pause.');
                    scmToolkitUserQueuePause(coordinator, plan.threadId, true);
                }
                if (plan.wasActive && !handoff?.userStopped && !submittedContinuations.has(plan.id)) {
                    if (resumed.thread.status?.type === 'active') throw new Error('Codex is already active; a duplicate continuation was not submitted.');
                    submittedContinuations.add(plan.id);
                    const admitted = !plan.journalWorkspace || await vscode.commands.executeCommand(
                        'sweetiebot.codexHandoff.consumeContinuation', { workspace: plan.journalWorkspace, id: plan.id });
                    if (admitted && !handoff?.userStopped) {
                        await send('turn/start', {
                            threadId: plan.threadId, cwd, clientUserMessageId: plan.id,
                            input: [{ type: 'text', text: plan.continuationText || 'The user moved this same chat to the selected Git checkout. Continue the existing task here. Working directory: ' + cwd + '. Use this checkout for subsequent file operations; preserve the user’s existing commit and staging instructions.', text_elements: [] }]
                        });
                    }
                }
            } finally {
                if (!checkoutVerified) {
                    if (previous) bindings.set(plan.threadId, previous);
                    else bindings.delete(plan.threadId);
                }
            }
            provider.navigateToRoute('/local/' + plan.threadId);
            await vscode.commands.executeCommand('chatgpt.openSidebar');
            // A late composer must never make a successfully resumed chat look paused.
            if (plan.composerFocus) void vscode.commands.executeCommand('sweetiebot.codexHandoff.restoreFocusWhenReady',
                { threadId: plan.threadId, state: plan.composerFocus }).catch(() => {});
            return { threadId: plan.threadId, cwd };
        } finally {
            if (checkoutVerified || !handoff) {
                if (handoff) handoffs.delete(plan.threadId);
                lease?.[Symbol.dispose]();
            }
        }
    }));
    return { dispose() {
        disposed = true;
        if (coordinator) scmToolkitLoadingCheckoutHandoff.add(coordinator);
        for (const item of subscriptions) item.dispose();
        if (guardedSend && connection.sendProviderRequest === guardedSend) connection.sendProviderRequest = originalSend;
        failPending();
        bindings.clear();
        for (const handoff of handoffs.values()) handoff.lease?.[Symbol.dispose]();
        handoffs.clear();
    } };
}
