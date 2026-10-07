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
    const clicked = {};
    const url = 'https://github.com/owner/repo/pull/13';
    const event = () => ({ dispose() {} });
    const vscode = {
      commands: {
        registerCommand(id, handler) {
          assert(!handlers.has(id), `Command ${id} already exists`);
          handlers.set(id, handler);
          return { dispose() { handlers.delete(id); } };
        },
        getCommands: async () => [...handlers.keys()],
        executeCommand: async (id, ...args) => {
          if (id === 'pr.refreshList') return;
          assert(handlers.has(id), `Missing command ${id}`);
          return handlers.get(id)(...args);
        }
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
