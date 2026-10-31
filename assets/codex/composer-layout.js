// Reorder and temporarily hide native Codex composer controls without moving React nodes.
// Hidden controls remain available from More controls; native event handlers and access prompts stay owned by Codex.
(() => {
  "use strict";
  if (globalThis.scmToolkitCodexComposerLayout) return;
  globalThis.scmToolkitCodexComposerLayout = true;
  const layout = __SCM_TOOLKIT_COMPOSER_LAYOUT__;
  const names = {
    input: "Message input", attachments: "Attachments",
    access: "Access permissions", location: "Computer / location / usage",
    clipboard: "Clipboard Send / Queue", send: "Send / Stop"
  };
  const hidden = new Set(layout.hidden);
  const revealed = new Set();
  const style = document.createElement("style");
  style.textContent = [
    ".scm-toolkit-layout-concealed{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important;opacity:0!important;pointer-events:none!important;}",
    ".scm-toolkit-composer-more{position:relative;order:9999;flex:0 0 auto;align-self:center;}",
    ".scm-toolkit-composer-more>button{border:1px solid var(--vscode-input-border,#646464);border-radius:6px;background:transparent;color:inherit;padding:4px 8px;cursor:pointer;}",
    ".scm-toolkit-composer-more-menu{position:absolute;right:0;bottom:calc(100% + 5px);z-index:99;min-width:200px;max-width:min(85vw,300px);padding:5px;background:var(--vscode-menu-background,var(--vscode-editor-background,#222));border:1px solid var(--vscode-menu-border,#646464);border-radius:8px;box-shadow:0 6px 24px #0006;}",
    ".scm-toolkit-composer-more-menu[hidden]{display:none!important;}",
    ".scm-toolkit-composer-more-menu button{display:block;width:100%;text-align:left;padding:7px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;}",
    ".scm-toolkit-composer-more-menu button:hover,.scm-toolkit-composer-more-menu button:focus{background:var(--vscode-list-hoverBackground,#444);}",
    ".scm-toolkit-composer-more-menu button:disabled{opacity:.5;cursor:default;}"
  ].join("\n");
  document.head.append(style);
  const roots = new WeakMap();

  function label(button) {
    return [button?.getAttribute?.("aria-label"), button?.getAttribute?.("title"),
      button?.getAttribute?.("data-testid"), button?.textContent].filter(Boolean).join(" ");
  }

  function locate() {
    const anchor = document.querySelector('button[data-composer-navigation-target="permissions"]');
    const footer = anchor?.closest('[class*="ComposerLayoutFooter_"]')
      || document.querySelector(".scm-toolkit-composer-footer")
      || document.querySelector('[class*="ComposerLayoutFooter_"]');
    if (!footer || !footer.isConnected) return null;
    const composer = footer.closest("[data-composer-body]") || footer.parentElement;
    if (!composer) return null;
    const buttons = [...composer.querySelectorAll("button")];
    const find = predicate => buttons.find(predicate);
    const input = footer.querySelector('[class*="AdaptiveFooterInput_"]')
      || composer.querySelector('[class*="AdaptiveFooterInput_"]');
    return {
      footer,
      controls: {
        input,
        attachments: find(b => b.getAttribute("data-composer-navigation-target") === "attachments"
          || /^(add (context|files?|attachment)|attach files?)/i.test(label(b))),
        access: find(b => b.getAttribute("data-composer-navigation-target") === "permissions"),
        location: find(b => b.getAttribute("data-composer-navigation-target") === "run-location"),
        clipboard: find(b => b.id === "scm-toolkit-codex-clipboard-submit"),
        send: find(b => b.matches("button.bg-composer-primary")
          && /\b(send|stop|interrupt|submit|cancel run)\b/i.test(label(b))
          && !/\b(queue|settings|dictation)\b/i.test(label(b)))
      }
    };
  }

  function slot(node, footer) {
    if (!node) return null;
    let candidate = node;
    while (candidate.parentElement && candidate.parentElement !== footer
      && footer.contains(candidate.parentElement)) candidate = candidate.parentElement;
    // An action group must not be concealed or moved as a unit.
    if (candidate !== node && candidate.querySelectorAll("button").length > 1) return node;
    return candidate;
  }

  function mountMenu(footer) {
    let menuRoot = roots.get(footer);
    if (menuRoot && menuRoot.isConnected) return menuRoot;
    menuRoot = document.createElement("div");
    menuRoot.className = "scm-toolkit-composer-more";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "⋯";
    trigger.title = "More composer controls";
    trigger.setAttribute("aria-label", "More composer controls");
    trigger.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "scm-toolkit-composer-more-menu";
    menu.hidden = true;
    trigger.addEventListener("click", event => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      trigger.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", event => {
      if (!menuRoot.isConnected || menuRoot.contains(event.target)) return;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    });
    menuRoot.append(trigger, menu);
    footer.append(menuRoot);
    roots.set(footer, menuRoot);
    return menuRoot;
  }

  function scan() {
    if (document.documentElement.getAttribute("data-codex-window-type") !== "extension") return;
    const found = locate();
    if (!found) return;
    const { footer, controls } = found;
    const reserved = new Set();
    // The input is never concealed. Reordering follows native flex/grid order;
    // mixed-purpose wrapper groups remain in their native position.
    layout.visible.forEach((id, index) => {
      const node = controls[id];
      if (!node) return;
      const target = slot(node, footer);
      if (!target || reserved.has(target)) return;
      reserved.add(target);
      if (target.style.order !== String(index)) target.style.order = String(index);
      if (id === "input" && target.style.flexBasis !== "100%") target.style.flexBasis = "100%";
    });
    for (const id of Object.keys(names)) {
      const node = controls[id];
      if (!node) continue;
      const target = slot(node, footer);
      const shouldHide = id !== "input" && hidden.has(id) && !revealed.has(id);
      if (target.classList.contains("scm-toolkit-layout-concealed") !== shouldHide) {
        target.classList.toggle("scm-toolkit-layout-concealed", shouldHide);
      }
    }
    if (!hidden.size) return;
    const more = mountMenu(footer);
    const menu = more.querySelector(".scm-toolkit-composer-more-menu");
    const missing = [...hidden].filter(id => !revealed.has(id));
    // Rebuild only when options change to avoid a mutation-observer loop.
    const signature = missing.map(id => id + ":" + Boolean(controls[id])).join(",");
    if (menu.dataset.signature === signature) return;
    menu.dataset.signature = signature;
    menu.replaceChildren();
    for (const id of missing) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Show " + names[id];
      button.disabled = !controls[id];
      button.addEventListener("click", () => {
        revealed.add(id);
        menu.hidden = true;
        more.querySelector("button").setAttribute("aria-expanded", "false");
        // Reveal the original anchor first, so any native popover can position correctly.
        scan();
        controls[id]?.focus?.();
        controls[id]?.click?.();
      });
      menu.append(button);
    }
    more.hidden = missing.length === 0;
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      try { scan(); } catch (error) {
        console.warn("Sweetiebot Codex composer layout unavailable", error);
      }
    });
  }
  if (globalThis.__SCM_TOOLKIT_COMPOSER_LAYOUT_TEST__) {
    Object.assign(globalThis.__SCM_TOOLKIT_COMPOSER_LAYOUT_TEST__, {locate, slot, scan, label});
    return;
  }
  schedule();
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "aria-label", "data-composer-navigation-target", "data-codex-window-type"]
  });
})();
