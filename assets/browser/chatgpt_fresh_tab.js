/* Keep newly opened ChatGPT home tabs free of drafts restored after hydration.
 * This is deliberately scoped to Sweetiebot-marked blank launches. */
(() => {
  if (window.top !== window) return;
  const launch = new URL(window.location.href);
  if (launch.origin !== 'https://chatgpt.com'
      || !(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname))
      || launch.searchParams.get('sweetiebot_fresh') !== '1'
      || launch.searchParams.has('q')) return;

  const draftKey = 'oai/apps/lightweight-web/composerDraft/v1';
  try {
    window.localStorage.removeItem(draftKey);
  } catch {
    // A blocked storage API must not break navigation.
  }

  // ChatGPT can restore the saved draft asynchronously, after its composer mounts.
  // Never clear anything once the user starts editing this tab.
  let userEdited = false;
  let stopped = false;
  let observer;
  let timer;
  const onUserEdit = event => {
    if (event.isTrusted) stop();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    clearTimeout(timer);
    document.removeEventListener('beforeinput', onUserEdit, true);
    document.removeEventListener('input', onUserEdit, true);
    document.removeEventListener('keydown', onUserEdit, true);
    document.removeEventListener('paste', onUserEdit, true);
  };
  const clearComposer = () => {
    if (stopped || userEdited) return;
    if (window.location.origin !== launch.origin
        || (window.location.pathname !== launch.pathname && window.location.pathname !== launch.pathname.replace(/\/$/, ''))) {
      stop();
      return;
    }
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"].ProseMirror');
    if (!composer) return;
    if (composer.tagName === 'TEXTAREA') {
      if (composer.value) {
        const setter = (window.HTMLTextAreaElement && Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set);
        if (setter) setter.call(composer, '');
        else composer.value = '';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (composer.textContent?.trim()) {
      // Let ProseMirror handle an actual document edit instead of only altering DOM.
      composer.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
  };
  document.addEventListener('beforeinput', onUserEdit, true);
  document.addEventListener('input', onUserEdit, true);
  document.addEventListener('keydown', onUserEdit, true);
  document.addEventListener('paste', onUserEdit, true);
  // Mutation observation catches late hydration; a bounded window avoids
  // continuing to interfere with ordinary conversation navigation.
  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    observer = new MutationObserver(clearComposer);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }
  const started = Date.now();
  const poll = () => {
    clearComposer();
    if (stopped) return;
    if (Date.now() - started >= 8000) return stop();
    timer = setTimeout(poll, 200);
  };
  poll();

  const clean = new URL(launch.href);
  clean.searchParams.delete('sweetiebot_fresh');
  history.replaceState(history.state, '', clean.href);
})();
