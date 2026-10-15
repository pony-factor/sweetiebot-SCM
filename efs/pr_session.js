'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function sessionDirectory(vscode, context) {
  const workspace = vscode.workspace.workspaceFile;
  if (workspace?.scheme !== 'file' || !context.globalStorageUri) return undefined;
  const directory = path.dirname(workspace.fsPath);
  const sessions = path.join(context.globalStorageUri.fsPath, 'pr-sessions');
  if (path.dirname(directory) !== sessions || !path.basename(directory).startsWith('session-') ||
      path.basename(workspace.fsPath) !== 'Pull Request.code-workspace') return undefined;
  return directory;
}

async function launchPRSession(vscode, context, root, options) {
  if (sessionDirectory(vscode, context)) return false;
  const sessions = path.join(context.globalStorageUri.fsPath, 'pr-sessions');
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(sessions, 'session-'));
  try {
    // A saved workspace has its own main window and extension host. Auxiliary
    // browser windows and the draft server are consequently owned by this
    // session, rather than by the repository window that launched New PR.
    const workspace = path.join(directory, 'Pull Request.code-workspace');
    const config = vscode.workspace.getConfiguration('scmToolkit');
    await fs.writeFile(workspace, JSON.stringify({
      folders: [{ path: root.fsPath }],
      settings: {
        'scmToolkit.openPanelOnStartup': false,
        'scmToolkit.automaticBranchCleanup': false,
        'scmToolkit.chatgptProjectUrl': config.get('chatgptProjectUrl', ''),
        'scmToolkit.autoPublishPullRequests': config.get('autoPublishPullRequests', true),
        'window.title': 'Pull Request — ${rootName}${separator}${appName}',
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
  const directory = sessionDirectory(vscode, context);
  if (!directory) return;
  const request = path.join(directory, 'request.json');
  let input;
  try { input = JSON.parse(await fs.readFile(request, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Consume once: reloading or restoring this workspace must not publish a
  // second request. Keep the saved workspace so VS Code can restore its chats.
  await fs.unlink(request);
  const root = vscode.Uri.file(input.root);
  try {
    await vscode.commands.executeCommand('sweetiebot.openPullRequestChat', root, input.options);
  } catch (error) {
    if (!error?.browserUnavailable && error?.name !== 'SweetiebotBrowserUnavailable') throw error;
    await vscode.commands.executeCommand('sweetiebot.createLocalPullRequest', root, input.options);
  }
}

module.exports = { sessionDirectory, launchPRSession, resumePRSession };
