// Keep the displayed Codex home/sidebar heading consistent with the user's
// configured window label, without rewriting conversation text or product copy.
(() => {
    const label = __SCM_TOOLKIT_CODEX_WINDOW_LABEL__;
    if (!label || label === 'Codex' || globalThis.scmToolkitWindowLabel === label) return;
    globalThis.scmToolkitWindowLabel = label;

    const combined = `${label}: Codex`;
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const selectors = 'h1,h2,h3,h4,header,[role="heading"],[role="banner"],[class*="Header"],[class*="header"],[class*="Heading"],[class*="heading"],[class*="Title"],[class*="title"]';
    const excluded = 'article,[data-message-id],[data-testid*="message"],[contenteditable="true"],input,textarea';

    function nearTop(element) {
        const box = element?.getBoundingClientRect?.();
        return Boolean(box && box.top >= -10 && box.top < 220);
    }

    function replaceHeading(element) {
        if (!nearTop(element) || element.closest?.(excluded)) return;
        // A header's own text may include labels from neighboring action buttons,
        // so compare only non-interactive text nodes below.
        // A real sidebar header can contain action buttons next to its title.
        // Skip their text, but do not skip the entire heading because of them.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
            const part = walker.currentNode;
            if (part.parentElement?.closest?.('button,a,input,textarea,select,[contenteditable="true"]')) continue;
            if (normalize(part.nodeValue)) nodes.push(part);
        }
        if (!nodes.length || nodes.length > 3) return;
        const titleText = normalize(nodes.map(part => part.nodeValue).join(''));
        if (titleText !== combined && titleText !== 'Codex') return;
        nodes.forEach((node, index) => {
            node.nodeValue = index === 0 ? label : '';
        });
    }

    function scan() {
        document.querySelectorAll(selectors).forEach(replaceHeading);
        // Some Codex versions use a plain div for the header rather than an h1.
        // Match only the *complete* compound title near the top of the webview.
        const root = document.body;
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node, count = 0;
        while ((node = walker.nextNode()) && count++ < 200) {
            if (normalize(node.nodeValue) !== combined) continue;
            const parent = node.parentElement;
            if (parent && !parent.closest?.(excluded) && nearTop(parent)) {
                node.nodeValue = label;
            }
        }
    }

    function start() {
        scan();
        const observer = new MutationObserver(scan);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
