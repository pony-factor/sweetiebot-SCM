// Flawless-style option: Send click interrupts; Enter retains Codex's native queue.
// Only the genuine Stop and Send controls are activated; React-owned nodes stay intact.
(() => {
    'use strict';
    if (globalThis.scmToolkitCodexInterruptSend) return;
    globalThis.scmToolkitCodexInterruptSend = true;
    const EDITOR = 'textarea:not([disabled]), [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], [data-testid*="composer" i] [contenteditable="true"]';
    const STOP = /\b(stop(?:\s+(?:response|generating|task))?|interrupt|cancel\s+run)\b/i;
    let sending = false;
    function label(button) {
        return [button?.getAttribute('aria-label'), button?.getAttribute('title'),
            button?.getAttribute('data-testid'), button?.textContent].filter(Boolean).join(' ');
    }
    function visible(element) { return Boolean(element?.isConnected && element.getClientRects().length); }
    function enabled(button) { return visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true'; }
    function isSend(button) {
        if (!enabled(button) || button.id === 'scm-toolkit-codex-clipboard-submit') return false;
        const name = label(button);
        if (/\b(stop|cancel|interrupt|pause|resume|remove|delete|edit|settings?|clipboard|dictat|voice|retry)\b/i.test(name)) return false;
        return /\b(send|submit|queue)\b/i.test(name) || (!name && button.type === 'submit');
    }
    function readText(editor) {
        const doc = editor?.__scmToolkitComposer?.view?.state?.doc;
        if (doc && typeof doc.textBetween === 'function') return doc.textBetween(0, doc.content.size, '\n');
        return editor && 'value' in editor ? editor.value : (editor?.innerText ?? editor?.textContent ?? '');
    }
    function controls(button) {
        for (let root = button?.parentElement, depth = 0; root && root !== document.body && depth < 12;
            root = root.parentElement, depth++) {
            const editor = [...root.querySelectorAll(EDITOR)].find(visible);
            if (!editor) continue;
            const stop = [...root.querySelectorAll('button')].find(candidate => enabled(candidate) && STOP.test(label(candidate)));
            if (stop && stop !== button) return {root, editor, stop};
        }
        return null;
    }
    async function interruptAndSend(surface) {
        if (sending || !surface) return false;
        const {root, editor, stop} = surface;
        const draft = readText(editor);
        if (!draft.trim() || !enabled(stop)) return false;
        sending = true;
        try {
            stop.click();
            for (let attempt = 0; attempt < 60; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 80));
                // Never send after a window/composer switch or a user draft edit.
                if (!visible(root) || !visible(editor) || readText(editor) !== draft) return false;
                const buttons = [...root.querySelectorAll('button')];
                if (buttons.some(candidate => enabled(candidate) && STOP.test(label(candidate)))) continue;
                const send = buttons.find(isSend);
                if (!send) continue;
                send.click();
                return true;
            }
            return false; // Preserve draft when native controls do not settle.
        } finally {
            sending = false;
        }
    }
    function onClick(event) {
        // Synthetic clipboard button submissions and Enter cannot interrupt.
        if (sending || !event.isTrusted || event.defaultPrevented || event.button !== 0) return;
        const button = event.target?.closest?.('button');
        if (!button || !isSend(button)) return;
        const surface = controls(button);
        if (!surface || !readText(surface.editor).trim()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void interruptAndSend(surface);
    }
    if (globalThis.__SCM_TOOLKIT_SEND_INTERRUPT_TEST__) {
        Object.assign(globalThis.__SCM_TOOLKIT_SEND_INTERRUPT_TEST__, {isSend, controls, interruptAndSend, onClick});
        return;
    }
    document.addEventListener('click', onClick, true);
})();
