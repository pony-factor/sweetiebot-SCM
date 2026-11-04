'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findLiveBranchWindow, focusExistingBranchWindow, SESSION_MAX_AGE_MS } =
  require('../extension/branches/window');

(async () => {
  const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-window-'));
  const group = path.join(baseDirectory, 'repo', 'topic-blue');
  const destination = path.join(group, 'repo');
  const workspace = path.join(group, 'topic-blue.code-workspace');
  const session = path.join(group, '.sweetiebot-session-2345-test.json');
  const options = { baseDirectory, sourcePid: 99999, alive: () => true };
  const writeSession = async data =>
    fs.writeFile(session, JSON.stringify({ pid: 2345, roots: [destination],
      workspaceFile: workspace, ...data }));
  const calls = [];
  const editor = {
    Uri: { file: fsPath => ({ fsPath }) },
    commands: { async executeCommand(...args) { calls.push(args); } }
  };
  try {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: destination }] }));
    await writeSession();
    const active = await findLiveBranchWindow(destination, options);
    assert.equal(active.target, workspace);
    assert.equal(await focusExistingBranchWindow(editor, destination, options), true);
    assert.deepEqual(calls.map(call => call[0]), ['vscode.openFolder', 'workbench.action.closeWindow']);
    assert.equal(calls[0][1].fsPath, workspace);
    assert.deepEqual(calls[0][2], { forceNewWindow: true });

    const alias = path.join(baseDirectory, 'repo-alias');
    await fs.symlink(destination, alias, 'dir');
    await writeSession({ roots: [alias] });
    assert.equal((await findLiveBranchWindow(destination, options)).target, workspace,
      'Canonicalize session roots, including macOS /var and /private/var aliases');
    await writeSession();

    calls.length = 0;
    const failed = { ...editor, commands: { async executeCommand(...args) {
      calls.push(args);
      if (args[0] === 'vscode.openFolder') throw Error('Cannot focus window');
    } } };
    await assert.rejects(focusExistingBranchWindow(failed, destination, options), /Cannot focus/);
    assert.deepEqual(calls.map(call => call[0]), ['vscode.openFolder'],
      'Never close the source when the target cannot be opened');

    // Flat legacy clone groups may not be named after the checkout.
    const legacyGroup = path.join(baseDirectory, 'historic-workspace');
    const legacyCheckout = path.join(legacyGroup, 'legacy-repository');
    const legacyWorkspace = path.join(legacyGroup, 'historic.code-workspace');
    await fs.mkdir(legacyCheckout, { recursive: true });
    await fs.writeFile(legacyWorkspace, JSON.stringify({ folders: [{ path: legacyCheckout }] }));
    await fs.writeFile(path.join(legacyGroup, '.sweetiebot-session-2345-legacy.json'),
      JSON.stringify({ pid: 2345, roots: [legacyCheckout], workspaceFile: legacyWorkspace }));
    assert.equal((await findLiveBranchWindow(legacyCheckout, options)).target, legacyWorkspace,
      'Focus a legacy window even when its managed group name differs');

    // A multi-root workspace can contain a second repository whose name does
    // not match the parent bucket chosen for the first repository.
    const multiGroup = path.join(baseDirectory, 'first-repo', 'main-azure');
    const secondCheckout = path.join(multiGroup, 'second-repo');
    const multiWorkspace = path.join(multiGroup, 'main-azure.code-workspace');
    await fs.mkdir(secondCheckout, { recursive: true });
    await fs.writeFile(multiWorkspace,
      JSON.stringify({ folders: [{ path: secondCheckout }] }));
    await fs.writeFile(path.join(multiGroup, '.sweetiebot-session-2345-multi.json'),
      JSON.stringify({ pid: 2345, roots: [secondCheckout], workspaceFile: multiWorkspace }));
    assert.equal((await findLiveBranchWindow(secondCheckout, options)).target, multiWorkspace,
      'Focus a secondary checkout in a differently named workspace bucket');

    await writeSession({ roots: [path.join(baseDirectory, 'other')] });
    assert.equal(await findLiveBranchWindow(destination, options), null,
      'A live PID without a matching checkout cannot own this branch');
    await writeSession({ pid: 99999 });
    assert.equal(await findLiveBranchWindow(destination, options), null,
      'The initiating extension host cannot be mistaken for another window');
    await writeSession({ pid: 2345 });
    const old = new Date(Date.now() - SESSION_MAX_AGE_MS - 20000);
    await fs.utimes(session, old, old);
    assert.equal(await findLiveBranchWindow(destination, options), null, 'Expired markers are ignored');
    calls.length = 0;
    assert.equal(await focusExistingBranchWindow(editor, destination, options), false);
    assert.equal(calls.length, 0, 'Do not close or reopen anything without a live owner');
    console.log('Existing branch window handoff checks passed.');
  } finally {
    await fs.rm(baseDirectory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
