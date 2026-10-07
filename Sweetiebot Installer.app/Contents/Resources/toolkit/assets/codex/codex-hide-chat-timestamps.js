// Runs as part of the Codex webview bundle when chat timestamp hiding is enabled.
(() => {
    const hiddenAttribute = 'data-scm-toolkit-hidden-chat-timestamp';

    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const timePattern = /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:AM|PM))?$/i;
    const relativePattern = /^(?:Today|Yesterday)(?:\s+at)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;
    const weekdayPattern = /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:\s+at)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;
    const monthPattern = /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at)?(?:,)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;
    const numericPattern = /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?:,)?\s+(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)$/i;

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
        if (!element) return null;

        const label = normalize(element.textContent);
        if (!looksLikeTimestamp(label)) return null;

        let best = element;
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
        if (!container || container.hasAttribute(hiddenAttribute)) return;

        container.setAttribute(hiddenAttribute, 'true');
        container.setAttribute('aria-hidden', 'true');
        container.style.setProperty('display', 'none', 'important');
    }

    function scan(root) {
        if (!root) return;

        if (root.nodeType === Node.TEXT_NODE) {
            if (looksLikeTimestamp(root.textContent)) hideTimestamp(root);
            return;
        }

        if (!(root instanceof Element) && root !== document) return;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return looksLikeTimestamp(node.textContent)
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                },
            },
        );

        const matches = [];
        while (walker.nextNode()) matches.push(walker.currentNode);
        matches.forEach(hideTimestamp);
    }

    function start() {
        scan(document);
        const observer = new MutationObserver((records) => {
            for (const record of records) {
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
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
