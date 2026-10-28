'use strict';

const COPY_TERMINAL_CONTENTS_COMMAND = 'sweetiebot.copyTerminalContents';
const TERMINAL_SELECT_ALL_COMMAND = 'workbench.action.terminal.selectAll';
const TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND = 'workbench.action.terminal.copyAndClearSelection';

function registerTerminalActions(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand(COPY_TERMINAL_CONTENTS_COMMAND, async () => {
    if (!vscode.window.activeTerminal) {
      vscode.window.showInformationMessage('No active terminal to copy.');
      return;
    }
    try {
      // VS Code copies all text still present in the terminal buffer, including scrollback.
      // Previous output removed by the terminal's scrollback limit is unrecoverable.
      await vscode.commands.executeCommand(TERMINAL_SELECT_ALL_COMMAND);
      await vscode.commands.executeCommand(TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND);
    } catch (error) {
      vscode.window.showErrorMessage('Unable to copy terminal contents: ' + (error?.message || error));
    }
  }));
}

module.exports = {
  COPY_TERMINAL_CONTENTS_COMMAND,
  TERMINAL_SELECT_ALL_COMMAND,
  TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND,
  registerTerminalActions
};
