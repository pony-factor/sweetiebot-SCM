'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  repositoryName,
  repositoryUrlForGitRepository,
  fetchOpenPullRequests,
  pickPullRequests,
  planStackMerges,
  squashCommitTitle,
  batchMergePrompt,
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
  assert.deepEqual(pulls.map(pr => pr.number), [9, 10, 12]);
  const newestPull = pulls.find(pr => pr.number === 12);
  const nonMainPull = pulls.find(pr => pr.number === 9);
  assert.deepEqual(pulls.map(pr => pr.base), ['develop', 'main', 'main']);
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
        if (action === 'all') { this.selectedItems = [...this.items]; events.accept(); }
        else if (action === 'one') {
          this.selectedItems = [this.items[1]];
          events.accept();
        } else if (action === 'first') {
          this.selectedItems = [this.items[0]];
          events.accept();
        } else if (action === 'top') {
          this.selectedItems = [this.items.at(-1)];
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
    assert.equal(picker.buttons.length, 0);
  });
  assert.deepEqual((await pickPullRequests(allPicker.vscode, pulls)).map(pr => pr.number), [10, 12, 9]);
  assert.equal(allPicker.disposed, true);

  const onePicker = pickerHarness('one');
  const oneResult = await pickPullRequests(onePicker.vscode, pulls);
  assert.deepEqual(oneResult.map(pr => pr.number), [12]);
  assert.equal(onePicker.disposed, true);

  const emptyPicker = pickerHarness('empty');
  assert.deepEqual(await pickPullRequests(emptyPicker.vscode, pulls), []);
  const cancelPicker = pickerHarness('cancel');
  assert.equal(await pickPullRequests(cancelPicker.vscode, pulls), undefined);
  assert.equal(cancelPicker.disposed, true);

  const prompt = batchMergePrompt({
    repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [newestPull],
    base: 'main'
  });
  assert.match(prompt, /Squash and merge the following selected pull request into each PR's explicitly listed base branch/);
  assert.match(prompt, /base: "main"/);
  const mixedPrompt = batchMergePrompt({ repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [newestPull, nonMainPull] });
  assert.match(mixedPrompt, /#9: Wrong base/);
  assert.match(mixedPrompt, /base: "develop"/);
  assert.match(mixedPrompt, /ONLY into their originally listed base branch/);
  assert.match(mixedPrompt, /requires fresh confirmation/);
  assert.match(prompt, /#12: Newest ready change/);
  assert(!prompt.includes('#10: Ready change'));
  assert.match(prompt, /Never merge, close, edit, or implicitly include an unselected PR/);
  assert.match(prompt, /Never force-push or rewrite any branch/);
  assert.match(prompt, /fast-forward-only push/);
  assert.match(prompt, /verify the resulting tree differs from its parent/);
  assert.equal(squashCommitTitle({ number: 269, title: '🐛 Repair retries' }),
    '🐛 Repair retries (#269)');
  assert.equal(squashCommitTitle({ number: 269, title: '🐛 Repair retries (#269)' }),
    '🐛 Repair retries (#269)', 'Do not repeat an existing PR-number suffix');
  assert.equal(squashCommitTitle({ number: 269, title: '🐛 Repair retries (#42)' }),
    '🐛 Repair retries (#42) (#269)', 'Retain the exact PR title even when it references another PR');
  assert.equal(squashCommitTitle({ number: 393, title: '🖌️ Show final commit titles beside generation times' }),
    '🖌️ Show final commit titles beside generation times (#393)');
  assert.throws(() => squashCommitTitle({ number: 0, title: 'Invalid' }), /valid pull-request number/);
  assert.throws(() => squashCommitTitle({ number: 269, title: '' }), /pull-request title/);
  assert.match(prompt, /squash title: "Newest ready change \(#12\)"/);
  assert.match(prompt, /read ALL original PR commits \(paginate the commits endpoint\)/);
  assert.match(prompt, /linked GitHub author\/committer accounts/);
  assert.match(prompt, /SYNC COMMIT FILTER ENABLED \(default\)/);
  assert.match(prompt, /preserve every verified Git author, committer and Co-authored-by trailer/);
  const syncIncludedPrompt=batchMergePrompt({ repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [newestPull], filterSyncCommitSummaries: false });
  assert.match(syncIncludedPrompt, /SYNC COMMIT FILTER DISABLED/);
  assert.match(syncIncludedPrompt, /explanatory bodies in the squash summary/);
  assert(!syncIncludedPrompt.includes('SYNC COMMIT FILTER ENABLED'));
  assert.match(prompt, /EMOJI-ONLY SUBJECT LINES DISABLED \(default\)/);
  const emojiPrompt = batchMergePrompt({ repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: [newestPull], omitBulletsForEmojiTitles: true });
  assert.match(emojiPrompt, /EMOJI-ONLY SUBJECT LINES ENABLED/);
  assert.match(emojiPrompt, /if EVERY remaining commit subject begins with an emoji/);
  assert.match(emojiPrompt, /If any retained subject lacks an emoji, keep the normal hyphen bullets/);
  assert.match(prompt, /bot-opened PR/);
  assert.match(prompt, /Deduplicate repeated credits for the same person\/agent/);
  assert.match(prompt, /correctly ordered Co-authored-by: Name <email> trailers/);
  assert.match(prompt, /compact chronological '- ' bullet list/);
  assert.match(prompt, /exact selected PR title VERBATIM/);
  assert.match(prompt, /never an individual commit title/);
  assert.match(prompt, /hyphen bullets, not '\*'/);
  assert.match(prompt, /four-space-indented continuation lines wrapped at 88 columns directly under its corresponding bullet/);
  assert.match(prompt, /relocate all such credits into ONE final trailer block/);
  assert.match(prompt, /separator of EXACTLY TEN underscores __________/);
  assert.match(prompt, /only one final trailer block after exactly ten underscores __________/);
  assert.doesNotMatch(prompt, /separator ---------/);
  assert.match(prompt, /Co-authored-by: Codex Web <noreply@openai.com>/);
  assert.match(prompt, /CO-AUTHOR ORDER \(HIGH TO LOW\)/);
  assert.match(prompt, /HUMAN AUTHOR PRE-MERGE GATE \(NON-OPTIONAL\)/);
  assert.match(prompt, /If no original linked human can be verified, STOP/);
  assert.match(prompt, /NEVER invoke the GitHub connector native squash operation/);
  assert.match(prompt, /HUMAN GIT AUTHOR, INCLUDING BOT-OPENED PRs/);
  assert.doesNotMatch(prompt, /git commit --author/);
  assert.match(prompt, /NO FORCE PUSHES OR HISTORY REWRITES ARE AUTHORIZED/);
  assert(prompt.includes('node efs/human_squash_merge.js'));
  assert.match(prompt, /NEVER push a squash commit directly to main/);
  assert.match(prompt, /This uses no git push and does not rewrite the PR branch/);
  assert(prompt.includes('NEVER use that route when the PR opener is codex-pony[bot]'));
  assert.match(prompt, /Git author is the verified original HUMAN/);
  const priorities = [
    '1. Main/original human Git authors first',
    '2. Other human contributors',
    '3. regular Codex',
    '4. Codex Web',
    '5. codex-pony[bot]',
    '6. GitHub Copilot',
    '7. Ollama',
    '8. other bots',
    '9. other AI collaborators'
  ];
  let position = -1;
  for (const tier of priorities) {
    const next = prompt.indexOf(tier);
    assert(next > position, 'Co-author tier must appear exactly after its predecessor: ' + tier);
    position = next;
  }
  assert.match(prompt, /Main\/original human Git authors first/);
  assert.match(prompt, /not.*automatically at the bottom/i);
  assert.match(prompt, /regular Codex and Codex Web as separate entries/);
  assert.match(prompt, /both use noreply@openai.com/);
  assert.match(prompt, /Co-authored-by: Codex <noreply@openai.com>/);
  assert.match(prompt, /Co-authored-by: Codex Web <noreply@openai.com>/);
  assert.match(prompt, /Co-authored-by: codex-pony\[bot\] <326443430\+codex-pony\[bot\]@users.noreply.github.com>/);
  assert.match(prompt, /Co-authored-by: Copilot <175728472\+Copilot@users.noreply.github.com>/);
  assert.match(prompt, /other Copilot agent identities exist/);
  assert.match(prompt, /For evidenced Ollama contributions, preserve only the exact verified co-author name and email/);
  assert.match(prompt, /omit unverified legacy Ollama trailers/);
  assert.doesNotMatch(prompt, /hello@ollama\.com/i);
  assert.match(prompt, /Do not add these optional entries/);
  assert.match(prompt, /original human author appears before bots and AI/);
  assert.match(prompt, /cover the verified original human authors and other evidenced contributors in the requested priority order/);
  assert.match(prompt, /Codex Web trailer in the Codex Web position/);
  assert.match(prompt, /custom commit message bypasses GitHub's default automatic co-author text/);
  assert.match(prompt, /commit_title and commit_message/);
  assert.match(prompt, /AFTER EACH COMPLETED MERGE/);
  assert.match(prompt, /first line exactly matches/);
  assert.match(prompt, /Resolve straightforward mechanical conflicts on the selected PR branch/);
  assert.match(prompt, /Re-read the updated head SHA/);
  assert.match(prompt, /leave a focused inline GitHub PR review comment on the actual conflicting code/);
  assert.match(prompt, /asking the specific question a maintainer must answer/);
  assert.match(prompt, /Check existing review threads and update the matching comment to avoid duplicate feedback/);
  assert.match(prompt, /exact current head commit_id, file path, line and side/);
  assert.match(prompt, /Do not substitute a top-level PR Conversation comment/);
  assert.match(prompt, /continue with unrelated safe selected PRs/);

  // Complete stacks reach main with separate squash commits; partial stacks
  // and ambiguous fork/branched/cyclic dependencies must not be assumed.
  const branchPr = (number, head, base, headRepo = 'owner/repo') => ({
    number, title: 'Layer ' + number, url: 'https://github.com/owner/repo/pull/' + number,
    head, base, headRepo, baseRepo: 'owner/repo', stack: { number: 7 }
  });
  const stackPulls = [
    branchPr(43, 'top', 'middle'), branchPr(41, 'bottom', 'main'),
    branchPr(42, 'middle', 'bottom')
  ];
  const stackPlan = planStackMerges(stackPulls, 'owner/repo');
  assert.deepEqual(planStackMerges([
    branchPr(428, 'newest', 'main'), branchPr(407, 'oldest', 'main'), branchPr(412, 'middle', 'main')
  ], 'owner/repo').ordered.map(pr => pr.number), [407, 412, 428], 'Independent PRs run oldest first');
  assert.deepEqual(planStackMerges([
    branchPr(42, 'child', 'parent'), branchPr(45, 'parent', 'main')
  ], 'owner/repo').ordered.map(pr => pr.number), [45, 42], 'Dependencies precede even an older-numbered child');
  assert.deepEqual(stackPlan.ordered.map(pr => pr.number), [41, 42, 43]);
  assert.deepEqual(stackPlan.stacked.map(pr => pr.stackParent), [41, 42]);
  assert.equal(stackPlan.nonMain.length, 0);
  const stackPicker = pickerHarness('all', picker => {
    assert.match(picker.items[1].label, /^↳ #42/);
    assert.match(picker.items[2].label, /^↳ ↳ #43/);
  });
  assert.deepEqual((await pickPullRequests(stackPicker.vscode, stackPulls)).map(pr => pr.number), [41, 42, 43]);
  const stackPrompt = batchMergePrompt({ repositoryUrl: 'https://github.com/owner/repo',
    pullRequests: stackPulls });
  assert(stackPrompt.indexOf('#41:') < stackPrompt.indexOf('#42:'));
  assert(stackPrompt.indexOf('#42:') < stackPrompt.indexOf('#43:'));
  assert.match(stackPrompt, /ONE separate squash commit per PR/);
  assert.match(stackPrompt, /gh stack merge <highest-selected-PR-number> --yes --squash/);
  assert.match(stackPrompt, /asynchronous stack-merge REST API/);
  assert.match(stackPrompt, /Do NOT use gh pr merge/);
  assert.match(stackPrompt, /ONLY selected PRs/);
  assert.match(stackPrompt, /STOP the affected stack/);
  assert.match(stackPrompt, /complete ordered human\/bot\/AI co-author trailers/);
  assert.match(stackPrompt, /squash title: "Layer 41 \(#41\)"/);
  assert.match(stackPrompt, /squash title: "Layer 42 \(#42\)"/);
  assert.match(stackPrompt, /squash title: "Layer 43 \(#43\)"/);
  assert.deepEqual(planStackMerges([stackPulls[0], stackPulls[1]], 'owner/repo')
    .nonMain.map(pr => pr.number), [43]);
  assert.deepEqual(planStackMerges([
    branchPr(41, 'bottom', 'main', 'fork/repo'),
    branchPr(42, 'middle', 'bottom')
  ], 'owner/repo').nonMain.map(pr => pr.number), [42]);
  assert.deepEqual(planStackMerges([
    branchPr(41, 'bottom', 'main'), branchPr(42, 'middle', 'bottom'),
    branchPr(43, 'other', 'bottom')
  ], 'owner/repo').nonMain.map(pr => pr.number), [42, 43]);
  assert.equal(planStackMerges([branchPr(44, 'x', 'y'), branchPr(45, 'y', 'x')],
    'owner/repo').nonMain.length, 2);

  let handler;
  const browserCalls = [];
  const errors = [];
  const infos = [];
  const warnings = [];
  const localRepository = {
    rootUri: { scheme: 'file', fsPath: '/workspace/repo' },
    state: { remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }] }
  };
  let mergeAllHandler;
  let configuredProject = '';
  let filterSyncSummaries = true;
  let emojiOnlySummaries = false;
  let pickerAction = 'first';
  let includeNonMain = false;
  let includeStack = false;
  let approveNonMain = false;
  const modalWarnings = [];
  const vscode = {
    ThemeIcon: class { constructor(id) { this.id = id; } },
    workspace: { getConfiguration(section) {
      assert.equal(section, 'scmToolkit');
      return { get(key, fallback) {
        assert(['chatgptProjectUrl', 'filterSyncCommitSummaries', 'squashOmitBulletsForEmojiTitles', 'mergePostSummaries', 'mergePostStatusUpdates'].includes(key),
          'Unexpected SCM configuration key: ' + key);
        if (key === 'chatgptProjectUrl') return configuredProject || fallback;
        if (key === 'filterSyncCommitSummaries') return filterSyncSummaries;
        if (['mergePostSummaries', 'mergePostStatusUpdates'].includes(key)) return fallback;
        return emojiOnlySummaries;
      } };
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
        if (options.silent) return undefined;
        assert.deepEqual(scopes, ['repo']);
        assert.equal(options.createIfNone, true);
        return { accessToken: 'linked-token' };
      }
    },
    commands: {
      registerCommand(id, callback) {
        if (id === 'sweetiebot.mergeAllPullRequests') mergeAllHandler = callback;
        else {
          assert.equal(id, 'sweetiebot.openPullRequestBatchChat');
          handler = callback;
        }
        return { dispose() {} };
      },
      async getCommands() { return ['workbench.action.browser.open', 'workbench.action.moveEditorToNewWindow']; },
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
  // Even with a locally installed Lindsey checkout, both toolbar actions
  // must open ChatGPT so conflicts can be resolved or escalated to humans.
  vscode.workspace.workspaceFolders = [{ uri: {
    fsPath: path.resolve(__dirname, '../../lindsey-sync')
  } }];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      if (includeStack) return stackPulls.map(pr => ({
        number: pr.number, title: pr.title, html_url: pr.url, draft: false,
        head: { ref: pr.head, sha: 'a'.repeat(40), repo: { full_name: pr.headRepo } },
        base: { ref: pr.base }, stack: pr.stack
      }));
      return [
        {
          number: 41, title: 'Selected PR', html_url: 'https://github.com/owner/repo/pull/41',
          draft: false, base: { ref: includeNonMain ? 'kefania' : 'main' }, head: { ref: 'selected', sha: 'a'.repeat(40) }
        },
        {
          number: 40, title: 'Unselected PR', html_url: 'https://github.com/owner/repo/pull/40',
          draft: false, base: { ref: 'main' }, head: { ref: 'unselected', sha: 'b'.repeat(40) }
        }
      ];
    }
  });
  // Browser preload owns submission; there is no OS keystroke timer.
  registerPullRequestBatchCommand(vscode, { subscriptions: [] }, fetchImpl, {
    async launchMergeSession(host, context, root, url, selection) {
      assert.equal(host, vscode);
      assert.equal(root, localRepository.rootUri);
      assert.equal(selection.repository, 'owner/repo');
      assert(selection.pullRequests.length >= 1);
      assert(selection.pullRequests.every(pr => pr.headSha.length === 40));
      browserCalls.push({ id: 'vscode.openFolder', options: { url } });
    }
  });
  await handler();
  assert.equal(errors.length, 0);
  assert.equal(infos.length, 0);
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0].id, 'vscode.openFolder');
  const chat = new URL(browserCalls[0].options.url);
  assert.equal(chat.origin, 'https://chatgpt.com');
  const mergePromptFromUrl = url => {
    assert.equal(url.search, '', 'The handoff uses a fragment payload');
    const fragment = new URLSearchParams(url.hash.slice(1));
    assert.equal(fragment.get('sweetiebot_merge'), '1');
    return fragment.get('q');
  };
  const sentPrompt = mergePromptFromUrl(chat);
  assert.match(sentPrompt, /pull\/40/);
  assert.match(sentPrompt, /squash title: "Unselected PR \(#40\)"/);
  assert.match(sentPrompt, /CO-AUTHOR ORDER \(HIGH TO LOW\)/);
  assert.match(sentPrompt, /CONFLICT RESOLUTION/);
  assert.match(sentPrompt, /preserve only the exact verified co-author name and email/);
  assert.doesNotMatch(sentPrompt, /hello@ollama\.com/i);
  assert(!sentPrompt.includes('pull/41'));
  assert.match(sentPrompt, /SYNC COMMIT FILTER ENABLED \(default\)/);
  assert.match(sentPrompt, /EMOJI-ONLY SUBJECT LINES DISABLED \(default\)/);
  filterSyncSummaries = false;
  emojiOnlySummaries = true;
  await handler();
  const alteredChat = new URL(browserCalls.filter(call => call.id === 'vscode.openFolder').at(-1).options.url);
  const alteredPrompt = mergePromptFromUrl(alteredChat);
  assert.match(alteredPrompt, /SYNC COMMIT FILTER DISABLED/);
  assert.match(alteredPrompt, /EMOJI-ONLY SUBJECT LINES ENABLED/);
  filterSyncSummaries = true;
  emojiOnlySummaries = false;
  assert.equal(browserCalls[0].options.openToSide, undefined);

  pickerAction = 'cancel';
  await mergeAllHandler();
  const allChat = new URL(browserCalls.filter(call => call.id === 'vscode.openFolder').at(-1).options.url);
  assert.match(mergePromptFromUrl(allChat), /pull\/41/);
  assert.match(mergePromptFromUrl(allChat), /pull\/40/);
  assert(mergePromptFromUrl(allChat).indexOf('#40:') < mergePromptFromUrl(allChat).indexOf('#41:'),
    'Merge All submits the oldest PR first');
  assert.match(mergePromptFromUrl(allChat), /oldest selected PRs first/);
  assert(browserCalls.every(call => call.id === 'vscode.openFolder'),
    'Merge All launches an independent workspace');
  includeNonMain = true;
  // The planner lists main-targeted PRs before unrelated non-main PRs.
  pickerAction = 'top';
  await handler();
  assert.equal(browserCalls.length, 3, 'Dismissing the non-main confirmation must not open ChatGPT');
  assert.equal(modalWarnings.length, 1);
  assert.match(modalWarnings[0].message, /kefania.*not main/);
  assert.equal(modalWarnings[0].options.modal, true);
  approveNonMain = true;
  await handler();
  const alternateChat = new URL(browserCalls.filter(call => call.id === 'vscode.openFolder').at(-1).options.url);
  assert.match(mergePromptFromUrl(alternateChat), /base: "kefania"/);
  includeNonMain = false;
  approveNonMain = false;
  pickerAction = 'cancel';
  await handler();
  assert.equal(browserCalls.length, 4, 'Cancelling must not submit a merge request');
  pickerAction = 'first';

  configuredProject = 'https://chatgpt.com/g/g-p-example/project';
  await handler();
  const scopedChat = new URL(browserCalls.filter(call => call.id === 'vscode.openFolder').at(-1).options.url);
  assert.equal(scopedChat.pathname, '/g/g-p-example/project');
  assert.match(mergePromptFromUrl(scopedChat), /pull\/40/);
  configuredProject = '';

  const modalCountBeforeStack = modalWarnings.length;
  includeStack = true;
  pickerAction = 'all';
  await handler();
  assert.equal(modalWarnings.length, modalCountBeforeStack,
    'Complete selected stacks must not trigger the non-main warning');
  const stackChat = new URL(browserCalls.filter(call =>
    call.id === 'vscode.openFolder').at(-1).options.url);
  assert.match(mergePromptFromUrl(stackChat), /gh stack merge/);
  assert(mergePromptFromUrl(stackChat).indexOf('#41:') <
    mergePromptFromUrl(stackChat).indexOf('#43:'));
  // The bottom member of a native stack also needs asynchronous stack merge.
  pickerAction = 'first';
  await handler();
  const bottomChat = new URL(browserCalls.filter(call =>
    call.id === 'vscode.openFolder').at(-1).options.url);
  assert.match(mergePromptFromUrl(bottomChat), /gh stack merge/);
  const existingBrowserCalls = browserCalls.length;
  pickerAction = 'top';
  await handler();
  assert.equal(browserCalls.length, existingBrowserCalls,
    'A partial native stack must not launch a merge chat');
  assert.match(modalWarnings.at(-1).message, /missing lower PRs/);
  includeStack = false;
  pickerAction = 'first';

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
