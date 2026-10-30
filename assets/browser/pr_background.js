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
  // Sandboxed preload code cannot load unrestricted Node core modules.
  // Constrain privileged compression and staging to this validated ChatGPT
  // WebContents and its active nonce-bound merge callback.
  contents.ipc?.handle('sweetiebot:merge-transport', async (event, request) => {
    if (event.senderFrame !== contents.mainFrame || !mergeCallback
        || new URL(event.senderFrame.url).origin !== 'https://chatgpt.com')
      throw Error('Invalid merge transport sender.');
    const callback = mergeCallback;
    const { gzipSync, gunzipSync } = require('node:zlib');
    const { createHash } = require('node:crypto');
    const limit = 64 * 1024 * 1024;
    const validateResult = raw => {
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > limit)
        throw Error('Oversized merge result.');
      const result = JSON.parse(raw);
      if (result?.version !== 1 || typeof result.repository !== 'string' || !Array.isArray(result.results))
        throw Error('Invalid merge result.');
    };
    if (!request || typeof request !== 'object') throw Error('Invalid merge transport request.');
    if (request.action === 'compress') {
      validateResult(request.raw);
      const encoded = gzipSync(Buffer.from(request.raw), { level: 9 }).toString('base64url');
      if (encoded.length > 48 * 1024 * 1024) throw Error('Oversized compressed result.');
      return encoded;
    }
    if (request.action !== 'validate' && request.action !== 'stage') throw Error('Unknown merge transport operation.');
    const data = request.data;
    if (typeof data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data)
        || data.length > 48 * 1024 * 1024) throw Error('Invalid compressed merge result.');
    const compressed = Buffer.from(data, 'base64url');
    if (compressed.toString('base64url') !== data) throw Error('Noncanonical compressed result.');
    validateResult(gunzipSync(compressed, { maxOutputLength: limit }).toString('utf8'));
    if (request.action === 'validate') return true;
    const digest = createHash('sha256').update(compressed).digest('hex');
    if (request.expectedId && request.expectedId !== digest) throw Error('Staged handoff digest mismatch.');
    const body = JSON.stringify({ id: digest, data });
    if (Buffer.byteLength(body) > limit) throw Error('Oversized staged merge result.');
    if (mergeCallback !== callback) throw Error('Merge workflow changed during staging.');
    const response = await fetch(callback + '/stage', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Origin: new URL(callback).origin, 'Content-Type': 'application/json' },
      body
    });
    const responseText = await response.text();
    if (![200, 201].includes(response.status) || responseText.length > 4096
        || JSON.parse(responseText).id !== digest || mergeCallback !== callback)
      throw Error('Local merge staging failed.');
    return digest;
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
