// Electron persists ordinary cookies but drops session cookies at process exit.
// Keep the shared browser login across app restarts in the
// native encrypted cookie store. Never export cookies to a separate file.
function sweetiebotPersistChatSession(session) {
    const key = Symbol.for('sweetiebot.chat-session-persistence');
    if (session[key] || !session.cookies?.on) return;
    session[key] = true;
    let pending = Promise.resolve();
    const revisions = new Map();
    let settingsAt = 0, retention = Promise.resolve(180);
    const retentionDays = () => {
        if (Date.now() - settingsAt > 30000) {
            settingsAt = Date.now();
            retention = import('node:child_process').then(({ execFile }) => new Promise(resolve => {
                execFile('/usr/bin/git', ['config', '--global', '--get', 'scm-toolkit.browser-session-cookie-days'],
                    { timeout: 2000 }, (error, stdout) => {
                        const value = Number(String(stdout || '').trim());
                        resolve(!error && Number.isInteger(value) && value >= 0 && value <= 4000 ? value : 180);
                    });
            })).catch(() => 180);
        }
        return retention;
    };
    const retain = (cookie, identity, revision) => {
        if (!cookie.session) return;
        // Preserve domain/path/security/SameSite, and never extend an expiry
        // supplied by the server. Server logout/removal is left intact.
        const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        const details = { url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
            name: cookie.name, value: cookie.value, path: cookie.path || '/',
            secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
            expirationDate: undefined };
        if (!cookie.hostOnly) details.domain = cookie.domain;
        pending = pending.then(async () => {
            const days = await retentionDays();
            if (!days || revisions.get(identity) !== revision) return;
            details.expirationDate = Date.now() / 1000 + days * 24 * 60 * 60;
            await session.cookies.set(details);
        })
            .then(() => session.cookies.flushStore()).catch(() => {});
    };
    session.cookies.on('changed', (_event, cookie, _cause, removed) => {
        const identity = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
        const revision = (revisions.get(identity) || 0) + 1;
        revisions.set(identity, revision);
        if (!removed) retain(cookie, identity, revision);
        else pending = pending.then(() => session.cookies.flushStore()).catch(() => {});
    });
    // Await the native store at application exit rather than racing its delayed
    // write. This shared profile has one hook; agent sessions never enter here.
    void import('electron').then(({ app }) => {
        let quitting = false;
        app.on('before-quit', event => {
            if (quitting) return;
            quitting = true;
            event.preventDefault();
            void pending.then(() => session.cookies.flushStore()).catch(() => {})
                .finally(() => app.quit());
        });
    }).catch(() => {});
    // Flush persistent cookies too; a quick quit must not outrun Chromium's
    // delayed cookie-store write. No cookie names or values are logged.
    session.cookies.on('changed', () => {
        pending = pending.then(() => session.cookies.flushStore()).catch(() => {});
    });
}
