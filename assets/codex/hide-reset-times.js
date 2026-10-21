// Suppress Codex usage-reset timing without concealing usage allowances.
function scmToolkitStripUsageResetTime(value) {
    const text = String(value == null ? '' : value);
    const duration = /\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\s+\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s))*/.source;
    const clock = /\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?|\d{1,2}\s*(?:AM|PM)/.source;
    const date = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|today|tomorrow|tonight/.source;
    const time = '(?:' + duration + '|' + clock + '|' + date + ')';
    const when = '(?:\\s+(?:in|at|on|after|until)\\s+|\\s*[,;:–—-]\\s*|\\s+)' + time;
    let result = text.replace(new RegExp('\\b(?:try again|retry)' + when, 'gi'), 'Try again later');
    result = result.replace(new RegExp('\\bwait until\\s+' + time, 'gi'), 'wait until your limit resets');
    result = result.replace(new RegExp('\\b(resets?|renews?)' + when, 'gi'), '$1');
    result = result.replace(new RegExp('\\b(next reset\\s*:?)' + when, 'gi'), '$1');
    if (/^\s*(?:resets?|renews?|next reset\s*:?)\s*[.!]?\s*$/i.test(result)) return '';
    return result;
}

// Also catch reset values rendered in child spans without their "Resets" prefix.
function scmToolkitIsStandaloneTime(value) {
    return /^(?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)(?:\s+\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m))*(?:\s+left)?|\d{1,2}:\d{2}\s*(?:AM|PM)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?|today|tomorrow)$/i.test(String(value || '').trim());
}

(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    let pending = false;
    function scrub() {
        pending = false;
        for (const element of document.querySelectorAll('*')) {
            if (/^(?:SCRIPT|STYLE|TEXTAREA|INPUT|PRE|CODE)$/i.test(element.tagName || '')) continue;
            for (const name of ['title', 'aria-label']) {
                const original = element.getAttribute?.(name);
                if (original == null) continue;
                const cleaned = scmToolkitStripUsageResetTime(original);
                if (cleaned !== original) {
                    if (cleaned.trim()) element.setAttribute(name, cleaned);
                    else element.removeAttribute(name);
                }
            }
            // A mixed-content banner may hold its message in a text node beside
            // an Upgrade button. Clean only its own text, preserving the controls.
            if (element.children?.length) {
                for (const node of element.childNodes || []) {
                    if (node.nodeType !== 3) continue;
                    const originalText = String(node.textContent || '');
                    const cleanedText = scmToolkitStripUsageResetTime(originalText);
                    if (cleanedText !== originalText) node.textContent = cleanedText;
                }
            }
            const original = String(element.textContent || '');
            if (!original.trim()) continue;
            const parentText = String(element.parentElement?.textContent || '');
            const nestedTime = !element.children?.length
                && scmToolkitIsStandaloneTime(original)
                && /(?:resets?|renews?|usage limit|rate limit|try again|wait until)/i.test(parentText)
                && scmToolkitStripUsageResetTime(parentText) !== parentText;
            const cleaned = nestedTime ? '' : scmToolkitStripUsageResetTime(original);
            if (cleaned === original) continue;
            if (element.children?.length) {
                // Never erase a parent containing other usage information.
                if (cleaned.trim() || element.getAttribute('data-scm-hidden-reset') === 'true') continue;
            } else if (cleaned.trim()) {
                element.textContent = cleaned;
                continue;
            }
            if (element.getAttribute('data-scm-hidden-reset') !== 'true') {
                element.setAttribute('data-scm-hidden-reset', 'true');
                element.setAttribute('aria-hidden', 'true');
                element.style?.setProperty('display', 'none', 'important');
            }
        }
    }
    const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        queueMicrotask(scrub);
    });
    observer.observe(document, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['title', 'aria-label'],
    });
    scrub();
})();
