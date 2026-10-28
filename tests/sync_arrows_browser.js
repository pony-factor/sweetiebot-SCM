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
        `<span class="${label}"><span>2</span><span class="codicon codicon-arrow-down"></span>` +
        '<span>3</span><span class="codicon codicon-arrow-up"></span></span>').join('')}
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
    const gaps = await page.locator('.codicon-arrow-down').evaluateAll(arrows => arrows.map(arrow =>
      arrow.nextElementSibling.getBoundingClientRect().left - arrow.previousElementSibling.getBoundingClientRect().right));
    assert.ok(gaps.every(gap => gap >= 3), 'Hiding the incoming arrow preserves a visible gap before the outgoing caption');
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
    // Reproduce Git's long caption/count span, compact count spans, and
    // contiguous tokens, rather than adding fixture-only whitespace.
    await page.goto('about:blank');
    await page.setContent('<div class="scm-view"><div class="scm-editor"></div>' +
      '<div class="button-container"><a class="monaco-button">' +
      '<span class="monaco-button-label"><span class="codicon codicon-sync"></span>' +
      '<span> Sync Changes 4</span><span class="codicon codicon-arrow-down"></span>' +
      '<span>2</span><span class="codicon codicon-arrow-up"></span></span>' +
      '<span class="monaco-button-label-short"><span class="codicon codicon-sync"></span>' +
      '<span>4</span><span class="codicon codicon-arrow-down"></span>' +
      '<span>2</span><span class="codicon codicon-arrow-up"></span></span></a></div></div>');
    await page.addStyleTag({ content: nativeCSS + '\n' + css });
    await page.addScriptTag({ content: helper });
    await page.evaluate(() => {
      window.values = { incomingSyncLabel: 'Flip', outgoingSyncLabel: 'Gust',
        hideIncomingSyncArrow: true, hideOutgoingSyncArrow: true,
        hideIncomingSyncCount: true, hideOutgoingSyncCount: true };
      scmToolkitCustomizeSyncLabels({ element: document.querySelector('.scm-editor'),
        disposables: { add() {} } }, {
        getValue: key => values[key.split('.').pop()],
        onDidChangeConfiguration(listener) { window.changed = listener; return { dispose() {} }; }
      }, {});
    });
    async function visibleText(label) {
      return page.locator(`.${label}`).evaluate(node => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll('[hidden], .codicon').forEach(child => child.remove());
        return copy.textContent.replace(/\s+/g, ' ').trim();
      });
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.equal(await visibleText('monaco-button-label'), 'Flip & Gust');
      assert.equal(await visibleText('monaco-button-label-short'), 'Flip & Gust');
      assert.deepEqual(await displays('down'), ['none', 'none']);
      assert.deepEqual(await displays('up'), ['none', 'none']);
      assert.deepEqual(await page.locator('.monaco-button-label-short > span[hidden]').evaluateAll(nodes =>
        nodes.map(node => getComputedStyle(node).display)), ['none', 'none', 'none', 'none']);
      await set('hideIncomingSyncCount', false);
      assert.equal(await visibleText('monaco-button-label'), 'Flip 4Gust');
      // The CSS gap separates adjacent native tokens even without text whitespace.
      assert.ok(await page.locator('.monaco-button-label .codicon-arrow-down').evaluate(arrow =>
        arrow.nextElementSibling.getBoundingClientRect().left - arrow.previousElementSibling.getBoundingClientRect().right >= 3));
      await set('hideOutgoingSyncCount', false);
      assert.match(await visibleText('monaco-button-label'), /Gust 2$/);
      await set('hideIncomingSyncArrow', false);
      await set('hideOutgoingSyncArrow', false);
      assert.deepEqual(await displays('down'), ['inline-block', 'inline-block']);
      assert.deepEqual(await displays('up'), ['inline-block', 'inline-block']);
      await set('hideIncomingSyncCount', true);
      await set('hideOutgoingSyncCount', true);
      await set('hideIncomingSyncArrow', true);
      await set('hideOutgoingSyncArrow', true);
    }
    await set('incomingSyncLabel', 'Fetch 80');
    await set('outgoingSyncLabel', 'Send 20');
    assert.equal(await visibleText('monaco-button-label'), 'Fetch 80 & Send 20');
    await set('hideIncomingSyncCount', false);
    assert.match(await visibleText('monaco-button-label'), /^Fetch 80 4/);
    await set('hideIncomingSyncCount', true);
    await page.evaluate(() => {
      document.querySelector('.monaco-button-label .codicon-sync').nextElementSibling.textContent = ' Sync Changes 9';
    });
    await page.waitForFunction(() => document.querySelector('.monaco-button-label').textContent.includes('Fetch 80 & Send 20'));
    await set('hideIncomingSyncCount', false);
    assert.match(await visibleText('monaco-button-label'), /^Fetch 80 9/);
    await set('hideIncomingSyncCount', true);
    console.log('Sync arrow rendered visibility checks passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
