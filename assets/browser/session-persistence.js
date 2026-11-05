// Electron persists ordinary cookies but drops session cookies at process exit.
// Keep the explicitly shared ChatGPT browser login across app restarts in the
// native encrypted cookie store. Never export cookies to a separate file.
function sweetiebotPersistChatSession(session) {
    const key = Symbol.for('sweetiebot.chat-session-persistence');
    if (session[key] || !session.cookies?.on) return;
    session[key] = true;
    let pending = Promise.resolve();
    const revisions = new Map();
    const retain = (cookie, identity, revision) => {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        if (!cookie.session || !['chatgpt.com', 'auth.openai.com', 'auth0.openai.com'].includes(domain)) return;
        // Preserve domain/path/security/SameSite, and never extend an expiry
        // supplied by the server. Server logout/removal is left intact.
        const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        const details = { url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
            name: cookie.name, value: cookie.value, path: cookie.path || '/',
            secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
            expirationDate: Date.now() / 1000 + 30 * 24 * 60 * 60 };
        if (!cookie.hostOnly) details.domain = cookie.domain;
        pending = pending.then(() => revisions.get(identity) === revision ? session.cookies.set(details) : undefined)
            .then(() => session.cookies.flushStore()).catch(() => {});
    };
    session.cookies.on('changed', (_event, cookie, _cause, removed) => {
        const identity = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
        const revision = (revisions.get(identity) || 0) + 1;
        revisions.set(identity, revision);
        if (!removed) retain(cookie, identity, revision);
        else pending = pending.then(() => session.cookies.flushStore()).catch(() => {});
    });
    // Flush persistent cookies too; a quick quit must not outrun Chromium's
    // delayed cookie-store write. No cookie names or values are logged.
    session.cookies.on('changed', () => {
        pending = pending.then(() => session.cookies.flushStore()).catch(() => {});
    });
}
