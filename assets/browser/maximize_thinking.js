// Adapted from Flawless ChatGPT's force-high-thinking control selection.
// Called only by a marked Sweetiebot workflow, before its automatic Send.
globalThis.sweetiebotEnsureMaximumThinking = (() => {
  const controlsQuery = 'button[aria-haspopup="menu"], button[aria-haspopup="listbox"], [role="button"][aria-haspopup], [role="combobox"], [data-codex-intelligence-trigger]';
  const optionsQuery = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"]';
  const ranks = { instant: 0, lite: 1, light: 1, low: 1, standard: 2, medium: 2,
    thinking: 3, high: 3, extended: 3, heavy: 4, xhigh: 4, 'extra high': 4,
    max: 5, maximum: 5, ultra: 6 };
  const levels = /\b(extra high|maximum|max|extended|standard|instant|medium|thinking|heavy|xhigh|ultra|high|light|lite|low)\b/i;
  const states = new WeakMap();
  let pending;
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => element && !element.disabled
    && element.getAttribute('aria-disabled') !== 'true' && !element.hasAttribute('data-disabled')
    && element.getClientRects().length > 0;
  const label = element => text(element.getAttribute('aria-label'))
    || text((element.getAttribute('aria-labelledby') || '').split(' ')
      .map(id => document.getElementById(id)?.textContent || '').join(' '))
    || text(element.getAttribute('title')) || text(element.textContent);
  const level = element => {
    const selected = text(element.getAttribute('data-selected-reasoning-effort')).toLowerCase();
    if (Object.hasOwn(ranks, selected)) return selected;
    const clone = element.cloneNode?.(true);
    clone?.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
    const content = text(clone?.textContent ?? element.innerText ?? element.textContent);
    const name = label(element);
    const modelSelector = /^(select chatgpt model|select model)$/i.test(name);
    if (!/\b(thinking|reasoning|effort)\b/i.test(name + ' ' + content)
        && !modelSelector
        && !Object.hasOwn(ranks, content.toLowerCase())
        && !Object.hasOwn(ranks, name.toLowerCase())) return '';
    return (content.match(levels) || name.match(levels))?.[1].toLowerCase()
      || (modelSelector ? 'model' : '');
  };
  const key = (element, value) => {
    for (const type of ['keydown', 'keyup']) element.dispatchEvent(new KeyboardEvent(type,
      {key: value, code: value, bubbles: true, cancelable: true}));
  };
  const findMenu = selector => {
    const controlled = document.getElementById(selector.getAttribute('aria-controls'));
    if (visible(controlled)) return controlled;
    const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"]')]
      .filter(menu => visible(menu) && !pending.before.has(menu));
    return menus.length === 1 ? menus[0] : undefined;
  };
  const finish = menu => {
    const {selector, state} = pending;
    state.confirmed = level(selector);
    pending = undefined;
    key(menu || selector, 'Escape');
    if (selector.getAttribute('aria-expanded') === 'true') selector.click();
  };
  const mark = message => {
    let status = document.getElementById('sweetiebot-thinking-status');
    if (!message) { status?.remove(); return; }
    if (!status) {
      const composer = document.querySelector('#prompt-textarea, [data-composer-markdown][contenteditable="true"]');
      if (!composer?.parentElement) return;
      status = document.createElement('div');
      status.id = 'sweetiebot-thinking-status';
      status.setAttribute('role', 'status');
      composer.parentElement.append(status);
    }
    if (status.textContent !== message) status.textContent = message;
  };
  const ensure = () => {
    if (pending && (!pending.selector.isConnected || Date.now() - pending.started > 10000)) {
      pending = undefined;
    }
    if (pending) {
      const {selector, state} = pending;
      const menu = findMenu(selector);
      if (pending.target && level(selector) === pending.target) finish(menu);
      else if (menu) {
        const slider = menu.querySelector('[role="slider"][aria-valuemax][aria-valuenow]');
        if (slider) {
          const maximum = Number(slider.getAttribute('aria-valuemax'));
          const current = Number(slider.getAttribute('aria-valuenow'));
          if (Number.isFinite(maximum) && Number.isFinite(current)) {
            if (current === maximum) finish(menu);
            else if (state.adjustments++ < 32) key(slider.closest('[role="menuitem"]') || slider, 'ArrowRight');
          }
        } else {
          const options = [...menu.querySelectorAll(optionsQuery)].filter(visible)
            .map(option => ({option, value: level(option)}))
            .filter(item => Object.hasOwn(ranks, item.value))
            .sort((a, b) => ranks[b.value] - ranks[a.value]);
          if (options.length) {
            const {option, value} = options[0];
            if (option.getAttribute('aria-checked') === 'true' || option.getAttribute('aria-selected') === 'true') finish(menu);
            else if (state.adjustments++ < 5) { pending.target = value; option.click(); }
          }
        }
      } else if (Date.now() - pending.opened > 500) {
        // Menus often hydrate after the initial keyboard action. Reopen to
        // verify a generic trigger whose visible label omits its selected level.
        selector.click();
        pending.opened = Date.now();
      }
      mark('Selecting maximum thinking before sending…');
      return false;
    }
    const controls = [...document.querySelectorAll(controlsQuery)].filter(visible)
      .filter(control => level(control));
    if (!controls.length) { mark('Waiting for thinking controls before sending…'); return false; }
    for (const selector of controls) {
      let state = states.get(selector);
      if (!state) { state = {attempts: 0, adjustments: 0}; states.set(selector, state); }
      if (state.confirmed === level(selector)) continue;
      if (state.attempts++ >= 5) {
        mark('Maximum thinking could not be confirmed. Check the thinking setting before sending manually.');
        return false;
      }
      state.adjustments = 0;
      pending = {selector, state, started: Date.now(), opened: Date.now(),
        before: new Set(document.querySelectorAll('[role="menu"], [role="listbox"]'))};
      key(selector, 'ArrowDown');
      mark('Selecting maximum thinking before sending…');
      return false;
    }
    mark('');
    return true;
  };
  ensure.cancel = () => {
    if (pending) {
      const menu = findMenu(pending.selector);
      key(menu || pending.selector, 'Escape');
      if (pending.selector.getAttribute('aria-expanded') === 'true') pending.selector.click();
      pending = undefined;
    }
    mark('');
  };
  return ensure;
})();
