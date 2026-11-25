'use strict';

const { deferExperimentPublish } = require('./experiment-policy');
const { isPullRequestReviewBranch } = require('./publish-policy');

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
      const config = vscode.workspace.getConfiguration('sweetiebot', root);
      const pushAfterCommit = vscode.workspace.getConfiguration('git', root).get('postCommitCommand') === 'push';
      const head = repository.state.HEAD;
      const branch = head?.name;
      // An unborn branch has nothing to publish. Local-only repositories also
      // have no default remote branch to resolve; wait for Git state to change.
      // GitHub PR review checkouts (pr/<contributor>/<number>) are local snapshots,
      // not new work branches. Never publish them simply because they became active.
      if (!branch || !head.commit || isPullRequestReviewBranch(branch)) return;
      const remote = await require('../commits/codex-commit').readCommitGitSetting(root.fsPath, 'sweetiebot.remote', 'origin');
      if (!repository.state.remotes?.some(item => item.name === remote)) return;
      const tracked = head.upstream?.remote === remote && head.upstream.name === branch;
      if (tracked ? !pushAfterCommit || !(head.ahead > 0) || head.behind !== 0
        : !config.get('autoPublishNewBranches', false)) return;
      if (lastBranch === branch && Date.now() - lastAttempt < 15000) return;
      busy = true;
      try {
        if (await deferExperimentPublish(root.fsPath)) return;
        lastBranch = branch; lastAttempt = Date.now();
        const { resolveDefaultBranch } = require('./actions');
        if (branch === await resolveDefaultBranch(repository, remote)) return;
        // A merged PR head is retired even if its remote tracking ref was pruned.
        // Preserve manual push warnings, but never show them from this watcher.
        const published = await vscode.commands.executeCommand(tracked ? 'sweetiebot.pushCommittedBranch' : 'sweetiebot.publishBranch', root, {
          branch, remote, expectedHead: head.commit, silentMerged: true, automatic: true
        });
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
    if (event.affectsConfiguration('sweetiebot.autoPublishNewBranches') || event.affectsConfiguration('git.postCommitCommand')) {
      for (const repository of api.repositories) {
        watchers.get(repository)?.dispose(); watchers.delete(repository); attach(repository);
      }
    }
  }));
  for (const repository of api.repositories) attach(repository);
}

module.exports = { registerAutoPublish };
