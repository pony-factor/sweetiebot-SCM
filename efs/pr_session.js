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
  if (await sessionDirectory(vscode, context)) return false;
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
    const title = `${displayName(options.branch)} PR [${path.basename(root.fsPath)}]`;
    const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    const workspace = path.join(directory, filename + '.code-workspace');
    const config = vscode.workspace.getConfiguration('scmToolkit');
    await fs.writeFile(workspace, JSON.stringify({
      folders: [{ path: root.fsPath }],
      settings: {
        'scmToolkit.openPanelOnStartup': false,
        'scmToolkit.automaticBranchCleanup': false,
        'scmToolkit.startCompactPRSession': true,
        'workbench.browser.dataStorage': 'workspace',
        'scmToolkit.chatgptProjectUrl': config.get('chatgptProjectUrl', ''),
        'scmToolkit.autoPublishPullRequests': config.get('autoPublishPullRequests', true),
        'window.title': title,
      },
    }), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({
      root: root.fsPath, options,
    }), { mode: 0o600 });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspace), { forceNewWindow: true });
    return true;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function resumePRSession(vscode, context) {
  const directory = await sessionDirectory(vscode, context);
  if (!directory) return;
  const request = path.join(directory, 'request.json');
  let input;
  try { input = JSON.parse(await fs.readFile(request, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Consume once: reloading or restoring this workspace must not publish a
  // second request. Keep the saved workspace so VS Code can restore its chats.
  await fs.unlink(request);
  const root = vscode.Uri.file(input.root);
  for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) {
    await vscode.commands.executeCommand(command);
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

module.exports = { sessionDirectory, launchPRSession, resumePRSession, closePRSession };
