'use strict';

const { execFile } = require('node:child_process');

const BROWSER_COMMAND = 'workbench.action.browser.open';
const FLOAT_COMMAND = 'workbench.action.moveEditorToNewWindow';
const COMPACT_MACOS_WINDOW = [
  'tell application "System Events"',
  'set foregroundProcess to first application process whose frontmost is true',
  'if name of foregroundProcess does not contain "Code" then return',
  'tell foregroundProcess',
  'if (count of windows) < 2 then return',
  'set floatingTitle to name of front window',
  'if floatingTitle does not contain "ChatGPT" and floatingTitle does not contain "Browser" and floatingTitle does not contain "Kefania" then return',
  'set size of front window to {680, 720}',
  'end tell',
  'end tell'
].join('\n');

// The VS Code extension API cannot size auxiliary windows directly. Limit the
// optional macOS resize to a frontmost ChatGPT/Browser window, never the
// workspace window, and allow missing Accessibility permission to fail safely.
function resizeMacChatWindow(exec = execFile) {
  return new Promise(resolve => {
    try {
      exec('/usr/bin/osascript', ['-e', COMPACT_MACOS_WINDOW], { timeout: 2500 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

// Opening and moving are separate native workbench commands. A failed move
// must not trigger Kefania's local fallback: ChatGPT may already be open.
async function openCompactKefaniaChat(vscode, url, { platform = process.platform, exec = execFile, requireFloating = false } = {}) {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(BROWSER_COMMAND)) {
    const error = new Error('Update VS Code to open ChatGPT in the Integrated Browser.');
    error.name = 'SweetiebotBrowserUnavailable';
    error.browserUnavailable = true;
    throw error;
  }
  if (requireFloating && !commands.includes(FLOAT_COMMAND)) throw new Error('Update VS Code to open the Kefania confirmation in a separate window.');
  const before = new Set(vscode.window.tabGroups?.all.flatMap(group => group.tabs) || []);
  await vscode.commands.executeCommand(BROWSER_COMMAND, {
    url, openToSide: false, reuseUrlFilter: url
  });
  // Close only the browser tab opened for this confirmation; never close the workspace window.
  const opened = vscode.window.tabGroups?.all.flatMap(group => group.tabs).filter(tab => !before.has(tab)) || [];
  const ownedTab = opened.length === 1 ? opened[0] : undefined;
  const closeOwnedTab = async () => {
    if (!ownedTab || !vscode.window.tabGroups?.all.some(group => group.tabs.includes(ownedTab))) {
      throw new Error('The Kefania confirmation tab is no longer open.');
    }
    await vscode.window.tabGroups.close(ownedTab, true);
  };
  if (!commands.includes(FLOAT_COMMAND)) {
    await vscode.window.showWarningMessage?.('ChatGPT opened inside the workspace because floating editor windows are unavailable.');
    return { floating: false };
  }
  try {
    await vscode.commands.executeCommand(FLOAT_COMMAND);
  } catch {
    if (requireFloating) {
      if (ownedTab) await vscode.window.tabGroups.close(ownedTab, true);
      throw new Error('VS Code could not open the Kefania confirmation in a separate window.');
    }
    await vscode.window.showWarningMessage?.('ChatGPT opened, but VS Code could not move the tab into a separate window.');
    return { floating: false };
  }
  if (platform === 'darwin') await resizeMacChatWindow(exec);
  return { floating: true, close: closeOwnedTab };
}

module.exports = { openCompactKefaniaChat, resizeMacChatWindow, COMPACT_MACOS_WINDOW };
