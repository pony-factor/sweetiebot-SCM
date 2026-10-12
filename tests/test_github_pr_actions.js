'use strict';

const assert = require('node:assert/strict');
const { squashMergePullRequest, deleteMergedRemoteBranch, closeMergedPullRequestTab, registerGitHubPullRequestActions } = require('../efs/github_pr_actions');
const url = 'https://github.com/owner/repo/pull/12';
const open = { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'topic',
  headRefOid: 'a'.repeat(40), isCrossRepository: false };

async function main() {
  const calls = [];
  const execute = async args => {
    calls.push(args);
    return { stdout: JSON.stringify({ ...open, state: calls.length > 1 ? 'MERGED' : 'OPEN' }) };
  };
  const result = await squashMergePullRequest(url, execute);
  assert.equal(result.merged, true);
  assert.deepEqual(calls[1], ['pr', 'merge', '12', '--repo', 'owner/repo', '--squash', '--match-head-commit', open.headRefOid]);
  for (const invalid of [{ isDraft: true }, { baseRefName: '' }, { state: 'CLOSED' }, { headRefOid: '' }]) {
    let count = 0;
    await assert.rejects(squashMergePullRequest(url, async () => {
      count++;
      return { stdout: JSON.stringify({ ...open, ...invalid }) };
    }));
    assert.equal(count, 1);
  }
  const alternate = { ...open, baseRefName: 'kefania' };
  const cancelledCalls = [];
  const cancelled = await squashMergePullRequest(url, async args => {
    cancelledCalls.push(args);
    return { stdout: JSON.stringify(alternate) };
  }, async target => {
    assert.deepEqual(target, { repo: 'owner/repo', number: '12', base: 'kefania' });
    return false;
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.merged, false);
  assert.equal(cancelledCalls.length, 1, 'Cancellation must not call merge');
  const alternateCalls = [];
  let alternateMerged = false;
  const alternateResult = await squashMergePullRequest(url, async args => {
    alternateCalls.push(args);
    if (args[1] === 'merge') { alternateMerged = true; return { stdout: '' }; }
    return { stdout: JSON.stringify({ ...alternate, state: alternateMerged ? 'MERGED' : 'OPEN' }) };
  }, async () => true);
  assert.equal(alternateResult.merged, true);
  assert.equal(alternateResult.base, 'kefania');
  assert.deepEqual(alternateCalls.map(args => args[1]), ['view', 'view', 'merge', 'view']);
  assert.deepEqual(alternateCalls[2], ['pr', 'merge', '12', '--repo', 'owner/repo', '--squash', '--match-head-commit', open.headRefOid]);

  // The modal approval is invalidated if the base, head, or state changes.
  for (const changed of [{ baseRefName: 'main' }, { headRefOid: 'b'.repeat(40) }, { state: 'CLOSED' }]) {
    let reads = 0, merges = 0;
    await assert.rejects(squashMergePullRequest(url, async args => {
      if (args[1] === 'merge') { merges++; return { stdout: '' }; }
      return { stdout: JSON.stringify({ ...alternate, ...(++reads === 2 ? changed : {}) }) };
    }, async () => true), /changed since confirmation/);
    assert.equal(merges, 0, 'Do not merge a retargeted or changed PR');
  }
  let conflicts = 0;
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') conflicts++;
    return { stdout: JSON.stringify({ ...alternate, mergeable: 'CONFLICTING' }) };
  }, async () => true), /conflicts with \`kefania\`/);
  assert.equal(conflicts, 0);
  // A main-targeted merge must not request the alternate-branch approval.
  let confirmedMain = 0;
  await squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') return { stdout: '' };
    return { stdout: JSON.stringify({ ...open, state: confirmedMain++ ? 'MERGED' : 'OPEN' }) };
  }, async () => { throw new Error('Main must not ask for confirmation'); });

  await assert.rejects(squashMergePullRequest('https://other.example/owner/repo/pull/12', execute));
  assert.equal((await squashMergePullRequest(url, async () => ({ stdout: JSON.stringify(open) }))).merged, false);
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') throw new Error('Required checks have not passed');
    return { stdout: JSON.stringify(open) };
  }), /Required checks/);
  let conflictCalls = 0;
  await assert.rejects(squashMergePullRequest(url, async () => {
    conflictCalls++;
    return { stdout: JSON.stringify({ ...open, mergeable: 'CONFLICTING' }) };
  }), /Unable to merge #12: conflicts with `main`/);
  assert.equal(conflictCalls, 1, 'Do not attempt to merge known conflicts');
  let racedReads = 0;
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') throw Object.assign(new Error('gh failed'), { stderr: 'not mergeable' });
    return { stdout: JSON.stringify({ ...open, mergeable: ++racedReads === 1 ? 'UNKNOWN' : 'CONFLICTING' }) };
  }), /Unable to merge #12: conflicts with `main`/);
  const originalFailure = Object.assign(new Error('gh failed'), { stderr: 'Required checks have not passed' });
  let failedReads = 0;
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') throw originalFailure;
    if (++failedReads > 1) throw new Error('Offline');
    return { stdout: JSON.stringify(open) };
  }), error => error === originalFailure);
  const cleanup = [];
  await deleteMergedRemoteBranch(result, async args => {
    cleanup.push(args);
    return { stdout: JSON.stringify(args[0] === 'pr' ? [] : [{ ref: 'refs/heads/topic', object: { sha: open.headRefOid } }]) };
  });
  assert.deepEqual(cleanup.at(-1), ['api', '--method', 'DELETE', 'repos/owner/repo/git/refs/heads/topic']);
  for (const pr of [{ ...open, isCrossRepository: true }, { ...open, headRefName: 'main' }]) {
    await deleteMergedRemoteBranch({ ...result, pr }, () => { throw new Error('Must not delete protected/fork branch'); });
  }
  await deleteMergedRemoteBranch(result, async () => ({ stdout: '[]' }));
  const missingRefs = [404, 422].map(status => Object.assign(new Error('gh failed'), {
    stderr: `gh: Reference does not exist (HTTP ${status})`
  }));
  missingRefs.push(new Error('gh: Reference does not exist (HTTP 422)'));
  const topicRef = { ref: 'refs/heads/topic', object: { sha: open.headRefOid } };
  const prefixedRef = { ref: 'refs/heads/topic-other', object: { sha: open.headRefOid } };
  for (const missingRef of missingRefs) {
    for (const remaining of [[], [prefixedRef]]) {
      let lookups = 0;
      await deleteMergedRemoteBranch(result, async args => {
        if (args.includes('DELETE')) throw missingRef;
        if (args[0] === 'pr') return { stdout: '[]' };
        return { stdout: JSON.stringify(++lookups === 1 ? [topicRef] : remaining) };
      });
      assert.equal(lookups, 2, 'Confirm automatic deletion after a raced DELETE');
    }
  }
  for (const failure of [...missingRefs, Object.assign(new Error('Forbidden'), { stderr: 'gh: Forbidden (HTTP 403)' })]) {
    await assert.rejects(deleteMergedRemoteBranch(result, async args => {
      if (args.includes('DELETE')) throw failure;
      return { stdout: JSON.stringify(args[0] === 'pr' ? [] : [topicRef]) };
    }), error => error === failure);
  }
  for (const missingRef of missingRefs) {
    let lookups = 0;
    await assert.rejects(deleteMergedRemoteBranch(result, async args => {
      if (args.includes('DELETE')) throw missingRef;
      if (args[0] === 'pr') return { stdout: '[]' };
      if (++lookups > 1) throw new Error('Lookup failed');
      return { stdout: JSON.stringify([topicRef]) };
    }), /Lookup failed/);
  }
  const validationFailure = Object.assign(new Error('gh failed'), {
    stderr: 'gh: Validation Failed (HTTP 422)'
  });
  let validationLookups = 0;
  await assert.rejects(deleteMergedRemoteBranch(result, async args => {
    if (args.includes('DELETE')) throw validationFailure;
    if (args[0] === 'pr') return { stdout: '[]' };
    return { stdout: JSON.stringify(++validationLookups === 1 ? [topicRef] : []) };
  }), error => error === validationFailure);
  assert.equal(validationLookups, 1, 'Other 422 errors must remain actionable');
  await assert.rejects(deleteMergedRemoteBranch(result, async () => ({ stdout: JSON.stringify([
    { ref: 'refs/heads/topic', object: { sha: 'b'.repeat(40) } }
  ]) })), /new commits/);
  let handler;
  const registeredIds = [];
  const errors = [];
  const refreshes = [];
  registerGitHubPullRequestActions({
    commands: { getCommands: async () => [], registerCommand: (id, fn) => { registeredIds.push(id); handler = fn; return { dispose() {} }; },
      executeCommand: async id => refreshes.push(id) },
    ProgressLocation: { Window: 10 },
    window: { withProgress: (_, fn) => fn(), showErrorMessage: message => errors.push(message) }
  }, { subscriptions: [] });
  assert.deepEqual(registeredIds, [
    'sweetiebot.squashMergePullRequest',
    'sweetiebot.squashMergeSelectedPullRequest'
  ]);
  await handler({});
  assert.equal(errors.length, 1);
  assert.deepEqual(refreshes, ['pr.refreshList', 'pr.refreshList']);
  const conflictErrors = [];
  const conflictRefreshes = [];
  registerGitHubPullRequestActions({
    commands: { getCommands: async () => [], registerCommand: (id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async id => conflictRefreshes.push(id) },
    ProgressLocation: { Window: 10 },
    window: { withProgress: (_, fn) => fn(), showErrorMessage: message => conflictErrors.push(message) }
  }, { subscriptions: [] }, async () => {
    throw Object.assign(new Error("Unable to merge #12: conflicts with `main`"), {
      code: 'SWEETIEBOT_MERGE_CONFLICT'
    });
  });
  await handler({ pullRequestModel: { url, number: 12 } });
  assert.deepEqual(conflictErrors, ["Unable to merge #12: conflicts with `main`"]);
  assert.deepEqual(conflictRefreshes, ['pr.refreshList']);

  const mergeErrors = [];
  let mergeFailure = new Error('Required checks have not passed');
  registerGitHubPullRequestActions({
    commands: { getCommands: async () => [], registerCommand: (_id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async () => {} },
    ProgressLocation: { Window: 10 },
    window: { withProgress: (_, fn) => fn(), showErrorMessage: message => mergeErrors.push(message) }
  }, { subscriptions: [] }, async () => { throw mergeFailure; });
  await handler({ pullRequestModel: { url, number: 12 } });
  mergeFailure = Object.assign(new Error('Fallback error'), { stderr: '  gh: branch protection prevented merge  ' });
  await handler({ pullRequestModel: { url, number: 12 } });
  assert.deepEqual(mergeErrors, [
    'Required checks have not passed',
    'gh: branch protection prevented merge'
  ]);
  const selected = [];
  const notices = [];
  registerGitHubPullRequestActions({
    commands: { getCommands: async () => [], registerCommand: (id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async id => refreshes.push(id) },
    ProgressLocation: { Window: 10 },
    window: { withProgress: (_, fn) => fn(), showErrorMessage: message => errors.push(message),
      showInformationMessage: message => notices.push(message) }
  }, { subscriptions: [] }, async selectedUrl => {
    selected.push(selectedUrl);
    return { merged: false, number: '12' };
  });
  // GitHub PR tree nodes expose the normalized model URL, not REST's html_url.
  await handler({ pullRequestModel: { url, number: 12 } });
  await handler({ url, number: 12 });
  await handler({ pullRequestModel: { html_url: url, number: 12 } });
  await handler({ htmlUrl: `${url}/`, number: 12 });
  await handler({ resourceUri: { query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:12' }) } });
  assert.deepEqual(selected, [url, url, url, url, url]);
  assert.equal(errors.length, 1);
  assert.equal(notices.length, 5);
  assert.deepEqual(refreshes, Array(7).fill('pr.refreshList'));
  assert.deepEqual(notices, Array(5).fill('PR #12 queued for merge.'));

  // A completed PR gets one brief notice; in-flight progress is only in the status bar.
  const successNotices = [], progressOptions = [];
  registerGitHubPullRequestActions({
    commands: { registerCommand: (_id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async () => {} },
    ProgressLocation: { Window: 10, Notification: 15 },
    extensions: { getExtension: () => undefined },
    window: {
      withProgress: (options, fn) => { progressOptions.push(options); return fn(); },
      showInformationMessage: message => successNotices.push(message),
      showWarningMessage: () => { throw new Error('Unexpected cleanup warning'); },
      showErrorMessage: () => { throw new Error('Unexpected merge error'); }
    }
  }, { subscriptions: [] }, async () => ({
    merged: true, number: 12, repo: 'owner/repo',
    pr: { ...open, state: 'MERGED', isCrossRepository: true }
  }));
  assert.deepEqual(await handler({ url, number: 12 }), { state: 'merged' });
  assert.deepEqual(successNotices, ['PR #12 merged into main.']);
  assert.equal(progressOptions.length, 1);
  assert.equal(progressOptions[0].location, 10);
  assert.equal(progressOptions[0].cancellable, false);
  // Native PR nodes can expose their URI only after rendering. Both the
  // direct command and the inline context action must resolve that clicked row.
  const renderedMerges = [], renderedErrors = [], renderedRefreshes = [];
  const renderedCommands = new Map();
  const renderedVscode = {
    commands: {
      registerCommand: (id, fn) => {
        renderedCommands.set(id, fn);
        return { dispose() {} };
      },
      getCommands: async () => [...renderedCommands.keys()],
      executeCommand: async id => { renderedRefreshes.push(id); }
    },
    ProgressLocation: { Window: 10 },
    window: {
      withProgress: (_, fn) => fn(),
      showErrorMessage: message => renderedErrors.push(message),
      showInformationMessage: () => {}
    }
  };
  registerGitHubPullRequestActions(renderedVscode, { subscriptions: [] }, async clicked => {
    renderedMerges.push(clicked);
    return { merged: false, number: 12 };
  });
  const renderedNode = {
    pullRequestModel: { number: 12 },
    async getTreeItem() {
      return { resourceUri: { query: JSON.stringify({
        prIdentifier: 'git@github.com:owner/repo.git:12'
      }) } };
    }
  };
  await renderedCommands.get('sweetiebot.squashMergePullRequest')(renderedNode);
  await renderedCommands.get('sweetiebot.squashMergeSelectedPullRequest')(renderedNode);
  assert.deepEqual(renderedMerges, [url, url], 'Both merge entry points resolve the clicked PR');
  assert.deepEqual(renderedErrors, []);
  assert.deepEqual(renderedRefreshes, ['pr.refreshList', 'pr.refreshList']);

  await renderedCommands.get('sweetiebot.squashMergeSelectedPullRequest')({
    pullRequestModel: { number: 99 },
    getTreeItem: renderedNode.getTreeItem
  });
  assert.deepEqual(renderedMerges, [url, url], 'A mismatched row cannot merge another PR');
  assert.match(renderedErrors.at(-1), /Could not identify the pull request/);


  // The inline button warns before launching a non-main merge; dismissal does nothing.
  const targetDialogs = [], targetNotices = [], targetMerges = [];
  let approveAlternate = false;
  registerGitHubPullRequestActions({
    commands: {
      registerCommand: (_id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async () => {}
    },
    ProgressLocation: { Window: 10 },
    extensions: { getExtension: () => undefined },
    window: {
      withProgress: (_, fn) => fn(),
      showWarningMessage: (message, options, action) => {
        targetDialogs.push({ message, options, action });
        return approveAlternate ? action : undefined;
      },
      showInformationMessage: message => targetNotices.push(message),
      showErrorMessage: message => { throw new Error(message); }
    }
  }, { subscriptions: [] }, async (prUrl, _execute, confirm) => {
    const approved = await confirm({ number: '12', base: 'kefania' });
    if (!approved) return { cancelled: true, merged: false, number: 12 };
    targetMerges.push(prUrl);
    return { merged: true, number: 12, repo: 'owner/repo', base: 'kefania',
      pr: { ...alternate, state: 'MERGED', isCrossRepository: true } };
  });
  await handler({ url, number: 12 });
  assert.equal(targetMerges.length, 0);
  assert.deepEqual(targetNotices, []);
  assert.match(targetDialogs[0].message, /kefania.*not.*main/);
  assert.equal(targetDialogs[0].options.modal, true);
  assert.equal(targetDialogs[0].action, 'Squash into kefania');
  approveAlternate = true;
  await handler({ url, number: 12 });
  assert.deepEqual(targetMerges, [url]);
  assert.deepEqual(targetNotices, ['PR #12 merged into kefania.']);

  // An inline PR row can be clicked before its TreeItem/selection metadata
  // becomes available. Retry the exact row after one refresh, without a second
  // click or duplicate merge.
  const firstClick = { pullRequestModel: { number: 12 } };
  const firstClickMerges = [];
  const firstClickErrors = [];
  const firstClickNotices = [];
  const firstClickCommands = new Map();
  let rowReady = false, firstClickRefreshes = 0;
  const firstClickVscode = {
    commands: {
      registerCommand: (id, fn) => {
        firstClickCommands.set(id, fn);
        return { dispose() {} };
      },
      getCommands: async () => [...firstClickCommands.keys()],
      executeCommand: async (id, argument) => {
        if (id === 'pr.refreshList') {
          firstClickRefreshes++;
          rowReady = true;
          return;
        }
        return firstClickCommands.get(id)(argument);
      }
    },
    ProgressLocation: { Window: 10 },
    window: {
      withProgress: (_, fn) => fn(),
      showErrorMessage: message => firstClickErrors.push(message),
      showInformationMessage: message => firstClickNotices.push(message)
    }
  };
  firstClickCommands.set('sweetiebot.resolveSelectedPullRequest', async clicked => {
    assert.equal(clicked, firstClick, 'Resolve the exact clicked row, not another selected PR');
    return rowReady ? { url, number: 12 } : { number: 12 };
  });
  registerGitHubPullRequestActions(firstClickVscode, { subscriptions: [] }, async selectedUrl => {
    firstClickMerges.push(selectedUrl);
    return { merged: false, number: 12 };
  });
  await firstClickCommands.get('sweetiebot.squashMergeSelectedPullRequest')(firstClick);
  assert.deepEqual(firstClickMerges, [url], 'One click must merge once after an automatic identity retry');
  assert.deepEqual(firstClickErrors, []);
  assert.equal(firstClickNotices.length, 1);
  assert.equal(firstClickRefreshes, 2, 'One recovery refresh and one post-action refresh');

  // Refuse a stale resolver returning another PR's URL; never merge whichever
  // row happens to be selected when the clicked row has not been identified.
  rowReady = true;
  const wrongRow = { pullRequestModel: { number: 99 } };
  firstClickCommands.set('sweetiebot.resolveSelectedPullRequest', async () => ({ url, number: 12 }));
  await firstClickCommands.get('sweetiebot.squashMergeSelectedPullRequest')(wrongRow);
  assert.deepEqual(firstClickMerges, [url], 'A mismatched PR must never be merged');
  assert.match(firstClickErrors.at(-1), /Could not identify the pull request/);

  // The GitHub resolver can itself register only after the first refresh.
  const lateCommands = new Map();
  const lateMerges = [];
  let lateRefreshes = 0;
  const lateVscode = {
    ...firstClickVscode,
    commands: {
      registerCommand: (id, fn) => {
        lateCommands.set(id, fn);
        return { dispose() {} };
      },
      getCommands: async () => [...lateCommands.keys()],
      executeCommand: async (id, argument) => {
        if (id === 'pr.refreshList') {
          lateRefreshes++;
          lateCommands.set('sweetiebot.resolveSelectedPullRequest', async clicked => {
            assert.equal(clicked, firstClick);
            return { url, number: 12 };
          });
          return;
        }
        return lateCommands.get(id)(argument);
      }
    }
  };
  registerGitHubPullRequestActions(lateVscode, { subscriptions: [] }, async selectedUrl => {
    lateMerges.push(selectedUrl);
    return { merged: false, number: 12 };
  });
  await lateCommands.get('sweetiebot.squashMergeSelectedPullRequest')(firstClick);
  assert.deepEqual(lateMerges, [url]);
  assert.equal(lateRefreshes, 2);

  // Closing the merged PR overview must not close an unrelated editor, issue,
  // different PR, or another webview. It must work in a non-active group.
  class WebviewTab {
    constructor(viewType) { this.viewType = viewType; }
  }
  const prViewType = 'github.vscode-pull-request-github.PullRequestOverview';
  const tab = (label, type = prViewType) => ({ label, input: new WebviewTab(type) });
  const mergedTitle = 'Close pull request after a successful merge';
  const matchingTab = tab('#12 Close pull request...');
  const nearby = [
    tab('#120 Close pull request...'),
    tab('#12 Completely different'),
    tab('#12 Close pull request...', 'github.vscode-pull-request-github.IssueOverview'),
    { label: matchingTab.label, input: { viewType: prViewType } }
  ];
  const closedTabs = [];
  const overviewVscode = {
    TabInputWebview: WebviewTab,
    window: { tabGroups: {
      all: [{ tabs: nearby }, { tabs: [matchingTab] }],
      close: async (tabToClose, preserveFocus) => {
        closedTabs.push({ tabToClose, preserveFocus });
        return true;
      }
    } }
  };
  const completed = { merged: true, number: 12, pr: { title: mergedTitle } };
  assert.equal(await closeMergedPullRequestTab(overviewVscode, completed), true);
  assert.deepEqual(closedTabs, [{ tabToClose: matchingTab, preserveFocus: true }]);
  assert.equal(await closeMergedPullRequestTab(overviewVscode, { ...completed, merged: false }), false);
  assert.equal(await closeMergedPullRequestTab(overviewVscode, { ...completed, pr: {} }), false);
  assert.equal(await closeMergedPullRequestTab({ window: {} }, completed), false);
  assert.equal(closedTabs.length, 1);
  const duplicate = tab(matchingTab.label);
  overviewVscode.window.tabGroups.all[0].tabs.push(duplicate);
  assert.equal(await closeMergedPullRequestTab(overviewVscode, completed), false,
    'Identical PR overview labels are ambiguous across repositories');
  assert.equal(closedTabs.length, 1);
  overviewVscode.window.tabGroups.all[0].tabs.pop();
  assert.equal(await closeMergedPullRequestTab(overviewVscode, {
    merged: true, number: 12, pr: { title: 'A different pull request' }
  }), false);
  assert.equal(closedTabs.length, 1);

  // The merge handler closes the PR's own tab only after a confirmed merge.
  // Queued merges, failures and cancellations must leave editors untouched.
  let closeHandler;
  const handlerClosed = [], handlerNotices = [], handlerWarnings = [];
  const handlerTab = tab('#12 The merged PR');
  const actionVscode = {
    TabInputWebview: WebviewTab,
    commands: {
      registerCommand: (_id, fn) => { closeHandler = fn; return { dispose() {} }; },
      executeCommand: async () => {}
    },
    ProgressLocation: { Window: 10 },
    extensions: { getExtension: () => undefined },
    window: {
      tabGroups: {
        all: [{ tabs: [handlerTab, tab('#13 Another PR')] }],
        close: async openedTab => { handlerClosed.push(openedTab); return true; }
      },
      withProgress: (_, fn) => fn(),
      showInformationMessage: message => handlerNotices.push(message),
      showWarningMessage: message => handlerWarnings.push(message),
      showErrorMessage: message => { throw new Error(message); }
    }
  };
  let mergeState = 'queued';
  registerGitHubPullRequestActions(actionVscode, { subscriptions: [] }, async () => {
    if (mergeState === 'cancelled') return { cancelled: true, merged: false };
    if (mergeState === 'error') throw new Error('Unable to merge');
    if (mergeState === 'queued') return { merged: false, number: 12 };
    return {
      merged: true, number: 12, repo: 'owner/repo', base: 'main',
      pr: { ...open, state: 'MERGED', isCrossRepository: true, title: 'The merged PR' }
    };
  });
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'queued' });
  assert.equal(handlerClosed.length, 0);
  mergeState = 'cancelled';
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'cancelled' });
  assert.equal(handlerClosed.length, 0);
  mergeState = 'complete';
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'merged' });
  assert.deepEqual(handlerClosed, [handlerTab]);
  assert.deepEqual(handlerNotices, ['PR #12 queued for merge.', 'PR #12 merged into main.']);
  assert.deepEqual(handlerWarnings, []);

}
main().catch(error => { console.error(error); process.exitCode = 1; });
