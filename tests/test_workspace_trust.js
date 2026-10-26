'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {
  TRUST_SETUP_COMMAND, TRUST_SETUP_SEEN_KEY, REQUEST_PARENT_TRUST_COMMAND,
  independentWorkspaceParent, showIndependentWorkspaceTrustSetup,
  promptForIndependentWorkspaceTrust, registerIndependentWorkspaceTrustCommand
} = require('../efs/branches/workspace_trust');

function fixture({ enabled = true, seen = false, selection = false } = {}) {
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
    commands: {
      async executeCommand(command) { calls.commands.push(command); return selection; },
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

  const first = fixture();
  assert.equal(await showIndependentWorkspaceTrustSetup(first.vscode, first.context, {
    baseDirectory, io: first.io
  }), false);
  assert.deepEqual(first.calls.updates, [[TRUST_SETUP_SEEN_KEY, true]]);
  assert.equal(first.calls.commands.length, 1);
  assert.deepEqual(first.calls.commands, [REQUEST_PARENT_TRUST_COMMAND]);
  assert.deepEqual(first.calls.mkdirs, [[baseDirectory, { recursive: true }]]);
  assert.equal(await showIndependentWorkspaceTrustSetup(first.vscode, first.context, {
    baseDirectory, io: first.io
  }), false);
  assert.equal(first.calls.commands.length, 1, 'First-run dismissal is remembered');

  const disabled = fixture({ enabled: false });
  assert.equal(await showIndependentWorkspaceTrustSetup(disabled.vscode, disabled.context, {
    baseDirectory, io: disabled.io
  }), false);
  assert.deepEqual(disabled.calls.commands, []);
  assert.deepEqual(disabled.calls.updates, []);

  const restricted = fixture({ seen: true });
  restricted.vscode.workspace.isTrusted = false;
  restricted.vscode.workspace.workspaceFolders = [{ uri: {
    scheme: 'file', fsPath: path.join(baseDirectory, 'new-clone')
  } }];
  await showIndependentWorkspaceTrustSetup(restricted.vscode, restricted.context, { baseDirectory });
  assert.equal(restricted.calls.commands.length, 1, 'A prior global dismissal cannot hide the guide in a new restricted clone');
  await showIndependentWorkspaceTrustSetup(restricted.vscode, restricted.context, { baseDirectory });
  assert.equal(restricted.calls.commands.length, 1, 'Reloading the same clone respects its dismissal');
  restricted.vscode.workspace.workspaceFolders[0].uri.fsPath = baseDirectory + '-other/clone';
  restricted.values.delete('workspace:' + TRUST_SETUP_SEEN_KEY);
  await showIndependentWorkspaceTrustSetup(restricted.vscode, restricted.context, { baseDirectory });
  assert.equal(restricted.calls.commands.length, 1, 'Sibling directories are not managed clones');

  const approved = fixture({ selection: true });
  assert.equal(await showIndependentWorkspaceTrustSetup(approved.vscode, approved.context, {
    baseDirectory, io: approved.io
  }), true);
  assert.deepEqual(approved.calls.mkdirs, [[baseDirectory, { recursive: true }]]);
  assert.deepEqual(approved.calls.copies, [], 'Clipboard is never touched');
  assert.deepEqual(approved.calls.commands, [REQUEST_PARENT_TRUST_COMMAND]);
  assert.deepEqual(approved.calls.updates, [[TRUST_SETUP_SEEN_KEY, true]]);

  const manual = fixture({ enabled: false, seen: true, selection: true });
  assert.equal(await showIndependentWorkspaceTrustSetup(manual.vscode, manual.context, {
    manual: true, baseDirectory, io: manual.io
  }), true);
  assert.equal(manual.calls.commands.length, 1);
  assert.deepEqual(manual.calls.updates, [], 'Manual setup must not modify first-run state');
  assert.deepEqual(manual.calls.commands, [REQUEST_PARENT_TRUST_COMMAND]);

  const registered = fixture();
  registerIndependentWorkspaceTrustCommand(registered.vscode, registered.context);
  assert.equal(registered.context.subscriptions.length, 1);
  assert.equal(registered.calls.registrations[0][0], TRUST_SETUP_COMMAND);
  await registered.calls.registrations[0][1]();
  assert.equal(registered.calls.commands.length, 1, 'Command Palette reopens setup');

  const simultaneous = fixture();
  let resolveDialog;
  let dialogOpened;
  const opened = new Promise(resolve => { dialogOpened = resolve; });
  simultaneous.vscode.commands.executeCommand = command => {
    simultaneous.calls.commands.push(command);
    return new Promise(resolve => { resolveDialog = resolve; dialogOpened(); });
  };
  const a = promptForIndependentWorkspaceTrust(simultaneous.vscode, simultaneous.context);
  const b = promptForIndependentWorkspaceTrust(simultaneous.vscode, simultaneous.context);
  await Promise.resolve();
  assert.equal(simultaneous.calls.updates.length, 1, 'Concurrent startup calls share one prompt');
  await opened;
  assert.equal(simultaneous.calls.commands.length, 1);
  resolveDialog(false);
  assert.deepEqual(await Promise.all([a, b]), [false, false]);

  console.log('Independent workspace trust onboarding checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
