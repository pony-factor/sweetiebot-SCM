'use strict';

const assert = require('node:assert/strict');
const { registerGitGraphRelativeDates } = require('../extension/ui/git_graph_relative_dates');

async function test() {
  const settings = { enabled: false, global: 'Date & Time', workspace: undefined };
  const updates = [];
  const listeners = new Set();
  const targets = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  const changed = key => {
    for (const callback of [...listeners]) {
      callback({ affectsConfiguration(name) { return name === key; } });
    }
  };
  const vscode = {
    ConfigurationTarget: targets,
    workspace: {
      getConfiguration(root) {
        if (root === 'scmToolkit') {
          return { get(key) {
            assert.equal(key, 'gitGraphRelativeDates');
            return settings.enabled;
          } };
        }
        assert.equal(root, 'git-graph');
        return {
          get(key) {
            assert.equal(key, 'date.format');
            return settings.workspace === undefined ? settings.global : settings.workspace;
          },
          inspect() { return { globalValue: settings.global, workspaceValue: settings.workspace }; },
          async update(key, value, target) {
            assert.equal(key, 'date.format');
            updates.push({ value, target });
            if (target === targets.Workspace) settings.workspace = value;
            else settings.global = value;
            changed('git-graph.date.format');
          }
        };
      },
      onDidChangeConfiguration(callback) {
        listeners.add(callback);
        return { dispose() { listeners.delete(callback); } };
      }
    }
  };
  const context = { subscriptions: [] };
  registerGitGraphRelativeDates(vscode, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  assert.equal(updates.length, 0, 'Opt-out must not touch Git Graph settings');

  settings.enabled = true;
  changed('scmToolkit.gitGraphRelativeDates');
  await tick();
  assert.deepEqual(updates, [{ value: 'Relative', target: targets.Global }]);
  assert.equal(settings.global, 'Relative');

  settings.global = 'Date Only';
  changed('git-graph.date.format');
  await tick();
  assert.equal(settings.global, 'Relative', 'Manual format changes are corrected while enabled');
  assert.equal(updates.length, 2, 'No update loops or redundant writes');

  settings.workspace = 'ISO Date Only';
  changed('git-graph.date.format');
  await tick();
  assert.equal(settings.workspace, 'Relative', 'Workspace overrides must not shadow enforcement');
  assert.equal(updates.at(-1).target, targets.Workspace);

  settings.enabled = false;
  changed('scmToolkit.gitGraphRelativeDates');
  settings.workspace = 'Date Only';
  changed('git-graph.date.format');
  await tick();
  assert.equal(settings.workspace, 'Date Only', 'Turning off enforcement preserves user changes');

  for (const disposable of context.subscriptions) disposable.dispose();
  settings.enabled = true;
  changed('scmToolkit.gitGraphRelativeDates');
  await tick();
  assert.equal(settings.workspace, 'Date Only', 'Disposal prevents later writes');
  console.log('Git Graph relative-date preference and enforcement checks passed.');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
