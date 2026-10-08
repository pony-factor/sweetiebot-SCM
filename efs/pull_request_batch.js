'use strict';

const { execFile } = require('child_process');
const { githubRepository } = require('./pull_request');
const { chatgptPromptUrl } = require('./chatgpt_project');

const CHAT_SUBMIT_DELAY_MS = 3000;

function repositoryName(repositoryUrl) {
  const normalized = githubRepository(repositoryUrl);
  return normalized ? normalized.slice('https://github.com/'.length) : undefined;
}

function repositoryUrlForGitRepository(repository) {
  const remotes = Array.isArray(repository?.state?.remotes) ? repository.state.remotes : [];
  const ordered = [
    ...remotes.filter(remote => remote?.name === 'origin'),
    ...remotes.filter(remote => remote?.name !== 'origin')
  ];
  for (const remote of ordered) {
    const url = githubRepository(remote?.pushUrl || remote?.fetchUrl);
    if (url) return url;
  }
  return undefined;
}

async function workspaceGitHubRepositories(vscode) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) throw new Error('The VS Code Git extension is unavailable.');
  const git = await extension.activate();
  const repositories = [];
  for (const repository of git.getAPI(1).repositories) {
    const repositoryUrl = repositoryUrlForGitRepository(repository);
    if (!repositoryUrl) continue;
    repositories.push({
      repository,
      repositoryUrl,
      name: repositoryName(repositoryUrl)
    });
  }
  return repositories;
}

async function chooseRepository(vscode, repositories) {
  if (!repositories.length) throw new Error('Open a local GitHub repository first.');
  if (repositories.length === 1) return repositories[0];
  const selected = await vscode.window.showQuickPick(
    repositories.map(entry => ({
      label: entry.name,
      description: entry.repository.rootUri?.fsPath || '',
      entry
    })),
    {
      title: 'Choose a repository',
      placeHolder: 'Select the repository whose open pull requests you want to merge.'
    }
  );
  return selected?.entry;
}

async function fetchOpenPullRequests(repositoryUrl, accessToken, fetchImpl = globalThis.fetch) {
  const fullName = repositoryName(repositoryUrl);
  if (!fullName) throw new Error('The selected repository does not have a GitHub remote.');
  const [owner, repo] = fullName.split('/');
  const pulls = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&base=main&per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    if (!response.ok) throw new Error(`GitHub pull-request lookup failed (${response.status}).`);
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) throw new Error('GitHub returned an invalid pull-request list.');
    for (const pr of pageItems) {
      if (pr?.draft || pr?.base?.ref !== 'main') continue;
      const number = Number(pr.number);
      const url = String(pr.html_url || '');
      if (!Number.isInteger(number) || number < 1 || !/^https:\/\/github\.com\//.test(url)) continue;
      pulls.push({
        number,
        title: String(pr.title || `Pull request #${number}`),
        url,
        head: String(pr.head?.ref || '')
      });
    }
    if (pageItems.length < 100) break;
  }
  return pulls.sort((a, b) => b.number - a.number);
}

async function pickPullRequests(vscode, pullRequests) {
  const picker = vscode.window.createQuickPick();
  const queueAllButton = {
    iconPath: new vscode.ThemeIcon('run-all'),
    tooltip: 'Queue all pull requests in ChatGPT (one click)'
  };
  picker.items = pullRequests.map(pullRequest => ({
    label: '#' + pullRequest.number + ' ' + pullRequest.title,
    description: pullRequest.head ? '← ' + pullRequest.head : '',
    detail: pullRequest.url,
    pullRequest
  }));
  picker.canSelectMany = true;
  picker.title = 'Squash and merge with ChatGPT';
  picker.placeholder = 'Select pull requests and press OK, or use Queue All to submit every PR.';
  picker.buttons = [queueAllButton];

  return new Promise(resolve => {
    let finished = false;
    const listeners = [];
    const finish = selection => {
      if (finished) return;
      finished = true;
      picker.hide();
      for (const listener of listeners) listener.dispose();
      picker.dispose();
      resolve(selection);
    };
    listeners.push(
      picker.onDidTriggerButton(button => {
        if (button === queueAllButton) finish([...pullRequests]);
      }),
      picker.onDidAccept(() => {
        finish(picker.selectedItems.flatMap(item => item.pullRequest ? [item.pullRequest] : []));
      }),
      picker.onDidHide(() => finish(undefined))
    );
    picker.show();
  });
}

