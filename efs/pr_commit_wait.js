'use strict';

const { readStatus } = require('./background_commit');

// Return a waiter only when the durable queue owns unfinished work. This also
// works in the independent PR extension host, where in-memory promises do not.
async function pendingPRCommits(vscode, context, root, dependencies = {}) {
  const script = vscode.Uri.joinPath(context.extensionUri, 'background_commit.py').fsPath;
  const status = dependencies.status || (() => readStatus(script, root.fsPath));
  const pause = dependencies.pause || (() => new Promise(resolve => setTimeout(resolve, 1000)));
  let current = await status();
  if (!current) throw new Error('Could not check commit naming before creating the PR.');
  if (!current.id && !current.titleJobs?.length) return undefined;
  return () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Waiting for commit naming and push before preparing the PR', cancellable: false,
  }, async () => {
    while (current.id || current.titleJobs?.length) {
      if (current.phase === 'blocked' && !current.recoverable) {
        throw new Error('Commit naming or push is paused: ' + (current.error || 'Retry the background commit before creating the PR.'));
      }
      await pause();
      current = await status();
      if (!current) throw new Error('Could not check commit naming before creating the PR.');
    }
  });
}

module.exports = { pendingPRCommits };
