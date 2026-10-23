'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { displayName } = require('./pony_profile');
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
    { sessionTitle: `Codex #${task.number} [${task.head}]`, blockerTask: task });
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
        'window.title': title,
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

let mergeDashboardStarted = false;
let mergeDashboardController;

async function resumeMergeDashboard(vscode, directory, context) {
  if (mergeDashboardStarted) return mergeDashboardController;
  let selection;
  try { selection = JSON.parse(await fs.readFile(path.join(directory, 'merge-selection.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const auth = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
  const dashboard = require('./merge_dashboard');
  // A dedicated merge workspace owns this layout; no edits to the source window.
  mergeDashboardController = dashboard.startMergeDashboard(vscode, selection, auth.accessToken, {
    context, rootUri: vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file')?.uri
  });
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0, groups: [{ size: 0.2 }, { size: 0.8 }]
  });
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
      const auth = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      const { invokeResolutionCLI } = require('./merge_resolution');
      const { githubGet } = require('./merge_dashboard');
      const prefix = 'repos/' + selection.repository;
      const initialPrompt = new URLSearchParams(url.hash.slice(1)).get('q') || '';
      const runLocal = async (result, snapshot) => {
        const controller = await resumeMergeDashboard(vscode, directory, context);
        return invokeResolutionCLI(result, snapshot, auth.accessToken, undefined,
          event => controller?.recordLocalProgress?.(event));
      };
      if (input.options?.syncOnly) {
        const { validateSyncResolution, resolutionInstructions } = require('./merge_resolution');
        handoff = await require('./merge_handoff').createMergeHandoff(selection, {
          validate: validateSyncResolution,
          execute: runLocal,
          onResult: async result => {
            const controller = await resumeMergeDashboard(vscode, directory, context);
            controller?.recordLocalResult?.(result);
          }
        });
        url.hash = new URLSearchParams({ sweetiebot_merge: '1', return_to: handoff.url,
          q: initialPrompt + '\n\nBRANCH-ONLY EXECUTION: Use operation:"sync". Main is read-only. Append the per-file conflict decision commits to the PR branch before syncing remaining incoming changes. Do not merge or close the PR.\n\n' +
            resolutionInstructions(selection, handoff.url) }).toString();
        handoff.url = url.href;
        if (Buffer.byteLength(url.href) > 70000) { handoff.dispose(); throw Error('Branch synchronization prompt exceeds the browser launch budget.'); }
      } else handoff = await require('./merge_batch').createMergeBatch(selection, {
        api: endpoint => {
          if (!endpoint.startsWith(prefix + '/')) throw Error('Batch API request is outside the selected repository.');
          return githubGet(globalThis.fetch, auth.accessToken, selection.repository, endpoint.slice(prefix.length));
        },
        destination: url.origin + url.pathname,
        makePrompt: snapshot => require('./pull_request_batch').batchMergePrompt({
          repositoryUrl: 'https://github.com/' + snapshot.repository,
          pullRequests: snapshot.pullRequests, localHandoff: true,
          filterSyncCommitSummaries: !initialPrompt.includes('SYNC COMMIT FILTER DISABLED'),
          omitBulletsForEmojiTitles: initialPrompt.includes('EMOJI-ONLY SUBJECT LINES ENABLED')
        }),
        execute: runLocal,
        onState: state => fs.writeFile(path.join(directory, 'merge-batch-state.json'), JSON.stringify(state), { mode: 0o600 }),
        onResult: async result => {
          const controller = await resumeMergeDashboard(vscode, directory, context);
          controller?.recordLocalResult?.(result);
          await controller?.refresh?.();
        }
      });
      context.subscriptions?.push(handoff);
      if (!handoff.url) return;
      url.href = handoff.url;
    }
    try { await require('./pr_workflows').openWorkflow(vscode, url.href); }
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
  launchBlockerCodexSession, resumePRSession, closePRSession };
