/* Keep Kefania PR and bulk merge workflows running in background windows. */
(contents => {
  const original = contents.getBackgroundThrottling();
  let callbackOrigin;
  let active = false;
  const update = (event, address, inPlace, mainFrame) => {
    address = event.url ?? address;
    mainFrame = event.isMainFrame ?? mainFrame;
    if (!mainFrame) return;
    let url;
    try { url = new URL(address); } catch { return; }
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && url.port && !url.username && !url.password
      && /^\/kefania-draft\/[0-9a-f-]{36}(?:\/(?:draft|pony))?$/.test(url.pathname);
    if (url.origin === 'https://chatgpt.com') {
      const payload = new URLSearchParams(url.hash.slice(1));
      if (payload.get('sweetiebot_merge') === '1') active = true;
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
      callbackOrigin = undefined;
    }
    contents.setBackgroundThrottling(active ? false : original);
  };
  contents.on('did-start-navigation', update);
})(this._view.webContents);
