// Observe activity inside the Codex host without reading conversation contents.
function scmToolkitRegisterCodexKeepAwake(connection, vscode, defaultEnabled) {
    if (process.platform !== 'darwin') return { dispose() {} };
    const { spawn } = require('child_process');
    const active = new Map();
    let child;
    let renewal;
    let disposed = false;
    const enabled = () => {
        const setting = vscode.workspace.getConfiguration('scmToolkit').inspect('codexKeepAwake');
        return setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue ?? defaultEnabled;
    };
    const stop = () => {
        clearTimeout(renewal);
        renewal = undefined;
        const previous = child;
        child = undefined;
        previous?.kill();
    };
    const refresh = () => {
        if (disposed || !enabled() || !active.size) { stop(); return; }
        if (child) return;
        clearTimeout(renewal);
        try {
            // User activity also postpones the screensaver. Renew before its
            // bounded assertion expires; -w releases it after a host crash.
            const spawned = spawn('/usr/bin/caffeinate', ['-d', '-i', '-u', '-t', '30', '-w', String(process.pid)], { stdio: 'ignore' });
            child = spawned;
            renewal = setTimeout(() => {
                stop();
                refresh();
            }, 20000);
            renewal.unref?.();
            spawned.on('error', () => {
                if (child === spawned) child = undefined;
                void vscode.window.showWarningMessage('Unable to keep this Mac awake while Codex works.');
            });
            spawned.on('exit', () => { if (child === spawned) child = undefined; });
        } catch {
            void vscode.window.showWarningMessage('Unable to keep this Mac awake while Codex works.');
        }
    };
    const reset = () => { active.clear(); stop(); };
    const notifications = connection.registerInternalNotificationHandler(notification => {
        const { method, params } = notification;
        const thread = params?.threadId ?? params?.thread?.id;
        if (typeof thread !== 'string') return;
        if (method === 'turn/started' && typeof params.turn?.id === 'string') {
            active.set(thread, params.turn.id);
        } else if (method === 'turn/completed') {
            if (active.get(thread) === params.turn?.id || active.get(thread) === null) active.delete(thread);
        } else if (method === 'thread/status/changed') {
            if (params.status?.type === 'active') {
                if (!active.has(thread)) active.set(thread, null);
            } else if (['idle', 'notLoaded', 'systemError'].includes(params.status?.type)) active.delete(thread);
        } else if (['thread/closed', 'thread/archived', 'thread/deleted'].includes(method)) {
            active.delete(thread);
        } else return;
        refresh();
    });
    const provider = connection.registerProvider('scm-toolkit-keep-awake', { onFatalError: reset });
    const configuration = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('scmToolkit.codexKeepAwake')) refresh();
    });
    return { dispose() {
        disposed = true;
        notifications.dispose();
        provider.dispose();
        configuration.dispose();
        reset();
    } };
}
