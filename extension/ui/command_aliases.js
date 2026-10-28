'use strict';

// Keep older workbench patches and user keybindings working during upgrades.
const LEGACY_COMMANDS = [
  "autoPullClean",
  "beginCommit",
  "chatgpt.searchRepositories",
  "checkCommitLimits",
  "closeAllEditors",
  "createBranch",
  "deleteBranch",
  "endCommit",
  "generateCodexCommitMessage",
  "openFileOnGitHub",
  "openPullRequestBatchChat",
  "openPullRequestChat",
  "openSettings",
  "prepareCodexCommit",
  "publishBranch",
  "returnHome",
  "squashMergeSelectedPullRequest",
  "squashMergePullRequest",
  "syncBranch",
  "workspaceSearch.clearIndex"
];

function isDuplicateCommandError(error) {
  return /command ['"].+['"] already exists/i.test(String(error?.message || error || ''));
}

function registerLegacyCommandAliases(vscode, context) {
  for (const name of LEGACY_COMMANDS) {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(
        `scmToolkit.${name}`,
        (...args) => vscode.commands.executeCommand(`sweetiebot.${name}`, ...args)
      ));
    } catch (error) {
      // A still-active legacy extension can own these compatibility aliases until
      // the next reload. Do not let that prevent canonical sweetiebot.* actions
      // from activating in the current window.
      if (!isDuplicateCommandError(error)) throw error;
    }
  }
}

module.exports = { registerLegacyCommandAliases, isDuplicateCommandError };
