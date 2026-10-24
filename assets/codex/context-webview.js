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
        // Capture only visible composer labels at handoff time. Codex does not
        // provide a stable public API for a thread's historical model choices.
        const composerLabel = kind => {
            const button = [...document.querySelectorAll(
                'button[data-composer-navigation-target="' + kind + '"]'
            )].find(item => item.getClientRects().length);
            const visible = String(button?.innerText || button?.textContent || '').replace(/\s+/g, ' ').trim();
            const attrs = [button?.getAttribute('title'), button?.getAttribute('aria-label')]
                .filter(value => typeof value === 'string');
            // A descriptive accessible label is more complete than Sweetiebot's
            // intentionally abbreviated visible text (e.g. "6.1" or "Uber").
            const descriptive = attrs.find(value => /\bGPT[- ]?\d|\b(?:o[1-9]|Codex)[- ]\d/i.test(value));
            const label = descriptive || visible || attrs[0] || '';
            const normalized = kind === 'model' && /^\d+(?:\.\d+)*(?:\s|$)/.test(label)
                ? 'GPT-' + label : kind === 'reasoning' && /^Uber$/i.test(label)
                    ? 'Extra High' : kind === 'reasoning' && /^Med$/i.test(label)
                        ? 'Medium' : label;
            return normalized.trim().slice(0, 100);
        };
        const model = { name: composerLabel('model'), effort: composerLabel('reasoning') };
        if (request.modelOnly) {
            api.postMessage({ type: 'scm-toolkit-context-response', id: request.id, model });
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
            model,
        });
    });

    // Place the action beside the existing chat actions, outside the transcript.
    if (typeof MutationObserver === 'undefined') return;
    const buttonId = 'scm-toolkit-open-chat-checkout';
    let scheduled = false;
    function mountCheckoutButton() {
        scheduled = false;
        const threadId = conversationId();
        const anchor = [...document.querySelectorAll('button')].find(button =>
            /^(Chat actions|Recent chats)(\b|\.)/i.test(button.getAttribute('aria-label') || '')
            && button.getClientRects().length
            && !button.closest('[data-thread-user-message-navigation-content]'));
        let button = document.getElementById(buttonId);
        if (!threadId || !anchor) { button?.remove(); return; }
        if (!button) {
            button = document.createElement('button');
            button.id = buttonId;
            button.type = 'button';
            button.title = 'Open chat checkout in a new window';
            button.setAttribute('aria-label', 'Open chat checkout in a new window');
            button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:0 0 auto;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer';
            button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3zM14 3h7v7M21 3l-8 8"/></svg>';
            button.addEventListener('click', () => {
                const current = conversationId();
                if (current) api.postMessage({ type: 'scm-toolkit-open-chat-checkout', threadId: current });
            });
        }
        if (button.parentElement !== anchor.parentElement || button.nextElementSibling !== anchor) anchor.before(button);
    }
    function scheduleCheckoutButton() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(mountCheckoutButton);
    }
    new MutationObserver(scheduleCheckoutButton).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'],
    });
    window.addEventListener('hashchange', scheduleCheckoutButton);
    scheduleCheckoutButton();
}
