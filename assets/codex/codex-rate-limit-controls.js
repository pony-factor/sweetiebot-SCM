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

// Turn only the small, icon-bearing "Rate Limited" notice into a Twilight sticker.
// Do not replace usage-limit cards with reset information or transcript text.
// Replaced by the installer with a data URI for the branch-provided twi-stop.png.
const scmToolkitTwilightStopSource = "__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__";
function scmToolkitSmallRateLimitNotice(root) {
    for (const label of root.querySelectorAll('span, p, button, [role="status"], [role="alert"]')) {
        if (!/^rate limited$/i.test(String(label.textContent || '').trim())) continue;
        if (label.closest?.('[data-scm-toolkit-rate-limit-pony]')) continue;
        let card = null;
        let ancestor = label;
        for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
            if (!/^rate limited$/i.test(String(ancestor.textContent || '').trim())) break;
            // A provider notice has an icon. A plain transcript sentence does not.
            if (!ancestor.querySelector?.('svg, img')) continue;
            const controls = ancestor.querySelectorAll?.('button, a, input, select') || [];
            if (controls.length && !ancestor.matches?.('button')) continue;
            card = ancestor; // Prefer the outermost single-purpose notification container.
        }
        if (card) return card;
    }
    return null;
}
function scmToolkitSyncRateLimitPony(root) {
    const card = scmToolkitSmallRateLimitNotice(root);
    if (!card || card.dataset.scmToolkitRateLimitPonyPending === 'true'
        || card.dataset.scmToolkitRateLimitPonyUnavailable === 'true') return;
    card.dataset.scmToolkitRateLimitPonyPending = 'true';
    const image = root.createElement('img');
    image.alt = 'Twilight Sparkle holding a STOP sign — rate limited';
    image.title = 'Rate limited · Twilight Sparkle STOP art by Anon';
    image.width = 96;
    image.style.width = '96px';
    image.style.maxWidth = '100%';
    image.style.height = 'auto';
    image.style.display = 'block';
    image.style.borderRadius = '8px';
    image.addEventListener('load', () => {
        if (!card.isConnected || !/^rate limited$/i.test(String(card.textContent || '').trim())) return;
        // Keep the existing host and its click handler, if it is itself a button.
        card.replaceChildren(image);
        card.setAttribute('data-scm-toolkit-rate-limit-pony', 'true');
        card.setAttribute('aria-label', image.alt);
        card.style.border = '0';
        card.style.boxShadow = 'none';
        card.style.background = 'transparent';
        card.style.padding = '4px';
        delete card.dataset.scmToolkitRateLimitPonyPending;
    });
    image.addEventListener('error', () => {
        // An image blocked by the Codex CSP must not replace a readable error.
        card.dataset.scmToolkitRateLimitPonyUnavailable = 'true';
        delete card.dataset.scmToolkitRateLimitPonyPending;
    });
    image.src = scmToolkitTwilightStopSource;
}


// Hide only the native icon-bearing, untimed Codex usage-limit transcript error.
// Keep user-authored copies, reset timers, upgrade cards, and other messages visible.
function scmToolkitIsInlineUsageLimitText(value) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    return /^you['’]ve hit your usage limit\.\s+upgrade your plan or add credits to continue,\s+or try again later\.?$/i.test(text);
}
function scmToolkitSyncInlineUsageLimit(root) {
    for (const leaf of root.querySelectorAll('p, span, div, [role="status"], [role="alert"]')) {
        if (!scmToolkitIsInlineUsageLimitText(leaf.textContent)) continue;
        if (leaf.closest?.('[data-scm-toolkit-inline-usage-limit-hidden]')) continue;
        // Work from the innermost matching text node, not a transcript container.
        if (Array.from(leaf.children || []).some(child => scmToolkitIsInlineUsageLimitText(child.textContent))) continue;
        let notice = null;
        for (let ancestor = leaf, depth = 0; ancestor && depth < 5;
                ancestor = ancestor.parentElement, depth++) {
            if (!scmToolkitIsInlineUsageLimitText(ancestor.textContent)) break;
            if (ancestor.matches?.('main, article, [role="log"], [data-testid="message-list"], [data-message-id]')) break;
            if (ancestor.querySelector?.('input, textarea, [contenteditable="true"]')) break;
            // The native error row carries a status icon; plain transcript quotations do not.
            if (ancestor.matches?.('[role="status"], [role="alert"]') ||
                    ancestor.querySelector?.('svg, img')) notice = ancestor;
        }
        if (!notice || notice.dataset?.scmToolkitInlineUsageLimitHidden === 'true') continue;
        notice.setAttribute('data-scm-toolkit-inline-usage-limit-hidden', 'true');
        notice.hidden = true;
        notice.style.display = 'none';
    }
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
            scmToolkitSyncInlineUsageLimit(document);
        });
    };
    new MutationObserver(sync).observe(document, { childList: true, subtree: true, characterData: true });
    sync();
})();
