'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launchPRSession, launchMergeSession, resumePRSession, sessionDirectory, closePRSession } = require('../efs/pr_session');

(async () => {
  const storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-pr-session-')));
  const originalHome = os.homedir;
  os.homedir = () => storage;
  try {
    const calls = [];
    const file = fsPath => ({ scheme: 'file', fsPath });
    const root = file(path.join(storage, 'repository'));
    await fs.mkdir(root.fsPath);
    execFileSync('git', ['init', '--quiet', root.fsPath]);
    const sessions = path.join(root.fsPath, '.git', 'sweetiebot-pr-sessions');
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
    assert.equal(path.basename(workspaceUri.fsPath), 'Draft PR [repository].code-workspace');
    assert.equal(saved.settings['window.title'], 'Draft PR [repository]');
    assert.deepEqual(saved.folders, [{ path: root.fsPath }]);
    assert.equal(saved.settings['scmToolkit.autoPublishPullRequests'], false);
    assert.equal(saved.settings['scmToolkit.automaticBranchCleanup'], false);
    assert.equal(saved.settings['scmToolkit.startCompactPRSession'], true, 'Only the PR workspace opts into compact startup');
    assert.equal(saved.settings['workbench.browser.dataStorage'], 'workspace');
    const browserStorage = path.join(storage, 'Library/Application Support/Sweetiebot/browserStorage');
    assert.equal((await fs.stat(browserStorage)).mode & 0o777, 0o700);
    assert.equal(await sessionDirectory(source, context), undefined);
    assert.equal(path.dirname(path.dirname(workspaceUri.fsPath)), sessions, 'Saved workspace inherits repository trust');
    assert.equal(execFileSync('git', ['-C', root.fsPath, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'Session files never appear in the working tree');

    // The originating window and command object no longer exist. A fresh
    // extension host resumes entirely from its own workspace and saved request.
    const resumed = [];
    const target = { Uri: { file }, workspace: { workspaceFile: workspaceUri, workspaceFolders: [{ uri: root }] },
      commands: { async executeCommand(...args) { resumed.push(args); } } };
    await resumePRSession(target, context);
    const layoutCommands = ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel'];
    assert.deepEqual(resumed, [...layoutCommands.map(command => [command]), ['sweetiebot.openPullRequestChat', root, options]]);
    assert.equal(await launchPRSession(target, context, root, options), false, 'Never recursively open another session');
    await resumePRSession(target, context);
    assert.equal(resumed.length, 4, 'Restoring a workspace must not repeat a PR request');
    const closeCommands = [];
    assert.equal(await closePRSession({ ...target, commands: { async executeCommand(command) { closeCommands.push(command); } } }, context), true);
    assert.deepEqual(closeCommands, ['workbench.action.switchToMainWindow', 'workbench.action.closeWindow'], 'Close the session workspace, including its auxiliary windows');
    assert.equal(await closePRSession(source, context), false, 'Never close the originating repository workspace');

    const foreign = { ...target, workspace: { workspaceFile: file('/elsewhere/session-x/Pull Request.code-workspace') } };
    assert.equal(await sessionDirectory(foreign, context), undefined);
    await resumePRSession(foreign, context);
    assert.equal(resumed.length, 4);

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
    assert.deepEqual(fallbackCalls.map(call => call[0]), [...layoutCommands, 'sweetiebot.openPullRequestChat', 'sweetiebot.createLocalPullRequest']);

    const failed = { ...source, commands: { async executeCommand() { throw new Error('Open failed'); } } };
    const before = await fs.readdir(sessions);
    await assert.rejects(launchPRSession(failed, context, root, options), /Open failed/);
    assert.deepEqual(await fs.readdir(sessions), before, 'Remove only the failed launch');
    const mergeUrl = 'https://chatgpt.com/#sweetiebot_merge=1&q=Selected%20PRs';
    await launchMergeSession(source, context, root, mergeUrl);
    const mergeWorkspace = calls.at(-1)[1];
    assert.deepEqual(calls.at(-1)[2], { forceNewWindow: true });
    assert.equal(path.basename(mergeWorkspace.fsPath), 'Bulk Merge [repository].code-workspace');
    const mergeCalls = [];
    const mergeHost = { ...target, workspace: { workspaceFile: mergeWorkspace, workspaceFolders: [{ uri: root }] },
      window: {}, commands: { async executeCommand(...args) { mergeCalls.push(args); } } };
    await resumePRSession(mergeHost, context);
    assert.deepEqual(mergeCalls, [...layoutCommands.map(command => [command]),
      ['workbench.action.browser.open', { url: mergeUrl, openToSide: false }]]);
    await resumePRSession(mergeHost, context);
    assert.equal(mergeCalls.length, 4, 'Reloading never resubmits a bulk merge');
    await launchMergeSession(source, context, root, mergeUrl);
    assert.notEqual(calls.at(-1)[1].fsPath, mergeWorkspace.fsPath, 'Each merge request owns an independent workspace');

    // A selected batch persists only its public PR snapshot in the dedicated
    // workspace and restores a live dashboard without resubmitting ChatGPT.
    const selection = { repository: 'pony-factor/example', pullRequests: [{
      number: 12, title: 'Fix a conflict',
      url: 'https://github.com/pony-factor/example/pull/12',
      head: 'my-feature', base: 'main', headSha: 'a'.repeat(40)
    }] };
    await launchMergeSession(source, context, root, mergeUrl, selection);
    const dashboardWorkspace = calls.at(-1)[1];
    const dashboardDirectory = path.dirname(dashboardWorkspace.fsPath);
    assert.deepEqual(JSON.parse(await fs.readFile(
      path.join(dashboardDirectory, 'merge-selection.json'), 'utf8')), selection);
    const mergeSettings = JSON.parse(await fs.readFile(dashboardWorkspace.fsPath, 'utf8'));
    assert.equal(mergeSettings.settings['scmToolkit.startCompactPRSession'], true,
      'Lindsey merge sessions also start in the 640px compact window');
    let launches = 0;
    const dashboardModulePath = require.resolve('../efs/merge_dashboard');
    const dashboardExports = require('../efs/merge_dashboard');
    const previousDashboard = require.cache[dashboardModulePath];
    require.cache[dashboardModulePath] = {
      id: dashboardModulePath, filename: dashboardModulePath, loaded: true,
      exports: { ...dashboardExports, startMergeDashboard(host, snapshot, token) {
        assert.equal(host, instrumented);
        assert.deepEqual(snapshot, selection);
        assert.equal(token, 'merge-session-token');
        launches++;
      } }
    };
    const dashboardCalls = [];
    context.subscriptions = [];
    const instrumented = { ...target,
      window: {},
      workspace: { workspaceFile: dashboardWorkspace, workspaceFolders: [{ uri: root }] },
      authentication: { async getSession(provider, scopes, options) {
        assert.equal(provider, 'github');
        assert.deepEqual(scopes, ['repo']);
        assert.equal(options.createIfNone, true);
        return { accessToken: 'merge-session-token' };
      } },
      commands: { async executeCommand(...args) { dashboardCalls.push(args); } }
    };
    try {
      await resumePRSession(instrumented, context);
      const handedOff = new URL(dashboardCalls[3][1].url);
      const payload = new URLSearchParams(handedOff.hash.slice(1));
      assert.match(payload.get('return_to'), /^http:\/\/127\.0\.0\.1:\d+\/lindsey-merge\/[\da-f-]{36}$/);
      assert(payload.get('q').includes('LOCAL LINDSEY CLI HANDOFF'));
      assert(payload.get('q').includes('COMPLETE git unified diff'));
      assert.deepEqual(dashboardCalls.map((call, index) => index === 3 ? [call[0]] : call), [
        ...layoutCommands.map(command => [command]),
        ['workbench.action.browser.open'],
        ['vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.2 }, { size: 0.8 }] }]
      ]);
      assert.equal(launches, 1);
      await resumePRSession(instrumented, context);
      assert.equal(launches, 1, 'Reload/restore must not duplicate a running dashboard');
      assert.equal(dashboardCalls.length, 5, 'Reload must not resubmit ChatGPT');
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose();
      if (previousDashboard) require.cache[dashboardModulePath] = previousDashboard;
      else delete require.cache[dashboardModulePath];
    }
    console.log('Independent PR workspace launch, restart, ownership, and cleanup checks passed.');
  } finally {
    os.homedir = originalHome;
    await fs.rm(storage, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
