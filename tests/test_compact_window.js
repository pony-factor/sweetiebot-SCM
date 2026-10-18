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
function documentFixture() {
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
  assert.equal(calls.length, 1, 'Double clicks cannot overwrite saved bounds');
  assert.deepEqual(calls[0], { bounds: { x: -1020, y: 163, width: 600, height: 600 }, options: { targetWindowId: 7 } });
  assert.ok(calls[0].bounds.width >= 600, 'Keep VS Code vertical-panel native minimum and resizable columns');
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
  assert.deepEqual(calls.at(-1).bounds, { x: -1300, y: 80, width: 1000, height: 760 });
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
    bounds: { x: -1020, y: 163, width: 600, height: 600 },
    options: { targetWindowId: 7 }
  }]);
  assert.equal(session.action().attrs['aria-pressed'], 'true');
  session.rebuild();
  assert.equal(sessionCalls.length, 1, 'Title-bar remount does not resize a second time');
  session.action().events.click(event);
  await flush();
  assert.deepEqual(sessionCalls.at(-1).bounds, { x: -1300, y: 80, width: 1000, height: 760 });
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
  ctx.scmToolkitMountCompactWindow(moving, { async positionWindow(bounds) {
    moves.push(JSON.parse(JSON.stringify(bounds)));
  } });
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
  assert.deepEqual(moves.at(-1), { x: 120, y: 90, width: 600, height: 600 });
  await moving.checkDisplay();
  assert.equal(moves.length, 2, 'A display transition resizes only once');
  assert.equal(moving.action().attrs['aria-pressed'], 'true');
  moving.action().events.click(event);
  await flush();
  assert.deepEqual(moves.at(-1), { x: -1300, y: 80, width: 1000, height: 760 });
  assert.equal(moving.checkDisplay, null, 'Restore stops watching display changes');

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
  assert.equal(sessionCalls.at(-1).bounds.width, 600);
  assert.equal(sessionCalls.at(-1).bounds.height, 600);

  const other = documentFixture();
  ctx.scmToolkitMountCompactWindow(other, native);
  assert.notEqual(doc.__sweetiebotCompactWindow, other.__sweetiebotCompactWindow, 'Each window owns its restore state');
  // A tighter display still receives a centered square with reduced gutters.
  const narrow = documentFixture();
  narrow.defaultView.screen = { availLeft: 1920, availTop: 24, availWidth: 625, availHeight: 650 };
  ctx.scmToolkitMountCompactWindow(narrow, native);
  narrow.action().events.click(event);
  assert.deepEqual(calls.at(-1).bounds, { x: 1933, y: 49, width: 600, height: 600 });
  release(); await flush();
  narrow.action().events.click(event);
  assert.deepEqual(calls.at(-1).bounds, { x: -1300, y: 80, width: 1000, height: 760 });
  release(); await flush();

  // Native VS Code cannot fit its side-panel minimum on a smaller display.
  // Do not request dimensions it will clamp into a rectangle or scrollable layout.
  const small = documentFixture();
  small.defaultView.screen = { availLeft: 1920, availTop: 24, availWidth: 450, availHeight: 390 };
  ctx.scmToolkitMountCompactWindow(small, native);
  const attempted = calls.length;
  small.action().events.click(event);
  assert.equal(calls.length, attempted, 'Too-small displays leave the native layout alone');
  assert.equal(small.action().title, 'Display too small for a 600px square window');
  assert.equal(small.action().attrs['aria-pressed'], 'false');
  small.defaultView.screen = { availLeft: 1920, availTop: 24, availWidth: 650, availHeight: 720 };
  small.action().events.click(event);
  assert.deepEqual(calls.at(-1).bounds, { x: 1945, y: 84, width: 600, height: 600 });
  release(); await flush();
  small.action().events.click(event);
  assert.deepEqual(calls.at(-1).bounds, { x: -1300, y: 80, width: 1000, height: 760 });
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
