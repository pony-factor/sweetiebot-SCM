'use strict';
const { pendingPRCommits } = require('./pr_commit_wait');
const { runKefania } = require('./kefania_runner');
const { githubRepository, normalizeConversationSource, readCodexConversation } = require('./pull_request');

function registerLocalPullRequestCommand(vscode, context, dependencies = {}) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.createLocalPullRequest', async (uri, options) => {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(vscode.Uri.from(uri?.rootUri ?? uri));
    if (!repository || repository.rootUri.scheme !== 'file') throw new Error('Select a local Git repository.');
    await repository.status();
    // The picker selected the target before this command began. A background
    // PR must use that captured branch even if the user checks out another one.
    if (typeof options?.branch !== 'string' || !options.branch || options.branch === options.base) {
      throw new Error('Select a branch other than the pull-request base.');
    }
    const remote = repository.state.remotes.find(item => item.name === options.remote);
    const url = githubRepository(remote?.pushUrl || remote?.fetchUrl);
    if (!url) throw new Error('The selected remote must identify a GitHub repository.');
    const waitForCommits = await (dependencies.pendingPRCommits || pendingPRCommits)(vscode, context, repository.rootUri);
    if (waitForCommits) await waitForCommits();
    const source = normalizeConversationSource(options.source) || (await readCodexConversation(vscode))?.source;
    const run = dependencies.runKefania || runKefania;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Creating new pull request with Kefania instructions', cancellable: false }, () =>
      run(repository.rootUri.fsPath, { repository: url.slice('https://github.com/'.length),
        head: options.branch, base: options.base, source }, { botOnly: false }));
    if (result?.url) {
      // Opening the result supplies confirmation without a redundant toast
      // in the independent PR workspace.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(result.url));
    }
    if (result?.source?.reason && result.source.reason !== 'No originating conversation supplied.') {
      await vscode.window.showWarningMessage(result.source.reason);
    }
    return result;
  }));
}
module.exports = { registerLocalPullRequestCommand };
