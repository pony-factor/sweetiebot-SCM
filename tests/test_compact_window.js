'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('assets/workbench/picker.js', 'utf8');
const watched = [];
const ctx = vm.createContext({
  console: { error() {} },
  scmToolkitWatchSpellcheckPopups(doc, commands) { watched.push({doc, commands}); }
});
vm.runInContext(source.slice(source.indexOf('function scmToolkitMountCompactWindow(')), ctx);
const renderedTheme = {'--vscode-editor-background':'#101010','--vscode-foreground':'#eeeeee','--vscode-button-background':'#00aa55'};
const palette=ctx.scmToolkitKefaniaThemeColors({
  querySelector(){return {};},
  defaultView:{getComputedStyle(){return {getPropertyValue:key=>renderedTheme[key]||''};},CSS:{supports:()=>true}}
});
assert.equal(palette.button,'#00aa55','Use the rendered theme accent, including user overrides');
assert.equal(palette.bg,'#101010');
function documentFixture(storage = new Map()) {
  const elements = new Map();
  const doc = {
    body: {},
    getElementById: id => elements.get(id),
    createElement: () => ({
      attrs: {}, events: {}, classList: { toggle() {} },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(key, fn) { this.events[key] = fn; },
      appendChild(child) { this.child = child; if (child.id) elements.set(child.id, child); },
      querySelector() { return this.child; },
      prepend(item) { elements.set(item.id, item); }
    }),
    querySelector: selector => {
      assert.equal(selector, '.part.titlebar .titlebar-left');
      return { querySelector() { return null; }, appendChild() {} };
    },
    defaultView: {
      localStorage: {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, value); }
      },
      vscodeWindowId: 7, screenX: -1300, screenY: 80, outerWidth: 1000, outerHeight: 760,
      screen: { availLeft: -1440, availTop: 25, availWidth: 1440, availHeight: 875 },
      MutationObserver: class { constructor(fn) { doc.remount = fn; } observe() {} disconnect() {} },
      addEventListener() {},
      setInterval(callback) { doc.checkDisplay = callback; return 1; },
      clearInterval() { doc.checkDisplay = null; }
    }
  };
  doc.action = () => elements.get('sweetiebot-compact-window-action').child;
  doc.newWindowAction = () => elements.get('sweetiebot-new-workspace-window-action').child;
  doc.item = id => elements.get(id);
  doc.rebuild = () => { elements.clear(); doc.remount(); };
  return doc;
}
const event = { preventDefault() {}, stopPropagation() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const doc = documentFixture();
  const calls = [];
  let release;
  let fail = false;
  const native = { positionWindow(bounds, options) {
    calls.push(JSON.parse(JSON.stringify({ bounds, options })));
    if (fail) return Promise.reject(new Error('native failure'));
    return new Promise(resolve => { release = resolve; });
  } };
  ctx.scmToolkitMountCompactWindow(doc, native);
  assert.equal(calls.length, 0, 'Regular windows do not automatically compact');
  doc.action().events.click(event);
  doc.action().events.click(event);
  await flush();
  assert.equal(calls.length, 1, 'Double clicks cannot overwrite saved bounds');
  assert.deepEqual(calls[0], { bounds: { x: -1440, y: 143, width: 640, height: 640 }, options: { targetWindowId: 7 } });
  assert.ok(calls[0].bounds.width >= 640, 'Keep VS Code vertical-panel native minimum and resizable columns');
  release(); await flush();
  assert.equal(doc.action().attrs['aria-pressed'], 'true');
  doc.rebuild();
  assert.equal(doc.action().attrs['aria-pressed'], 'true', 'Remount preserves restore state');
  fail = true;
  doc.action().events.keydown({ ...event, key: 'Enter' });
  await flush();
  assert.equal(doc.action().attrs['aria-pressed'], 'true', 'Failed restore keeps original bounds');
  assert.equal(doc.action().title, 'Could not resize window; click to retry');
  fail = false;
  doc.action().events.keydown({ ...event, key: ' ' });
  assert.deepEqual(calls.at(-1).bounds, { x: -1260, y: 135, width: 1080, height: 656 });
  release(); await flush();
  assert.equal(doc.action().attrs['aria-pressed'], 'false');
  // Dedicated PR workspaces start square, and their title-bar button still restores size.
  const session = documentFixture();
  const sessionCalls = [];
  const sessionNative = { async positionWindow(bounds, options) {
    sessionCalls.push(JSON.parse(JSON.stringify({ bounds, options })));
  } };
  let autoCompact = true;
  let changed;
  const sessionConfiguration = {
    getValue(key) { return key === 'scmToolkit.startCompactPRSession' ? autoCompact : true; },
    onDidChangeConfiguration(callback) { changed = callback; return { dispose() {} }; },
  };
  ctx.scmToolkitMountCompactWindow(session, sessionNative, null, sessionConfiguration);
  await flush();
  assert.deepEqual(sessionCalls, [{
    bounds: { x: -1440, y: 143, width: 640, height: 640 },
    options: { targetWindowId: 7 }
  }]);
  assert.equal(session.action().attrs['aria-pressed'], 'true');
  session.rebuild();
  assert.equal(sessionCalls.length, 1, 'Title-bar remount does not resize a second time');
  session.action().events.click(event);
  await flush();
  assert.deepEqual(sessionCalls.at(-1).bounds, { x: -1260, y: 135, width: 1080, height: 656 });
  assert.equal(session.action().attrs['aria-pressed'], 'false');
  autoCompact = false;
  changed({ affectsConfiguration: key => key === 'scmToolkit.startCompactPRSession' });
  autoCompact = true;
  changed({ affectsConfiguration: key => key === 'scmToolkit.startCompactPRSession' });
  await flush();
  assert.equal(sessionCalls.length, 2, 'Setting changes never reapply automatic compaction');

  // Cross-display resizing must preserve compact size at the drag destination.
  const moving = documentFixture();
  const moves = [];
  const nativeOrder = [];
  ctx.scmToolkitMountCompactWindow(moving, {
    async unmaximizeWindow(options) {
      assert.equal(options.targetWindowId, 7);
      nativeOrder.push('unmaximize');
    },
    async positionWindow(bounds) {
      nativeOrder.push('position');
      moves.push(JSON.parse(JSON.stringify(bounds)));
    }
  });
  moving.action().events.click(event);
  await flush();
  moving.defaultView.screenX = 120;
  moving.defaultView.screenY = 90;
  moving.defaultView.outerWidth = 1000;
  moving.defaultView.outerHeight = 760;
  await moving.checkDisplay();
  assert.equal(moves.length, 1, 'Same-display manual resizing stays available');
  moving.defaultView.screen = { availLeft: 0, availTop: 25, availWidth: 1920, availHeight: 1055 };
  await moving.checkDisplay();
  assert.deepEqual(moves.at(-1), { x: 120, y: 90, width: 640, height: 640 });
  await moving.checkDisplay();
  assert.equal(moves.length, 2, 'A display transition resizes only once');
  assert.equal(moving.action().attrs['aria-pressed'], 'true');
  // A title-bar double-click/native fill must stay expanded on this display.
  moving.defaultView.outerWidth = 1920;
  moving.defaultView.outerHeight = 1055;
  await moving.checkDisplay();
  assert.equal(moves.length, 2, 'Native fill is not undone by compact sizing');
  assert.equal(moving.action().attrs['aria-pressed'], 'false');
  assert.equal(moving.checkDisplay, null, 'Expansion stops compact display enforcement');
  moving.action().events.click(event);
  await flush();
  assert.deepEqual(moves.at(-1), { x: 0, y: 233, width: 640, height: 640 });

  // Windows share a row allocator, wrap below it, and reuse released slots.
  const storage = new Map();
  const compacted = [];
  const tiled = [];
  for (let id = 1; id <= 4; id++) {
    const windowDoc = documentFixture(storage);
    windowDoc.defaultView.vscodeWindowId = id;
    windowDoc.defaultView.screen = { availLeft: -1440, availTop: 25, availWidth: 1440, availHeight: 2560 };
    ctx.scmToolkitMountCompactWindow(windowDoc, {
      async positionWindow(bounds) {
        compacted.push(JSON.parse(JSON.stringify(bounds)));
      }
    });
    tiled.push(windowDoc);
    windowDoc.action().events.click(event);
    await flush();
  }
  assert.deepEqual(compacted, [
    { x: -1440, y: 985, width: 640, height: 640 },
    { x: -800, y: 985, width: 640, height: 640 },
    { x: -1440, y: 1625, width: 640, height: 640 },
    { x: -800, y: 1625, width: 640, height: 640 }
  ]);
  tiled[0].action().events.click(event);
  await flush();
  tiled[0].action().events.click(event);
  await flush();
  assert.deepEqual(compacted.at(-1), compacted[0], 'Expansion frees the first slot for reuse');

  // Concurrent renderer requests are serialized; closed windows do not hold slots.
  const concurrentStorage = new Map();
  concurrentStorage.set('sweetiebot.compact-window-placements.v1', JSON.stringify({
    99: { display: '-1440:25:1440:875', slot: 0 }
  }));
  let pendingLock = Promise.resolve();
  const locks = { request(name, callback) {
    const result = pendingLock.then(callback);
    pendingLock = result.catch(() => {});
    return result;
  } };
  const concurrent = [];
  const concurrentBounds = [];
  for (const id of [20, 21]) {
    const windowDoc = documentFixture(concurrentStorage);
    windowDoc.defaultView.vscodeWindowId = id;
    windowDoc.defaultView.navigator = { locks };
    ctx.scmToolkitMountCompactWindow(windowDoc, {
      async getWindows() { return [{ id: 20 }, { id: 21 }]; },
      async positionWindow(bounds) { concurrentBounds.push(JSON.parse(JSON.stringify(bounds))); }
    });
    concurrent.push(windowDoc);
  }
  concurrent.forEach(windowDoc => windowDoc.action().events.click(event));
  await flush();
  assert.deepEqual(concurrentBounds, [
    { x: -1440, y: 143, width: 640, height: 640 },
    { x: -800, y: 143, width: 640, height: 640 }
  ], 'Simultaneous clicks reserve distinct slots and reclaim closed-window slots');

  const separate = documentFixture(concurrentStorage);
  separate.defaultView.vscodeWindowId = 22;
  separate.defaultView.screen = { availLeft: 0, availTop: 25, availWidth: 1920, availHeight: 1055 };
  let separateBounds;
  ctx.scmToolkitMountCompactWindow(separate, {
    async positionWindow(bounds) { separateBounds = JSON.parse(JSON.stringify(bounds)); }
  });
  separate.action().events.click(event);
  await flush();
  assert.deepEqual(separateBounds, { x: 0, y: 233, width: 640, height: 640 },
    'Each display starts its own row');

  const rejected = documentFixture(concurrentStorage);
  rejected.defaultView.vscodeWindowId = 23;
  ctx.scmToolkitMountCompactWindow(rejected, {
    async positionWindow() { throw new Error('native failure'); }
  });
  rejected.action().events.click(event);
  await flush();
  assert.equal(JSON.parse(concurrentStorage.get('sweetiebot.compact-window-placements.v1'))[23], undefined,
    'A failed resize releases its reservation');

  // Workspace configuration may arrive after the workbench mounts.
  const late = documentFixture();
  let lateEnabled = false;
  let lateChanged;
  const lateConfiguration = {
    getValue(key) { return key === 'scmToolkit.startCompactPRSession' ? lateEnabled : true; },
    onDidChangeConfiguration(callback) { lateChanged = callback; return { dispose() {} }; },
  };
  ctx.scmToolkitMountCompactWindow(late, sessionNative, null, lateConfiguration);
  assert.equal(sessionCalls.length, 2, 'No resize before the session setting arrives');
  lateEnabled = true;
  lateChanged({ affectsConfiguration: key => key === 'scmToolkit.startCompactPRSession' });
  await flush();
  assert.equal(sessionCalls.length, 3, 'Late session setting applies compact layout once');
  assert.equal(sessionCalls.at(-1).bounds.width, 640);
  assert.equal(sessionCalls.at(-1).bounds.height, 640);

  const other = documentFixture();
  ctx.scmToolkitMountCompactWindow(other, native);
  assert.notEqual(doc.__sweetiebotCompactWindow, other.__sweetiebotCompactWindow, 'Each window owns its restore state');
  // A tighter display still compacts in place.
  const narrow = documentFixture();
  narrow.defaultView.screen = { availLeft: 1920, availTop: 24, availWidth: 665, availHeight: 690 };
  narrow.defaultView.screenX = 1930;
  narrow.defaultView.screenY = 40;
  ctx.scmToolkitMountCompactWindow(narrow, native);
  narrow.action().events.click(event);
  await flush();
  assert.deepEqual(calls.at(-1).bounds, { x: 1920, y: 49, width: 640, height: 640 });
  release(); await flush();
  narrow.action().events.click(event);
  await flush();
  assert.deepEqual(calls.at(-1).bounds, { x: 1953, y: 110, width: 600, height: 518 });
  release(); await flush();

  // Native VS Code cannot fit its side-panel minimum on a smaller display.
  // Do not request dimensions it will clamp into a rectangle or scrollable layout.
  const small = documentFixture();
  small.defaultView.screen = { availLeft: 1920, availTop: 24, availWidth: 450, availHeight: 390 };
  ctx.scmToolkitMountCompactWindow(small, native);
  const attempted = calls.length;
  small.action().events.click(event);
  assert.equal(calls.length, attempted, 'Too-small displays leave the native layout alone');
  assert.equal(small.action().title, 'Display too small for a 640px square window');
  assert.equal(small.action().attrs['aria-pressed'], 'false');
  small.defaultView.screen = { availLeft: 1920, availTop: 24, availWidth: 650, availHeight: 720 };
  small.defaultView.screenX = 1925;
  small.defaultView.screenY = 60;
  small.action().events.click(event);
  await flush();
  assert.deepEqual(calls.at(-1).bounds, { x: 1920, y: 64, width: 640, height: 640 });
  release(); await flush();
  small.action().events.click(event);
  await flush();
  assert.deepEqual(calls.at(-1).bounds, { x: 1945, y: 114, width: 600, height: 540 });
  release(); await flush();
  // The workbench's titlebar still installs the popup consumer when the SCM
  // widget is absent and compact-window resizing is unavailable.
  const withoutSCM = documentFixture();
  const spellcheckCommands = {executeCommand() {}};
  ctx.scmToolkitMountCompactWindow(withoutSCM, undefined, spellcheckCommands);
  assert.equal(watched.at(-1).doc, withoutSCM);
  assert.equal(watched.at(-1).commands, spellcheckCommands);
  assert.equal(withoutSCM.__sweetiebotCompactWindow, undefined);
  const workspace = documentFixture();
  const commands = [];
  let openRelease;
  let openFail = false;
  const visibility = { compactWindowButton: true, newWorkspaceWindowButton: true };
  let visibilityChanged;
  const configuration = {
    getValue: key => visibility[key.replace('scmToolkit.', '')],
    onDidChangeConfiguration(callback) { visibilityChanged = callback; return { dispose() {} }; }
  };
  ctx.scmToolkitMountCompactWindow(workspace, native, { executeCommand(id) {
    commands.push(id);
    if (openFail) return Promise.reject(new Error('open failure'));
    return new Promise(resolve => { openRelease = resolve; });
  } }, configuration);
  const compactItem = () => workspace.item('sweetiebot-compact-window-action');
  const newItem = () => workspace.item('sweetiebot-new-workspace-window-action');
  const refresh = () => visibilityChanged({ affectsConfiguration: () => true });
  assert.equal(compactItem().hidden, false);
  assert.equal(newItem().hidden, false);
  visibility.compactWindowButton = false; refresh();
  assert.equal(compactItem().hidden, true);
  assert.equal(newItem().hidden, false, 'Workspace button stays independent');
  visibility.newWorkspaceWindowButton = false; refresh();
  assert.equal(newItem().hidden, true);
  visibility.compactWindowButton = true; refresh();
  assert.equal(compactItem().hidden, false);
  assert.equal(newItem().hidden, true, 'Sizing button stays independent');
  visibility.newWorkspaceWindowButton = true; refresh();
  workspace.newWindowAction().events.click(event);
  workspace.newWindowAction().events.click(event);
  assert.deepEqual(commands, ['sweetiebot.openIndependentWorkspace']);
  assert.equal(workspace.newWindowAction().attrs['aria-disabled'], 'true');
  openRelease(); await flush();
  assert.equal(workspace.newWindowAction().attrs['aria-disabled'], 'false');
  workspace.rebuild();
  openFail = true;
  workspace.newWindowAction().events.keydown({ ...event, key: 'Enter' });
  await flush();
  assert.equal(workspace.newWindowAction().title, 'Could not open workspace in new window; click to retry');
  openFail = false;
  workspace.newWindowAction().events.keydown({ ...event, key: ' ' });
  openRelease(); await flush();
  assert.equal(workspace.newWindowAction().title, 'Open independent workspace from main');
  console.log('Compact window native resize, restore, failure, remount, and isolation checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
