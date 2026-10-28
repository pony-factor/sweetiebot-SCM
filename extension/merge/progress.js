'use strict';

const stages = {
  preparing: 'Preparing the selected PR',
  'message-prepared': 'Commit message verified',
  integrating: 'Integrating with the current base',
  'applying-resolution': 'Applying the conflict resolution',
  'decision-commit': 'Recording the file resolution',
  'sync-prepared': 'Branch update prepared',
  prepared: 'Integration prepared',
  pushed: 'Branch update pushed',
  'verifying-push': 'Verifying the pushed branch',
  'waiting-checks': 'Waiting for integrated-head checks',
  'checks-passed': 'Integrated-head checks passed',
  merging: 'Waiting for GitHub to confirm the merge'
};

function withMergeProgress(vscode, { numbers, branchOnly }, task,
  { schedule = setInterval, cancel = clearInterval, now = Date.now } = {}) {
  if (!numbers.length) return task(() => {});
  const scope = numbers.map(number => '#' + number).join(', ');
  const title = 'Lindsey · Applying ' + (branchOnly ? 'PR fix ' : 'merge batch round · ') + scope;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title, cancellable: false }, async progress => {
    let message = 'Starting local execution…';
    const started = now();
    progress.report({message});
    const timer = schedule(() => progress.report({
      message: message + ' · ' + Math.floor((now() - started) / 1000) + 's elapsed'
    }), 20000);
    timer?.unref?.();
    try {
      return await task(event => {
        if (!numbers.includes(event?.number) || !stages[event.stage]) return;
        message = '#' + event.number + ' · ' + stages[event.stage];
        progress.report({message});
      });
    } catch (error) {
      void vscode.window.showWarningMessage?.('Lindsey could not finish applying ' + scope + '. See the local handoff result for the error.');
      throw error;
    } finally { cancel(timer); }
  });
}

module.exports = { withMergeProgress };
