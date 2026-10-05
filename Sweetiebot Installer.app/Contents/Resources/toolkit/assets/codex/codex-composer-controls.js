// Keep the native location menu and its React ownership while placing it inline.
(() => {
    if (globalThis.scmToolkitComposerControls) return;
    globalThis.scmToolkitComposerControls = true;
    const style = document.createElement('style');
    style.textContent = `
      .scm-toolkit-inline-location { position: absolute !important; margin: 0 !important; z-index: 2; }
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
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
