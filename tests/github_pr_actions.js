'use strict';

const assert = require('node:assert/strict');
const { squashMergePullRequest, deleteMergedRemoteBranch, closeMergedPullRequestTab, registerGitHubPullRequestActions } = require('../extension/github/pr_actions');
const { squashMessage } = require('../extension/merge/squash_attribution');
const url = 'https://github.com/owner/repo/pull/12';
const open = { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'topic',
  headRefOid: 'a'.repeat(40), isCrossRepository: false, title: '🐛 Correct caching' };

const asyncPath = 'repos/owner/repo/pulls/12/merge-async';
const requestId = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
const pending = { status: 'pending', details: { uuid: requestId } };
const asyncMergedResponse = { status: 'merged', details: { sha: 'c'.repeat(40) } };
const mergedPr = { ...open, state: 'MERGED' };

function mockMerge({ views = [open, open, mergedPr], submission = pending, responses = [asyncMergedResponse],
  submissionError, stackMetadata = { stack: null, user: { login: 'JFWooten4', type: 'User' } } } = {}) {
  const calls = [];
  const execute = async args => {
    calls.push(args);
    if (args[0] === 'pr') return { stdout: JSON.stringify(views.length > 1 ? views.shift() : views[0]) };
    if (args.some(a => typeof a === 'string' && a.includes('/commits?per_page=100&page='))) return { stdout: JSON.stringify([{ author: { login: 'JFWooten4', type: 'User' }, commit: { author: { name: 'John Wooten', email: 'noreply@wooten.link' }, committer: { name: 'GitHub', email: 'noreply@github.com' }, message: 'Change\n\nCo-authored-by: Codex <noreply@openai.com>' } }]) };
    if (args.includes('repos/owner/repo/pulls/12')) return { stdout: JSON.stringify(stackMetadata) };
    if (args.includes('--method')) {
      if (submissionError) throw submissionError;
      return { stdout: JSON.stringify(submission) };
    }
    return { stdout: JSON.stringify(responses.length > 1 ? responses.shift() : responses[0]) };
  };
  return { execute, calls };
}
const quickPoll = { preferLocalGit: false, wait: async () => {}, pollAttempts: 2 };

