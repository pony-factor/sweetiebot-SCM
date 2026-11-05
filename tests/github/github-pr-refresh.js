'use strict';

const assert = require('node:assert/strict');
const { installPullRequestRefresh, pullRequestFromTreeNode, pullRequestsInFolder, checkFolderMergeEligibility } = require('../../extension/github/pr-refresh');

async function testBulkEligibility() {
  const request = { number: 12, url: "https://github.com/owner/repo/pull/12" };
  const head = "a".repeat(40);
  const pr = { state: "open", draft: false, mergeable: true, mergeable_state: "clean",
    html_url: request.url, head: { sha: head, ref: "topic" }, base: { ref: "main" }, title: "Feature" };
  const checkRun = { id: 1, name: "Unit tests", status: "completed", conclusion: "success" };
  let currentPr = pr, run = checkRun, responseStatus = 200;
  const visited = [];
  const fetchImpl = async (url, options) => {
    visited.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-token");
    if (responseStatus !== 200) return { ok: false, status: responseStatus };
    const json = url.includes("/pulls/12") ? currentPr
      : url.includes("/check-runs") ? { check_runs: [run] }
      : url.includes("/check-suites") ? { check_suites: [] }
      : url.includes("/status") ? { statuses: [] } : undefined;
    assert(json, "No unexpected GitHub endpoint: " + url);
    return { ok: true, json: async () => json };
  };
  const check = () => checkFolderMergeEligibility(request, "test-token", fetchImpl);
  assert.deepEqual(await check(), { eligible: true, headSha: head,
    head: "topic", base: "main", title: "Feature" });
  assert(visited.some(url => url.includes("/check-runs")));
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    run = { ...checkRun, conclusion };
    assert.match((await check()).reason, /Checks not passing: Unit tests/);
  }
  run = { ...checkRun, status: "in_progress", conclusion: null };
  assert.match((await check()).reason, /Checks pending/);
  run = checkRun;
  for (const state of ["dirty", "blocked", "behind", "unstable", "unknown"]) {
    currentPr = { ...pr, mergeable_state: state };
    assert.equal((await check()).eligible, false, "Reject mergeability state " + state);
  }
  currentPr = { ...pr, mergeable: null };
  assert.equal((await check()).eligible, false, "Unknown mergeability is not approval");
  currentPr = { ...pr, draft: true };
  assert.equal((await check()).eligible, false);
  currentPr = { ...pr, state: "closed" };
  assert.equal((await check()).eligible, false);
  currentPr = { ...pr, stack: { id: "native-stack" } };
  assert.match((await check()).reason, /stack-aware/);
  currentPr = pr;
  responseStatus = 403;
  assert.match((await check()).reason, /Unable to verify eligibility/);
  assert.equal((await checkFolderMergeEligibility(request, "", fetchImpl)).eligible, false);
  assert.equal((await checkFolderMergeEligibility({ ...request, number: 99 }, "test-token", fetchImpl)).eligible, false);
}

