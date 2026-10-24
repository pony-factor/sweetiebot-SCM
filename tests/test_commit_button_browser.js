'use strict';

// Browser integration test: NODE_PATH=<Playwright modules> node tests/test_commit_button_browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const helper = source.slice(0, source.indexOf('function scmToolkitHideOutgoingSyncCount('));
const css = name => fs.readFileSync(path.join(__dirname, '../assets/workbench', name), 'utf8');

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.CODEX_TEST_CHROMIUM || undefined
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function setup(patched) {
      // setContent replaces markup but not the page's global lexical declarations.
      // Navigate first so each scenario can safely inject a fresh helper script.
      await page.goto('about:blank');
      await page.setContent('<div class="scm-view"><div class="button-container" id="actions" style="margin:40px"></div></div>');
      await page.addScriptTag({ content: helper });
      await page.evaluate(patched => {
        window.calls = [];
        window.executions = [];
        window.widget = {
          container: document.getElementById('actions'),
          setButton(command) {
            const descriptor = command && ('enabled' in command ? command : { enabled: command.disabled !== true,
              command: { id: 'git.commit', title: command.title, ...command.command },
              secondaryCommands: command.secondaryCommands });
            if (patched && scmToolkitDeferActionButtonUpdate(this, descriptor)) return;
            this.container.replaceChildren();
            if (!command) return;
            const button = document.createElement('button');
            button.className = 'monaco-button';
            button.textContent = descriptor.command.title;
            button.disabled = descriptor.enabled === false;
            button.classList.toggle('disabled', button.disabled);
            button.onclick = patched ? () => scmToolkitRunActionButton(this) : () => calls.push(descriptor.command.title);
            this.container.append(button);
          },
          executeCommand(id, ...args) {
            executions.push({ id, args });
            calls.push(this.scmToolkitPressState.currentButton.command.title);
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

    // A status refresh before keyboard activation used to discard focus. This
    // happens outside pointerdown, so the old pointer-only guard did not help.
    await page.locator('button').focus();
    await page.evaluate(() => widget.setButton({ title: 'Commit' }));
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => calls), []);

    await setup(true);
    await page.locator('button').focus();
    await page.evaluate(() => {
      window.originalButton = document.querySelector('button');
      for (let i = 0; i < 30; i++) widget.setButton({ title: 'Commit' });
    });
    assert.equal(await page.evaluate(() => document.activeElement === originalButton), true);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => calls), ['Commit']);
    await page.waitForFunction(() => !widget.scmToolkitPressState.pressed);

    // Space activates on keyup: real command changes must also wait until the
    // current gesture finishes, then expose the latest command exactly once.
    await page.keyboard.down('Space');
    await page.evaluate(() => widget.setButton({ title: 'After keyboard refresh' }));
    assert.equal(await page.locator('button').textContent(), 'Commit');
    await page.keyboard.up('Space');
    await page.waitForFunction(() => document.querySelector('button').textContent === 'After keyboard refresh');
    assert.deepEqual(await page.evaluate(() => calls), ['Commit', 'Commit']);

    // Even when Git replaces proxy command handles, keep the DOM and dispatch
    // the latest primary/menu commands. Presentation changes still rebuild it.
    await page.evaluate(() => {
      const command = handle => ({ title: 'Commit', command: {
        id: 'git.commit', arguments: [{ $mid: 3, handle }, null]
      } });
      widget.setButton(command(1));
      const original = document.querySelector('button');
      widget.setButton(command(1));
      window.keptEquivalent = original === document.querySelector('button');
      widget.setButton(command(2));
      window.keptNewCommand = original === document.querySelector('button');
      document.querySelector('button').click();
    });
    assert.equal(await page.evaluate(() => keptEquivalent && keptNewCommand), true);
    assert.deepEqual(await page.evaluate(() => executions.at(-1)), {
      id: 'git.commit', args: [{ $mid: 3, handle: 2 }, null]
    });
    await page.evaluate(() => {
      const action = handle => ({ title: 'Commit', secondaryCommands: [[{
        id: 'proxy.' + handle, title: 'Commit staged', arguments: [handle]
      }]] });
      widget.setButton(action(1));
      const original = document.querySelector('button');
      widget.setButton(action(2));
      window.keptMenu = original === document.querySelector('button');
      scmToolkitRunActionButton(widget, 0, 0);
      widget.setButton({ title: 'Commit', disabled: true });
      window.replacedDisabled = original !== document.querySelector('button');
    });
    assert.equal(await page.evaluate(() => keptMenu && replacedDisabled), true);
    assert.deepEqual(await page.evaluate(() => executions.at(-1)), { id: 'proxy.2', args: [2] });

    await setup(true);
    await page.evaluate(() => widget.setButton({ title: 'Commit', command: { id: 'proxy.old' } }));
    await press();
    await page.evaluate(() => widget.setButton({ title: 'Commit', command: { id: 'proxy.latest' } }));
    await page.mouse.up();
    await page.waitForFunction(() => !widget.scmToolkitPressState.pressed);
    assert.deepEqual(await page.evaluate(() => executions), [{ id: 'proxy.latest', args: [] }]);
    await page.locator('button').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => executions.length), 2, 'Two activations must each dispatch exactly once');

    // Both button styles acknowledge the press before any command completes.
    await setup(true);
    const theme = `:root {
      --vscode-button-background: rgb(20, 40, 60);
      --vscode-button-hoverBackground: rgb(80, 110, 140);
      --vscode-focusBorder: rgb(180, 90, 220);
      --vscode-widget-border: rgb(60, 60, 60);
      --vscode-foreground: white;
    } .monaco-button { background: var(--vscode-button-background); }`;
    await page.addStyleTag({content: theme + css('picker.css')});
    await press();
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(180, 90, 220)');
    await page.mouse.up();
    await page.evaluate(() => { window.firstPulse = document.querySelector('button').getAnimations()[0]; });
    await page.locator('button').click();
    assert.equal(await page.evaluate(() => Boolean(firstPulse)
      && firstPulse !== document.querySelector('button').getAnimations()[0]
      && firstPulse.playState === 'idle'), true, 'A second quick click restarts filled-button feedback');
    assert.equal(await page.evaluate(() => executions.length), 2);
    await page.waitForFunction(() => !document.getElementById('actions').classList.contains('scm-toolkit-action-pressed'));
    await page.addStyleTag({content: css('outlined_buttons.css')});
    await page.evaluate(() => {
      const dropdown = document.createElement('div');
      dropdown.className = 'monaco-button-dropdown';
      dropdown.append(document.querySelector('button'));
      dropdown.insertAdjacentHTML('beforeend', '<a class="monaco-button monaco-dropdown-button">Menu</a><a class="scm-toolkit-settings">Settings</a>');
      document.getElementById('actions').append(dropdown);
    });
    await press();
    assert.equal(await page.locator('.monaco-button-dropdown').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(180, 90, 220)');
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.scm-toolkit-settings').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.mouse.up();
    await page.evaluate(() => { window.firstPulse = document.querySelector('.monaco-button-dropdown').getAnimations()[0]; });
    await page.locator('button').click();
    assert.equal(await page.evaluate(() => Boolean(firstPulse)
      && firstPulse !== document.querySelector('.monaco-button-dropdown').getAnimations()[0]
      && firstPulse.playState === 'idle'), true, 'A second quick click restarts outline feedback');
    await page.waitForFunction(() => !document.getElementById('actions').classList.contains('scm-toolkit-action-pressed'));
    await page.locator('.monaco-dropdown-button').click();
    assert.equal(await page.locator('#actions').evaluate(node => node.classList.contains('scm-toolkit-action-pressed')), false);

    // The theme accent must appear on the physical press even with no helper
    // running yet; command latency cannot delay this native :active response.
    await setup(false);
    await page.addStyleTag({content: theme + css('picker.css')});
    await press();
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(180, 90, 220)');
    await page.mouse.up();
    await page.addStyleTag({content: css('outlined_buttons.css')});
    await press();
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(180, 90, 220)');
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.mouse.up();

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
    await page.waitForFunction(() => !document.getElementById('actions').classList.contains('scm-toolkit-action-pressed'));
    await press();
    await page.mouse.up();
    assert.equal(await page.evaluate(() => calls.length), 22);
    assert.equal(await page.locator('#actions').evaluate(node => node.classList.contains('scm-toolkit-action-pressed')), false);

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
