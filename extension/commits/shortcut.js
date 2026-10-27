'use strict';

const { resolveCommitRepository } = require('./codex_commit');

// The shortcut must target the Source Control repository that owns the draft.
// Otherwise VS Code can resolve git.commit against another repository when an
// editor in that repository is active, leaving the prefilled title untouched.
// Delegate the actual commit to Git so staging prompts, safeguards, signing,
// optional push, and background generation still follow the native button.
function registerCommitShortcut(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.commit', async uri => {
    const repository = await resolveCommitRepository(vscode, uri);
    if (!repository) return;
    return vscode.commands.executeCommand('git.commit', repository.rootUri);
  }));
}

module.exports = { registerCommitShortcut };
