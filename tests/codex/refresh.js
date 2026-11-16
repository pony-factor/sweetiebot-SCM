'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
const timers = new Map();
const intervals = new Map();
let enabled = true, installed = true, paused = false;
let revision = 'initial';
let releaseServer, stopping = false, reloads = 0;
let preserveCalls = 0, preserveAvailable = true, preserveFails = false;
const reloadEvents = [];
const notices = [];
let invalidations = 0;
let warningChoice;
const warningOptions = [];
const warnings = [];
const workspaceData = new Map();
const workspaceState = {
  get(key, fallback) { return workspaceData.has(key) ? workspaceData.get(key) : fallback; },
  update(key, value) { workspaceData.set(key, value); return Promise.resolve(); }
};
const delays = [];
let timerId = 0, changed, configurationChanged, focusChanged, extensionPath = '/extensions/codex-old', launches = 0;
const children = [];
const sandbox = vm.createContext({
  module: { exports: {} }, process: { platform: 'darwin', env: {} },
  setInterval(fn) { intervals.set(++timerId, fn); return timerId; },
  clearInterval(id) { intervals.delete(id); },
  setTimeout(fn, delay) { delays.push(delay); timers.set(++timerId, fn); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  require(name) {
    if (name === 'path') return path;
    if (name === 'os') return { homedir() { return '/test-home'; } };
    if (name === 'fs') return {
      existsSync(file) { assert.equal(file, '/test-home/.config/sweetiebot/pause-app-repair'); return paused; },
      unlinkSync(file) { assert.equal(file, '/test-home/.config/sweetiebot/pause-app-repair'); paused = false; }
    };
    if (name === '../ui/runtime-revision') return { runtimeRevision() { return revision; } };
    if (name === '../ui/extension-cache') return { invalidateUserExtensionCache() { invalidations++; return true; } };
    if (name === '../ui/reload-guard') return require('../../extension/ui/reload-guard');
    assert.equal(name, 'child_process');
    return { spawn(executable, args) {
      launches++;
      assert.equal(executable, 'python3');
      assert.deepEqual(Array.from(args), ['/toolkit/codex-customizations/scripts/repair.py',
        '--app', '/Custom/Code.app', ...(installed ? ['--codex-extension', extensionPath] : [])]);
      const callbacks = new Map();
      const child = { stdout: { on(event, fn) { callbacks.set('stdout', fn); } }, stderr: { on() {} },
        on(event, fn) { callbacks.set(event, fn); },
        kill() { this.killed = true; }, callbacks };
      children.push(child);
      return child;
    } };
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extension/codex/refresh.js'), 'utf8'), sandbox);
const context = { subscriptions: [], extensionUri: { fsPath: '/toolkit' }, workspaceState };
const vscode = {
  env: { appRoot: '/Custom/Code.app/Contents/Resources/app' },
  ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration() { return { get() { return enabled; }, async update(key, value, target) {
    assert.equal(key, 'automaticAppRepair'); assert.equal(target, 1); enabled = value;
  } }; },
    onDidChangeConfiguration(fn) { configurationChanged = fn; return { dispose() {} }; } },
  commands: {
    async getCommands() {
      return preserveAvailable ? ['sweetiebot.preserveCodexConversation'] : [];
    },
    async executeCommand(command) {
      if (command === 'sweetiebot.preserveCodexConversation') {
        preserveCalls++;
        reloadEvents.push('preserve');
        if (preserveFails) throw new Error('Codex view closed during capture');
        return true;
      }
      assert.equal(command, 'workbench.action.reloadWindow');
      reloadEvents.push('reload');
      reloads++;
    }
  },
  Uri: { joinPath(uri, ...parts) { return { fsPath: [uri.fsPath, ...parts].join('/') }; } },
  window: { onDidChangeWindowState(fn) { focusChanged = fn; return { dispose() {} }; }, showInformationMessage(message) { notices.push(message); return Promise.resolve(); }, showWarningMessage(message, ...options) { warnings.push(message); warningOptions.push(options); return Promise.resolve(warningChoice); }, createOutputChannel() { return { append() {}, appendLine() {}, dispose() {} }; } },
  extensions: {
    getExtension() { return installed ? { extensionPath } : undefined; },
    onDidChange(fn) { changed = fn; return { dispose() {} }; }
  }
};
function tick() {
  const [id, fn] = timers.entries().next().value;
  timers.delete(id); fn();
}
sandbox.module.exports.registerCodexRefresh(vscode, context, () => {
  stopping = true;
  return new Promise(resolve => { releaseServer = resolve; });
});
timers.clear();
configurationChanged({ affectsConfiguration(key) { return key === 'sweetiebot.messagePlaceholder'; } });
assert.equal(timers.size, 0, 'unrelated live settings do not request app repair');
configurationChanged({ affectsConfiguration(key) { return key === 'sweetiebot.sourceControlLabel'; } });
assert.equal(timers.size, 1, 'saving the Source Control label requests app repair without restarting first');
timers.clear();
configurationChanged({ affectsConfiguration(key) { return key === 'sweetiebot.messageBarLayout'; } });
assert.equal(timers.size, 1, 'saving message bar order requests app repair without restarting first');
tick();
assert.equal(launches, 1, 'startup repairs the selected Codex installation');
changed();
// Run the debounce timer, leaving the subprocess timeout alone.
const [id, fn] = [...timers.entries()].at(-1); timers.delete(id); fn();
assert.equal(launches, 1, 'update events cannot launch concurrent installers');
extensionPath = '/extensions/codex-new';
children[0].callbacks.get('close')(0);
tick();
assert.equal(launches, 2, 'queued repair resolves the new selected extension path');
children[1].callbacks.get('stdout')('Installed SCM toolkit for VS Code 1.0. Reload VS Code.');
revision = 'updated';
children[1].callbacks.get('close')(0);
assert.equal(notices.length, 0, 'reload is withheld until the quiet period elapses');
tick();
assert.equal(notices.length, 0, 'successful settled repair needs no reload prompt');
assert.equal(invalidations, 0, 'cache is not cleared before the reload is authorized');
await Promise.resolve();
assert.equal(stopping, true);
assert.equal(reloads, 0, 'reload waits for the old settings server to exit');
releaseServer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(reloads, 1);
assert.equal(preserveCalls, 1, 'Capture a visible Codex thread before reload');
assert.deepEqual(reloadEvents, ['preserve', 'reload'], 'Restore snapshot precedes reload');
assert.equal(invalidations, 1, 'the first reload invalidates the extension cache');
focusChanged({ focused: false });
assert.equal(timers.size, 0, 'unfocused windows do not repair');
revision = 'changed-by-another-window';
[...intervals.values()][0](); tick();
children.at(-1).callbacks.get('close')(0); tick();
assert.equal(reloads, 1, 'a repaired background window waits until focused');
assert.equal(preserveCalls, 1, 'Unfocused windows must not capture or reopen Codex threads');
assert.equal(invalidations, 1, 'background repair leaves the extension cache alone');
focusChanged({ focused: true });
tick();
assert.equal(launches, 4, 'returning to a stale window checks installed updates immediately');
children.at(-1).callbacks.get('close')(0);
tick();
assert.equal(notices.length, 0);
preserveFails = true;
await Promise.resolve(); releaseServer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(reloads, 2, 'a stale window automatically reloads after focus and repair');
assert.equal(preserveCalls, 2, 'The focused window attempts another capture');
assert.deepEqual(reloadEvents, ['preserve', 'reload', 'preserve', 'reload'],
  'Capture failure cannot prevent an otherwise authorized reload');
preserveFails = false;
assert.equal(invalidations, 2);
// A newly loaded window already has those bytes, even if the installer reports work again.
const reloaded = { ...context, subscriptions: [] };
const originalChanged = changed;
sandbox.module.exports.registerCodexRefresh(vscode, reloaded);
tick();
children.at(-1).callbacks.get('stdout')('Installed SCM toolkit for VS Code 1.0. Reload VS Code.');
children.at(-1).callbacks.get('close')(0);
tick();
assert.equal(reloads, 2, 'reloading does not reload the same update again');
assert.equal(invalidations, 2, 'an unchanged reloaded window does not touch the extension cache');
focusChanged({ focused: true });
assert.equal(timers.size, 0, 'an unchanged focused window does not repair');
reloaded.subscriptions.at(-1).dispose();
// A new activation in the same workspace must not oscillate between revisions.
revision = 'changed-by-another-window';
const looping = { ...context, subscriptions: [] };
sandbox.module.exports.registerCodexRefresh(vscode, looping);
tick();
revision = 'updated';
children.at(-1).callbacks.get('close')(0);
tick();
await new Promise(resolve => setImmediate(resolve));
assert.equal(reloads, 2, 'an already-reloaded revision cannot restart a loop');
assert.equal(invalidations, 2, 'a blocked reload does not invalidate caches');
assert.equal(warnings.length, 1, 'a reload loop is reported once');
looping.subscriptions.at(-1).dispose();
changed = originalChanged;
enabled = false; changed();
assert.equal(timers.size, 0, 'disabled repair does not queue a run');
assert.equal(launches, 6, 'disabled repair cannot launch');
enabled = true; installed = false;
[...intervals.values()][0](); tick();
assert.equal(launches, 7, 'workbench repair works without Codex installed');
context.subscriptions.at(-1).dispose();
assert.equal(children.at(-1).killed, true);
children.at(-1).callbacks.get('close')(0);
assert.equal(intervals.size, 0);
assert.equal(timers.size, 0, 'disposal cancels repair and its timeout');
const retryContext = { ...context, subscriptions: [], workspaceState: {
  get(_key, fallback) { return fallback; },
  update() { return Promise.resolve(); }
} };
sandbox.module.exports.registerCodexRefresh(vscode, retryContext);
tick();
const noticesBeforeBusy = notices.length;
children.at(-1).callbacks.get('close')(75);
assert.equal(notices.length, noticesBeforeBusy, 'a busy updater never offers a premature reload');
assert.equal(timers.size, 1, 'a busy updater schedules a retry');
tick();
assert.equal(launches, 9, 'the waiting window retries without a reload');
for (const delay of [15000, 60000, 300000]) {
  children.at(-1).callbacks.get('close')(1);
  assert.equal(timers.size, 1, 'failed repairs schedule a bounded retry');
  assert.equal(delays.at(-1), delay);
  tick();
}
children.at(-1).callbacks.get('close')(1);
assert.equal(timers.size, 0, 'persistent failures stop retrying until the next scheduled check');
assert.equal(notices.length, noticesBeforeBusy, 'failed repairs never offer a reload');
preserveAvailable = false;
changed(); tick();
revision = 'recovered';
children.at(-1).callbacks.get('close')(0);
tick();
await new Promise(resolve => setImmediate(resolve));
assert.equal(reloads, 3, 'an extension update automatically reloads after recovery');
assert.equal(preserveCalls, 2, 'Missing Codex command cannot block app repair or trigger a capture');
retryContext.subscriptions.at(-1).dispose();
paused = true;
const pausedContext = { ...context, subscriptions: [] };
const launchesBeforePause = launches;
sandbox.module.exports.registerCodexRefresh(vscode, pausedContext);
assert.equal(timers.size, 0, 'the shared pause flag suppresses startup repair even when the profile enables it');
changed();
focusChanged({ focused: true });
assert.equal(timers.size, 0, 'paused profiles cannot schedule repairs on update or focus');
assert.equal(launches, launchesBeforePause);
pausedContext.subscriptions.at(-1).dispose();
assert(warnings.at(-1).includes('shared stop flag'), 'a paused repair cannot silently strand an updated app');
assert.deepEqual(warningOptions.at(-1), ['Resume automatic repair']);
warningChoice = 'Resume automatic repair';
const resumed = { ...context, subscriptions: [] };
sandbox.module.exports.registerCodexRefresh(vscode, resumed);
await new Promise(setImmediate);
assert.equal(paused, false, 'explicit Resume removes the shared stop flag');
assert.equal(timers.size, 1, 'Resume queues repair immediately');
resumed.subscriptions.at(-1).dispose();
warningChoice = undefined;

// A failed optional update must still activate the successfully recovered UI.
sandbox.process.env.VSCODE_PID = '100';
const browserData = new Map();
const browserState = {
  get(key, fallback) { return browserData.has(key) ? browserData.get(key) : fallback; },
  async update(key, value) { browserData.set(key, value); }
};
const browserContext = { ...context, subscriptions: [], workspaceState: browserState };
sandbox.module.exports.registerCodexRefresh(vscode, browserContext);
tick();
const recoveredChild = children.at(-1);
recoveredChild.callbacks.get('stdout')('Sweetiebot core repair com');
recoveredChild.callbacks.get('stdout')('plete.\nBrowser session changes require a full VS Code quit and restart after installation; Reload Window is not sufficient.');
assert.equal(browserState.get('sweetiebot.browserProfileRestart'), '100');
assert(warnings.at(-1).includes('saved site sign-ins'));
revision = 'core-recovered-with-optional-failure';
const beforeCoreReload = reloads;
recoveredChild.callbacks.get('close')(1);
const [settleId, settle] = [...timers.entries()].at(-1);
timers.delete(settleId); settle();
await new Promise(setImmediate);
assert.equal(reloads, beforeCoreReload + 1, 'optional failure cannot withhold a completed core repair');
browserContext.subscriptions.at(-1).dispose();
const beforeRestartWarning = warnings.length;
const stillRunning = { ...browserContext, subscriptions: [] };
sandbox.module.exports.registerCodexRefresh(vscode, stillRunning);
assert.equal(warnings.length, beforeRestartWarning + 1, 'Reload Window retains the required full-restart notice');
stillRunning.subscriptions.at(-1).dispose();
sandbox.process.env.VSCODE_PID = '101';
const restarted = { ...browserContext, subscriptions: [] };
sandbox.module.exports.registerCodexRefresh(vscode, restarted);
assert.equal(warnings.length, beforeRestartWarning + 1, 'a new app process clears the restart notice');
restarted.subscriptions.at(-1).dispose();
// Browser executable changes participate in stale-window detection.
const { runtimeRevision } = require('../../extension/ui/runtime-revision');
const runtimeRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sweetiebot-runtime-test-'));
try {
  const appRoot = path.join(runtimeRoot, 'app');
  const extensionRoot = path.join(runtimeRoot, 'extensions', 'toolkit');
  fs.mkdirSync(extensionRoot, {recursive: true});
  fs.mkdirSync(path.join(appRoot, 'out/vs/platform/browserView/electron-browser'), {recursive: true});
  const nativeMain = path.join(appRoot, 'out/mainImpl.js');
  const preload = path.join(appRoot, 'out/vs/platform/browserView/electron-browser/preload-browserView.js');
  fs.writeFileSync(nativeMain, 'native main');
  fs.writeFileSync(preload, 'native preload');
  const runtime = () => runtimeRevision({env: {appRoot}, extensions: {getExtension() {}}}, {extensionPath: extensionRoot});
  const before = runtime();
  fs.writeFileSync(nativeMain, 'repaired main');
  const mainRepaired = runtime();
  assert.notEqual(before, mainRepaired);
  fs.writeFileSync(preload, 'repaired preload');
  assert.notEqual(mainRepaired, runtime());
} finally { fs.rmSync(runtimeRoot, {recursive: true, force: true}); }
console.log('Codex update repair lifecycle checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
