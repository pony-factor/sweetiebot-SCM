'use strict';

// Browser integration test: NODE_PATH=<Playwright modules> node tests/test_commit-button-browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../../assets/workbench/picker.js'), 'utf8');
const helper = source.slice(0, source.indexOf('function scmToolkitHideOutgoingSyncCount('));
const css = name => fs.readFileSync(path.join(__dirname, '../../assets/workbench', name), 'utf8');

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
    await page.addStyleTag({content: css('outlined-buttons.css')});
    await page.evaluate(() => {
      const dropdown = document.createElement('div');
      dropdown.className = 'monaco-button-dropdown';
      dropdown.append(document.querySelector('button'));
      dropdown.insertAdjacentHTML('beforeend', '<a class="monaco-button monaco-dropdown-button">Menu</a><a class="scm-toolkit-settings">Settings</a>');
      document.getElementById('actions').append(dropdown);
    });
    // VS Code outlines the focused tree row in addition to the action border.
    // Keep keyboard focus visible on the action, without an outer row box.
    await page.addStyleTag({content: `
      .monaco-list:focus .monaco-list-row.focused { outline: 1px solid red !important; }
      .monaco-button:focus { outline: 1px solid red; }
    `});
    await page.evaluate(() => {
      const actions = document.getElementById('actions');
      const list = document.createElement('div');
      list.className = 'monaco-list';
      list.tabIndex = 0;
      const row = document.createElement('div');
      row.className = 'monaco-list-row focused';
      actions.replaceWith(list);
      list.append(row);
      row.append(actions);
    });
    await page.locator('.monaco-list').focus();
    assert.equal(await page.locator('.monaco-list-row').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    assert.equal(await page.locator('.monaco-button-dropdown').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(180, 90, 220)');
    await page.locator('button').focus();
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    assert.equal(await page.locator('.monaco-button-dropdown').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(180, 90, 220)');
    await page.locator('.monaco-dropdown-button').evaluate(node => { node.tabIndex = 0; node.focus(); });
    assert.equal(await page.locator('.monaco-dropdown-button').evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'Menu keeps its own keyboard focus indicator');
    await page.evaluate(() => document.querySelector('.scm-view').classList.add('scm-history-view'));
    await page.locator('.monaco-list').focus();
    assert.equal(await page.locator('.monaco-list-row').evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'History focus is unchanged');
    await page.evaluate(() => document.querySelector('.scm-view').classList.remove('scm-history-view'));

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
    await page.addStyleTag({content: css('outlined-buttons.css')});
    await press();
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(180, 90, 220)');
    assert.equal(await page.locator('button').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.mouse.up();

    // A clean repository renders Sync as a single native button. Its wand
    // must share the same inset, outline and border press feedback as Commit.
    await setup(true);
    await page.addStyleTag({content: theme + `
      .scm-view .button-container { display: flex; padding-left: 11px; }
      .scm-view .button-container > .monaco-button-dropdown { display: flex; flex-grow: 1; }
    ` + css('picker.css') + css('outlined-buttons.css')});
    await page.evaluate(() => widget.setButton({ title: 'Flip & Gust' }));
    await page.evaluate(() => {
      const container = document.getElementById('actions');
      container.classList.add('scm-toolkit-commit-settings', 'scm-toolkit-single-action-settings');
      container.style.removeProperty('margin');
      const wand = document.createElement('button');
      wand.className = 'scm-toolkit-settings';
      wand.textContent = '🪄';
      container.append(wand);
      container.insertAdjacentHTML('afterend', `
        <div class="button-container">
          <div class="monaco-button-dropdown">
            <button class="monaco-button">Commit</button>
            <button class="monaco-button monaco-dropdown-button">Menu</button>
            <button class="scm-toolkit-settings">🪄</button>
          </div>
        </div>
      `);
    });
    for (const width of [320, 900]) {
      await page.locator('.scm-view').evaluate((node, width) => { node.style.width = width + 'px'; }, width);
      const action = await page.locator('#actions').boundingBox();
      const commit = await page.locator('.monaco-button-dropdown').boundingBox();
      const main = await page.locator('#actions > .monaco-button').boundingBox();
      const settings = await page.locator('#actions > .scm-toolkit-settings').boundingBox();
      assert.equal(action.x, commit.x, 'Sync has the same leading inset as Commit');
      assert.equal(action.width, commit.width, 'Sync has the same width as Commit');
      assert(Math.abs(settings.x + settings.width - (action.x + action.width - 1)) < 1,
        'Settings stays at the right edge of the action');
      assert(Math.abs(main.x + main.width - settings.x) < 1, 'Settings sits immediately beside Sync');
    }
    assert.equal(await page.locator('#actions').evaluate(node => getComputedStyle(node).borderTopStyle), 'solid');
    assert.equal(await page.locator('#actions > .monaco-button').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await page.locator('#actions > .scm-toolkit-settings').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    const singleBox = await page.locator('#actions > .monaco-button').boundingBox();
    await page.mouse.move(singleBox.x + singleBox.width / 2, singleBox.y + singleBox.height / 2);
    await page.mouse.down();
    assert.equal(await page.locator('#actions').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(180, 90, 220)');
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

    // Responsive message bars keep the branch picker beside the editor.
    // A full-width flex basis previously pushed Message onto another row.
    await page.goto('about:blank');
    await page.setContent(`<div class="scm-view">
      <div class="scm-editor scm-toolkit-responsive-message-bar">
        <button class="scm-toolkit-branch"><span class="scm-toolkit-branch-label">main</span><span>⌄</span></button>
        <div class="scm-editor-container">Message</div>
      </div>
    </div>`);
    await page.addStyleTag({content: theme + css('picker.css') + css('outlined-buttons.css')});
    for (const width of [1080, 640, 320]) {
      await page.locator('.scm-editor').evaluate((node, width) => { node.style.width = width + 'px'; }, width);
      for (const name of ['main', 'feature/a-very-long-branch-name-that-must-stay-truncated']) {
        await page.locator('.scm-toolkit-branch-label').evaluate((node, name) => { node.textContent = name; }, name);
        const branch = await page.locator('.scm-toolkit-branch').boundingBox();
        const editor = await page.locator('.scm-editor-container').boundingBox();
        assert(branch.width > 0 && branch.width <= width * 0.28 + 1,
          `Branch picker stays compact at ${width}px (${name})`);
        assert(Math.abs(branch.y + branch.height / 2 - editor.y - editor.height / 2) < 1,
          `Branch picker and Message share a row at ${width}px (${name})`);
        assert(editor.x >= branch.x + branch.width - 1 && editor.width >= 128,
          'Message retains usable space beside the branch picker');
      }
    }
    // Custom SCM icons resolve the user's icon color, not secondary text or link colors.
    await page.goto('about:blank');
    const iconControls = [
      'home', 'delete-branch', 'autocomplete', 'spellcheck', 'post-spellcheck',
      'codex-coauthor', 'pull-request', 'sync-branch', 'pony-branch',
      'stacked-branch', 'auto-publish', 'auto-commit'
    ];
    await page.setContent(`<div class="scm-view"><div class="scm-editor">
      ${iconControls.map(name => `<button class="scm-toolkit-${name}"></button>`).join('')}
      <label class="scm-toolkit-push"><input type="checkbox" class="scm-toolkit-push-checkbox" checked><span class="scm-toolkit-push-mark"></span></label>
      </div><div class="monaco-action-bar"><div class="action-item"><a class="action-label codicon" style="display:inline-block;width:24px;height:24px;color:var(--vscode-icon-foreground)">x</a></div></div></div>`);
    await page.addStyleTag({content: `:root {
      --vscode-icon-foreground: rgb(20, 180, 40);
      --vscode-foreground: rgb(225, 225, 225);
      --vscode-descriptionForeground: rgb(100, 100, 100);
      --vscode-textLink-foreground: rgb(50, 100, 220);
      --vscode-disabledForeground: rgb(90, 80, 70);
      --vscode-editorWarning-foreground: rgb(220, 140, 40);
      --vscode-checkbox-border: rgb(25, 50, 75);
      --vscode-checkbox-foreground: rgb(75, 50, 25);
    }` + css('picker.css')});
    const controlColor = name => page.locator('.scm-toolkit-' + name).evaluate(node => getComputedStyle(node).color);
    for (const name of iconControls) {
      assert.equal(await controlColor(name), 'rgb(20, 180, 40)', name);
    }
    const clock = page.locator('.scm-toolkit-auto-commit');
    await clock.evaluate(node => node.setAttribute('aria-pressed', 'false'));
    assert.equal(await controlColor('auto-commit'), await controlColor('home'));
    assert.equal(await clock.evaluate(node => getComputedStyle(node, '::after').content), 'none');
    await clock.evaluate(node => {
      node.setAttribute('aria-pressed', 'true');
      node.classList.add('scm-toolkit-auto-commit-active');
    });
    assert.equal(await clock.evaluate(node => getComputedStyle(node, '::after').content), '"✓"');
    assert.equal(await controlColor('auto-commit'), 'rgb(50, 100, 220)');
    await page.locator('.scm-toolkit-post-spellcheck').evaluate(node => node.classList.add('scm-toolkit-post-spellcheck-active'));
    assert.equal(await controlColor('post-spellcheck'), 'rgb(50, 100, 220)');
    await page.locator('.scm-toolkit-pull-request').evaluate(node => node.classList.add('scm-toolkit-pr-needs-attention'));
    assert.equal(await controlColor('pull-request'), 'rgb(220, 140, 40)');
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-icon-foreground', 'rgb(170, 30, 80)'));
    assert.equal(await controlColor('home'), 'rgb(170, 30, 80)', 'Live theme changes propagate');
    for (const name of iconControls) {
      await page.locator('.scm-toolkit-' + name).evaluate(node => { node.disabled = true; });
      assert.equal(await controlColor(name), 'rgb(90, 80, 70)', name + ' disabled');
    }
    const mark = page.locator('.scm-toolkit-push-mark');
    assert.equal(await mark.evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(25, 50, 75)');
    assert.equal(await mark.evaluate(node => getComputedStyle(node, '::after').borderRightColor), 'rgb(75, 50, 25)');
    await page.locator('.scm-toolkit-push-checkbox').evaluate(node => { node.disabled = true; });
    assert.equal(await mark.evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(90, 80, 70)');
    const nativeIcon = page.locator('.action-label.codicon');
    await nativeIcon.hover();
    assert.equal(await nativeIcon.evaluate(node => getComputedStyle(node).color), 'rgb(255, 255, 255)', 'Intentional white hover stays intact');

    assert.deepEqual(errors, []);
    console.log('Commit button browser tests passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
