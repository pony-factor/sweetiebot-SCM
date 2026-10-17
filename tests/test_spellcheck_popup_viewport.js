'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');

const css = fs.readFileSync('assets/workbench/picker.css', 'utf8');

test('spellcheck modal fits and remains usable in very narrow and short workbench windows', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const [width, height] of [[240, 180], [320, 240], [600, 600]]) {
      const page = await browser.newPage({viewport: {width, height}});
      try {
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
          <div class="monaco-workbench">
            <dialog class="scm-toolkit-spellcheck-popup" aria-label="Spellchecks Performed">
              <button class="scm-toolkit-spellcheck-close">Close</button>
              <div class="scm-toolkit-spellcheck-status" role="status"></div>
              <div class="scm-toolkit-spellcheck-content">
                <h1>Spellchecks Performed</h1>
                <section class="file"><h2>notes.md</h2>
                  <div class="diff-line add"><span class="line-number">1</span><span class="line-number">1</span>
                    <span class="sign">+</span><span class="scm-toolkit-spellcheck-line-actions"></span><span class="line-text">A spelling suggestion</span></div>
                </section>
              </div>
              <label class="scm-toolkit-spellcheck-message-label">Commit message
                <textarea class="scm-toolkit-spellcheck-message" rows="4">Spellcheck notes</textarea>
              </label>
              <footer class="scm-toolkit-spellcheck-actions">
                <button class="scm-toolkit-spellcheck-revert">Revert</button>
                <button class="scm-toolkit-spellcheck-accept">Accept</button>
              </footer>
            </dialog>
          </div></body></html>`);
        await page.evaluate(() => document.querySelector('dialog').showModal());
        const bounds = await page.locator('dialog').boundingBox();
        assert(bounds && bounds.width > 0 && bounds.height > 0, `dialog visible at ${width}x${height}`);
        assert(bounds.x >= -1 && bounds.y >= -1, `dialog starts inside ${width}x${height}`);
        assert(bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1,
          `dialog fits ${width}x${height}`);
        for (const label of ['Close', 'Revert', 'Accept']) {
          const button = page.getByRole('button', {name: label});
          await button.scrollIntoViewIfNeeded();
          const rect = await button.boundingBox();
          assert(rect && rect.y >= -1 && rect.y + rect.height <= height + 1,
            `${label} remains reachable at ${width}x${height}`);
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
