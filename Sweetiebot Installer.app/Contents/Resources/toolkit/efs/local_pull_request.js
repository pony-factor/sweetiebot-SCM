'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { access } = require('node:fs/promises');
const { githubRepository, normalizeConversationSource, readCodexConversation } = require('./pull_request');

function registerLocalPullRequestCommand(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.createLocalPullRequest', async (uri, options) => {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(vscode.Uri.from(uri?.rootUri ?? uri));
    if (!repository || repository.rootUri.scheme !== 'file') throw new Error('Select a local Git repository.');
    await repository.status();
    if (repository.state.HEAD?.name !== options.branch || options.branch === options.base) {
      throw new Error('The active branch changed; select the PR branch again.');
    }
    const remote = repository.state.remotes.find(item => item.name === options.remote);
    const url = githubRepository(remote?.pushUrl || remote?.fetchUrl);
    if (!url) throw new Error('The selected remote must identify a GitHub repository.');
    const runner = path.join(path.dirname(repository.rootUri.fsPath), 'kefania', 'src', 'local-pr.js');
    await access(runner).catch(() => { throw new Error('Keep an updated kefania checkout beside this repository, with npm dependencies installed.'); });
    const source = normalizeConversationSource(options.source) || (await readCodexConversation(vscode))?.source;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: `Kefania: draft PR for ${options.branch} with local Codex`, cancellable: false }, async () => {
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
      await vscode.window.showInformationMessage(`Kefania ${result.existing ? 'found' : 'created'} PR: ${result.url}`);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(result.url));
    }
    if (result?.source?.reason && result.source.reason !== 'No originating conversation supplied.') {
      await vscode.window.showWarningMessage(result.source.reason);
    }
    return result;
  }));
}
module.exports = { registerLocalPullRequestCommand };
