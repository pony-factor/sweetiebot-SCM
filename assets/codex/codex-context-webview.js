// Read-only snapshot requests; never submit, steer, focus, or stop a Codex turn.
function scmToolkitRegisterCodexSnapshot(api) {
    window.addEventListener('message', event => {
        const request = event.data;
        if (request?.type !== 'scm-toolkit-context-request' || typeof request.id !== 'string') return;
        const transcripts = [...document.querySelectorAll('[data-thread-user-message-navigation-content]')];
        const transcript = transcripts.find(element => element.getClientRects().length > 0)
            ?? (transcripts.length === 1 ? transcripts[0] : undefined);
        const text = String(transcript?.innerText ?? '').trim().slice(-6000);
        api.postMessage({ type: 'scm-toolkit-context-response', id: request.id, text });
    });
}
