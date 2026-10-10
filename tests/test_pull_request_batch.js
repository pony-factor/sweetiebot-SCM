'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  repositoryName,
  repositoryUrlForGitRepository,
  fetchOpenPullRequests,
  pickPullRequests,
  batchMergePrompt,
  submitChatPromptWithEnter,
  classifyChatSubmitError,
  registerPullRequestBatchCommand
} = require('../efs/pull_request_batch');

async function run() {
  const extensionSource = readFileSync(path.join(__dirname, '../efs/extension.js'), 'utf8');
  const recoveryAwait = extensionSource.indexOf('await registerPushRecovery(vscode, context);');
  const aliases = extensionSource.indexOf('registerLegacyCommandAliases(vscode, context);');
  assert(recoveryAwait > -1);
  assert(aliases > -1);
  for (const registration of [
    'registerPullRequestBatchCommand(vscode, context);',
    'registerGitHubPullRequestActions(vscode, context);'
  ]) {
    const index = extensionSource.indexOf(registration);
    assert(index > -1 && index < aliases, `${registration} must be registered before legacy compatibility aliases`);
    assert(index < recoveryAwait, `${registration} must be registered before awaited startup recovery`);
  }

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
  assert.deepEqual(pulls.map(pr => pr.number), [12, 10, 9]);
  assert.deepEqual(pulls.map(pr => pr.base), ['main', 'main', 'develop']);
  assert.match(requested[0].url, /state=open&per_page=100/);
  assert(!requested[0].url.includes('base=main'));
  assert.equal(requested[0].options.headers.Authorization, 'Bearer token');

  function pickerHarness(action, verify = () => {}) {
    const events = {};
    let hidden = false;
    let disposed = false;
    const picker = {
      items: [],
      buttons: [],
      selectedItems: [],
      onDidTriggerButton(callback) { events.button = callback; return { dispose() {} }; },
      onDidAccept(callback) { events.accept = callback; return { dispose() {} }; },
      onDidHide(callback) { events.hide = callback; return { dispose() {} }; },
      show() {
        verify(this);
        if (action === 'all') events.button(this.buttons[0]);
        else if (action === 'one') {
          this.selectedItems = [this.items[1]];
          events.accept();
        } else if (action === 'first') {
          this.selectedItems = [this.items[0]];
          events.accept();
        } else if (action === 'empty') events.accept();
        else if (action === 'cancel') events.hide();
      },
      hide() {
        if (!hidden) {
          hidden = true;
          events.hide();
        }
      },
      dispose() { disposed = true; }
    };
    return {
      picker,
      vscode: {
        ThemeIcon: class { constructor(id) { this.id = id; } },
        window: { createQuickPick() { return picker; } }
      },
      get disposed() { return disposed; }
    };
  }

  const allPicker = pickerHarness('all', picker => {
    assert.equal(picker.canSelectMany, true);
    assert.equal(picker.items.length, pulls.length);
    assert.equal(picker.items.some(item => item.selectAll), false);
    assert.equal(picker.buttons.length, 1);
    assert.equal(picker.buttons[0].iconPath.id, 'run-all');
    assert.match(picker.buttons[0].tooltip, /Queue all pull requests/);
  });
  assert.deepEqual(await pickPullRequests(allPicker.vscode, pulls), pulls);
  assert.equal(allPicker.disposed, true);

  const onePicker = pickerHarness('one');
  const oneResult = await pickPullRequests(onePicker.vscode, pulls);
  assert.deepEqual(oneResult.map(pr => pr.number), [10]);
  assert.equal(onePicker.disposed, true);

  const emptyPicker = pickerHarness('empty');
  assert.deepEqual(await pickPullRequests(emptyPicker.vscode, pulls), []);
  const cancelPicker = pickerHarness('cancel');
  assert.equal(await pickPullRequests(cancelPicker.vscode, pulls), undefined);
  assert.equal(cancelPicker.disposed, true);

  const prompt = batchMergePrompt({
    repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [pulls[0]],
    base: 'main'
  });
  assert.match(prompt, /Squash and merge the following selected pull request into each PR's explicitly listed base branch/);
  assert.match(prompt, /base: "main"/);
  const mixedPrompt = batchMergePrompt({ repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [pulls[0], pulls[2]] });
  assert.match(mixedPrompt, /#9: Wrong base/);
  assert.match(mixedPrompt, /base: "develop"/);
  assert.match(mixedPrompt, /ONLY into its listed base branch/);
  assert.match(mixedPrompt, /request fresh confirmation/);
  assert.match(prompt, /#12: Newest ready change/);
  assert(!prompt.includes('#10: Ready change'));
  assert.match(prompt, /Do not merge, close, edit, or otherwise act on any unselected pull request/);
  assert.match(prompt, /force-with-lease/);
  assert.match(prompt, /verify the resulting tree differs from its parent/);

  let osascriptCall;
  const submittedWithEnter = await submitChatPromptWithEnter(
    (file, args, callback) => {
      osascriptCall = { file, args };
      callback(null);
    },
    { platform: 'darwin', delayMs: 0 }
  );
  assert.deepEqual(submittedWithEnter, { submitted: true });
  assert.equal(osascriptCall.file, '/usr/bin/osascript');
  assert.equal(osascriptCall.args[0], '-e');
  assert.match(osascriptCall.args[1], /frontApp contains "Code"/);
  assert.match(osascriptCall.args[1], /tell application "System Events"\nset frontApp/);
  assert.match(osascriptCall.args[1], /key code 36/);
  assert.match(osascriptCall.args[1], /\nkey code 36\n/);
  assert(!osascriptCall.args[1].includes('\\n'), 'AppleScript must contain real newlines, not backslash-n text');
  assert.deepEqual(await submitChatPromptWithEnter(() => {}, { platform: 'linux', delayMs: 0 }), { submitted: false, reason: 'unsupported' });
  assert.equal(classifyChatSubmitError(new Error('VS Code is not frontmost: Finder')).reason, 'focus');
  assert.equal(classifyChatSubmitError(new Error('osascript is not allowed assistive access. (-25211)')).reason, 'accessibility');
  assert.equal(classifyChatSubmitError(new Error('Not authorized to send Apple events. (-1743)')).reason, 'automation');
  assert.equal(classifyChatSubmitError(new Error('Expected end of line')).reason, 'script');
  const failedSubmission = await submitChatPromptWithEnter(
    (_file, _args, callback) => callback(new Error('Expected end of line')),
    { platform: 'darwin', delayMs: 0 }
  );
  assert.equal(failedSubmission.reason, 'script');

  let handler;
  const browserCalls = [];
  const errors = [];
  const infos = [];
  const warnings = [];
  const localRepository = {
    rootUri: { scheme: 'file', fsPath: '/workspace/repo' },
    state: { remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }] }
  };
  let configuredProject = '';
  let pickerAction = 'first';
  let includeNonMain = false;
  let approveNonMain = false;
  const modalWarnings = [];
  const vscode = {
    ThemeIcon: class { constructor(id) { this.id = id; } },
    workspace: { getConfiguration(section) {
      assert.equal(section, 'scmToolkit');
      return { get(key, fallback) { assert.equal(key, 'chatgptProjectUrl'); return configuredProject || fallback; } };
    } },
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
      createQuickPick() { return pickerHarness(pickerAction).picker; },
      showErrorMessage(message) { errors.push(message); },
      showInformationMessage(message) { infos.push(message); },
      showWarningMessage(message, options, action) {
        if (options?.modal) {
          modalWarnings.push({ message, options, action });
          return approveNonMain ? action : undefined;
        }
        warnings.push(message);
      }
    }
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [
        {
          number: 41, title: 'Selected PR', html_url: 'https://github.com/owner/repo/pull/41',
          draft: false, base: { ref: includeNonMain ? 'kefania' : 'main' }, head: { ref: 'selected' }
        },
        {
          number: 40, title: 'Unselected PR', html_url: 'https://github.com/owner/repo/pull/40',
          draft: false, base: { ref: 'main' }, head: { ref: 'unselected' }
        }
      ];
    }
  });
  let submitCalls = 0;
  registerPullRequestBatchCommand(vscode, { subscriptions: [] }, fetchImpl, async () => {
    submitCalls += 1;
    return true;
  });
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
  assert.equal(submitCalls, 1);

  pickerAction = 'all';
  await handler();
  const allChat = new URL(browserCalls.at(-1).options.url);
  assert.match(allChat.searchParams.get('q'), /pull\/41/);
  assert.match(allChat.searchParams.get('q'), /pull\/40/);
  assert.equal(submitCalls, 2);
  includeNonMain = true;
  pickerAction = 'first';
  await handler();
  assert.equal(browserCalls.length, 2, 'Dismissing the non-main confirmation must not open ChatGPT');
  assert.equal(submitCalls, 2);
  assert.equal(modalWarnings.length, 1);
  assert.match(modalWarnings[0].message, /kefania.*not main/);
  assert.equal(modalWarnings[0].options.modal, true);
  approveNonMain = true;
  await handler();
  const alternateChat = new URL(browserCalls.at(-1).options.url);
  assert.match(alternateChat.searchParams.get('q'), /base: "kefania"/);
  assert.equal(submitCalls, 3);
  includeNonMain = false;
  approveNonMain = false;
  pickerAction = 'cancel';
  await handler();
  assert.equal(browserCalls.length, 3, 'Cancelling must not submit a merge request');
  assert.equal(submitCalls, 3);
  pickerAction = 'first';

  configuredProject = 'https://chatgpt.com/g/g-p-example/project';
  await handler();
  const scopedChat = new URL(browserCalls.at(-1).options.url);
  assert.equal(scopedChat.pathname, '/g/g-p-example/project');
  assert.match(scopedChat.searchParams.get('q'), /pull\/41/);
  assert.equal(submitCalls, 4);
  configuredProject = '';

  registerPullRequestBatchCommand(vscode, { subscriptions: [] }, fetchImpl, async () => ({ submitted: false, reason: 'focus' }), 'darwin');
  await handler();
  assert.match(warnings.pop(), /not frontmost/);
  registerPullRequestBatchCommand(vscode, { subscriptions: [] }, fetchImpl, async () => ({ submitted: false, reason: 'script', detail: 'Expected end of line' }), 'darwin');
  await handler();
  assert.match(warnings.pop(), /Expected end of line/);

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
