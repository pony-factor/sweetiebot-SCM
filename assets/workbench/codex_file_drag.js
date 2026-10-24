// Hot-swappable workbench component: nothing is installed before activate().
globalThis.__sweetiebotWorkbenchComponents?.register('codex-file-drag', ({ document: doc, window: win }) => {
    const style = doc.createElement('style');
    style.textContent = 'iframe[src*="extensionId=openai.chatgpt&"]{pointer-events:auto!important}';
    style.disabled = true;
    doc.head.appendChild(style);
    const reset = () => { style.disabled = true; };
    const update = event => {
        const transfer = event.dataTransfer;
        style.disabled = !(transfer && (Array.from(transfer.types || []).includes('Files')
            || transfer.files?.length
            || Array.from(transfer.items || []).some(item => item.kind === 'file')));
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
