// Flawless-style option: Send click interrupts; Enter retains Codex's native queue.
// Use the native stop callback when Stop and Queue share a single control.
(() => {
    'use strict';
    if (globalThis.scmToolkitCodexInterruptSend) return;
    globalThis.scmToolkitCodexInterruptSend = true;
    const EDITOR = 'textarea:not([disabled]), [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder], .ProseMirror[contenteditable="true"], [data-testid*="composer" i] [contenteditable="true"]';
    const STOP = /\b(stop(?:\s+(?:response|generating|task))?|interrupt|cancel\s+run)\b/i;
    let sending = null;
    const QUEUE_RAIL = '[data-composer-rail], [data-scm-toolkit-queue-id], .scm-toolkit-queue-editor';
    const composerControl = element => Boolean(element && !element.closest?.(QUEUE_RAIL));
    function label(button) {
        return [button?.getAttribute('aria-label'), button?.getAttribute('title'),
            button?.getAttribute('data-testid'), button?.textContent].filter(Boolean).join(' ');
    }
    function visible(element) { return Boolean(element?.isConnected && element.getClientRects().length); }
    function enabled(button) { return visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true'; }
    function isSend(button) {
        if (!composerControl(button) || !enabled(button) || button.id === 'scm-toolkit-codex-clipboard-submit') return false;
        const name = label(button);
        if (/\b(stop|cancel|interrupt|pause|resume|remove|delete|edit|settings?|clipboard|dictat|voice|retry)\b/i.test(name)) return false;
        return /\b(send|submit|queue|steer)\b/i.test(name) || (!name && button.type === 'submit');
    }
    function isImmediateSend(button) {
        if (!isSend(button)) return false;
        // The primary action can remain Queue/Steer while the stopped turn
        // settles. Never replay that action as though it were an idle Send.
        const name = button.getAttribute('aria-label') || button.getAttribute('title') || label(button);
        return !/\b(queue|steer)\b/i.test(name)
            && (/\b(send|submit)\b/i.test(name) || (!name && button.type === 'submit'));
    }
    function readText(editor) {
        const doc = editor?.__scmToolkitComposer?.view?.state?.doc;
        if (doc && typeof doc.textBetween === 'function') return doc.textBetween(0, doc.content.size, '\n');
        return editor && 'value' in editor ? editor.value : (editor?.innerText ?? editor?.textContent ?? '');
    }
    function nativeRun(button) {
        const key = Object.keys(button || {}).find(key => key.startsWith('__reactFiber$'));
        let fiber = key && button[key];
        if (!fiber) return null;
        // DOM nodes can retain the alternate fiber after a React commit.
        let top = fiber;
        while (top.return) top = top.return;
        if (top.stateNode?.current && top.stateNode.current !== top) fiber = fiber.alternate;
        for (let depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
            const props = fiber.memoizedProps;
            if (typeof props?.isResponseInProgress === 'boolean'
                && typeof props.onStop === 'function') return props;
        }
        return null;
    }
    function controls(button) {
        for (let root = button?.parentElement, depth = 0; root && root !== document.body && depth < 12;
            root = root.parentElement, depth++) {
            const editor = [...root.querySelectorAll(EDITOR)].find(candidate => visible(candidate) && composerControl(candidate));
            if (!editor) continue;
            const stop = [...root.querySelectorAll('button')].find(candidate => composerControl(candidate) && enabled(candidate) && STOP.test(label(candidate)));
            if (stop && stop !== button) return {root, editor, stop};
            if ((nativeRun(button) || nativeRun(editor))?.isResponseInProgress) return {root, editor, nativeButton: button};
        }
        return null;
    }
    async function interruptAndSend(surface) {
        if (sending || !surface) return false;
        const {root, editor, stop, nativeButton} = surface;
        const draft = readText(editor);
        const run = nativeButton && (nativeRun(nativeButton) || nativeRun(editor));
        if (!draft.trim() || (nativeButton ? !run?.isResponseInProgress : !enabled(stop))) return false;
        sending = root;
        try {
            if (nativeButton) await run.onStop();
            else stop.click();
            for (let attempt = 0; attempt < 60; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 80));
                // Never send after a window/composer switch or a user draft edit.
                if (!visible(root) || !visible(editor) || readText(editor) !== draft) return false;
                const buttons = [...root.querySelectorAll('button')].filter(composerControl);
                if (nativeButton) {
                    const currentRun = buttons.map(nativeRun).find(Boolean) || nativeRun(editor);
                    if (!currentRun || currentRun.isResponseInProgress) continue;
                }
                if (buttons.some(candidate => enabled(candidate) && STOP.test(label(candidate)))) continue;
                const send = buttons.find(isImmediateSend);
                if (!send) continue;
                send.click();
                return true;
            }
            return false; // Preserve draft when native controls do not settle.
        } catch {
            return false; // Keep the draft if native interruption fails.
        } finally {
            sending = null;
        }
    }
    function onClick(event) {
        // Synthetic clipboard button submissions and Enter cannot interrupt.
        if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || event.detail === 0) return;
        const button = event.target?.closest?.('button');
        if (!button || !isSend(button)) return;
        if (sending) {
            // A second real click during Stop must not leak into native Queue.
            if (sending.contains?.(button) || controls(button)?.root === sending) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            return;
        }
        const surface = controls(button);
        if (!surface || !readText(surface.editor).trim()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void interruptAndSend(surface);
    }
    if (globalThis.__SCM_TOOLKIT_SEND_INTERRUPT_TEST__) {
        Object.assign(globalThis.__SCM_TOOLKIT_SEND_INTERRUPT_TEST__, {isSend, isImmediateSend, nativeRun, controls, interruptAndSend, onClick});
        return;
    }
    document.addEventListener('click', onClick, true);
})();
