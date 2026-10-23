'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the actual dashboard handlers with controlled pane geometry.
function fixture(saved = {}) {
  const nodes = {};
  function node(id, width = 0, height = 0) {
    const item = nodes[id] = {
      clientWidth: width, clientHeight: height, offsetWidth: width, offsetHeight: height,
      handlers: {}, attrs: {}, captured: null,
      style: { setProperty(key, value) {
        if (key === '--sidebar-width') nodes.aside.clientWidth = parseFloat(value);
        if (key === '--timeline-height') nodes.timeline.offsetHeight = parseFloat(value);
      } },
      classList: { add() {}, remove() {} },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      focus() {}, setPointerCapture(id) { this.captured = id; },
      hasPointerCapture(id) { return this.captured === id; },
      releasePointerCapture() { this.captured = null; },
      querySelector() { return nodes.heading; },
    };
    return item;
  }
  node('layout', 1000, 600);
  node('aside', 370, 600);
  node('heading', 0, 70);
  node('timeline', 0, 170);
  node('details-splitter', 6, 600);
  node('timeline-splitter', 370, 6);
  node('body');
  let state = saved;
  let resize;
  const context = {
    acquireVsCodeApi: () => ({ getState: () => state, setState: value => { state = value; } }),
    document: { getElementById: id => nodes[id], body: nodes.body,
      querySelector: selector => nodes[selector === '.layout' ? 'layout' : 'aside'] },
    window: { innerWidth: 1000 },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} },
  };
  const html = fs.readFileSync(require.resolve('../efs/merge_dashboard.html'), 'utf8');
  const script = html.slice(html.indexOf('  const vscode = acquireVsCodeApi();'), html.indexOf('  let model ='));
  vm.runInNewContext(script, context);
  const fire = (id, type, props) => nodes[id].handlers[type]({ preventDefault() {}, ...props });
  return { nodes, fire, resize: () => resize(), context, state: () => state };
}

const f = fixture({ unrelated: true });
const width = () => f.nodes.aside.clientWidth;
const height = () => f.nodes.timeline.offsetHeight;
assert.equal(width(), 994 * 0.37);
const initialHeight = height();
f.fire('timeline-splitter', 'pointerdown', { button: 0, pointerId: 1, clientY: 400 });
f.fire('timeline-splitter', 'pointermove', { pointerId: 2, clientY: 100 });
assert.equal(height(), initialHeight, 'Ignore another pointer during drag');
f.fire('timeline-splitter', 'pointermove', { pointerId: 1, clientY: 300 });
assert.equal(height(), initialHeight + 100, 'Dragging timeline top upward expands it');
f.fire('timeline-splitter', 'pointercancel', { pointerId: 1 });
assert.equal(f.nodes['timeline-splitter'].captured, null);
assert.equal(f.state().unrelated, true, 'Preserve unrelated webview state');
f.fire('details-splitter', 'pointerdown', { button: 0, pointerId: 3, clientX: width() });
f.fire('details-splitter', 'pointermove', { pointerId: 3, clientX: 5000 });
assert.equal(width(), 794, 'Keep at least 200px available for details');
f.fire('details-splitter', 'pointerup', { pointerId: 3 });
f.fire('details-splitter', 'keydown', { key: 'Home' });
assert.equal(width(), 160);
f.fire('details-splitter', 'keydown', { key: 'ArrowRight', shiftKey: true });
assert.equal(width(), 200);
f.fire('timeline-splitter', 'keydown', { key: 'End' });
assert.equal(height(), 424, 'Keep at least 100px for the PR list');
const restored = fixture(f.state());
assert.equal(restored.nodes.aside.clientWidth, width());
assert.equal(restored.nodes.timeline.offsetHeight, height());
f.nodes.layout.clientWidth = 700;
f.resize();
assert.equal(width(), 160, 'Keep the PR list readable when shrinking the window');
f.nodes.layout.clientWidth = 1200;
f.resize();
assert.equal(width(), 1194 * f.state().sidebarRatio, 'Restore saved proportions when space is available');
f.context.window.innerWidth = 600;
f.nodes.aside.clientHeight = 370;
f.resize();
assert.equal(height(), 194, 'Clamp timeline when switching to compact layout');
const invalid = fixture({ sidebarRatio: Infinity, timelineRatio: -3 });
assert.equal(invalid.nodes.aside.clientWidth, 994 * 0.37);
assert.equal(invalid.nodes.timeline.offsetHeight, 524 * 0.34);
console.log('Dashboard drag, keyboard, cancellation, saved layout and resize checks passed.');
