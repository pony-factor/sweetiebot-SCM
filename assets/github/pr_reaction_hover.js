/* Enrich reaction tooltips in the GitHub Pull Requests overview. */
(() => {
  'use strict';
  if (window.__sweetiebotReactionHoverInstalled) return;
  window.__sweetiebotReactionHoverInstalled = true;
  const cache = new Map();
  const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i;
  const css = document.createElement('style');
  css.textContent = '.sweetiebot-reaction-popover{position:fixed;z-index:2147483647;'
    + 'max-width:min(330px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;'
    + 'box-sizing:border-box;width:max-content;padding:10px 12px;border-radius:8px;'
    + 'color:var(--vscode-editorHoverWidget-foreground,var(--vscode-editor-foreground));'
    + 'background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));'
    + 'border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));'
    + 'box-shadow:0 3px 12px #0004;pointer-events:none;font-size:12px;line-height:1.4}'
    + '.sweetiebot-reactor{display:flex;align-items:center;gap:8px;margin-top:6px}'
    + '.sweetiebot-reactor img{width:26px;height:26px;flex-shrink:0;border-radius:50%}'
    + '.sweetiebot-reactor-name{font-weight:600}'
    + '.sweetiebot-reactor-login{opacity:.75;margin-left:4px}'
    + '.sweetiebot-more{opacity:.75;padding-top:6px}';
  (document.head || document.documentElement).appendChild(css);

  function parseNativeTitle(title) {
    const match = /^(.*?) reacted with (.+)$/u.exec(title || '');
    if (!match || !match[1]) return null;
    let actors = match[1];
    let more = 0;
    const overflow = /^(.*?) and (\d+) more$/u.exec(actors);
    if (overflow) {
      actors = overflow[1];
      more = Number(overflow[2]);
    }
    const logins = actors.split(/, | and /u).filter(Boolean);
    if (!logins.length || !logins.every(login => loginPattern.test(login))) return null;
    return { logins, more, emoji: match[2] };
  }

  function profileFor(login) {
    if (!cache.has(login)) {
      cache.set(login, fetch('https://api.github.com/users/' + encodeURIComponent(login))
        .then(response => response.ok ? response.json() : null)
        .catch(() => null));
    }
    return cache.get(login);
  }

  let active = null;
  let tooltip = null;
  let generation = 0;
  function hide() {
    generation++;
    if (tooltip) tooltip.remove();
    tooltip = null;
    active = null;
  }
  function position(target) {
    if (!tooltip) return;
    const r = target.getBoundingClientRect();
    const height = tooltip.offsetHeight;
    const width = tooltip.offsetWidth;
    const top = r.bottom + height + 6 < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - height - 6);
    tooltip.style.top = top + 'px';
    tooltip.style.left = Math.max(8, Math.min(r.left, innerWidth - width - 8)) + 'px';
  }
  function rowFor(login) {
    const row = document.createElement('div');
    row.className = 'sweetiebot-reactor';
    const avatar = document.createElement('img');
    avatar.alt = '';
    avatar.referrerPolicy = 'no-referrer';
    avatar.src = 'https://avatars.githubusercontent.com/' + encodeURIComponent(login) + '?size=52';
    const identity = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'sweetiebot-reactor-name';
    name.textContent = login;
    const username = document.createElement('span');
    username.className = 'sweetiebot-reactor-login';
    username.textContent = '@' + login;
    identity.append(name, username);
    row.append(avatar, identity);
    return { row, avatar, name, login };
  }
  function show(target) {
    if (active === target) return;
    close();
    const original = target.getAttribute('title');
    const info = parseNativeTitle(original);
    if (!info) return;
    active = target;
    const token = ++generation;
    tooltip = document.createElement('div');
    tooltip.className = 'sweetiebot-reaction-popover';
    tooltip.setAttribute('role', 'tooltip');
    const heading = document.createElement('div');
    heading.textContent = 'Reacted with ' + info.emoji;
    tooltip.appendChild(heading);
    const rows = info.logins.map(rowFor);
    for (const entry of rows) tooltip.appendChild(entry.row);
    if (info.more) {
      const extra = document.createElement('div');
      extra.className = 'sweetiebot-more';
      extra.textContent = 'and ' + info.more + ' more';
      tooltip.appendChild(extra);
    }
    document.body.appendChild(tooltip);
    position(target);
    target.dataset.sweetiebotOriginalTitle = original;
    target.removeAttribute('title');
    for (const entry of rows) {
      void profileFor(entry.login).then(profile => {
        if (token !== generation || active !== target || !profile) return;
        if (typeof profile.name === 'string' && profile.name.trim()) entry.name.textContent = profile.name.trim();
        if (typeof profile.avatar_url === 'string') {
          try {
            const url = new URL(profile.avatar_url);
            if (url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com') {
              entry.avatar.src = url.href;
            }
          } catch (_) { /* keep the public avatar fallback */ }
        }
        position(target);
      });
    }
  }
  function close() {
    if (!active) return;
    if (active.hasAttribute('data-sweetiebot-original-title')) {
      active.setAttribute('title', active.dataset.sweetiebotOriginalTitle);
      delete active.dataset.sweetiebotOriginalTitle;
    }
    hide();
  }
  document.addEventListener('mouseover', event => {
    const target = event.target.closest?.('.comment-reactions > div');
    if (target === active) return;
    close();
    if (target?.hasAttribute('title')) show(target);
  }, true);
  document.addEventListener('mouseout', event => {
    if (active && active.contains(event.target) && !active.contains(event.relatedTarget)) close();
  }, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
})();
