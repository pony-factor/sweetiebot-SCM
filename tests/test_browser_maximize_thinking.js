'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/browser/maximize_thinking.js'), 'utf8');

function fixture({slider = false, blocked = false, generic = false} = {}) {
  let now = 0, opened, current = 0;
  const status = new Map();
  const element = (text, attrs = {}) => ({textContent: text, isConnected: true,
    getAttribute: key => attrs[key] ?? null, hasAttribute: key => key in attrs,
    setAttribute(key, value) {attrs[key] = String(value);},
    getClientRects: () => [1],
    remove() {status.delete(this.id);},
    dispatchEvent(event) { if (event.type === 'keydown' && event.key === 'Escape') opened = undefined; },
    click() {}, querySelector: () => null, querySelectorAll: () => []});
  const controls = [];
  function addControl(name, choices, useSlider = false) {
    const trigger = element(generic ? name : choices[0], {'aria-label': name, 'aria-haspopup': 'menu'});
    const options = choices.map((value, index) => {
      const option = element(value, {'aria-checked': String(index === 0)});
      option.click = () => {
        if (blocked) return;
        for (const item of options) item.setAttribute('aria-checked', 'false');
        option.setAttribute('aria-checked', 'true');
        if (!generic) trigger.textContent = value;
        opened = undefined;
      };
      return option;
    });
    const range = element('', {'aria-valuenow': '0', 'aria-valuemax': '3'});
    range.closest = () => range;
    range.dispatchEvent = event => {
      if (!blocked && event.type === 'keydown' && event.key === 'ArrowRight') {
        current = Math.min(3, current + 1);
        range.setAttribute('aria-valuenow', String(current));
      }
    };
    const menu = element('');
    menu.querySelector = () => useSlider ? range : null;
    menu.querySelectorAll = () => options;
    trigger.click = () => {opened = opened === menu ? undefined : menu;};
    trigger.dispatchEvent = event => {
      if (event.type === 'keydown' && event.key === 'ArrowDown') opened = menu;
      if (event.type === 'keydown' && event.key === 'Escape') opened = undefined;
    };
    controls.push(trigger);
    return {trigger, options};
  }
  const effort = addControl('Thinking effort', slider ? ['Instant'] : ['Instant', 'High', 'Maximum'], slider);
  const time = addControl('Thinking time', ['Standard', 'Extended', 'Heavy']);
  const composer = {parentElement: {append(node) {status.set(node.id, node);}}};
  const context = {Date: {now: () => now},
    KeyboardEvent: class {constructor(type, values) {this.type = type; Object.assign(this, values);}},
    document: {
      getElementById: id => status.get(id), createElement: () => element(''),
      querySelector: () => composer,
      querySelectorAll: query => query.includes('[role="menu"]') ? (opened ? [opened] : []) : controls,
    }};
  vm.runInNewContext(source, context);
  const ensure = context.sweetiebotEnsureMaximumThinking;
  return {ensure, effort, time, controls, status, current: () => current,
    tick(ms = 600) {now += ms; return ensure();}, opened: () => opened};
}
for (const generic of [false, true]) {
  const f = fixture({generic});
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) ready = f.tick();
  assert.equal(ready, true, 'Confirm both effort and thinking time');
  assert.equal(f.effort.options[2].getAttribute('aria-checked'), 'true');
  assert.equal(f.time.options[2].getAttribute('aria-checked'), 'true');
  assert.equal(f.opened(), undefined);
  assert.equal(f.status.size, 0);
}
const slider = fixture({slider: true});
let ready = false;
for (let i = 0; i < 30 && !ready; i++) ready = slider.tick();
assert.equal(ready, true);
assert.equal(slider.current(), 3, 'Use aria-valuemax rather than a hard-coded High setting');
const blocked = fixture({blocked: true});
for (let i = 0; i < 100; i++) assert.equal(blocked.tick(), false, 'Never confirm an ignored selection');
blocked.ensure.cancel();
assert.equal(blocked.status.size, 0);
const delayed = fixture();
const controls = delayed.controls.splice(0);
assert.equal(delayed.ensure(), false, 'Wait for delayed thinking controls');
delayed.controls.push(...controls);
for (let i = 0; i < 30 && !delayed.tick(); i++);
assert.equal(delayed.ensure(), true);
delayed.effort.trigger.textContent = 'Instant';
assert.equal(delayed.ensure(), false, 'Recheck if the selected effort changes before Send');
console.log('Maximum thinking: slider, menus, generic labels, delayed hydration, ignored selection, and setting changes passed.');
