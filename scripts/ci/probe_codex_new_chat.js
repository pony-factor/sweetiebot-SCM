#!/usr/bin/env node
"use strict";
// Inspects the official Codex webview, not a mocked SVG.
// Saves only relevant geometry, accessible control labels, and CSS colors.
const fs = require("fs");
const { chromium } = require("playwright");
const result = { selector: ':root[data-codex-window-type=extension] svg circle.fill-text-info[cx="15.75"][cy="4"][r="3.25"]', frames: [] };
const css = fs.readFileSync(process.env.CODEX_PROBE_CSS, "utf8");
let browser;
const deadline = Date.now() + 90000;

async function inspect(frame) {
  return frame.evaluate(({ css, selector }) => {
    const label = (circle) => {
      const button = circle.closest('button,[role="button"],a');
      return [button?.getAttribute("aria-label"), button?.getAttribute("title"),
        button?.getAttribute("data-testid")].filter(Boolean).filter(s => s.length < 80);
    };
    const exact = [...document.querySelectorAll(selector)];
    const candidates = [...document.querySelectorAll("svg circle")].filter(
      c => c.matches('circle.fill-text-info[cx="15.75"][cy="4"][r="3.25"]') ||
        label(c).some(v => /new[\s-]*chat/i.test(v)));
    const before = candidates.map(c => getComputedStyle(c).fill);
    const style = document.createElement("style");
    style.textContent = css; document.head.appendChild(style);
    const after = candidates.map(c => getComputedStyle(c).fill);
    style.remove();
    return {
      windowType: document.documentElement.getAttribute("data-codex-window-type"),
      exactMatches: exact.length,
      circles: candidates.slice(0, 10).map((c, i) => ({
        className: c.getAttribute("class"), cx: c.getAttribute("cx"),
        cy: c.getAttribute("cy"), r: c.getAttribute("r"),
        labels: label(c), exact: c.matches(selector),
        before: before[i], after: after[i]
      }))
    };
  }, { css, selector: result.selector });
}
(async () => {
  while (Date.now() < deadline) {
    try {
      if (!browser) browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 5000 });
      const frames = browser.contexts().flatMap(c => c.pages().flatMap(p => p.frames()));
      result.frames = [];
      for (const frame of frames) {
        try {
          const d = await inspect(frame);
          if (d.circles.length || d.exactMatches || d.windowType) result.frames.push(d);
        } catch {}
      }
      if (result.frames.some(f => f.circles.length)) break;
    } catch (err) { result.connectError = String(err).slice(0, 150); }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const exact = result.frames.flatMap(f => f.circles).filter(c => c.exact);
  result.verified = exact.length === 1 && exact[0].after === "rgb(18, 171, 52)" &&
    exact[0].before !== exact[0].after;
  fs.writeFileSync(process.env.CODEX_PROBE_REPORT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ verified: result.verified, matched: exact.length, frames: result.frames.length }));
  if (!result.verified) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close().catch(() => {}); });
