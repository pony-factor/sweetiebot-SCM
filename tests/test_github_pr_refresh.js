'use strict';

const assert = require('node:assert/strict');
const { installPullRequestRefresh, pullRequestFromTreeNode } = require('../extension/github/github_pr_refresh');

async function main() {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  const timers = new Map();
  let sequence = 0;
  global.setInterval = (fn, delay) => { assert.equal(delay, 120000); timers.set(++sequence, fn); return sequence; };
  global.clearInterval = id => timers.delete(id);
  try {
    let visibility, focus, configChanged, enabled = true, calls = 0, resolve, mergeSelected;
    const merges = [];
    const commands = new Map();
    const subscriptions = [];
    const view = { visible: false, onDidChangeVisibility: fn => { visibility = fn; return { dispose() {} }; } };
    const vscode = {
      window: { state: { focused: true }, onDidChangeWindowState: fn => { focus = fn; return { dispose() {} }; } },
      workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'pullRequestAutoRefresh' ? enabled : fallback }),
        onDidChangeConfiguration: fn => { configChanged = fn; return { dispose() {} }; } },
      commands: { registerCommand: (id, handler) => {
        assert(!commands.has(id), `Command ${id} already exists`);
        commands.set(id, handler);
        if (id === 'sweetiebot.resolveSelectedPullRequest') {
          mergeSelected = async node => merges.push(await handler(node));
        }
        return { dispose() { commands.delete(id); } };
      }, executeCommand: (id, arg) => {
        if (commands.has(id)) return commands.get(id)(arg);
        if (id === 'sweetiebot.squashMergePullRequest') { merges.push(arg); return Promise.resolve(); }
        if (id === 'sweetiebot.githubRateLimited') return Promise.resolve();
        assert.equal(id, 'pr.refreshList'); calls++;
        return new Promise(done => { resolve = done; });
      } }
    };
    assert.equal(installPullRequestRefresh(vscode, view, { _register: item => subscriptions.push(item) }), view);
    const url = 'https://github.com/owner/repo/pull/12';
    assert.deepEqual(pullRequestFromTreeNode(url), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode([{ url }]), { url, number: 12 });
    assert.equal(pullRequestFromTreeNode([{ url }, { url }]).url, undefined);
    assert.deepEqual(pullRequestFromTreeNode({ scheme: 'prnode',
      query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:12' }) }),
    { url, number: 12 });
    await mergeSelected({ url, number: 12 });
    assert(!commands.has('scmToolkit.squashMergeSelectedPullRequest'));
    assert(!commands.has('sweetiebot.squashMergeSelectedPullRequest'));
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
    for (const remote of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
      assert.deepEqual(pullRequestFromTreeNode({ resourceUri: { query: JSON.stringify({ prIdentifier: `${remote}:12` }) } }), { url, number: 12 });
      assert.deepEqual(pullRequestFromTreeNode({ pullRequestModel: { remote: { url: remote }, number: 12 } }), { url, number: 12 });
    }
    // GitHub PR tree commands can receive a rendered TreeItem rather than a
    // fully hydrated PRNode. Its command arguments and stable ID retain identity.
    const renderedWithCommand = {
      id: 'category-https://github.com/owner/repo/pull/12',
      command: { arguments: [{ pullRequestModel: { html_url: url, number: 12 } }] }
    };
    assert.deepEqual(pullRequestFromTreeNode(renderedWithCommand), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode({ id: 'category-' + url }), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode({ id: 'category-' + url, number: 99 }),
      { url: undefined, number: 99 }, 'Never substitute a PR when the clicked row number disagrees');
    assert.deepEqual(pullRequestFromTreeNode({ command: { arguments: [
      { remote: { url: 'git@github.com:owner/repo.git' }, number: 12 }
    ] } }), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode({ pullRequestModel: {
      githubRepository: { remote: { url: 'https://github.com/owner/repo.git' } }, number: 12
    } }), { url, number: 12 });
    assert.equal(pullRequestFromTreeNode({ command: { arguments: [] }, id: 'unrelated-tree-item' }).url, undefined);
    assert.equal(pullRequestFromTreeNode({ id: 'prefixhttps://github.com/owner/repo/pull/12https://github.com/owner/repo/pull/13' }).url, undefined,
      'Never guess between multiple PR identities');
    assert.equal(pullRequestFromTreeNode({ resourceUri: { query: '{invalid' } }).url, undefined);
    assert.equal(pullRequestFromTreeNode({ remote: { url: 'git@other.example:owner/repo.git' }, number: 12 }).url, undefined);
    assert.deepEqual(pullRequestFromTreeNode({ html_url: '', url, number: 99 }), { url, number: 12 },
      'Ignore unusable URL aliases and derive the number from the actual PR URL');
    for (const subscription of subscriptions) subscription.dispose();
    const renderedNode = {};
    const renderedOwner = {
      _register: item => subscriptions.push(item),
      getTreeItem: async node => {
        assert.equal(node, renderedNode, 'Resolve the clicked node, not a different selection');
        return { resourceUri: { query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:13' }) } };
      }
    };
    installPullRequestRefresh(vscode, { ...view, selection: [{ url, number: 12 }] }, renderedOwner);
    await mergeSelected(renderedNode);
    assert.deepEqual(merges.at(-1), { url: 'https://github.com/owner/repo/pull/13', number: 13 });
    // Dispose this additional view before checking the original refresh lifecycle.
    for (const subscription of subscriptions) subscription.dispose();
    installPullRequestRefresh(vscode, view, { _register: item => subscriptions.push(item) });
    view.selection = [{ pullRequestModel: { html_url: url, number: 12 } }];
    await mergeSelected();
    assert.deepEqual(merges.at(-1), { url, number: 12 });
    view.selection = [{ url }, { url: 'https://github.com/owner/repo/pull/13' }];
    await mergeSelected();
    assert.equal(merges.at(-1).url, undefined, 'Never guess among multiple selected PRs');

    // A click immediately changes only that PR's row, even before the remote
    // operation finishes. Duplicate clicks do not dispatch a second merge.
    const rowCommands = new Map(), rowRefreshes = [], rowSubscriptions = [];
    const rowProgress = [], rowProgressUpdates = [];
    let completeMerge;
    const dispatched = [];
    const rowOwner = {
      _register: item => rowSubscriptions.push(item),
      async getTreeItem() { return { description: 'by @pony', contextValue: 'pullrequest:hasHeadRef', iconPath: 'native-icon' }; },
      refresh: node => rowRefreshes.push(node)
    };
    const rowVscode = {
      ...vscode,
      // Keep this isolated test view from replacing the main view's listeners.
      ProgressLocation: { Notification: 15 },
      window: {
        ...vscode.window,
        onDidChangeWindowState: () => ({ dispose() {} }),
        withProgress: (options, work) => {
          rowProgress.push(options);
          return work({ report: update => rowProgressUpdates.push(update) });
        }
      },
      workspace: { ...vscode.workspace, onDidChangeConfiguration: () => ({ dispose() {} }) },
      commands: {
        registerCommand(id, fn) {
          rowCommands.set(id, fn);
          return { dispose() { rowCommands.delete(id); } };
        },
        executeCommand(id, arg, options) {
          if (id === 'sweetiebot.squashMergePullRequest') {
            assert.deepEqual(options, { progressManaged: true }, 'The inline button owns its one notification');
            dispatched.push(arg);
            return new Promise(resolve => { completeMerge = resolve; });
          }
          if (id === 'pr.refreshList') return Promise.resolve();
          throw new Error('Unexpected command ' + id);
        }
      }
    };
    installPullRequestRefresh(rowVscode, {
      visible: false, onDidChangeVisibility: () => ({ dispose() {} })
    }, rowOwner);
    const clicked = { pullRequestModel: { url, number: 12 } };
    const another = { pullRequestModel: { url: 'https://github.com/owner/repo/pull/13', number: 13 } };
    const clickMerge = rowCommands.get('sweetiebot.squashMergeTreePullRequest');
    const first = clickMerge(clicked);
    assert.equal(rowProgress.length, 1, 'Show progress synchronously, before PR row hydration');
    assert.equal(rowProgress[0].location, 15);
    assert.equal(rowProgress[0].title, 'Squash merge PR #12');
    assert.equal(rowProgress[0].cancellable, false);
    await new Promise(setImmediate);
    const during = await rowOwner.getTreeItem(clicked);
    assert.match(during.description, /by @pony · ⏳ Squash-merging/);
    assert.match(during.contextValue, /sweetiebotMergeBusy/);
    assert.equal(during.iconPath, 'native-icon');
    assert.equal((await rowOwner.getTreeItem(another)).description, 'by @pony');
    assert.equal(rowRefreshes.at(-1), clicked);
    await clickMerge(clicked);
    assert.equal(rowProgress.length, 1, 'Duplicate clicks must not create duplicate notifications');
    assert.deepEqual(rowProgressUpdates, [{ message: 'Checking merge eligibility…' }]);
    assert.deepEqual(dispatched, [url], 'The second click must not dispatch another merge');
    completeMerge({ state: 'merged' });
    assert.deepEqual(await first, { state: 'merged' });
    assert.match((await rowOwner.getTreeItem(clicked)).description, /✅ Merged/);
    const second = clickMerge(clicked);
    await new Promise(setImmediate);
    completeMerge({ state: 'queued' });
    assert.deepEqual(await second, { state: 'queued' });
    assert.match((await rowOwner.getTreeItem(clicked)).description, /Merge queued/);
    assert.doesNotMatch((await rowOwner.getTreeItem(clicked)).description, /✅ Merged/);
    const retryPending = clickMerge(clicked);
    await new Promise(setImmediate);
    completeMerge({ state: 'pending' });
    assert.deepEqual(await retryPending, { state: 'pending' });
    assert.match((await rowOwner.getTreeItem(clicked)).description, /GitHub is processing the merge/);
    for (const state of ['cancelled', 'failed']) {
      const action = clickMerge(clicked);
      await new Promise(setImmediate);
      completeMerge({ state });
      assert.deepEqual(await action, { state });
      assert.equal((await rowOwner.getTreeItem(clicked)).description, 'by @pony');
    }
    assert.equal(dispatched.length, 5);
    for (const subscription of rowSubscriptions) subscription.dispose();
    const manifest = require('../extension/package.json');
    assert.equal(manifest.contributes.menus['view/item/context'][0].command,
      'sweetiebot.squashMergeTreePullRequest');
    await Promise.resolve();
    assert.equal(calls, 0);
    assert.equal(timers.size, 0);
    view.visible = true; visibility();
    assert.equal(calls, 1);
    view.visible = false; visibility();
    view.visible = true; visibility();
    assert.equal(calls, 1, 'Visibility changes do not bypass the interval');
    const tick = [...timers.values()][0];
    tick(); assert.equal(calls, 1); // No overlapping refreshes.
    resolve(); await Promise.resolve();
    now += 120000; tick(); assert.equal(calls, 2);
    resolve(); await Promise.resolve();
    vscode.window.state.focused = false; focus();
    assert.equal(timers.size, 0);
    tick(); assert.equal(calls, 2);
    now += 120000;
    vscode.window.state.focused = true; focus();
    assert.equal(calls, 3);
    resolve(); await Promise.resolve();
    enabled = false; configChanged({ affectsConfiguration: () => true });
    assert.equal(timers.size, 0);
    now += 120000;
    enabled = true; configChanged({ affectsConfiguration: () => true });
    assert.equal(calls, 4);
    resolve(); await Promise.resolve();
    view.visible = false; visibility();
    assert.equal(timers.size, 0);
    now += 120000;
    view.visible = true; visibility();
    subscriptions.at(-1).dispose();
    assert.equal(timers.size, 0);
    resolve(); await Promise.resolve();
    tick(); assert.equal(calls, 5);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    Date.now = originalNow;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
