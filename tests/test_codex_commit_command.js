'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function run() {
  const manifest = require('../efs/package.json');
  assert(manifest.activationEvents.includes('onCommand:sweetiebot.prepareCodexCommit'),
    'The first Codex commit command must activate the extension in a fresh window');
  let command, active = false, bridgeInstalled = false, progress = 0;
  let snapshot = 'Same-window conversation', captureError, activationError, discoveryError;
  let expectedContext = '';
  const commands = new Map();
  let additions = 0;
  let expectedPaths = ['/selected/edited file', '/selected/deleted file', '/selected/new file'];
  const commits = [];
  let commitError;
  let normalizationError, normalizations = 0;
  const gitSettings = {};
  let pushes = 0;
  let pendingCommit = false;
  const queued = [];
  const repository = {
    rootUri: { fsPath: '/selected' },
    state: { indexChanges: ['staged'], workingTreeChanges: [{ uri: { fsPath: '/selected/edited file' } }, { uri: { fsPath: '/selected/deleted file' } }], untrackedChanges: [{ uri: { fsPath: '/selected/new file' } }], mergeChanges: [] },
    get inputBox() { throw new Error('The commit backend must not access the message box'); },
    async commit(message, options) {
      assert.equal(normalizations, commits.length + 1, 'normalize staged files before each commit');
      commits.push({ message, options });
      if (commitError) throw commitError;
    },
    async status() {},
    async add(paths) {
      assert.deepEqual(Array.from(paths), expectedPaths);
      for (const file of paths) {
        assert.notEqual(path.relative(this.rootUri.fsPath, file), '', 'Git receives nonempty relative pathspecs');
      }
      additions++;
      this.state.indexChanges = ['staged'];
    }
  };
  const child = {
    stdout: { setEncoding() {}, on(event, callback) { this.callback = callback; } },
    stderr: { setEncoding() {}, on() {} },
    on(event, callback) { if (event === 'close') this.close = callback; },
    stdin: { on() {}, end(value) {
      assert.equal(JSON.parse(value).context, expectedContext);
      child.stdout.callback(JSON.stringify({ message: 'Fix generation' }));
      child.close(0);
    } }
  };
  const sandbox = vm.createContext({
    module: { exports: {} }, process, clearTimeout,
    setTimeout(callback, delay) {
      assert.equal(delay, 9060000, 'The child deadline allows ten 900-second Ollama attempts plus one minute of overhead');
      return setTimeout(callback, delay);
    },
    require: name => {
      if (name === './python_runtime') {
        return {
          resolvePythonExecutable: () => '/resolved/python3',
          pythonLaunchError: error => error
        };
      }
      if (name === 'node:path') return path;
      if (name === './codex_attribution') return require('../efs/codex_attribution');
      assert.equal(name, 'child_process'); return { execFile(exe, args, options, callback) {
        assert.equal(exe, '/resolved/python3');
        assert.deepEqual(Array.from(args), ['/extension/local_codex_commit.py', '--normalize-staged-whitespace']);
        assert.equal(options.cwd, '/selected');
        assert.equal(options.timeout, 30000);
        if (!normalizationError) normalizations++;
        callback(normalizationError, '', normalizationError ? 'Whitespace cleanup failed' : '');
      }, spawn(exe, args, options) {
      assert.equal(exe, '/resolved/python3');
      assert.equal(options.cwd, '/selected');
      assert.equal(args[0], '/extension/local_codex_commit.py');
      return child;
    } }; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../efs/codex_commit.js'), 'utf8'), sandbox);
  const vscode = {
    Uri: { from: uri => uri, joinPath: (uri, file) => ({ fsPath: `${uri.fsPath}/${file}` }) },
    extensions: { getExtension: id => id === 'vscode.git'
      ? { async activate() { return { getAPI: () => ({ getRepository: () => repository }) }; } }
      : { get isActive() { return active; }, async activate() {
        if (activationError) throw activationError;
        active = true;
      } } },
    commands: { registerCommand(id, callback) { commands.set(id, callback); command = callback; return {}; },
      async getCommands() {
        if (discoveryError) throw discoveryError;
        return bridgeInstalled ? ['sweetiebot.readCodexContext'] : [];
      },
      async executeCommand(id, root, options) {
        if (id === 'sweetiebot.queueCommit') {
          assert.equal(options.onlyIfPending, true);
          if (pendingCommit) queued.push(options);
          return { queued: pendingCommit };
        }
        if (id === 'git.push') {
          assert.equal(root.fsPath, '/selected');
          pushes++;
          return;
        }
        assert.equal(id, 'sweetiebot.readCodexContext');
        if (captureError) throw captureError;
        return snapshot;
      } },
    workspace: { getConfiguration(section, root) {
      assert.equal(section, 'git');
      assert.equal(root.fsPath, '/selected');
      return { get: key => gitSettings[key] };
    } },
    ProgressLocation: { Notification: 15 },
    window: { async withProgress(options, callback) { progress++; assert.equal(options.title, 'Generating commit message'); return callback(); } }
  };
  sandbox.module.exports.registerCodexCommitCommand(vscode, { subscriptions: [], extensionUri: { fsPath: '/extension' } });
  const commit = commands.get('sweetiebot.commitWithMessage');
  pendingCommit = true;
  const manualMessage = '🧪 Record manual change\n\nCo-authored-by: Codex <noreply@openai.com>';
  await commit({ fsPath: '/selected' }, manualMessage);
  assert.equal(queued[0].message, manualMessage, 'preserve the manual subject and attribution exactly');
  assert.equal(commits.length, 0, 'pending commits use the queue instead of blocked direct Git');
  assert.equal(normalizations, 0, 'the queue owns preparation when a job is pending');
  assert.equal(pushes, 0, 'publication stays ordered behind pending title generation');
  pendingCommit = false;

  const prepare = commands.get('sweetiebot.prepareCodexCommit');
  const uri = { scheme: 'file', fsPath: '/selected' };
  await commit(uri, 'Generated title');
  assert.equal(commits[0].message, 'Generated title');
  assert.equal(commits[0].options.signoff, false);
  gitSettings.enableCommitSigning = true;
  gitSettings.alwaysSignOff = true;
  await commit(uri, 'Signed title');
  assert.equal(commits[1].options.signCommit, true);
  assert.equal(commits[1].options.signoff, true);
  assert.equal(pushes, 0, 'push stays opt-in');
  gitSettings.postCommitCommand = 'push';
  await commit(uri, 'Commit and push');
  assert.equal(pushes, 1, 'the push checkbox still triggers the normal Git push command');
  await assert.rejects(commit(uri, ''), /message is required/);
  commitError = new Error('Hook failed');
  await assert.rejects(commit(uri, 'Failed title'), /Hook failed/);
  assert.equal(pushes, 1, 'a failed commit never pushes');
  commitError = undefined;
  normalizationError = new Error('Cleanup failed');
  await assert.rejects(commit(uri, 'Failed cleanup'), /Whitespace cleanup failed/);
  assert.equal(commits.length, 4, 'cleanup failure stops before Git commits');
  assert.equal(pushes, 1, 'cleanup failure never pushes');
  normalizationError = undefined;
  await prepare(uri);
  assert.equal(additions, 0, 'existing staged changes leave unstaged changes alone');
  repository.state.indexChanges = [];
  await assert.rejects(commit(uri, 'Unstaged title'), /no staged changes/);
  await prepare(uri);
  assert.equal(additions, 1, 'empty index stages the working tree including new files');
  repository.state.indexChanges = [];
  repository.state.workingTreeChanges = [];
  repository.state.untrackedChanges = [];
  await assert.rejects(prepare(uri), /no changes to commit/);
  repository.state.mergeChanges = ['conflict'];
  await assert.rejects(prepare(uri), /Resolve merge conflicts/);
  await assert.rejects(commit(uri, 'Conflicted title'), /Resolve merge conflicts/);
  assert.equal(additions, 1, 'clean and conflicted repositories do not stage anything');
  assert.equal(await command({ scheme: 'file', fsPath: '/selected' }), 'Fix generation');
  assert.equal(active, true, 'activate Codex before looking for its bridge');
  assert.equal(progress, 1, 'missing optional bridge still generates from the staged diff');
  bridgeInstalled = true;
  expectedContext = snapshot;
  assert.equal(await command({ scheme: 'file', fsPath: '/selected' }), 'Fix generation');
  assert.equal(progress, 2);
  expectedContext = '';
  for (const message of [
    'Open a Codex conversation with text in this window first.',
    'The Codex view closed before its text could be captured.',
    'Codex text capture timed out.',
    'The Codex view is unavailable.'
  ]) {
    captureError = new Error(message);
    assert.equal(await command(uri), 'Fix generation', message);
  }
  captureError = undefined;
  for (const value of ['', undefined, null, { text: 'Invalid snapshot' }]) {
    snapshot = value;
    assert.equal(await command(uri), 'Fix generation', 'empty or invalid optional snapshots use the diff');
  }
  active = false;
  activationError = new Error('Codex activation failed');
  assert.equal(await command(uri), 'Fix generation', 'Codex activation is optional');
  activationError = undefined;
  discoveryError = new Error('Command discovery failed');
  assert.equal(await command(uri), 'Fix generation', 'bridge discovery is optional');
  assert.equal(additions, 1, 'message generation does not stage additional changes');
  repository.state.mergeChanges = [];
  repository.state.indexChanges = [];
  repository.state.workingTreeChanges = [
    { uri: { fsPath: '/selected/edited file' }, status: 5 },
    { uri: { fsPath: '/selected/deleted file' }, status: 6 },
    { uri: { fsPath: '/selected/new file' }, status: 7 }
  ];
  repository.state.untrackedChanges = [{ uri: { fsPath: '/selected/new file' }, status: 7 }];
  gitSettings.smartCommitChanges = 'tracked';
  expectedPaths = ['/selected/edited file', '/selected/deleted file'];
  await prepare(uri);
  assert.equal(additions, 2, 'tracked smart commits exclude new files from either Git group');
  expectedPaths = ['/selected/edited file', '/selected/deleted file', '/selected/new file'];
  await prepare(uri, { all: true });
  assert.equal(additions, 3, 'explicit Commit All includes working changes even when some files are staged');
  expectedPaths = ['/selected/edited file', '/selected/deleted file'];
  await prepare(uri, { all: 'tracked' });
  assert.equal(additions, 4, 'explicit tracked mode preserves untracked files');
  console.log('Local Codex commit command checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
