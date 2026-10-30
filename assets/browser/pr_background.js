/* Keep Kefania PR and bulk merge workflows running in background windows. */
(contents => {
  const original = contents.getBackgroundThrottling();
  let callbackOrigin;
  let active = false;
  let mergeCallback;
  // This handler belongs to one WebContents and is never exposed to page JS.
  contents.ipc?.handle('sweetiebot:merge-prompt', async event => {
    if (event.senderFrame !== contents.mainFrame || !mergeCallback
        || new URL(event.senderFrame.url).origin !== 'https://chatgpt.com') throw Error('Invalid merge prompt sender.');
    const address = mergeCallback;
    const response = await fetch(address + '/prompt', { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Merge prompt transport failed.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 100000) throw Error('Merge prompt exceeds transport limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    if (mergeCallback !== address) throw Error('Merge workflow changed during prompt read.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  });
  const update = (event, address, inPlace, mainFrame) => {
    address = event.url ?? address;
    mainFrame = event.isMainFrame ?? mainFrame;
    if (!mainFrame) return;
    let url;
    try { url = new URL(address); } catch { return; }
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && url.port && !url.username && !url.password
      && /^(?:\/kefania-draft\/[0-9a-f-]{36}(?:\/(?:draft|pony))?|\/lindsey-merge\/[0-9a-f-]{36})$/.test(url.pathname);
    if (url.origin === 'https://chatgpt.com') {
      const payload = new URLSearchParams(url.hash.slice(1));
      if (payload.get('sweetiebot_merge') === '1') {
        active = true;
        mergeCallback = undefined;
        try {
          const candidate = new URL(payload.get('return_to'));
          if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1'
              && candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash
              && /^\/lindsey-merge\/[0-9a-f-]{36}$/.test(candidate.pathname)) mergeCallback = candidate.href;
        } catch { /* No prompt capability for malformed launches. */ }
      }
      if (payload.get('sweetiebot_pr') === '1') {
        try {
          const callback = new URL(payload.get('return_to'));
          if (callback.protocol === 'http:' && callback.hostname === '127.0.0.1'
              && callback.port && !callback.username && !callback.password
              && !callback.search && !callback.hash
              && /^\/kefania-draft\/[0-9a-f-]{36}\/(?:draft|pony)$/.test(callback.pathname)) {
            callbackOrigin = callback.origin;
            active = true;
          }
        } catch { /* Ordinary ChatGPT tabs retain their default behavior. */ }
      }
    } else if (local && (!callbackOrigin || callbackOrigin === url.origin)) {
      active = true;
    } else {
      active = false;
      mergeCallback = undefined;
      callbackOrigin = undefined;
    }
    contents.setBackgroundThrottling(active ? false : original);
  };
  contents.on('did-start-navigation', update);
})(this._view.webContents);
