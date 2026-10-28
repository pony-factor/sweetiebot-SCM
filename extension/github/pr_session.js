'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { displayName } = require('../codex/pony_profile');
const run = promisify(execFile);

async function repositorySessions(root) {
  const { stdout } = await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, timeout: 10000 });
  return path.join(stdout.trim(), 'sweetiebot-pr-sessions');
}

async function sessionDirectory(vscode, context) {
  const workspace = vscode.workspace.workspaceFile;
  if (workspace?.scheme !== 'file' || !context.globalStorageUri) return undefined;
  const directory = path.dirname(workspace.fsPath);
  if (!path.basename(directory).startsWith('session-') ||
      !workspace.fsPath.endsWith('.code-workspace')) return undefined;
  // Retain recognition of older sessions if the user explicitly trusted one.
  if (path.dirname(directory) === path.join(context.globalStorageUri.fsPath, 'pr-sessions')) return directory;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'file') continue;
    try {
      if (path.dirname(directory) === await repositorySessions(folder.uri.fsPath)) return directory;
    } catch { /* A non-Git folder cannot own a PR session. */ }
  }
}

async function launchPRSession(vscode, context, root, options) {
  return launchSession(vscode, context, root, options);
}

async function launchMergeSession(vscode, context, root, url, selection) {
  return launchSession(vscode, context, root, {}, url, selection);
}

async function launchBlockerWebSession(vscode, context, root, url, number, selection) {
  return launchSession(vscode, context, root,
    { sessionTitle: `Resolve #${number} [${path.basename(root.fsPath)}]`, ...(selection ? { syncOnly: true } : {}) }, url, selection);
}

async function launchBlockerCodexSession(vscode, context, root, task) {
  return launchSession(vscode, context, root,
    { sessionTitle: `Codex #${task.number} [${task.head}]`,
      windowTitle: `Codex #${task.number} [\${activeRepositoryBranchName}]`, blockerTask: task });
}

async function launchSession(vscode, context, root, options, mergeUrl, mergeSelection) {
  if (!mergeUrl && !options.blockerTask && await sessionDirectory(vscode, context)) return false;
  // Workspace trust includes the saved workspace file itself. Global storage
  // is outside the trusted repository and leaves the new host in Restricted
  // Mode, where this extension cannot start. Git metadata stays under a normal
  // trusted checkout and never adds a workspace/request to the working tree.
  const sessions = await repositorySessions(root.fsPath);
  // Electron owns the encrypted browser data; never read or copy credentials.
  // All dedicated PR workspaces use this same persistent profile.
  await fs.mkdir(path.join(os.homedir(), 'Library', 'Application Support', 'Sweetiebot', 'browserStorage'),
    { recursive: true, mode: 0o700 });
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(sessions, 'session-'));
  try {
    // A saved workspace has its own main window and extension host. Auxiliary
    // browser windows and the draft server are consequently owned by this
    // session, rather than by the repository window that launched New PR.
    const title = options.sessionTitle || (mergeUrl ? `Bulk Merge [${path.basename(root.fsPath)}]`
      : `${displayName(options.branch)} PR [${path.basename(root.fsPath)}]`);
    const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    const workspace = path.join(directory, filename + '.code-workspace');
    const config = vscode.workspace.getConfiguration('scmToolkit');
    await fs.writeFile(workspace, JSON.stringify({
      folders: [{ path: root.fsPath }],
      settings: {
        'scmToolkit.openPanelOnStartup': false,
        'scmToolkit.automaticBranchCleanup': false,
        // Both PR drafts and Lindsey merge dashboards open compact; expanding remains manual.
        'scmToolkit.startCompactPRSession': true,
        'workbench.browser.dataStorage': 'workspace',
        'scmToolkit.chatgptProjectUrl': config.get('chatgptProjectUrl', ''),
        'scmToolkit.autoPublishPullRequests': config.get('autoPublishPullRequests', true),
        'window.title': options.windowTitle || title,
      },
    }), { mode: 0o600 });
    if (mergeUrl && mergeSelection) {
      await fs.writeFile(path.join(directory, 'merge-selection.json'),
        JSON.stringify(mergeSelection), { mode: 0o600 });
    }
    await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({
      root: root.fsPath, options, ...(mergeUrl ? { mergeUrl } : {}),
    }), { mode: 0o600 });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspace), { forceNewWindow: true });
    return true;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// Summary comments are optional. A stale extension install or GitHub failure
