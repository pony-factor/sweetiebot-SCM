/* Submit only the exact prompt launched by Sweetiebot's PR button. */
(() => {
  if (window.top !== window) return;
  const launch = new URL(window.location.href);
  const prompt = launch.searchParams.get('q');
  if (launch.origin !== 'https://chatgpt.com' || !(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname))
      || launch.searchParams.get('sweetiebot_pr') !== '1' || !prompt) return;

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
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('click', onClick, true);
  };
  const onInput = event => { if (event.isTrusted) stop(); };
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
      history.replaceState(history.state, '', clean.href);
      button.click();
      return;
    }
    timer = setTimeout(attempt, 250);
  };
  attempt();
})();
