// A clipboard-to-prompt action beside Codex's native Send control.
// Submission is delegated to Codex so active runs use its queued-follow-up flow.
(() => {
    'use strict';
    if (globalThis.scmToolkitCodexClipboardSubmit) return;
    globalThis.scmToolkitCodexClipboardSubmit = true;

    const BUTTON_ID = 'scm-toolkit-codex-clipboard-submit';
    const EDITOR_SELECTOR = 'textarea:not([disabled]), [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder], .ProseMirror[contenteditable="true"], [data-testid*="composer" i] [contenteditable="true"]';
    const CONTROL_SELECTOR = 'button[data-composer-navigation-target="permissions"], button[data-composer-navigation-target="run-location"]';
    let scheduled = false;
    let busy = false;

    function label(button) {
        return [button.getAttribute('aria-label'), button.getAttribute('title'),
            button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ').trim();
    }

    function visible(element) {
        return Boolean(element && element.isConnected && element.getClientRects().length);
    }

    function classify(button) {
        if (!button || button.id === BUTTON_ID || !visible(button)
            || button.disabled || button.getAttribute('aria-disabled') === 'true') return '';
        const name = label(button);
        if (/\b(stop|cancel|interrupt|pause|voice|dictat|microphone|retry)\b/i.test(name)) return '';
        if (/\bqueue\b/i.test(name) && !/\b(remove|delete|edit|reorder)\b/i.test(name)) return 'queue';
        if (/\b(send|submit)\b/i.test(name) && !/\bsettings?\b/i.test(name)) return 'send';
        if (button.type === 'submit') return 'send';
        return '';
    }

    function chooseAction(buttons, active) {
        const eligible = buttons.filter(button => classify(button));
        return (active && eligible.find(button => classify(button) === 'queue'))
            || eligible.find(button => classify(button) === 'send') || null;
    }

    function isRunning(root) {
        return [...root.querySelectorAll('button')].some(button =>
            visible(button) && /\b(stop(?:\s+(?:response|generating|task))?|interrupt|cancel\s+run)\b/i.test(label(button)))
            || Boolean(root.querySelector('[data-state="streaming"], [data-state="generating"], [data-state="running"]'));
    }

    function findSurface() {
        // Prefer the composer-specific controls over chat history buttons.
        const anchors = [...document.querySelectorAll(CONTROL_SELECTOR)];
        const editors = [...document.querySelectorAll(EDITOR_SELECTOR)];
        for (const anchor of [...anchors, ...editors]) {
            let root = anchor.parentElement;
            for (let depth = 0; root && root !== document.body && depth < 10; depth++, root = root.parentElement) {
                const editor = [...root.querySelectorAll(EDITOR_SELECTOR)].find(visible);
                if (!editor) continue;
                const submit = chooseAction([...root.querySelectorAll('button')], isRunning(root));
                if (submit) return { root, editor, submit };
            }
        }
        return null;
    }

    function readText(editor) {
        return 'value' in editor ? editor.value : (editor.innerText ?? editor.textContent ?? '');
    }

    function setText(editor, text) {
        if ('value' in editor) {
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value');
            if (descriptor?.set) descriptor.set.call(editor, text);
            else editor.value = text;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            return readText(editor) === text;
        }
        editor.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand('insertText', false, text)) return false;
        return readText(editor).replace(/\r\n/g, '\n').trim() === text.replace(/\r\n/g, '\n').trim();
    }

    function message(button, description) {
        button.title = description;
        button.setAttribute('aria-label', description);
    }

    function hasRichContext(editor) {
        // Do not discard selected files, mentions, quotes, or other editor nodes.
        return Boolean(editor.querySelector?.(
            '[contenteditable="false"], [data-attachment], [data-mention], img, figure, blockquote'
        ));
    }

    async function sendClipboard(button) {
        if (busy) return;
        busy = true;
        button.disabled = true;
        try {
            const clipboard = await navigator.clipboard.readText();
            if (!clipboard.trim()) {
                message(button, 'Clipboard is empty');
                return;
            }
            const surface = findSurface();
            if (!surface || !surface.editor.isConnected || hasRichContext(surface.editor)) {
                message(button, 'Could not send clipboard; existing rich draft was preserved');
                return;
            }
            const { editor, root } = surface;
            const draft = readText(editor);
            if (!setText(editor, clipboard)) {
                if (editor.isConnected && readText(editor) === clipboard) setText(editor, draft);
                message(button, 'Could not insert clipboard text into Codex');
                return;
            }

            // Let React/ProseMirror consume input and enable the native button.
            await new Promise(resolve => setTimeout(resolve, 80));
            const current = findSurface();
            if (!current || current.editor !== editor || !root.isConnected
                || readText(editor).trim() !== clipboard.trim()) {
                message(button, 'Composer changed; clipboard text was not submitted');
                return;
            }
            const active = isRunning(current.root);
            const action = chooseAction([...current.root.querySelectorAll('button')], active);
            if (!action || action.disabled) {
                message(button, 'Codex is not ready; clipboard text left in composer');
                return;
            }
            // With a run active, Codex's normal follow-up Send queues the turn
            // when chatgpt.followUpQueueMode=queue (the native default). Prefer
            // an explicit Queue action when the extension exposes one.
            action.click();
            await new Promise(resolve => setTimeout(resolve, 200));
            if (draft && editor.isConnected && !readText(editor).trim()) {
                setText(editor, draft);
            }
            message(button, active ? 'Queue clipboard prompt' : 'Send clipboard prompt');
        } catch (error) {
            message(button, 'Clipboard unavailable; allow access and try again');
        } finally {
            busy = false;
            button.disabled = false;
            schedule();
        }
    }

    function createButton() {
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'scm-toolkit-codex-clipboard-button';
        message(button, 'Send clipboard prompt (queue while Codex works)');
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 12h6m-3-3 3 3-3 3"/></svg>';
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => void sendClipboard(button));
        return button;
    }

    function mount() {
        scheduled = false;
        const surface = findSurface();
        const existing = document.getElementById(BUTTON_ID);
        if (!surface?.submit?.parentElement) {
            if (existing) existing.remove();
            return;
        }
        const button = existing || createButton();
        if (button.parentElement !== surface.submit.parentElement
            || button.nextElementSibling !== surface.submit) {
            surface.submit.before(button);
        }
        button.disabled = busy;
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(mount);
    }

    // Pure helpers are exposed only to the local Node test harness.
    if (globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__) {
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.classify = classify;
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.chooseAction = chooseAction;
        return;
    }

    const style = document.createElement('style');
    style.textContent = '#'+BUTTON_ID+'{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;border:0;border-radius:7px;margin:0 4px 0 0;padding:4px;background:transparent;color:inherit;cursor:pointer}#'+BUTTON_ID+':hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent)}#'+BUTTON_ID+':focus-visible{outline:2px solid currentColor;outline-offset:2px}#'+BUTTON_ID+':disabled{opacity:.5;cursor:wait}#'+BUTTON_ID+' svg{width:18px;height:18px}';
    document.head.append(style);
    new MutationObserver(schedule).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'aria-label', 'data-state'],
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
    else schedule();
})();
