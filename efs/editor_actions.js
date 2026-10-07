'use strict';

const CLOSE_ALL_EDITORS_COMMAND = 'sweetiebot.closeAllEditors';
const VSCODE_CLOSE_ALL_EDITORS_COMMAND = 'workbench.action.closeAllEditors';

function registerEditorActions(vscode, context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(CLOSE_ALL_EDITORS_COMMAND, () =>
      vscode.commands.executeCommand(VSCODE_CLOSE_ALL_EDITORS_COMMAND)
    )
  );
}

module.exports = {
  CLOSE_ALL_EDITORS_COMMAND,
  VSCODE_CLOSE_ALL_EDITORS_COMMAND,
  registerEditorActions
};
