'use strict';

const { githubRepository } = require('./pull_request');
const { openCompactKefaniaChat } = require('./kefania_chat_window');
const { chatgptMergeUrl, resolveChatgptActionProject } = require('./chatgpt_project');

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
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100&page=${page}`,
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
      if (pr?.draft || !pr?.base?.ref) continue;
      const number = Number(pr.number);
      const url = String(pr.html_url || '');
      if (!Number.isInteger(number) || number < 1 || !/^https:\/\/github\.com\//.test(url)) continue;
      pulls.push({
        number,
        title: String(pr.title || `Pull request #${number}`),
        url,
        head: String(pr.head?.ref || ''),
        headRepo: String(pr.head?.repo?.full_name || ''),
        base: String(pr.base.ref),
        baseRepo: fullName,
        stack: pr.stack && typeof pr.stack === 'object' ? pr.stack : null
      });
    }
    if (pageItems.length < 100) break;
  }
  return pulls.sort((a, b) => b.number - a.number);
}

/** Find complete selected linear chains rooted at main. A branch-name link is
 * only a preview: verify GitHub-native stack membership before merging. */
function planStackMerges(pullRequests, repositoryFullName, defaultBranch = 'main') {
  const heads = new Map();
  for (const pr of pullRequests) {
    if (!pr.head || pr.headRepo !== repositoryFullName) continue;
    heads.set(pr.head, heads.has(pr.head) ? null : pr);
  }
  const children = new Map();
  for (const pr of pullRequests) {
    if (pr.base !== defaultBranch) children.set(pr.base, (children.get(pr.base) || 0) + 1);
  }
  const ancestry = (pr, seen = new Set()) => {
    if (seen.has(pr.number)) return null;
    if (pr.base === defaultBranch) return { stackDepth: 0, stackRoot: pr.number, stackParent: null };
    // Forks, duplicate heads, cycles and branched chains cannot be inferred
    // safely as a single contiguous stack.
    if (children.get(pr.base) !== 1) return null;
    const parent = heads.get(pr.base);
    if (!parent || parent.number === pr.number) return null;
    const chain = ancestry(parent, new Set([...seen, pr.number]));
    return chain && { stackDepth: chain.stackDepth + 1, stackRoot: chain.stackRoot, stackParent: parent.number };
  };
  const ordered = pullRequests.map(pr => ({
    ...pr, ...(ancestry(pr) || { stackDepth: null, stackRoot: null, stackParent: null })
  })).sort((a, b) => {
    if (a.stackDepth === null) return b.stackDepth === null ? b.number - a.number : 1;
    if (b.stackDepth === null) return -1;
    return b.stackRoot - a.stackRoot || a.stackDepth - b.stackDepth || a.number - b.number;
  });
  return {
    ordered,
    stacked: ordered.filter(pr => pr.stackDepth > 0),
    nonMain: ordered.filter(pr => pr.base !== defaultBranch && pr.stackDepth === null)
  };
}

