/* Submit only the exact prompt launched by Sweetiebot's PR or merge action. */
(() => {
  if (window.top !== window) return;
  const launch = new URL(window.location.href);
  const fragment = new URLSearchParams(launch.hash.slice(1));
  const fragmentLaunch = fragment.get('sweetiebot_pr') === '1' || fragment.get('sweetiebot_merge') === '1';
  const payload = fragmentLaunch ? fragment : launch.searchParams;
  const prLaunch = payload.get('sweetiebot_pr') === '1';
  const mergeLaunch = fragmentLaunch && payload.get('sweetiebot_merge') === '1';
  const prompt = payload.get('q');
  if (launch.origin !== 'https://chatgpt.com' || !(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname))
      || prLaunch === mergeLaunch || !prompt) return;
  if (encodeURIComponent(prompt).length > 70000) return;

  let callback;
  try {
    const candidate = new URL(payload.get('return_to'));
    if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1'
        && candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash
        && /^\/kefania-draft\/[0-9a-f-]{36}\/(draft|pony)$/.test(candidate.pathname)) callback = candidate;
  } catch { /* Older manual drafting links do not collect results automatically. */ }
  // Give this action's new tab a blank draft without deleting or replacing the
  // user's shared draft. ChatGPT reads storage in its page world, not preload.
  let composerIsolated = false;
  if (fragmentLaunch && (callback || mergeLaunch)) {
    const isolateComposerDraft = () => {
      const storage = window.localStorage;
      const keys = new Set(['oai/apps/lightweight-web/composerDraft/v1', 'oai/apps/conversationDrafts']);
      const prototype = window.Storage.prototype;
      const get = prototype.getItem, set = prototype.setItem, remove = prototype.removeItem;
      const drafts = new Map();
      prototype.getItem = function(name) { return this === storage && keys.has(String(name)) ? drafts.get(String(name)) ?? null : get.call(this, name); };
      prototype.setItem = function(name, value) { if (this === storage && keys.has(String(name))) drafts.set(String(name), String(value)); else set.call(this, name, value); };
      prototype.removeItem = function(name) { if (this === storage && keys.has(String(name))) drafts.delete(String(name)); else remove.call(this, name); };
      // ChatGPT also reads named Storage properties rather than getItem.
      // Keep those reads and writes in the same tab-local draft map.
      const isolated = new Proxy(storage, {
        get(target, name) {
          if (keys.has(name)) return drafts.get(name);
          const value = Reflect.get(target, name, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, name, value) {
          if (keys.has(name)) { drafts.set(name, String(value)); return true; }
          return Reflect.set(target, name, value, target);
        },
        deleteProperty(target, name) {
          if (keys.has(name)) { drafts.delete(name); return true; }
          return Reflect.deleteProperty(target, name);
        }
      });
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => isolated });
    };
    try { require('electron').contextBridge.executeInMainWorld({ func: isolateComposerDraft }); composerIsolated = true; }
    catch { /* Existing composer guards still prevent overwriting a user draft. */ }
  }
  // Remove transport metadata before ChatGPT hydrates or constructs requests.
  // The complete prompt remains in this isolated preload closure.
  if (fragmentLaunch) {
    const clean = new URL(launch.href); clean.hash = '';
    history.replaceState(history.state, '', clean.href);
  }
  const collectResult = () => {
    if (!callback) return;
    const expires = Date.now() + 1200000;
    let previous, stableSince;
    const collect = () => {
      if (Date.now() > expires || window.location.origin !== launch.origin) return;
      const generating = [...document.querySelectorAll('button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop"]')]
        .some(button => button.getClientRects().length > 0);
      // The nonce-bearing callback validates ownership without depending on
      // ChatGPT's changing message-container markup.
      const links = document.querySelectorAll('a[href]');
      let latest;
      for (const link of links) {
        let url;
        try { url = new URL(link.href); } catch { continue; }
        if (url.origin !== callback.origin || url.pathname !== callback.pathname || url.search
            || url.href.length > 80000) continue;
        const result = new URLSearchParams(url.hash.slice(1));
        const expectedKeys = callback.pathname.endsWith('/pony') ? ['profile'] : ['title', 'body'];
        if ([...result.keys()].some(key => !expectedKeys.includes(key)) || !expectedKeys.every(key => result.get(key)?.trim())) continue;
        latest = url.href;
      }
      // A response can repeat its return link with a revised draft. Stabilize
      // the final candidate once, rather than resetting for every earlier link.
      if (latest !== previous) { previous = latest; stableSince = Date.now(); }
      if (latest && !generating && Date.now() - stableSince >= 2000) { window.location.assign(latest); return; }
      setTimeout(collect, 500);
    };
    collect();
  };
  // Collection also covers a deliberate manual Send; publication is owned by
  // the local receiver and its auto-publish preference.
  collectResult();

  // Collapse only the Sweetiebot launch's sidebar once, including delayed hydration.
  // Use the close control rather than changing ChatGPT's shared preferences.
  const sidebarDeadline = Date.now() + 60000;
  let sidebarTimer;
  let sidebarDone = false;
  const finishSidebar = () => {
    sidebarDone = true;
    clearTimeout(sidebarTimer);
    document.removeEventListener('click', onSidebarClick, true);
  };
  const sidebarLabels = new Set(['hide sidebar', 'close sidebar', 'collapse sidebar',
    'show sidebar', 'open sidebar', 'expand sidebar']);
  const onSidebarClick = event => {
    const button = event.target.closest?.('button');
    if (event.isTrusted && sidebarLabels.has((button?.getAttribute('aria-label') || '').toLowerCase())) {
      finishSidebar();
    }
  };
  const collapseSidebar = () => {
    if (sidebarDone) return;
    if (Date.now() >= sidebarDeadline || window.location.origin !== launch.origin) return finishSidebar();
    const button = document.querySelector(
      'button[aria-label="Hide sidebar"], button[aria-label="Close sidebar"], button[aria-label="Collapse sidebar"]'
    );
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
        && button.getClientRects().length) {
      finishSidebar();
      button.click();
      return;
    }
    sidebarTimer = setTimeout(collapseSidebar, 250);
  };
  document.addEventListener('click', onSidebarClick, true);
  collapseSidebar();

  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const expected = normalize(prompt);
  const samePreparedText = text => text === expected || (inserted && text.replace(/\s/g, '') === expected.replace(/\s/g, ''));
  const deadline = Date.now() + 180000;
  let timer;
  let stopped = false;
  let inserted = false;
  let inserting = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    globalThis.sweetiebotEnsureMaximumThinking?.cancel?.();
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('click', onClick, true);
  };
  const onInput = event => { if (event.isTrusted && !inserting) stop(); };
  const onClick = event => {
    const button = event.target.closest?.('button');
    const label = button?.getAttribute('aria-label') || '';
    if (event.isTrusted && /^(send|send prompt|stop|stop streaming|start voice)$/i.test(label)) stop();
  };
  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onClick, true);
  const attempt = () => {
    if (stopped) return;
    if (Date.now() >= deadline || window.location.pathname !== launch.pathname) return stop();
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"].ProseMirror');
    const text = normalize(composer?.value ?? composer?.innerText ?? composer?.textContent);
    if (composerIsolated && composer && text && !samePreparedText(text) && !inserted && composer.getClientRects().length) {
      // Hydration can read its saved draft before preload isolation runs.
      // This is a newly created workflow tab; the shared draft is preserved.
      composer.focus();
      inserting = true;
      if (composer.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(composer, '');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }
      inserting = false;
      timer = setTimeout(attempt, 250);
      return;
    }
    if (fragmentLaunch && composer && !text && !inserted && composer.getClientRects().length) {
      composer.focus();
      inserting = true;
      if (composer.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(composer, prompt);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        inserted = true;
      } else {
        // Editing through the browser updates ProseMirror's state as well as DOM.
        inserted = document.execCommand('insertText', false, prompt);
      }
      inserting = false;
      timer = setTimeout(attempt, 250);
      return;
    }
    const button = document.querySelector(
      'button#composer-submit-button, button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]'
    );
    const label = button?.getAttribute('aria-label') || '';
    if (composer && samePreparedText(text) && button && !button.disabled
        && button.getAttribute('aria-disabled') !== 'true'
        && button.getClientRects().length && !/stop|voice/i.test(label)
        && button.getAttribute('data-testid') !== 'stop-button') {
      // Do not race Send against model/effort selection or silently submit at
      // Instant when a selector has not hydrated or could not be confirmed.
      if (!globalThis.sweetiebotEnsureMaximumThinking?.()) {
        timer = setTimeout(attempt, 250);
        return;
      }
      stop();
      // Remove the launch payload before sending so a reload cannot send it again.
      const clean = new URL(window.location.href);
      clean.searchParams.delete('q');
      clean.searchParams.delete('sweetiebot_pr');
      clean.searchParams.delete('sweetiebot_merge');
      if (fragmentLaunch) clean.hash = '';
      history.replaceState(history.state, '', clean.href);
      button.click();
      return;
    }
    timer = setTimeout(attempt, 250);
  };
  attempt();
})();
