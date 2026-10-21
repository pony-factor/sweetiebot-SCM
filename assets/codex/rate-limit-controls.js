// Offer the native banked-reset flow only when Codex renders its eligibility control.
function scmToolkitIsAvailableResetSummary(value) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    return /^[1-9]\d*\s+resets? available$/i.test(text) || /^full reset$/i.test(text);
}
function scmToolkitIsLimitCardHeading(value) {
    return /^(?:rate limited|you[’']re out of codex messages|you[’']ve hit your usage limit)$/i
        .test(String(value || '').trim().replace(/[.!]\s*$/, ''));
}
function scmToolkitFindAvailableResetSummary(root) {
    for (const element of root.querySelectorAll('button, [role="button"], a')) {
        if (element.dataset?.scmToolkitResetShortcut === 'true') continue;
        const label = element.getAttribute?.('aria-label') || element.textContent;
        if (scmToolkitIsAvailableResetSummary(label)) return element;
    }
    return null;
}
function scmToolkitFindRateLimitHeading(root) {
    for (const element of root.querySelectorAll('h1, h2, h3, strong, [role="heading"], p, span')) {
        if (!scmToolkitIsLimitCardHeading(element.textContent)) continue;
        if (element.closest?.('[data-scm-toolkit-reset-action]')) continue;
        // A transcript message isn't a banner; require a nearby native banner action.
        let candidate = element.parentElement;
        for (let depth = 0; candidate && depth < 5; depth++, candidate = candidate.parentElement) {
            if (String(candidate.textContent || '').length > 900) break;
            const actions = Array.from(candidate.querySelectorAll?.('button, a') || []);
            if (actions.some(button =>
                /^(?:dismiss|close|upgrade|add credits|buy credits)$/i.test(
                    String(button.getAttribute?.('aria-label') || button.textContent || '').trim()))
                && !candidate.matches?.('[role="log"], [data-testid="message-list"]')) {
                return element;
            }
        }
    }
    return null;
}
function scmToolkitSyncResetShortcut(root) {
    const nativeSummary = scmToolkitFindAvailableResetSummary(root);
    const existing = root.querySelector('[data-scm-toolkit-reset-action]');
    const heading = nativeSummary ? scmToolkitFindRateLimitHeading(root) : null;
    if (!heading) {
        existing?.remove();
        return;
    }
    if (existing && existing.parentElement === heading.parentElement) return;
    existing?.remove();
    const button = root.createElement('button');
    button.type = 'button';
    button.textContent = 'Use credits';
    button.dataset.scmToolkitResetShortcut = 'true';
    button.setAttribute('data-scm-toolkit-reset-action', '');
    button.setAttribute('aria-label', 'Use an available Codex rate-limit reset');
    button.title = 'Review and confirm a banked Codex reset';
    button.style.marginInlineStart = 'auto';
    button.style.flex = '0 0 auto';
    button.style.cursor = 'pointer';
    button.style.padding = '4px 10px';
    button.style.borderRadius = '6px';
    button.style.background = 'var(--vscode-button-background, var(--vscode-focusBorder, #4777d8))';
    button.style.color = 'var(--vscode-button-foreground, white)';
    button.style.border = '0';
    button.addEventListener('click', () => {
        const native = scmToolkitFindAvailableResetSummary(root);
        if (native?.isConnected && typeof native.click === 'function') {
            native.click(); // Native reset dialog owns all confirmations.
        } else {
            button.remove();
        }
    });
    const row = heading.parentElement;
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.append(button);
}

