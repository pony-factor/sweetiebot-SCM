'use strict';

const assert = require('node:assert/strict');
const {
  repositoryName,
  repositoryUrlForGitRepository,
  fetchOpenPullRequests,
  pickPullRequests,
  batchMergePrompt,
  registerPullRequestBatchCommand
} = require('../efs/pull_request_batch');

async function run() {
  assert.equal(repositoryName('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(repositoryName('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(repositoryName('https://gitlab.com/owner/repo'), undefined);

  assert.equal(repositoryUrlForGitRepository({
    state: { remotes: [
      { name: 'backup', fetchUrl: 'https://github.com/backup/repo.git' },
      { name: 'origin', pushUrl: 'git@github.com:owner/repo.git' }
    ] }
  }), 'https://github.com/owner/repo');
  assert.equal(repositoryUrlForGitRepository({ state: { remotes: [] } }), undefined);

  const requested = [];
  const apiPulls = [
    {
      number: 10, title: 'Ready change', html_url: 'https://github.com/owner/repo/pull/10',
      draft: false, base: { ref: 'main' }, head: { ref: 'ready-change' }
    },
    {
      number: 12, title: 'Newest ready change', html_url: 'https://github.com/owner/repo/pull/12',
      draft: false, base: { ref: 'main' }, head: { ref: 'newest' }
    },
    {
      number: 11, title: 'Draft change', html_url: 'https://github.com/owner/repo/pull/11',
      draft: true, base: { ref: 'main' }, head: { ref: 'draft' }
    },
    {
      number: 9, title: 'Wrong base', html_url: 'https://github.com/owner/repo/pull/9',
      draft: false, base: { ref: 'develop' }, head: { ref: 'develop-only' }
    }
  ];
  const pulls = await fetchOpenPullRequests('https://github.com/owner/repo', 'token', async (url, options) => {
    requested.push({ url, options });
    return { ok: true, status: 200, async json() { return apiPulls; } };
  });
  assert.deepEqual(pulls.map(pr => pr.number), [12, 10]);
  assert.match(requested[0].url, /state=open&base=main/);
  assert.equal(requested[0].options.headers.Authorization, 'Bearer token');

  const allResult = await pickPullRequests({
    window: { async showQuickPick(items, options) {
      assert.equal(options.canPickMany, true);
      assert.equal(options.placeHolder, 'Select one or more pull requests, then press OK.');
      assert.equal(items.length, pulls.length);
      assert.equal(items.some(item => item.selectAll), false);
      return items;
    } }
  }, pulls);
  assert.deepEqual(allResult, pulls);

  const oneResult = await pickPullRequests({
    window: { async showQuickPick(items) { return [items[1]]; } }
  }, pulls);
  assert.deepEqual(oneResult.map(pr => pr.number), [10]);

  const prompt = batchMergePrompt({
    repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [pulls[0]],
    base: 'main'
  });
  assert.match(prompt, /Squash and merge the following selected pull request into "main"/);
  assert.match(prompt, /#12: Newest ready change/);
  assert(!prompt.includes('#10: Ready change'));
  assert.match(prompt, /Do not merge, close, edit, or otherwise act on any unselected pull request/);
  assert.match(prompt, /force-with-lease/);
  assert.match(prompt, /verify the resulting tree differs from its parent/);

  let handler;
  const browserCalls = [];
  const errors = [];
  const infos = [];
  const localRepository = {
    rootUri: { scheme: 'file', fsPath: '/workspace/repo' },
    state: { remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }] }
  };
  const vscode = {
    extensions: {
      getExtension(id) {
        assert.equal(id, 'vscode.git');
        return { async activate() { return { getAPI() { return { repositories: [localRepository] }; } }; } };
      }
    },
    authentication: {
      async getSession(provider, scopes, options) {
        assert.equal(provider, 'github');
        assert.deepEqual(scopes, ['repo']);
        assert.equal(options.createIfNone, true);
        return { accessToken: 'linked-token' };
      }
    },
    commands: {
      registerCommand(id, callback) {
        assert.equal(id, 'sweetiebot.openPullRequestBatchChat');
        handler = callback;
        return { dispose() {} };
      },
      async getCommands() { return ['workbench.action.browser.open']; },
      async executeCommand(id, options) { browserCalls.push({ id, options }); }
    },
    window: {
      async showQuickPick(items, options) {
        assert.equal(options.canPickMany, true);
        return [items[0]];
      },
      showErrorMessage(message) { errors.push(message); },
      showInformationMessage(message) { infos.push(message); }
    }
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [
        {
          number: 41, title: 'Selected PR', html_url: 'https://github.com/owner/repo/pull/41',
          draft: false, base: { ref: 'main' }, head: { ref: 'selected' }
        },
        {
          number: 40, title: 'Unselected PR', html_url: 'https://github.com/owner/repo/pull/40',
          draft: false, base: { ref: 'main' }, head: { ref: 'unselected' }
        }
      ];
    }
  });
  registerPullRequestBatchCommand(vscode, { subscriptions: [] }, fetchImpl);
  await handler();
  assert.equal(errors.length, 0);
  assert.equal(infos.length, 0);
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0].id, 'workbench.action.browser.open');
  const chat = new URL(browserCalls[0].options.url);
  assert.equal(chat.origin, 'https://chatgpt.com');
  const sentPrompt = chat.searchParams.get('q');
  assert.match(sentPrompt, /pull\/41/);
  assert(!sentPrompt.includes('pull/40'));
  assert.equal(browserCalls[0].options.openToSide, false);

  const pkg = require('../efs/package.json');
  assert(pkg.activationEvents.includes('onCommand:sweetiebot.openPullRequestBatchChat'));
  assert(pkg.contributes.commands.some(command => command.command === 'sweetiebot.openPullRequestBatchChat'));
  assert(pkg.contributes.menus['view/title'].some(item =>
    item.command === 'sweetiebot.openPullRequestBatchChat' && item.when.includes('view == pr:github')
  ));

  console.log('Batch pull-request merge chat checks passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
