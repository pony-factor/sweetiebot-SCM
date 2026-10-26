// Keep the native location menu and its React ownership while placing it inline.
(() => {
    if (globalThis.scmToolkitComposerControls) return;
    globalThis.scmToolkitComposerControls = true;
    const style = document.createElement('style');
    style.textContent = `
      :root[data-codex-window-type="extension"] .scm-toolkit-composer-footer {
        display: flex !important; flex-wrap: wrap; column-gap: 4px !important; row-gap: 4px; }
      :root[data-codex-window-type="extension"] .scm-toolkit-composer-footer > * {
        flex: 0 0 auto; }
      :root[data-codex-window-type="extension"] .scm-toolkit-composer-footer > :last-child {
        flex: 1 0 auto; min-width: max-content; }
      :root[data-codex-window-type="extension"] .scm-toolkit-composer-footer > [class*="AdaptiveFooterInput_"] {
        flex-basis: 100%; order: -1; min-width: 0; }
      :root[data-codex-window-type="extension"] [data-composer-body] div:has(> .scm-toolkit-codex-clipboard-button) {
        gap: 4px !important; }
      .scm-toolkit-inline-location { position: absolute !important; margin: 0 !important;
        z-index: 2; pointer-events: auto !important; }
      .scm-toolkit-location-overflow { overflow: visible !important;
        position: relative !important; z-index: 11 !important; pointer-events: auto !important; }
      .scm-toolkit-empty-utility { min-height: 0 !important; height: 0 !important;
        padding-block: 0 !important; margin-block: 0 !important; border: 0 !important; overflow: visible !important; }
    `;
    document.head.append(style);
    function set(element, property, value) {
        if (element.style[property] !== value) element.style[property] = value;
    }
    function scan() {
        document.querySelectorAll('button[data-composer-navigation-target="run-location"]').forEach(location => {
            // Limit the search to the nearest shared composer ancestor.
            let composer = location.parentElement;
            while (composer && !composer.querySelector('button[data-composer-navigation-target="permissions"]')) {
                composer = composer.parentElement;
            }
            if (!composer || composer === document.body || composer === document.documentElement) return;
            const access = composer.querySelector('button[data-composer-navigation-target="permissions"]');
            // Absolute positioning preserves React's menu ownership, but its
            // width still needs a place in the native footer's layout.
            const footer = access.closest('[class*="ComposerLayoutFooter_"]');
            if (footer && !footer.classList.contains('scm-toolkit-composer-footer')) {
                footer.classList.add('scm-toolkit-composer-footer');
            }
            // The native utility rail clips its descendants. The inline button
            // sits outside those bounds, so every intervening wrapper must allow
            // painting and hit testing and sit above the composer footer. A
            // z-index on the button alone cannot escape a lower stacking context.
            for (let wrapper = location.parentElement; wrapper && wrapper !== composer;
                wrapper = wrapper.parentElement) {
                if (!wrapper.classList.contains('scm-toolkit-location-overflow')) {
                    wrapper.classList.add('scm-toolkit-location-overflow');
                }
            }
            const rail = location.closest('[data-composer-rail-item]');
            if (rail) {
                const onlyLocation = [...rail.querySelectorAll('button')].every(button => button === location)
                    && rail.textContent.trim() === location.textContent.trim();
                if (rail.classList.contains('scm-toolkit-empty-utility') !== onlyLocation) {
                    rail.classList.toggle('scm-toolkit-empty-utility', onlyLocation);
                }
            }
            if (!location.classList.contains('scm-toolkit-inline-location')) {
                location.classList.add('scm-toolkit-inline-location');
            }
            if (!margins.has(access)) margins.set(access, {
                start:access.style.marginInlineStart, end:access.style.marginInlineEnd,
            });
            const usageOnly = location.disabled && location.querySelector('scm-toolkit-usage-meter');
            const margin = margins.get(access);
            set(access, 'marginInlineStart', usageOnly ? `${location.getBoundingClientRect().width + 8}px` : margin.start);
            set(access, 'marginInlineEnd', usageOnly ? margin.end : `${location.getBoundingClientRect().width + 8}px`);
            const parent = location.offsetParent;
            if (!parent) return;
            const origin = parent.getBoundingClientRect();
            const target = access.getBoundingClientRect();
            const left = usageOnly ? target.left - location.getBoundingClientRect().width - 4 : target.right + 4;
            set(location, 'left', `${left - origin.left - parent.clientLeft + parent.scrollLeft}px`);
            set(location, 'top', `${target.top - origin.top - parent.clientTop + parent.scrollTop}px`);
        });
    }
    let pending = false;
    let enabled = true;
    const margins = new Map();
    function safeScan() {
        if (!enabled) return;
        try { scan(); } catch {
            enabled = false;
            style.remove();
            for (const [element, margin] of margins) {
                element.style.marginInlineStart = margin.start;
                element.style.marginInlineEnd = margin.end;
            }
        }
    }
    function schedule() {
        if (pending || !enabled) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; safeScan(); });
    }
    function start() {
        safeScan();
        new MutationObserver(schedule).observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['class', 'style', 'data-composer-navigation-target'],
        });
        new ResizeObserver(schedule).observe(document.documentElement);
        window.addEventListener('resize', schedule);
        document.addEventListener('scroll', schedule, true);
    }
    start();
})();
