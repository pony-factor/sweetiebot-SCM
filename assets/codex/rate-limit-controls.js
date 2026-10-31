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
const scmToolkitRateLimitStickerEnabled = "__SCM_TOOLKIT_RATE_LIMIT_STICKER_ENABLED__";
// Codex may rerender the original untranslated no-reset transcript warning
// after the installer has compacted its defaultMessage. Reapply the compact
// presentation as soon as the message's text changes, before the next paint.
function scmToolkitIsUntimedRateLimitWarning(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    // A concrete reset time is useful information; keep the entire message.
    // The optional timed-warning hider owns that separate user preference.
    if (/\btry again\s+(?:at|on|in|after|until)\b/i.test(text)) return false;
    if (/^you[’']ve hit your usage limit\.\s*(?:(?:upgrade your plan(?: or add credits)?|add credits) to continue,\s*or\s*)?try again (?:at|on|in|later)\b[^<>]*$/i.test(text)) return true;
    return /^you[’']ve hit your usage limit\.\s*upgrade your plan or add credits to continue,\s*or\s*try again later\.?$/i.test(text);
}

// When Hide Codex reset times is enabled, compact the same native
// usage-limit message even when Codex supplies a concrete retry deadline.
// Keep this independent of the always-on, untimed warning normalization.
function scmToolkitIsHiddenTimedRateLimitWarning(value) {
    if (globalThis.scmToolkitHideRateLimitTimes !== true) return false;
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return /^you[’']ve hit your usage limit\.\s*(?:(?:upgrade your plan(?: or add credits)?|add credits) to continue,\s*or\s*)?try again (?:at|on|in|after|until)\s+[^<>]+\.?$/i.test(text)
        // A previously scrubbed multi-node date can leave the clock suffix.
        || /^you[’']ve hit your usage limit\.\s*(?:(?:upgrade your plan(?: or add credits)?|add credits) to continue,\s*or\s*)?try again later,\s*\d{1,2}:\d{2}\s*(?:AM|PM)\.?$/i.test(text);
}

// Queued prompts live beside the composer, outside the transcript. Their
// accessible preview labels contain user text and are never status evidence.
const scmToolkitQueuedPromptSelector = '[aria-label^="Preview queued message"], [data-testid="queued-message"], [data-testid="queued-message-list"]';
function scmToolkitIsQueuedPrompt(node) {
    return Boolean(node?.closest?.(scmToolkitQueuedPromptSelector)
        || node?.querySelector?.(scmToolkitQueuedPromptSelector)
        || node?.querySelector?.('[aria-label="Queued message actions"], [aria-label="Delete queued message"]'));
}

function scmToolkitCompactUntimedRateLimitNode(node) {
    if (scmToolkitIsQueuedPrompt(node) || !(scmToolkitIsUntimedRateLimitWarning(node?.textContent)
        || scmToolkitIsHiddenTimedRateLimitWarning(node?.textContent))) return false;
    // Never rewrite user input, dialogs, clickable upgrade cards, or
    // other informative notices. A timed native warning is eligible only
    // with the separate Hide Codex reset times preference enabled.
    if (node.closest?.('[data-message-author-role="user"], [data-conversation-role="user"], [contenteditable], [role="textbox"], [role="dialog"], [role="menu"], [role="tooltip"], [data-scm-toolkit-reset-action]')) return false;
    if (node.querySelector?.('a, button, input, textarea, select, [role="button"]')) return false;
    for (const descendant of node.querySelectorAll?.('p, span, div, [role="status"], [role="alert"]') || []) {
        if (scmToolkitIsUntimedRateLimitWarning(descendant.textContent)
            || scmToolkitIsHiddenTimedRateLimitWarning(descendant.textContent)) return false;
    }
    // Update only text nodes, preserving status icons and surrounding markup.
    const textNodes = [];
    const collect = element => {
        for (const child of element.childNodes || []) {
            if (child.nodeType === 3) textNodes.push(child);
            else if (child.nodeType === 1) collect(child);
        }
    };
    collect(node);
    if (!textNodes.length) return false;
    node.setAttribute?.('data-scm-toolkit-rate-limit-original', node.textContent);
    node.setAttribute?.('data-scm-toolkit-compact-limit', 'true');
    textNodes[0].textContent = 'Rate limited';
    for (const text of textNodes.slice(1)) text.textContent = '';
    return true;
}

function scmToolkitCompactUntimedRateLimitBranch(root) {
    if (!root) return;
    const candidates = new Set();
    // Handle changes to existing text nodes as well as entirely new messages.
    let ancestor = root.nodeType === 3 ? root.parentElement : root;
    for (let depth = 0; ancestor && depth < 7; depth++, ancestor = ancestor.parentElement) {
        if (ancestor.matches?.('p, span, div, [role="status"], [role="alert"]')) candidates.add(ancestor);
    }
    for (const descendant of root.querySelectorAll?.('p, span, div, [role="status"], [role="alert"]') || []) {
        candidates.add(descendant);
    }
    // Deepest elements first, so a wrapper cannot swallow a matching label.
    for (const candidate of [...candidates].reverse()) {
        scmToolkitCompactUntimedRateLimitNode(candidate);
    }
}

function scmToolkitIsShortRateLimit(value) {
    // Exclude useful reset details and status cards with additional text.
    return /^rate(?:d)? limited$/i.test(String(value || '').trim().replace(/\s+/g, ' '));
}
// Fix the legacy typo on the isolated footer label while preserving provider icons.
// The native fallback stays readable even when the sticker cannot render.
function scmToolkitNormalizeRateLimitTypo(card) {
    if (!/^rated limited$/i.test(String(card.textContent || '').trim())) return;
    const visit = node => {
        for (const child of node.childNodes || []) {
            if (child.nodeType === 3) {
                child.textContent = String(child.textContent || '').replace(/rated limited/ig, 'Rate limited');
            } else {
                visit(child);
            }
        }
    };
    visit(card);
}
const scmToolkitRateLimitTranscriptSelector = [
    '[role="log"]', '[data-testid="message-list"]', '[data-testid*="transcript"]',
    '[data-message-author-role]', '[data-conversation-role]', '[data-message-id]',
    '[data-turn-id]'
].join(', ');
const scmToolkitCodexEditorSelector = 'textarea, [role="textbox"], [contenteditable], .ProseMirror';

function scmToolkitPlainRateLimitNodes(root) {
    const found = new Set();
    for (const label of root.querySelectorAll('span, p, button, [role="status"], [role="alert"]')) {
        if (scmToolkitIsQueuedPrompt(label) || !scmToolkitIsShortRateLimit(label.innerText || label.textContent)) continue;
        // Correct the visible typo even when this particular layout is too
        // different to qualify for sticker replacement.
        scmToolkitNormalizeRateLimitTypo(label);
        let card = null;
        for (let node = label, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
            if (!scmToolkitIsShortRateLimit(node.innerText || node.textContent)) {
                // A short label may be nested in a richer warning. Never
                // discard its reset time, credit details or action prompt.
                if (/^rate(?:d)? limited\b[\s\S]*\b(?:reset|credit|upgrade|try again)/i
                    .test(String(node.innerText || node.textContent || '').trim())) card = null;
                break;
            }
            // Do not replace a label nested inside a real action or editor.
            const controls = node.querySelectorAll?.('button, a, input, textarea, select, [role="button"]') || [];
            // Reaching the composer owner ends the search; the isolated
            // status already found below it remains safe to replace.
            if (node.querySelector?.(scmToolkitCodexEditorSelector)) break;
            if (controls.length || node.matches?.('button, a, [role="button"]')) {
                card = null;
                break;
            }
            if (node.matches?.(scmToolkitRateLimitTranscriptSelector)) break;
            card = node;
        }
        if (card) found.add(card);
    }
    // Account for already-rendered stickers from an earlier Sweetiebot injection.
    for (const sticker of root.querySelectorAll('[data-scm-toolkit-rate-limit-pony]')) {
        found.add(sticker);
    }
    return [...found];
}
// Identify the status by a shared local composer owner, not monitor-dependent
// widths, pixel gaps, zoom factors, or the presence of a decorative status icon.
function scmToolkitComposerStatusDistance(status, editor) {
    if (!status || !editor || status === editor
        || status.contains?.(editor) || editor.contains?.(status)
        || status.closest?.(scmToolkitRateLimitTranscriptSelector)
        || editor.closest?.(scmToolkitRateLimitTranscriptSelector)) return null;
    let distance = 0;
    for (let owner = editor.parentElement; owner; owner = owner.parentElement, distance++) {
        if (owner.matches?.('body, html, main, [role="main"], [role="application"]')) return null;
        if (!owner.contains?.(status)) continue;
        // Shared app/transcript roots aren't evidence of a composer footer.
        if (owner.querySelector?.(scmToolkitRateLimitTranscriptSelector)) return null;
        return distance;
    }
    return null;
}

function scmToolkitIsDetailedRateLimitNotice(value) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return /^(?:rate(?:d)? limited|you[’']ve hit your usage limit|you[’']re out of codex messages)\b/i.test(normalized)
        && /\b(?:resets?|credits?|upgrade|try again|usage limit|codex messages)\b/i.test(normalized);
}

function scmToolkitDetailedRateLimitNodes(root) {
    const found = new Set();
    for (const label of root.querySelectorAll('span, p, h1, h2, h3, strong, [role="status"], [role="alert"]')) {
        if (scmToolkitIsQueuedPrompt(label) || (!scmToolkitIsDetailedRateLimitNotice(label.textContent)
            && !scmToolkitIsShortRateLimit(label.textContent))
            || label.closest?.(scmToolkitRateLimitTranscriptSelector)) continue;
        let candidate = null;
        // A short title with a sibling Upgrade button is also rich. Prefer
        // the nearest native status/details container, never a composer root.
        for (let node = label, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
            if (node.matches?.('body, html, main, [role="main"], [role="application"]')
                || node.matches?.(scmToolkitRateLimitTranscriptSelector)
                || node.querySelector?.(scmToolkitCodexEditorSelector)) break;
            if (node.matches?.('button, a, [role="button"]')) break;
            if (scmToolkitIsDetailedRateLimitNotice(node.textContent)
                || node.querySelector?.('button, a, [role="button"]')
                || (node.querySelectorAll?.('button, a, [role="button"]') || []).length > 0) {
                candidate = node;
                break;
            }
        }
        if (candidate) found.add(candidate);
    }
    return [...found];
}

// A second recognition path uses accessible status semantics and stable
// feature identifiers when Codex changes the translated banner copy or DOM
// wrapper. This deliberately does not assume CSS classes, screen coordinates,
// English text alone, or a fixed parent depth.
function scmToolkitRateLimitEvidence(node) {
    if (!node || scmToolkitIsQueuedPrompt(node) || node.closest?.(scmToolkitRateLimitTranscriptSelector)
        || node.closest?.('[contenteditable], [role="textbox"], [role="dialog"], [role="menu"], [hidden], [aria-hidden="true"], [inert]')) {
        return {matched: false, anchored: false};
    }
    const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    const signals = [
        node.getAttribute?.('data-testid'), node.getAttribute?.('data-status'),
        node.getAttribute?.('data-state'), node.getAttribute?.('id'),
        node.getAttribute?.('aria-label'), node.getAttribute?.('title')
    ].filter(Boolean).join(' ');
    // These are identifiers, not exact DOM class names or displayed phrases.
    const anchored = /(?:rate[\s_-]*limit|usage[\s_-]*limit|message[\s_-]*limit|quota[\s_-]*(?:exhaust|limit)|limit[\s_-]*reach|too[\s_-]*many[\s_-]*requests)/i.test(signals);
    const wording = /(?:rate[\s-]*limit(?:ed|ing)?|usage[\s-]*limit|quota (?:exhausted|reached|exceeded)|(?:message|request) limit (?:reached|exceeded)|(?:too many requests)|(?:out of (?:codex )?messages)|(?:you[’']?(?:ve| have) (?:hit|reached) (?:your |the )?(?:usage )?limit))/i.test(text);
    return {matched: anchored || wording, anchored};
}
function scmToolkitSemanticRateLimitNodes(root) {
    const results = new Set();
    for (const label of root.querySelectorAll(
        'span, p, h1, h2, h3, [role="status"], [role="alert"], [aria-live], [data-testid], [data-status], [aria-label], [title]'
    )) {
        const evidence = scmToolkitRateLimitEvidence(label);
        if (!evidence.matched || label.matches?.('button, a, [role="button"]')
            || label.querySelector?.(scmToolkitCodexEditorSelector)) continue;
        let candidate = label;
        // Prefer the owning alert/status wrapper, including different markup.
        for (let node = label.parentElement; node && node !== root; node = node.parentElement) {
            if (node.matches?.('body, html, main, [role="main"], [role="application"]')
                || node.matches?.(scmToolkitRateLimitTranscriptSelector)
                || node.querySelector?.(scmToolkitCodexEditorSelector)) break;
            if (node.matches?.('[role="status"], [role="alert"], [aria-live]') ||
                scmToolkitRateLimitEvidence(node).anchored) {
                candidate = node;
                break;
            }
            // Do not absorb a long page or unrelated content.
            if (String(node.textContent || '').length > 600) break;
        }
        if (candidate !== label && candidate.contains?.(label) === false) continue;
        if (candidate.closest?.(scmToolkitRateLimitTranscriptSelector)) continue;
        results.add(candidate);
    }
    // Nested labels of the same notice count as one candidate.
    return [...results].filter(node =>
        ![...results].some(other => other !== node && other.contains?.(node)));
}
function scmToolkitIsNativeRateLimitStatus(node) {
    const evidence = scmToolkitRateLimitEvidence(node);
    return evidence.matched && (evidence.anchored ||
        Boolean(node.matches?.('[role="status"], [role="alert"], [aria-live]')));
}

function scmToolkitFooterRateLimitNotice(root) {
    const notices = scmToolkitPlainRateLimitNodes(root);
    const editors = [...root.querySelectorAll(scmToolkitCodexEditorSelector)]
        .filter(editor => !editor.closest?.(
            '[hidden], [aria-hidden="true"], [inert], ' + scmToolkitRateLimitTranscriptSelector));
    let card = null;
    let rich = false;
    let best = Infinity;
    let ambiguous = false;
    const detailed = scmToolkitDetailedRateLimitNodes(root);
    // The short-only footer is preferred; information-bearing cards are
    // eligible for a separate compact sticker without losing native contents.
    for (const candidate of [...notices, ...detailed]) {
        if (candidate.getAttribute?.('data-scm-toolkit-rate-limit-pony') === 'true'
            || candidate.dataset?.scmToolkitRateLimitPony === 'true'
            || candidate.closest?.(scmToolkitRateLimitTranscriptSelector)) continue;
        for (const editor of editors) {
            const distance = scmToolkitComposerStatusDistance(candidate, editor);
            if (distance === null) continue;
            if (distance < best) {
                card = candidate;
                rich = detailed.includes(candidate) || !scmToolkitIsShortRateLimit(candidate.textContent);
                best = distance;
                ambiguous = false;
            } else if (distance === best && candidate !== card) {
                // Never replace an arbitrary one of two equally local statuses.
                ambiguous = true;
            }
        }
    }
    if (card && !ambiguous) return {card, notices, rich};
    if (ambiguous) return {card: null, notices, rich: false};
    // Renderers may portal the limit card outside the composer subtree.
    // Only trust a *unique*, semantically marked native alert/status with a
    // visible composer, never a loose phrase somewhere on the page.
    if (!editors.length) return {card: null, notices, rich: false};
    const semantic = scmToolkitSemanticRateLimitNodes(root);
    const local = [];
    const remote = [];
    for (const candidate of semantic) {
        if (candidate.getAttribute?.('data-scm-toolkit-rate-limit-pony') === 'true'
            || candidate.dataset?.scmToolkitRateLimitPony === 'true'
            || candidate.dataset?.scmToolkitRateLimitPonyMounted === 'true'
            || candidate.closest?.(scmToolkitRateLimitTranscriptSelector)) continue;
        const distances = editors.map(editor => scmToolkitComposerStatusDistance(candidate, editor))
            .filter(distance => distance !== null);
        if (distances.length) {
            local.push({candidate, distance: Math.min(...distances)});
        } else if (scmToolkitIsNativeRateLimitStatus(candidate)) {
            remote.push(candidate);
        }
    }
    if (local.length) {
        local.sort((a, b) => a.distance - b.distance);
        if (local.length > 1 && local[0].distance === local[1].distance)
            return {card: null, notices, rich: false};
        return {card: local[0].candidate, notices, rich: true};
    }
    if (remote.length === 1) return {card: remote[0], notices, rich: true};
    return {card: null, notices, rich: false};
}
function scmToolkitHideDuplicateRateLimitNotices(notices, footer) {
    for (const notice of notices) {
        if (notice === footer) continue;
        // Only hide real transcript duplicates or old injected stickers.
        if (!notice.closest?.(scmToolkitRateLimitTranscriptSelector)
            && notice.getAttribute?.('data-scm-toolkit-rate-limit-pony') !== 'true') continue;
        notice.setAttribute?.('data-scm-toolkit-rate-limit-duplicate', 'true');
        notice.setAttribute?.('aria-hidden', 'true');
        if (notice.style?.setProperty) notice.style.setProperty('display', 'none', 'important');
        else if (notice.style) notice.style.display = 'none';
    }
}
// Codex's native banner can be compacted by hide-reset-times.js into a
// [data-scm-toolkit-rate-limited] span while keeping the full outer <aside>.
// In that layout the generic "rich" notice branch would add a companion pony
// without removing the original green border. Replace the entire presentation
// only for the uniquely identified banner in the live composer.
function scmToolkitCollapsedNativeRateLimitBanner(root) {
    const banners = new Set();
    for (const status of root.querySelectorAll?.('[data-scm-toolkit-rate-limited="true"]') || []) {
        const banner = status.closest?.('aside');
        const composer = banner?.closest?.('[data-codex-composer-root]');
        if (!composer || status.closest?.(scmToolkitRateLimitTranscriptSelector)
            || scmToolkitIsQueuedPrompt(status)
            || !composer.querySelector?.(scmToolkitCodexEditorSelector)) continue;
        banners.add(banner);
    }
    return banners.size === 1 ? [...banners][0] : null;
}
function scmToolkitRestoreNativeRateLimitBanner(banner) {
    if (banner?.getAttribute?.('data-scm-toolkit-rate-limit-native-hidden') !== 'true') return;
    banner.style?.removeProperty?.('display');
    banner.removeAttribute?.('data-scm-toolkit-rate-limit-native-hidden');
}
function scmToolkitCleanNativeRateLimitStickers(root, activeBanner) {
    for (const sticker of root.querySelectorAll?.('[data-scm-toolkit-native-rate-limit-pony]') || []) {
        if (activeBanner && sticker.nextElementSibling === activeBanner) continue;
        scmToolkitRestoreNativeRateLimitBanner(sticker.nextElementSibling);
        sticker.remove?.();
    }
    for (const banner of root.querySelectorAll?.('[data-scm-toolkit-rate-limit-native-hidden="true"]') || []) {
        if (banner !== activeBanner) scmToolkitRestoreNativeRateLimitBanner(banner);
    }
}
function scmToolkitSyncCollapsedNativeRateLimitPony(root) {
    const banner = scmToolkitCollapsedNativeRateLimitBanner(root);
    if (!banner || !scmToolkitRateLimitStickerEnabled) {
        scmToolkitCleanNativeRateLimitStickers(root, null);
        return false;
    }
    scmToolkitCleanNativeRateLimitStickers(root, banner);
    const previous = banner.previousElementSibling;
    if (previous?.getAttribute?.('data-scm-toolkit-native-rate-limit-pony') === 'true') {
        // A React rerender may replace the aside without replacing its sibling.
        if (banner.getAttribute?.('data-scm-toolkit-rate-limit-native-hidden') !== 'true') {
            banner.setAttribute('data-scm-toolkit-rate-limit-native-hidden', 'true');
            banner.style.setProperty('display', 'none', 'important');
        }
        return true;
    }
    if (banner.dataset.scmToolkitRateLimitPonyUnavailable === 'true'
        || banner.dataset.scmToolkitRateLimitPonyPending === 'true'
        || !banner.parentElement?.insertBefore) return true;

    banner.dataset.scmToolkitRateLimitPonyPending = 'true';
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
        delete banner.dataset.scmToolkitRateLimitPonyPending;
        if (!banner.isConnected || scmToolkitCollapsedNativeRateLimitBanner(root) !== banner
            || !scmToolkitRateLimitStickerEnabled || !banner.parentElement?.insertBefore
            || banner.previousElementSibling?.getAttribute?.('data-scm-toolkit-native-rate-limit-pony') === 'true') return;
        const sticker = root.createElement('div');
        sticker.setAttribute('data-scm-toolkit-native-rate-limit-pony', 'true');
        sticker.setAttribute('data-scm-toolkit-rate-limit-pony', 'true');
        sticker.setAttribute('role', 'status');
        sticker.setAttribute('aria-label', image.alt);
        // Keep the native green banner hidden, but frame the image itself
        // with no interior spacing and center it above the composer.
        scmToolkitStyleRateLimitStickerCard(sticker);
        sticker.append(image);
        banner.parentElement.insertBefore(sticker, banner);
        // Preserve the untouched native banner underneath, so a failed image
        // never causes a blank warning and removing the sticker restores it.
        banner.setAttribute('data-scm-toolkit-rate-limit-native-hidden', 'true');
        banner.style.setProperty('display', 'none', 'important');
    });
    image.addEventListener('error', () => {
        delete banner.dataset.scmToolkitRateLimitPonyPending;
        banner.dataset.scmToolkitRateLimitPonyUnavailable = 'true';
        scmToolkitRestoreNativeRateLimitBanner(banner);
    });
    image.src = scmToolkitTwilightStopSource;
    return true;
}

function scmToolkitStyleRateLimitStickerCard(node) {
    node.style.border = '1px solid var(--vscode-focusBorder, currentColor)';
    node.style.borderRadius = '8px';
    node.style.outline = 'none';
    node.style.boxShadow = 'none';
    node.style.background = 'transparent';
    node.style.padding = '0';
    node.style.overflow = 'hidden';
    node.style.minWidth = '0';
    node.style.minHeight = '0';
    node.style.maxWidth = '100%';
    node.style.width = 'max-content';
    node.style.height = 'auto';
    node.style.display = 'flex';
    node.style.flex = '0 0 auto';
    node.style.alignSelf = 'center';
    node.style.marginInline = 'auto';
}
function scmToolkitSyncRateLimitPony(root) {
    // React can recycle a native footer while retaining our attributes. Retire
    // stale mount flags so its illustration returns after the next render.
    for (const companion of root.querySelectorAll('[data-scm-toolkit-rate-limit-pony-companion]')) {
        if (!companion.querySelector?.('img')) companion.remove();
    }
    for (const card of root.querySelectorAll('[data-scm-toolkit-rate-limit-pony], [data-scm-toolkit-rate-limit-pony-mounted]')) {
        if (card.getAttribute?.('data-scm-toolkit-rate-limit-pony-companion') === 'true') continue;
        if (card.getAttribute?.('data-scm-toolkit-rate-limit-pony') === 'true' && !card.querySelector?.('img'))
            card.removeAttribute?.('data-scm-toolkit-rate-limit-pony');
        if (card.dataset?.scmToolkitRateLimitPonyMounted === 'true'
            && !card.parentElement?.querySelector?.('[data-scm-toolkit-rate-limit-pony-companion] img'))
            delete card.dataset.scmToolkitRateLimitPonyMounted;
    }
    // Remove misplaced companions from older injections without touching the
    // queued prompt or its real attachments.
    for (const sticker of root.querySelectorAll('[data-scm-toolkit-rate-limit-pony-companion]')) {
        if (scmToolkitIsQueuedPrompt(sticker.parentElement)) sticker.remove();
    }
    if (scmToolkitSyncCollapsedNativeRateLimitPony(root)) return;
    const {card, notices, rich} = scmToolkitFooterRateLimitNotice(root);
    if (!card) return;
    scmToolkitNormalizeRateLimitTypo(card);
    if (!scmToolkitRateLimitStickerEnabled) return;
    scmToolkitHideDuplicateRateLimitNotices(notices, card);
    if (card.dataset.scmToolkitRateLimitPonyPending === 'true'
        || card.dataset.scmToolkitRateLimitPonyUnavailable === 'true'
        || card.dataset.scmToolkitRateLimitPonyMounted === 'true') return;
    if (rich && card.parentElement?.querySelector?.('[data-scm-toolkit-rate-limit-pony-companion]')) return;
    card.dataset.scmToolkitRateLimitPonyPending = 'true';
    const image = root.createElement('img');
    image.alt = 'Twilight Sparkle holding a STOP sign — rate limited';
    image.title = 'Rate limited · Twilight Sparkle STOP illustration';
    image.width = 96;
    image.style.width = '96px';
    image.style.maxWidth = '100%';
    image.style.height = 'auto';
    image.style.display = 'block';
    image.style.borderRadius = '8px';
    image.addEventListener('load', () => {
        // Do not overwrite an updated, action-bearing status while art loads.
        const current = scmToolkitFooterRateLimitNotice(root);
        if (!card.isConnected || current.card !== card || current.rich !== rich) {
            // If Codex added reset/action details while the image loaded, a
            // previously plain status must never be destructively replaced.
            delete card.dataset.scmToolkitRateLimitPonyPending;
            return;
        }
        if (rich) {
            // Keep the native timer, credit details, and buttons completely
            // intact; the pony occupies its own small independent card.
            const parent = card.parentElement;
            if (!parent?.insertBefore) {
                delete card.dataset.scmToolkitRateLimitPonyPending;
                return;
            }
            if (parent.querySelector?.('[data-scm-toolkit-rate-limit-pony-companion]')) {
                delete card.dataset.scmToolkitRateLimitPonyPending;
                return;
            }
            const compact = root.createElement('div');
            compact.setAttribute('data-scm-toolkit-rate-limit-pony-companion', 'true');
            compact.setAttribute('data-scm-toolkit-rate-limit-pony', 'true');
            compact.setAttribute('aria-label', image.alt);
            scmToolkitStyleRateLimitStickerCard(compact);
            compact.append(image);
            parent.insertBefore(compact, card);
            card.dataset.scmToolkitRateLimitPonyMounted = 'true';
        } else {
            card.replaceChildren(image);
            card.setAttribute('data-scm-toolkit-rate-limit-pony', 'true');
            card.setAttribute('aria-label', image.alt);
            scmToolkitStyleRateLimitStickerCard(card);
        }
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
    const style = document.createElement('style');
    style.textContent = '[data-scm-toolkit-compact-limit="true"]{font-size:0!important}[data-scm-toolkit-compact-limit="true"]::after{content:"Rate limited";font-size:12px}[data-scm-toolkit-rate-limit-pony="true"]{display:flex!important;width:max-content!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:100%!important;padding:0!important;margin-inline:auto!important;align-self:center!important;overflow:hidden!important}';
    (document.head || document.documentElement).appendChild(style);
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
    const onMutations = mutations => {
        // Respond within the observer's microtask, not in the subsequently
        // queued general sync, so React rerenders do not flash the full copy.
        for (const mutation of mutations) {
            scmToolkitCompactUntimedRateLimitBranch(mutation.target);
            for (const added of mutation.addedNodes || []) {
                scmToolkitCompactUntimedRateLimitBranch(added);
            }
        }
        sync();
    };
    new MutationObserver(onMutations).observe(document, { childList: true, subtree: true, characterData: true });
    scmToolkitCompactUntimedRateLimitBranch(document);
    sync();
})();
