// Reorder and temporarily hide native Codex composer controls without moving React nodes.
// Hidden controls are restored in Settings; native event handlers and access prompts stay owned by Codex.
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
  const hidden = new Set((layout.hidden || []).filter(id => id !== "input"));
  const accessSelector = 'button[data-composer-navigation-target="permissions"]';
  const footerSelector = '[data-composer-footer-responsive], [class*="ComposerLayoutFooter_"]';
  const conceal = "position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important;opacity:0!important;pointer-events:none!important;";
  const style = document.createElement("style");
  style.textContent = [
    ".scm-toolkit-custom-layout-controlled{display:flex!important;flex-wrap:wrap;justify-content:flex-start!important;box-sizing:border-box;min-width:0;max-width:100%;}",
    ".scm-toolkit-custom-layout-controlled .scm-toolkit-layout-group{display:contents!important;}",
    ".scm-toolkit-custom-layout-controlled>*,.scm-toolkit-custom-layout-controlled .scm-toolkit-layout-group>*{flex:0 0 auto!important;margin-inline-start:0!important;}",
    ".scm-toolkit-custom-layout-controlled [class*=AdaptiveFooterInput_]{box-sizing:border-box!important;min-width:0!important;max-width:100%!important;flex:1 1 100%!important;margin-inline:0!important;}",
    `.scm-toolkit-layout-concealed{${conceal}}`,
    // Codex can mount access buttons outside the footer or in multiple composer variants.
    hidden.has("access") ? `:root[data-codex-window-type="extension"] ${accessSelector}{${conceal}}` : "",
    ".scm-toolkit-custom-layout-controlled .scm-toolkit-layout-aligned{margin-inline-start:0!important;}",
    ".scm-toolkit-custom-layout-controlled .scm-toolkit-layout-right-start{margin-inline-start:auto!important;}"
  ].join("\n");
  document.head.append(style);

  function label(button) {
    return [button?.getAttribute?.("aria-label"), button?.getAttribute?.("title"),
      button?.getAttribute?.("data-testid"), button?.textContent].filter(Boolean).join(" ");
  }

  function locate() {
    const footer = document.querySelector(`:is(${footerSelector}):has(${accessSelector})`)
      || document.querySelector(".scm-toolkit-composer-footer")
      || document.querySelector(footerSelector);
    if (!footer || !footer.isConnected) return null;
    let composer = footer.closest("[data-composer-body]") || footer.parentElement;
    if (!composer) return null;
    // The utility rail can be a sibling of the input surface.
    while (!composer.querySelector('button[data-composer-navigation-target="run-location"]')
      && composer.parentElement && composer.parentElement !== document.body
      && composer.parentElement.querySelectorAll('[data-composer-body]').length <= 1) {
      composer = composer.parentElement;
    }
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
        access: footer.querySelector(accessSelector) || find(b => b.matches(accessSelector)),
        location: find(b => b.getAttribute("data-composer-navigation-target") === "run-location"),
        clipboard: find(b => b.id === "scm-toolkit-codex-clipboard-submit"),
        send: find(b => footer.contains(b)
          && b.matches("button.bg-composer-primary, button.bg-primary-solid")
          && /\b(send|stop|interrupt|submit|cancel run|queue|steer)\b/i.test(label(b))
          && !/\b(settings|dictation)\b/i.test(label(b)))
      }
    };
  }

  function slot(node, footer) {
    if (!node) return null;
    if (node.scmToolkitLayoutSlot?.parentElement === footer) return node.scmToolkitLayoutSlot;
    let candidate = node;
    while (candidate.parentElement && candidate.parentElement !== footer
      && footer.contains(candidate.parentElement)) candidate = candidate.parentElement;
    // Native action groups can contain both alignment groups. Expose their
    // children to the footer flex layout without moving React-owned nodes.
    if (candidate !== node && candidate.querySelectorAll("button").length > 1) {
      for (let parent = node.parentElement; parent && parent !== footer;
        parent = parent.parentElement) {
        if (!parent.classList.contains("scm-toolkit-layout-group"))
          parent.classList.add("scm-toolkit-layout-group");
      }
      return node;
    }
    return candidate;
  }

  function scan() {
    if (document.documentElement.getAttribute("data-codex-window-type") !== "extension") return;
    const found = locate();
    if (!found) return;
    const { footer, controls } = found;
    const left = layout.left || (layout.visible || []).filter(id => id !== "send");
    const right = layout.right || (layout.visible || []).filter(id => id === "send");
    const ordered = [...left, ...right];
    const firstRight = right.find(id => {
      const target = slot(controls[id], footer);
      return target && footer.contains(target) && !hidden.has(id);
    });
    if (!footer.classList.contains("scm-toolkit-custom-layout-controlled"))
      footer.classList.add("scm-toolkit-custom-layout-controlled");
    const reserved = new Set();
    // Keep React's native nodes in place and use footer flex order for the
    // left/right rail. A single auto margin starts the right-aligned group.
    ordered.forEach((id, index) => {
      const node = controls[id];
      if (!node) return;
      const target = slot(node, footer);
      if (!target || reserved.has(target)) return;
      reserved.add(target);
      const order = id === "input" ? "-1" : String(index);
      if (target.style.order !== order) target.style.order = order;
      if (id === "input" && target.style.flexBasis !== "100%") target.style.flexBasis = "100%";
      if (footer.contains(target)) {
        target.classList.toggle("scm-toolkit-layout-aligned", true);
        target.classList.toggle("scm-toolkit-layout-right-start", id === firstRight);
      }
    });
    for (const id of Object.keys(names)) {
      const node = controls[id];
      if (!node) continue;
      const target = slot(node, footer);
      const shouldHide = hidden.has(id);
      if (target.classList.contains("scm-toolkit-layout-concealed") !== shouldHide) {
        target.classList.toggle("scm-toolkit-layout-concealed", shouldHide);
      }
      if (node.scmToolkitLayoutSlot === target
        && node.classList.contains("scm-toolkit-layout-concealed") !== shouldHide) {
        node.classList.toggle("scm-toolkit-layout-concealed", shouldHide);
      }
    }
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
