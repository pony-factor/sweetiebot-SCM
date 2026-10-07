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
  "squashMergePullRequest",
  "syncBranch",
  "workspaceSearch.clearIndex"
];

function registerLegacyCommandAliases(vscode, context) {
  for (const name of LEGACY_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(
      `scmToolkit.${name}`,
      (...args) => vscode.commands.executeCommand(`sweetiebot.${name}`, ...args)
    ));
  }
}

module.exports = { registerLegacyCommandAliases };
