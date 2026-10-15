'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launchPRSession, resumePRSession, sessionDirectory } = require('../efs/pr_session');

(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-pr-session-'));
  try {
    const calls = [];
    const file = fsPath => ({ scheme: 'file', fsPath });
    const root = file('/example/repository');
    const context = { globalStorageUri: file(storage) };
    const source = {
      Uri: { file },
      workspace: { getConfiguration: () => ({ get: (key, fallback) =>
        key === 'autoPublishPullRequests' ? false : fallback }) },
      commands: { async executeCommand(...args) { calls.push(args); } },
    };
    const options = { branch: 'draft', base: 'main', remote: 'origin',
      source: { kind: 'codex', id: 'original-conversation' }, conversationContext: 'Original intent' };
    assert.equal(await launchPRSession(source, context, root, options), true);
    const [command, workspaceUri, openOptions] = calls[0];
    assert.equal(command, 'vscode.openFolder');
    assert.deepEqual(openOptions, { forceNewWindow: true });
    const saved = JSON.parse(await fs.readFile(workspaceUri.fsPath, 'utf8'));
    assert.deepEqual(saved.folders, [{ path: root.fsPath }]);
    assert.equal(saved.settings['scmToolkit.autoPublishPullRequests'], false);
    assert.equal(saved.settings['scmToolkit.automaticBranchCleanup'], false);
    assert.equal(sessionDirectory(source, context), undefined);

    // The originating window and command object no longer exist. A fresh
    // extension host resumes entirely from its own workspace and saved request.
    const resumed = [];
    const target = { Uri: { file }, workspace: { workspaceFile: workspaceUri },
      commands: { async executeCommand(...args) { resumed.push(args); } } };
    await resumePRSession(target, context);
    assert.deepEqual(resumed, [['sweetiebot.openPullRequestChat', root, options]]);
    assert.equal(await launchPRSession(target, context, root, options), false, 'Never recursively open another session');
    await resumePRSession(target, context);
    assert.equal(resumed.length, 1, 'Restoring a workspace must not repeat a PR request');

    const foreign = { ...target, workspace: { workspaceFile: file('/elsewhere/session-x/Pull Request.code-workspace') } };
    assert.equal(sessionDirectory(foreign, context), undefined);
    await resumePRSession(foreign, context);
    assert.equal(resumed.length, 1);

    await fs.writeFile(path.join(path.dirname(workspaceUri.fsPath), 'request.json'), JSON.stringify({ root: root.fsPath, options }));
    const fallbackCalls = [];
    const unavailable = { ...target, commands: { async executeCommand(...args) {
      fallbackCalls.push(args);
      if (args[0] === 'sweetiebot.openPullRequestChat') {
        const error = new Error('Browser unavailable');
        error.browserUnavailable = true;
        throw error;
      }
    } } };
    await resumePRSession(unavailable, context);
    assert.deepEqual(fallbackCalls.map(call => call[0]), ['sweetiebot.openPullRequestChat', 'sweetiebot.createLocalPullRequest']);

    const failed = { ...source, commands: { async executeCommand() { throw new Error('Open failed'); } } };
    const before = await fs.readdir(path.join(storage, 'pr-sessions'));
    await assert.rejects(launchPRSession(failed, context, root, options), /Open failed/);
    assert.deepEqual(await fs.readdir(path.join(storage, 'pr-sessions')), before, 'Remove only the failed launch');
    console.log('Independent PR workspace launch, restart, ownership, and cleanup checks passed.');
  } finally {
    await fs.rm(storage, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
