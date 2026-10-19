'use strict';

// NODE_PATH=<Playwright modules> node tests/test_sync_arrows_browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const helper = source.slice(source.indexOf('function scmToolkitCustomizeSyncLabels('),
  source.indexOf('\nfunction scmToolkitCustomizeCommitButtonLabel('));
const css = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.css'), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CODEX_TEST_CHROMIUM || undefined });
  try {
    const page = await browser.newPage();
    // Native codicon rules override the browser's default [hidden] rule.
    const nativeCSS = process.env.CODEX_TEST_WORKBENCH_CSS
      ? fs.readFileSync(process.env.CODEX_TEST_WORKBENCH_CSS, 'utf8')
      : '.codicon[class*=codicon-]{display:inline-block}';
    await page.setContent(`<div class="scm-view"><div class="scm-editor"></div>
      <div class="button-container"><a class="monaco-button">
      <span class="codicon codicon-sync"></span>
      ${['monaco-button-label', 'monaco-button-label-short'].map(label =>
        `<span class="${label}"><span>2</span><span class="codicon codicon-arrow-down"></span>
        <span>3</span><span class="codicon codicon-arrow-up"></span></span>`).join('')}
      </a></div></div>`);
    await page.addStyleTag({ content: nativeCSS + '\n' + css });
    await page.addScriptTag({ content: helper });
    await page.evaluate(() => {
      window.values = { incomingSyncLabel: 'Flip', outgoingSyncLabel: 'Gust' };
      const configuration = {
        getValue: key => values[key.split('.').pop()],
        onDidChangeConfiguration(listener) { window.changed = listener; return { dispose() {} }; }
      };
      scmToolkitCustomizeSyncLabels({ element: document.querySelector('.scm-editor'),
        disposables: { add() {} } }, configuration, { hideOutgoingSyncCount: false });
    });
    async function set(name, value) {
      await page.evaluate(([name, value]) => {
        values[name] = value;
        changed({ affectsConfiguration: key => key === `scmToolkit.${name}` });
      }, [name, value]);
    }
    async function displays(direction) {
      return page.locator(`.codicon-arrow-${direction}`).evaluateAll(nodes =>
        nodes.map(node => getComputedStyle(node).display));
    }
    assert.deepEqual(await displays('down'), ['inline-block', 'inline-block']);
    assert.deepEqual(await displays('up'), ['inline-block', 'inline-block']);
    await set('hideIncomingSyncArrow', true);
    assert.deepEqual(await displays('down'), ['none', 'none']);
    assert.deepEqual(await displays('up'), ['inline-block', 'inline-block']);
    await set('hideOutgoingSyncArrow', true);
    assert.deepEqual(await displays('up'), ['none', 'none']);
    assert.deepEqual(await displays('down'), ['none', 'none']);
    await page.evaluate(() => document.querySelector('.codicon-arrow-down').previousElementSibling.textContent = '4');
    await page.waitForTimeout(50);
    assert.deepEqual(await displays('down'), ['none', 'none']);
    assert.match(await page.locator('.monaco-button-label').textContent(), /Flip\s*4/);
    assert.match(await page.locator('.monaco-button-label').textContent(), /Gust\s*3/);
    await set('hideIncomingSyncArrow', false);
    assert.deepEqual(await displays('down'), ['inline-block', 'inline-block']);
    assert.deepEqual(await displays('up'), ['none', 'none']);
    await set('hideOutgoingSyncArrow', false);
    assert.deepEqual(await displays('up'), ['inline-block', 'inline-block']);
    console.log('Sync arrow rendered visibility checks passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
