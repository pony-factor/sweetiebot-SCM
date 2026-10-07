'use strict';

const assert = require('node:assert/strict');
const { installPullRequestRefresh } = require('../efs/github_pr_refresh');

async function main() {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const timers = new Map();
  let sequence = 0;
  global.setInterval = (fn, delay) => { assert.equal(delay, 5000); timers.set(++sequence, fn); return sequence; };
  global.clearInterval = id => timers.delete(id);
  try {
    let visibility, focus, configChanged, enabled = true, calls = 0, resolve, mergeSelected;
    const merges = [];
    const commands = new Map();
    const subscriptions = [];
    const view = { visible: false, onDidChangeVisibility: fn => { visibility = fn; return { dispose() {} }; } };
    const vscode = {
      window: { state: { focused: true }, onDidChangeWindowState: fn => { focus = fn; return { dispose() {} }; } },
      workspace: { getConfiguration: () => ({ get: () => enabled }),
        onDidChangeConfiguration: fn => { configChanged = fn; return { dispose() {} }; } },
      commands: { registerCommand: (id, handler) => {
        commands.set(id, handler);
        if (id === 'sweetiebot.squashMergeSelectedPullRequest') mergeSelected = handler;
        return { dispose() {} };
      }, executeCommand: (id, arg) => {
        if (commands.has(id)) return commands.get(id)(arg);
        if (id === 'sweetiebot.squashMergePullRequest') { merges.push(arg); return Promise.resolve(); }
        assert.equal(id, 'pr.refreshList'); calls++;
        return new Promise(done => { resolve = done; });
      } }
    };
    assert.equal(installPullRequestRefresh(vscode, view, { _register: item => subscriptions.push(item) }), view);
    const url = 'https://github.com/owner/repo/pull/12';
    await commands.get('scmToolkit.squashMergeSelectedPullRequest')({ url, number: 12 });
    await mergeSelected({ pullRequestModel: { html_url: url, number: 12 } });
    await mergeSelected({ url, number: 12 });
    await mergeSelected({
      resourceUri: { query: JSON.stringify({ prIdentifier: 'https://github.com/owner/repo:12' }) }
    });
    assert.deepEqual(merges, [
      { url, number: 12 },
      { url, number: 12 },
      { url, number: 12 },
      { url, number: 12 }
    ]);
    const manifest = require('../efs/package.json');
    assert.equal(manifest.contributes.menus['view/item/context'][0].command,
      'sweetiebot.squashMergeSelectedPullRequest');
    await Promise.resolve();
    assert.equal(calls, 0);
    assert.equal(timers.size, 0);
    view.visible = true; visibility();
    assert.equal(calls, 1);
    const tick = [...timers.values()][0];
    tick(); assert.equal(calls, 1); // No overlapping refreshes.
    resolve(); await Promise.resolve();
    tick(); assert.equal(calls, 2);
    resolve(); await Promise.resolve();
    vscode.window.state.focused = false; focus();
    assert.equal(timers.size, 0);
    tick(); assert.equal(calls, 2);
    vscode.window.state.focused = true; focus();
    assert.equal(calls, 3);
    resolve(); await Promise.resolve();
    enabled = false; configChanged({ affectsConfiguration: () => true });
    assert.equal(timers.size, 0);
    enabled = true; configChanged({ affectsConfiguration: () => true });
    assert.equal(calls, 4);
    resolve(); await Promise.resolve();
    view.visible = false; visibility();
    assert.equal(timers.size, 0);
    view.visible = true; visibility();
    subscriptions.at(-1).dispose();
    assert.equal(timers.size, 0);
    resolve(); await Promise.resolve();
    tick(); assert.equal(calls, 5);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
