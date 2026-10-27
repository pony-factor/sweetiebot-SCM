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

// The extension host may not enumerate tabs belonging to auxiliary windows.
// This macOS fallback only presses the close control of one VS Code window
// whose title contains the unique confirmation token; it never targets a
// generic foreground window or a workspace without that token.
function closeMacConfirmationWindow(token, exec = execFile) {
  if (!/^[a-f0-9]{8}$/i.test(token)) return Promise.reject(new Error('Invalid Kefania window token.'));
  const script = [
    'tell application "System Events"',
    'set matchedWindows to {}',
    'repeat with hostProcess in (application processes whose name is "Code" or name is "Code - Insiders")',
    'repeat with candidate in (windows of hostProcess)',
    'set windowTitle to name of candidate',
    'if windowTitle contains "Kefania" and windowTitle contains "' + token + '" then set end of matchedWindows to candidate',
    'end repeat',
    'end repeat',
    'if (count of matchedWindows) is not 1 then error "No unique Kefania confirmation window"',
    'set targetWindow to item 1 of matchedWindows',
    'set closeControl to first button of targetWindow whose subrole is "AXCloseButton"',
    'perform action "AXPress" of closeControl',
    'end tell',
    'return "closed"',
  ].join('\n');
  return new Promise((resolve, reject) => {
    try {
      exec('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (error, stdout) => {
        if (error || String(stdout).trim() !== 'closed') reject(new Error(
          'Cannot close the Kefania window automatically. Check macOS Accessibility permission for VS Code, or use the window close control.'));
        else resolve();
      });
    } catch {
      reject(new Error('Cannot close the Kefania window automatically. Use its window close control.'));
    }
  });
}

// Opening and moving are separate native workbench commands. A failed move
// must not trigger Kefania's local fallback: ChatGPT may already be open.
async function openCompactKefaniaChat(vscode, url, { platform = process.platform, exec = execFile, requireFloating = false, floating = true } = {}) {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(BROWSER_COMMAND)) {
    const error = new Error('Update VS Code to open ChatGPT in the Integrated Browser.');
    error.name = 'SweetiebotBrowserUnavailable';
    error.browserUnavailable = true;
    throw error;
  }
  if (requireFloating && !commands.includes(FLOAT_COMMAND)) throw new Error('Update VS Code to open the Kefania confirmation in a separate window.');
  const openTabs = () => vscode.window.tabGroups?.all.flatMap(group => group.tabs) || [];
  const before = new Set(openTabs());
  await vscode.commands.executeCommand(BROWSER_COMMAND, {
    url, openToSide: false, reuseUrlFilter: url
  });
  if (!floating && !requireFloating) return { floating: false };
  // Moving an editor to an auxiliary window can replace its Tab object. Retain
  // the unique confirmation URL token to find the relocated tab safely later.
  const opened = openTabs().filter(tab => !before.has(tab));
  const ownedTab = opened.length === 1 ? opened[0] : undefined;
  const token = /\/kefania-draft\/([0-9a-f]{8})[0-9a-f-]{28}/i.exec(url)?.[1];
  let currentTab = ownedTab;
  let closed = false;
  const closeOwnedTab = async () => {
    if (closed) throw new Error('Kefania confirmation tab is no longer open.');
    const tabs = openTabs();
    let target = tabs.includes(currentTab) ? currentTab : undefined;
    if (!target && token) {
      const matches = tabs.filter(tab => typeof tab.label === 'string' &&
        tab.label.includes('Kefania') && tab.label.includes(token));
      if (matches.length > 1) throw new Error('Ambiguous Kefania confirmation tabs; refusing to close another tab.');
      if (matches.length === 1) target = matches[0];
    }
    if (target) {
      try {
        if (await vscode.window.tabGroups.close(target, true)) {
          closed = true;
          return;
        }
      } catch { /* The auxiliary window can outlive the original tab reference. */ }
    }
    if (platform === 'darwin' && token) {
      await closeMacConfirmationWindow(token, exec);
      closed = true;
      return;
    }
    throw new Error('VS Code could not close the Kefania confirmation tab. Use the window close control.');
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
  // Refresh the tab reference after the move, before independent chat tabs open.
  const relocated = openTabs().filter(tab => !before.has(tab));
  if (relocated.length === 1) currentTab = relocated[0];
  if (platform === 'darwin') await resizeMacChatWindow(exec);
  return { floating: true, close: closeOwnedTab };
}

module.exports = { openCompactKefaniaChat, resizeMacChatWindow, closeMacConfirmationWindow, COMPACT_MACOS_WINDOW };
