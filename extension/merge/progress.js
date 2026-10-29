'use strict';

const stages = {
  preparing: 'Preparing the selected PR',
  'reading-pr': 'Reading GitHub PR identity, branch rules and contributors',
  'reading-checks': 'Reading checks on the selected GitHub head',
  'creating-checkout': 'Creating an isolated local checkout',
  cloning: 'Fetching repository history into the isolated checkout',
  'inspecting-files': 'Verifying local ancestry and changed files',
  'message-prepared': 'Commit message verified',
  integrating: 'Integrating with the current base',
  'applying-resolution': 'Applying the conflict resolution',
  'decision-commit': 'Recording the file resolution',
  'sync-prepared': 'Branch update prepared',
  prepared: 'Integration prepared',
  pushing: 'Pushing the prepared branch update to GitHub',
  pushed: 'Branch update pushed',
  'verifying-push': 'Verifying the pushed branch',
  'waiting-checks': 'Waiting for integrated-head checks',
  'checks-passed': 'Integrated-head checks passed',
  'checks-polled': 'GitHub checks refreshed',
  'preparing-merge': 'Creating and verifying the local merge commit',
  'pushing-merge': 'Pushing the verified merge to the upstream base',
  'verifying-merge': 'Verifying the destination commit and GitHub merge status',
  merging: 'Waiting for GitHub to confirm the merge'
};

function stageLocation(stage) {
  if (['reviewing', 'refreshing'].includes(stage)) return 'review';
  return ['reading-pr', 'reading-checks', 'cloning', 'pushing', 'pushed', 'verifying-push',
    'waiting-checks', 'checks-polled', 'checks-passed', 'pushing-merge', 'verifying-merge',
    'merging', 'verifying', 'waiting', 'checks_failed', 'merged'].includes(stage) ? 'upstream' : 'local';
}

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

module.exports = { withMergeProgress, stages, stageLocation };
