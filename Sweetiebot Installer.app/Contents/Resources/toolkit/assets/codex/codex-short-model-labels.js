// Shorten only the active composer model display, preserving its controls.
(() => {
    if (globalThis.scmToolkitShortModelLabels) return;
    globalThis.scmToolkitShortModelLabels = true;
    const selector = 'button[data-composer-navigation-target="reasoning"],button[data-composer-navigation-target="model"]';

    function shorten(value) {
        return value.replace(/\bGPT[-\s]+(?=\d)/gi, '')
            .replace(/\bMedium\b/gi, 'Med')
            .replace(/\bLight\b/gi, 'Low')
            .replace(/\bExtra\s+high\b/gi, 'Uber');
    }

    function scan() {
        document.querySelectorAll(selector).forEach(button => {
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const next = shorten(node.nodeValue);
                if (next !== node.nodeValue) node.nodeValue = next;
            }
        });
    }

    function start() {
        scan();
        // React may update text nodes in place or replace the composer entirely.
        new MutationObserver(scan).observe(document.documentElement, {
            childList: true, subtree: true, characterData: true,
            attributes: true,
            attributeFilter: ['data-composer-navigation-target', 'data-selected-reasoning-effort'],
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
