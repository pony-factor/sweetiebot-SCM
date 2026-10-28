'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = {};
const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
vm.runInNewContext(source.slice(0, source.indexOf('function scmToolkitDeferActionButtonUpdate')), sandbox);

(async () => {
  for (const approval of [true, false, undefined]) {
    const requests = [];
    const home = { path: '/Users/Example/', with: value => ({ scheme: 'file', ...value }) };
    const result = await sandbox.scmToolkitRequestIndependentWorkspaceTrust(home, {
      async requestResourcesTrust(request) { requests.push(request); return approval; }
    }, '/attacker-controlled-path');
    assert.equal(result, approval);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].uri.path, '/Users/Example/Library/Application Support/Sweetiebot/Workspaces');
    assert.match(requests[0].message, /ALL existing and future repositories/);
    assert.match(requests[0].message, /Only approve/);
  }
  console.log('Native parent-folder trust request checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
