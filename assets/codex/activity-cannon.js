// Preserve native activity controls and timing; replace only their visual label.
function scmToolkitActivityMinutes(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!/^(?:Working|Worked|Thought) for (?:\d+\s*(?:d|h|m|s|days?|hours?|minutes?|seconds?)\s*)+$/i.test(text)) return null;
    let minutes = 0;
    for (const match of text.matchAll(/(\d+)\s*(days?|hours?|minutes?|seconds?|d|h|m|s)/gi)) {
        minutes += +match[1] * (/^d/i.test(match[2]) ? 1440 : /^h/i.test(match[2]) ? 60 : /^m/i.test(match[2]) ? 1 : 0);
    }
    return minutes;
}
(() => {
    if (!globalThis.scmToolkitActivityCannonEnabled || globalThis.scmToolkitActivityCannonInstalled) return;
    globalThis.scmToolkitActivityCannonInstalled = true;
    globalThis.scmToolkitShowCannon = true; // Share duration ownership with the native timestamp helper.
    const style = document.createElement('style');
    style.textContent = '[data-scm-toolkit-activity-cannon]{font-size:0!important;display:inline-flex!important;align-items:center;gap:6px;min-width:0;max-width:100%;white-space:normal!important}[data-scm-toolkit-activity-cannon]>:not(svg){font-size:0!important}[data-scm-toolkit-activity-cannon]::before{content:attr(data-scm-toolkit-activity-dots);font-size:24px;line-height:1;min-width:0;overflow-wrap:anywhere;white-space:normal;flex:0 1 auto}[data-scm-toolkit-activity-cannon]::after{content:"";display:inline-block;flex:0 0 22px;width:22px;height:22px;background:center/contain no-repeat var(--scm-toolkit-activity-cannon-image)}';
    // The artwork is a large data URL. Share it once, rather than rewriting
    // megabytes of inline style on every historical label after every update.
    document.documentElement.style.setProperty('--scm-toolkit-activity-cannon-image', 'url("' + globalThis.scmToolkitActivityCannonImage + '")');
    (document.head || document.documentElement).append(style);
    const selector = 'span, p, div, button, summary, [data-scm-toolkit-activity-cannon]';
    const update = node => {
            if (!node.matches?.(selector)) return;
            if (node.closest('[data-message-author-role="user"], [data-conversation-role="user"], [contenteditable], pre, code')) return;
            const minutes = scmToolkitActivityMinutes(node.textContent);
            if (minutes === null) {
                node.removeAttribute('data-scm-toolkit-activity-cannon');
                node.removeAttribute('data-scm-toolkit-activity-dots');
                return;
            }
            if ([...node.children].some(child => scmToolkitActivityMinutes(child.textContent) !== null)) return;
            if (!node.hasAttribute('data-scm-toolkit-activity-cannon')) node.setAttribute('data-scm-toolkit-activity-cannon', 'true');
            const dots = '•'.repeat(Math.min(minutes, 120));
            if (node.getAttribute('data-scm-toolkit-activity-dots') !== dots) node.setAttribute('data-scm-toolkit-activity-dots', dots);
    };
    const scan = root => {
        update(root);
        for (const node of root.querySelectorAll?.(selector) || []) update(node);
    };
    const added = new Set(), changed = new Set();
    let queued = false;
    new MutationObserver(records => {
        for (const record of records) {
            changed.add(record.target.nodeType === 3 ? record.target.parentElement : record.target);
            for (const node of record.addedNodes || []) if (node.nodeType === 1) added.add(node);
        }
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            for (const root of added) {
                if (!root.isConnected) continue;
                let owner = root.parentElement;
                while (owner && !added.has(owner)) owner = owner.parentElement;
                if (!owner) scan(root);
            }
            for (const root of changed) {
                for (let node = root, depth = 0; node && depth < 5 && node !== document.body && node !== document.documentElement; node = node.parentElement, depth++) {
                    update(node);
                    if (node.textContent.length > 96) break;
                }
            }
            added.clear(); changed.clear();
        });
    })
        .observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    scan(document);
})();
