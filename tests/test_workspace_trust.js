'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {
  TRUST_SETUP_COMMAND, TRUST_SETUP_SEEN_KEY,
  independentWorkspaceParent, showIndependentWorkspaceTrustSetup,
  promptForIndependentWorkspaceTrust, registerIndependentWorkspaceTrustCommand
} = require('../efs/workspace_trust');

function fixture({ enabled = true, seen = false, selection = 'Not Now' } = {}) {
  const calls = { prompts: [], updates: [], commands: [], copies: [], mkdirs: [], registrations: [] };
  const values = new Map([[TRUST_SETUP_SEEN_KEY, seen]]);
  const context = {
    subscriptions: [],
    workspaceState: {
      get(key, fallback) { return values.has('workspace:' + key) ? values.get('workspace:' + key) : fallback; },
      async update(key, value) { values.set('workspace:' + key, value); }
    },
    globalState: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) { calls.updates.push([key, value]); values.set(key, value); }
    }
  };
  const vscode = {
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'scmToolkit');
        return { get(key, fallback) {
          assert.equal(key, 'promptForIndependentWorkspaceTrust');
          return enabled === undefined ? fallback : enabled;
        } };
      }
    },
    window: {
      async showInformationMessage(...args) {
        calls.prompts.push(args);
        return selection;
      }
    },
    env: { clipboard: { async writeText(value) { calls.copies.push(value); } } },
    commands: {
      async executeCommand(command) { calls.commands.push(command); },
      registerCommand(name, action) {
        calls.registrations.push([name, action]);
        return { dispose() {} };
      }
    }
  };
  const io = { async mkdir(folder, options) { calls.mkdirs.push([folder, options]); } };
  return { vscode, context, io, calls, values };
}

(async () => {
  const baseDirectory = '/tmp/sweetiebot-trust-tests/Workspace Clones';
  assert.equal(independentWorkspaceParent(), path.join(os.homedir(), 'Library', 'Application Support', 'Sweetiebot', 'Workspaces'));

  const first = fixture({ selection: 'Not Now' });
  assert.equal(await showIndependentWorkspaceTrustSetup(first.vscode, first.context, {
    baseDirectory, io: first.io
  }), false);
  assert.deepEqual(first.calls.updates, [[TRUST_SETUP_SEEN_KEY, true]]);
  assert.equal(first.calls.prompts.length, 1);
  assert.match(first.calls.prompts[0][0], /ALL future repositories/);
  assert.match(first.calls.prompts[0][1].detail, /add the copied path yourself/);
  assert.deepEqual(first.calls.commands, []);
  assert.deepEqual(first.calls.mkdirs, []);
  assert.equal(await showIndependentWorkspaceTrustSetup(first.vscode, first.context, {
    baseDirectory, io: first.io
  }), false);
  assert.equal(first.calls.prompts.length, 1, 'First-run dismissal is remembered');

  const disabled = fixture({ enabled: false });
  assert.equal(await showIndependentWorkspaceTrustSetup(disabled.vscode, disabled.context, {
    baseDirectory, io: disabled.io
  }), false);
  assert.deepEqual(disabled.calls.prompts, []);
  assert.deepEqual(disabled.calls.updates, []);

  const restricted = fixture({ seen: true });
  restricted.vscode.workspace.isTrusted = false;
  restricted.vscode.workspace.workspaceFolders = [{ uri: {
    scheme: 'file', fsPath: path.join(baseDirectory, 'new-clone')
  } }];
  await showIndependentWorkspaceTrustSetup(restricted.vscode, restricted.context, { baseDirectory });
  assert.equal(restricted.calls.prompts.length, 1, 'A prior global dismissal cannot hide the guide in a new restricted clone');
  await showIndependentWorkspaceTrustSetup(restricted.vscode, restricted.context, { baseDirectory });
  assert.equal(restricted.calls.prompts.length, 1, 'Reloading the same clone respects its dismissal');
  restricted.vscode.workspace.workspaceFolders[0].uri.fsPath = baseDirectory + '-other/clone';
  restricted.values.delete('workspace:' + TRUST_SETUP_SEEN_KEY);
  await showIndependentWorkspaceTrustSetup(restricted.vscode, restricted.context, { baseDirectory });
  assert.equal(restricted.calls.prompts.length, 1, 'Sibling directories are not managed clones');

  const approved = fixture({ selection: 'Manage Workspace Trust' });
  assert.equal(await showIndependentWorkspaceTrustSetup(approved.vscode, approved.context, {
    baseDirectory, io: approved.io
  }), true);
  assert.deepEqual(approved.calls.mkdirs, [[baseDirectory, { recursive: true }]]);
  assert.deepEqual(approved.calls.copies, [baseDirectory]);
  assert.deepEqual(approved.calls.commands, ['workbench.trust.manage']);
  assert.deepEqual(approved.calls.updates, [[TRUST_SETUP_SEEN_KEY, true]]);
  assert.equal(approved.calls.prompts[0][1].modal, true);

  const manual = fixture({ enabled: false, seen: true, selection: 'Manage Workspace Trust' });
  assert.equal(await showIndependentWorkspaceTrustSetup(manual.vscode, manual.context, {
    manual: true, baseDirectory, io: manual.io
  }), true);
  assert.equal(manual.calls.prompts.length, 1);
  assert.deepEqual(manual.calls.updates, [], 'Manual setup must not modify first-run state');
  assert.deepEqual(manual.calls.commands, ['workbench.trust.manage']);

  const registered = fixture();
  registerIndependentWorkspaceTrustCommand(registered.vscode, registered.context);
  assert.equal(registered.context.subscriptions.length, 1);
  assert.equal(registered.calls.registrations[0][0], TRUST_SETUP_COMMAND);
  await registered.calls.registrations[0][1]();
  assert.equal(registered.calls.prompts.length, 1, 'Command Palette reopens setup');

  const simultaneous = fixture();
  let resolveDialog;
  simultaneous.vscode.window.showInformationMessage = (...args) => {
    simultaneous.calls.prompts.push(args);
    return new Promise(resolve => { resolveDialog = resolve; });
  };
  const a = promptForIndependentWorkspaceTrust(simultaneous.vscode, simultaneous.context);
  const b = promptForIndependentWorkspaceTrust(simultaneous.vscode, simultaneous.context);
  await Promise.resolve();
  assert.equal(simultaneous.calls.updates.length, 1, 'Concurrent startup calls share one prompt');
  // Let the awaited state update resolve before the UI dialog appears.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(simultaneous.calls.prompts.length, 1);
  resolveDialog('Not Now');
  assert.deepEqual(await Promise.all([a, b]), [false, false]);

  console.log('Independent workspace trust onboarding checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
