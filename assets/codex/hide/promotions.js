// Runs as part of the Codex webview bundle when promotion hiding is enabled.
(() => {
    const signatures = [
        { title: 'Enable Fast mode', action: 'Enable now' },
        { title: "You're out of Codex messages", action: 'Upgrade' },
    ];
    const hiddenAttribute = 'data-scm-toolkit-hidden-promotion';

    const normalize = (value) => (value || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

    function matchingSignature(button) {
        const label = normalize(button.textContent);
        return signatures.find(({ action }) => label === action);
    }

    function findPromotionCard(button, signature) {
        let element = button.parentElement;
        for (let depth = 0; element && depth < 10; depth += 1) {
            // Stop before crossing into a shared conversation/composer wrapper.
            // An unrelated Upgrade button must not match a neighboring card.
            if (element.matches('main, [role="main"]')
                || element.querySelector('textarea, input, [contenteditable="true"]')
                || Array.from(element.querySelectorAll('button')).filter(
                    (candidate) => normalize(candidate.textContent) === signature.action
                ).length > 1) return null;
            const text = normalize(element.textContent);
            if (text.includes(signature.title) && text.includes(signature.action)) {
                return element;
            }
            element = element.parentElement;
        }
        return null;
    }

    function hidePromotion(button) {
        const signature = matchingSignature(button);
        if (!signature) return;

        const card = findPromotionCard(button, signature);
        if (
            !card
            || card === document.body
            || card === document.documentElement
        ) {
            return;
        }

        // An exhausted allowance is still useful status when promotions and
        // reset times are hidden. Keep the native card with a minimal label.
        if (signature.title === "You're out of Codex messages") {
            const marker = 'data-scm-toolkit-rate-limited';
            for (const child of card.childNodes) {
                if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
                    child.textContent = '';
                } else if (child.nodeType === Node.ELEMENT_NODE && !child.hasAttribute(marker)) {
                    child.setAttribute('aria-hidden', 'true');
                    child.style.setProperty('display', 'none', 'important');
                }
            }
            if (!card.querySelector(`[${marker}]`)) {
                const status = document.createElement('span');
                status.setAttribute(marker, 'true');
                status.setAttribute('role', 'status');
                status.textContent = 'Rated Limited';
                card.appendChild(status);
            }
            return;
        }

        if (card.hasAttribute(hiddenAttribute)) return;
        card.setAttribute(hiddenAttribute, 'true');
        card.setAttribute('aria-hidden', 'true');
        card.style.setProperty('display', 'none', 'important');
    }

    function scan(root) {
        if (root instanceof Element && root.matches('button')) {
            hidePromotion(root);
        }
        root.querySelectorAll?.('button').forEach(hidePromotion);
    }

    function start() {
        scan(document);
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'characterData') {
                    scan(record.target.parentElement || document);
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
            characterData: true,
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
