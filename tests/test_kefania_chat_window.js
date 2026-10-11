'use strict';

const assert = require('node:assert/strict');
const { openCompactKefaniaChat, resizeMacChatWindow } = require('../efs/kefania_chat_window');

function mockVscode({ float = true, browser = true, moveError = false, openError = false } = {}) {
  const calls = [], warnings = [];
  return {
    calls, warnings,
    commands: {
      async getCommands() {
        return [...(browser ? ['workbench.action.browser.open'] : []),
          ...(float ? ['workbench.action.moveEditorToNewWindow'] : [])];
      },
      async executeCommand(name, options) {
        calls.push({ name, options });
        if (name === 'workbench.action.browser.open' && openError) throw new Error('Cannot open browser');
        if (name === 'workbench.action.moveEditorToNewWindow' && moveError) throw new Error('Move failed');
      }
    },
    window: { async showWarningMessage(message) { warnings.push(message); } }
  };
}

async function run() {
  const url = 'https://chatgpt.com/#sweetiebot_pr=1&q=Test';
  const vscode = mockVscode();
  let resizeCall;
  const floating = await openCompactKefaniaChat(vscode, url, {
    platform: 'darwin',
    exec(file, args, options, done) {
      resizeCall = { file, args, options };
      done(null, '', '');
    }
  });
  assert.deepEqual(floating, { floating: true });
  assert.deepEqual(vscode.calls.map(item => item.name), [
    'workbench.action.browser.open', 'workbench.action.moveEditorToNewWindow'
  ]);
  assert.equal(vscode.calls[0].options.url, url);
  assert.equal(vscode.calls[0].options.openToSide, false);
  assert.equal(vscode.calls[0].options.reuseUrlFilter, url);
  assert.equal(resizeCall.file, '/usr/bin/osascript');
  assert.match(resizeCall.args[1], /size of front window to \{680, 720\}/);
  assert.match(resizeCall.args[1], /count of windows\) < 2/);
  assert.match(resizeCall.args[1], /does not contain "ChatGPT"/);

  const otherOS = mockVscode();
  await openCompactKefaniaChat(otherOS, url, {
    platform: 'linux',
    exec() { throw new Error('Do not run osascript on Linux'); }
  });
  assert.equal(otherOS.calls.length, 2);

  for (const options of [{ float: false }, { moveError: true }]) {
    const host = mockVscode(options);
    assert.deepEqual(await openCompactKefaniaChat(host, url, { platform: 'linux' }), { floating: false });
    assert.equal(host.calls[0].name, 'workbench.action.browser.open');
    assert.equal(host.warnings.length, 1);
  }
  await assert.rejects(openCompactKefaniaChat(mockVscode({ browser: false }), url),
    error => error.browserUnavailable === true);
  const launchFailure = mockVscode({ openError: true });
  await assert.rejects(openCompactKefaniaChat(launchFailure, url), /Cannot open browser/);
  assert.equal(launchFailure.calls.length, 1, 'Do not move another editor after a failed launch');
  await resizeMacChatWindow((_file, _args, _options, callback) => callback(new Error('Accessibility denied')));
  await resizeMacChatWindow(() => { throw new Error('osascript missing'); });
  console.log('Kefania compact browser window checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