async function main() {
  const local = mockMerge();
  let delegated=false;
  const localResult=await squashMergePullRequest(url,local.execute,undefined,{humanMerge:async(repo,number,options)=>{
    delegated=true;assert.equal(repo,'owner/repo');assert.equal(number,12);
    assert.deepEqual(options,{allowHistoryRewrite:false,localGitMerge:true,expected:{headSha:open.headRefOid,head:open.headRefName,base:open.baseRefName,title:open.title}});
    return {merged:true,sha:'c'.repeat(40)};
  }});
  assert(localResult.merged&&delegated,'The sidebar defaults to its verified local Git executor');
  assert(!local.calls.some(args=>args.includes('--method')),'The sidebar does not submit an async merge before local checks');
  // A protected base cannot accept local integration pushes. Retry using
  // GitHub's native squash only when the verified human author is the opener.
  const protectedHuman = mockMerge();
  const protectedResult = await squashMergePullRequest(url, protectedHuman.execute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => ({ merged: false, status: 'blocked',
      reason: 'The base branch is protected; local Git cannot bypass its merge policy.' })
  });
  assert.equal(protectedResult.merged, true);
  assert(protectedHuman.calls.some(args => args.includes('--method')),
    'Protected bases merge through GitHub, not a direct local push');

  const protectedRules = mockMerge();
  assert.equal((await squashMergePullRequest(url, protectedRules.execute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => {
      throw new Error('The base has active branch rules; local Git will not bypass them.');
    }
  })).merged, true, 'Active rulesets also use the native protected-branch merge');

  // A bot-opened PR against a protected base may use GitHub's merge-commit
  // API only after explicit confirmation, preserving the source commits.
  const protectedConfirm = mockMerge({
    views: [open, open, open, { ...open, state: 'MERGED' }],
    stackMetadata: { stack: null, user: { login: 'codex-pony[bot]', type: 'Bot' } }
  });
  const mergedSha = 'c'.repeat(40);
  let nativeMergeSubmitted = false;
  const protectedExecute = async args => {
    if (args.includes('repos/owner/repo/pulls/12/merge')) {
      nativeMergeSubmitted = true;
      assert(args.includes('merge_method=merge'));
      assert(args.includes('sha=' + open.headRefOid));
      assert(args.includes('commit_title=🐛 Correct caching (#12)'));
      return { stdout: JSON.stringify({ merged: true, sha: mergedSha }) };
    }
    if (args.includes('repos/owner/repo/git/commits/' + mergedSha)) {
      const originals = [{
        author: { login: 'JFWooten4', type: 'User' },
        commit: { author: { name: 'John Wooten', email: 'noreply@wooten.link' },
          committer: { name: 'GitHub', email: 'noreply@github.com' },
          message: 'Change\\n\\nCo-authored-by: Codex <noreply@openai.com>' }
      }];
      const prepared = squashMessage(open.title, 12, originals);
      return { stdout: JSON.stringify({ parents: [{ sha: 'b'.repeat(40) }, { sha: open.headRefOid }],
        message: prepared.title + '\\n\\n' + prepared.message }) };
    }
    return protectedConfirm.execute(args);
  };
  let confirmedChoice = false;
  const mergePreserving = await squashMergePullRequest(url, protectedExecute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => ({ merged: false, reason: 'The base branch is protected; local Git cannot bypass its merge policy.' }),
    confirmPreserveCommits: async target => {
      assert.deepEqual(target, { repo: 'owner/repo', number: '12', base: 'main' });
      confirmedChoice = true;
      return true;
    }
  });
  assert(confirmedChoice && nativeMergeSubmitted && mergePreserving.merged);
  assert.equal(mergePreserving.method, 'merge');
  assert.equal(mergePreserving.authorsPreserved, true);

  const declined = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'codex-pony[bot]', type: 'Bot' }
  } });
  const cancelledProtected = await squashMergePullRequest(url, declined.execute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => ({ merged: false, reason: 'The base branch is protected; local Git cannot bypass its merge policy.' }),
    confirmPreserveCommits: async () => false
  });
  assert.equal(cancelledProtected.cancelled, true);
  assert(!declined.calls.some(args => args.includes('--method')),
    'Declining the alternative must not merge or rewrite anything');

  const protectedBot = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'codex-pony[bot]', type: 'Bot' }
  } });
  await assert.rejects(squashMergePullRequest(url, protectedBot.execute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => ({ merged: false, status: 'blocked',
      reason: 'The base branch is protected; local Git cannot bypass its merge policy.' })
  }), /The base is protected/);
  assert(!protectedBot.calls.some(args => args.includes('--method')),
    'Bot-opened PRs cannot silently replace the original human author');

  const protectedOtherHuman = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'OtherHuman', type: 'User' }
  } });
  await assert.rejects(squashMergePullRequest(url, protectedOtherHuman.execute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => ({ merged: false, status: 'blocked',
      reason: 'The base branch is protected; local Git cannot bypass its merge policy.' })
  }), /The base is protected/);
  assert(!protectedOtherHuman.calls.some(args => args.includes('--method')));

  const localFailure = mockMerge();
  await assert.rejects(squashMergePullRequest(url, localFailure.execute, undefined, {
    ...quickPoll, preferLocalGit: true,
    humanMerge: async () => ({ merged: false, reason: 'Required checks have not passed' })
  }), /Required checks have not passed/);
  assert(!localFailure.calls.some(args => args.includes('--method')),
    'Unrelated local failures never trigger a native fallback');

  const happy = mockMerge();
  const result = await squashMergePullRequest(url, happy.execute,
    async () => { throw new Error('Main must not request alternate-base confirmation'); }, quickPoll);
  assert.equal(result.merged, true);
  assert.equal(result.base, 'main');
  assert.deepEqual(happy.calls[4], ['api', '-H', 'X-GitHub-Api-Version: 2026-03-10',
    '--method', 'PUT', asyncPath, '-f', `sha=${open.headRefOid}`,
    '-f', 'merge_method=squash', '-f', 'merge_action=direct_merge',
    '-f', 'commit_title=🐛 Correct caching (#12)',
    '-f', `commit_message=- Change\n\n__________\n\nCo-authored-by: John Wooten <noreply@wooten.link>\nCo-authored-by: Codex (Web) <noreply@openai.com>`]);
  assert.deepEqual(happy.calls[5], ['api', '-H', 'X-GitHub-Api-Version: 2026-03-10',
    `${asyncPath}/${requestId}`]);
  assert.deepEqual(happy.calls.map(args => args[0]), ['pr', 'pr', 'api', 'api', 'api', 'api', 'pr']);

  // A bot-created PR keeps its opener but must never enter GitHub's native
  // squash endpoint (which would author its commit as codex-pony[bot]).
  const botOpened = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'codex-pony[bot]', type: 'Bot' }
  } });
  let handled = false;
  const botResult = await squashMergePullRequest(url, botOpened.execute, undefined, {
    ...quickPoll,
    humanMerge: async (repo, number, options) => {
      handled = true;
      assert.equal(repo, 'owner/repo');
      assert.equal(number, 12);
      assert.deepEqual(options, { allowHistoryRewrite: false, localGitMerge: true },
        'The one-click squash button must never approve a force push');
      return { merged: true, sha: 'c'.repeat(40), author: { name: 'John Wooten', email: 'noreply@wooten.link' } };
    }
  });
  assert.equal(handled, true);
  assert.equal(botResult.merged, true);
  assert.equal(botOpened.calls.some(args => args.includes('--method')), false,
    'A bot opener must not reach the bot-authored squash merge endpoint');
  const blockedRewrite = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'codex-pony[bot]', type: 'Bot' }
  } });
  await assert.rejects(squashMergePullRequest(url, blockedRewrite.execute, undefined, {
    ...quickPoll, humanMerge: async (_repo, _number, options) => {
      assert.equal(options.allowHistoryRewrite, false);
      return { merged: false, reason: 'No-force-push policy: use Merge preserving commits.' };
    }
  }), /No-force-push policy/);
  assert.equal(blockedRewrite.calls.some(args => args.includes('--method')), false,
    'Blocked attribution must not silently attempt a native squash or rewrite');

  const waitingBot = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'codex-pony[bot]', type: 'Bot' }
  } });
  await assert.rejects(squashMergePullRequest(url, waitingBot.execute, undefined, {
    ...quickPoll, humanMerge: async () => ({ merged: false, status: 'waiting', reason: 'Waiting for required checks' })
  }), /Waiting for required checks/);
  const anotherHumanOpener = mockMerge({ stackMetadata: {
    stack: null, user: { login: 'DifferentHuman', type: 'User' }
  } });
  let usedHumanHelper = false;
  const protectedAttribution = await squashMergePullRequest(url, anotherHumanOpener.execute, undefined, {
    ...quickPoll, humanMerge: async (repo, number, options) => {
      assert.deepEqual(options, { allowHistoryRewrite: false, localGitMerge: true },
        'Different-actor PRs must not authorize history rewrites');
      usedHumanHelper = true;
      return { merged: true, sha: 'c'.repeat(40),
        author: { name: 'John Wooten', email: 'noreply@wooten.link' } };
    }
  });
  assert(usedHumanHelper && protectedAttribution.merged);
  assert.equal(anotherHumanOpener.calls.some(args => args.includes('--method')), false,
    'A different human PR opener must not replace the original human Git author');
  const botOnly = mockMerge();
  const botOnlyExecute = args => args.some(a => String(a).includes('/commits?per_page=100&page='))
    ? Promise.resolve({stdout: JSON.stringify([{
      author: {login: 'codex-pony[bot]', type: 'Bot'},
      commit: { author: {name: 'codex-pony[bot]', email: 'bot@example.org'}, message: 'Bot-only change' }
    }])})
    : botOnly.execute(args);
  await assert.rejects(squashMergePullRequest(url, botOnlyExecute, undefined, quickPoll),
    /No verified original human Git author/);
  assert.equal(botOnly.calls.some(args => args.includes('--method')), false,
    'No native merge request without a linked human original author');
  const unverifiable = mockMerge({ stackMetadata: { stack: null } });
  await assert.rejects(squashMergePullRequest(url, unverifiable.execute, undefined, quickPoll),
    /Cannot verify PR opener identity/);
  assert.equal(unverifiable.calls.some(args => args.includes('--method')), false);

  for (const invalid of [{ isDraft: true }, { baseRefName: '' }, { state: 'CLOSED' }, { headRefOid: '' }]) {
    const denied = mockMerge({ views: [{ ...open, ...invalid }] });
    await assert.rejects(squashMergePullRequest(url, denied.execute));
    assert.equal(denied.calls.length, 1, 'Invalid PRs never submit a merge');
  }

  const alternate = { ...open, baseRefName: 'kefania' };
  const cancelled = mockMerge({ views: [alternate] });
  const cancelResult = await squashMergePullRequest(url, cancelled.execute, async target => {
    assert.deepEqual(target, { repo: 'owner/repo', number: '12', base: 'kefania' });
    return false;
  }, quickPoll);
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.merged, false);
  assert.equal(cancelled.calls.length, 1, 'Cancelled base confirmation must not submit');
  const approved = mockMerge({ views: [alternate, alternate, { ...alternate, state: 'MERGED' }] });
  const alternateResult = await squashMergePullRequest(url, approved.execute, async () => true, quickPoll);
  assert.equal(alternateResult.merged, true);
  assert.equal(alternateResult.base, 'kefania');
  assert.deepEqual(approved.calls.map(args => args[0]), ['pr', 'pr', 'api', 'api', 'api', 'api', 'pr']);

  // Validate the exact head and destination again after selection, even for main.
  for (const changed of [{ baseRefName: 'another' }, { title: '🎨 New PR title' }, { headRefOid: 'b'.repeat(40) },
    { headRefName: 'other' }, { state: 'CLOSED' }, { isDraft: true }]) {
    for (const initial of [open, alternate]) {
      const stale = mockMerge({ views: [initial, { ...initial, ...changed }] });
      await assert.rejects(squashMergePullRequest(url, stale.execute, async () => true, quickPoll),
        /changed since selection/);
      assert.equal(stale.calls.length, 2, 'Changed PR must not submit');
    }
  }
  await assert.rejects(squashMergePullRequest('https://other.example/owner/repo/pull/12', happy.execute));

  for (const branch of [open, alternate]) {
    const conflicting = mockMerge({ views: [{ ...branch, mergeable: 'CONFLICTING' }] });
    await assert.rejects(squashMergePullRequest(url, conflicting.execute, async () => true, quickPoll),
      /conflicts with/);
    assert.equal(conflicting.calls.length, 1);
  }
  const lateConflict = mockMerge({ views: [open, { ...open, mergeable: 'CONFLICTING' }] });
  await assert.rejects(squashMergePullRequest(url, lateConflict.execute, undefined, quickPoll),
    /conflicts with `main`/);
  assert.equal(lateConflict.calls.length, 2);

  // The one-click action must never implicitly merge unselected native
  // downstack PRs, even though GitHub's async endpoint supports them.
  const stacked = mockMerge({ views: [open, open], stackMetadata: {
    stack: { number: 3, size: 2, position: 2 }
  } });
  await assert.rejects(squashMergePullRequest(url, stacked.execute, undefined, quickPoll),
    /belongs to a GitHub-native stack/);
  assert.equal(stacked.calls.filter(args => args.includes('--method')).length, 0);

  // A 202 request is not a completed merge. Bounded polling must leave
  // cleanup inactive if GitHub is still processing.
  const processing = mockMerge({ views: [open, open], responses: [pending] });
  const processingResult = await squashMergePullRequest(url, processing.execute, undefined, quickPoll);
  assert.equal(processingResult.merged, false);
  assert.equal(processingResult.pending, true);
  assert.equal(processing.calls.filter(args => args.includes(`${asyncPath}/${requestId}`)).length, 2);

  // Queues are terminal for the async request but NOT successful merges.
  const queued = mockMerge({ views: [open, open], submission: { status: 'enqueued', details: {} } });
  await assert.rejects(squashMergePullRequest(url, queued.execute, undefined, quickPoll), /queue/);

  // A 200 already-merged response still needs a matching PR snapshot.
  const already = mockMerge({ submission: asyncMergedResponse });
  assert.equal((await squashMergePullRequest(url, already.execute, undefined, quickPoll)).merged, true);
  const changedAfterMerge = mockMerge({ views: [open, open, { ...mergedPr, headRefOid: 'b'.repeat(40) }] });
  await assert.rejects(squashMergePullRequest(url, changedAfterMerge.execute, undefined, quickPoll),
    /branch cleanup was skipped/);

  const failed = mockMerge({ responses: [{ status: 'failed', details: { message: 'Required checks have not passed' } }] });
  await assert.rejects(squashMergePullRequest(url, failed.execute, undefined, quickPoll),
    /Required checks have not passed/);
  const missingUuid = mockMerge({ submission: { status: 'pending', details: {} } });
  await assert.rejects(squashMergePullRequest(url, missingUuid.execute, undefined, quickPoll),
    /without a valid request ID/);
  const unknown = mockMerge({ submission: { status: 'unexpected' } });
  await assert.rejects(squashMergePullRequest(url, unknown.execute, undefined, quickPoll),
    /unexpected asynchronous merge status/);

  // A concurrent request may be resumed only when GitHub confirms the exact
  // same SHA, squash method, and queue policy.
  const busyError = Object.assign(new Error('Request in progress'), {
    stderr: 'gh: Request in progress (HTTP 409)',
    stdout: JSON.stringify({ status: 'pending', details: {
      uuid: requestId, expected_head_sha: open.headRefOid, merge_method: 'squash', merge_action: 'default'
    } })
  });
  const wrongPolicy = mockMerge({ submissionError: busyError });
  await assert.rejects(squashMergePullRequest(url, wrongPolicy.execute, undefined, quickPoll), /unverifiable asynchronous/);
  const matchingError = Object.assign(new Error('Request in progress'), {
    stderr: 'gh: HTTP 409',
    stdout: JSON.stringify({ status: 'pending', details: {
      uuid: requestId, expected_head_sha: open.headRefOid, merge_method: 'squash',
      merge_action: 'direct_merge', bypass_rules: false
    } })
  });
  const stillPending = mockMerge({ views: [open, open], submissionError: matchingError, responses: [pending] });
  const existingResult = await squashMergePullRequest(url, stillPending.execute, undefined, quickPoll);
  assert.equal(existingResult.pending, true, 'A matching existing request is processing, not an attribution failure');
  assert.equal(existingResult.merged, false, 'Pending retries cannot trigger cleanup');
  assert.equal(stillPending.calls.filter(args => args.includes('--method')).length, 1,
    'A retry only submits once and then polls the existing request');

  {
    const clean = { ...open, mergeable: 'MERGEABLE' };
    const stalled = mockMerge({ views: [clean, clean, clean, mergedPr], submissionError: matchingError, responses: [pending] });
    let recovered = false;
    const originals = [{ author: { login: 'JFWooten4', type: 'User' }, commit: { author: { name: 'John Wooten', email: 'noreply@wooten.link' }, committer: { name: 'GitHub', email: 'noreply@github.com' }, message: 'Change\n\nCo-authored-by: Codex <noreply@openai.com>' } }];
    const expected = squashMessage(open.title, 12, originals);
    const execute = async args => {
      if (args.includes('repos/owner/repo/pulls/12/merge')) {
        assert(args.includes('sha=' + open.headRefOid));
        assert(args.includes('commit_title=' + expected.title));
        assert(args.includes('commit_message=' + expected.message));
        recovered = true; return { stdout: JSON.stringify({ merged: true }) };
      }
      if (recovered && args.includes('repos/owner/repo/pulls/12')) return { stdout: JSON.stringify({ merged: true, merge_commit_sha: 'c'.repeat(40) }) };
      if (args.includes('repos/owner/repo/git/commits/' + 'c'.repeat(40))) return { stdout: JSON.stringify({ message: expected.title + '\n\n' + expected.message }) };
      return stalled.execute(args);
    };
    const result = await squashMergePullRequest(url, execute, undefined, quickPoll);
    assert.equal(recovered, true);
    assert.equal(result.merged, true, 'a stalled matching request can recover without changing merge metadata');
  }

  const resumed = mockMerge({ submissionError: matchingError });
  const commitArgs = ['repos/owner/repo/pulls/12/commits?per_page=100&page=1'];
  const originals = JSON.parse((await resumed.execute(['api', ...commitArgs])).stdout);
  const message = squashMessage(open.title, 12, originals);
  const resumeExecute = async (args, actualMessage = `${message.title}\n\n${message.message}`) => {
    if (args.includes('repos/owner/repo/pulls/12') && resumed.calls.some(call => call.includes('--method'))) {
      return { stdout: JSON.stringify({ merged: true, merge_commit_sha: 'c'.repeat(40) }) };
    }
    if (args.includes('repos/owner/repo/git/commits/' + 'c'.repeat(40))) {
      return { stdout: JSON.stringify({ message: actualMessage }) };
    }
    return resumed.execute(args);
  };
  assert.equal((await squashMergePullRequest(url, resumeExecute, undefined, quickPoll)).merged, true);
  for (const invalidMessage of [message.title + '\n\nMissing contributors', 'Wrong title\n\n' + message.message]) {
    const mismatch = mockMerge({ submissionError: matchingError });
    await assert.rejects(squashMergePullRequest(url, async args => {
      if (args.includes('repos/owner/repo/pulls/12') && mismatch.calls.some(call => call.includes('--method'))) {
        return { stdout: JSON.stringify({ merged: true, merge_commit_sha: 'c'.repeat(40) }) };
      }
      if (args.includes('repos/owner/repo/git/commits/' + 'c'.repeat(40))) {
        return { stdout: JSON.stringify({ message: invalidMessage }) };
      }
      return mismatch.execute(args);
    }, undefined, quickPoll), /contributor attribution differs.*cleanup was skipped/);
  }
  for (const override of [{ expected_head_sha: 'b'.repeat(40) }, { merge_method: 'merge' },
    { merge_action: 'default' }, { bypass_rules: true }, { bypass_rules: undefined }, { uuid: 'invalid' }]) {
    const body = JSON.parse(matchingError.stdout);
    Object.assign(body.details, override);
    const incompatible = mockMerge({ submissionError: Object.assign(new Error('409'), {
      stderr: 'gh: HTTP 409', stdout: JSON.stringify(body)
    }) });
    await assert.rejects(squashMergePullRequest(url, incompatible.execute, undefined, quickPoll),
      /different or unverifiable/);
    assert.equal(incompatible.calls.some(args => args.includes(`${asyncPath}/${requestId}`)), false);
  }
  const wrongError = Object.assign(new Error('Request in progress'), {
    stderr: 'gh: (HTTP 409)',
    stdout: JSON.stringify({ status: 'pending', details: {
      uuid: requestId, expected_head_sha: 'b'.repeat(40), merge_method: 'merge', merge_action: 'default'
    } })
  });
  const blocked = mockMerge({ submissionError: wrongError });
  await assert.rejects(squashMergePullRequest(url, blocked.execute, undefined, quickPoll),
    /unverifiable asynchronous merge request/);
  assert.equal(blocked.calls.filter(args => args[0] === 'api').length, 3);

  const originalFailure = Object.assign(new Error('Forbidden'), { stderr: 'gh: Forbidden (HTTP 403)' });
  const blockedPermission = mockMerge({ views: [open, open, open], submissionError: originalFailure });
  await assert.rejects(squashMergePullRequest(url, blockedPermission.execute, undefined, quickPoll),
    error => error === originalFailure);
  const racedConflict = mockMerge({ views: [open, open, { ...open, mergeable: 'CONFLICTING' }],
    submissionError: new Error('Merge rejected') });
  await assert.rejects(squashMergePullRequest(url, racedConflict.execute, undefined, quickPoll),
    /conflicts with `main`/);

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
  registerGitHubPullRequestActions({ authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) },
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
  registerGitHubPullRequestActions({ authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) },
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
  registerGitHubPullRequestActions({ authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) },
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
  registerGitHubPullRequestActions({ authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) },
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

  // Progress becomes a notification immediately on click, without a premature
  // completion toast. Success still has exactly one informational notice.
  const successNotices = [], progressOptions = [], progressUpdates = [];
  registerGitHubPullRequestActions({ authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) },
    commands: { registerCommand: (_id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async () => {} },
    ProgressLocation: { Window: 10, Notification: 15 },
    extensions: { getExtension: () => undefined },
    window: {
      withProgress: (options, fn) => {
        progressOptions.push(options);
        return fn({ report: update => progressUpdates.push(update) });
      },
      showInformationMessage: message => successNotices.push(message),
      showWarningMessage: () => { throw new Error('Unexpected cleanup warning'); },
      showErrorMessage: () => { throw new Error('Unexpected merge error'); }
    }
  }, { subscriptions: [] }, async () => ({
    merged: true, number: 12, repo: 'owner/repo',
    pr: { ...open, state: 'MERGED', isCrossRepository: true }
  }));
  const mergeOperation = handler({ url, number: 12 });
  assert.equal(progressOptions.length, 1, 'The start notification appears before any asynchronous PR lookup');
  assert.equal(progressOptions[0].location, 15);
  assert.equal(progressOptions[0].title, 'Squash merge PR #12');
  assert.equal(progressOptions[0].cancellable, false);
  assert.deepEqual(await mergeOperation, { state: 'merged' });
  assert.deepEqual(progressUpdates, [{ message: 'Checking merge eligibility…' }]);
  assert.deepEqual(successNotices, ['PR #12 merged into main.']);
  const managedOperation = handler({ url, number: 12 }, { progressManaged: true });
  assert.equal(progressOptions.length, 1, 'The PR sidebar must not open a nested notification');
  assert.deepEqual(await managedOperation, { state: 'merged' });
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
  registerGitHubPullRequestActions({ ...renderedVscode, authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) } }, { subscriptions: [] }, async clicked => {
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
  registerGitHubPullRequestActions({ authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) },
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
  registerGitHubPullRequestActions({ ...firstClickVscode, authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) } }, { subscriptions: [] }, async selectedUrl => {
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
  registerGitHubPullRequestActions({ ...lateVscode, authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) } }, { subscriptions: [] }, async selectedUrl => {
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
  registerGitHubPullRequestActions({ ...actionVscode, authentication: { getSession: async () => ({ accessToken: 'test-vscode-session', scopes: ['repo'] }) } }, { subscriptions: [] }, async () => {
    if (mergeState === 'cancelled') return { cancelled: true, merged: false };
    if (mergeState === 'error') throw new Error('Unable to merge');
    if (mergeState === 'queued') return { merged: false, number: 12 };
    if (mergeState === 'pending') return { merged: false, pending: true, number: 12 };
    if (mergeState === 'enqueued') return { merged: false, enqueued: true, number: 12 };
    return {
      merged: true, number: 12, repo: 'owner/repo', base: 'main',
      pr: { ...open, state: 'MERGED', isCrossRepository: true, title: 'The merged PR' }
    };
  });
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'queued' });
  assert.equal(handlerClosed.length, 0);
  mergeState = 'pending';
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'pending' });
  assert.equal(handlerClosed.length, 0);
  mergeState = 'enqueued';
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'queued' });
  assert.equal(handlerClosed.length, 0);
  mergeState = 'cancelled';
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'cancelled' });
  assert.equal(handlerClosed.length, 0);
  mergeState = 'complete';
  assert.deepEqual(await closeHandler({ url, number: 12 }), { state: 'merged' });
  assert.deepEqual(handlerClosed, [handlerTab]);
  assert.deepEqual(handlerNotices, ['PR #12 queued for merge.',
    'PR #12 asynchronous squash still processing.', 'PR #12 added to merge queue.',
    'PR #12 merged into main.']);
  assert.deepEqual(handlerWarnings, []);

}
main().catch(error => { console.error(error); process.exitCode = 1; });
