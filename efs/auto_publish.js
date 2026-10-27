'use strict';

// Git events survive SCM widget replacement and opening a branch in a new window.
async function registerAutoPublish(vscode, context) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const api = (await extension.activate()).getAPI(1);
  const watchers = new Map();
  let disposed = false;
  const attach = repository => {
    if (disposed || watchers.has(repository)) return;
    let timer, busy = false, lastAttempt = 0, lastBranch, reported, closed = false;
    const check = async () => {
      if (disposed || closed || busy) return;
      const root = repository.rootUri;
      const config = vscode.workspace.getConfiguration('scmToolkit', root);
      if (!config.get('autoPublishNewBranches', false)) return;
      const branch = repository.state.HEAD?.name;
      const remote = await require('./codex_commit').readCommitGitSetting(root.fsPath, 'scm-toolkit.remote', 'origin');
      if (!branch || (repository.state.HEAD.upstream?.remote === remote
          && repository.state.HEAD.upstream.name === branch)) return;
      if (lastBranch === branch && Date.now() - lastAttempt < 15000) return;
      lastBranch = branch; lastAttempt = Date.now();
      busy = true;
      try {
        const { resolveDefaultBranch } = require('./branch_actions');
        if (branch === await resolveDefaultBranch(repository, remote)) return;
        const published = await vscode.commands.executeCommand('sweetiebot.publishBranch', root, { branch, remote });
        reported = undefined;
        if (!published && !disposed && !closed) {
          clearTimeout(timer); timer = setTimeout(() => { void check(); }, 15000);
        }
      } catch (error) {
        const message = `Could not automatically publish ${branch}: ${error.message}`;
        if (reported !== message) void vscode.window.showWarningMessage(message);
        reported = message;
      } finally { busy = false; }
    };
    const schedule = () => {
      clearTimeout(timer);
      const delay = lastBranch === repository.state.HEAD?.name
        ? Math.max(500, 15000 - (Date.now() - lastAttempt)) : 500;
      timer = setTimeout(() => { void check(); }, delay);
    };
    const listener = repository.state.onDidChange(schedule);
    watchers.set(repository, { dispose() { closed = true; clearTimeout(timer); listener.dispose(); } });
    schedule();
  };
  context.subscriptions.push({ dispose() {
    disposed = true;
    for (const watcher of watchers.values()) watcher.dispose();
    watchers.clear();
  } }, api.onDidOpenRepository(attach), api.onDidCloseRepository(repository => {
    watchers.get(repository)?.dispose(); watchers.delete(repository);
  }), vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scmToolkit.autoPublishNewBranches')) {
      for (const repository of api.repositories) {
        watchers.get(repository)?.dispose(); watchers.delete(repository); attach(repository);
      }
    }
  }));
  for (const repository of api.repositories) attach(repository);
}

module.exports = { registerAutoPublish };
