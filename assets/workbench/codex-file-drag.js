// Hot-swappable workbench component: nothing is installed before activate().
globalThis.__sweetiebotWorkbenchComponents?.register('codex-file-drag', ({ document: doc, window: win }) => {
    const style = doc.createElement('style');
    style.textContent = 'iframe[src*="extensionId=openai.chatgpt&"]{pointer-events:auto!important}';
    style.disabled = true;
    doc.head.appendChild(style);
    // Avoid recalculating iframe hit testing and CSS on every dragover/mousemove.
    const reset = () => { if (!style.disabled) style.disabled = true; };
    const update = event => {
        const transfer = event.dataTransfer;
        const types = transfer?.types;
        const fileDrag = !!transfer && !!(
            (typeof types?.contains === 'function'
                ? types.contains('Files') : Array.prototype.includes.call(types || [], 'Files'))
            || transfer.files?.length
            || Array.prototype.some.call(transfer.items || [], item => item.kind === 'file'));
        if (style.disabled === fileDrag) style.disabled = !fileDrag;
    };
    const leave = event => {
        if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0
            || event.clientX >= win.innerWidth || event.clientY >= win.innerHeight)) reset();
    };
    const listeners = [['dragenter', update], ['dragover', update],
        ['dragleave', leave], ...['drop', 'dragend', 'blur', 'mousedown', 'mousemove']
            .map(type => [type, reset])];
    for (const [type, listener] of listeners) win.addEventListener(type, listener, true);
    return {
        dispose() {
            for (const [type, listener] of listeners) win.removeEventListener(type, listener, true);
            style.remove();
        }
    };
});
