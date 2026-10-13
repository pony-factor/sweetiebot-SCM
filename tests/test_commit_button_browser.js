'use strict';

// Browser integration test: NODE_PATH=<Playwright modules> node tests/test_commit_button_browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const helper = source.slice(0, source.indexOf('function scmToolkitHideOutgoingSyncCount('));

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.CODEX_TEST_CHROMIUM || undefined
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function setup(patched) {
      await page.setContent('<div id="actions" style="margin:40px"></div>');
      await page.addScriptTag({ content: helper });
      await page.evaluate(patched => {
        window.calls = [];
        window.widget = {
          container: document.getElementById('actions'),
          setButton(command) {
            if (patched && scmToolkitDeferActionButtonUpdate(this, command)) return;
            this.container.replaceChildren();
            if (!command) return;
            const button = document.createElement('button');
            button.className = 'monaco-button';
            button.textContent = command.title;
            button.disabled = command.disabled === true;
            button.onclick = () => calls.push(command.title);
            this.container.append(button);
          }
        };
        widget.setButton({ title: 'Commit' });
      }, patched);
    }
    async function press() {
      const box = await page.locator('button').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
    }
    // Reproduce the dropped click when a provider refresh replaces the node.
    await setup(false);
    await press();
    await page.evaluate(() => widget.setButton({ title: 'Commit' }));
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => calls), []);

    await setup(true);
    for (let i = 0; i < 20; i++) {
      await press();
      await page.evaluate(() => {
        window.pressedButton = document.querySelector('button');
        widget.setButton({ title: 'Intermediate' });
        widget.setButton({ title: 'Commit' });
      });
      assert.equal(await page.evaluate(() => pressedButton === document.querySelector('button')), true);
      await page.mouse.up();
      await page.waitForFunction(() => !widget.scmToolkitPressState.pressed);
    }
    assert.deepEqual(await page.evaluate(() => calls), Array(20).fill('Commit'));

    // Dragging away cancels the click; the queued refresh still completes.
    await press();
    await page.evaluate(() => widget.setButton({ title: 'Latest' }));
    await page.mouse.move(700, 400);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('button').textContent === 'Latest');
    assert.equal(await page.evaluate(() => calls.length), 20);
    await page.locator('button').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => calls.at(-1)), 'Latest');

    // Removal must also wait for release, without triggering a second command.
    await press();
    await page.evaluate(() => widget.setButton(undefined));
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('button'));
    assert.equal(await page.evaluate(() => calls.length), 22);

    await page.evaluate(() => widget.setButton({ title: 'Disabled', disabled: true }));
    await press();
    await page.mouse.up();
    assert.equal(await page.evaluate(() => calls.length), 22);

    await page.evaluate(() => widget.setButton({ title: 'Commit' }));
    await press();
    await page.evaluate(() => {
      widget.setButton({ title: 'Should not render' });
      document.dispatchEvent(new Event('pointercancel'));
      scmToolkitDisposeActionButton(widget);
    });
    await page.mouse.move(700, 400);
    await page.mouse.up();
    assert.equal(await page.locator('button').textContent(), 'Commit');
    assert.equal(await page.evaluate(() => widget.scmToolkitPressState), undefined);
    assert.deepEqual(errors, []);
    console.log('Commit button browser tests passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