async function pickPullRequests(vscode, pullRequests) {
  const picker = vscode.window.createQuickPick();
  const queueAllButton = {
    iconPath: new vscode.ThemeIcon('run-all'),
    tooltip: 'Queue all pull requests in ChatGPT (one click)'
  };
  const plan = planStackMerges(pullRequests, pullRequests[0]?.baseRepo);
  picker.items = plan.ordered.map(item => ({
    label: `${'↳ '.repeat(item.stackDepth || 0)}#${item.number} ${item.title}`,
    description: `${item.head ? item.head + ' → ' : ''}${item.base}${item.stackDepth > 0 ? ' (stacked toward main)' : item.stack ? ' (GitHub stack)' : ''}`,
    detail: item.url,
    pullRequest: pullRequests.find(pr => pr.number === item.number)
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

function batchMergePrompt({ repositoryUrl, pullRequests }) {
  if (!Array.isArray(pullRequests) || !pullRequests.length) {
    throw new Error('Select at least one pull request.');
  }
  if (pullRequests.some(pr => !pr.base)) throw new Error('A selected pull request has no target branch.');
  const plan = planStackMerges(pullRequests, repositoryName(repositoryUrl));
  const hasStack = plan.stacked.length > 0 || plan.ordered.some(pr => pr.stack);
  const list = plan.ordered.map(pr =>
    `- #${pr.number}: ${pr.title} — ${pr.url} (head: ${pr.head || 'unknown'}; base: ${JSON.stringify(pr.base)}${pr.stackDepth > 0 ? `; selected parent: #${pr.stackParent}; intended destination: main` : ''}${pr.stack ? '; GitHub stack metadata present' : ''})`
  ).join('\n');
  const summary = hasStack
    ? `Squash and merge the following selected pull requests in repository ${repositoryUrl}. Complete selected stacks must land on main in ancestor-first order, with ONE separate squash commit per PR. Unrelated PRs retain their explicitly listed bases:`
    : `Squash and merge the following selected pull request${pullRequests.length === 1 ? '' : 's'} into each PR's explicitly listed base branch in repository ${repositoryUrl}:`;
  return [
    summary,
    list,
    'Use the GitHub connection or tools available in this chat. Inspect main, every selected base and PR, and every diff before changes. Re-check each selected PR and its head/base just before acting. A snapshot mismatch requires fresh confirmation. Never merge, close, edit, or implicitly include an unselected PR.',
    hasStack
      ? 'COMPLETE SELECTED STACKS: The list is ordered from closest to main upward. For GitHub-native linked stacks, first verify live GitHub stack membership, the base branch, all approvals/checks, and that the exact contiguous prefix through the highest selected PR contains ONLY selected PRs. Prefer the GitHub-native atomic stack squash operation: gh stack merge <highest-selected-PR-number> --yes --squash, or the equivalent asynchronous stack-merge REST API. Do NOT use gh pr merge or the legacy synchronous merge endpoint for a native stack. GitHub creates one squash commit per PR. If a merge queue overrides the squash method, report that limitation; do not promise squash commits. Poll/verify each actual merge result rather than assuming a queued request completed. Do not add unselected PRs just to complete a stack.'
      : 'Determine a safe merge order from dependencies, overlapping changes, and current branch states.',
    hasStack
      ? 'BRANCH-LINKED BUT NOT GITHUB-NATIVE: Do not mistake a head/base branch-name chain for verified native stack membership. If native stack merge is unavailable, only use manual ancestor-first squash and child-only replay when you can prove each child diff excludes all ancestor changes, safely retarget ONLY selected descendants to main, respect branch protections, and preserve one squash commit per PR. Do not force-push a protected or unselected parent/base branch. If that cannot be verified and performed safely with available tools, STOP that stack; never fall back to merging children into parent branches and calling the result delivered to main.'
      : '',
    'For GitHub-native stacked PRs missing selected lower ancestors, STOP and request a complete prefix: never merge one into an intermediate base or implicitly include its unselected ancestors. PRs outside complete selected stacks and without native stack membership must merge ONLY into their originally listed base branch. Do not silently merge them into main or pull in an unselected dependency. Report blockers or unexpected base changes and continue only with unrelated safe PRs.',
    'Before creating or updating commits, verify the resulting tree differs from its parent and intended changes are present. Use each PR title as its squash-commit title and include the required Codex Web co-author trailer wherever the operation allows explicit commit text. Never force-push main or any protected/PR base branch. Any necessary rewrite of a selected PR head must use force-with-lease and must not affect an unselected PR. Preserve unrelated work.',
    'Report which PRs actually landed on main versus another branch, which were only queued, and which were blocked. Never collapse multiple selected PRs into a single squash commit or claim an intermediate-branch merge reached main.'
  ].filter(Boolean).join('\n\n');
}

function registerPullRequestBatchCommand(vscode, context, fetchImpl = globalThis.fetch) {
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
        vscode.window.showInformationMessage('No open, ready-for-review pull requests were found.');
        return;
      }
      const selected = await pickPullRequests(vscode, pullRequests);
      if (selected === undefined) return;
      if (!selected.length) {
        vscode.window.showInformationMessage('Select at least one pull request.');
        return;
      }
      const plan = planStackMerges(selected, repositoryName(selectedRepository.repositoryUrl));
      // A native stacked PR cannot merge above unselected lower layers.
      const incompleteNative = plan.nonMain.filter(pr => pr.stack);
      if (incompleteNative.length) {
        vscode.window.showWarningMessage(
          `Select the missing lower PRs for GitHub stack member(s) ${incompleteNative.map(pr => '#' + pr.number).join(', ')}. A partial stack cannot be merged into main safely.`,
          { modal: true, detail: 'Select a contiguous prefix from main up to each desired layer; no merge request was launched.' }
        );
        return;
      }
      // A complete selected stack targets main even when intermediate PRs
      // have another selected PR's branch as their direct base.
      if (plan.nonMain.length) {
        const targets = [...new Set(plan.nonMain.map(pr => pr.base))].map(name => '"' + name + '"').join(', ');
        const selectedNumbers = new Set(selected.map(pr => pr.number));
        const missing = [...new Set(plan.nonMain.flatMap(pr => pullRequests
          .filter(candidate => candidate.head === pr.base
            && candidate.headRepo === repositoryName(selectedRepository.repositoryUrl)
            && !selectedNumbers.has(candidate.number))
          .map(candidate => '#' + candidate.number)))];
        const action = 'Continue with non-main targets';
        const choice = await vscode.window.showWarningMessage(
          `Selected PRs target ${targets}, not main, and are not part of a complete selected stack. Continue with those base branches?`,
          { modal: true, detail: missing.length
            ? `Missing selected parent PR(s): ${missing.join(', ')}. Select a complete stack to land separate squash commits on main; otherwise merge only into the stated base.`
            : 'These PRs merge into their stated bases, not automatically main. Complete selected stacks do not trigger this warning.' },
          action
        );
        if (choice !== action) return;
      }
      const prompt = batchMergePrompt({
        repositoryUrl: selectedRepository.repositoryUrl,
        pullRequests: selected
      });
      const projectUrl = await resolveChatgptActionProject(vscode, context);
      if (projectUrl === undefined) return;
      const url = chatgptMergeUrl(prompt, projectUrl);
      // The browser preload polls for a ready Send button instead of waiting
      // three seconds and sending Return through macOS accessibility APIs.
      await openCompactKefaniaChat(vscode, url, { floating: false });
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
  planStackMerges,
  batchMergePrompt,
  registerPullRequestBatchCommand
};
