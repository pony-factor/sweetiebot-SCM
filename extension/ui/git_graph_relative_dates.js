'use strict';

const OPT_IN_KEY = 'scmToolkit.gitGraphRelativeDates';
const GRAPH_DATE_KEY = 'git-graph.date.format';

// Git Graph owns its date rendering. Enforce its supported setting without
// patching the extension or altering any commit's authored/committed timestamps.
function registerGitGraphRelativeDates(vscode, context) {
  let disposed = false;
  let pending = false;
  let running = false;

  async function enforce() {
    if (!vscode.workspace.getConfiguration('scmToolkit').get('gitGraphRelativeDates', false)) return;
    const graph = vscode.workspace.getConfiguration('git-graph');
    if (graph.get('date.format') === 'Relative') return;

    // A workspace override takes precedence over global configuration.
    const inspection = typeof graph.inspect === 'function' ? graph.inspect('date.format') : null;
    const target = inspection?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspection?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await graph.update('date.format', 'Relative', target);
  }

  function schedule() {
    if (disposed) return;
    pending = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (pending && !disposed) {
          pending = false;
          try {
            await enforce();
          } catch (error) {
            console.warn('Sweetiebot could not enforce Git Graph relative dates:', error.message);
          }
        }
      } finally {
        running = false;
      }
    })();
  }

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(OPT_IN_KEY) ||
        event.affectsConfiguration(GRAPH_DATE_KEY)) schedule();
  }));
  context.subscriptions.push({ dispose() { disposed = true; } });
  schedule();
}

module.exports = { registerGitGraphRelativeDates };
