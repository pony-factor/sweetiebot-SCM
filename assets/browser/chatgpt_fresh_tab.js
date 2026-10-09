/* Discard only ChatGPT's shared composer draft when Sweetie Bot opens a blank home tab.
 * Keep cookies, login state, conversation history, and unrelated site storage intact. */
(() => {
  if (window.top !== window) return;
  const launch = new URL(window.location.href);
  if (launch.origin !== 'https://chatgpt.com'
      || !(launch.pathname === '/' || /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(launch.pathname))
      || launch.searchParams.get('sweetiebot_fresh') !== '1'
      || launch.searchParams.has('q')) return;

  try {
    // ChatGPT currently shares this unsent text between browser tabs. Clearing
    // it before page hydration keeps a new tab from inheriting the last draft.
    window.localStorage.removeItem('oai/apps/lightweight-web/composerDraft/v1');
  } catch {
    // Storage may be blocked. Do not disrupt navigation or browser sign-in.
    return;
  }

  const clean = new URL(launch.href);
  clean.searchParams.delete('sweetiebot_fresh');
  history.replaceState(history.state, '', clean.href);
})();
