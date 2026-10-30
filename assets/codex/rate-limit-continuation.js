// Window-local, opt-in continuation. Never retry before a known reset time.
function scmToolkitRateLimitResetAt(text, now = Date.now()) {
    const relative = String(text).match(/(?:try again|resets?)\s+in\s+(\d+)\s*(seconds?|minutes?|hours?|s|m|h)\b/i);
    if (relative) return now + Number(relative[1]) * (/^h/i.test(relative[2]) ? 3600000 : /^m/i.test(relative[2]) ? 60000 : 1000);
    const clock = String(text).match(/(?:try again|resets?)\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!clock || +clock[2] > 59 || +clock[1] > (clock[3] ? 12 : 23)) return null;
    const date = new Date(now);
    date.setHours(clock[3] ? (+clock[1] % 12) + (/pm/i.test(clock[3]) ? 12 : 0) : +clock[1], +clock[2], 0, 0);
    if (date.getTime() < now - 60000) date.setDate(date.getDate() + 1);
    return date.getTime();
}

function scmToolkitInstallRateLimitContinuation(api, identity) {
    if (globalThis.scmToolkitRateLimitContinuationInstalled) return;
    globalThis.scmToolkitRateLimitContinuationInstalled = true;
    let armed, timer, button, knownReset, knownThread, queued = false;
    let lookups = 0, lastLookup = -Infinity, lookupRequest, quotaAvailable = false;
    const continued = new Set();
    const transcript = '[role="log"], [data-testid="message-list"], [data-testid*="transcript"], [data-testid^="conversation-turn-"], [data-message-author-role], [data-conversation-role], [data-message-id], [data-turn-id]';
    const excluded = '[data-message-author-role="user"], [data-conversation-role="user"], [data-testid="queued-message"], [aria-label^="Preview queued message"], [contenteditable], pre, code';
    const notices = () => [...document.querySelectorAll('p, span, [role="status"], [role="alert"], [data-scm-toolkit-rate-limit-original]')]
        .filter(node => !node.closest(excluded) && /^(?:you[’']ve hit your usage limit|rate(?:d)? limited)\b/i.test(node.dataset.scmToolkitRateLimitOriginal || node.textContent.trim()));
    const update = () => {
        queued = false;
        const threadId = identity();
        const limited = notices();
        if (threadId !== knownThread) { armed = undefined; knownReset = undefined; knownThread = threadId; lookups = 0; lastLookup = -Infinity; lookupRequest = undefined; quotaAvailable = false; }
        const activeFooter = limited.some(node => !node.closest(transcript))
            || [...document.querySelectorAll('[data-scm-toolkit-rate-limit-pony="true"]:not([data-scm-toolkit-rate-limit-pony-companion]), [data-scm-toolkit-rate-limit-pony-mounted="true"]')]
                .some(node => !node.closest(transcript) && (node.querySelector('img') || /rate(?:d)? limited/i.test(node.textContent)));
        if (!activeFooter || !threadId) {
            clearTimeout(timer); button?.remove(); button = undefined; armed = undefined; knownReset = undefined; lookups = 0; lastLookup = -Infinity; lookupRequest = undefined; quotaAvailable = false; return;
        }
        if (quotaAvailable) { clearTimeout(timer); button?.remove(); button = undefined; armed = undefined; return; }
        for (const notice of limited) {
            // Preserve the first absolute deadline: a relative label must not
            // extend the reset on each DOM refresh.
            knownReset ??= scmToolkitRateLimitResetAt(notice.dataset.scmToolkitRateLimitOriginal || notice.textContent);
        }
        if (knownReset && continued.has(threadId + ':' + knownReset)) { button?.remove(); button = undefined; return; }
        const composer = document.querySelector('[data-composer-markdown][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea');
        if (!composer?.parentElement) return;
        if (!button?.isConnected) {
            button = document.createElement('button'); button.type = 'button';
            button.dataset.scmToolkitContinueAtReset = 'true';
            button.addEventListener('click', () => { if (!armed) { lookups = 0; lastLookup = -Infinity; } armed = armed ? undefined : threadId; update(); });
            composer.parentElement.append(button);
        }
        const label = armed ? (knownReset ? 'Cancel continuation at reset' : 'Cancel · waiting for reset time') : 'Continue unanswered work at reset';
        if (button.textContent !== label) button.textContent = label;
        button.setAttribute('aria-pressed', String(Boolean(armed)));
        clearTimeout(timer);
        if (!armed) return;
        if (!knownReset && lookups < 3 && Date.now() - lastLookup >= 30000) {
            lookups++; lastLookup = Date.now();
            lookupRequest = globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random();
            api.postMessage({ type: 'scm-toolkit-read-limit-reset', threadId, requestId: lookupRequest });
        }
        if (knownReset && Date.now() >= knownReset + 1000) {
            // Native queued prompts take precedence over an automatic Continue.
            if (document.querySelector('[data-testid="queued-message"], [aria-label^="Preview queued message"]') || composer.textContent?.trim() || composer.value?.trim()) return;
            const resetAt = knownReset; continued.add(threadId + ':' + resetAt); armed = undefined; button.remove(); button = undefined;
            api.postMessage({ type: 'scm-toolkit-continue-at-reset', threadId, resetAt });
            return;
        }
        timer = setTimeout(update, knownReset ? Math.min(60000, Math.max(1000, knownReset + 1000 - Date.now())) : 30000);
    };
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(update); } };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    window.addEventListener('message', event => {
        const result = event.data;
        if (result?.type !== 'scm-toolkit-limit-reset-result' || !armed || result.threadId !== identity()
            || result.requestId !== lookupRequest) return;
        lookupRequest = undefined;
        if (result.known && result.limited === false) quotaAvailable = true;
        if (result.limited && Number.isFinite(result.resetAt) && result.resetAt > Date.now()
            && result.resetAt < Date.now() + 31 * 86400000) knownReset = Math.max(knownReset || 0, result.resetAt);
        schedule();
    });
    window.addEventListener('hashchange', schedule);
    schedule();
}
