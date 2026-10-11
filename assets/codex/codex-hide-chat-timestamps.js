// Runs as part of the Codex webview bundle when chat timestamp hiding is enabled.
(() => {
    // Multiple lazy-loaded webview chunks may include this helper.
    if (globalThis.scmToolkitHideTimestampsInitialized) return;
    globalThis.scmToolkitHideTimestampsInitialized = true;
    const hiddenAttribute = 'data-scm-toolkit-hidden-chat-timestamp';
    const styleId = 'scm-toolkit-hidden-chat-timestamp-style';

    function installStyle() {
        if (document.getElementById?.(styleId) || !document.createElement) return;
        const root = document.head || document.documentElement;
        if (!root?.appendChild) return;
        const style = document.createElement('style');
        style.id = styleId;
        // A persistent stylesheet wins over React resetting the inline style.
        style.textContent = `[${hiddenAttribute}] { display: none !important; }`;
        root.appendChild(style);
    }

    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const timePattern = /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:AM|PM))?$/i;
    const relativePattern = /^(?:Today|Yesterday)(?:\s+at)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;
    const weekdayPattern = /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:\s+at)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;
    const monthPattern = /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at)?(?:,)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;
    const numericPattern = /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?:,)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;

    // Hide elapsed-work labels without removing the collapsible activity controls.
    const activityDurationPattern = /^(?:Worked|Thought) for \d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)(?:\s*\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s))*$/i;
    const activityLeadPattern = /^(?:Worked|Thought)(?:\s+for\b|\s*$)/i;

    function looksLikeActivityDuration(value) {
        return activityDurationPattern.test(normalize(value));
    }

    function activityControl(node) {
        let element = node.parentElement;
        for (let depth = 0; element && depth < 6; depth += 1, element = element.parentElement) {
            const tag = (element.tagName || '').toUpperCase();
            if (tag === 'BUTTON' || tag === 'SUMMARY'
                || element.getAttribute?.('role') === 'button'
                || element.hasAttribute?.('aria-expanded')) return element;
        }
        return null;
    }

    function relabelActivityDuration(node) {
        const control = activityControl(node);
        if (!control) return;
        // Only touch controls whose complete label is an elapsed duration.
        const label = normalize(control.textContent).replace(/[›»⌄▾>]$/, '').trim();
        if (!looksLikeActivityDuration(label)) return;

        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        const first = nodes.find((part) => activityLeadPattern.test(normalize(part.textContent)));
        if (!first) return;

        for (const part of nodes) part.textContent = part === first ? 'Activity' : '';
        for (const name of ['title', 'aria-label']) {
            const value = control.getAttribute?.(name);
            if (value != null && looksLikeActivityDuration(value)) control.setAttribute(name, 'Activity');
        }
    }

    function looksLikeTimestamp(value) {
        const text = normalize(value);
        return Boolean(
            text
            && text.length <= 64
            && (
                relativePattern.test(text)
                || weekdayPattern.test(text)
                || monthPattern.test(text)
                || numericPattern.test(text)
                || timePattern.test(text)
            )
        );
    }

    function hasInteractiveContent(element) {
        return Boolean(element.querySelector('button,a,input,textarea,select,[contenteditable="true"]'));
    }

    function timestampContainer(node) {
        let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        // Timestamp labels can be split into several text nodes or spans.
        // Find a small exact-match ancestor without hiding its surrounding row.
        let found = null;
        for (let depth = 0; element && depth < 5; depth += 1, element = element.parentElement) {
            if (looksLikeTimestamp(element.textContent)) {
                found = element;
                break;
            }
            if (element === document.body || element === document.documentElement) break;
        }
        if (!found) return null;

        const label = normalize(found.textContent);
        let best = found;
        for (let depth = 0; depth < 5; depth += 1) {
            const parent = best.parentElement;
            if (
                !parent
                || parent === document.body
                || parent === document.documentElement
                || normalize(parent.textContent) !== label
                || hasInteractiveContent(parent)
            ) {
                break;
            }
            best = parent;
        }

        if (hasInteractiveContent(best)) return null;
        return best;
    }

    function hideTimestamp(node) {
        const container = timestampContainer(node);
        if (!container) return;

        if (container.getAttribute(hiddenAttribute) !== 'true') {
            container.setAttribute(hiddenAttribute, 'true');
        }
        if (container.getAttribute('aria-hidden') !== 'true') {
            container.setAttribute('aria-hidden', 'true');
        }
        if (container.style?.getPropertyValue?.('display') !== 'none'
            || container.style?.getPropertyPriority?.('display') !== 'important') {
            container.style?.setProperty('display', 'none', 'important');
        }
    }

    function processTextNode(node) {
        if (timestampContainer(node)) hideTimestamp(node);
        else if (activityLeadPattern.test(normalize(node.textContent))) relabelActivityDuration(node);
    }

    function scan(root) {
        if (!root) return;

        if (root.nodeType === Node.TEXT_NODE) {
            processTextNode(root);
            return;
        }

        if (!(root instanceof Element) && root !== document) return;

        if (root !== document && timestampContainer(root)) hideTimestamp(root);
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return looksLikeTimestamp(node.textContent)
                        || looksLikeTimestamp(node.parentElement?.textContent)
                        || activityLeadPattern.test(normalize(node.textContent))
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                },
            },
        );

        const matches = [];
        while (walker.nextNode()) matches.push(walker.currentNode);
        matches.forEach(processTextNode);
    }

    function start() {
        installStyle();
        scan(document);
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'attributes') {
                    // React may remove our marker or accessible hiding state.
                    scan(record.target);
                    continue;
                }
                if (record.type === 'characterData') {
                    scan(record.target);
                    continue;
                }
                for (const node of record.addedNodes) scan(node);
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: [hiddenAttribute, 'aria-hidden'],
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
