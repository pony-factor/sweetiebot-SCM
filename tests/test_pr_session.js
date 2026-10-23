'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launchPRSession, launchMergeSession, resumePRSession, sessionDirectory, closePRSession } = require('../efs/pr_session');
const { openCodexBranch, launchBlockerAction, blockerOptions } = require('../efs/merge_blocker_actions');

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
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async address => {
      const endpoint = new URL(address).pathname;
      const pr = selection.pullRequests[0];
      const result = endpoint.endsWith('/branches/main') ? { commit: { sha: 'b'.repeat(40) } } : {
        number: pr.number, state: 'open', draft: false, title: pr.title, mergeable: true,
        head: { ref: pr.head, sha: pr.headSha, repo: { full_name: selection.repository } }, base: { ref: pr.base }
      };
      return { ok: true, json: async () => result };
    };
    try {
      await resumePRSession(instrumented, context);
      const launchPayload = new URLSearchParams(new URL(dashboardCalls[3][1].url).hash.slice(1));
      assert(launchPayload.get('return_to').includes('/lindsey-merge/'));
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
      globalThis.fetch = priorFetch;
      for (const disposable of context.subscriptions) disposable.dispose();
      if (previousDashboard) require.cache[dashboardModulePath] = previousDashboard;
      else delete require.cache[dashboardModulePath];
    }
    const pr = { ...selection.pullRequests[0], state: 'blocked', headSha: selection.pullRequests[0].headSha };
    const option = blockerOptions(pr)[0];
    await launchBlockerAction(source, context, root, selection.repository, pr, option, 'web');
    const actionWorkspace = calls.at(-1)[1];
    const actionDirectory = path.dirname(actionWorkspace.fsPath);
    assert.equal(path.basename(actionWorkspace.fsPath), 'Resolve #12 [repository].code-workspace');
    const actionRequest = JSON.parse(await fs.readFile(path.join(actionDirectory, 'request.json'), 'utf8'));
    const actionPrompt = new URLSearchParams(new URL(actionRequest.mergeUrl).hash.slice(1)).get('q');
    assert(actionPrompt.includes('Preserve what is already on the current main branch'));
    assert(actionPrompt.includes('does not authorize merging or closing'));
    await assert.rejects(fs.stat(path.join(actionDirectory, 'merge-selection.json')), /ENOENT/,
      'Implementation follow-ups do not receive a bulk merge capability');

    // Exercise an actual independent clone and verify the task resumes only
    // in its selected branch, leaving the source checkout unchanged.
    execFileSync('git', ['-C', root.fsPath, 'symbolic-ref', 'HEAD', 'refs/heads/my-feature']);
    await fs.writeFile(path.join(root.fsPath, 'fixture.txt'), 'Local workspace fixture\n');
    execFileSync('git', ['-C', root.fsPath, 'add', 'fixture.txt']);
    execFileSync('git', ['-C', root.fsPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', '🧪 Create branch fixture']);
    const fixtureSha = execFileSync('git', ['-C', root.fsPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branchPr = { ...pr, headSha: fixtureSha };
    const codexSource = { ...source,
      extensions: { getExtension: () => ({ async activate() {} }) },
      commands: { ...source.commands, getCommands: async () => ['sweetiebot.codex.startBlockerTask'] }
    };
    const localGit = async (cwd, args) => {
      const copy = [...args];
      if (copy[0] === 'remote' && copy[1] === 'set-url') copy[3] = root.fsPath;
      return execFileSync('git', copy, { cwd, encoding: 'utf8' }).trim();
    };
    await openCodexBranch(codexSource, context, root.fsPath, selection.repository, branchPr,
      'Keep main and add the proposed features.', { git: localGit, baseDirectory: path.join(storage, 'clones') });
    const codexWorkspace = calls.at(-1)[1];
    const codexSettings = JSON.parse(await fs.readFile(codexWorkspace.fsPath, 'utf8'));
    const cloneRoot = codexSettings.folders[0].path;
    assert.notEqual(cloneRoot, root.fsPath);
    assert.equal(execFileSync('git', ['-C', cloneRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixtureSha);
    assert.equal(execFileSync('git', ['-C', root.fsPath, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    const startedCodex = [];
    const codexHost = { ...codexSource, workspace: { workspaceFile: codexWorkspace,
      workspaceFolders: [{ uri: file(cloneRoot) }] }, commands: { ...codexSource.commands,
      async executeCommand(...args) { startedCodex.push(args); } } };
    await resumePRSession(codexHost, context);
    assert.equal(startedCodex.length, 1);
    assert.equal(startedCodex[0][0], 'sweetiebot.codex.startBlockerTask');
    assert.equal(startedCodex[0][1].cwd, cloneRoot);
    assert.equal(startedCodex[0][1].prompt, 'Keep main and add the proposed features.');
    await resumePRSession(codexHost, context);
    assert.equal(startedCodex.length, 1, 'Reload never resubmits the selected implementation');
    console.log('Independent PR workspaces, selected web prompts and isolated Codex branch tasks passed.');
  } finally {
    os.homedir = originalHome;
    await fs.rm(storage, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
