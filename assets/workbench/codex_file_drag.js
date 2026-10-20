// VS Code blocks iframe input when a drag crosses its editor/workbench. Keep
// Codex reachable for file drops, including returning from the main editor.
(() => {
    const style = document.createElement('style');
    style.id = 'scm-toolkit-codex-file-drag';
    style.textContent = 'iframe[src*="extensionId=openai.chatgpt&"]{pointer-events:auto!important}';
    document.head.appendChild(style);
    style.disabled = true;
    const reset = () => { style.disabled = true; };
    const update = event => {
        const transfer = event.dataTransfer;
        style.disabled = !(transfer && (Array.from(transfer.types || []).includes('Files')
            || transfer.files?.length
            || Array.from(transfer.items || []).some(item => item.kind === 'file')));
    };
    window.addEventListener('dragenter', update, true);
    window.addEventListener('dragover', update, true);
    window.addEventListener('dragleave', event => {
        // Entering the child iframe also produces a host leave. Only reset on
        // leaving the window, so the iframe remains reachable across that edge.
        if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0
            || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) reset();
    }, true);
    for (const type of ['drop', 'dragend', 'blur', 'mousedown', 'mousemove']) {
        window.addEventListener(type, reset, true);
    }
})();
