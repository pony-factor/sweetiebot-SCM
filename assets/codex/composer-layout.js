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
  const hidden = new Set((layout.hidden || []).filter(id => id !== "input" && id !== "access"));
  const style = document.createElement("style");
  style.textContent = [
    ".scm-toolkit-layout-concealed{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important;opacity:0!important;pointer-events:none!important;}",
    ".scm-toolkit-custom-layout-controlled>.scm-toolkit-layout-aligned{margin-inline-start:0!important;}",
    ".scm-toolkit-custom-layout-controlled>.scm-toolkit-layout-right-start{margin-inline-start:auto!important;}"
  ].join("\n");
  document.head.append(style);

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

  function scan() {
    if (document.documentElement.getAttribute("data-codex-window-type") !== "extension") return;
    const found = locate();
    if (!found) return;
    const { footer, controls } = found;
    // Custom layouts own access visibility; an older hide-icon preference must
    // not suppress Codex's native permissions chooser.
    if (!document.documentElement.hasAttribute("data-sweetiebot-composer-access-visible"))
      document.documentElement.setAttribute("data-sweetiebot-composer-access-visible", "");
    const left = layout.left || (layout.visible || []).filter(id => id !== "send");
    const right = layout.right || (layout.visible || []).filter(id => id === "send");
    const ordered = [...left, ...right];
    const firstRight = right.find(id => {
      const target = slot(controls[id], footer);
      return target?.parentElement === footer;
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
      if (target.style.order !== String(index)) target.style.order = String(index);
      if (id === "input" && target.style.flexBasis !== "100%") target.style.flexBasis = "100%";
      if (target.parentElement === footer) {
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
