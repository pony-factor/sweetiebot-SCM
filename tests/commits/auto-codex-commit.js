'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
  const source = fs.readFileSync(path.join(__dirname, '../../extension/commits/auto-codex-commit.js'), 'utf8');
  const intervals = [];
  const commits = [];
  const warnings = [];
  const handlers = new Map();
  const values = new Map();
  const store = {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    async update(key, value) { values.set(key, value); }
  };
  const root = { scheme: 'file', fsPath: '/project', toString() { return 'file:///project'; } };
  const otherRoot = { scheme: 'file', fsPath: '/other', toString() { return 'file:///other'; } };
  const repository = {
    rootUri: root, inputBox: { value: '' },
    state: { HEAD: { name: 'feature' }, indexChanges: [],
      workingTreeChanges: [{}], untrackedChanges: [], mergeChanges: [] },
    async status() {}
  };
  const other = {
    rootUri: otherRoot, inputBox: { value: '' },
    state: { HEAD: { name: 'feature' }, indexChanges: [],
      workingTreeChanges: [{}], untrackedChanges: [], mergeChanges: [] },
    async status() {}
  };
  let fail = false;
  const vscode = {
    Uri: { from: uri => uri },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({
      repositories: [repository, other],
      getRepository: uri => [repository, other].find(item => item.rootUri.fsPath === uri.fsPath)
    }) }) }) },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    commands: {
      registerCommand(name, callback) {
        handlers.set(name, callback);
        return { dispose() { handlers.delete(name); } };
      },
      async executeCommand(name, ...args) {
        if (handlers.has(name)) return handlers.get(name)(...args);
        assert.equal(name, 'sweetiebot.queueCommit');
        if (fail) throw Error('Background queue is busy');
        commits.push({ root: args[0].fsPath, options: args[1] });
        return { queued: true };
      }
    },
    window: { showWarningMessage: message => warnings.push(message) }
  };
  const sandbox = {
    module: { exports: {} }, console,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return 1; },
    clearInterval: () => {},
    require: id => {
      assert.equal(id, './codex-commit');
      return {
        readCommitGitSetting: async (_root, _key, fallback) => fallback,
        coauthorTrailer: (name, email) => 'Co-authored-by: ' + name + ' <' + email + '>'
      };
    }
  };
  vm.runInNewContext(source, sandbox, { filename: 'auto-codex-commit.js' });
  const {
    AUTO_COMMIT_INTERVAL_MS, preferenceKey, isAutoCommitEnabled,
    scanAutoCodexCommits, registerAutoCodexCommit
  } = sandbox.module.exports;
  assert.equal(AUTO_COMMIT_INTERVAL_MS, 30000);
  assert.equal(preferenceKey(root, 'feature') !== preferenceKey(root, 'main'), true);
  assert.equal(preferenceKey(root, 'feature') !== preferenceKey(otherRoot, 'feature'), true);
  const context = { workspaceState: store, subscriptions: [] };
  registerAutoCodexCommit(vscode, context);
  assert.equal(intervals[0].ms, 30000);
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 0, 'new window and branches must start off');
  const toggle = (uri, branch) => vscode.commands.executeCommand(
    'sweetiebot.autoCommitForBranch', 'toggle', uri, branch
  );
  const get = (uri, branch) => vscode.commands.executeCommand(
    'sweetiebot.autoCommitForBranch', 'get', uri, branch
  );
  assert.equal(await toggle(root, 'feature'), true);
  assert.equal(await get(root, 'feature'), true);
  assert.equal(await get(root, 'main'), false);
  assert.equal(await get(otherRoot, 'feature'), false);
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 1, 'only the enabled repository commits');
  assert.equal(commits[0].root, '/project');
  assert.equal(commits[0].options.expectedBranch, 'feature');
  assert.equal(commits[0].options.push, false);
  assert.equal(commits[0].options.all, true);
  assert.equal(commits[0].options.trailer, 'Co-authored-by: Codex <noreply@openai.com>');
  repository.state.HEAD.name = 'main';
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 1, 'switching to a new branch starts off');
  await assert.rejects(() => toggle(root, 'feature'), /branch changed/);
  assert.equal(await toggle(root, 'main'), true);
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].options.expectedBranch, 'main');
  repository.state.HEAD.name = 'feature';
  assert.equal(await get(root, 'feature'), true, 'returning to a branch restores opt-in');
  assert.equal(await toggle(root, 'feature'), false);
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 2, 'disabled branch does not auto-commit');
  await toggle(root, 'feature');
  repository.inputBox.value = 'Human draft';
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 2, 'draft commit messages are protected');
  repository.inputBox.value = '';
  repository.state.mergeChanges = [{}];
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 2, 'conflicts are protected');
  repository.state.mergeChanges = [];
  repository.state.workingTreeChanges = [];
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 2, 'clean trees are protected');
  repository.state.untrackedChanges = [{}];
  await scanAutoCodexCommits(vscode, store);
  assert.equal(commits.length, 3, 'untracked files qualify');
  await scanAutoCodexCommits(vscode, store, new Set(['/project']));
  assert.equal(commits.length, 3, 'an in-progress repository is skipped');
  fail = true;
  const reported = new Map();
  await scanAutoCodexCommits(vscode, store, new Set(), reported);
  await scanAutoCodexCommits(vscode, store, new Set(), reported);
  assert.equal(warnings.length, 1, 'duplicate queue errors are suppressed');
  fail = false;
  const otherWindowStore = { get: (_key, fallback) => fallback };
  assert.equal(isAutoCommitEnabled(otherWindowStore, root, 'feature'), false,
    'another window/workspace does not inherit this opt-in');
  await scanAutoCodexCommits(vscode, otherWindowStore);
  assert.equal(commits.length, 3);
  assert.equal(isAutoCommitEnabled(store, root, 'main'), true,
    'preferences persist in workspaceState independently of branch activity');

  const pickerSource = fs.readFileSync(path.join(__dirname, '../../assets/workbench/picker.js'), 'utf8');
  const barSource = fs.readFileSync(path.join(__dirname, '../../assets/workbench/message-bar.js'), 'utf8');
  assert(barSource.includes("autoCommitToggle: active.has('auto-commit')"));
  assert(pickerSource.includes('autoCommitButton.hidden = false'));
  assert(pickerSource.includes('refreshAutoCommit();\n        refreshSpellcheck();'),
    'SCM branch changes refresh the clock');
  const start = pickerSource.indexOf('    let autoCommitIdentity;');
  const end = pickerSource.indexOf('    const refreshAutoPublish = () => {', start);
  assert(start >= 0 && end > start);
  const button = {
    attrs: {}, active: new Set(), disabled: false,
    setAttribute(name, value) { this.attrs[name] = value; },
    classList: { toggle() {} },
    addEventListener(name, fn) { assert.equal(name, 'click'); this.click = fn; }
  };
  button.classList.toggle = (name, value) => {
    if (value) button.active.add(name);
    else button.active.delete(name);
  };
  const buttonValues = new Map();
  const buttonErrors = [];
  let failUpdate = false;
  const controlContext = vm.createContext({
    autoCommitButton: button,
    commands: {
      async executeCommand(name, action, uri, branch) {
        assert.equal(name, 'sweetiebot.autoCommitForBranch');
        const key = uri.fsPath + ':' + branch;
        if (action === 'get') return buttonValues.get(key) === true;
        assert.equal(action, 'toggle');
        if (failUpdate) throw Error('Write failed');
        const enabled = buttonValues.get(key) !== true;
        buttonValues.set(key, enabled);
        return enabled;
      }
    },
    notifications: { error: error => buttonErrors.push(error.message) }
  });
  vm.runInContext(
    "let updatingAutoCommit = false; let currentBranch = 'feature';" +
    "let currentRepositoryUri = { scheme: 'file', fsPath: '/project', toString() { return 'file:///project'; } };\n" +
    pickerSource.slice(start, end) +
    "\nthis.refresh = refreshAutoCommit;" +
    "\nthis.setBranch = branch => { currentBranch = branch; refreshAutoCommit(); };" +
    "\nthis.setRepository = root => { currentRepositoryUri = root; refreshAutoCommit(); };",
    controlContext
  );
  const flush = () => new Promise(resolve => setImmediate(resolve));
  controlContext.refresh();
  await flush();
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.match(button.title, /no push/);
  await button.click({ stopPropagation() {} });
  assert.equal(button.attrs['aria-pressed'], 'true');
  assert(button.active.has('scm-toolkit-auto-commit-active'));
  controlContext.setBranch('main');
  await flush();
  assert.equal(button.attrs['aria-pressed'], 'false', 'another branch begins off in the UI');
  await button.click({ stopPropagation() {} });
  assert.equal(button.attrs['aria-pressed'], 'true');
  controlContext.setBranch('feature');
  await flush();
  assert.equal(button.attrs['aria-pressed'], 'true', 'the earlier branch restores its clock');
  controlContext.setRepository({
    scheme: 'file', fsPath: '/other', toString() { return 'file:///other'; }
  });
  await flush();
  assert.equal(button.attrs['aria-pressed'], 'false', 'other repositories do not inherit the state');
  failUpdate = true;
  await button.click({ stopPropagation() {} });
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.equal(button.disabled, false);
  assert.deepEqual(buttonErrors, ['Write failed']);
  controlContext.setBranch(undefined);
  assert.equal(button.disabled, true, 'detached or unresolved branches cannot be enabled');

  const manifest = require('../../extension/package.json');
  assert(manifest.activationEvents.includes('onCommand:sweetiebot.autoCommitForBranch'),
    'reading branch preferences must activate the extension on a fresh window');
  const extensionSource = fs.readFileSync(path.join(__dirname, '../../extension/extension.js'), 'utf8');
  assert(extensionSource.indexOf('  registerAutoCodexCommit(vscode, context);')
    < extensionSource.indexOf('  await registerManagedWindowActivity(vscode, context);'),
  'register branch preferences before asynchronous startup can reveal SCM');
  assert.equal(manifest.contributes.configuration.properties['sweetiebot.autoCommitWithCodex'],
    undefined, 'the old global toggle must not override branch-scoped preferences');
  console.log('Window/repository/branch automatic commit tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
