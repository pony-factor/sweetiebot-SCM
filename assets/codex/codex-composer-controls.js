// Keep the native location menu and its React ownership while placing it inline.
(() => {
    if (globalThis.scmToolkitComposerControls) return;
    globalThis.scmToolkitComposerControls = true;
    const style = document.createElement('style');
    style.textContent = `
      :root[data-codex-window-type="extension"] [data-composer-body] [data-composer-input-layout],
      :root[data-codex-window-type="extension"] [data-composer-body] [data-rich-text-layout] {
        min-width: 0 !important; max-width: 100%; }
      :root[data-codex-window-type="extension"] [data-composer-body] .ProseMirror,
      :root[data-codex-window-type="extension"] [data-composer-body] .ProseMirror p {
        white-space: pre-wrap !important; overflow-wrap: anywhere; }
      :root[data-codex-window-type="extension"] [data-composer-body] [data-composer-input-layout="single-line"] {
        height: auto !important; max-height: min(25dvh, 7lh); overflow-y: auto !important; }
      :root[data-codex-window-type="extension"] [data-composer-body] [data-composer-input-layout="single-line"] > * {
        height: auto !important; }
      :root[data-codex-window-type="extension"] [data-composer-body] [class*="ComposerLayoutFooter_"][data-composer-layout="single-line"] > [class*="AdaptiveFooterInput_"] {
        grid-column: 1 / -1; min-width: 0; }
      :root[data-codex-window-type="extension"] [data-composer-body] div:has(> .scm-toolkit-codex-clipboard-button) {
        gap: 4px !important; }
      button[data-composer-navigation-target="run-location"]:not(.scm-toolkit-inline-location) {
        visibility: hidden !important;
      }
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
            const parent = location.offsetParent;
            if (!parent) return;
            const origin = parent.getBoundingClientRect();
            const target = access.getBoundingClientRect();
            set(location, 'left', `${target.right - origin.left - parent.clientLeft + parent.scrollLeft + 4}px`);
            set(location, 'top', `${target.top - origin.top - parent.clientTop + parent.scrollTop}px`);
        });
    }
    let pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; scan(); });
    }
    function start() {
        scan();
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
