'use strict';

const assert = require('node:assert/strict');
const { openCompactKefaniaChat, resizeMacChatWindow } = require('../extension/codex/kefania_chat_window');

function mockVscode({ float = true, browser = true, moveError = false, openError = false, recreateOnMove = false, rejectClose = false } = {}) {
  const calls = [], warnings = [], closed = [], workspaceTab = { name: 'Workspace' };
  const group = { tabs: [workspaceTab] };
  return {
    calls, warnings, closed, workspaceTab,
    commands: {
      async getCommands() {
        return [...(browser ? ['workbench.action.browser.open'] : []),
          ...(float ? ['workbench.action.moveEditorToNewWindow'] : [])];
      },
      async executeCommand(name, options) {
        calls.push({ name, options });
        if (name === 'workbench.action.browser.open' && openError) throw new Error('Cannot open browser');
        if (name === 'workbench.action.browser.open') group.tabs.push({ name: 'Kefania confirmation', label: 'Kefania confirmation' });
        if (name === 'workbench.action.moveEditorToNewWindow' && recreateOnMove) {
          group.tabs = group.tabs.filter(tab => tab.name !== 'Kefania confirmation');
          group.tabs.push({ name: 'Relocated confirmation', label: 'PR #268 · Kefania · 11111111' });
        }
        if (name === 'workbench.action.moveEditorToNewWindow' && moveError) throw new Error('Move failed');
      }
    },
    window: { tabGroups: { all:[group], async close(tab) { if (rejectClose) return false; closed.push(tab); group.tabs=group.tabs.filter(item=>item!==tab); return true; } }, async showWarningMessage(message) { warnings.push(message); } }
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
  assert.equal(floating.floating, true);
  assert.equal(typeof floating.close, 'function');
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
  await floating.close();
  assert.equal(vscode.closed.length, 1, 'Close targets exactly one confirmation tab');
  assert.equal(vscode.closed[0].name, 'Kefania confirmation');
  assert.deepEqual(vscode.window.tabGroups.all[0].tabs, [vscode.workspaceTab], 'Workspace tab is preserved');
  await assert.rejects(floating.close(), /no longer open/, 'Never close an unrelated tab after the confirmation closes');

  const relocatedHost = mockVscode({recreateOnMove: true});
  const relocated = await openCompactKefaniaChat(relocatedHost,
    'http://127.0.0.1:60847/kefania-draft/11111111-2222-4333-8444-555555555555', {platform: 'linux'});
  const relocatedTabs = relocatedHost.window.tabGroups.all[0].tabs;
  const movedIndex = relocatedTabs.findIndex(tab => tab.name === 'Relocated confirmation');
  // Navigation may rehydrate the browser tab again after the auxiliary move.
  relocatedTabs[movedIndex] = {name:'Navigated confirmation',label:'PR #268 · Kefania · 11111111'};
  relocatedTabs.push({ name: 'Other confirmation', label: 'PR #269 · Kefania · 22222222' });
  await relocated.close();
  assert.deepEqual(relocatedHost.closed.map(tab => tab.name), ['Navigated confirmation'],
    'Close resolves the relocated tab, not another browser or confirmation');
  assert.equal(relocatedHost.window.tabGroups.all[0].tabs.some(tab => tab.name === 'Other confirmation'), true);
  const detachedHost = mockVscode({recreateOnMove:true});
  const detached = await openCompactKefaniaChat(detachedHost,
    'http://127.0.0.1:60847/kefania-draft/aaaaaaaa-2222-4333-8444-555555555555',
    {platform:'darwin',exec(file,args,options,done){
      if(args[1].includes('AXCloseButton')) {
        assert.match(args[1], /windowTitle contains "Kefania"/);
        assert.match(args[1], /windowTitle contains "aaaaaaaa"/);
        done(null,'closed','');
      } else done(null,'','');
    }});
  detachedHost.window.tabGroups.all[0].tabs = [detachedHost.workspaceTab];
  await detached.close();
  assert.deepEqual(detachedHost.window.tabGroups.all[0].tabs,[detachedHost.workspaceTab],
    'Detached-window fallback must not close workspace tabs');

  const failedCloseHost = mockVscode({rejectClose:true});
  const failedClose = await openCompactKefaniaChat(failedCloseHost, url, {platform:'linux'});
  await assert.rejects(failedClose.close(), /could not close/, 'An unsuccessful VS Code close is not reported as success');

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
  const noFloat = mockVscode({float:false});
  await assert.rejects(openCompactKefaniaChat(noFloat, url, {requireFloating:true}), /separate window/);
  assert.equal(noFloat.calls.length, 0, 'Required floating window never falls back to a workspace tab');
  await assert.rejects(openCompactKefaniaChat(mockVscode({moveError:true}), url, {requireFloating:true}), /separate window/);
  const launchFailure = mockVscode({ openError: true });
  await assert.rejects(openCompactKefaniaChat(launchFailure, url), /Cannot open browser/);
  assert.equal(launchFailure.calls.length, 1, 'Do not move another editor after a failed launch');
  await resizeMacChatWindow((_file, _args, _options, callback) => callback(new Error('Accessibility denied')));
  await resizeMacChatWindow(() => { throw new Error('osascript missing'); });
  console.log('Kefania compact browser window checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
