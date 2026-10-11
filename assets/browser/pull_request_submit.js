/* Submit only the exact prompt launched by Sweetiebot's PR button. */
(() => {
  if (window.top !== window) return;
  const launch = new URL(window.location.href);
  const fragment = new URLSearchParams(launch.hash.slice(1));
  const fragmentLaunch = fragment.get('sweetiebot_pr') === '1';
  const payload = fragmentLaunch ? fragment : launch.searchParams;
  const prompt = payload.get('q');
  if (launch.origin !== 'https://chatgpt.com' || !(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname))
      || payload.get('sweetiebot_pr') !== '1' || !prompt) return;
  if (encodeURIComponent(prompt).length > 70000) return;

  let callback;
  try {
    const candidate = new URL(payload.get('return_to'));
    if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1'
        && candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash
        && /^\/kefania-draft\/[0-9a-f-]{36}\/(draft|pony)$/.test(candidate.pathname)) callback = candidate;
  } catch { /* Older manual drafting links do not collect results automatically. */ }
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
      const generating = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop"]');
      const links = document.querySelectorAll('[data-message-author-role="assistant"] a[href]');
      for (const link of links) {
        let url;
        try { url = new URL(link.href); } catch { continue; }
        if (url.origin !== callback.origin || url.pathname !== callback.pathname || url.search
            || url.href.length > 80000) continue;
        const result = new URLSearchParams(url.hash.slice(1));
        const expectedKeys = callback.pathname.endsWith('/pony') ? ['profile'] : ['title', 'body'];
        if ([...result.keys()].some(key => !expectedKeys.includes(key)) || !expectedKeys.every(key => result.get(key)?.trim())) continue;
        if (url.href !== previous) { previous = url.href; stableSince = Date.now(); }
        if (!generating && Date.now() - stableSince >= 2000) { window.location.assign(url.href); return; }
      }
      setTimeout(collect, 500);
    };
    collect();
  };

  // Collapse only the PR launch's sidebar once, including delayed hydration.
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
  const deadline = Date.now() + 60000;
  let timer;
  let stopped = false;
  let inserted = false;
  let inserting = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('click', onClick, true);
  };
  const onInput = event => { if (event.isTrusted && !inserting) stop(); };
  const onClick = event => {
    if (event.isTrusted && event.target.closest?.('button')) stop();
  };
  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onClick, true);
  const attempt = () => {
    if (stopped) return;
    if (Date.now() >= deadline || window.location.pathname !== launch.pathname) return stop();
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"].ProseMirror');
    const text = normalize(composer?.value ?? composer?.innerText ?? composer?.textContent);
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
    if (composer && text === expected && button && !button.disabled
        && button.getAttribute('aria-disabled') !== 'true'
        && button.getClientRects().length && !/stop|voice/i.test(label)
        && button.getAttribute('data-testid') !== 'stop-button') {
      stop();
      // Remove the launch payload before sending so a reload cannot send it again.
      const clean = new URL(window.location.href);
      clean.searchParams.delete('q');
      clean.searchParams.delete('sweetiebot_pr');
      if (fragmentLaunch) clean.hash = '';
      history.replaceState(history.state, '', clean.href);
      button.click();
      collectResult();
      return;
    }
    timer = setTimeout(attempt, 250);
  };
  attempt();
})();