// The empty status strip above the composer owns the Twilight sticker.
// In-chat rate-limit notices are redundant, not alternative sticker placements.
// The installer replaces this literal with the repository's verified PNG as a data URI.
const scmToolkitTwilightStopSource = "__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__";
function scmToolkitIsShortRateLimit(value) {
    // "Rated Limited" is the current footer wording; transcript notices say "Rate limited".
    return /^rate(?:d)? limited$/i.test(String(value || '').trim());
}
function scmToolkitPlainRateLimitNodes(root) {
    const found = new Set();
    for (const label of root.querySelectorAll('span, p, button, [role="status"], [role="alert"]')) {
        if (!scmToolkitIsShortRateLimit(label.textContent)) continue;
        let card = null;
        for (let node = label, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
            if (!scmToolkitIsShortRateLimit(node.textContent)) break;
            const controls = node.querySelectorAll?.('button, a, input, textarea, select, [role="button"]') || [];
            if (controls.length && !node.matches?.('button')) break;
            const rect = node.getBoundingClientRect?.();
            if (rect && rect.width >= 35 && rect.height >= 12) card = node;
        }
        if (card) found.add(card);
    }
    // Account for already-rendered stickers from an earlier Sweetiebot injection.
    for (const sticker of root.querySelectorAll('[data-scm-toolkit-rate-limit-pony]')) {
        if (sticker.getBoundingClientRect?.()) found.add(sticker);
    }
    return [...found];
}
function scmToolkitFooterRateLimitNotice(root) {
    const notices = scmToolkitPlainRateLimitNodes(root);
    let editorRect = null;
    for (const field of root.querySelectorAll('textarea, [role="textbox"], [contenteditable], .ProseMirror')) {
        const rect = field.getBoundingClientRect?.();
        if (!rect || rect.width < 180 || rect.height < 10) continue;
        if (!editorRect || rect.top > editorRect.top) editorRect = rect;
    }
    if (!editorRect) return {card: null, notices};
    let card = null;
    let best = Infinity;
    for (const candidate of notices) {
        // A preexisting transcript sticker must not qualify as a footer.
        if (candidate.getAttribute?.('data-scm-toolkit-rate-limit-pony') === 'true'
            || candidate.dataset?.scmToolkitRateLimitPony === 'true') continue;
        if (!scmToolkitIsShortRateLimit(candidate.textContent)) continue;
        const rect = candidate.getBoundingClientRect?.();
        if (!rect || rect.height > 160 || rect.height < 20) continue;
        const gap = editorRect.top - rect.bottom;
        const leftGap = Math.abs(editorRect.left - rect.left);
        // An empty footer spans the editor column and sits directly above it.
        // Narrow transcript bubbles, status menus, and cards with details do not.
        if (gap < -8 || gap > 180 || leftGap > Math.max(72, editorRect.width * 0.16)
            || rect.width < Math.max(180, editorRect.width * 0.74)
            || rect.width > editorRect.width * 1.6) continue;
        const score = gap + leftGap;
        if (score < best) {
            card = candidate;
            best = score;
        }
    }
    return {card, notices};
}
function scmToolkitHideDuplicateRateLimitNotices(notices, footer) {
    const footerRect = footer.getBoundingClientRect();
    for (const notice of notices) {
        if (notice === footer) continue;
        const rect = notice.getBoundingClientRect?.();
        if (!rect || rect.bottom > footerRect.top || rect.height > 160) continue;
        // Never hide another full-width card that could contain native actions.
        if (rect.width >= footerRect.width * 0.8
            && notice.getAttribute?.('data-scm-toolkit-rate-limit-pony') !== 'true') continue;
        notice.setAttribute?.('data-scm-toolkit-rate-limit-duplicate', 'true');
        notice.setAttribute?.('aria-hidden', 'true');
        if (notice.style?.setProperty) notice.style.setProperty('display', 'none', 'important');
        else if (notice.style) notice.style.display = 'none';
    }
}
function scmToolkitSyncRateLimitPony(root) {
    const {card, notices} = scmToolkitFooterRateLimitNotice(root);
    if (!card) return;
    scmToolkitHideDuplicateRateLimitNotices(notices, card);
    if (card.dataset.scmToolkitRateLimitPonyPending === 'true'
        || card.dataset.scmToolkitRateLimitPonyUnavailable === 'true') return;
    card.dataset.scmToolkitRateLimitPonyPending = 'true';
    const image = root.createElement('img');
    image.alt = 'Twilight Sparkle holding a STOP sign — rate limited';
    image.title = 'Rate limited · Twilight Sparkle art by CaptainPudgeMuffin';
    image.width = 96;
    image.style.width = '96px';
    image.style.maxWidth = '100%';
    image.style.height = 'auto';
    image.style.display = 'block';
    image.style.borderRadius = '8px';
    image.addEventListener('load', () => {
        // Do not overwrite an updated, action-bearing status while art loads.
        if (!card.isConnected || scmToolkitFooterRateLimitNotice(root).card !== card) {
            delete card.dataset.scmToolkitRateLimitPonyPending;
            return;
        }
        card.replaceChildren(image);
        card.setAttribute('data-scm-toolkit-rate-limit-pony', 'true');
        card.setAttribute('aria-label', image.alt);
        // Collapse the entire green banner to just the standalone sticker.
        card.style.border = '0';
        card.style.outline = 'none';
        card.style.boxShadow = 'none';
        card.style.background = 'transparent';
        card.style.padding = '0';
        card.style.minWidth = '0';
        card.style.minHeight = '0';
        card.style.width = 'max-content';
        card.style.height = 'auto';
        card.style.display = 'inline-flex';
        card.style.flex = '0 0 auto';
        card.style.alignSelf = 'flex-start';
        delete card.dataset.scmToolkitRateLimitPonyPending;
    });
    image.addEventListener('error', () => {
        // Retain native text if the local data URI is blocked or fails.
        card.dataset.scmToolkitRateLimitPonyUnavailable = 'true';
        delete card.dataset.scmToolkitRateLimitPonyPending;
    });
    image.src = scmToolkitTwilightStopSource;
}

(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    if (globalThis.scmToolkitResetShortcutInstalled) return;
    globalThis.scmToolkitResetShortcutInstalled = true;
    let queued = false;
    const sync = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            scmToolkitSyncResetShortcut(document);
            scmToolkitSyncRateLimitPony(document);
        });
    };
    new MutationObserver(sync).observe(document, { childList: true, subtree: true, characterData: true });
    sync();
})();
