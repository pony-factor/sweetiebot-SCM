'use strict';

// The Source Control Commit button is Git's acceptInputCommand (git.commit).
// Delegate to the same command so button/keyboard commits share Git's repository
// selection, input validation, AI title generation, commit guard and optional push.
function registerCommitShortcut(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.commit', () =>
    vscode.commands.executeCommand('git.commit')
  ));
}

module.exports = { registerCommitShortcut };