function batchMergePrompt({ repositoryUrl, pullRequests, base = 'main' }) {
  if (!Array.isArray(pullRequests) || !pullRequests.length) {
    throw new Error('Select at least one pull request.');
  }
  const list = pullRequests.map(pr =>
    `- #${pr.number}: ${pr.title} — ${pr.url}${pr.head ? ` (head: ${pr.head})` : ''}`
  ).join('\n');
  return [
    `Squash and merge the following selected pull request${pullRequests.length === 1 ? '' : 's'} into ${JSON.stringify(base)} in repository ${repositoryUrl}:`,
    list,
    `Use the GitHub connection or tools available in this chat. Read the current ${base} branch and every selected pull request and diff before making changes. Re-check each selected pull request immediately before merging it. Do not merge, close, edit, or otherwise act on any unselected pull request.`,
    'Determine a safe merge order from dependencies, overlapping changes, and the current branch state. For each selected pull request, squash-merge its intended changes into main and use the pull-request title as the resulting squash commit title. If an earlier merge changes what a later pull request needs, reconcile the later pull request safely rather than blindly merging stale or duplicated changes.',
    'Before creating or updating any commit, verify the resulting tree differs from its parent and that the intended changes are actually present. Never force-push main or another protected branch. If rewriting a selected pull-request branch is genuinely necessary, use force-with-lease only on that pull-request branch. Preserve unrelated work and delete a merged source branch only when it is safe.',
    'If a selected pull request cannot be merged safely, explain the blocker instead of substituting a different pull request or forcing the merge. Continue with other selected pull requests only when the blocker does not make them unsafe.'
  ].join('\n\n');
}

function classifyChatSubmitError(error, stderr = '') {
  const detail = String(stderr || error?.message || '').trim();
  let reason = 'script';
  if (/VS Code is not frontmost/i.test(detail)) reason = 'focus';
  else if (/assistive access|accessibility|not allowed to send keystrokes|-25211/i.test(detail)) reason = 'accessibility';
  else if (/not authorized to send Apple events|-1743/i.test(detail)) reason = 'automation';
  return { submitted: false, reason, detail };
}

function submitChatPromptWithEnter(execFileImpl = execFile, options = {}) {
  const platform = options.platform ?? process.platform;
  const delayMs = options.delayMs ?? CHAT_SUBMIT_DELAY_MS;
  if (platform !== 'darwin') return Promise.resolve({ submitted: false, reason: 'unsupported' });
  return new Promise(resolve => {
    setTimeout(() => {
      const script = [
        'tell application "System Events"',
        'set frontApp to name of first application process whose frontmost is true',
        'if frontApp contains "Code" then',
        'key code 36',
        'else',
        'error ("VS Code is not frontmost: " & frontApp) number 1001',
        'end if',
        'end tell'
      ].join('\n');
      execFileImpl('/usr/bin/osascript', ['-e', script], (error, _stdout, stderr) => {
        resolve(error ? classifyChatSubmitError(error, stderr) : { submitted: true });
      });
    }, delayMs);
  });
}

function registerPullRequestBatchCommand(vscode, context, fetchImpl = globalThis.fetch, submitPrompt = submitChatPromptWithEnter, platform = process.platform) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.openPullRequestBatchChat', async () => {
    try {
      if (!(await vscode.commands.getCommands(true)).includes('workbench.action.browser.open')) {
        throw new Error('Update VS Code to open ChatGPT in the Integrated Browser.');
      }
      const repositories = await workspaceGitHubRepositories(vscode);
      const selectedRepository = await chooseRepository(vscode, repositories);
      if (!selectedRepository) return;
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      const pullRequests = await fetchOpenPullRequests(
        selectedRepository.repositoryUrl, session.accessToken, fetchImpl
      );
      if (!pullRequests.length) {
        vscode.window.showInformationMessage('No open, ready-for-review pull requests targeting main were found.');
        return;
      }
      const selected = await pickPullRequests(vscode, pullRequests);
      if (selected === undefined) return;
      if (!selected.length) {
        vscode.window.showInformationMessage('Select at least one pull request.');
        return;
      }
      const prompt = batchMergePrompt({
        repositoryUrl: selectedRepository.repositoryUrl,
        pullRequests: selected,
        base: 'main'
      });
      const projectUrl = vscode.workspace?.getConfiguration('scmToolkit').get('chatgptProjectUrl', '') || '';
      const url = chatgptPromptUrl(prompt, projectUrl);
      await vscode.commands.executeCommand('workbench.action.browser.open', {
        url,
        openToSide: false,
        reuseUrlFilter: url
      });
      const submission = await submitPrompt();
      if (platform === 'darwin' && submission !== true && !submission?.submitted) {
        const message = submission?.reason === 'focus'
          ? 'ChatGPT opened, but VS Code was not frontmost when Sweetiebot tried to press Return. Focus VS Code and retry, or submit the prompt manually.'
          : submission?.reason === 'accessibility'
            ? 'ChatGPT opened, but macOS denied the Return key event. Check which VS Code process has Accessibility access and restart VS Code after any permission change.'
            : submission?.reason === 'automation'
              ? 'ChatGPT opened, but macOS denied automation of System Events. Check System Settings > Privacy & Security > Automation.'
              : 'ChatGPT opened, but automatic Return failed for a reason other than confirmed Accessibility denial. Submit the prompt manually. ' + String(submission?.detail || '').slice(0, 200);
        vscode.window.showWarningMessage(message.trim());
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to prepare pull-request merge chat: ${error.message}`);
    }
  }));
}

module.exports = {
  repositoryName,
  repositoryUrlForGitRepository,
  workspaceGitHubRepositories,
  fetchOpenPullRequests,
  pickPullRequests,
  batchMergePrompt,
  submitChatPromptWithEnter,
  classifyChatSubmitError,
  registerPullRequestBatchCommand
};
