// Runs as part of the Codex webview bundle when dictation-button hiding is enabled.
(() => {
    const hiddenAttribute = 'data-scm-toolkit-hidden-dictation';

    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    function looksLikeDictation(value) {
        const text = normalize(value);
        return /\bdictat(?:e|ion)\b/i.test(text);
    }

    function isDictationButton(element) {
        if (!(element instanceof Element) || !element.matches('button,[role="button"]')) {
            return false;
        }

        return [
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('data-tooltip'),
            element.getAttribute('data-tooltip-content'),
        ].some(looksLikeDictation);
    }

    function hideDictationButton(element) {
        if (!isDictationButton(element) || element.hasAttribute(hiddenAttribute)) return;

        element.setAttribute(hiddenAttribute, 'true');
        element.setAttribute('aria-hidden', 'true');
        element.style.setProperty('display', 'none', 'important');
    }

    function scan(root) {
        if (!(root instanceof Element) && root !== document) return;

        if (root instanceof Element) hideDictationButton(root);
        root.querySelectorAll?.('button,[role="button"]').forEach(hideDictationButton);
    }

    function start() {
        scan(document);
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'attributes') {
                    hideDictationButton(record.target);
                    continue;
                }
                for (const node of record.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) scan(node);
                }
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-label', 'title', 'data-tooltip', 'data-tooltip-content'],
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
