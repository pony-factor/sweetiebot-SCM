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
    fs.readFileSync(path.join(__dirname, '../extension/commits/auto_codex_commit.js'), 'utf8'),
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
  // The message bar and background scheduler share exactly one configuration setting.
  const pickerSource = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
  const barSource = fs.readFileSync(path.join(__dirname, '../assets/workbench/message_bar.js'), 'utf8');
  assert(barSource.includes("autoCommitToggle: active.has('auto-commit')"));
  assert(barSource.includes("'auto-commit': root.querySelector"));
  assert(pickerSource.includes('autoCommitButton.hidden = false'));
  const start = pickerSource.indexOf('    const refreshAutoCommit = () => {');
  const end = pickerSource.indexOf('    const refreshAutoPublish = () => {', start);
  assert(start >= 0 && end > start);
  let currentEnabled = false, failUpdate = false, changed, click;
  const errors = [];
  const button = {
    attrs: {}, active: new Set(), disabled: false,
    setAttribute(name, value) { this.attrs[name] = value; },
    classList: { toggle() {} },
    addEventListener(name, handler) { assert.equal(name, 'click'); click = handler; }
  };
  button.classList.toggle = (name, value) => {
    if (value) button.active.add(name);
    else button.active.delete(name);
  };
  const controlContext = vm.createContext({
    autoCommitButton: button,
    configuration: {
      getValue(name) { assert.equal(name, 'scmToolkit.autoCommitWithCodex'); return currentEnabled; },
      async updateValue(name, value) {
        assert.equal(name, 'scmToolkit.autoCommitWithCodex');
        if (failUpdate) throw Error('Write failed');
        currentEnabled = value;
        changed({ affectsConfiguration: key => key === name });
      },
      onDidChangeConfiguration(fn) { changed = fn; return { dispose() {} }; }
    },
    notifications: { error(error) { errors.push(error.message); } },
    widget: { disposables: { add() {} } }
  });
  vm.runInContext('let updatingAutoCommit = false;\n' + pickerSource.slice(start, end)
    + '\nthis.refresh = refreshAutoCommit;', controlContext);
  controlContext.refresh();
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.match(button.title, /no push/);
  await click({ stopPropagation() {} });
  assert.equal(currentEnabled, true);
  assert.equal(button.attrs['aria-pressed'], 'true');
  assert(button.active.has('scm-toolkit-auto-commit-active'));
  currentEnabled = false;
  changed({ affectsConfiguration: key => key === 'scmToolkit.autoCommitWithCodex' });
  assert.equal(button.attrs['aria-pressed'], 'false');
  failUpdate = true;
  await click({ stopPropagation() {} });
  assert.equal(currentEnabled, false);
  assert.equal(button.disabled, false);
  assert.deepEqual(errors, ['Write failed']);
  failUpdate = false;
  await click({ stopPropagation() {} });
  assert.equal(currentEnabled, true);

  const manifest = require('../extension/package.json');
  const option = manifest.contributes.configuration.properties['scmToolkit.autoCommitWithCodex'];
  assert.equal(option.default, false);
  assert.equal(option.scope, 'window');
  console.log('Automatic Codex co-author commit tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
