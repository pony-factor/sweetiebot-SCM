// Transfer focus and DOM selection only during an explicit checkout handoff.
function scmToolkitComposerFocus() {
    const selector = '[data-composer-body] [contenteditable="true"], .ProseMirror[contenteditable="true"]';
    let editing = false, saved;
    const editorFor = node => node?.closest?.(selector);
    const point = (editor, node, offset) => {
        if (!node || !editor.contains(node)) return null;
        const path = [];
        while (node !== editor) {
            const parent = node.parentNode;
            if (!parent) return null;
            path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
            node = parent;
        }
        return { path, offset };
    };
    const snapshot = editor => {
        const selection = window.getSelection();
        const anchor = point(editor, selection?.anchorNode, selection?.anchorOffset);
        const focus = point(editor, selection?.focusNode, selection?.focusOffset);
        return anchor && focus ? { anchor, focus } : {};
    };
    document.addEventListener('focusin', event => {
        const editor = editorFor(event.target);
        editing = Boolean(editor);
        saved = editor ? snapshot(editor) : undefined;
    }, true);
    document.addEventListener('focusout', event => {
        // Clicking the workbench's branch control blurs the entire webview.
        // Preserve the editing intent across that boundary, but not clicks on
        // other controls within Codex.
        if (editorFor(event.target) && event.relatedTarget && !editorFor(event.relatedTarget)) {
            editing = false;
            saved = undefined;
        }
    }, true);
    document.addEventListener('selectionchange', () => {
        const editor = editorFor(document.activeElement);
        if (editor) { editing = true; saved = snapshot(editor); }
    });
    return {
        capture() {
            const editor = editorFor(document.activeElement);
            if (editor) return snapshot(editor);
            return editing ? saved || {} : undefined;
        },
        restore(state, current, expected) {
            return new Promise(resolve => {
                let finished = false;
                const finish = result => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timeout);
                    observer.disconnect();
                    document.removeEventListener('pointerdown', cancel, true);
                    document.removeEventListener('keydown', cancel, true);
                    resolve(result);
                };
                // A fresh user action wins over a delayed handoff restoration.
                const cancel = () => finish(false);
                const resolvePoint = (editor, value) => {
                    if (!Array.isArray(value?.path) || value.path.length > 100 || !Number.isSafeInteger(value.offset)) return null;
                    let node = editor;
                    for (const index of value.path) {
                        if (!Number.isSafeInteger(index) || index < 0) return null;
                        node = node.childNodes?.[index];
                        if (!node) return null;
                    }
                    const limit = node.nodeType === 3 ? node.length : node.childNodes.length;
                    return value.offset >= 0 && value.offset <= limit ? { node, offset: value.offset } : null;
                };
                const attempt = () => {
                    if (finished || current() !== expected) return;
                    const editor = [...document.querySelectorAll(selector)].find(item => item.getClientRects().length);
                    if (!editor) return;
                    // Wait for the restored draft's DOM to contain both saved
                    // endpoints instead of focusing an empty hydration frame.
                    const anchor = state.anchor && resolvePoint(editor, state.anchor);
                    const focus = state.focus && resolvePoint(editor, state.focus);
                    if ((state.anchor || state.focus) && (!anchor || !focus)) return;
                    editor.focus({ preventScroll: true });
                    if (anchor && focus) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
                    finish(true);
                };
                const observer = new MutationObserver(attempt);
                const timeout = setTimeout(() => finish(false), 4000);
                observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                document.addEventListener('pointerdown', cancel, true);
                document.addEventListener('keydown', cancel, true);
                attempt();
            });
        }
    };
}