async function main() {
  await testBulkEligibility();
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  const timers = new Map();
  let sequence = 0;
  global.setInterval = (fn, delay) => { assert.equal(delay, 120000); timers.set(++sequence, fn); return sequence; };
  global.clearInterval = id => timers.delete(id);
  try {
    let visibility, focus, configChanged, enabled = true, calls = 0, resolve, mergeSelected;
    const merges = [];
    const commands = new Map();
    const subscriptions = [];
    const view = { visible: false, onDidChangeVisibility: fn => { visibility = fn; return { dispose() {} }; } };
    const vscode = {
      window: { state: { focused: true }, onDidChangeWindowState: fn => { focus = fn; return { dispose() {} }; } },
      workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'pullRequestAutoRefresh' ? enabled : fallback }),
        onDidChangeConfiguration: fn => { configChanged = fn; return { dispose() {} }; } },
      commands: { registerCommand: (id, handler) => {
        assert(!commands.has(id), `Command ${id} already exists`);
        commands.set(id, handler);
        if (id === 'sweetiebot.resolveSelectedPullRequest') {
          mergeSelected = async node => merges.push(await handler(node));
        }
        return { dispose() { commands.delete(id); } };
      }, executeCommand: (id, arg) => {
        if (commands.has(id)) return commands.get(id)(arg);
        if (id === 'sweetiebot.squashMergePullRequest') { merges.push(arg); return Promise.resolve(); }
        if (id === 'sweetiebot.githubRateLimited') return Promise.resolve();
        assert.equal(id, 'pr.refreshList'); calls++;
        return new Promise(done => { resolve = done; });
      } }
    };
    assert.equal(installPullRequestRefresh(vscode, view, { _register: item => subscriptions.push(item) }), view);
    const url = 'https://github.com/owner/repo/pull/12';
    assert.deepEqual(pullRequestFromTreeNode(url), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode([{ url }]), { url, number: 12 });
    assert.equal(pullRequestFromTreeNode([{ url }, { url }]).url, undefined);
    assert.deepEqual(pullRequestFromTreeNode({ scheme: 'prnode',
      query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:12' }) }),
    { url, number: 12 });
    await mergeSelected({ url, number: 12 });
    assert(!commands.has('sweetiebot.squashMergeSelectedPullRequest'));
    assert(!commands.has('sweetiebot.squashMergeSelectedPullRequest'));
    await mergeSelected({ pullRequestModel: { html_url: url, number: 12 } });
    await mergeSelected({ url, number: 12 });
    await mergeSelected({
      resourceUri: { query: JSON.stringify({ prIdentifier: 'https://github.com/owner/repo:12' }) }
    });
    assert.deepEqual(merges, [
      { url, number: 12 },
      { url, number: 12 },
      { url, number: 12 },
      { url, number: 12 }
    ]);
    for (const remote of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
      assert.deepEqual(pullRequestFromTreeNode({ resourceUri: { query: JSON.stringify({ prIdentifier: `${remote}:12` }) } }), { url, number: 12 });
      assert.deepEqual(pullRequestFromTreeNode({ pullRequestModel: { remote: { url: remote }, number: 12 } }), { url, number: 12 });
    }
    // GitHub PR tree commands can receive a rendered TreeItem rather than a
    // fully hydrated PRNode. Its command arguments and stable ID retain identity.
    const renderedWithCommand = {
      id: 'category-https://github.com/owner/repo/pull/12',
      command: { arguments: [{ pullRequestModel: { html_url: url, number: 12 } }] }
    };
    assert.deepEqual(pullRequestFromTreeNode(renderedWithCommand), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode({ id: 'category-' + url }), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode({ id: 'category-' + url, number: 99 }),
      { url: undefined, number: 99 }, 'Never substitute a PR when the clicked row number disagrees');
    assert.deepEqual(pullRequestFromTreeNode({ command: { arguments: [
      { remote: { url: 'git@github.com:owner/repo.git' }, number: 12 }
    ] } }), { url, number: 12 });
    assert.deepEqual(pullRequestFromTreeNode({ pullRequestModel: {
      githubRepository: { remote: { url: 'https://github.com/owner/repo.git' } }, number: 12
    } }), { url, number: 12 });
    assert.equal(pullRequestFromTreeNode({ command: { arguments: [] }, id: 'unrelated-tree-item' }).url, undefined);
    assert.equal(pullRequestFromTreeNode({ id: 'prefixhttps://github.com/owner/repo/pull/12https://github.com/owner/repo/pull/13' }).url, undefined,
      'Never guess between multiple PR identities');
    assert.equal(pullRequestFromTreeNode({ resourceUri: { query: '{invalid' } }).url, undefined);
    assert.equal(pullRequestFromTreeNode({ remote: { url: 'git@other.example:owner/repo.git' }, number: 12 }).url, undefined);
    assert.deepEqual(pullRequestFromTreeNode({ html_url: '', url, number: 99 }), { url, number: 12 },
      'Ignore unusable URL aliases and derive the number from the actual PR URL');
    for (const subscription of subscriptions) subscription.dispose();
    const renderedNode = {};
    const renderedOwner = {
      _register: item => subscriptions.push(item),
      getTreeItem: async node => {
        assert.equal(node, renderedNode, 'Resolve the clicked node, not a different selection');
        return { resourceUri: { query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:13' }) } };
      }
    };
    installPullRequestRefresh(vscode, { ...view, selection: [{ url, number: 12 }] }, renderedOwner);
    await mergeSelected(renderedNode);
    assert.deepEqual(merges.at(-1), { url: 'https://github.com/owner/repo/pull/13', number: 13 });
    // Dispose this additional view before checking the original refresh lifecycle.
    for (const subscription of subscriptions) subscription.dispose();
    installPullRequestRefresh(vscode, view, { _register: item => subscriptions.push(item) });
    view.selection = [{ pullRequestModel: { html_url: url, number: 12 } }];
    await mergeSelected();
    assert.deepEqual(merges.at(-1), { url, number: 12 });
    view.selection = [{ url }, { url: 'https://github.com/owner/repo/pull/13' }];
    await mergeSelected();
    assert.equal(merges.at(-1).url, undefined, 'Never guess among multiple selected PRs');

    // A click immediately changes only that PR's row, even before the remote
    // operation finishes. Duplicate clicks do not dispatch a second merge.
    const rowCommands = new Map(), rowRefreshes = [], rowSubscriptions = [];
    const rowProgress = [], rowProgressUpdates = [];
    let completeMerge;
    const dispatched = [];
    const rowOwner = {
      _register: item => rowSubscriptions.push(item),
      async getTreeItem() { return { description: 'by @pony', contextValue: 'pullrequest:hasHeadRef', iconPath: 'native-icon' }; },
      refresh: node => rowRefreshes.push(node)
    };
    const rowVscode = {
      ...vscode,
      // Keep this isolated test view from replacing the main view's listeners.
      ProgressLocation: { Notification: 15 },
      window: {
        ...vscode.window,
        onDidChangeWindowState: () => ({ dispose() {} }),
        withProgress: (options, work) => {
          rowProgress.push(options);
          return work({ report: update => rowProgressUpdates.push(update) });
        }
      },
      workspace: { ...vscode.workspace, onDidChangeConfiguration: () => ({ dispose() {} }) },
      commands: {
        registerCommand(id, fn) {
          rowCommands.set(id, fn);
          return { dispose() { rowCommands.delete(id); } };
        },
        executeCommand(id, arg, options) {
          if (id === 'sweetiebot.squashMergePullRequest') {
            assert.deepEqual(options, { progressManaged: true }, 'The inline button owns its one notification');
            dispatched.push(arg);
            return new Promise(resolve => { completeMerge = resolve; });
          }
          if (id === 'pr.refreshList') return Promise.resolve();
          throw new Error('Unexpected command ' + id);
        }
      }
    };
    installPullRequestRefresh(rowVscode, {
      visible: false, onDidChangeVisibility: () => ({ dispose() {} })
    }, rowOwner);
    const clicked = { pullRequestModel: { url, number: 12 } };
    const another = { pullRequestModel: { url: 'https://github.com/owner/repo/pull/13', number: 13 } };
    const clickMerge = rowCommands.get('sweetiebot.squashMergeTreePullRequest');
    const first = clickMerge(clicked);
    assert.equal(rowProgress.length, 1, 'Show progress synchronously, before PR row hydration');
    assert.equal(rowProgress[0].location, 15);
    assert.equal(rowProgress[0].title, 'Squash merge PR #12');
    assert.equal(rowProgress[0].cancellable, false);
    await new Promise(setImmediate);
    const during = await rowOwner.getTreeItem(clicked);
    assert.match(during.description, /by @pony · ⏳ Squash-merging/);
    assert.match(during.contextValue, /sweetiebotMergeBusy/);
    assert.equal(during.iconPath, 'native-icon');
    assert.equal((await rowOwner.getTreeItem(another)).description, 'by @pony');
    assert.equal(rowRefreshes.at(-1), clicked);
    await clickMerge(clicked);
    assert.equal(rowProgress.length, 1, 'Duplicate clicks must not create duplicate notifications');
    assert.deepEqual(rowProgressUpdates, [{ message: 'Checking merge eligibility…' }]);
    assert.deepEqual(dispatched, [url], 'The second click must not dispatch another merge');
    completeMerge({ state: 'merged' });
    assert.deepEqual(await first, { state: 'merged' });
    assert.match((await rowOwner.getTreeItem(clicked)).description, /✅ Merged/);
    const second = clickMerge(clicked);
    await new Promise(setImmediate);
    completeMerge({ state: 'queued' });
    assert.deepEqual(await second, { state: 'queued' });
    assert.match((await rowOwner.getTreeItem(clicked)).description, /Merge queued/);
    assert.doesNotMatch((await rowOwner.getTreeItem(clicked)).description, /✅ Merged/);
    const retryPending = clickMerge(clicked);
    await new Promise(setImmediate);
    completeMerge({ state: 'pending' });
    assert.deepEqual(await retryPending, { state: 'pending' });
    assert.match((await rowOwner.getTreeItem(clicked)).description, /GitHub is processing the merge/);
    for (const state of ['cancelled', 'failed']) {
      const action = clickMerge(clicked);
      await new Promise(setImmediate);
      completeMerge({ state });
      assert.deepEqual(await action, { state });
      assert.equal((await rowOwner.getTreeItem(clicked)).description, 'by @pony');
    }
    assert.equal(dispatched.length, 5);

    // A folder action must discover nested PR rows, deduplicate them, and
    // attempt each merge only after the preceding merge has completed.
    const folder = { id: 'open-pr-folder' };
    const nestedFolder = { id: 'nested-pr-folder' };
    const firstPr = { url, number: 12, pullRequestModel: { title: 'First PR title' } };
    const secondPr = { url: 'https://github.com/owner/repo/pull/13', number: 13, label: 'Second PR title' };
    const thirdPr = { url: 'https://github.com/owner/repo/pull/14', number: 14 };
    const folderSubscriptions = [], folderCommands = new Map();
    const folderCalls = [], folderResolvers = [], folderProgress = [], folderWarnings = [], folderErrors = [];
    const folderConfirmations = [], confirmationResolvers = [];
    let filterBlocked = true;
    const eligibilityCalls = new Map();
    const checkBulkEligibility = async request => {
      const count = (eligibilityCalls.get(request.number) || 0) + 1;
      eligibilityCalls.set(request.number, count);
      if (filterBlocked && request.number === 13) {
        return { eligible: false, reason: "Checks not passing: Unit tests" };
      }
      if (filterBlocked && request.number === 14 && count > 1) {
        return { eligible: false, reason: "Merge conflicts" };
      }
      return { eligible: true, headSha: "a".repeat(40),
        head: "topic-" + request.number, base: "main",
        title: "PR " + request.number };
    };
    const folderOwner = {
      _register: item => folderSubscriptions.push(item),
      async getChildren(node) {
        if (node === folder) return [firstPr, nestedFolder, thirdPr];
        if (node === nestedFolder) return [secondPr, firstPr];
        return [];
      },
      async getTreeItem(node) {
        return { contextValue: node === folder ? 'pullrequest-folder' : 'pullrequest',
          label: node === thirdPr ? 'Third PR title' : undefined };
      },
      refresh() {}
    };
    const folderVscode = {
      ...rowVscode,
      window: {
        ...rowVscode.window,
        withProgress: (options, task) => {
          folderProgress.push(options);
          return task({ report: update => folderProgress.push(update) });
        },
        showWarningMessage(message, options, action) {
          if (options?.modal) {
            folderConfirmations.push({ message, options, action });
            if (action === undefined) return Promise.resolve(undefined);
            return new Promise(resolve => confirmationResolvers.push(resolve));
          }
          folderWarnings.push(message);
        },
        showErrorMessage: message => folderErrors.push(message),
        showInformationMessage: () => {}
      },
      authentication: { getSession: async () => ({ accessToken: "test-token", scopes: ["repo"] }) },
      commands: {
        registerCommand(id, fn) {
          folderCommands.set(id, fn);
          return { dispose() { folderCommands.delete(id); } };
        },
        executeCommand(id, arg, options) {
          if (id === 'sweetiebot.squashMergePullRequest') {
            assert.deepEqual(options, { progressManaged: true });
            folderCalls.push(arg);
            return new Promise((resolve, reject) => folderResolvers.push({ resolve, reject }));
          }
          if (id === 'pr.refreshList') return Promise.resolve();
          throw new Error('Unexpected folder command: ' + id);
        }
      }
    };
    installPullRequestRefresh(folderVscode, {
      visible: false, onDidChangeVisibility: () => ({ dispose() {} })
    }, folderOwner, { checkBulkEligibility });
    const folderMerge = folderCommands.get('sweetiebot.squashMergeTreePullRequest');
    assert.deepEqual((await pullRequestsInFolder(folderOwner, folder)).map(pr => pr.url),
      [url, secondPr.url, thirdPr.url]);
    const mergingFolder = folderMerge(folder);
    await new Promise(setImmediate);
    assert.deepEqual(folderCalls, [], "No PR is merged during eligibility checks");
    assert.equal(folderConfirmations.length, 1);
    assert.equal(folderConfirmations[0].message, "Squash merge 2 eligible pull requests?");
    assert.equal(folderConfirmations[0].action, "Merge 2 PRs");
    assert.equal(folderConfirmations[0].options.modal, true);
    assert.deepEqual(folderConfirmations[0].options.detail.split("\n"), [
      "#12 — First PR title", "#14 — Third PR title", "",
      "Excluded 1 of 3 PRs:", "#13 — Checks not passing: Unit tests"
    ]);
    await folderMerge(folder);
    assert.equal(folderConfirmations.length, 1, "Duplicate clicks cannot open another confirmation");
    confirmationResolvers.shift()("Merge 2 PRs");
    await new Promise(setImmediate);
    assert.deepEqual(folderCalls, [url], "Only an eligible PR is dispatched");
    folderResolvers[0].resolve({ state: "merged" });
    assert.deepEqual(await mergingFolder,
      { state: "completed", total: 3, excluded: 1, merged: 1, queued: 0,
        pending: 0, cancelled: 0, failed: 0, skipped: 1 });
    assert.deepEqual(folderCalls, [url], "Fresh conflicts prevent even attempting the second PR");
    assert.match(folderWarnings[0], /1 merged, 0 queued, 0 pending, 0 cancelled, 0 failed, 1 skipped/);
    assert.match(folderWarnings[0], /#14: Merge conflicts/);

    // Once all three PRs become eligible, merges remain sequential and one
    // failed merge still allows the next independently eligible PR to run.
    filterBlocked = false;
    const allMerge = folderMerge(folder);
    await new Promise(setImmediate);
    assert.equal(folderConfirmations[1].message, "Squash merge 3 eligible pull requests?");
    confirmationResolvers.shift()("Merge 3 PRs");
    await new Promise(setImmediate);
    assert.deepEqual(folderCalls, [url, url]);
    folderResolvers[1].resolve({ state: "merged" });
    await new Promise(setImmediate);
    assert.deepEqual(folderCalls, [url, url, secondPr.url]);
    folderResolvers[2].reject(new Error("Merge checks failed"));
    await new Promise(setImmediate);
    assert.deepEqual(folderCalls, [url, url, secondPr.url, thirdPr.url]);
    folderResolvers[3].resolve({ state: "pending" });
    assert.deepEqual(await allMerge,
      { state: "completed", total: 3, excluded: 0, merged: 1, queued: 0,
        pending: 1, cancelled: 0, failed: 1, skipped: 0 });
    assert.match(folderErrors[0], /PR #13: Merge checks failed/);

    const cancellingFolder = folderMerge(folder);
    await new Promise(setImmediate);
    assert.equal(folderConfirmations.length, 3);
    confirmationResolvers.shift()(undefined);
    assert.deepEqual(await cancellingFolder, { state: "cancelled", total: 3 });
    assert.equal(folderCalls.length, 4, "Dismissal must not invoke a merge command");
    assert.equal(folderProgress.filter(item => item.title === "Squash merge eligible folder pull requests").length, 2,
      "Cancellation must not show merge execution progress");

    // No eligible candidates: show a blocker, never a merge-confirm button.
    filterBlocked = true;
    eligibilityCalls.clear();
    const blockedChecker = () => ({ eligible: false, reason: "Checks pending" });
    // The checker is injected per installation; use a fresh isolated view.
    const noEligibleCommands = new Map();
    const noEligibleOwner = { ...folderOwner,
      _register: item => folderSubscriptions.push(item) };
    const noEligibleVscode = { ...folderVscode, commands: {
      ...folderVscode.commands,
      registerCommand(id, fn) {
        noEligibleCommands.set(id, fn);
        return { dispose() { noEligibleCommands.delete(id); } };
      }
    } };
    installPullRequestRefresh(noEligibleVscode, {
      visible: false, onDidChangeVisibility: () => ({ dispose() {} })
    }, noEligibleOwner, { checkBulkEligibility: blockedChecker });
    const none = await noEligibleCommands.get("sweetiebot.squashMergeTreePullRequest")(folder);
    assert.deepEqual(none, { state: "blocked", total: 3, excluded: 3 });
    assert.equal(folderConfirmations.at(-1).action, undefined);
    assert.match(folderConfirmations.at(-1).message, /No pull requests are currently eligible/);
    assert.deepEqual(await folderMerge({ id: 'empty' }), { state: 'failed', total: 0 });
    assert.match(folderErrors.at(-1), /No pull requests were found/);
    for (const subscription of folderSubscriptions) subscription.dispose();
    for (const subscription of rowSubscriptions) subscription.dispose();
    const manifest = require('../../extension/package.json');
    assert.equal(manifest.contributes.menus['view/item/context'][0].command,
      'sweetiebot.squashMergeTreePullRequest');
    await Promise.resolve();
    assert.equal(calls, 0);
    assert.equal(timers.size, 0);
    view.visible = true; visibility();
    assert.equal(calls, 1);
    view.visible = false; visibility();
    view.visible = true; visibility();
    assert.equal(calls, 1, 'Reopening does not overlap an in-flight refresh');
    const tick = [...timers.values()][0];
    tick(); assert.equal(calls, 1);
    resolve(); await Promise.resolve();
    view.visible = false; visibility();
    view.visible = true; visibility();
    assert.equal(calls, 2, 'Opening the sidebar immediately refreshes inside 120 seconds');
    resolve(); await Promise.resolve();
    tick(); assert.equal(calls, 2, 'Periodic refresh still respects its interval');
    now += 120000; tick(); assert.equal(calls, 3);
    resolve(); await Promise.resolve();
    vscode.window.state.focused = false; focus();
    assert.equal(timers.size, 0);
    tick(); assert.equal(calls, 3);
    now += 120000;
    vscode.window.state.focused = true; focus();
    assert.equal(calls, 4);
    resolve(); await Promise.resolve();
    enabled = false; configChanged({ affectsConfiguration: () => true });
    assert.equal(timers.size, 0);
    now += 120000;
    enabled = true; configChanged({ affectsConfiguration: () => true });
    assert.equal(calls, 5);
    resolve(); await Promise.resolve();
    view.visible = false; visibility();
    assert.equal(timers.size, 0);
    view.visible = true; visibility();
    assert.equal(calls, 6, 'Opening refreshes before the next scheduled interval');
    subscriptions.at(-1).dispose();
    assert.equal(timers.size, 0);
    resolve(); await Promise.resolve();
    tick(); assert.equal(calls, 6);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    Date.now = originalNow;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
