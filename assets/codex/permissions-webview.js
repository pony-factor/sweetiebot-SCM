function scmToolkitRegisterCodexPermissionsMenu(api) {
    const style = document.createElement('style');
    style.textContent = ':root[data-sweetiebot-hide-permissions] button[data-composer-navigation-target="permissions"]{opacity:0!important;position:absolute!important;width:1px!important;min-width:0!important;padding:0!important;pointer-events:none!important}';
    document.head.append(style);
    window.addEventListener('message', event => {
        if (event.data?.type === 'sweetiebot-permissions-visibility') {
            document.documentElement.toggleAttribute('data-sweetiebot-hide-permissions', event.data.hidden === true);
        } else if (event.data?.type === 'sweetiebot-open-permissions') {
            const button = [...document.querySelectorAll('button[data-composer-navigation-target="permissions"]')]
                .find(element => element.getClientRects().length);
            const reply = opened => api.postMessage({type: 'sweetiebot-permissions-opened', id: event.data.id, opened: !!opened});
            if (!button) {reply(false); return;}
            window.focus?.();
            button.focus?.({preventScroll: true});
            button.click();
            requestAnimationFrame(() => {
                if (!document.querySelector('[role="menu"], [role="dialog"][data-state="open"]')) {
                    button.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
                }
                requestAnimationFrame(() => reply(button.getAttribute('aria-expanded') === 'true'
                    || button.getAttribute('data-state') === 'open' || document.querySelector('[role="menu"], [role="dialog"][data-state="open"]')));
            });
        }
    });
    api.postMessage({type: 'sweetiebot-permissions-ready'});
}
