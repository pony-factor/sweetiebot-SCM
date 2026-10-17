'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const manifest = require('../efs/package.json');
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
assert.equal(manifest.main, './trust_activation.js');

async function fixture(trusted) {
  let grant;
  const calls = { loaded: 0, started: 0, stopped: 0, prompts: 0, registrations: 0 };
  const vscode = { workspace: {
    isTrusted: trusted,
    onDidGrantWorkspaceTrust(callback) { grant = callback; return { dispose() {} }; }
  } };
  const sandbox = { module: { exports: {} }, console, setImmediate,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === './workspace_trust') return {
        registerIndependentWorkspaceTrustCommand() { calls.registrations++; },
        async promptForIndependentWorkspaceTrust() { calls.prompts++; }
      };
      assert.equal(name, './extension');
      calls.loaded++;
      return {
        async activate() { calls.started++; },
        async deactivate() { calls.stopped++; }
      };
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../efs/trust_activation'), 'utf8'), sandbox);
  const extension = sandbox.module.exports;
  await extension.activate({ subscriptions: [] });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, extension, vscode, grant: () => grant() };
}

(async () => {
  const restricted = await fixture(false);
  assert.equal(restricted.calls.registrations, 1);
  assert.equal(restricted.calls.prompts, 1);
  assert.equal(restricted.calls.loaded, 0, 'Restricted startup must not even load trusted services');
  await restricted.extension.deactivate();
  assert.equal(restricted.calls.stopped, 0);
  restricted.vscode.workspace.isTrusted = true;
  restricted.grant();
  restricted.grant();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restricted.calls.loaded, 1);
  assert.equal(restricted.calls.started, 1, 'Trust transition starts normal services once');
  await restricted.extension.deactivate();
  assert.equal(restricted.calls.stopped, 1);
  const trusted = await fixture(true);
  assert.equal(trusted.calls.started, 1);
  console.log('Workspace trust activation checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
