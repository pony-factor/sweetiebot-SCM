// Keep visual hints outside contenteditable. Chromium can expose generated
// placeholder text inside the editor as its macOS accessibility value.
(() => {
    const values = new Set(__SCM_TOOLKIT_PLACEHOLDERS__);
    const marker = 'data-scm-toolkit-placeholder';
    const hostMarker = 'data-scm-toolkit-placeholder-host';
    const overlays = new Map();
    const style = document.createElement('style');
    style.textContent = `
        .ProseMirror [${marker}]::before { content: none !important; }
        [${hostMarker}] { position: relative; }
        .scm-toolkit-placeholder-display {
            position: absolute; pointer-events: none; user-select: none;
            -webkit-user-select: none; white-space: nowrap; overflow: hidden;
            text-overflow: ellipsis; color: var(--color-text-tertiary);
            opacity: var(--composer-editor-placeholder-opacity, .5);
        }
    `;
    document.head.append(style);
    let scheduled = false;
    let enabled = true;
    function sync() {
        scheduled = false;
        const active = new Set();
        for (const placeholder of document.querySelectorAll('.ProseMirror .placeholder[data-placeholder]')) {
            const text = placeholder.getAttribute('data-placeholder');
            const editor = placeholder.closest('[contenteditable="true"]');
            const host = editor?.parentElement;
            if (!host || !values.has(text) || !placeholder.getClientRects().length) continue;
            active.add(placeholder);
            let overlay = overlays.get(placeholder);
            if (!overlay || overlay.parentElement !== host) {
                overlay?.remove();
                overlay = document.createElement('span');
                overlay.className = 'scm-toolkit-placeholder-display';
                overlay.setAttribute('aria-hidden', 'true');
                overlay.setAttribute('contenteditable', 'false');
                if (getComputedStyle(host).position === 'static') host.setAttribute(hostMarker, '');
                host.append(overlay);
                overlays.set(placeholder, overlay);
                resize.observe(host);
            }
            if (!placeholder.hasAttribute(marker)) placeholder.setAttribute(marker, '');
            if (overlay.textContent !== text) overlay.textContent = text;
            const rect = placeholder.getBoundingClientRect();
            const parent = host.getBoundingClientRect();
            const computed = getComputedStyle(placeholder);
            const css = `left:${rect.left - parent.left - host.clientLeft + host.scrollLeft}px;top:${rect.top - parent.top - host.clientTop + host.scrollTop}px;width:${rect.width}px;font:${computed.font};line-height:${computed.lineHeight}`;
            if (overlay.style.cssText !== css) overlay.style.cssText = css;
        }
        for (const [placeholder, overlay] of overlays) {
            if (active.has(placeholder)) continue;
            placeholder.removeAttribute(marker);
            if (overlay.parentElement) resize.unobserve(overlay.parentElement);
            overlay.remove();
            overlays.delete(placeholder);
        }
    }
    function schedule() {
        if (scheduled || !enabled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            try { sync(); } catch {
                enabled = false;
                style.remove();
                for (const overlay of overlays.values()) overlay.remove();
                overlays.clear();
            }
        });
    }
    new MutationObserver(schedule).observe(document.body, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'data-placeholder']
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    sync();
})();
