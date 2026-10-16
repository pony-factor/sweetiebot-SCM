'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { resolveKefaniaFile } = require('./kefania_paths');
const { githubRepository, normalizeConversationSource, readCodexConversation } = require('./pull_request');

function registerLocalPullRequestCommand(vscode, context) {
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
    const runner = await resolveKefaniaFile(repository.rootUri.fsPath, path.join('src', 'local-pr.js'));
    const source = normalizeConversationSource(options.source) || (await readCodexConversation(vscode))?.source;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Creating new pull request with Kefania instructions', cancellable: false }, async () => {
      return new Promise((resolve, reject) => {
        const env = { ...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter) };
        const child = spawn('node', [runner], { cwd: repository.rootUri.fsPath, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', error = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
        child.stdin.on('error', () => {});
        child.on('error', () => reject(new Error('Node is unavailable on the VS Code PATH.')));
        child.on('close', code => {
          if (code !== 0) return reject(new Error(error.trim() || 'Kefania was interrupted. Check GitHub for an existing PR before retrying.'));
          try { resolve(JSON.parse(output)); } catch { reject(new Error('Kefania returned an invalid PR result.')); }
        });
        child.stdin.end(JSON.stringify({ repository: url.slice('https://github.com/'.length), head: options.branch,
          base: options.base, source }));
      });
    });
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
