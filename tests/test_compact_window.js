'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('assets/workbench/picker.js', 'utf8');
const ctx = vm.createContext({ console: { error() {} } });
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
      addEventListener() {}
    }
  };
  doc.action = () => elements.get('sweetiebot-compact-window-action').child;
  doc.newWindowAction = () => elements.get('sweetiebot-new-workspace-window-action').child;
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
  doc.action().events.click(event);
  doc.action().events.click(event);
  assert.equal(calls.length, 1, 'Double clicks cannot overwrite saved bounds');
  assert.deepEqual(calls[0], { bounds: { x: -1000, y: 57, width: 560, height: 811 }, options: { targetWindowId: 7 } });
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
  const other = documentFixture();
  ctx.scmToolkitMountCompactWindow(other, native);
  assert.notEqual(doc.__sweetiebotCompactWindow, other.__sweetiebotCompactWindow, 'Each window owns its restore state');
  const workspace = documentFixture();
  const commands = [];
  let openRelease;
  let openFail = false;
  ctx.scmToolkitMountCompactWindow(workspace, native, { executeCommand(id) {
    commands.push(id);
    if (openFail) return Promise.reject(new Error('open failure'));
    return new Promise(resolve => { openRelease = resolve; });
  } });
  workspace.newWindowAction().events.click(event);
  workspace.newWindowAction().events.click(event);
  assert.deepEqual(commands, ['workbench.action.duplicateWorkspaceInNewWindow']);
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
  assert.equal(workspace.newWindowAction().title, 'Open workspace in new window');
  console.log('Compact window native resize, restore, failure, remount, and isolation checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