// must never turn an independently completed local merge into a failed handoff.
async function publishOptionalMergeSummaries({ enabled, selection, input, result, token },
  loadPublisher = () => require('../merge/summary').publishMergeSummaries) {
  if (enabled !== true) return [];
  const merged = Array.isArray(result?.results)
    ? result.results.filter(item => item.status === 'merged' && item.merged === true) : [];
  if (!merged.length) return [];
  try {
    const publish = loadPublisher();
    if (typeof publish !== 'function') {
      // A mistaken async loader may return a rejected promise instead of a
      // publisher function. Consume that rejection without treating it as a
      // valid publisher or letting it crash the merge-session process.
      if (publish && typeof publish.then === 'function') {
        void Promise.resolve(publish).catch(() => {});
      }
      throw Error('The installed Sweetiebot merge summary module is out of date. Reload or reinstall Sweetiebot.');
    }
    return await publish({ enabled: true, selection, input, result, token });
  } catch (error) {
    return merged.map(item => ({ number: item.number,
      error: error?.message || String(error) }));
  }
}

let mergeDashboardStarted = false;
let mergeDashboardController;
const mergeWorkerTabs = new Map();

async function resumeMergeDashboard(vscode, directory, context) {
  if (mergeDashboardStarted) return mergeDashboardController;
  let selection;
  try { selection = JSON.parse(await fs.readFile(path.join(directory, 'merge-selection.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let savedState;
  try { savedState = JSON.parse(await fs.readFile(path.join(directory, 'merge-batch-state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('Could not restore local merge explanations.'); }
  const auth = await require('./session').githubSession(vscode);
  const dashboard = require('../merge/dashboard');
  const hasEditors = vscode.window.tabGroups?.all.some(group => group.tabs.length) === true;
  // A dedicated merge workspace owns this layout; no edits to the source window.
  mergeDashboardController = dashboard.startMergeDashboard(vscode, selection, auth.accessToken, {
    onFocusWorker: async id => {
      const tab = mergeWorkerTabs.get(id);
      const groups = vscode.window.tabGroups?.all || [];
      const group = groups.find(group => group.tabs.includes(tab));
      if (!group) return;
      const names = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'];
      const column = (group.viewColumn || groups.indexOf(group) + 1) - 1;
      const index = group.tabs.indexOf(tab);
      if (!names[column] || index < 0 || index > 8) return;
      await vscode.commands.executeCommand('workbench.action.focus' + names[column] + 'EditorGroup');
      await vscode.commands.executeCommand('workbench.action.openEditorAtIndex' + (index + 1));
    },
    initialRateLimit: savedState?.rateLimit,
    viewColumn: hasEditors ? (vscode.ViewColumn?.Two || 2) : (vscode.ViewColumn?.One || 1),
    context, rootUri: vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file')?.uri
  });
  if (savedState) mergeDashboardController.recordBatchState(savedState);
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0, groups: hasEditors ? [{ size: 0.2 }, { size: 0.8 }] : [{}]
  });
  await require('../merge/runner_layout').arrangeRunnerPanes(vscode);
  mergeDashboardStarted = true;
  return mergeDashboardController;
}

async function resumePRSession(vscode, context) {
  const directory = await sessionDirectory(vscode, context);
  if (!directory) return;
  const request = path.join(directory, 'request.json');
  let input;
  try { input = JSON.parse(await fs.readFile(request, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await resumeMergeDashboard(vscode, directory, context);
    return;
  }
  // Consume once: reloading or restoring this workspace must not publish a
  // second request. Keep the saved workspace so VS Code can restore its chats.
  await fs.unlink(request);
  const root = vscode.Uri.file(input.root);
  if (input.options?.blockerTask) {
    const task = input.options.blockerTask;
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.some(folder => folder.uri.scheme === 'file' && folder.uri.fsPath === root.fsPath) ||
        !Number.isSafeInteger(task.number) || task.number < 1 ||
        !/^[a-f0-9]{40}$/i.test(task.headSha || '') ||
        typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 24000) {
      throw Error('Invalid Codex implementation workspace request.');
    }
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: root.fsPath, timeout: 10000 });
    const branch = await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root.fsPath, timeout: 10000 });
    if (head.stdout.trim() !== task.headSha || branch.stdout.trim() !== task.head) {
      throw Error('The Codex branch workspace changed before its task started.');
    }
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) throw Error('Codex is unavailable in the branch workspace.');
    await extension.activate();
    if (!(await vscode.commands.getCommands(true)).includes('sweetiebot.codex.startBlockerTask')) {
      throw Error('Reload this window to start the Codex implementation task.');
    }
    await vscode.commands.executeCommand('sweetiebot.codex.startBlockerTask', { cwd: root.fsPath, prompt: task.prompt });
    return;
  }

  for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) {
    await vscode.commands.executeCommand(command);
  }
  if (input.mergeUrl) {
    const url = new URL(input.mergeUrl);
    if (url.origin !== 'https://chatgpt.com' ||
        new URLSearchParams(url.hash.slice(1)).get('sweetiebot_merge') !== '1') {
      throw new Error('Invalid bulk merge chat URL.');
    }
    let handoff;
    // Only a fresh, explicitly selected batch gets a local mutation capability.
    // Restoring a dashboard never resubmits a chat or executes an old result.
    let selection;
    try { selection = JSON.parse(await fs.readFile(path.join(directory, 'merge-selection.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (selection) {
      const auth = await require('./session').githubSession(vscode);
      const { invokeResolutionCLI } = require('../merge/resolution');
      const { githubGet } = require('../merge/dashboard');
      const readFetch = require('./read_api').createLindseyReadFetch(selection.repository);
      const prefix = 'repos/' + selection.repository;
      const initialPrompt = new URLSearchParams(url.hash.slice(1)).get('q') || '';
      const runLocal = (result, snapshot) => require('../merge/progress').withMergeProgress(vscode,
        { numbers: result.results.map(item => item.number), branchOnly: input.options?.syncOnly === true }, async report => {
        const controller = await resumeMergeDashboard(vscode, directory, context);
        const executed = await invokeResolutionCLI(result, snapshot, auth.accessToken, undefined,
          event => { report(event); controller?.recordLocalProgress?.(event); });
        const summaryErrors = await publishOptionalMergeSummaries({
          enabled: vscode.workspace?.getConfiguration?.('scmToolkit')?.get('mergePostSummaries', false) === true,
          selection: snapshot, input: result, result: executed, token: auth.accessToken
        });
        return { ...executed, summaryErrors };
      });
      if (input.options?.syncOnly) {
        handoff = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: 'Preparing Lindsey PR fix ' + selection.pullRequests.map(pr => '#' + pr.number).join(', '), cancellable: false
        }, progress => require('../merge/batch').createMergeBatch(selection, {
          onProgress: update => progress.report(update),
          branchOnly: true,
          api: endpoint => {
            if (!endpoint.startsWith(prefix + '/')) throw Error('Repair API request is outside the selected repository.');
            return githubGet(readFetch, auth.accessToken, selection.repository, endpoint.slice(prefix.length));
          },
          destination: url.origin + url.pathname,
          makePrompt: () => initialPrompt,
          execute: runLocal,
          onResult: async result => {
            const controller = await resumeMergeDashboard(vscode, directory, context);
            controller?.recordLocalResult?.(result);
          },
          onState: async state => {
            await fs.writeFile(path.join(directory, 'merge-batch-state.json'), JSON.stringify(state), {mode: 0o600});
            mergeDashboardController?.recordBatchState?.(state);
            require('../merge/session_completion').updateMergeSessionCompletion(vscode, selection, state);
          }
        }));
      } else {
      const blockerReports = {};
      const keepAwake = require('../merge/keep_awake').createMergeKeepAwake();
      let awakeState;
      const updateAwake = () => {
        if (awakeState) keepAwake.update(awakeState, selection,
          vscode.workspace.getConfiguration('scmToolkit').get('codexKeepAwake', true));
      };
      context.subscriptions?.push(keepAwake, vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('scmToolkit.codexKeepAwake')) updateAwake();
      }));
      const startBatch = progress => require('../merge/parallel_merge_batch').createParallelMergeBatch(selection, {
        onProgress: update => progress?.report(update),
        api: endpoint => {
          if (!endpoint.startsWith(prefix + '/')) throw Error('Batch API request is outside the selected repository.');
          return githubGet(readFetch, auth.accessToken, selection.repository, endpoint.slice(prefix.length));
        },
        destination: url.origin + url.pathname,
        makePrompt: snapshot => require('./pull_request_batch').batchMergePrompt({
          repositoryUrl: 'https://github.com/' + snapshot.repository,
          postMergeSummaries: vscode.workspace?.getConfiguration?.('scmToolkit')?.get('mergePostSummaries', false) === true,
          pullRequests: snapshot.pullRequests, localHandoff: true,
          filterSyncCommitSummaries: !initialPrompt.includes('SYNC COMMIT FILTER DISABLED'),
          omitBulletsForEmojiTitles: initialPrompt.includes('EMOJI-ONLY SUBJECT LINES ENABLED')
        }),
        execute: runLocal,
        onState: async state => {
          awakeState = state;
          updateAwake();
          if (state.rateLimit) {
            const error = Object.assign(Error(state.rateLimit.message), {rateLimited:true,retryAt:state.rateLimit.retryAt,configured:state.rateLimit.configured});
            void require('./rate_limit').promptRateLimit(vscode, error, {context,retryPriority:1,retry:()=>vscode.commands.executeCommand('sweetiebot.mergeAllPullRequests')}).catch(()=>{});
          }
          for (const deferred of state.deferred) {
            if (blockerReports[deferred.number]) continue;
            const pr = (state.pullRequests || selection.pullRequests).find(pr => pr.number === deferred.number);
            const history = state.history.filter(item => item.number === deferred.number);
            const paths = history.flatMap(item => item.conflictPaths || []);
            const decisions = [...new Map(history.flatMap(item => item.decisions || []).map(note => [note.path, note])).values()];
            if (!pr) continue;
            if (!paths.length) {
              blockerReports[pr.number] = { ...require('../merge/blocker_report').blockerReport(pr, deferred.reason, []),
                posted: false, error: 'No conflict location was supplied, so an inline comment could not be anchored. The executor details remain available locally.' };
              continue;
            }
            blockerReports[pr.number] = await require('../merge/blocker_report').publishBlockerReport({
              repository: selection.repository, pr, reason: deferred.reason, kind: deferred.kind, paths, decisions, api: require('./user_api').githubUserAPI(auth.accessToken)
            });
          }
          state.blockerReports = blockerReports;
          await fs.writeFile(path.join(directory, 'merge-batch-state.json'), JSON.stringify(state), { mode: 0o600 });
          mergeDashboardController?.recordBatchState?.(state);
          require('../merge/session_completion').updateMergeSessionCompletion(vscode, selection, state);
        },
        onResult: async result => {
          const controller = await resumeMergeDashboard(vscode, directory, context);
          controller?.recordLocalResult?.(result);
          await controller?.refresh?.();
        }
      });
      try { handoff = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Preparing Lindsey merge queue', cancellable: false
      }, startBatch); }
      catch (error) { keepAwake.dispose(); throw error; }
      const disposeBatch = handoff.dispose.bind(handoff);
      handoff.dispose = () => { keepAwake.dispose(); disposeBatch(); };
      }
      context.subscriptions?.push(handoff);
      if (handoff.launches?.length) {
        try {
          for (const launch of handoff.launches) {
            const close = await require('./pr_workflows').openWorkflow(vscode, launch.url);
            if (close.tab) mergeWorkerTabs.set(launch.id, close.tab);
            require('../merge/runner_layout').registerMergeRunner(vscode,'batch:'+launch.id,close.tab);
          }
        } catch (error) { handoff.dispose(); throw error; }
        const controller = await resumeMergeDashboard(vscode, directory, context);
        controller?.recordBatchState?.(handoff.state());
        return;
      }
      if (!handoff.url) { await resumeMergeDashboard(vscode, directory, context); return; }
      url.href = handoff.url;
    }
    try {
      const close = await require('./pr_workflows').openWorkflow(vscode, url.href);
      if (selection) require('../merge/runner_layout').registerMergeRunner(vscode,'batch',close.tab);
    }
    catch (error) { handoff?.dispose(); throw error; }
    await resumeMergeDashboard(vscode, directory, context);
    return;
  }
  try {
    await vscode.commands.executeCommand('sweetiebot.openPullRequestChat', root, input.options);
  } catch (error) {
    if (!error?.browserUnavailable && error?.name !== 'SweetiebotBrowserUnavailable') throw error;
    await vscode.commands.executeCommand('sweetiebot.createLocalPullRequest', root, input.options);
  }
}

async function closePRSession(vscode, context) {
  // Only the dedicated session may close its workspace. The originating
  // repository window must never be closed by the confirmation control.
  if (!await sessionDirectory(vscode, context)) return false;
  await vscode.commands.executeCommand('workbench.action.switchToMainWindow');
  await vscode.commands.executeCommand('workbench.action.closeWindow');
  return true;
}

module.exports = { sessionDirectory, launchPRSession, launchMergeSession, launchBlockerWebSession,
  launchBlockerCodexSession, resumePRSession, closePRSession, publishOptionalMergeSummaries };
