// Read-only snapshot requests; never submit, steer, focus, or stop a Codex turn.
function scmToolkitRegisterCodexSnapshot(api) {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const conversationId = () => {
        const locations = [
            window.location?.hash,
            window.location?.pathname,
            window.location?.search,
        ].filter(Boolean);
        for (const value of locations) {
            const local = String(value).match(new RegExp('(?:/local/|conversation(?:Id)?[=/:])(' + uuid.source + ')', 'i'));
            if (local) return local[1];
        }

        const selectors = [
            '[data-conversation-id]',
            '[data-thread-id]',
            '[data-session-id]',
            'a[href*="/local/"]',
        ];
        for (const element of document.querySelectorAll(selectors.join(','))) {
            const values = [
                element.getAttribute?.('data-conversation-id'),
                element.getAttribute?.('data-thread-id'),
                element.getAttribute?.('data-session-id'),
                element.getAttribute?.('href'),
            ].filter(Boolean);
            for (const value of values) {
                const match = String(value).match(uuid);
                if (match) return match[0];
            }
        }
        return undefined;
    };

    window.addEventListener('message', event => {
        const request = event.data;
        if (request?.type !== 'scm-toolkit-context-request' || typeof request.id !== 'string') return;
        const transcripts = [...document.querySelectorAll('[data-thread-user-message-navigation-content]')];
        const visible = transcripts.find(element => element.getClientRects().length);
        const text = (visible ?? transcripts.at(-1))?.innerText?.trim() ?? '';
        api.postMessage({
            type: 'scm-toolkit-context-response',
            id: request.id,
            text,
            conversationId: conversationId(),
        });
    });
}
