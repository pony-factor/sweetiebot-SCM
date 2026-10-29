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
    const style = document.createElement('style');
    style.textContent = '[data-scm-toolkit-activity-cannon]{font-size:0!important;display:inline-flex!important;align-items:center;gap:6px}[data-scm-toolkit-activity-cannon]::before{content:attr(data-scm-toolkit-activity-dots);font-size:24px;line-height:1}[data-scm-toolkit-activity-cannon]::after{content:"";display:inline-block;width:22px;height:22px;background:center/contain no-repeat var(--scm-toolkit-activity-cannon-image)}';
    (document.head || document.documentElement).append(style);
    const scan = () => {
        for (const node of document.querySelectorAll('span, p, button, summary, [data-scm-toolkit-activity-cannon]')) {
            if (node.closest('[data-message-author-role="user"], [data-conversation-role="user"], [contenteditable], pre, code')) continue;
            const minutes = scmToolkitActivityMinutes(node.textContent);
            if (minutes === null) {
                node.removeAttribute('data-scm-toolkit-activity-cannon');
                node.removeAttribute('data-scm-toolkit-activity-dots');
                continue;
            }
            if ([...node.children].some(child => scmToolkitActivityMinutes(child.textContent) !== null)) continue;
            node.setAttribute('data-scm-toolkit-activity-cannon', 'true');
            node.setAttribute('data-scm-toolkit-activity-dots', '•'.repeat(Math.min(minutes, 120)));
            node.style.setProperty('--scm-toolkit-activity-cannon-image', 'url("' + globalThis.scmToolkitActivityCannonImage + '")');
        }
    };
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; scan(); }); } })
        .observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    scan();
})();
