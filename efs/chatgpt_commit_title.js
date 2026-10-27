'use strict';

// Explicit, interactive ChatGPT title suggestions never alter Git history.
// Background commit generation and post-commit spellcheck still use Ollama.
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {startNativeSpellcheckBridge} = require('./native_spellcheck_bridge');
const {resolveChatgptReviewProjectUrl} = require('./chatgpt_project');

const execFileAsync = promisify(execFile);
const MAX_DIFF = 16000;

function acceptableTitle(value) {
  return typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= 72 && !/[\r\n\x00-\x1f]/.test(value);
}

async function stagedDiff(root, run = execFileAsync) {
  const {stdout} = await run('git', [
    'diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--'
  ], {cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024});
  if (!stdout.trim()) throw new Error('Stage changes before requesting a ChatGPT commit title.');
  return stdout.slice(0, MAX_DIFF);
}

function registerChatgptCommitTitle(vscode, context, dependencies = {}) {
  const start = dependencies.start || startNativeSpellcheckBridge;
  const diff = dependencies.diff || stagedDiff;
  const disposable = vscode.commands.registerCommand('sweetiebot.suggestCommitTitleWithChatGPT', async resource => {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    const git = await gitExtension?.activate();
    const repositories = git?.getAPI(1)?.repositories || [];
    const hintedPath = resource?.rootUri?.fsPath || resource?.fsPath;
    let repository = repositories.find(item => item.rootUri.fsPath === hintedPath);
    if (!repository && repositories.length === 1) repository = repositories[0];
    if (!repository && repositories.length > 1) {
      const picked = await vscode.window.showQuickPick(repositories.map(item => ({
        label: item.rootUri.fsPath, repository: item
      })), {placeHolder: 'Choose a repository with staged changes'});
      repository = picked?.repository;
    }
    if (!repository) return null;
    const originalTitle = repository.inputBox?.value ?? '';
    const data = await diff(repository.rootUri.fsPath);
    const consent = await vscode.window.showWarningMessage(
      'Send up to 16,000 characters of the staged diff to ChatGPT for a commit-title suggestion? It may contain private code. No commit will be created.',
      {modal: true}, 'Send to ChatGPT'
    );
    if (consent !== 'Send to ChatGPT') return null;
    if (!(await vscode.commands.getCommands(true)).includes('workbench.action.browser.open')) {
      throw new Error('This VS Code build does not have the native Integrated Browser.');
    }
    const projectUrl = resolveChatgptReviewProjectUrl(
      vscode.workspace.getConfiguration('scmToolkit', repository.rootUri));
    const session = await start({title: originalTitle.slice(0, 512), body: data},
      {projectUrl, mode: 'commit-title'});
    try {
      await vscode.commands.executeCommand('workbench.action.browser.open', {
        url: session.url, openToSide: false, reuseUrlFilter: session.url
      });
      const reply = await session.completed;
      if (!acceptableTitle(reply.title) || reply.body !== '') {
        throw new Error('ChatGPT did not return a valid concise commit title.');
      }
      if (repository.inputBox?.value !== originalTitle) {
        throw new Error('The Source Control message changed. The suggestion was not applied.');
      }
      const choice = await vscode.window.showInformationMessage(
        'Use this ChatGPT commit title? ' + reply.title,
        {modal: true}, 'Use title'
      );
      if (choice !== 'Use title') return reply.title;
      if (repository.inputBox?.value !== originalTitle) {
        throw new Error('The Source Control message changed. The suggestion was not applied.');
      }
      repository.inputBox.value = reply.title;
      return reply.title;
    } catch (error) {
      session.cancel();
      throw error;
    }
  });
  context.subscriptions.push(disposable);
}

module.exports = {acceptableTitle, stagedDiff, registerChatgptCommitTitle};
