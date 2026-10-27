// A clipboard-to-prompt action beside Codex's native Send control.
// Submission is delegated to Codex so active runs use its queued-follow-up flow.
(() => {
    'use strict';
    if (globalThis.scmToolkitCodexClipboardSubmit) return;
    globalThis.scmToolkitCodexClipboardSubmit = true;

    const BUTTON_ID = 'scm-toolkit-codex-clipboard-submit';
    const EDITOR_SELECTOR = 'textarea:not([disabled]), [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder], .ProseMirror[contenteditable="true"], [data-testid*="composer" i] [contenteditable="true"]';
    const CONTROL_SELECTOR = 'button[data-composer-navigation-target="permissions"], button[data-composer-navigation-target="run-location"]';
    const RUNNING_CONTROL = /\b(stop(?:\s+(?:response|generating|task))?|interrupt|cancel\s+run)\b/i;
    let scheduled = false;
    let enabled = true;
    let busy = false;
    const NATIVE_CLIPBOARD_MODULE = null /* scm-toolkit-native-clipboard */;

    async function readClipboard(load = path => import(path), module = NATIVE_CLIPBOARD_MODULE) {
        if (module) {
            try {
                const { appServices } = await load(module);
                if (typeof appServices?.clipboard?.readText === 'function') {
                    return await appServices.clipboard.readText();
                }
            } catch {}
            // Use the browser's public clipboard API if the internal facade moved.
        }
        return navigator.clipboard.readText();
    }

    function label(button) {
        return [button.getAttribute('aria-label'), button.getAttribute('title'),
            button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ').trim();
    }

    function visible(element) {
        return Boolean(element && element.isConnected && element.getClientRects().length);
    }

    function classify(button, includeDisabled = false) {
        if (!button || button.id === BUTTON_ID || !visible(button)
            || (!includeDisabled && (button.disabled || button.getAttribute('aria-disabled') === 'true'))) return '';
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

    // Mounting must not depend on an enabled Send button: after a chat starts,
    // Send can be disabled (empty draft) or replaced by Stop during a run.
    function chooseMountTarget(buttons, active) {
        const candidates = buttons.filter(button => button && button.id !== BUTTON_ID && visible(button));
        const kind = button => RUNNING_CONTROL.test(label(button)) ? 'stop' : classify(button, true);
        const find = (target, enabledOnly = false) => candidates.find(button =>
            kind(button) === target && (!enabledOnly
                || (!button.disabled && button.getAttribute('aria-disabled') !== 'true')));
        return (active && find('queue', true)) || find('send', true)
            || (active && find('stop')) || find('send') || find('queue') || find('stop') || null;
    }

    function isRunning(root) {
        return [...root.querySelectorAll('button')].some(button =>
            visible(button) && RUNNING_CONTROL.test(label(button)))
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
                const mountTarget = chooseMountTarget([...root.querySelectorAll('button')], isRunning(root));
                if (mountTarget) return { root, editor, mountTarget };
            }
        }
        return null;
    }

    function readText(editor) {
        const composer = editor.__scmToolkitComposer;
        if (composer) {
            // ProseMirror's current document updates before Codex persists its
            // React draft. Reading the persisted text here can return the old
            // (often empty) prompt even after setPromptText succeeds.
            const doc = composer.view?.state?.doc;
            if (doc && typeof doc.textBetween === 'function') {
                return doc.textBetween(0, doc.content.size, '\n');
            }
            if (typeof composer.getPersistedText === 'function') return composer.getPersistedText();
        }
        return 'value' in editor ? editor.value : (editor.innerText ?? editor.textContent ?? '');
    }

    function setText(editor, text) {
        const composer = editor.__scmToolkitComposer;
        if (composer && typeof composer.setPromptText === 'function') {
            if (!composer.view || composer.view.isDestroyed) return false;
            // Update ProseMirror through Codex's own plain-text import path.
            // Browser editing commands can fail or leave React's draft stale.
            composer.setPromptText(text, { format: 'plain' });
            // Insertion may propagate to the view and persisted state on a
            // later render. Validate the actual draft before clicking Send.
            return true;
        }
        if ('value' in editor) {
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value');
            if (descriptor?.set) descriptor.set.call(editor, text);
            else editor.value = text;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            return readText(editor) === text;
        }
        // A contenteditable DOM write can diverge from Codex's native draft.
        // If its editor API changed, preserve the draft and leave sending manual.
        return false;
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
            const origin = findSurface();
            if (!origin) return;
            const initialText = readText(origin.editor);
            const clipboard = await readClipboard();
            if (!clipboard.trim()) {
                message(button, 'Clipboard is empty');
                return;
            }
            const surface = findSurface();
            if (!surface || surface.editor !== origin.editor || !surface.editor.isConnected
                || readText(surface.editor) !== initialText || hasRichContext(surface.editor)) {
                message(button, 'Could not send clipboard; existing rich draft was preserved');
                return;
            }
            const { editor } = surface;
            const previousText = readText(editor);
            if (!setText(editor, clipboard)) {
                message(button, 'Could not insert clipboard text into Codex');
                return;
            }
            // Codex can serialize rich-looking plain text differently from
            // the clipboard. Accept its resulting draft only if it is new,
            // or if it equals the intended clipboard text exactly.
            const normalized = text => text.replace(/\r\n/g, '\n').trim();
            const insertedText = readText(editor);
            const expectedText = normalized(clipboard);
            const priorText = normalized(previousText);
            const serializedText = normalized(insertedText);
            const matchesInsertion = value => {
                const actual = normalized(value);
                return actual === expectedText
                    || (serializedText !== priorText && actual === serializedText);
            };

            // Wait for Codex's editor state and enabled native Send/Queue
            // control. A plain-text draft is replaced, never restored.
            for (let attempt = 0; attempt < 25; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 80));
                const current = findSurface();
                if (!current || current.editor !== editor || !editor.isConnected) {
                    message(button, 'Composer changed; clipboard text was not submitted');
                    return;
                }
                if (!matchesInsertion(readText(editor))) {
                    // React may not have applied the new text yet. Allow it to
                    // settle and retry insertion once if the old draft remains.
                    if (normalized(readText(editor)) === priorText) {
                        if (attempt === 2 && !hasRichContext(editor)) {
                            setText(editor, clipboard);
                        }
                        continue;
                    }
                    message(button, 'Composer changed; clipboard text was not submitted');
                    return;
                }
                const active = isRunning(current.root);
                const action = chooseAction([...current.root.querySelectorAll('button')], active);
                if (!action) continue;
                // Only click the native Send / Queue action; never click Stop
                // or synthesize Enter, which could change the draft instead.
                action.click();
                message(button, active ? 'Queue clipboard prompt' : 'Send clipboard prompt');
                return;
            }
            message(button, 'Codex is not ready; clipboard text left in composer');
        } catch (error) {
            message(button, 'Could not prepare clipboard prompt; review the draft and send manually');
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
        if (!surface?.mountTarget?.parentElement) {
            if (existing) existing.remove();
            return;
        }
        const button = existing || createButton();
        if (button.parentElement !== surface.mountTarget.parentElement
            || button.nextElementSibling !== surface.mountTarget) {
            surface.mountTarget.before(button);
        }
        button.disabled = busy;
    }

    function schedule() {
        if (scheduled || !enabled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            try { mount(); } catch {
                scheduled = false;
                enabled = false;
                document.getElementById(BUTTON_ID)?.remove();
            }
        });
    }

    // Pure helpers are exposed only to the local Node test harness.
    if (globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__) {
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.classify = classify;
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.chooseAction = chooseAction;
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.chooseMountTarget = chooseMountTarget;
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.findSurface = findSurface;
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.sendClipboard = sendClipboard;
        globalThis.__SCM_TOOLKIT_CLIPBOARD_TEST__.readClipboard = readClipboard;
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
