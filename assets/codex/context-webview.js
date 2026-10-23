// Read-only snapshot requests; never submit, steer, focus, or stop a Codex turn.
function scmToolkitRegisterCodexSnapshot(api) {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const conversationId = (allowHidden = false) => {
        const locations = [
            window.location?.hash,
            window.location?.pathname,
            window.location?.search,
        ].filter(Boolean);
        for (const value of locations) {
            const local = String(value).match(new RegExp('(?:/local/|conversation(?:Id)?[=/:])(' + uuid.source + ')', 'i'));
            if (local) return local[1];
        }

        const fiberIdentities = new Set();
        for (const transcript of document.querySelectorAll('[data-thread-user-message-navigation-content]')) {
            if (!allowHidden && !transcript.getClientRects().length) continue;
            const fiberKey = Object.keys(transcript).find(key => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? transcript[fiberKey] : undefined;
            for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
                const props = fiber.memoizedProps;
                const value = [props?.threadId, props?.conversationId, props?.thread?.id, props?.conversation?.id]
                    .find(value => typeof value === 'string' && new RegExp('^' + uuid.source + '$', 'i').test(value));
                if (value) { fiberIdentities.add(value); break; }
            }
        }
        if (fiberIdentities.size === 1) return [...fiberIdentities][0];
        if (fiberIdentities.size > 1) return undefined;
        const selectors = [
            '[data-conversation-id]',
            '[data-thread-id]',
            '[data-session-id]',
        ];
        const identities = new Set();
        for (const element of document.querySelectorAll(selectors.join(','))) {
            if (!allowHidden && !element.getClientRects?.().length) continue;
            const values = [
                element.getAttribute?.('data-conversation-id'),
                element.getAttribute?.('data-thread-id'),
                element.getAttribute?.('data-session-id'),
                element.getAttribute?.('href'),
            ].filter(Boolean);
            for (const value of values) {
                const match = String(value).match(uuid);
                if (match) identities.add(match[0]);
            }
        }
        return identities.size === 1 ? [...identities][0] : undefined;
    };

    window.addEventListener('message', event => {
        const request = event.data;
        if (request?.type !== 'scm-toolkit-context-request' || typeof request.id !== 'string') return;
        if (request.identityOnly) {
            const hasConversation = [...document.querySelectorAll('[data-thread-user-message-navigation-content]')]
                .some(element => request.allowHidden || element.getClientRects().length);
            api.postMessage({ type: 'scm-toolkit-context-response', id: request.id, conversationId: conversationId(request.allowHidden), hasConversation });
            return;
        }
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
