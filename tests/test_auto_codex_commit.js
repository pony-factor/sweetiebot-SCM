'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
  const intervals = [];
  const warnings = [];
  const commits = [];
  let enabled = false;
  let fail = false;
  const repository = {
    rootUri: { scheme: 'file', fsPath: '/project' },
    inputBox: { value: '' },
    state: {
      HEAD: { name: 'feature' },
      indexChanges: [],
      workingTreeChanges: [{ uri: { fsPath: '/project/file.js' } }],
      untrackedChanges: [],
      mergeChanges: []
    },
    status: async () => {}
  };
  const vscode = {
    extensions: {
      getExtension: () => ({ activate: async () => ({ getAPI: () => ({ repositories: [repository] }) }) })
    },
    workspace: {
      getConfiguration(section) {
        return { get(name, fallback) {
          if (section === 'scmToolkit' && name === 'autoCommitWithCodex') return enabled;
          return fallback;
        } };
      }
    },
    commands: {
      executeCommand: async (command, root, options) => {
        assert.equal(command, 'sweetiebot.queueCommit');
        assert.equal(root, repository.rootUri);
        if (fail) throw new Error('Background queue is busy');
        commits.push(options);
        return { queued: true };
      }
    },
    window: { showWarningMessage: message => { warnings.push(message); } }
  };
  const sandbox = {
    module: { exports: {} },
    console,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return 1; },
    clearInterval: () => {},
    require: id => {
      assert.equal(id, './codex_commit');
      return {
        readCommitGitSetting: async (_root, _key, fallback) => fallback,
        coauthorTrailer: (name, email) => `Co-authored-by: ${name} <${email}>`
      };
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../efs/auto_codex_commit.js'), 'utf8'),
    sandbox, { filename: 'auto_codex_commit.js' }
  );
  const { AUTO_COMMIT_INTERVAL_MS, hasPendingChanges, scanAutoCodexCommits, registerAutoCodexCommit } = sandbox.module.exports;
  assert.equal(AUTO_COMMIT_INTERVAL_MS, 30000);
  assert.equal(hasPendingChanges(repository.state), true);
  assert.equal(hasPendingChanges({ indexChanges: [], workingTreeChanges: [], untrackedChanges: [] }), false);
  registerAutoCodexCommit(vscode, { subscriptions: [] });
  assert.equal(intervals[0].ms, 30000);
  await scanAutoCodexCommits(vscode);
  assert.equal(commits.length, 0, 'opt-in is disabled by default');
  enabled = true;
  await scanAutoCodexCommits(vscode);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].all, true);
  assert.equal(commits[0].push, false);
  assert.equal(commits[0].trailer, 'Co-authored-by: Codex <noreply@openai.com>');
  assert.equal(commits[0].codex, false);
  repository.inputBox.value = 'Draft by a person';
  await scanAutoCodexCommits(vscode);
  assert.equal(commits.length, 1, 'do not replace a manually entered message');
  repository.inputBox.value = '';
  repository.state.mergeChanges = [{}];
  await scanAutoCodexCommits(vscode);
  assert.equal(commits.length, 1, 'do not commit conflicts');
  repository.state.mergeChanges = [];
  repository.state.workingTreeChanges = [];
  await scanAutoCodexCommits(vscode);
  assert.equal(commits.length, 1, 'clean tree is skipped');
  repository.state.untrackedChanges = [{}];
  await scanAutoCodexCommits(vscode);
  assert.equal(commits.length, 2, 'new files count as changes');
  const busy = new Set(['/project']);
  await scanAutoCodexCommits(vscode, busy);
  assert.equal(commits.length, 2, 'an in-progress commit is not repeated');
  fail = true;
  const errors = new Map();
  await scanAutoCodexCommits(vscode, new Set(), errors);
  await scanAutoCodexCommits(vscode, new Set(), errors);
  assert.equal(warnings.length, 1, 'a persistent queue error is only reported once');
  const manifest = require('../efs/package.json');
  const option = manifest.contributes.configuration.properties['scmToolkit.autoCommitWithCodex'];
  assert.equal(option.default, false);
  assert.equal(option.scope, 'window');
  console.log('Automatic Codex co-author commit tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
