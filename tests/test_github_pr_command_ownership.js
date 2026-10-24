'use strict';

const assert = require('node:assert/strict');
const { registerLegacyCommandAliases } = require('../efs/command_aliases');
const { registerGitHubPullRequestActions } = require('../efs/github_pr_actions');
const { installPullRequestRefresh } = require('../efs/github_pr_refresh');

async function main() {
  for (const githubFirst of [true, false]) {
    const handlers = new Map();
    const subscriptions = [];
    const merged = [];
    let refreshes = 0;
    let onRefresh;
    const clicked = {};
    const url = 'https://github.com/owner/repo/pull/13';
    const event = () => ({ dispose() {} });
    const vscode = {
      authentication: { getSession: async () => ({ accessToken: "test-session", scopes: ["repo"] }) },
      commands: {
        registerCommand(id, handler) {
          assert(!handlers.has(id), `Command ${id} already exists`);
          handlers.set(id, handler);
          return { dispose() { handlers.delete(id); } };
        },
        getCommands: async () => [...handlers.keys()],
        executeCommand: async (id, ...args) => {
          if (id === 'pr.refreshList') { refreshes++; return onRefresh?.(); }
          assert(handlers.has(id), `Missing command ${id}`);
          return handlers.get(id)(...args);
        }
      },
      authentication: {
        getSession: async () => ({ scopes: ['repo'], accessToken: 'mock-user-token',
          account: { id: 'tester', label: 'Tester' } })
      },
      ProgressLocation: { Notification: 15 },
      window: {
        state: { focused: true }, onDidChangeWindowState: event,
        withProgress: (_, fn) => fn(), showInformationMessage() {},
        showErrorMessage(message) { assert.fail(message); }
      },
      workspace: {
        getConfiguration: () => ({ get: () => true }), onDidChangeConfiguration: event
      }
    };
    const view = { visible: false, selection: [clicked], onDidChangeVisibility: event };
    const owner = {
      _register: item => subscriptions.push(item),
      getTreeItem: async node => {
        assert.equal(node, clicked);
        return { resourceUri: { query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:13' }) } };
      }
    };
    const github = () => installPullRequestRefresh(vscode, view, owner);
    const sweetiebot = () => {
      registerLegacyCommandAliases(vscode, { subscriptions });
      registerGitHubPullRequestActions(vscode, { subscriptions }, async selectedUrl => {
        merged.push(selectedUrl);
        return { merged: false, number: 13 };
      });
    };
    if (githubFirst) { github(); sweetiebot(); }
    else { sweetiebot(); github(); }
    await vscode.commands.executeCommand('sweetiebot.squashMergeSelectedPullRequest', clicked);
    await vscode.commands.executeCommand('scmToolkit.squashMergeSelectedPullRequest');
    await vscode.commands.executeCommand('scmToolkit.squashMergePullRequest', { url });
    assert.deepEqual(merged, [url, url, url]);
    // The inline button resolves in the tree's owner, then hands off only a
    // URL. Model objects/functions must not cross the extension boundary.
    const mergeHandler = handlers.get('sweetiebot.squashMergePullRequest');
    handlers.set('sweetiebot.squashMergePullRequest', target => {
      assert.equal(target, url, 'The row bridge must send the canonical URL');
      return mergeHandler(target);
    });
    await vscode.commands.executeCommand('sweetiebot.squashMergeTreePullRequest', clicked);
    assert.equal(merged.length, 4);
    const originalGetTreeItem = owner.getTreeItem;
    owner.getTreeItem = async () => { throw new Error('stale row'); };
    const originalShowError = vscode.window.showErrorMessage;
    const errors = [];
    vscode.window.showErrorMessage = message => errors.push(message);
    const refreshesBeforeFailure = refreshes;
    await vscode.commands.executeCommand('sweetiebot.squashMergeTreePullRequest', {});
    assert.equal(refreshes, refreshesBeforeFailure + 1, 'Refresh once before reporting an unresolved row');
    assert.equal(merged.length, 4, 'An unresolved clicked row must not use another selection');
    assert.equal(errors.length, 1, 'Show the error only after retrying');
    assert.match(errors[0], /Could not identify the clicked pull request/);
    const staleClicked = {};
    let hydrated = false, lookups = 0;
    owner.getTreeItem = async node => {
      assert.equal(node, staleClicked, 'Retry the original click even if selection changes');
      lookups++;
      if (!hydrated) throw new Error('stale row');
      return { url };
    };
    onRefresh = () => {
      hydrated = true;
      view.selection = [{ url: 'https://github.com/owner/repo/pull/99' }];
      throw new Error('refresh failed after hydration');
    };
    await vscode.commands.executeCommand('sweetiebot.squashMergeTreePullRequest', staleClicked);
    assert.equal(lookups, 2, 'Retry resolution even when refresh rejects');
    assert.equal(refreshes, refreshesBeforeFailure + 3, 'Retry refresh plus the normal refresh after merging');
    assert.equal(merged.length, 5);
    assert.equal(merged.at(-1), url);
    assert.equal(errors.length, 1, 'A successful retry must not show an error');
    onRefresh = undefined;
    view.selection = [clicked];
    owner.getTreeItem = originalGetTreeItem;
    await vscode.commands.executeCommand('sweetiebot.squashMergeTreePullRequest');
    await vscode.commands.executeCommand('sweetiebot.squashMergeTreePullRequest', { number: 99 });
    assert.equal(merged.length, 5, 'Missing and mismatched rows must not merge the selected PR');
    vscode.window.showErrorMessage = originalShowError;
    handlers.set('sweetiebot.squashMergePullRequest', mergeHandler);
    // An optional resolver must never discard or substitute a supplied identity.
    handlers.set('sweetiebot.resolveSelectedPullRequest', async () => ({ url: undefined }));
    await vscode.commands.executeCommand('sweetiebot.squashMergeSelectedPullRequest', { url });
    await vscode.commands.executeCommand('sweetiebot.squashMergeSelectedPullRequest', url);
    await vscode.commands.executeCommand('sweetiebot.squashMergeSelectedPullRequest', {
      scheme: 'prnode', query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:13' })
    });
    assert.deepEqual(merged, Array(8).fill(url));
    for (const subscription of subscriptions) subscription.dispose();
    assert.equal(handlers.size, 0);
    // Direct arguments still work without the optional GitHub tree patch.
    sweetiebot();
    await vscode.commands.executeCommand('sweetiebot.squashMergeSelectedPullRequest', { url });
    assert.equal(merged.at(-1), url);
    for (const subscription of subscriptions) subscription.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
