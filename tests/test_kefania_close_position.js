'use strict';
const assert = require('node:assert/strict');
const { kefaniaClosePosition, normalizeKefaniaClosePosition } = require('../efs/codex/kefania_close_position');

for (const position of ['left','middle','right']) {
  assert.equal(normalizeKefaniaClosePosition(position), position);
  assert.equal(kefaniaClosePosition({
    get(key, fallback) { return key === 'kefaniaCloseButtonPosition' ? position : fallback; },
    inspect() { return {globalValue: position}; },
  }), position);
}
for (const invalid of [undefined, null, false, 'center', '', 'LEFT']) {
  assert.equal(normalizeKefaniaClosePosition(invalid), 'left');
}
assert.equal(kefaniaClosePosition({
  get(key, fallback) { return key === 'kefaniaCloseButtonLeft' ? false : fallback; },
  inspect() { return {globalValue:undefined,workspaceValue:undefined,workspaceFolderValue:undefined}; },
}), 'right', 'Legacy right preference must survive the new schema default');
assert.equal(kefaniaClosePosition({
  get(key, fallback) { return key === 'kefaniaCloseButtonLeft' ? false : key === 'kefaniaCloseButtonPosition' ? 'middle' : fallback; },
  inspect() { return {globalValue:'middle'}; },
}), 'middle', 'An explicit dropdown choice must override the legacy right preference');
console.log('Kefania close position normalization and legacy migration passed.');
